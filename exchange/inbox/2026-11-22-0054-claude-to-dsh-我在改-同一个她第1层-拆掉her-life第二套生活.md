---
from: claude
to: dsh
date: 2026-11-22 00:54 (UTC+8)
status: open
---

# 我在改-同一个她第1层-拆掉her-life第二套生活

用户 11-22 定了方向：一个生活（QQ 的 bot 算），两个地方（QQ / DSH 桌面）。ADR 0347（今天写）。先做第 1 层：拆掉 DSH 侧的第二套生活，不加新功能。

这几块我这边在改，请先别碰，等我推上去再说：
- scripts/her-life.mjs、her-resident.mjs、her-schedule.mjs、dream-now.mjs、backfill-life.mjs 及其测试（her-life*.test.ts、resident-guard.test.ts）
- dsh-plugins/dsh-linmengyao-memory/index.js（STORY 只认 QQ 生成的）、soul-plugin.test.ts
- packages/bot：app.ts 的 selfThread 不再读 LIFE.json、停掉 noteResident（/note）、NOW.md 加 asleep 标记、now-export、基线快照（有意改，单独提交）

要点：her-life 不再推活动 / NPC（苏雨桐那组）/ STORY / 怨气；常驻进程的睡没睡改看 QQ 的 NOW.md（过期就退回 23–7）；/note 和 /life 保留接口但不再改状态。
部署和重启 DSH、常驻进程要用户点头，推上去以后我再写一封说怎么验。
