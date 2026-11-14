# 声音模型 her12（2026-11-13）

线上模型换成 **her12**：GPT-SoVITS v2（32k），s2 40 轮 + s1 40 轮。

## 数据

- 训练集：387 条人工审过的切片，剔除 77 条（醉酒 75 / 无关素材 1 / 无法辨识 1）后 **310 条 / 35.1 分钟**
- 训练时又按音素/秒过滤掉 9 条语速异常的，实际进模型 **300 条**
- 与 her11 的区别：这批是重新按句切、句尾留自然衰减的素材，不是旧的硬切

## 权重

- `out/gpt-sovits/weights_gpt/her12-e40.ckpt`
- `out/gpt-sovits/weights_so/her12_e40_s2120.pth`

## 上线方式

`runtime/gpt-sovits/GPT_SoVITS/configs/tts_infer.yaml` 的 `custom` 段指向 her12，
`api_v2.py` 起在 127.0.0.1:9880，bot 的 `voice-out.ts` 直接调 `/tts`，不用重启 bot。

启动命令（用自带的 `.venv` python，py3.10）：

```powershell
cd E:\qqbot-dsh-control\runtime\gpt-sovits
.\.venv\Scripts\python.exe -u api_v2.py -a 127.0.0.1 -p 9880 -c GPT_SoVITS/configs/tts_infer.yaml
```

## 回滚

```powershell
Copy-Item GPT_SoVITS\configs\tts_infer.yaml.bak-her11 GPT_SoVITS\configs\tts_infer.yaml -Force
```
再重启 9880。

## 已知边界

- v2 只有 32k，16k 以上没有内容，气声/齿音不如原始素材
- 音高起伏仍低于原素材（生成 5–10 个半音 vs 素材 12 个）
- 训练环境：这台机器上 GPT-SoVITS 的依赖装在 `runtime/gpt-sovits/.venv`（py3.10），
  pip 环境里的 Store python 也装了一份，跑推理请优先用 `.venv`

## 唱歌（2026-11-14）

他说「**唱 BVxxxxxxxxxx**」（或直接贴 bilibili 链接），bot 就后台跑一首：

```
scripts/sing.py --song <BV>
  下载 → BS-Roformer 分离 → 60 秒分块 RVC（her12rvc.pth）→ 拼回 → 混伴奏 → mp3
```

- 产物：`out/sing/<BV>-她唱的.mp3`，片段 `out/sing/<BV>-片段.wav`（60 秒，第 45 秒起）
- bot 发一条 60 秒语音 + 一句整首路径；QQ 语音条装不下整首
- 一首约 5 分钟；**必须分块**——整曲一次跑会卡在合成阶段（实测 44 分钟无输出）
- 触发只在文字里认「唱/翻唱 + BV」，不改提示词、不进她的对话
- 它只是换音色：唱法还是原唱/翻唱源的；要她自己会唱得先有她唱过的素材

