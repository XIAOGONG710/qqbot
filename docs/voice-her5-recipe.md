# 她的声音：最终可用方案（2026-11-09）

结论：**F5-TTS 出自然韵律 → RVC her5 换音色**，是这轮试下来最像、也最自然的一条链路。
试听对比在 `out\试听-最终\`，用户确认 `her5` 最好，F5 源的两条尤其自然。

## 链路

```
文本 ──► F5-TTS（24k，自然韵律） ──► RVC her5（48k，音色） ──► loudnorm -16 LUFS
```

一条命令：

```powershell
pwsh -File out\gpt-sovits\tts_her.ps1 -Text "宝宝，我今天下课晚了，你先吃吧，别等我了。" -Out demo.wav
```

参数：F5 `nfe_step 32`、`cfg_strength 2.0`、`speed 1.0`；RVC `pitch 0`、`rmvpe`、`index_rate 0.75`。

## 关键资产

| 内容 | 路径 |
| --- | --- |
| RVC her5（48k，300 轮，600 条数据） | `runtime\rvc-webui\assets\weights\her5.pth` |
| her5 索引 | `assets\indices\her5_added_IVF658_Flat_nprobe_1_her5_v2.index` |
| F5 模型 | `runtime\f5-tts\models\F5TTS_v1_Base\` |
| F5 参考音频 | `runtime\f5-tts\ref\ref.wav`（文本「不行不行就是不行」） |
| F5 本地 vocoder | `runtime\checkpoints\vocos-mel-24khz\`（避开联网下载） |
| 训练数据 | `out\clips-kept2\`（600 条 / 63.7 分钟，48k） |

## 踩过的坑（复现时照抄）

- F5 默认会联网下 vocos，hf 不通就卡死：把 `config.yaml` + `pytorch_model.bin` 放到 `runtime\checkpoints\vocos-mel-24khz\`，启动加 `--load_vocoder_from_local`。
- F5 模型也走本地：`-p models\F5TTS_v1_Base\model_1250000.safetensors -v models\F5TTS_v1_Base\vocab.txt`。
- RVC CLI 用 `python -m infer.cli`（`-m train.*`），直接跑脚本会 `No module named 'infer'`。
- RVC 训练前要手动生成 `filelist.txt`（wav|hubert|f0|f0nsf|spk）和 `config.json`，`out\gpt-sovits\rvc_make_filelist.py` 已封装；40k 用 `v1/40k.json`，48k 用 `v2/48k.json`。
- `configs.config` 在 import 时会解析命令行参数，生成配置前要先把 `sys.argv` 清空。
- 沙箱没有命名管道：预处理加 `noparallel True`，RVC 训练不受影响。

## 天花板

- 分离（BS-Roformer）已经把 8 kHz 以上的齿音削掉一半（源 0.009 / 输出 0.011，都在低位），48k 训练救不回来——瓶颈在分离，不在采样率。
- 45~64 分钟素材的 RVC 上限是“很像”，做不到“复刻”。
- 想再近一步只能换素材（无 BGM 原声，跳过分离）或加数据到 1 小时以上。
