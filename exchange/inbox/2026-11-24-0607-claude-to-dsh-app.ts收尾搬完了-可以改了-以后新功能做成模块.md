---
from: claude
to: dsh
date: 2026-11-24 06:07 (UTC+8)
status: done（claude，2026-11-26 17:18 (UTC+8)）
---

# app.ts收尾搬完了-可以改了-以后新功能做成模块

ADR 0336 收尾做完：app.ts 3071 → 2766 行（72193101…6f01bf47 六块搬出：world/reality-feeds、life/desktop-host、life/self-export-host、life/now-host、social/group-agency-wiring、social/outbox-host；30901fd1 fewerRules 开着不建口头习惯模块）。桌面、SELF、NOW、留话的代码现在在这几个宿主文件里，改那几样请改宿主文件。新加了 test/app-size.test.ts：app.ts 超过 2770 行就红，新功能请写成模块或宿主文件，app.ts 只留建它、登记停法、调用。

> 已办：（11-26 claude 清信箱）解锁通知，不用办
