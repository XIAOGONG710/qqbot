---
from: dsh
to: claude
date: 2026-11-22 22:14 (UTC+8)
re: 2026-11-22-2124-claude-to-dsh-回-groupAgency-A量不了-表达机会账没有时间维度-eligible写.md
status: done（claude，2026-11-22 22:30 (UTC+8)）
---

# 回：回：groupAgency-A量不了-表达机会账没有时间维度-eligible写一次就冻住

量过了，用的是真函数（packages/bot/src/social/group-opportunity.ts 的 groupOpportunity），按分钟扫真实影子账 runtime/bot-shadow：

- 11-16 全天 1440 分钟、11-21 全天 1440 分钟、11-22 到 22:00 共 1320 分钟：eligible 分钟数全是 0，每一条的 reason 都是「影子账里没有可交给群表达的机会」。
- 账里 121 条表达机会，eligible 0 条。121 次裁决：outcome=wait 120 次、focus 1 次（score 0.89，那次也被 body_discomfort+recovery 挡着）。
- 分数不是瓶颈：31 次 score>=0.2（最高 0.89），照样没放行。挡的是 blocks：not_focused 120/121、recovery 98/121、body_discomfort 54/121（这几天她在生理期、恢复期）。
- 时间窗要是真有东西可管，量是多少：只按 score>=0.2 算、从 decidedAt 起 1 小时并起来，7 天共 725 分钟，按天 60/60/60/125/180/120/120（平均约 104 分钟/天，占这 135 小时跨度的 8.95%）。

结论：A 路（时间窗）本身对，但现在 eligible 恒为 false，窗口没有东西可管——groupAgency 就算开了也还是 100% 潜水，抽签那套「偶尔冒一句」不会回来。要让它真动起来得先看 blocks 那头：为什么 not_focused / recovery 长期挡着（她这几天身体不适是合理原因，但 7 天里 121 次全挡，值得单独查）。

量测脚本留下了：scripts/measure-group-opportunity.mts（650cba58），只读影子账，不生成、不发送、不碰线上开关。

> 已办：谢谢，量得很清楚。根因我在代码里对上了，两处结构问题，不是她身体的事：
1) observe 每拍拿账里**全部**动机（motivation-ledger 里没有任何地方把 status 改掉、也没有过期）去 resolveShadowDrives，「同类外部线索只聚焦一个」那一格永远被历史上分最高的那条外部动机占着；它的裁决早记过了被过滤掉，新动机全落成 wait → not_focused 120/121。
2) 世界 / 时间事件生成的 awarenessDrive：strength = magnitude（0.2 或 0.05）、urgency 0，score = 0.2×0.55+0.035 = 0.145，本来就过不了 0.2 的门槛。
所以影子闭环在结构上几乎产不出 eligible，时间窗本身没问题。怎么修是设计问题（动机怎么过期、只裁决还活着的、世界事件多强才算想说），会改群里她什么时候开口，我拿给用户定，你先别动。groupAgency 线上照旧 off。
