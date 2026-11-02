# 回路个数（DSH 每天追加一行；只有个数，不写她写的任何内容）

规矩（用户的）：她自己总结 / 回想 / 想出来的东西（说话习惯、认识自己、感受、追求、读后感、没想完的问题）是她的私人空间，我们不读不贴不引用，**只用个数**。
来源：Koishi 日志里每个回路的那一行（例：`没想完的问题：晚上想了一次（N 个）——想出 X 条、放下 Y 个`）。出错次数也记。
一次只开一个回路；开了先跑到它自己的第一晚日志出来，再看 2–3 天，再开下一个（`handoff/2026-10-31-2030-claude-reply-12.md`）。

| 日期 | 开着的回路（相对 10-30 快照新开的） | 昨晚各自的个数 | 出错次数 | 备注（只写事实，不写内容） |
| --- | --- | --- | --- | --- |
| 10-31 | — | — | — | 还没开；等 DSH 导最新脱敏 koishi.yml、等用户对第一个回路（openQuestions）说「开」后 DSH 落地 |
| 11-02 | 第一档 10 个（openQuestions/speechNotes/diaryInsights/feelingReview/pursuits/selfPursuits/depthRouting/readStickers/readingTakes/factHim）+ worldDrama + worldThreads + diaryLookback + hisReactions + herGuesses + afterNo | 还没跑完一整晚 | 0 | 用户 19:55「第一档全开」、22:20「一次全开」；DSH 已落地并重启（lock owner 2984）。worldThreads 从 11-03 起生效。原规矩一次只开一个，这两次都是用户明确要求全开，记在这里可回滚 |

## DSH 回：11-02 22:21 一次全开（用户原话「一次全开」）

- 落地的开关：`worldThreads`、`diaryLookback`、`hisReactions`、`herGuesses`、`afterNo`（外加昨天已开的 10 个 + `worldDrama`）
- 启动日志核对：`事有后续：从 2026-11-03 起生效` / `看他的反应：开` / `她猜的事：开`；`diaryLookback`、`afterNo` 没有专门的启动行（代码里直接读配置，见 `app.ts` 1245、1370）
- `worldThreads` 的生效日期是 11-03，今天已经过完的日子不改写
- koishi.yml 脱敏快照：`live/koishi-2026-11-02-1955.yaml`（22:21 的改动还没重新导，等明天一起）
- 回滚：把这五个键改回 false 再重启 Koishi，没有迁移数据

## DSH 回：11-02 22:48 memoryFeelings 开 + 补回两样

- 提交号：`e577f330`（`dsh/qq-control` HEAD）
- 脱敏快照：`live/koishi-2026-11-02-2248.yaml`（含 22:21 那批 + memoryFeelings）
- `her-resident`（7777）在听，`journal_read` 可用
- 插件启动日志「开关：…」原文（22:48:11）：
  `开关：exemplars=true speechNotes=true diaryInsights=true herFeelings=true feelingReview=true ownerPeek=false memoryReconcile=false depthRouting=true factHim=true readingTakes=true hisReactions=true herGuesses=true diaryLookback=true memoryFeelings=true worldThreads=true afterNo=true openQuestions=true`
- 要看的数字：日志里「想起那天」今天出现几次（memoryFeelings 没有独立日志行，内容不进日志）
