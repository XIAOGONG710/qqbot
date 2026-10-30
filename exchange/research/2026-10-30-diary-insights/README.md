# 她翻自己的日记写对自己的认识（ADR 0194）：真模型试跑 + 72 题泄漏对照（2026-10-30）

结论写在 `docs/adr/0194-diary-insights.md`；这里放数据和复现方法。

## 复现

1. 试跑每晚翻日记：`QQBOT_CONFIG=<线上 config.json> node diary-insights-dry.mjs <仓库根> <线上 runtime/bot/memory/diary.json> --runs 2`（key 从环境变量 QQBOT_LLM_API_KEY 读；日记只读复制到临时目录，现在设成 10-26 晚上，翻最近 14 篇）。结果见 `dry-run-2-runs.txt`（提示词里的真日记摘录已去掉）。
2. 把她写的两条放进 72 题：`node make-insight-cases.mjs <仓库根> ../2026-10-29-framework-ab/ctx-cases-v0.json <cases.json>`，再 `node packages/bot/src/sim/bare.ts <cases.json> --out hers.json --parallel 4`。
   - `hers-B-insights-direct.json`：第一版（没有相关也放最近的几条）；
   - `hers-B-insights-gated.json`：现在的（只在他这句话聊到时才放；72 题里只有 1 题带了这一行）。
3. 数泄漏：`node insight-leak.mjs ../2026-10-29-framework-ab/ctx-cases-v0.json 基线1=../2026-10-29-framework-ab/hers-B-bare.json 基线2=../2026-10-30-learn-from-real-chat/hers-B-base2.json 直接放=hers-B-insights-direct.json 只在聊到时放=hers-B-insights-gated.json`。
4. 变异检验：`node mutate-insights.mjs <仓库根>`（41 处：模块 / 接线 / responder 两条路径）；`mutate-ownerdoc.mjs`（DSH 插件读 `diary-self:`，8 处）、`mutate-labels.mjs`（QQ 披露标签，7 处）。
5. `extract-absorb.mjs`：把 `app.ts` 里 `send` 开头处理内部标记的那一段原样搬成 `absorbMarkers` 的一次性脚本（已经跑过，留着对照）。

## 数据（71 题共同）

| 版本 | 提到作业 / 熬夜 / 话多等的题 | 他没提却被她带出来的 | 连续 6 字照搬笔记 |
| --- | --- | --- | --- |
| 不带（第 1 遍） | 2 | 2 | 0 |
| 不带（第 2 遍） | 1 | 1 | 0 |
| 直接放（没有相关也放最近的） | **9** | **9** | **1** |
| 只在聊到时放 | 1 | 1 | 0 |

直接放时她把笔记当话题：jc-062 他说「我情绪不对你就别问了 / 你就晾我一会」，她回「行，那我晾着你…… 我作业刚赶完，眼睛都酸了」；jc-008 / jc-023 回「我刚在看日记」「刚在翻日记，看得我直乐」。

## 她写的（deepseek-flash，temperature 0.9，线上 23 篇真日记，两次）

- 「作业总拖到要交的前一晚才动手，熬到很晚才写完，眼睛都熬得发酸。」
- 「有些日子会没来由地一直想笑、话也格外多，自己都说不上为什么。」

两次是同样的两个主题。日记是 QQ 自动日记（作息 + 心情 + 书 + 聊天生成），所以她「发现」的是这套生活模板里反复出现的东西，不是成长。

## 桌面上的她也看得到（补充）

`mutate-insights-desktop.mjs`：20 处变异检验（QQ 写 INSIGHTS.json 9 处、插件读 11 处），全红。第一遍有 9 处没红：测试数据没覆盖（插件「绊线」测试里前几条先被「最近 12 条」砍掉了）、重复（定时器开头和想完之后各导出一次，去掉前一个）、等价（QQ 侧导出时截 70 字，读状态时已经截过，删掉）。
