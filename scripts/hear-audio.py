"""听声音：把一段音频听成一句中文。

用法：
    python scripts/hear-audio.py <音频路径> [--json]
    python scripts/hear-audio.py bili-dmqq/人声/*.mp3   # 只测前 3 个

输出（给人看）：
    语速偏慢，声音偏低，安静，几乎没停顿

输出（--json，给她的 hearing 实现用）：
    {"seconds": 82.6, "speech": 0.71, "loud": -22.4, "pitch": 178.2,
     "tempo": 96.0, "pauses": 2, "desc": "…"}
"""
import json
import sys
import warnings

warnings.filterwarnings("ignore")

F0_MIN, F0_MAX = 60.0, 500.0


def hear(path: str) -> dict:
    import librosa
    import numpy as np

    y, sr = librosa.load(path, sr=16000, mono=True)
    y, _ = librosa.effects.trim(y, top_db=40)
    seconds = float(len(y) / sr)
    duration = seconds

    if duration < 0.2:
        return {"seconds": round(duration, 1), "desc": "太短了，听不清"}

    # 声音低/高：取有声段的基频中位数
    try:
        f0 = librosa.yin(y, fmin=F0_MIN, fmax=F0_MAX, sr=sr)
        f0 = f0[np.isfinite(f0) & (f0 > 0)]
        pitch = float(np.median(f0)) if f0.size else 0.0
    except Exception:
        pitch = 0.0

    # 响度（dBFS）
    rms = float(np.sqrt(np.mean(y ** 2)) + 1e-12)
    loud = 20 * float(np.log10(rms))

    # 有没有说话：过零率 + 能量（把人声当“有声”，静音不算）
    frame = librosa.feature.rms(y=y, frame_length=400, hop_length=160)[0]
    speech = float(np.mean(frame > (frame.max() * 0.08))) if frame.size else 0.0

    # 语速：用节拍估算（说话时约 4–6 拍/秒 不适用，只取相对快慢）
    try:
        tempo = float(librosa.feature.rhythm.tempo(y=y, sr=sr)[0])
    except Exception:
        tempo = 0.0

    # 停顿：静音段超过 0.6 秒的个数
    intervals = librosa.effects.split(y, top_db=35)
    pauses = max(0, len(intervals) - 1)

    bits = []
    if speech < 0.05:
        bits.append("几乎没声音")
    elif speech < 0.35:
        bits.append("声音断断续续")
    else:
        bits.append("一直在说" if pauses > 3 else "说得挺连贯")

    if pitch:
        if pitch < 110:
            bits.append("声音偏低")
        elif pitch > 220:
            bits.append("声音偏高")
    if loud < -32:
        bits.append("说话很轻")
    elif loud > -14:
        bits.append("声音挺响")
    # 说话快慢：用「有声比例 / 停顿数」估，不靠节拍（人声没有节拍）
    if speech > 0.85 and pauses <= 3:
        bits.append("说得又快又密")
    elif pauses >= 10:
        bits.append("一句一句的，中间老停")
    if pauses >= 6:
        bits.append("停顿很多")
    elif pauses == 0 and speech > 0.5:
        bits.append("几乎没停顿")

    return {
        "seconds": round(duration, 1),
        "speech": round(speech, 2),
        "loud": round(loud, 1),
        "pitch": round(pitch, 1),
        "tempo": round(tempo, 1),
        "pauses": pauses,
        "desc": "，".join(bits),
    }


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv
    if not args:
        print(__doc__)
        return 2
    for path in args[:5]:
        try:
            result = hear(path)
        except Exception as error:
            print(f"{path}: 听不出来（{error}）", file=sys.stderr)
            continue
        if as_json:
            print(json.dumps({"path": path, **result}, ensure_ascii=False))
        else:
            print(f"{path}\n  → {result['seconds']} 秒：{result['desc']}")
            print(f"    speech={result['speech']} loud={result['loud']}dB pitch={result['pitch']}Hz tempo={result['tempo']} 停顿={result['pauses']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
