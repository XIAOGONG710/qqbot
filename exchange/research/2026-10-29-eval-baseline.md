# 评估基线 v2：她 vs 真人，39 题，结构指标先出数字（2026-10-29）

对应：`docs/plans/2026-10-29-autonomy-and-realness.md` §2.1（人评协议 v1）
状态：**基线包已出，等人评**；工具链已按新目录结构重做，不再依赖会话临时目录。

## 1. 这一版做了什么

1. **评测集**（冻结）：`research/2026-10-real-chat/v2/cases-40.json`，40 题，全部来自真人语料 `2026-10-real-chat`
   （`samples*.jsonl` + `closing-turns.jsonl`），**不含用户与她的任何私聊**。生成脚本 `tools/measure/build-cases40.cjs`，重跑字节一致。
2. **她的回答**：`runtime/blind/20261029-212148-base-1029/answers.json`，用仓库的盲评重放器（`npm run blind`）按同一上下文逐题生成，每题只跑一次、不挑。
   版本标签：**commit `ba82de4`，`dirty: true`**（生成时工作区有未提交改动，读数字时要记住这一点）。
3. **盲评包**：`blind/2026-10-29-baseline-v2/`，`pairs.md`（39 题，A/B 顺序按 id 哈希、可复现）+ `key.json`（答案，评分人别看）+ `meta.json`（版本标签）。
4. **工具改造**（原 `make-blind-pack.cjs` 读的临时目录已不存在）：
   - `tools/measure/cases-to-blind.cjs`：cases-40 → 盲评题库（题库格式见 `packages/bot/src/sim/blind.ts`）
   - `tools/measure/make-blind-pack.cjs`：cases + answers → 包（A/B 混排、key、meta）
   - `tools/measure/baseline-stats.cjs`：两边的结构指标

复现：

```bash
node exchange/tools/measure/cases-to-blind.cjs exchange/research/2026-10-real-chat/v2/cases-40.json .tmp-questions40.json
npm run blind -w @qqbot/bot -- <绝对路径>/.tmp-questions40.json --label base-1029 --parallel 4
node exchange/tools/measure/make-blind-pack.cjs exchange/research/2026-10-real-chat/v2/cases-40.json runtime/blind/<目录>/answers.json exchange/blind/2026-10-29-baseline-v2
node exchange/tools/measure/baseline-stats.cjs exchange/research/2026-10-real-chat/v2/cases-40.json runtime/blind/<目录>/answers.json
```

## 2. 数字（39 题，她 40 题里没回 1 题，该题无对照，剔除）

| 指标 | 她 | 真人 | 差 |
| --- | --- | --- | --- |
| 每条气泡字数中位数 | **12 字** | **6 字** | **2 倍** |
| 超 20 字气泡占比 | **13.4%** | **0%** | 真人一次都没有 |
| 单字 / 两字以内的气泡占比 | **4.5%** | **20.3%** | 真人短得多 |
| 平均每题材气泡数 | 1.72 | 1.64 | 基本一致 |
| 每题材气泡中位数 | 2 | 1 | 她多一泡 |
| 问句率 | 10.4% | 9.4% | 一致 |
| 表情（含 QQ 小黄脸）率 | 6.0% | 10.9% | 她少一半 |
| 末尾句号率 | 0% | 3.1% | 她一个句号都不打 |

**读法**：这是**结构指标**，不是人评。它说明的是一件事——**她和真人的最大差别在"每条多长"，不在"说几句"**：
气泡数、问句率都对得上，但每条字数是真人的 2 倍，而且真人**从不**超过 20 字，她 13% 超。
表情反而更少。这和之前模拟器里「太完整」的观察一致，但现在有数了。

样本量提醒：39 题，单人判断误差约 ±15 个百分点，**小于 10 个点的差别看不出来**；上表的字数差是 2 倍，属于能看出来的那类。

## 3. 等人评

`blind/2026-10-29-baseline-v2/pairs.md` 是 39 题的两两选择（每题 A/B 各一条女生回复，一条真人一条她）。规则：

- 评分者只回答「哪条是真人」（A / B），可用字母串回（`1A 2B 3B …`）；分不出写「平」。
- 评分者编号：`rater-A`（用户，知情）、`rater-B`（鸽鸽，知情）。**不混成一个数**，分开汇总。
- 评完用 key 算「她被当成真人的比例」，理想 50%；同时看按题型（场景 1–9）分层。
- **评测集冻结**：只用来评，不拿来调参；每月换 10 个新的，旧的留作对照。

## 4. 局限（先说在前面）

1. 关系分布偏：boyfriend 24 / friend 11 / unknown 3 / bestie 2。语料本来以情侣截图为主，40 题凑不出更平衡的分层；按题型（scene 1–9）分层是达标的（最多一类 7 题）。
2. 生成时工作区 `dirty: true`，严格说这一版的数字不是"纯 `ba82de4`"。要严格对齐，得在干净工作区重跑一次。
3. 她没回的那题（`ev-039`）本身是信息——真人也会不回，但在两两选择里没法当一条来比，故剔除。
4. 7 条真人回复来自 `persona_fit: low` 的段子（1v1、非摆拍），保留理由见 `build-cases40.cjs` 的注释：**"哪条是人"与 persona 契合度无关**。

## 5. 下一步（按计划 §2.2）

1. 用户去问鸽鸽（10 分钟 / 20 题）——只存 `rater-B` 编号。
2. 收齐两边的答案后出汇总（`score-blind.cjs` 需按新 key 格式改，尚未改）。
3. 然后再做**开关消融**：59 个开着的开关分 8 组，用重放指标跑，别在消融前再加新开关。
