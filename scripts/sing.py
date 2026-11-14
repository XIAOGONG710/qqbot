"""让她唱一首：BV/链接 -> 下载 -> 分离人声 -> 分块 RVC -> 拼回 -> 混伴奏 -> mp3。

用法:
  python scripts/sing.py --song BV1hW4y1Y7dG
  python scripts/sing.py --song BV1hW4y1Y7dG --pitch 0 --out E:\\qqbot-dsh-control\\out\\sing

每步打一行 STAGE，最后一行 DONE <mp3 路径>，方便 bot 那边读日志。
"""
import argparse
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PY = os.path.join(ROOT, "runtime", "gpt-sovits", ".venv", "Scripts", "python.exe")
RVC = os.path.join(ROOT, "runtime", "rvc-webui")
MODEL = os.path.join(RVC, "assets", "weights", "her12rvc.pth")
DL = os.path.join(ROOT, "out", "gpt-sovits", "bili_dl.py")
SEP = os.path.join(ROOT, "out", "gpt-sovits", "sep_one.py")
FFMPEG = "ffmpeg"


def stage(name, extra=""):
    print(f"STAGE {name} {extra}".strip(), flush=True)


def run(cmd, cwd=None, env=None):
    print("  $", " ".join(cmd[:6]), flush=True)
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def bv_of(song):
    m = re.search(r"(BV[0-9A-Za-z]{10})", song)
    if not m:
        raise SystemExit("给 BV 号或 bilibili 链接（标题搜索还没接）")
    return m.group(1)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", required=True, help="BV 号或 B 站链接")
    ap.add_argument("--pitch", type=int, default=0)
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "sing"))
    ap.add_argument("--reuse", action="store_true", help="已有下载/分离结果就复用")
    args = ap.parse_args()

    bv = bv_of(args.song)
    work = os.path.join(args.out, bv)
    os.makedirs(work, exist_ok=True)
    src = os.path.join("E:\\音色素材", bv + ".wav")

    if not (args.reuse and os.path.exists(src)):
        stage("download", bv)
        run([sys.executable, DL, bv])

    vocals = os.path.join(work, f"{bv}_(vocals)_model_bs_roformer_ep_317_sdr_12.wav")
    inst = os.path.join(work, f"{bv}_(other)_model_bs_roformer_ep_317_sdr_12.wav")
    if not (args.reuse and os.path.exists(vocals)):
        stage("separate")
        run([PY, SEP, src, work])

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
    lst = os.path.join(chunks, "list.txt")
    with open(lst, "w", encoding="utf8") as fh:
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


if __name__ == "__main__":
    main()
