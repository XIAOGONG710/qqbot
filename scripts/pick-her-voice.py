"""在她「录」的那批里挑最像说话的几句（2026-11-01）。

挑法：响度接近 -22dB（不炸不轻）、有声比例高、停顿不多、音高接近 300Hz（她说的“别太尖”）。
输出到 --out 目录，文件名里带上原句，方便直接听。

用法：python scripts/pick-her-voice.py [--top 3]
"""
import argparse
import json
import os
import shutil
import sys
import warnings

warnings.filterwarnings("ignore")


def measure(path: str):
    import librosa
    import numpy as np

    y, sr = librosa.load(path, sr=16000, mono=True)
    if len(y) < sr:
        return None
    y, _ = librosa.effects.trim(y, top_db=40)
    f0 = librosa.yin(y, fmin=60, fmax=500, sr=sr)
    f0 = f0[np.isfinite(f0) & (f0 > 0)]
    pitch = float(np.median(f0)) if f0.size else 0.0
    rms = float(np.sqrt(np.mean(y ** 2)) + 1e-12)
    loud = 20 * float(np.log10(rms))
    frame = librosa.feature.rms(y=y, frame_length=400, hop_length=160)[0]
    speech = float(np.mean(frame > (frame.max() * 0.08))) if frame.size else 0.0
    intervals = librosa.effects.split(y, top_db=35)
    pauses = max(0, len(intervals) - 1)
    score = abs(loud + 22) * 1.0 + abs(pitch - 300) * 0.02 + (1 - speech) * 6 + pauses * 0.3
    return {"pitch": pitch, "loud": loud, "speech": speech, "pauses": pauses, "score": score}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="runtime/voice/her-recordings")
    ap.add_argument("--top", type=int, default=3)
    ap.add_argument("--out", default=os.path.join(os.path.expanduser("~"), "Desktop", "她的声音", "她念的"))
    args = ap.parse_args()

    manifest = json.load(open(os.path.join(args.dir, "manifest.json"), encoding="utf-8"))
    rows = []
    for name, text in manifest.items():
        path = os.path.join(args.dir, name)
        if not os.path.exists(path):
            continue
        try:
            m = measure(path)
        except Exception:
            continue
        if m:
            rows.append((name, text, m))
    rows.sort(key=lambda r: r[2]["score"])
    os.makedirs(args.out, exist_ok=True)
    for i, (name, text, m) in enumerate(rows[:args.top], 1):
        safe = text.replace("/", "、").replace("\\", "、")[:18]
        dst = os.path.join(args.out, f"{i}-{safe}.wav")
        shutil.copyfile(os.path.join(args.dir, name), dst)
        print(f"{i}. {name} pitch={m['pitch']:.0f}Hz loud={m['loud']:.1f}dB 停顿={m['pauses']}  「{text}」")
    print(f"\n挑出来放在 {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
