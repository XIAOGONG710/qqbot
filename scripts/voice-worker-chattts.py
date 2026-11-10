r"""她的语音 worker：ChatTTS 念 → RVC 换成她的音色 → 后处理成手机随手录的样子（2026-11-06）。

接法：和原来的 IndexTTS worker 一样走文件队列（packages/bot/src/vision/voice-out.ts）：
  机器人把 {"text", "emo"?, "style"?} 写进 <dir>/queue/in/<id>.json，这里生成 wav，再把 {"ok", "wav"} 写到 <dir>/queue/out/<id>.json。
  style 是 voice-text.ts 的 voiceStyle：oral 0–9 口语、laugh 0–2 笑、breaks 0–7 停顿、speed 0–9 语速。

装法（在 DSH 那台机器上）：
  1. 建一个目录，例如 runtime\chattts，放进本脚本，改名 worker.py；建 .venv 并装 ChatTTS（pip install ChatTTS torch torchaudio）。
  2. 同目录写 worker.json（见下面 DEFAULT_CONFIG 的字段；没写的用默认值）。
  3. 先挑说话人：python worker.py --pick-speakers 12  → samples\spk-XX.wav 听一遍，挑最年轻、最亮、最甜的那个，
     把 samples\spk-XX.txt 复制成 speaker.txt（之后每条语音都是这个人，音色才稳定）。
  4. 试一句：python worker.py --once "嗯……我在呢，你说嘛"  → 听 samples\once.wav。
  5. （可选，让音色更稳）生成训练素材：python worker.py --make-dataset 25  → dataset\ 里约 25 分钟、各种语气的同一个声音，
     听一遍删掉念坏的，拿去训 RVC（她的 .pth / .index），填进 worker.json 的 rvc。全是合成声音，不涉及任何真实的人。
  6. 机器人那边设 QQBOT_TTS_DIR=这个目录（voice-out.ts 会用 <dir>\.venv\Scripts\python.exe <dir>\worker.py 拉起它）。

调「甜」（用户 11-06：「甜一点，小女友那种感觉」）：
  - 音色主要看两件事：挑的 ChatTTS 说话人（第 3 步），和 RVC 用来训练的声音。rvc.extra_args 里默认 --f0-up-key 2（升 2 个半音），偏甜偏亮；
    太尖就改回 0 或 1。后处理 eq 稍微提一点 3 kHz 左右（亮），压一点齿音。
  - 语气交给机器人那边的 style（平常就带一点笑、语速稍慢）。
电音 / 发闷：多半是 RVC 的参数，按下面 rvc 的说明调 index_rate、protect；还不行就是训练数据不够干净或轮数过多。

许可：ChatTTS 的模型权重是 CC BY-NC 4.0（非商用）；RVC 训练用的声音要有对方授权。
"""
import argparse
import glob
import json
import os
import random
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))

DEFAULT_CONFIG = {
    # 固定说话人：--pick-speakers 挑好后放在这里（ChatTTS 的说话人字符串）
    "speaker_file": "speaker.txt",
    "temperature": 0.3,       # 太高会出怪音、吞字
    "top_p": 0.7,
    "top_k": 20,
    "sample_rate": 24000,
    "rvc": {
        "enabled": True,
        "python": "",          # RVC 的 python（留空就用当前这个）
        "cwd": "",             # RVC 仓库目录（python -m infer.cli 在这里跑）
        "model": "",           # 她的 .pth
        "index": "",           # 对应的 .index（可空）
        "index_rate": 0.6,     # 0.5–0.75：太高会把训练数据的口音和杂音带进来
        # 下面这些参数名按你那份 RVC 的 infer.cli 来（我这边没有那份代码，名字是按常见写法猜的）；
        # RVC 报「不认识的参数」就把那一对删掉或改成它的叫法。--f0-up-key 2 = 升 2 个半音，偏甜偏亮，太尖就调小；
        # rmvpe 提音高最稳；protect 0.33 保住换气声和清辅音（像真人的关键）
        "extra_args": ["--f0-up-key", "2", "--f0-method", "rmvpe", "--protect", "0.33"],
    },
    "post": {
        "enabled": True,
        "ffmpeg": "ffmpeg",
        # 去低频轰声、限高频（像手机）、轻提 3 kHz（亮）、压齿音、响度统一；开头留一点空白
        "filter": "highpass=f=90,lowpass=f=9500,equalizer=f=3000:t=q:w=1.2:g=2,deesser=i=0.3,loudnorm=I=-18:TP=-2:LRA=9,adelay=120|120",
    },
}


def load_config() -> dict:
    path = os.path.join(HERE, "worker.json")
    config = json.loads(json.dumps(DEFAULT_CONFIG))
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            user = json.load(f)
        for key, value in user.items():
            if isinstance(value, dict) and isinstance(config.get(key), dict):
                config[key].update(value)
            else:
                config[key] = value
    return config


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


class Voice:
    def __init__(self, config: dict):
        import ChatTTS  # noqa: 只在真正要念的时候才加载
        import torch
        self.torch = torch
        self.ChatTTS = ChatTTS
        self.config = config
        self.chat = ChatTTS.Chat()
        self.chat.load(compile=False)
        spk_path = os.path.join(HERE, config["speaker_file"])
        self.speaker = open(spk_path, encoding="utf-8").read().strip() if os.path.exists(spk_path) else None
        if not self.speaker:
            log("还没挑说话人（speaker.txt），先用随机的；音色会每次不一样，先跑 --pick-speakers")

    def tts(self, text: str, style: dict, out_wav: str, speaker: str | None = None) -> None:
        import torchaudio
        oral, laugh, breaks, speed = (int(style.get(k, d)) for k, d in (("oral", 4), ("laugh", 1), ("breaks", 4), ("speed", 4)))
        spk = speaker or self.speaker or self.chat.sample_random_speaker()
        code = self.ChatTTS.Chat.InferCodeParams(
            spk_emb=spk, temperature=self.config["temperature"], top_P=self.config["top_p"], top_K=self.config["top_k"],
            prompt=f"[speed_{speed}]",
        )
        refine = self.ChatTTS.Chat.RefineTextParams(prompt=f"[oral_{oral}][laugh_{laugh}][break_{breaks}]")
        wavs = self.chat.infer([text], params_refine_text=refine, params_infer_code=code)
        audio = self.torch.from_numpy(wavs[0]).unsqueeze(0) if wavs[0].ndim == 1 else self.torch.from_numpy(wavs[0])
        torchaudio.save(out_wav, audio, self.config["sample_rate"])


def rvc(config: dict, src: str, dst: str) -> str:
    r = config["rvc"]
    if not r.get("enabled") or not r.get("model"):
        return src
    cmd = [r.get("python") or sys.executable, "-m", "infer.cli", "--model", r["model"], "--input", src, "--output", dst,
           "--index-rate", str(r["index_rate"])]
    if r.get("index"):
        cmd += ["--index", r["index"]]
    cmd += [str(a) for a in r.get("extra_args", [])]
    done = subprocess.run(cmd, cwd=r.get("cwd") or None, capture_output=True, text=True, timeout=120)
    if done.returncode != 0 or not os.path.exists(dst):
        log(f"RVC 没转成（{done.returncode}）：{(done.stderr or done.stdout)[-300:]}；这条先用 ChatTTS 原声")
        return src
    return dst


def post(config: dict, src: str, dst: str) -> str:
    p = config["post"]
    if not p.get("enabled"):
        return src
    done = subprocess.run([p["ffmpeg"], "-v", "error", "-y", "-i", src, "-af", p["filter"], "-ar", "24000", "-ac", "1", dst],
                          capture_output=True, text=True, timeout=60)
    if done.returncode != 0 or not os.path.exists(dst):
        log(f"后处理没做成：{done.stderr[-300:]}；用处理前的")
        return src
    return dst


def speak(voice: Voice, config: dict, text: str, style: dict, base: str) -> str:
    raw = f"{base}.tts.wav"
    voice.tts(text, style, raw)
    converted = rvc(config, raw, f"{base}.rvc.wav")
    final = post(config, converted, f"{base}.wav")
    for temp in (raw, f"{base}.rvc.wav"):  # 中间文件不留
        if temp != final and os.path.exists(temp):
            os.remove(temp)
    return final


def run_queue(config: dict) -> None:
    inbox, outbox = os.path.join(HERE, "queue", "in"), os.path.join(HERE, "queue", "out")
    os.makedirs(inbox, exist_ok=True)
    os.makedirs(outbox, exist_ok=True)
    voice = Voice(config)
    log("worker 就绪，等 queue/in 里的句子")
    while True:
        for path in sorted(glob.glob(os.path.join(inbox, "*.json"))):
            job_id = os.path.splitext(os.path.basename(path))[0]
            result = {"ok": False}
            try:
                with open(path, encoding="utf-8") as f:
                    job = json.load(f)
                text = str(job.get("text", "")).strip()
                if text:
                    started = time.time()
                    wav = speak(voice, config, text, job.get("style") or {}, os.path.join(outbox, job_id))
                    result = {"ok": True, "wav": os.path.abspath(wav)}
                    log(f"{job_id}：{len(text)} 字，{time.time() - started:.1f} 秒")
            except Exception as error:  # 一条坏了不影响下一条
                log(f"{job_id} 出错：{error}")
            finally:
                try:
                    os.remove(path)
                except OSError:
                    pass
                tmp = os.path.join(outbox, f"{job_id}.json.tmp")
                with open(tmp, "w", encoding="utf-8") as f:
                    json.dump(result, f, ensure_ascii=False)
                os.replace(tmp, os.path.join(outbox, f"{job_id}.json"))
        time.sleep(0.3)


# 训练素材（--make-dataset）：用挑好的说话人把这些句子按各种语气念一遍，拿去训 RVC。
# 全是合成的声音（ChatTTS 的随机说话人不对应任何真实的人），没有授权问题。
# 句子覆盖她平时跟他说话的样子：应声、撒娇、笑、困、累、担心、小抱怨、问他、长一点的叙述；不含真实的人名地名。
DATASET_LINES = {
    "plain": [
        "嗯，我在呢，你说吧。", "刚下课，正往回走呢。", "今天食堂的面还挺好吃的。", "我等会儿要去图书馆，晚点再跟你说。",
        "你吃饭了没呀？", "这周作业有点多，不过还行。", "外面风好大，我把窗户关上了。", "刚洗完头，头发还湿着呢。",
        "我在宿舍躺着，啥也不想干。", "明天早上有课，得早点睡了。", "你那边天气怎么样？", "我刚才去楼下买了瓶水。",
    ],
    "sweet": [
        "你回来啦？我等你好久了。", "哎呀，你别这样嘛，我会不好意思的。", "那你要记得想我哦。", "就一会儿嘛，陪我聊聊天好不好？",
        "我才没有生气呢，就是想让你哄哄我。", "你今天有没有想我呀？", "嗯……那好吧，听你的。", "晚安啦，梦里见。",
        "你夸我一下嘛，就一下。", "抱抱，今天有点累。", "你最好了，我就知道。", "下次一起去嘛，好不好？",
    ],
    "happy": [
        "哈哈哈，你也太逗了吧！", "真的吗？那也太好了！", "嘿嘿，我今天小测考得还不错。", "我跟你说，今天碰到一件超好玩的事。",
        "哇，这个好好看，我也想要。", "笑死我了，你怎么想出来的？", "好耶，周末可以睡懒觉了！", "我刚才看到晚霞了，特别好看。",
    ],
    "tired": [
        "好困啊……眼睛都睁不开了。", "今天真的好累，不想动了。", "嗯……我先睡一会儿，醒了找你。", "作业还没写完，好烦，写不动了。",
        "唉，感觉一天什么都没干成。", "我先躺一下，等会儿再说。",
    ],
    "worried": [
        "你到了没？到了跟我说一声。", "你是不是不舒服呀？", "这么晚了，路上小心点。", "我有点担心明天的考试。",
        "你别太累了，早点休息。", "你今天怎么这么安静？",
    ],
    "pout": [
        "哼，你都不理我。", "你又忘了，每次都这样。", "我不管，你得补偿我。", "说好的呢？你骗人。",
        "算了，不跟你说了。", "你怎么才回我呀？",
    ],
    "long": [
        "今天上课的时候老师突然点我回答问题，我一下子就懵了，还好旁边同学小声提醒了我一下，不然就尴尬死了。",
        "我刚才在楼下喂猫，它今天特别黏人，一直蹭我的手，我蹲了好久都不想走。",
        "其实也没什么大事，就是最近有点累，作业一堆，晚上还睡不好，跟你说说就好多了。",
        "下周末要是天气好的话，我们去公园走走吧，我想拍点照片，顺便吃点好吃的。",
    ],
}
DATASET_STYLES = {
    "plain": {"oral": 4, "laugh": 0, "breaks": 4, "speed": 5},
    "sweet": {"oral": 5, "laugh": 1, "breaks": 4, "speed": 4},
    "happy": {"oral": 5, "laugh": 2, "breaks": 3, "speed": 6},
    "tired": {"oral": 3, "laugh": 0, "breaks": 6, "speed": 3},
    "worried": {"oral": 3, "laugh": 0, "breaks": 5, "speed": 4},
    "pout": {"oral": 5, "laugh": 0, "breaks": 3, "speed": 5},
    "long": {"oral": 4, "laugh": 1, "breaks": 5, "speed": 5},
}


def make_dataset(config: dict, minutes: float) -> None:
    """按各种语气把句子念若干遍，直到总时长够 minutes 分钟；只做响度统一，不加手机 EQ（训练素材要干净）。"""
    import wave
    voice = Voice(config)
    if not voice.speaker:
        log("先挑说话人（--pick-speakers），把最甜的那个复制成 speaker.txt，再生成训练素材")
        return
    out = os.path.join(HERE, "dataset")
    os.makedirs(out, exist_ok=True)
    manifest, total, round_no = [], 0.0, 0
    while total < minutes * 60:
        round_no += 1
        for style_name, lines in DATASET_LINES.items():
            for i, text in enumerate(lines):
                base = os.path.join(out, f"{style_name}-{i:02d}-r{round_no}")
                raw = f"{base}.raw.wav"
                voice.tts(text, DATASET_STYLES[style_name], raw)  # 每遍随机性不同，同一句会有不同的念法
                done = subprocess.run([config["post"]["ffmpeg"], "-v", "error", "-y", "-i", raw, "-af", "highpass=f=60,loudnorm=I=-20:TP=-2",
                                       "-ar", "40000", "-ac", "1", f"{base}.wav"], capture_output=True, text=True, timeout=60)
                final = f"{base}.wav" if done.returncode == 0 and os.path.exists(f"{base}.wav") else raw
                if final != raw and os.path.exists(raw):
                    os.remove(raw)
                with wave.open(final) as w:
                    seconds = w.getnframes() / w.getframerate()
                total += seconds
                manifest.append({"file": os.path.basename(final), "text": text, "style": style_name, "seconds": round(seconds, 2)})
        log(f"第 {round_no} 遍念完，累计 {total / 60:.1f} 分钟")
    with open(os.path.join(out, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump({"speaker_file": config["speaker_file"], "minutes": round(total / 60, 1), "items": manifest}, f, ensure_ascii=False, indent=1)
    log(f"训练素材在 {out}（{len(manifest)} 段，{total / 60:.1f} 分钟）；先听一遍，把念坏的（吞字、怪音）删掉再拿去训 RVC")


def main() -> None:
    parser = argparse.ArgumentParser(description="她的语音 worker（ChatTTS + RVC）")
    parser.add_argument("--pick-speakers", type=int, metavar="N", help="随机生成 N 个说话人，各念一句，存到 samples/ 供挑选")
    parser.add_argument("--once", metavar="TEXT", help="用 speaker.txt 念一句，存到 samples/once.wav")
    parser.add_argument("--make-dataset", type=float, metavar="MINUTES", help="用 speaker.txt 按各种语气生成 RVC 训练素材，到 dataset/")
    args = parser.parse_args()
    if args.make_dataset:
        make_dataset(load_config(), args.make_dataset)
        return
    config = load_config()
    samples = os.path.join(HERE, "samples")
    os.makedirs(samples, exist_ok=True)
    line = "嗯……你回来啦？我刚还在想你呢，嘿嘿。"
    if args.pick_speakers:
        voice = Voice(config)
        for i in range(args.pick_speakers):
            spk = voice.chat.sample_random_speaker()
            base = os.path.join(samples, f"spk-{i:02d}")
            with open(f"{base}.txt", "w", encoding="utf-8") as f:
                f.write(spk)
            voice.tts(line, {"oral": 4, "laugh": 1, "breaks": 4, "speed": 4}, f"{base}.wav", speaker=spk)
            log(f"{base}.wav")
        log("听完把最甜的那个 spk-XX.txt 复制成 speaker.txt")
        return
    if args.once:
        voice = Voice(config)
        log(speak(voice, config, args.once, {"oral": 4, "laugh": 1, "breaks": 4, "speed": 4}, os.path.join(samples, "once")))
        return
    random.seed()
    run_queue(config)


if __name__ == "__main__":
    main()
