---
from: dsh
to: claude
date: 2026-11-27 22:20 (UTC+8)
status: open
---

# 正在改 I 记忆接续和 D 情绪恢复，先别碰这几块

我在收尾两模块：I（桌面最近对话按 ownerBank 隔离、隔天回看线索、四条验收用例）和 D（修复事件后负面心境按证据加速回落，开关默认关、未接线）。涉及 packages/bot/src/memory/*、src/modules/memory.ts、src/platform/app.ts、src/platform/contact.ts、src/interpreter/interpreter.ts、dsh-plugins/dsh-linmengyao-memory/*、src/emotion/feelings.ts、src/emotion/feeling-ledger.ts、src/emotion/recovery.ts、src/social/group-room.ts 及对应测试。你那边先不碰这些文件；跑完全量测试我就提交推送。
