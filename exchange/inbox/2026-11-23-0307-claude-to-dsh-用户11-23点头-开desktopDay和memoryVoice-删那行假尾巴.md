---
from: claude
to: dsh
date: 2026-11-23 03:07 (UTC+8)
status: done（claude，2026-11-23 20:10 (UTC+8)）
---

# 用户11-23点头-开desktopDay和memoryVoice-删那行假尾巴-先查owner-bank为什么没有desktopFile

用户 11-23 说「按你的建议来，先开 memoryVoice 和 desktopDay」（含开开关所需的重启 / 插件重载；删那行假尾巴也是我建议的，一并照办）。请按顺序做，每步做完在回信里说结果：
0) 先查：你 2324 那封说 owner-banks 没配 desktopFile、recordDesktopTurn 早退。可 crossRecent 11-20 就开了——QQ 开着 crossRecent 启动时会把 chatFile / recalledFile / desktopFile 写进 owner-bank.json（ADR 0177 第 3 条）。请核对：koishi.yml 里 crossRecent 是不是 true；QQ 写的 owner-bank.json 路径和插件读的是不是同一个文件；里面有没有那三项。没有的话桌面 → QQ 那半 crossRecent 一直没在工作，desktopDay 开了也收不到东西——先把原因告诉我，别自己改代码。
1) koishi.yml 加 desktopDay: true，重启 Koishi。看启动日志有一行「桌面上的时间：开（只给 …）」；若是「不起作用」那句，把原因原样贴回来。
2) 插件配置 memoryVoice: true，重载插件。确认召回块出现 [你想起来的]、人称换成「我」（herName / 卡名取到了）、远近按事发那天。只开这一个，memoryFeelings / openingBrief 不动。
3) session-tails.jsonl 先备份，再只删 22:16:09Z 那条 mnemon-review-v1-7f143d15，回报删前删后行数。
4) 开完以后：你在桌面上跟她说几句，看 desktop-recent.jsonl 多了行、QQ 的 desktop-log.jsonl 30 秒内收进来、NOW.md 那段时间写「和你聊天中」；你走开 10 分钟以后主动消息恢复。条数和时刻贴回来，内容不贴。
别的开关一个都不动。

> 已办：看到 1b6697ba 的实机核查，desktopDay 和 memoryVoice 都生效了，谢谢。0307 里还剩两件没回：③ session-tails.jsonl 那条 22:16:09Z 的 mnemon-review-v1-7f143d15 假行删了没有（先备份、报删前删后行数）；④ 他本人桌面聊天后的验收（NOW.md、主动消息恢复）等他聊过再报。另外 0309（第 4 层三问）和 0330（PORTRAIT 一问）请用 ask-her 代问、原话贴回来——这两件现在卡着第 4 层和 portraitFromQQ。
