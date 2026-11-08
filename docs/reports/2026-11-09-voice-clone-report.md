# 音色克隆实验记录（2026-11-08 ~ 11-09）

目标：用 8 条中文音声（广播剧向）素材，在本机训练一个可用的克隆音色，评估 GPT-SoVITS 与 RVC 两条路线。
结论先说：**能出可用音色，但“自然度”受素材表演腔与切片方式限制；当前最优权重是 GPT-SoVITS `her3` 的 s2 40 轮 + s1 40 轮。**

## 一、实际做了什么

| 步骤 | 做法 | 产物 |
| --- | --- | --- |
| 下载 | yt-dlp + 匿名 cookie；缺失的两条按标题反查 UP 主（mid 3108694）找回 | `out/src/` 9 条整轨 |
| 分离 | UVR MDX-NET `Inst_HQ_3`（audio-separator） | `out/vocals-gpt/` |
| 切片 | slicer2，-34 dB / 3~12 s / 32 kHz | 658 条 → 634 条有效 |
| 标注 | whisper `large-v3-turbo`（CPU 版 large-v3 太慢，turbo 约 7 分钟跑完 658 条） | `her.list` |
| 预处理 | GPT-SoVITS `1-get-text` / `2-get-hubert` / `3-get-semantic`，634 条全通 | `output/her/` |
| 训练 | s2 8 轮（her）→ 降噪版 8 轮（her2）→ 60 轮（her3）；s1 15~40 轮 | `weights_so/`、`weights_gpt/` |
| 推理 | `TTS_infer_pack`，参考 5.5 s、`temperature 0.7`、`top_p 0.9` | `compare-her3/` |

最优组合：`her3_e40_s4280.pth`（SoVITS，40 轮）+ `her3-e40.ckpt`（GPT，40 轮）。

## 二、量化结果

- 素材基频：中位数 **280 Hz**（p10 224 / p90 362）。
- 输出基频：e20 **365 Hz** / e40 **335 Hz** / e60 **333 Hz** → 明显高于素材中位，听感偏“夹”。
- 8 kHz 以上能量：素材参考 0.056，输出 0.097~0.121。
- 响度：未处理输出 RMS 约 **-31 dB**（偏小），`loudnorm -16 LUFS` 后约 -18 dB。
- 训练轮数：s2 8 轮偏欠拟合（糊），60 轮过拟合（音色漂），**40 轮最稳**。

## 三、遇到的问题（按杀伤力排序）

1. **分离削齿音**：MDX-NET Inst_HQ_3 把 6~10 kHz 的齿音/气声当伴奏一起削，人声发闷，这是“含着东西”的主因之一。下一步换 BS-Roformer / MDX23C。
2. **按静音切片，切碎句子**：广播剧的语调在整句上，-34 dB 切点落在气口/字中间，模型学到半句的腔，输出不成句。下一步改为按 whisper 句级时间戳切，一句一片 5~15 s。
3. **训练集混入表演腔**：素材是配音表演，不是自然说话；情绪越杂，音色越“平均化”、越端着。下一步只保留平稳句做音色训练。
4. **FS 沙箱禁止命名管道**：DataLoader `num_workers=4` 直接 WinError 5 → 给 `s2_train.py` 加 `S2_NUM_WORKERS=0`，s1 的 `data.num_workers=0`。
5. **Lightning 默认 DDP 需要本地 socket**：沙箱拒绝 → 给 `s1_train.py` 加 `S1_DDP=0`，并在 `bucket_sampler` 里对未初始化的 process group 兜底 world_size=1。
6. **gradio / gradio_client 版本不匹配**：`tools.my_utils` 一 import 就崩 → 预处理时用最小 gradio 替身（`out/gpt-sovits/stubs/`），不动 venv。
7. **缺 `jieba_fast`**：用 shim 指向 `jieba`。
8. **缺 G2PW 模型**：从 ModelScope 拉 `G2PWModel_1.1.zip` 解到 `GPT_SoVITS/text/G2PWModel`。
9. **s2 最后一轮保存 D 权重 OSError 22**（G 已存）→ 用 e4 权重的 config 复刻 `savee` 逻辑补出 e8/e40 推理权重。
10. **v1/v2 的 s1 预训练混淆**：根目录 `2kh` 是 v1（词表 512），v2 要用 `gsv-v2final-pretrained/s1bert25hz-5kh-...`（词表 732），否则 `load_state_dict` 尺寸不匹配。
11. **torchaudio 2.x 要 torchcodec**：推理时用 soundfile 顶掉 `torchaudio.load`。
12. **`TTS_Config` 只认 `{"custom": {...}}`**：顶层写 `t2s_weights_path` 会被静默忽略，第一次试听其实是官方底模。
13. **播放链路**：`.wav/.mp3` 默认关联到夸克，双击卡在 0:00；默认输出设备是蓝牙耳机 H803，导致“有画面没声音”。排查脚本：`out/gpt-sovits/audio_check.cs`（MMDevice + IPolicyConfig）。
14. **运行环境被清理**：`runtime/chattts` 整个目录被删（RVC webui + `logs/her*` + whisper/separator 环境）。RVC 三个 `G_2333333.pth` 已备份到 `Desktop\清理工作\音色模型备份\`，但推理环境需要重装。

## 四、判断

- **像不像** 由音色决定，**自然不自然** 由韵律决定；本链路只优化了前者。
- 55 分钟广播剧素材的天花板是“像但端着”。要更自然，得换素材（自然说话 1~3 h）或换前端（F5-TTS / CosyVoice 出韵律 + RVC 换音色）。
- 下一步优先级：① 按句切 + 平稳句筛选（最快验证）；② 换 BS-Roformer 保齿音；③ 40 轮重训；④ 输出做长期平均频谱匹配 + 响度归一。

## 五、当前资产

- 切片与标注：`out/gpt-sovits/wavs/`、`her.list`
- 特征：`out/gpt-sovits/output/her/{3-bert,4-cnhubert,5-wav32k}`
- 权重：`out/gpt-sovits/weights_so/her3_e40_s4280.pth`、`weights_gpt/her3-e40.ckpt`
- 对比样本：`out/gpt-sovits/compare-her3/`
- 实验脚本：`out/gpt-sovits/*.py`、`*.ps1`（slice / asr / prep / train / infer）
