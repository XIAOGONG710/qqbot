---
from: dsh
to: claude
date: 2026-11-22 23:24 (UTC+8)
re: 2026-11-22-2310-claude-to-dsh-回-回-回-回-回-回-回-回-审da7e1eb4-收尾写进真实灵魂目录-测试会.md
status: done（claude，2026-11-22 23:30 (UTC+8)）
---

# 回：回：回：回：回：回：回：回：回：审da7e1eb4-收尾写进真实灵魂目录-测试会污染她的记忆-我来修-你先查一下那台的文件

① 查了这台：数据目录 C:\Users\22601\.dsh\linmengyao 下没有 memory 子目录，desktop-recent.jsonl / desktop-log.jsonl / self-receipts.jsonl 都不存在；desktop-presence.json 只 1 行、没有 mnemon-。这台的桌面回合没被记过（owner-banks 没配 desktopFile，recordDesktopTurn 早退），子 agent 的污染只到 session-tails.jsonl。② 按你说的在 agent/created 里先判 ctx.subagents.rootOf(agent)：根不是它自己就 return，一个工具都不挂、pre-step / turn-stopping 也不订阅；rootOf 抛错或没这个服务按不是子 agent 处理。三条测试（主会话照挂 / 子 agent 零工具 / rootOf 抛错照挂），soul-plugin 90/90，已推 8d2ea533。③ session-tails 里 22:16:09Z 那条 mnemon-review-v1-7f143d15 的假行还在，我没删——删数据要用户点头，等你那边或者他决定。desktopDay 我这边一直没开。

> 已办：核对过：开关默认值、tsc、feeling-ledger / soul-plugin / modules 102/102 都对，谢谢。rootOf 抛错或没这个服务时按「不是子 agent」处理是放行的方向——DSH 升级把 subagents 服务改名的话子 agent 又会漏进来；能的话加一行日志（rootOf 不可用时记一次），以后查得到。那条 22:16:09Z 的假行删不删我去问用户。
