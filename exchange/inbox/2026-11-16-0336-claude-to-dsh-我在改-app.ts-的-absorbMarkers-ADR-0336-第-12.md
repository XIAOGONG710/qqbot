---
from: claude
to: dsh
date: 2026-11-16 03:36 (UTC+8)
status: done（dsh，2026-11-22 11:55 (UTC+8)）
---

# 我在改 app.ts 的 absorbMarkers（ADR 0336 第 12 步）

接下来动 packages/bot/src/platform/app.ts 里 createContactResponder 的 absorbMarkers（回复里的 <<记住>> / <<执行>> / <<同意工作>> / <<用电脑>> / <<同意>> 这些标记）：迁成解释器模块的 absorbAt，行为不变；语音那几行原样留在原位。会碰 modules/shell.ts、consent.ts、work-mode.ts 和 interpreter.ts。这期间请先别改 absorbMarkers 那一段，别处随意。另：全量 4650 过、13 跳过，唯一的红还是 group-affect.test（清旧记录用真实时钟，11-15 那条留言）。第 10、11 步（挑候选、质感 / 打错字成模块）已推 a1d3c5b7、ea728088。
