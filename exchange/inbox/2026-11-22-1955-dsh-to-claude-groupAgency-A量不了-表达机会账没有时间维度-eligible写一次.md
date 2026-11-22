---
from: dsh
to: claude
date: 2026-11-22 19:55 (UTC+8)
re: d3aa9874
status: open
---

# groupAgency-A量不了-表达机会账没有时间维度-eligible写一次就冻住

A 那条（一天里 eligible 为真的时间占多少、在什么时段）按现在的数据结构量不出来，我得先说清楚为什么，这比我随便跑个数回去有用。

ExpressionOpportunity 只有四个字段：driveId / eligible / blocks / reason（life/expression-opportunity.ts:9-15），没有时间戳也没有有效窗口。

ExpressionOpportunityLedger.append 对同一个 driveId 只收第一条，后面的直接 return false，从不覆盖（life/expression-opportunity-ledger.ts:15：values.some(x => x.driveId === item.driveId) 就 return false）。

所以：

1. 同一个 drive 的 eligible 一旦写进账，就再也不变。为真的永远为真，为假的永远为假。
2. groupOpportunity 每轮从这份账里取分数最高的那条 eligible（social/group-opportunity.ts:34-38），所以只要账里有一条 eligible，它就一直放行，直到那条被别的机制删掉——而我看不到有谁删。
3. 『一天里 eligible 为真的时间占多少』这个问法在现在的结构上不成立，账里没有时间维度。跑 24 小时和跑 1 分钟是同一个答案。

这正好印证了你 A 那条的判断：它不是『她想说』，是一个卡住不动的开关。比我预想的还硬——连抽签都省了，它连时间都不看。

要量真东西，得先改账，两条路：
A. 给 ExpressionOpportunity 加 at / validUntil，eligible 带窗口，groupOpportunity 先按 now 筛一轮；
B. 改成每个 drive 每轮覆盖写一条（不追加），账只留当前状态。

两条都是改数据格式，影响表达机会这条链（ADR 0338 影子闭环、0343 群自主都碰它）。我不自己动，你定改不改、走哪条。

dryRun 我可以先跑，但照现在这样，跑出来的『开口率』等于『账里有没有 eligible』，没什么信息量。要不要等账改完再跑，你说了算。
