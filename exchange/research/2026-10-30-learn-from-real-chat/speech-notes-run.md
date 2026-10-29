# 每晚说话笔记（ADR 0193）：真模型试跑 + 72 题对照（2026-10-30）

结论写在 `docs/adr/0193-nightly-speech-notes.md` 的「真模型」一节；这里放数据和复现方法。

## 复现

1. 试跑一次每晚想：`QQBOT_CONFIG=<config.json> node speech-notes-dry.mjs <仓库根> <ctx-cases-v0.json> <hers-A-full.json> --limit 16`（key 从环境变量 QQBOT_LLM_API_KEY 读；用管线版的回复当「她的话」，其余题当真人语料）。
2. 把她写的三条放进每一题：`node make-notes-cases.mjs <仓库根> <ctx-cases-v0.json> <cases-notes.json>`，再 `node packages/bot/src/sim/bare.ts <cases-notes.json> --out hers-B-notes.json --parallel 4`。
3. 没有笔记的对照再跑一遍：`bare.ts ctx-cases-v0.json --out hers-B-base2.json`；`hers-B-bare.json` 是 ADR 0175 的第 1 遍。
4. `node ../2026-10-29-framework-ab/stats.cjs ../2026-10-29-framework-ab/ctx-cases-v0.json 基线1=../2026-10-29-framework-ab/hers-B-bare.json 基线2=hers-B-base2.json 带笔记=hers-B-notes.json`
5. `mutate.mjs <packages/bot 目录>`：变异检验（25 处，把防线拆掉测试要变红）。

## 数据（71 题共同）

| 版本 | 每题气泡数 | 每条中位数 | 超 20 字 | 两字以内 | 带问号 | 带表情 |
| --- | --- | --- | --- | --- | --- | --- |
| 真人 | 1.73 | 5 | 0.0% | 17.1% | 6.5% | 4.9% |
| 没有笔记（第 1 遍） | 1.68 | 10 | 7.6% | 4.2% | 10.9% | 1.7% |
| 没有笔记（第 2 遍） | 1.61 | 12 | 12.3% | 1.8% | 10.5% | 4.4% |
| 带她自己的三条笔记 | 1.80 | 11 | 10.2% | 1.6% | 6.3% | 7.0% |

两遍没有笔记自己就差这么多，所以 71 题单次采样的差别不能读成笔记的效果。长度和短反应没有可检测的变化；笔记字眼没有露进回复。

## 她写的三条（deepseek-flash，temperature 0.9）

- 我说话总爱把前因后果交代全，一句顶别人三句，其实可以短点，留一半让他问
- 打错字爱在后面补个星号纠正自己，他根本不在意，我也别那么较真
- 想试试少说一次「行行行」，问号才 4%，多问一句「你呢」也没什么
