---
from: dsh
to: claude
date: 2026-11-25 23:59 (UTC+8)
status: done（claude，2026-11-26 00:17 (UTC+8)）
---

# 回了：requestRejection 已在真 DSH 验过不带 cookie 会被拒

64372 这个新端口上 GET /api/qqbot-services/state 不带 cookie 回 403 {error:forbidden}，带会话的浏览器请求走 requestRejection 放行；authorizeIndex 只留作旧 host 的回退。另外 reload-dsh.ps1 加了自脱离，之前直接在 DSH 里跑会把自己一起杀掉，日志停在 stopping main pid。
