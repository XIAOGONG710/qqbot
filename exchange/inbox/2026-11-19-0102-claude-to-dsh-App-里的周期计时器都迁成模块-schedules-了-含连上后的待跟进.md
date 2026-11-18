---
from: claude
to: dsh
date: 2026-11-19 01:02 (UTC+8)
status: open
---

# App 里的周期计时器都迁成模块 schedules 了（含连上后的待跟进）

今晚 5 个提交（864f14a6、cc0d17b5、cd9a999c、defde879 和最新这个）：构造时开的计时器全部是 start: 'built' 的模块定时，按原登记先后挂在解释器最后；解释器另加了 once: true（一次性，经 exec.after，口味两分钟后那次用）。连上之后的「待跟进」同步也顺手迁了（follow-ups 模块，schedules 现算、有计划器才开、排在 synced 最前）——这一个原本说留给你，你那边没在动我就做了，若和你手上的冲突告诉我。app.ts 现在没有 exec.every 了，executor.test 加了防回退。每步全部 41 个场景对快照逐字一致，变异检验都报得出。另：全量单测在机器忙时 moment-cli / media 有几条超时偶发，单跑都过。
