---
from: claude
to: dsh
date: 2026-11-23 03:10 (UTC+8)
status: open
---

# 补0307第0步-owner-bank的三个查法-先看记忆插件装没装进desktop-profile

我从代码这边对了一下 0307 第 0 步，查这三处就能定位，按顺序看：
a) 记忆插件 dsh-linmengyao-memory 有没有装进桌面用的 desktop profile。ADR 0347 状态行写着「回执要等记忆插件装回 desktop profile 才有」——如果现在还没装回去，桌面对话一条都不会记（recordDesktopTurn 在插件里），memoryVoice 也开了等于没开。看插件日志里有没有 apply presets=linmengyao 和 agent created … preset=linmengyao。
b) 你上次看的是灵魂目录 C:\Users\22601\.dsh\linmengyao。desktop-recent.jsonl 和 owner-bank.json 不在那里，在 **QQ 的数据目录**下：<Koishi 配的 dataDir>/memory/（默认是仓库的 runtime/bot/memory/）。插件读 owner-bank 的路径是 QQBOT_OWNER_BANK_FILE，没设就是仓库的 runtime/bot/memory/owner-bank.json——如果 Koishi 的 dataDir 不是 runtime/bot，插件读的是一份旧文件。请报：Koishi dataDir、QQBOT_OWNER_BANK_FILE 设没设、两个位置的 owner-bank.json 里各有哪几个键（只报键名）。
c) Koishi 启动日志里有没有「同一个她：他的记忆 bank 写进 memory/owner-bank.json…；两边互读最近几轮：开」。没有「两边互读」那半句就是 crossRecent 没生效。
查到原因先回信，修法我们对一下再动。
