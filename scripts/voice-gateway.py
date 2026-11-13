"""她的嗓子（voice gateway）：说话和唱歌都从这一个口进。

POST /speak  {text, emotion}  ->  audio/wav
GET  /health                  ->  {ok, model}

说话：按情绪挑参考 -> 让 api_v2（her11，9880）用 3 个 seed 各生成一遍 -> 按 HNR 挑最好的
      -> ffmpeg 提亮 + 4k 激励（与试听版 gen_her11.py 的 AF 完全一致）。
排队：同一时刻只跑一个请求（GPU 只有一张）；等超过 QUEUE_WAIT 秒回 503，
      机器人那边收到 503 就退回发文字，不会让她哑着。
唱歌（/sing）以后接 RVC，先留位置。

跑法: runtime\\gpt-sovits\\.venv\\Scripts\\python.exe scripts\\voice-gateway.py
"""
import io
import os
import subprocess
import tempfile
import threading
import time
import urllib.request

import librosa
import numpy as np
import soundfile as sf
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
import uvicorn

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
REFS = os.path.join(ROOT, "runtime", "voice-refs")
FF = os.path.join(os.environ["USERPROFILE"], ".dsh", "bin", "ffmpeg.exe")
API = os.environ.get("VOICE_API", "http://127.0.0.1:9880")
PORT = int(os.environ.get("VOICE_GATEWAY_PORT", "9890"))
SEEDS = [int(s) for s in os.environ.get("VOICE_SEEDS", "42,7").split(",")]
QUEUE_WAIT = float(os.environ.get("VOICE_QUEUE_WAIT", "40"))
SYNTH_TIMEOUT = float(os.environ.get("VOICE_SYNTH_TIMEOUT", "25"))
# 与 out/gpt-sovits/gen_her11.py 保持一致
AF = ("treble=g=9:f=6000,equalizer=f=120:t=q:w=1:g=-2,"
      "asplit=2[a][b];[b]highpass=f=4000,volume=0.5[exc];"
      "[a][exc]amix=inputs=2:duration=first:weights=1 0.6")

EMO = {
    "calm": "calm", "平静": "calm",
    "happy": "happy", "开心": "happy", "高兴": "happy",
    "sad": "sad", "委屈": "sad", "难过": "sad",
    "angry": "angry", "生气": "angry",
    "shy": "shy", "害羞": "shy", "撒娇": "shy",
}

lock = threading.Lock()
state = {"ok": False, "model": "her11"}


class SpeakRequest(BaseModel):
    text: str
    emotion: str = "calm"


def synth(text: str, emo: str, seed: int) -> bytes:
    ref = os.path.join(REFS, f"{emo}.wav")
    ref_text = open(os.path.join(REFS, f"{emo}.txt"), encoding="utf-8").read().strip()
    body = {
        "text": text, "text_lang": "zh",
        "ref_audio_path": ref, "prompt_text": ref_text, "prompt_lang": "zh",
        "top_k": 15, "top_p": 0.9,
        "temperature": 0.8 if emo == "calm" else 0.9,
        "text_split_method": "cut0", "batch_size": 1, "speed_factor": 1.0,
        "seed": seed, "parallel_infer": True, "repetition_penalty": 1.3,
        "media_type": "wav",
    }
    data = _post_json(f"{API}/tts", body, SYNTH_TIMEOUT)
    if len(data) < 2000:
        raise RuntimeError("generation returned too little audio")
    return data


def _post_json(url: str, body: dict, timeout: float) -> bytes:
    import json
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def hnr(data: bytes) -> float:
    """自相关法估 HNR（Boersma 式的简化版）：比 librosa.hpss 快两个数量级，
    训练占着 CPU 时 hpss 要十几秒，实时语音条等不起。"""
    y, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    y = y.mean(axis=1)
    if len(y) < sr * 0.2:
        return -99.0
    frame = 1024
    ratios = []
    for start in range(0, len(y) - frame, frame // 2):
        seg = y[start:start + frame] * np.hanning(frame)
        if float(np.sum(seg ** 2)) < 1e-6:
            continue
        ac = np.correlate(seg, seg, mode="full")[frame - 1:]
        if ac[0] <= 0:
            continue
        lo, hi = int(sr / 600), min(len(ac) - 1, int(sr / 70))
        peak = float(np.max(ac[lo:hi]))
        r = peak / float(ac[0])
        r = min(max(r, 0.0), 0.999)
        ratios.append(r / (1.0 - r))
    if not ratios:
        return -99.0
    return float(10 * np.log10(np.median(ratios) + 1e-9))


def polish(data: bytes) -> bytes:
    raw = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    out = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    raw.close()
    out.close()
    try:
        open(raw.name, "wb").write(data)
        subprocess.run([FF, "-v", "error", "-y", "-i", raw.name, "-af", AF,
                        "-ar", "32000", out.name], check=True, timeout=60)
        return open(out.name, "rb").read()
    finally:
        for p in (raw.name, out.name):
            try:
                os.remove(p)
            except OSError:
                pass


app = FastAPI()


@app.get("/health")
def health():
    return {"ok": state["ok"], "model": state["model"], "seeds": SEEDS}


@app.post("/speak")
def speak(req: SpeakRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty text")
    emo = EMO.get((req.emotion or "calm").strip().lower(), EMO.get(req.emotion or "", "calm"))
    if not lock.acquire(timeout=QUEUE_WAIT):
        raise HTTPException(status_code=503, detail="busy")
    try:
        started = time.time()
        candidates = []
        for seed in SEEDS:
            try:
                data = synth(text, emo, seed)
                candidates.append((hnr(data), data))
            except Exception as error:  # 一个 seed 失败就用剩下的
                print(f"seed {seed} failed: {type(error).__name__}", flush=True)
        if not candidates:
            raise HTTPException(status_code=502, detail="all seeds failed")
        best_hnr, best = max(candidates, key=lambda item: item[0])
        wav = polish(best)
        print(f"speak emo={emo} chars={len(text)} seeds={len(candidates)} "
              f"hnr={best_hnr:.1f} took={time.time() - started:.1f}s", flush=True)
        return Response(content=wav, media_type="audio/wav")
    finally:
        lock.release()


@app.post("/sing")
def sing():
    raise HTTPException(status_code=501, detail="singing is not wired yet")


if __name__ == "__main__":
    state["ok"] = True
    uvicorn.run(app, host="127.0.0.1", port=PORT, log_level="warning")
