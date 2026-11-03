# 模块：她的日子（生活）

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她自己的一天：作息、世界账（天气、猫、快递、作业、钱）、日常小事和小测、项目与追求、身体、心情和在读的书、真人式连续数值、闺蜜、节日、承诺和日记。

## 文件（`packages/bot/src/` 下）

- `life/schedule.ts`
- `life/actions.ts`
- `life/projects.ts`
- `life/pursuits.ts`
- `life/money.ts`
- `life/body.ts`
- `life/needs.ts`
- `life/her-days.ts`
- `life/day-plan.ts`
- `life/everyday.ts`
- `life/menu.ts`
- `life/diary.ts`
- `life/biography.ts`
- `life/bedtime.ts`
- `life/people.ts`
- `life/promises.ts`
- `life/promise-state.ts`
- `life/open-loops.ts`
- `life/tastes.ts`
- `life/acquaintances.ts`
- `human-values.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `tastes` | 从经历里长出偏好 | [ADR 0162](../adr/0162-tastes.md) |
| `acquaintances` | 认识的人（B 站上再见到认得） | [ADR 0163](../adr/0163-acquaintances.md) |
| `herDays` | 每日心情、在读的书 | [ADR 0015](../adr/0015-her-own-days.md) |
| `schedule` | 作息 | [ADR 0007](../adr/0007-schedule-and-reply-timing.md) |
| `autonomousLife` | 没人聊天时她一件件过日子 | [ADR 0040](../adr/0040-rule-life-selector.md) |
| `projectChoice` | 作业接管空闲 | [ADR 0056](../adr/0056-project-portfolio.md) |
| `lifeInPrompt` | 生活账进提示词 | [ADR 0045](../adr/0045-continuous-needs.md) |
| `realWeather` | 真实天气 | [ADR 0048](../adr/0048-real-weather.md) |
| `everydayLife` | 日常小事 / 小测 | [ADR 0106](../adr/0106-everyday-life.md) |
| `menu` | 每顿吃什么（每天随机） | [ADR 0125](../adr/0125-menu.md) |
| `pursuits` | 她自己的追求 | [ADR 0104](../adr/0104-pursuits.md) |
| `herFeelings` | 心境（开心 / 难过 / 流泪） | [ADR 0102](../adr/0102-feelings.md) |
| `grievance` | 小别扭 / 和好 | [ADR 0074](../adr/0074-small-grievance.md) |
| `npcAsks` | 闺蜜约人 / 改约 | [ADR 0061](../adr/0061-friends-ask-and-back-out.md) |
| `festivals` | 公共节日（模式） | [ADR 0076](../adr/0076-festivals-and-winter-break.md) |

## 看它有没有变好

周报「她的日子」；consistency-cli（说的和账对不对）；sim/life-audit

## 最相关的 ADR

[ADR 0015](../adr/0015-her-own-days.md)、[ADR 0040](../adr/0040-rule-life-selector.md)、[ADR 0045](../adr/0045-continuous-needs.md)、[ADR 0104](../adr/0104-pursuits.md)、[ADR 0106](../adr/0106-everyday-life.md)、[ADR 0162](../adr/0162-tastes.md)、[ADR 0163](../adr/0163-acquaintances.md)、[ADR 0222](../adr/0222-human-values.md)
