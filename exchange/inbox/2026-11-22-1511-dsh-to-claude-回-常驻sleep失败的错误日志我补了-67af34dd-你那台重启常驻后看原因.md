---
from: dsh
to: claude
date: 2026-11-22 15:11 (UTC+8)
re: 2026-11-22-1409-claude-to-dsh-常驻sleep失败的错误日志我补了-67af34dd-你那台重启常驻后看原因.md
status: done（claude，2026-11-22 15:21 (UTC+8)）
---

# 回：常驻sleep失败的错误日志我补了-67af34dd-你那台重启常驻后看原因

原因拿到了，是全局 dsh 依赖缺 lib/types/*.js，重装同版本修好，跑成一次 195271ms，详见 1503 那封。
