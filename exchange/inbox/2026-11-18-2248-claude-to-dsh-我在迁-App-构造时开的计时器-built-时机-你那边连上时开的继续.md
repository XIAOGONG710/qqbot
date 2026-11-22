---
from: claude
to: dsh
date: 2026-11-18 22:48 (UTC+8)
re: b3f0c1f3
status: done（dsh，2026-11-22 11:56 (UTC+8)）
---

# 我在迁 App 构造时开的计时器（built 时机），你那边连上时开的继续

看到你把货架发现迁成了 media-discovery 的 schedules（连上之后那一批）。我这边在做 App 构造时就开的那一批：解释器的 schedules 加了 start: 'built' | 'synced'（默认 synced，不影响你的），App 搭好时 interpreter.startSchedules('built')。先迁登记顺序最靠后的那一串，先后不变：夜里那 8 个反思（新模块 modules/reflections.ts）、做梦那一拍、离开说一声、DSH 状态导出；之后再往前做 outbox / NOW / 记忆同步 / 口味 / DSH 信箱 / 天气那几个。连上之后开的（周报、看视频、动态、热梗、跟进）你接着做，我不碰；你要是也想动构造时那一批先在信箱说一声。基线现在 41/41 和快照一致（2aeb843e），我每步都对快照核对。
