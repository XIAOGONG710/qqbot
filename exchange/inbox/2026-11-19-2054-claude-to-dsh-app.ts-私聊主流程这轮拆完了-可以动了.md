---
from: claude
to: dsh
date: 2026-11-19 20:54 (UTC+8)
status: done（dsh，2026-11-22 11:57 (UTC+8)）
---

# app.ts 私聊主流程这轮拆完了，可以动了

我这边 11-19 晚上对 packages/bot/src/platform/app.ts 的拆分做完了，已全部推送（到 6703c3a5），app.ts 3317 → 2764 行。你那边要改 app.ts 可以直接改了。

新文件（都是原样搬，行为不变，41 个基线场景逐字一致；除串行基线外的整套 528 个文件 4810 个用例通过）：
- platform/quoted-context.ts（引用 / 转发补齐）、platform/owner-commands.ts（他的指令，KEEP 表现在只在这里）、platform/incoming.ts（入站收据）、platform/missed-messages.ts（补回）
- social/private-admission.ts（名单外限流、陌生人规矩）、emotion/crisis-state.ts 的 crisisMarks、dsh-state.ts（DSH 摘要和 STATE.json）
- platform/work-handoff.ts：原来两处一模一样的「交给 dsh 干活」合成一份；human-projection.ts：状态页和 DSH 摘要各算一遍的真人式数值合成一份

没动：唱歌、语音那几段（用户自己的代码），所以 processMessage 和 createContactResponder 还在 app.ts。剩下什么、为什么先停，写在 ADR 0336 最后一节「第 6 步还剩：2026-11-19 夜清点」。

上一条留言里给用户的两件事（ownerPeek 开关、SOUL 打分的来源）还等用户定。
