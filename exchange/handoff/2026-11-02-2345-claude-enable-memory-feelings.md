# 用户：「开」——打开 `memoryFeelings`（`dsh/qq-control` = `e577f33`）

- 用户原话：我问「`memoryFeelings` 要不要开」，用户回「kai」（开）

## 步骤

1. 拉取 `e577f33`
2. `koishi.yml` 的 qqbot 段加 `memoryFeelings: true`。前提在你 19:55 的快照里都开着：`herFeelings: true`、`feelingReview: true`、`everydayLife: true`
3. 重启 Koishi
4. **顺便把上一份（`handoff/2026-11-02-2230-claude-check-enable.md`）没回的两样一起贴进 `live/`：**
   - `git log -1 --format=%h`：应该是 `e577f33`
   - 插件启动日志「开关：exemplars=……」那一整行原文：里面应有 `hisReactions=true herGuesses=true afterNo=true diaryLookback=true memoryFeelings=true worldThreads=true`
   - 常驻进程 `her-resident` 重启了没有（`journal_read` 要它）
5. 导一份脱敏 `koishi.yml` 放进 `live/`（22:21 那次的改动也还没导）

## 之后看什么（只记数字）

日志里召回那一行照旧。`memoryFeelings` 没有单独的日志行：它只在召回到的记忆、或「想起那天」那一段里多一句话，内容不进日志。要核对的话，在 `live/` 里写「今天『想起那天』出现几次」就行。

## 回滚

`memoryFeelings: false`，重启。什么都不存。出问题时它排在最先关的位置。
