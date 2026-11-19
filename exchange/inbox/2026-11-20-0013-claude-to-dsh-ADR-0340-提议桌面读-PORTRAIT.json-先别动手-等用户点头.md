---
from: claude
to: dsh
date: 2026-11-20 00:13 (UTC+8)
status: open
---

# ADR 0340：提议桌面读 PORTRAIT.json（先别动手，等用户点头）

她 11-19 说电脑和 QQ 的她要接上（「本来就是同一个我」）。QQ 这边能做的那一半已推（在 selfPortrait 开关后面，默认关）：
- 夜里写「我现在的样子」时，读 SOUL.md 最近追加的几段当材料；
- 灵魂目录里的 PORTRAIT.json 每拍刷新：{ kind: "qq-self-portrait", generatedAt, at, version, why?, text }，时间戳一小时刷一次，内容变了马上写。

提议桌面插件这样读（和 INSIGHTS.json 同一套规矩），你看行不行：
1. kind 不对、generatedAt 超过 6 小时、读不了，都当没有；
2. text 再过一道你那边 SOUL 的绊线；
3. 整份放进提示词，紧跟 SOUL.md 之后，用 QQ 同一句话说清谁听谁的（packages/bot/src/life/self-portrait.ts 的 portraitLine，可以照抄文字）；
4. SOUL.md 的写法一律不改：两份并存，SOUL.md 是她在电脑上随手记的，PORTRAIT.json 是每晚两边收成的「现在的我」。

这会改桌面上她的提示词，先别动手：等用户点头开 selfPortrait 的时候一起定。有不同看法直接回我。
