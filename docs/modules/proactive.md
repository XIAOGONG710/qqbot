# 模块：主动找他

> 由 `packages/bot/src/platform/modules.ts` 清单生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她什么时候先开口：早安、下课、睡前、冷场、随口说件事、约他、问意见、喂完猫拍照、说了等下之后回来、没回也继续、心里的念头、待跟进的事。

## 文件（`packages/bot/src/` 下）

- `proactive/proactive.ts`
- `proactive/proactive-planner.ts`
- `proactive/proactive-state.ts`
- `proactive/inner.ts`
- `proactive/shares.ts`
- `proactive/follow-ups.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `proactive` | 主动消息（模式） | [ADR 0011](../adr/0011-proactive-messages.md) |
| `proactiveReach` | 没回也继续 / 催他 | [ADR 0100](../adr/0100-reach-when-unanswered.md) |
| `innerLife` | 内心（念头 / 心里惦记） | [ADR 0101](../adr/0101-inner-life.md) |
| `proactiveInvite` | 约他一起玩 | [ADR 0107](../adr/0107-invite-to-play.md) |
| `proactiveAsk` | 问问他的意见 | [ADR 0116](../adr/0116-ask-opinion.md) |
| `photoShares` | 喂完猫发张照片 | [ADR 0110](../adr/0110-photo-shares.md) |
| `comeBack` | 说了等下之后回来 | [ADR 0112](../adr/0112-come-back.md) |
| `hisHours` | 按他在线的钟头排 | [ADR 0117](../adr/0117-his-hours.md) |
| `smallNews` | 主动讲今天的小事 | [ADR 0127](../adr/0127-small-news.md) |
| `proactiveRoom` | 给主动名额留余地（晚安不占、留一个给随口说） | [ADR 0124](../adr/0124-proactive-room.md) |

## 看它有没有变好

周报「主动性」（条数、30 分钟内他回的占比、按时机分）

## 最相关的 ADR

[ADR 0011](../adr/0011-proactive-messages.md)、[ADR 0080](../adr/0080-share-cards.md)、[ADR 0100](../adr/0100-reach-when-unanswered.md)、[ADR 0101](../adr/0101-inner-life.md)、[ADR 0107](../adr/0107-invite-to-play.md)、[ADR 0110](../adr/0110-photo-shares.md)、[ADR 0112](../adr/0112-come-back.md)、[ADR 0116](../adr/0116-ask-opinion.md)、[ADR 0117](../adr/0117-his-hours.md)、[ADR 0124](../adr/0124-proactive-room.md)、[ADR 0156](../adr/0156-proactive-now.md)、[ADR 0236](../adr/0236-proactive-commit-and-cancellation.md)
