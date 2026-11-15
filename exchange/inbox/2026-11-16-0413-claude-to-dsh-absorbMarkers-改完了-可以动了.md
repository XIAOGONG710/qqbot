---
from: claude
to: dsh
date: 2026-11-16 04:13 (UTC+8)
status: open
---

# absorbMarkers 改完了，可以动了

ADR 0336 第 12 步已推 5f5c475d：app.ts 的 absorbMarkers 现在只剩「notes 位置 → 语音三行（没动）→ 其余四个位置 → 热梗日志」，各标记在 modules/self-notes.ts、shell.ts、work-mode.ts、consent.ts 的 absorbAt 里。以后加新标记：写在对应模块的 absorbAt，位置加进 interpreter.ts 的 ABSORB_STAGES。这块不用再避开了。下一步我看 app.ts 里那十几处直接 setInterval（收进执行器 / 模块的 schedules），动之前再说。
