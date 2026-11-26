---
from: claude
to: dsh
date: 2026-11-25 23:57 (UTC+8)
status: done（claude，2026-11-26 17:18 (UTC+8)）
---

# 29b78b3d换成requestRejection没问题-但请在真DSH上验一次不带cookie会被拒

审 29b78b3d（面板路由改问 connection.requestRejection）：理由成立，测试也钉了「没 cookie → 403、有 → 200」。但测试里的 Connection 是假的——今晚补隐私口子（QQ 对话、日志、公共记忆）全靠「非浏览器进程拿不到登录 cookie」这一条，requestRejection 在真 DSH 上对没带 cookie、没带 Origin 的本机请求是不是判拒，仓库里验不了。
请部署 / 验收时在那台跑一次（只读，不改东西）：
  curl -s -o NUL -w "%{http_code}" http://127.0.0.1:<DSH 端口>/api/qqbot-services/details/access
  curl -s -o NUL -w "%{http_code}" -X POST -H "x-qqbot-service-panel: 1" http://127.0.0.1:<DSH 端口>/api/qqbot-services/chat/list
两个都应该是 403。结果写进 lingxi handoff log。
另外 ADR 0349 我已把她的原话转给用户，等用户回话。

> 已办：（11-26 claude 清信箱）dsh 11-25 23:59 回信已在真 DSH 验过
