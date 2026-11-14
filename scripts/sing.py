"""让她唱一首：歌名或 BV -> 找女声源 -> 下载 -> 分离人声 -> 分块 RVC -> 拼回 -> 混伴奏 -> mp3。

用法:
  python scripts/sing.py --song BV1hW4y1Y7dG
  python scripts/sing.py --song 稻香            # 搜女声翻唱，验过音高才用
  python scripts/sing.py --song 稻香 --pitch 0 --out E:\\qqbot-dsh-control\\out\\sing

每步打一行 STAGE，最后一行 DONE <mp3 路径>，方便 bot 那边读日志。
"""
import argparse
import atexit
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


def run(cmd, cwd=None, env=None, timeout=None):
    print("  $", " ".join(cmd[:6]), flush=True)
    subprocess.run(cmd, cwd=cwd, env=env, check=True, timeout=timeout)


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
    """返回 (bv, 说明)。给 BV 就直接用。

    给歌名时先看**原唱**（用户 2026-11-14：原唱是女声就直接用，只有原唱是男声才另找女声翻唱）：
    1. 搜「<歌名> 原唱」「<歌名>」，播放最高的前两个候选取来验音高；
    2. 都不合格（男声源）才搜「女声 翻唱 / 女声版 / 翻唱」，再验；
    3. 音高验不过的一律跳过——RVC 用男声源转出来会怪。
    """
    m = re.search(r"(BV[0-9A-Za-z]{10})", song)
    if m:
        return m.group(1), "直接指定"

    originals = search_group([f"{song} 原唱", song], skip_male_marker=False)[:2]
    covers = search_group([f"{song} 女声 翻唱", f"{song} 女声版", f"{song} 翻唱"], skip_male_marker=True)

    seen, candidates = set(), []
    for item, kind in [(c, "原唱") for c in originals] + [(c, "翻唱") for c in covers]:
        if item["bv"] in seen:
            continue
        seen.add(item["bv"])
        candidates.append((item, kind))
    if not candidates:
        raise SystemExit(f"没搜到《{song}》的可用源")
    print("  候选：" + "、".join(f"{k}:{c['title'][:14]}" for c, k in candidates[:MAX_CANDIDATES]), flush=True)

    for cand, kind in candidates[:MAX_CANDIDATES]:
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
            stage("f0-check", f"{bv} {kind} {f0:.0f} Hz")
            if FEMALE_LO <= f0 <= FEMALE_HI:
                return bv, f"{kind}：{cand['title'][:24]}（{f0:.0f} Hz）"
            print(f"  ! {bv}（{kind}）中位 {f0:.0f} Hz，不是女声源，换下一个", flush=True)
        except subprocess.CalledProcessError as error:
            print(f"  ! {bv} 处理失败：{error}", flush=True)
    raise SystemExit("前几个候选都不是女声源")


def search_group(queries, skip_male_marker: bool):
    """按一组关键词搜，合并去重，播放高的在前"""
    seen, out = set(), []
    for q in queries:
        try:
            for item in search_covers(q):
                if item["bv"] in seen:
                    continue
                if skip_male_marker and re.search(r"男声|男生", item["title"]):
                    continue
                seen.add(item["bv"])
                out.append(item)
        except Exception as error:  # 搜索挂了就往下走，别把整首带崩
            print(f"  ! 搜索「{q}」失败：{error}", flush=True)
    out.sort(key=lambda x: x["play"], reverse=True)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--song", required=True, help="歌名，或 BV 号 / B 站链接")
    ap.add_argument("--pitch", type=int, default=0)
    ap.add_argument("--out", default=os.path.join(ROOT, "out", "sing"))
    ap.add_argument("--result", default="", help="把 {bv, mp3} 写进这个 json，给 bot 读")
    ap.add_argument("--ratio", type=float, default=4.0, help="伴奏比人声低多少 dB（默认 4）")
    ap.add_argument("--mix-only", action="store_true", help="跳过下载/分离/转换，只按现有 stems 重混")
    ap.add_argument("--force", action="store_true", help="已经有成品也重唱一遍")
    ap.add_argument("--keep-chunks", action="store_true", help="保留分块中间产物（排查用）")
    args = ap.parse_args()

    work_root = args.out
    os.makedirs(work_root, exist_ok=True)
    guard(work_root, args.result)
    bv, why = pick_source(args.song, work_root)
    print(f"SOURCE {bv} {why}", flush=True)
    args.song_bv = bv
    args.source_note = why

    work = os.path.join(work_root, bv)
    vocals = os.path.join(work, f"{bv}_(vocals)_model_bs_roformer_ep_317_sdr_12.wav")
    inst = os.path.join(work, f"{bv}_(other)_model_bs_roformer_ep_317_sdr_12.wav")
    merged = os.path.join(work, "vocals-her.wav")
    if not os.path.exists(inst):
        raise SystemExit(f"伴奏没分离出来：{inst}")

    # 同一首歌唱过就直接给成品：素材、分块都不重跑（用户再点一次不用再等 5 分钟）
    cached = os.path.join(args.out, f"{bv}-她唱的.mp3")
    if not args.force and not args.mix_only and os.path.exists(cached):
        stage("cached", bv)
        finish(args, cached)
        return

    if args.mix_only:
        if not os.path.exists(merged):
            raise SystemExit(f"还没转过人声：{merged}")
        stage("mix", "复用已转人声")
        mix(args, inst, merged)
        return

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
        out_chunk = os.path.join(chunks, "out-" + f)
        if os.path.exists(out_chunk):
            continue
        # 单个分块最坏情况会上百秒；卡住就掐掉重来一次——整曲一次跑卡过 44 分钟，不能没有兜底
        for attempt in (1, 2):
            try:
                run([PY, "-m", "infer.cli", "--model", MODEL,
                     "--input", os.path.join(chunks, f), "--output", out_chunk,
                     "--pitch", str(args.pitch), "--f0-method", "rmvpe", "--index-rate", "0"],
                    cwd=RVC, env=env, timeout=900)
                break
            except subprocess.TimeoutExpired:
                print(f"  ! {f} 第 {attempt} 次超时，重来", flush=True)
                if attempt == 2:
                    raise SystemExit(f"分块 {f} 一直转不出来")

    stage("concat")
    with open(os.path.join(chunks, "list.txt"), "w", encoding="utf8") as fh:
        for f in parts:
            fh.write(f"file 'out-{f}'\n")
    run([FFMPEG, "-hide_banner", "-v", "error", "-y", "-f", "concat", "-safe", "0",
         "-i", "list.txt", "-c", "copy", merged], cwd=chunks)

    stage("mix")
    mix(args, inst, merged)
    # 分块只是中间产物（几十 MB），成品和 stems 留着供重混
    if not args.keep_chunks:
        shutil.rmtree(chunks, ignore_errors=True)


def guard(work_root: str, result_path: str = "") -> None:
    """同一时间只跑一首：两个进程抢 8 GB 显存会一起崩。拿不到锁就直接退出，让 bot 回一句。"""
    lock = os.path.join(work_root, ".sing.lock")
    try:
        fd = os.open(lock, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
    except FileExistsError:
        try:
            pid = int(open(lock, encoding="utf8").read().strip() or 0)
        except Exception:
            pid = 0
        if pid and _alive(pid):
            print("BUSY 已经有一首在唱了", flush=True)
            if result_path:      # 让 bot 立刻知道是「忙着」，不用等 30 分钟超时
                with open(result_path, "w", encoding="utf8") as fh:
                    json.dump({"busy": True}, fh)
            raise SystemExit(3)
        os.remove(lock)          # 残留的旧锁，接着用
        return guard(work_root, result_path)
    with os.fdopen(fd, "w", encoding="utf8") as fh:
        fh.write(str(os.getpid()))
    atexit.register(lambda: os.path.exists(lock) and os.remove(lock))


def _alive(pid: int) -> bool:
    import ctypes
    kernel = ctypes.windll.kernel32 if os.name == "nt" else None
    if kernel is None:
        return True
    handle = kernel.OpenProcess(0x1000, False, pid)
    if handle:
        kernel.CloseHandle(handle)
        return True
    return False


def lufs(path: str) -> float:
    """整段的综合响度（LUFS）；量不出来给 NaN"""
    res = subprocess.run([FFMPEG, "-hide_banner", "-nostats", "-i", path, "-af", "ebur128", "-f", "null", "-"],
                         capture_output=True, text=True, errors="ignore")
    found = re.findall(r"I:\s+(-?\d+\.\d) LUFS", res.stderr)
    return float(found[-1]) if found else float("nan")


def mix(args, inst: str, vocals: str) -> None:
    """伴奏压到「比她低 ratio dB」：她的音色和音高不动，只把伴奏让出来。
    比例按两个 stem 的实测 LUFS 算，换首歌也能用。"""
    lv, li = lufs(vocals), lufs(inst)
    gain_db = min(0.0, max(-18.0, (lv - args.ratio) - li)) if lv == lv and li == li else -6.0
    gain = 10 ** (gain_db / 20)
    stage("mix-gain", f"人声 {lv:.1f} / 伴奏 {li:.1f} LUFS → 伴奏 {gain_db:+.1f} dB（目标低 {args.ratio} dB）")
    mp3 = os.path.join(args.out, f"{args.song_bv}-她唱的.mp3")
    filter_complex = (
        f"[0:a]volume={gain:.4f}[i];[1:a]volume=1.0[v];"
        "[i][v]amix=inputs=2:duration=first,loudnorm=I=-14:TP=-1.0:LRA=11"
    )
    run([FFMPEG, "-hide_banner", "-v", "error", "-y", "-i", inst, "-i", vocals,
         "-filter_complex", filter_complex, "-ar", "44100", "-c:a", "libmp3lame", "-b:a", "192k", mp3])
    finish(args, mp3, inst_gain_db=round(gain_db, 1))


def finish(args, mp3, inst_gain_db=None):
    """收尾：打 DONE、给 bot 写结果文件（有了它 bot 才不用猜文件名）"""
    mp3 = os.path.abspath(mp3)
    print("DONE", mp3, flush=True)
    if getattr(args, "result", ""):
        payload = {"bv": args.song_bv, "mp3": mp3, "source": getattr(args, "source_note", "")}
        if inst_gain_db is not None:
            payload["instGainDb"] = inst_gain_db
        with open(args.result, "w", encoding="utf8") as fh:
            json.dump(payload, fh, ensure_ascii=False)


if __name__ == "__main__":
    main()
