"""让她唱一首：歌名或 BV -> 找女声源 -> 下载 -> 分离人声 -> 分块 RVC -> 拼回 -> 混伴奏 -> mp3。

用法:
  python scripts/sing.py --song BV1hW4y1Y7dG
  python scripts/sing.py --song 稻香            # 搜女声翻唱，验过音高才用
  python scripts/sing.py --song 稻香 --pitch 0 --out E:\\qqbot-dsh-control\\out\\sing

每步打一行 STAGE，最后一行 DONE <mp3 路径>，方便 bot 那边读日志。
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, "runtime", "gpt-sovits", ".venv", "Scripts", "python.exe")
RVC = os.path.join(ROOT, "runtime", "rvc-webui")
MODEL = os.path.join(RVC, "assets", "weights", "her12rvc.pth")
DL = os.path.join(ROOT, "out", "gpt-sovits", "bili_dl.py")
SEP = os.path.join(ROOT, "out", "gpt-sovits", "sep_one.py")
FFMPEG = "ffmpeg"
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"

# wbi 混表（B 站固定那张）
MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19,
         29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
         22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52]

# 女声的合理音高范围（人声中位 F0）；低于 190 基本是男声源
FEMALE_LO, FEMALE_HI = 190, 420
MAX_CANDIDATES = 3


def stage(name, extra=""):
    print(f"STAGE {name} {extra}".strip(), flush=True)


def run(cmd, cwd=None, env=None):
    print("  $", " ".join(cmd[:6]), flush=True)
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


# --- B 站搜索（wbi 签名） ---------------------------------------------------
_COOKIE = ""


def _get(url, headers=None):
    h = {"User-Agent": UA, "Referer": "https://search.bilibili.com", "Origin": "https://search.bilibili.com",
         "Accept": "application/json, text/plain, */*", "Accept-Language": "zh-CN,zh;q=0.9"}
    if _COOKIE:
        h["Cookie"] = _COOKIE
    h.update(headers or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=20) as resp:
        return json.loads(resp.read().decode("utf-8", "ignore"))


def _bootstrap():
    """拿登录态：优先用 bot 存的 B 站凭据（匿名搜索会被 412），没有就退回游客 cookie"""
    global _COOKIE
    if _COOKIE:
        return
    secret = os.path.join(ROOT, "runtime", "bot-shadow", "secrets", "bilibili.json")
    if os.path.exists(secret):
        with open(secret, encoding="utf-8") as fh:
            d = json.load(fh)
        _COOKIE = (
            f"SESSDATA={d['sessdata']}; bili_jct={d['biliJct']}; DedeUserID={d['dedeUserId']}; "
            f"buvid3={d['buvid3']}; buvid4={urllib.parse.quote(str(d.get('buvid4', '')))}"
        )
        return
    spi = _get("https://api.bilibili.com/x/frontend/finger/spi")
    d = spi["data"]
    _COOKIE = f"buvid3={d['b_3']}; buvid4={urllib.parse.quote(d['b_4'])}"


def _mixin_key() -> str:
    _bootstrap()
    nav = _get("https://api.bilibili.com/x/web-interface/nav")
    img = nav["data"]["wbi_img"]["img_url"].rsplit("/", 1)[-1].split(".")[0]
    sub = nav["data"]["wbi_img"]["sub_url"].rsplit("/", 1)[-1].split(".")[0]
    raw = img + sub
    return "".join(raw[i] for i in MIXIN)[:32]


def search_covers(keyword: str, limit: int = 8):
    """按关键词搜视频，返回 [{bv,title,play,author,duration}]，播放高的在前"""
    key = _mixin_key()
    params = {"search_type": "video", "keyword": keyword, "page": 1, "page_size": 20}
    params["wts"] = int(time.time())
    items = sorted(params.items())
    query = urllib.parse.urlencode([(k, str(v).replace("!", "").replace("'", "").replace("(", "").replace(")", "").replace("*", "")) for k, v in items])
    params["w_rid"] = hashlib.md5((query + key).encode()).hexdigest()
    data = _get("https://api.bilibili.com/x/web-interface/search/type?" + urllib.parse.urlencode(params))
    out = []
    for r in data.get("data", {}).get("result") or []:
        title = re.sub(r"<[^>]+>", "", r.get("title", ""))
        dur = r.get("duration", "")
        secs = 0
        if re.fullmatch(r"\d+:\d+", dur or ""):
            m, s = dur.split(":")
            secs = int(m) * 60 + int(s)
        if secs < 90:
            continue
        out.append({"bv": r["bvid"], "title": title, "play": r.get("play", 0), "author": r.get("author", ""), "duration": secs})
    out.sort(key=lambda x: x["play"], reverse=True)
    return out[:limit]


def vocal_f0(wav: str) -> float:
    """人声中位 F0：用 venv 里的 librosa.pyin，取前 30 秒"""
    code = (
        "import librosa,numpy as np,sys;"
        "y,sr=librosa.load(sys.argv[1],sr=16000,mono=True,duration=30);"
        "f0,vf,vp=librosa.pyin(y,fmin=70,fmax=600,sr=sr);"
        "f0=f0[~np.isnan(f0)];"
        "print(float(np.median(f0)) if f0.size else 0.0)"
    )
    res = subprocess.run([PY, "-c", code, wav], capture_output=True, text=True, timeout=600)
    return float(res.stdout.strip() or 0)


def pick_source(song: str, work_root: str):
    """返回 (bv, 说明)。给 BV 就直接用；给歌名就搜女声翻唱，按音高验。"""
    m = re.search(r"(BV[0-9A-Za-z]{10})", song)
    if m:
        return m.group(1), "直接指定"
    queries = [f"{song} 女声 翻唱", f"{song} 女声版", f"{song} 翻唱"]
    seen, candidates = set(), []
    for q in queries:
        try:
            for item in search_covers(q):
                if item["bv"] in seen:
                    continue
                if re.search(r"男声|男生|原唱", item["title"]):
                    continue
                seen.add(item["bv"])
                candidates.append(item)
        except Exception as error:  # 搜索挂了就往下走，别把整首带崩
            print(f"  ! 搜索「{q}」失败：{error}", flush=True)
    if not candidates:
        raise SystemExit(f"没搜到《{song}》的女声翻唱")
    print(f"  候选 {len(candidates)} 个：" + "、".join(c["title"][:18] for c in candidates[:MAX_CANDIDATES]), flush=True)

    for cand in candidates[:MAX_CANDIDATES]:
        bv = cand["bv"]
        src = os.path.join("E:\\音色素材", bv + ".wav")
        work = os.path.join(work_root, bv)
        os.makedirs(work, exist_ok=True)
        vocals = os.path.join(work, f"{bv}_(vocals)_model_bs_roformer_ep_317_sdr_12.wav")
        try:
            if not os.path.exists(src):
                stage("download", f"{bv} {cand['title'][:20]}")
                run([sys.executable, DL, bv])
            if not os.path.exists(vocals):
                stage("separate", bv)
                run([PY, SEP, src, work])
            f0 = vocal_f0(vocals)
            stage("f0-check", f"{bv} {f0:.0f} Hz")
            if FEMALE_LO <= f0 <= FEMALE_HI:
                return bv, f"{cand['title'][:24]}（{f0:.0f} Hz）"
            print(f"  ! {bv} 中位 {f0:.0f} Hz，不像女声，换下一个", flush=True)
        except subprocess.CalledProcessError as error:
            print(f"  ! {bv} 处理失败：{error}", flush=True)
    raise SystemExit("前几个候选都不是女声源")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", required=True, help="歌名，或 BV 号 / B 站链接")
    ap.add_argument("--pitch", type=int, default=0)
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "sing"))
    ap.add_argument("--result", default="", help="把 {bv, mp3} 写进这个 json，给 bot 读")
    args = ap.parse_args()

    work_root = args.out
    os.makedirs(work_root, exist_ok=True)
    bv, why = pick_source(args.song, work_root)
    print(f"SOURCE {bv} {why}", flush=True)

    work = os.path.join(work_root, bv)
    vocals = os.path.join(work, f"{bv}_(vocals)_model_bs_roformer_ep_317_sdr_12.wav")
    inst = os.path.join(work, f"{bv}_(other)_model_bs_roformer_ep_317_sdr_12.wav")
    if not os.path.exists(inst):
        raise SystemExit(f"伴奏没分离出来：{inst}")

    chunks = os.path.join(work, "chunks")
    shutil.rmtree(chunks, ignore_errors=True)
    os.makedirs(chunks)
    stage("split")
    run([FFMPEG, "-hide_banner", "-v", "error", "-y", "-i", vocals,
         "-f", "segment", "-segment_time", "60", "-reset_timestamps", "1",
         os.path.join(chunks, "c%02d.wav")])

    env = dict(os.environ, PYTHONPATH=".", PYTHONUTF8="1")
    parts = sorted(f for f in os.listdir(chunks) if f.startswith("c") and f.endswith(".wav"))
    for i, f in enumerate(parts):
        stage("rvc", f"{i + 1}/{len(parts)} {f}")
        run([PY, "-m", "infer.cli", "--model", MODEL,
             "--input", os.path.join(chunks, f), "--output", os.path.join(chunks, "out-" + f),
             "--pitch", str(args.pitch), "--f0-method", "rmvpe", "--index-rate", "0"],
            cwd=RVC, env=env)

    stage("concat")
    with open(os.path.join(chunks, "list.txt"), "w", encoding="utf8") as fh:
        for f in parts:
            fh.write(f"file 'out-{f}'\n")
    merged = os.path.join(work, "vocals-her.wav")
    run([FFMPEG, "-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0",
         "-i", "list.txt", "-c", "copy", merged], cwd=chunks)

    stage("mix")
    mp3 = os.path.join(args.out, f"{bv}-她唱的.mp3")
    run([FFMPEG, "-hide_banner", "-v", "error", "-y", "-i", inst, "-i", merged,
         "-filter_complex", "[1:a]volume=1.3[v];[0:a][v]amix=inputs=2:duration=first,loudnorm=I=-14:TP=-1.0:LRA=11",
         "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", mp3])
    print("DONE", mp3, flush=True)
    if args.result:
        with open(args.result, "w", encoding="utf8") as fh:
            json.dump({"bv": bv, "mp3": mp3, "source": why}, fh, ensure_ascii=False)


if __name__ == "__main__":
    main()
