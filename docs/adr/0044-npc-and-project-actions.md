# ADR 0044：同学来往和长期项目进行动账（生活内核 A 阶段的最后两项）

- 状态：已实现（模拟器，影子模式：记账、不进提示词），单元测试、模拟器回归见下（2026-10-09）
- 日期：2026-10-09
- 关联：[ADR 0033](0033-npc-days.md)（同学自己的日子和世界里的同学事件）、[ADR 0037](0037-typed-life-actions.md)（类型化行动与裁判）、[ADR 0040](0040-rule-life-selector.md)（规则自主选择器）、
  [ADR 0042](0042-interrupts-and-chat-rewrites.md)（硬事件打断、状态行审计）、[长期执行计划](../plans/2026-10-08-long-term-execution.md) 第 4 节 A 阶段门槛（「至少一次 NPC 互动、一个长期目标进展」）

## 背景

ADR 0040 / 0042 之后，她没人聊天时一件件过日子：睡觉、吃饭、上课、学习、读书、休闲都落进事件账，72 小时重启一致、状态行 0 分叉。
但长期计划 A 阶段的门槛还差两项：

- **NPC 互动**：世界里早就有同学的事（ADR 0033：苏雨桐下课拉她去食堂、感冒时她帮拍板书；陈佳宁晚上在微信上互损、感冒抱怨），只在世界和日记里，行动账上看不出她和谁在一起。
- **长期目标进展**：作息里的「修片、摄影」只是空闲活动的几个字，一直记成 `leisure`；摄影这件她真在推进的事没有进展可言。

这一版由 Codex 10-09 上午写在线上目录里（未提交），下午用户同意后原样挪到分支 `codex-wip-adr0044`（`04f84fe`），Claude 从那里接着做完、补了反方向审计和本文。

## 决策

1. **两种新行动**（`actions.ts`）：`work_on_project`（15–240 分钟，默认 60）和 `interact_npc`（5–60 分钟，默认 15）；两种都要 `subject`（状态行那几个字）和 `target`。
   **`target` 是稳定 ID**（项目 ID、NPC 的 `id`），不拿显示名当标识；`LifeEvent` 多一个可选的 `target` 字段，旧账本照读。
2. **同学的事进账，挂在本来就有的那件事上**（`life-selector.ts`）：
   - 一起去食堂（`lunch_with_friend`）、辣米线（`spicy_noodles`）→ 那顿午饭的 `eat` 带上 `target`（「和朋友吃午饭」）；
   - 帮她拍板书（`notes_for_friend`）→ 那节课的 `attend_class` 带上 `target`；
   - 别的同学事件（微信互损、感冒抱怨）→ 单独一段 `interact_npc`，15 分钟，「在微信上跟陈佳宁聊了会儿」；空闲活动排到这件事之前就停（和饭点、世界里的事同一个截断）。
   世界里同学事件的 `person` 多带一个 `id`（`world.ts`），文字不变，提示词不变。
3. **摄影成长是第一个长期项目**（`projects.ts`）：空闲活动里写着「修片」「摄影」的，记成 `work_on_project`、`target: photography_growth`；普通刷手机、打游戏还是 `leisure`。
   **「刷摄影区」不算**（Claude 改了 Codex 的初稿）：刷着看别人的片子是休闲，修片、出去拍才算在练；算进去，72 小时里的「进展」从 209 分钟虚涨到 331 分钟。
   **进展只从事件账推**（`photographyProgress`：次数、分钟、最近三步），不另存一个会和账本漂移的「进度数字」（相机基金那次的教训，ADR 0035）。
   赶作业照样抢它（`DEADLINE_PREEMPTS`），聊天里说过做了别的也照样改写它（`REVISABLE`，ADR 0042）。
4. **审计两个方向都要对**（`sim/life-audit.ts`）：
   - 账 → 状态行（ADR 0042）：`interact_npc` 不在作息文本里，能从同一天世界里那件带 `person.id` 的事核回对象就算一致；
   - **状态行 → 账（新，Claude 复核时提的）**：`auditLedgerCoverage` 在第一件到最后一件行动之间每 15 分钟取一次状态行，状态行说她在睡觉、上课、吃饭、学习、做空闲里的某件事，
     账上那一刻却没有行动、而且那段空当不短于 10 分钟（执行器本来不记的短空当），就记一条「账上缺」。模拟器的 `statusConsistent` 两个方向都过才算过。
5. **还是影子模式**：`autonomousLife` 默认关；进展不进提示词、日记、状态行。

## 不做的

- 长期项目的期限、资源、阻碍、暂停和放弃条件，另外两个首批项目（课程项目、相机基金）——长期计划 B 阶段。
- NPC 拒绝、迟到、改约、主动找她——C 阶段（社会生态里的「NPC 行动与反应」）；这一版只把世界里已经定好的事搬进账。
- 进展进提示词（「最近修片修到哪了」）：先在模拟器里看几天的进展数字合不合理，再决定怎么说出口。

## 实现

| 文件 | 改了什么 |
| --- | --- |
| `packages/bot/src/actions.ts` | `work_on_project`、`interact_npc`；`target` 字段；两种都要 subject 和 target；赶作业抢 `work_on_project` |
| `packages/bot/src/projects.ts`（新） | `projectActivity`（哪些空闲活动算摄影成长）、`photographyProgress`（从账推进展） |
| `packages/bot/src/life-selector.ts` | `dayWorld`、同学事件挂到午饭 / 上课上或单独一段 `interact_npc`；空闲活动截到下一件同学事件 |
| `packages/bot/src/action-queue.ts` | 队列里的行动带 `target`；`work_on_project` 可被聊天改写 |
| `packages/bot/src/world.ts` | 世界事件的 `person` 带 `id` |
| `packages/bot/src/sim/life-audit.ts` | `interact_npc` 的对照；`auditLedgerCoverage`（反方向） |
| `packages/bot/src/sim/runner.ts`、`scenario.ts` | 检查 `npcInteractionsAtLeast`、`projectProgressAtLeast`；`statusConsistent` 带上反方向 |
| `packages/bot/sim/life-72h-auto.json` | 至少 1 次带 NPC 的行动、摄影至少 120 分钟、`work_on_project` 至少 1 件 |
| 测试 | `projects.test.ts`；`actions.test.ts`（两种新行动的校验）；`life-selector.test.ts`（72 小时里和苏雨桐的来往进账、摄影 ≥ 120 分钟、两个方向的审计 0 问题，拿掉一段修片能被报出来） |

## 验证

- 单元测试：3.5 天的账本两个方向都 0 问题；反例——拿掉一段 30 分钟以上的修片，反方向审计正好报出一段 `work_on_project`。
- 真模型 `20261009-143433-adr44`（`life-72h-auto`，带中途重启，2 次）：回复检查 24 / 24、管线自检 21 / 21，两次都是。
  她的三天里：带同学的行动 2 件（10-13、10-14 中午都是和苏雨桐吃午饭）、摄影成长 4 段共 331 分钟（这批还把「刷摄影区」算在里面；去掉以后是 2 段修片、209 分钟，见下面复跑）、上课 10、饭 8、睡觉 3；
  状态行 ↔ 事件账两个方向都 0 问题（0 分叉、账上缺 0）。问这几天干了什么的回答和不开时一样（进展还不进提示词）。
- 去掉「刷摄影区」以后复跑 `20261009-144406-adr44b`（最终代码 `97f09a4`，1 次）：回复 24 / 24、管线 21 / 21；摄影成长 2 段修片共 209 分钟（10-12 下午 12:46–15:15、16:35–17:35），和苏雨桐吃午饭 2 次（10-13、10-14），两个方向的审计都 0。全仓 588 项通过。

## 确认记录

- 2026-10-06 用户授权「暴力推进，要选的按推荐定」；长期计划第 4 节 A 阶段门槛。2026-10-09 14:15 用户选择把 Codex 的半成品挪到分支再上线，之后由 Claude 接着做完。
