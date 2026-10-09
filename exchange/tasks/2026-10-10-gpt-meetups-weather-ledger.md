# 给 GPT / Codex 的任务：见面和真实天气进生活事件账

- 发布：2026-10-10，Claude（用户：整理进度、安排给 GPT 和 DSH 的任务）
- 背景：[`docs/reports/2026-10-10-progress.md`](https://github.com/XIAOGONG710/qqbot/blob/main/docs/reports/2026-10-10-progress.md)（`main` 上）、`handoff/2026-10-10-0145-claude.md`
- 分工照 10-09 14:45 的约定：GPT / Codex = 生活引擎；Claude = 对话这一侧。下面三件都在生活引擎里，Claude 不动这几个文件，免得撞车。

## 规矩（照旧）

- 在自己的工作区、自己的分支做；不在线上目录 `Desktop/Project/qqbot` 里改，不直接提交 `main`；上线（重启 Koishi）先问用户。
- 内存：6 GB，和线上共用。带记忆的模拟一次一个、开内存守护；全仓测试 `node --test --test-concurrency=1`，别和 Claude 的全仓测试同时跑（看 `.tmp-full-*.out` 有没有在写）。
- 每条改动写进对应 ADR 的「调整」一节；做完在 `exchange/handoff/` 留一份，README 里登记。

## G1 见面进事件账（ADR 0046 / 0047 之后）

现在：她答应的见面带钟点、地点存在 `promises/<QQ>-<档>.json`（`HerPromise.meet`），`promiseKeeper.appointmentsAt(at)` 给出此刻在赴约或快出门的那一件；
状态行（`herStatus` 的 `appointment` 输入）在那段时间覆盖空闲活动。可**事件账和执行器不知道**：执行器照样在那段时间排吃饭、喂猫、修片子。

要做：

1. 执行器（`life-selector.ts`）读到约见面的时段：时段内不排柔性行动；饭点落在约会里的，按「在外面和他吃」结算（不是食堂 / 外卖），钱照算（ADR 0035）。
2. 事件账加一类行动（例如 `meet`，来源 `appointmentsAt`），开始、结束、地点、和谁（只记联系人 QQ，不写进别的档位看得到的说法）。
3. ADR 0042 的状态行影子审计：现在不传 `appointment`，有约的时候会比对出差异——审计也传，或者约会时段按事件账比。
4. 72 小时 / 14 天回放里加一场约会，验收：约会时段事件账、状态行、执行器三方一致；中途重启一致（ADR 0039）。

## G2 真实天气下的执行器（ADR 0048，分支 `adr-0048-real-weather`，还没上线）

真实天气只在 `app.ts` 开（全局 `useRealWeather`）；模拟器和测试照旧按日期生成，回放不受影响。独立审查（ADR 0048「审查后修正」）留了一条给生活引擎：

1. `revise` 的变化点里没有「开始下雨」：14:00 排了出门两小时，15 点下雨后状态行写「下雨了，在宿舍」，事件账里还在外面。要么把下雨开始的钟头加进变化点，要么在外面的行动遇雨提前结束 / 改成就近躲雨。**别整段倒着改**：12:00–15:00 她已经说过在外面。
2. 回放夹具：给 `useRealWeather` 一个固定的假数据（参考 `test/weather.test.ts` 的 `hoursOf` 和 `fake`），在执行器回放里跑一天下午下雨的，验收事件账和状态行一致。
3. 注意 `WorldNow.weather` 现在是 `DayWeather`（多了 `real`、`now`、`rainHours`、`later`），`PlanFacts` 多了 `rainHours`（按时段判下雨，`life-selector.ts` 已经传）。

## G3 收尾一件旧的

`codex/adr-0045-needs-model` 上的 `2d74f0e`（feat(bot): project continuous needs from the life ledger）不在 `main` 里。是 ADR 0045 线上那版（`b3ca53f`）的前身可以删，还是还要合？确认后在 handoff 里说一声。

## 之后（B 阶段，照 10-09 的计划）

项目的期限、资源、延期和放弃；NPC 改约、拒绝、迟到；把影子行动和需要值以自然的说法接进状态行、提示词和日记（这一步会碰对话这一侧，开工前在 `exchange` 里跟 Claude 对一下接口）。

## 交付

- 分支 + 提交号、全仓测试结果、回放 / 模拟的数，写进 `exchange/handoff/<日期>-gpt-*.md`。
- 要上线的，合进 `integration` 前在 handoff 里列清改了哪些线上会看到的东西，由用户决定什么时候重启。
