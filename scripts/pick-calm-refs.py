"""在语料里挑「最平静」的几段，当 IndexTTS 的参考音频。

昨晚卡在「情绪太高涨」——参考音频是兴奋的开场白。这批 B 站人声里有安静的段，
先用声音特征（音高、响度、停顿）排一下，再把平静的那几段切出来当参考。

用法：python scripts/pick-calm-refs.py [--top 5] [--out runtime/indextts/calm-refs]
"""
import argparse
import glob
import os
import subprocess
import sys
import warnings

warnings.filterwarnings("ignore")


def probe_seconds(path: str) -> float:
    out = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
                         capture_output=True, text=True).stdout.strip()
    try:
        return float(out)
    except ValueError:
        return 0.0


def measure(path: str, at: float = 10.0, seconds: float = 8.0):
    import librosa
    import numpy as np

    y, sr = librosa.load(path, sr=16000, mono=True, offset=at, duration=seconds)
    if len(y) < sr * 2:
        return None
    y, _ = librosa.effects.trim(y, top_db=40)
    if len(y) < sr * 2:
        return None
    f0 = librosa.yin(y, fmin=60, fmax=500, sr=sr)
    f0 = f0[np.isfinite(f0) & (f0 > 0)]
    pitch = float(np.median(f0)) if f0.size else 0.0
    rms = float(np.sqrt(np.mean(y ** 2)) + 1e-12)
    loud = 20 * float(np.log10(rms))
    # 2026-11-01：第一版把「几乎没声音」当成最平静——要挑的是「正常说话但语气平」，
    # 所以两头都罚：响度离 -24dB 越远越差，音高离 280Hz 越远越差；太安静的直接跳过。
    if loud < -34:
        return None
    calm = abs(loud + 24) + abs(pitch - 280) * 0.05
    return {"pitch": pitch, "loud": loud, "calm": calm}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--top", type=int, default=5)
    ap.add_argument("--out", default="runtime/indextts/calm-refs")
    ap.add_argument("--glob", default="bili-dmqq/人声/*.mp3")
    ap.add_argument("--at", type=float, default=10.0)
    args = ap.parse_args()

    files = sorted(glob.glob(args.glob))
    if not files:
        print("没找到语料", file=sys.stderr)
        return 2
    rows = []
    for path in files:
        if probe_seconds(path) < args.at + 8:
            continue
        try:
            m = measure(path, args.at)
        except Exception:
            continue
        if not m or m["pitch"] <= 0:
            continue
        rows.append((path, m))
    rows.sort(key=lambda r: r[1]["calm"])
    os.makedirs(args.out, exist_ok=True)
    for i, (path, m) in enumerate(rows[:args.top], 1):
        dst = os.path.join(args.out, f"calm-{i}.wav")
        subprocess.run([os.path.expanduser("~\\.dsh\\bin\\ffmpeg.exe"), "-v", "error", "-y",
                        "-ss", str(args.at), "-t", "8", "-i", path,
                        "-ar", "32000", "-ac", "1", dst], check=False)
        name = os.path.basename(path)
        print(f"calm-{i}: pitch={m['pitch']:.0f}Hz loud={m['loud']:.1f}dB  {name}")
    print(f"\n切好的参考音频在 {args.out}/")
    return 0


if __name__ == "__main__":
    sys.exit(main())
