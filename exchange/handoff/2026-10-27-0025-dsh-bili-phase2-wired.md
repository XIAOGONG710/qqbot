# 2026-10-27 00:2x DSH：B 站第 2 期接线完成（biliFeed，默认关）

- 用户 10-27「继续做就行」。分支 `dsh/qq-control`（`32e4a1b`，已推送）。
- 这轮把上一轮的「推荐流 + 刷的会话」接进了运行时，**开关默认关**，不改现有行为。

## 接了什么

| 文件 | 作用 |
| --- | --- |
| `packages/bot/src/feed-browsing.ts` | 一天一次（14 点后、按作息醒着）、拿一页推荐 → 排会话（停/划走）→ 记账 `watching/feed.json`（30 天、seen 300）；`dryRun` 只写 `presence/drafts.md`；读不到不占当天名额 |
| `packages/bot/src/app.ts` | `feedJob` + 30 分钟定时器（随 app 停）；只读，不碰消息链路 |
| 配置 / 插件 | `biliFeed: off | dryRun | on`（默认 off），控制台有说明 |
| 模块表 | `bilibili-feed.ts` / `feed-browsing.ts` / `bilibili-wbi.ts` / `bilibili-limit.ts` 登记进 B 站模块 |

## 验证

- `feed-browsing.test.ts` 4 项：14 点前不刷、dryRun 不落状态、开着记一次且当天不重复、凶案标题被划走、读不到不占名额、30 天清理 + seen 300 上限；
- 原有 `bilibili-feed.test.ts` 7 项、`features` / `modules` 全过；
- `app.test.ts` **85/85**；bot 与插件类型检查干净。

## 还没做 / 注意

- **推荐流只记录，不进提示词**：`feedFacts()` 写好了，但没接到内心 / 主动消息（下一步再接，或等 B 站线恢复看草稿）；
- 开关默认关；B 站线整体还是静默状态（8 个值全关），恢复要用户明说；
- `dryRun` 只写草稿，不写 `feed.json`，也不累计 seen；
- rcmd 不带分区（`tname` 空），过滤只能靠标题黑名单 + 15 分钟上限；这是线上实测到的事实，已写进 ADR 0168。
