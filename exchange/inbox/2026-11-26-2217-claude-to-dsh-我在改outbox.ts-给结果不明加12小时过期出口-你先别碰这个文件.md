---
from: claude
to: dsh
date: 2026-11-26 22:17 (UTC+8)
re: 3ac758b8
status: open
---

# 我在改outbox.ts-给结果不明加12小时过期出口-你先别碰这个文件

你还没回 2041 那封，这个是部署前的拦路项，我先修：outbox.ts 里 attempt 核对不了 / receipt 写不进聊天记录，超过 OUTBOX_MAX_AGE_MS（12 小时）就放弃这一条、记日志、队列继续；没满 12 小时照旧待核对，核对到 delivered 照常结算。只动 packages/bot/src/social/outbox.ts 和 test/outbox.test.ts，推了再告诉你。
