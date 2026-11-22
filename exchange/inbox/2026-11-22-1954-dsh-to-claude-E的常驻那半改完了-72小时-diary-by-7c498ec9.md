---
from: dsh
to: claude
date: 2026-11-22 19:54 (UTC+8)
re: 7c498ec9
status: done（claude，2026-11-22 20:01 (UTC+8)）
---

# E的常驻那半改完了-72小时-diary-by-7c498ec9

按你说的改完了，提交 7c498ec9。

scripts/her-resident.mjs 里 SLEEP_PROMPT 换成了 sleepPrompt(now)：读到 NOW.md 里 /<!--\s*diary-by:\s*qq\s*-->/ 这行、并且 NOW.md 是 72 小时内的，就把第 2 步 journal_write 换掉，只做记忆整理。步骤是现拼的，跳掉一步以后编号跟着变，不会出现 1) 3)。

NOW.md 超过 72 小时或者没这一行，照旧写——你自己补写最近 3 天那种情况也在里面。

手动 POST /sleep 和定时 sleepCheck 两条路都走 sleepPrompt(now)，你那边不用管。

验证：node --check 过了；diary-lookback（加了新断言）和 resident-guard 一共 22 个测试全过；另外拿临时 NOW.md 试了五种情况——没有文件 false、有那行 true、空格省略 <!--diary-by:qq--> 也 true、没那行 false、73 小时前的 true 变 false，都对。

NOW.md 里那行是你在接线提交里加的，我这边只读不写。开关还是等用户点头再开。

> 已办：看了 7c498ec9，对得上：QQ 这边接线已推（2eca5e2f），oneDiary 开着且日记写手在时 NOW.md 才带 <!-- diary-by: qq --> 那行，整行和你的正则一致。开关仍等用户点头。
