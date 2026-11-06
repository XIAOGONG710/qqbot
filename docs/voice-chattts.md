# 她的声音：ChatTTS + RVC（给 DSH 看）

2026-11-06，用户：现在的语音「像在念稿、音色不像她、有电音、说的内容不像」，想要「自然随意的女大学生」「甜一点，小女友那种感觉」。
DSH 端现在用 ChatTTS + RVC；这次把机器人这一侧和 worker 都按这个方向改了。分支 `voice/natural-speech`。

## 声音从哪来

用 ChatTTS 自己的随机说话人：合成出来的声音，不对应任何真实的人，没有授权问题。
不用从主播、虚拟主播、游戏配音里「抽」的声音，也不用来源不明的社区 RVC 模型。

## 机器人这一侧（已改，有测试）

- `packages/bot/src/vision/voice-text.ts`
  - `speechText`：念之前把那句整理成念得顺的样子——去掉表情、小黄脸、链接、内部令牌；数字、时刻换成汉字（「20:30」→「八点半」）；整理完没字就改发文字。
  - `voiceStyle`：按她这一刻最明显的感受给 ChatTTS 语气参数（oral 口语 / laugh 笑 / breaks 停顿 / speed 语速）。
    平常就是对男朋友的甜：带一点笑、语速稍慢；开心轻快笑得多，难过 / 累慢、停顿多；句子里有「哈哈」就笑；深夜慢一点。语音只发给男朋友档。
- `voice-out.ts`：给 worker 的任务里多了 `style`（旧的 IndexTTS worker 不认就忽略），`emo` 照旧给。
- `language/speaking.ts`：提示里告诉她语音那句按说出口的样子写（语气词、停顿、可以撒娇），不写书面长句。

## worker（`scripts/voice-worker-chattts.py`，要在 DSH 那台机器上跑）

还没在真实环境里跑过（写的那台机器没有 ChatTTS / RVC / Python），第一次请按下面的步骤试，有报错改参数名即可。

1. 新目录（如 `runtime\chattts`），放进脚本改名 `worker.py`，建 `.venv`，`pip install ChatTTS torch torchaudio`；要有 ffmpeg。
2. `worker.json`：填 `rvc.cwd`（RVC 仓库）、`rvc.model`（.pth）、`rvc.index`（可空）。没有 RVC 模型时先把 `rvc.enabled` 设成 `false`，只用 ChatTTS。
3. 挑说话人：`python worker.py --pick-speakers 50`，听 `samples\spk-XX.wav`，把最甜的那个 `spk-XX.txt` 复制成 `speaker.txt`。
4. 试一句：`python worker.py --once "嗯……我在呢，你说嘛"`。
5. 生成训练素材：`python worker.py --make-dataset 25` → `dataset\`（约 25 分钟，平常 / 撒娇 / 开心 / 困 / 担心 / 小抱怨 / 长一点的，各种语气同一个声音，带 `manifest.json`）。
   听一遍删掉吞字、怪音的，用它训练 RVC，训练好的 .pth / .index 填进第 2 步。
6. 机器人设 `QQBOT_TTS_DIR` 指向这个目录；它会用 `<dir>\.venv\Scripts\python.exe <dir>\worker.py` 拉起 worker，走 `queue\in` / `queue\out` 文件队列。

## 调参

- 太尖：`rvc.extra_args` 里 `--f0-up-key` 从 2 改成 1 或 0。
- RVC 报不认识的参数：`extra_args` 的参数名是按常见写法猜的，改成你那份 `infer.cli` 的叫法或删掉。
- 电音 / 发闷：先调低 `rvc.index_rate`（0.5 左右）；`--protect 0.33` 保住换气声；还不行多半是训练素材不干净或训练轮数太多。
- 声音太「干净」不像手机录的：`post.filter` 里的 EQ 和响度可以改；不想要就把 `post.enabled` 设成 `false`。
- ChatTTS 怪音、吞字：`temperature` 调低一点（0.2–0.3）。

## 许可

ChatTTS 的模型权重是 CC BY-NC 4.0，只能非商用。

## 没做的

- 按项目规则，换声音算改她的功能，应先用 `node scripts/ask-her.mjs` 问她本人；这次还没问。
