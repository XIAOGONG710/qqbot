# 她的声音：训练过程与问题记录（2026-11-08/09）

记录这次给林梦瑶做声音的过程：做了什么、卡在哪、结论是什么，方便下次接着干。

## 素材

来源是六条恋爱向语音（bilibili 直播切片，久远千羽），存在 `out/audio/`、`out/src/`，
UVR5 分离后的人声在 `out/vocals/`（`*_Vocals_*.wav`）。这些素材只在本机，`out/` 不入库。

## RVC

### 做过什么

1. `runtime/chattts` 下装了 RVC WebUI，切段 → 预处理 → 提取 f0/hubert → 训练。
2. 第一版 `her2`：1500 轮，出来的声音发闷、像含着东西。
3. 排查发现训练数据被污染：
   - 三条原始视频音轨没做分离就扔进 `out/vocals/`，切片时混进了带伴奏的混音；
   - `out/vocals` 里同时存在 `(Instrumental)` 文件，也进了数据集。
4. 重新分离这三条，只取 `*Vocals*` 重建数据集（`her3`，140 段，筛完剩 93 段），400 轮训练
   （约 9 秒/轮，50 分钟）。发闷问题解决（频谱重心从 ~500 Hz 回到 ~1000 Hz）。

### 问题

- **发闷**：训练数据带伴奏/器乐 → 模型学到的是混音的音色。修法是数据只留干净人声。
- **音高对不齐**：源音（ChatTTS）约 230 Hz，目标音色自然音高约 440 Hz，差一个八度，
  转换后听着像被压低的声音，忽高忽低。RVC 只保留源音的语调，这个问题绕不开。
- **语气**：RVC 的语气永远来自源音，TTS 的语气随机 → 听着像念稿。

### 结果

- `her3_e400` 检查点（assets/weights 下的推理模型和 `logs/her3/G_*` 训练检查点）。
- 训练目录后来被清理脚本整体删掉，三个模型（her/her2/her3 的 `G_2333333.pth`）
  备份在 `Desktop/清理工作/音色模型备份/`，重装 RVC 本体即可加载。

## F5-TTS（零样本）

- 已装好：`runtime/f5-tts`，权重 `F5TTS_v1_Base`（1.3 G），跑通第一句。
- 用法：参考音频 + 该音频的文字 + 要念的句子，几秒出结果，不用训练。
- 坑：
  - torchaudio 2.11 的 `load` 依赖 torchcodec，而 torchcodec 0.16 的 DLL 和 torch 2.11 不匹配
    （`libtorchcodec_core4.dll` 加载失败）→ 用 `run_f5.py` 把 `torchaudio.load/save`
    换成 soundfile 实现。
  - 参考音频的文字由 faster-whisper 转写，素材是耳语/夹子音时转写错误率高，
    文字对不上会直接影响合成效果。
- 当前效果：声音偏尖、停顿不自然。方向和参考音频强相关，需要挑一段平静、音高居中、
  转写准确的参考再试。

## GPT-SoVITS（待训练）

- 已装好：`runtime/gpt-sovits`，CUDA torch 2.11、预训练模型（s1/s2、hubert、roberta、G2PW）齐了。
- 还差素材转写 → 训练清单 → s1/s2 训练。
- 装依赖时的坑：`jieba_fast`、`pyopenjtalk` 在 Windows 上没有 wheel，需要 MSVC 才能编译
  → 跳过/打桩；`pyarrow` 新版本删了 `PyExtensionType`，要降到 16.x 才能 `import datasets`。

## 结论

短期用 F5-TTS 当后端（零样本、不用训练）最省事；要稳定、像本人，还是 GPT-SoVITS 训一版。
RVC 适合变声/翻唱，不适合「打字→她说话」这条链路。
