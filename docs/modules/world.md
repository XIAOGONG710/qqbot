# 模块：她的世界（世界账）

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她那边正在发生的事：天气、节日、NPC、障碍、生活事件与选择、可重放的动作队列；世界状态是所有“她那边”的事实来源。

## 文件（`packages/bot/src/` 下）

- `world/world.ts`
- `world/weather.ts`
- `world/air-quality.ts`
- `world/daylight.ts`
- `world/threads.ts`
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
| `diaryInsights` | 她每晚翻自己的日记，写下对自己的认识（「我发现自己……」，要有两天以上的依据） | [ADR 0194](../adr/0194-diary-insights.md) |
| `herDays` | 每日心情、在读的书 | [ADR 0015](../adr/0015-her-own-days.md) |
| `schedule` | 作息 | [ADR 0007](../adr/0007-schedule-and-reply-timing.md) |
| `autonomousLife` | 没人聊天时她一件件过日子 | [ADR 0040](../adr/0040-rule-life-selector.md) |
| `projectChoice` | 作业接管空闲 | [ADR 0056](../adr/0056-project-portfolio.md) |
| `lifeInPrompt` | 生活账进提示词 | [ADR 0045](../adr/0045-continuous-needs.md) |
| `realWeather` | 真实天气 | [ADR 0048](../adr/0048-real-weather.md) |
| `realAirQuality` | 真实空气质量 | [ADR 0227](../adr/0227-real-air-quality.md) |
| `realDaylight` | 真实日照 | [ADR 0228](../adr/0228-real-daylight.md) |
| `everydayLife` | 日常小事 / 小测 | [ADR 0106](../adr/0106-everyday-life.md) |
| `worldDrama` | 日子里的小起伏（一天之内的难过 / 烦 / 高兴） | [ADR 0211](../adr/0211-world-drama.md) |
| `worldThreads` | 她那边的事有后续（拌嘴第二天和好、淋雨第二天嗓子发紧……一天最多一条；闹心的事有冷却期；要日常小事和小起伏） | [ADR 0216](../adr/0216-world-threads.md) |
| `diaryLookback` | 翻回去看自己的日记（他问到前几天的事，她那天写的日记也给她，说法对得上） | [ADR 0217](../adr/0217-diary-lookback.md) |
| `memoryFeelings` | 回忆带着当时的感觉（想起某天的事时附一句她那天有依据的感觉；因为他而难过 / 烦的不附；要心境） | [ADR 0218](../adr/0218-memory-feelings.md) |
| `realNights` | 昨晚真的怎么睡的（早上困不困看她几点说睡了、半夜有没有被吵醒，不按课表；被吵醒有起床气） | [ADR 0219](../adr/0219-real-nights.md) |
| `menu` | 每顿吃什么（每天随机） | [ADR 0125](../adr/0125-menu.md) |
| `pursuits` | 她自己的追求 | [ADR 0104](../adr/0104-pursuits.md) |
| `herFeelings` | 心境（开心 / 难过 / 流泪；桌面上的她读同一份；ownerPeek 开着时 /心境 看） | [ADR 0102](../adr/0102-feelings.md) |
| `feelingReview` | 她聊完回想一下，记下有依据的感受（每条要指出是哪几条消息让她有的） | [ADR 0197](../adr/0197-feelings-shared-and-reviewed.md) |
| `readingTakes` | 她读完 / 看完之后自己想的（每晚一次，有话想说才写；私人空间，聊到那本书 / 视频才放进提示词） | [ADR 0204](../adr/0204-reading-takes.md) |
| `herGuesses` | 她猜的事和后来的结果（每晚她自己挑哪句算数、对照世界账看对没对；私人空间，聊到同一类事才放进提示词） | [ADR 0213](../adr/0213-her-guesses.md) |
| `openQuestions` | 她没想完的问题（他问她答「不知道」的，夜里她自己想一遍，想出什么写什么；私人空间，他再问到同一件事才放进提示词） | [ADR 0207](../adr/0207-open-questions.md) |
| `ownerPeek` | 他能不能用 /追求 /说话习惯 /心境 /自我认识 看她自己总结 / 回想出来的东西（默认不能：她的私人空间） | [ADR 0200](../adr/0200-private-space.md) |
| `grievance` | 小别扭 / 和好 | [ADR 0074](../adr/0074-small-grievance.md) |
| `npcAsks` | 闺蜜约人 / 改约 | [ADR 0061](../adr/0061-friends-ask-and-back-out.md) |
| `festivals` | 公共节日（模式） | [ADR 0076](../adr/0076-festivals-and-winter-break.md) |

## 看它有没有变好

周报「她的日子」里的世界事件；consistency-cli（说的和世界账对不对）

## 最相关的 ADR

[ADR 0007](../adr/0007-schedule-and-reply-timing.md)、[ADR 0026](../adr/0026-diary-of-her-day.md)、[ADR 0045](../adr/0045-continuous-needs.md)、[ADR 0106](../adr/0106-everyday-life.md)、[ADR 0216](../adr/0216-world-threads.md)、[ADR 0217](../adr/0217-diary-lookback.md)、[ADR 0227](../adr/0227-real-air-quality.md)、[ADR 0228](../adr/0228-real-daylight.md)
