r"""下载社区的 RVC 模型，用她的一句话逐条转出来，方便听。

模型来源：HF 镜像上的 lowo/RVC-weights（288 个 pth，名字大多无意义，这里挑「命名像女声」的）。
用法：
    cd runtime/voice/RVC
    $env:PYTHONPATH="."; ..\venv312\Scripts\python.exe ..\..\scripts\rvc-try-models.py
输出：runtime/voice/RVC/community/<名字>.wav + 桌面\她的声音\社区模型试听\
"""
import json
import os
import subprocess
import sys
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 仓库根
REPO = os.path.join(ROOT, "runtime", "voice")
RVC = os.path.join(REPO, "RVC")
PY = os.path.join(REPO, "venv312", "Scripts", "python.exe")
OUT = os.path.join(RVC, "community")
DESKTOP = os.environ.get("RVC_DESKTOP") or os.path.join(REPO, "community-out")
SRC = os.path.join(RVC, "test-in.wav")  # 她的那句话（IndexTTS 定版音色）
BASE = "https://hf-mirror.com/lowo/RVC-weights/resolve/main/"

# 挑「名字像女声」的 16 个（少女/温柔/御姐/软）
MODELS = [
    "!!!!yezi48k.pth", "1shaonv15.pth", "Lanlan.pth", "NUOMI.pth",
    "Shaoyu.pth", "benxi-04.pth", "jiujishaoyu40k.pth", "lanlan.pth",
    "muqingguan.pth", "qinghe.pth", "rourou.pth", "taimei1300lun40k.pth",
    "wenrounvyin.pth", "wenrouyu.pth", "xiaoqing.pth", "xiaojuDLC.pth",
]


def fetch(name: str) -> str:
    os.makedirs(OUT, exist_ok=True)
    target = os.path.join(OUT, name)
    if os.path.exists(target) and os.path.getsize(target) > 1_000_000:
        return target
    url = BASE + urllib.parse.quote(name)
    print(f"[dl] {name}", flush=True)
    urllib.request.urlretrieve(url, target + ".part")
    os.replace(target + ".part", target)
    return target


def convert(path: str, name: str) -> str | None:
    stem = os.path.splitext(name)[0]
    out = os.path.join(OUT, f"{stem}.wav")
    if os.path.exists(out):
        return out
    env = dict(os.environ, PYTHONPATH=".")
    result = subprocess.run(
        [PY, "-m", "infer.cli", "--model", path, "--input", SRC, "--output", out, "--index-rate", "0"],
        cwd=RVC, env=env, capture_output=True, text=True, timeout=900,
    )
    if result.returncode != 0 or not os.path.exists(out):
        print(f"[x] {name}: {(result.stderr or result.stdout)[-160:]}", flush=True)
        return None
    print(f"[ok] {name}", flush=True)
    return out


def main() -> int:
    os.makedirs(DESKTOP, exist_ok=True)
    ok = 0
    for name in MODELS:
        try:
            path = fetch(name)
        except Exception as error:
            print(f"[x] 下载失败 {name}: {error}", flush=True)
            continue
        made = convert(path, name)
        if made:
            ok += 1
            target = os.path.join(DESKTOP, f"{ok:02d}-{os.path.splitext(name)[0]}.wav")
            try:
                open(target, "wb").write(open(made, "rb").read())
            except OSError:
                pass
    print(f"完成 {ok}/{len(MODELS)}，输出目录 {DESKTOP}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
