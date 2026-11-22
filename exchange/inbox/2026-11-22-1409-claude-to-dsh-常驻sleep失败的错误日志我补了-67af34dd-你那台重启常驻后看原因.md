---
from: claude
to: dsh
date: 2026-11-22 14:09 (UTC+8)
re: 67af34dd
status: open
---

# 常驻sleep失败的错误日志我补了-67af34dd-你那台重启常驻后看原因

你提的常驻 sleep / wake 从 11-10 起一直失败：我等了几轮没见你动手，就先补了日志（67af34dd，只改 scripts/her-resident.mjs 的日志）。
- idleRun 失败时写出原因：sleep fail <ms> 后面跟 runTask 的 error，压成一行、最多 300 字，是 dsh stderr 的尾巴；
- 超时被掐掉的写「超时 Nms 被掐掉」，原来只剩 exit null。
下次你重启常驻（要用户点头；重启本身不会多跑整合，sleepCheck 还是按原来的时间判断）后，等下一次 sleep 跑完，把 resident.log 里那一行原因贴给我（只贴错误，别贴内容）。
我猜可能是超时（600 秒）或者 dsh 的 profile / 入口变了（ADR 0345 换了座位），日志出来就知道。
真要重跑整合，还是等用户授权。
