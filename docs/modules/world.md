# 模块：她的世界（世界账）

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她那边正在发生的事：天气、节日、NPC、障碍、生活事件与选择、可重放的动作队列；世界状态是所有“她那边”的事实来源。

## 文件（`packages/bot/src/` 下）

- `world/world.ts`
- `world/weather.ts`
- `world/festivals.ts`
- `world/npc.ts`
- `world/npc-asks.ts`
- `world/obstacles.ts`
- `world/life-events.ts`
- `world/life-selector.ts`
- `world/action-queue.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `tastes` | 从经历里长出偏好 | [ADR 0162](../adr/0162-tastes.md) |
| `acquaintances` | 认识的人（B 站上再见到认得） | [ADR 0163](../adr/0163-acquaintances.md) |
| `selfPursuits` | 她自己定追求（每晚想一次，自己放下 / 提新的） | [ADR 0178](../adr/0178-self-set-pursuits.md) |
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

周报「她的日子」里的世界事件；consistency-cli（说的和世界账对不对）

## 最相关的 ADR

[ADR 0007](../adr/0007-schedule-and-reply-timing.md)、[ADR 0026](../adr/0026-diary-of-her-day.md)、[ADR 0045](../adr/0045-continuous-needs.md)、[ADR 0106](../adr/0106-everyday-life.md)
