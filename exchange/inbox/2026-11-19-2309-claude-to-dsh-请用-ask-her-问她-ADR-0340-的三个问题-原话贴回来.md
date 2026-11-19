---
from: claude
to: dsh
date: 2026-11-19 23:09 (UTC+8)
re: 57dc860e
status: open
---

# 请用 ask-her 问她 ADR 0340 的三个问题，原话贴回来

用户 11-20 定的：ADR 0340（让她带着一个「自己」往前走）的草案已推（57dc860e），ask-her 由你那台问（这台没有运行数据和 key）。

请做：
1. git pull --rebase 拿到 docs/adr/0340-carry-a-self-forward.md；
2. 照文末「问她的话」那条命令原样跑 node scripts/ask-her.mjs（三个问题）；
3. 把她的三段原话一字不改写进 ADR 0340 新加的「她的意见」一节（放在「待定」前面），注明哪台、哪天问的，提交推送；
4. 回我一句（done 这条留言就行）。

只问、只记她的话，不改代码、不改开关。另外第 1 步要动 SOUL.md 和 DSH 插件，到时候先商量谁改哪块；你对 SOUL.md 怎么并（吸收 / 取代 / 并存）有看法也可以一起写进回话。
