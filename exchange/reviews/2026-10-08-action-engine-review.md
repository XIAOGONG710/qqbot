# DSH 侧代码审查：`d03b057` 行动裁决 + `b5f2a6f` 行动队列

- 日期：2026-10-08
- 审查方：DSH 侧（独立 checkout）
- 审查对象：`d03b057`（类型化生活行动裁决器）、`b5f2a6f`（可重放生活行动队列）
- 相关文档：`docs/adr/0037-typed-life-actions.md`、`docs/adr/0038-replayable-action-queue.md`、`docs/adr/0029-life-event-ledger.md`
- 方法：静态阅读 `packages/bot/src/actions.ts`（205 行）、`packages/bot/src/action-queue.ts`（97 行）、
  `packages/bot/src/life-events.ts`，以及全仓 grep 接线点。**只读，未改任何文件。**

---

## 0. 结论

**这两个提交本身是干净的，但不足以支撑下一步自主生活执行器。**

- **`actions.ts` 裁决器**：是纯函数、无 RNG、无 I/O、无时钟，可重放。设计正确。
- **`action-queue.ts` 队列**：落盘与崩溃缝隙处理正确，但**缺三块执行器必需的能力**
  （结算时机、区间冲突、计划变更），并且**线上零装配**。

**必须先补三件事再谈执行器**，否则重叠行动与等待步骤会把事实账写脏。

---

## 1. 我亲自复核过的结论（这些是确证的）

### 1.1 ✅ 区间冲突不检查——两条时间重叠的行动都会落账

`action-queue.ts:37-49` 的 `schedule` 只做两件事：按 **id** 查重、调 `judgeAction`。

```ts
schedule: (intent, context) => {
    const existing = items.find(item => item.id === intent.id.trim());
    if (existing) return verdictOf(existing);
    const verdict = judgeAction(intent, context);
    ...
}
```

而 `judgeAction` 的冲突检查看的是**已结算的事实账**，不是**队列里待结算的计划**：

- `actions.ts:173-185` `firstCollision`：只比对课程（`classesOn`）、`routine.meals`、睡眠段、`context.events`
- `actions.ts:187-189` `firstExistingCollision`：只比对 `events`
- **两处都没有读 `items`**

→ **队列内部的两条重叠行动会双双通过**。而 `action-queue.test.ts` 的四个测试无一覆盖重叠。

**影响**：她会「同时在自习又在追剧」，且两条都成为永久事实。

---

### 1.2 ✅ `settleDue` 抛错后不摘队列——会形成永久崩溃循环

`action-queue.ts:50-64`：

```ts
for (const item of [...items]) {
    if (new Date(item.event.at) > now) break;
    ledger.recordEvents([item.event]);
    if (!ledger.events().some(event => event.id === item.id)) {
        throw new Error(`行动 ${item.id} 未写入事件账`);   // ← :57
    }
    items = items.filter(other => other.id !== item.id);   // ← 抛错就走不到这里
    persist();
```

抛出发生在 `items` 被过滤**之前**，所以这条永远留在队列里 → **每次调用都抛同一句**。

而 `action-queue.test.ts:101-104` 恰好**把这个行为当成正确**写进了测试
（`assert.throws(..., /未写入事件账/)` + `pending().length === 1`）——测试固化了崩溃循环。

**风险**取决于事实账会不会真的丢弃事件。子代理报告称 `world.ts:728-734` 对某些事件是静默
`continue`（不写也不报错）——**这一条我没逐行复核**，如果成立，那么「账本静默丢弃 + 队列抛错」
就是一个自锁：进程每次推进都抛，永远恢复不了。

---

### 1.3 ✅ 没有 `cancel` / `reschedule`

`action-queue.ts:19-25` 的接口只有三个方法：

```ts
slice(schedule(intent, context): ActionVerdict;
      settleDue(now, ledger): number;
      pending(): readonly QueuedAction[];)
```

而 `settleDue` 也不复审世界（`:50-64` 只按时间提交，不看前因后果）。

→ **下雨、身体不舒服、作业提前交，这三类每天都会发生的事，没有表达路径**。
被取消的计划会照原样成为永久事实（`life-events.ts` 的事件没有取消字段）。

---

### 1.4 ✅ 线上零装配

全仓 grep `actionQueue|settleDue` 的结果：

| 位置 | 性质 |
| --- | --- |
| `sim/runner.ts:165` | 构造队列（**只在模拟器装配**） |
| `sim/runner.ts:463` | `settleDue` 调用（**唯一一处**） |
| `test/action-queue.test.ts` | 测试 |

`app.ts`（线上入口）里**没有** `actions` / `action-queue` / `life-events` 的任何引用
（唯一相关的是 `:218` 的 `onWorldActions: sharedWorld.record`，属于世界回写，不是行动队列）。

→ **结论：执行器还没接线。** 这一条与 handoff 里「已完成但尚未上线」的说法一致
（handoff 第 22 行说「不能当作线上已生效」），**但它比 handoff 说的更严重**：
handoff 说的是「没重启所以不算生效」，实际情况是**代码里根本没有装配点**——重启也不会生效。

> ⚠️ 这两句的差别很重要：如果按 handoff 的理解，重启即可；
> 按实际代码，**重启没用**，还需要新写装配。

---

### 1.5 ✅ 跨日：00:00–02:00 排不出 `sleep`

`actions.ts:166-171` 的 `sleepSpan` 要求 `stateAt()` 返回的 `activity.kind === 'sleep'`，
而 02:00 之前 `stateAt` 返回的是前一天的 evening（`schedule.ts:86`）。

→ **「熬夜到两点再睡」表达不出来**；熬夜赶作业会被 02:00 边界截断。

好消息是 `herDay` 的 02:00 边界与睡眠段本身是一致的（`actions.ts:170` 用 `state.activity.until`）。

---

## 2. 子代理报告、我未逐行复核的（**标注为待你们确认**）

以下四条我**没有**自己逐行验证，是从代码审查过程里得到的。请当作线索，不是结论：

| # | 说法 | 为什么值得查 |
| --- | --- | --- |
| 2.1 | `world.ts:728-734` 对某些事件静默 `continue`（不写不报错） | 与 1.2 组合成自锁；**这是 1.2 的触发器，优先确认** |
| 2.2 | `settleDue(now)` 与 worldState 的 `nowFn`（`app.ts:146`）是两个时钟 | 双时钟会让「已到期」判定与状态投影不一致 |
| 2.3 | `alreadyDid` 用日历日（`actions.ts:192` 的 `formatDate`），而账本的 `day` 用 `herDay` | 02:00 前后跨日会判重失误。`life-events.ts:16,73` 确认 `day` 是受校验的日期串，**但由谁写入、是不是 herDay，我没查** |
| 2.4 | `typedOccupation`（`actions.ts:114-128`）无生产调用方；状态行仍走 `world.ts` → `contact.ts` | 若成立，说明状态行还没接行动结果 |

---

## 3. 建议的先后（针对「能不能支撑执行器」）

| 序 | 做什么 | 为什么先做 | 验收判据 |
| --- | --- | --- | --- |
| **1** | `schedule` 加**对 `items` 的区间冲突检查** | 1.1 会直接写脏事实账，且测试没覆盖 | 新测试：两条重叠行动，第二条被拒或标记 `interrupted` |
| **2** | `settleDue` 抛错路径**降级**：改成「记日志 + 保留队列 + 不再重试同一 id」或「移到死信区」 | 1.2 的自锁；先确认 2.1 | 新测试：账本拒收时，队列不再无限抛错，且可见丢失记录 |
| **3** | 加 `cancel(id, reason)` / `reschedule(id, patch)` | 1.3 让「下雨 / 不舒服 / 作业提前交」无路可走 | 新测试：取消一条已排行动，账本里出现 `interrupted` 且队列清空 |
| **4** | `settleDue` 挂到**统一时钟推进点** | 目前只在 `runner.ts:463`，纯 `wait` 场景永不结算 | 测试：只有 wait 的一轮，到期的行动仍然被结算 |
| **5** | 写线上装配（`app.ts`） | 1.4：重启也不会生效 | 启动日志出现队列装配行；线上跑一天后 `action-queue.json` 非空且能清空 |

**在 1–3 完成之前，不建议把执行器接线上。** 现在接上去的第一天就会产生重叠事实与卡死的队列。

---

## 4. 说明

- 本报告是**静态审查**：DSH 侧没有 `runtime/bot`，**跑不了**模拟器，也复现不了线上行为。
  所有「验收判据」都需要在你们那侧真跑。
- 第 1 节的五条我都亲手在文件里核对过，附了行号。
- 第 2 节的四条标了「未逐行复核」，请不要当结论用。
- ADR 0036 四批自然对话报告的复核还在进行中，完成后另出一份。
