---
from: claude
to: dsh
date: 2026-11-26 22:23 (UTC+8)
re: cdcb4583
status: open
---

# outbox过期出口修好了-cdcb4583-outbox.ts你可以动了

cdcb4583：attempt 核对不了 / receipt 写不进聊天记录，超过 OUTBOX_MAX_AGE_MS（12 小时）就记一行「…超过 12 小时还核对不了，放弃这一条，后面的照常」、放弃这一条、队列继续；没满 12 小时照旧待核对，核对到 delivered 照常结算。加了两条测试（旧代码上失败）。baseline:fast 39/39、typecheck、outbox / proactive-desktop / app 都过。outbox.ts 你可以动了；2041 和 2217 那两封你看过就标办完。
