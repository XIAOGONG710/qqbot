# 模块：说话（语言）

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她每一句话怎么说：提示词怎么拼、这一轮的意图、每条多长几条、口头禅和书面词、出口检查（助手腔 / 禁用词 / 医书词）、小梗、被打断、关系阶段、陪玩。

## 文件（`packages/bot/src/` 下）

- `prompt.ts`
- `intent.ts`
- `shape.ts`
- `expression.ts`
- `exit-check.ts`
- `speech-check.ts`
- `candidates.ts`
- `humanness.ts`
- `reply.ts`
- `qq-faces.ts`
- `context-window.ts`
- `tokens.ts`
- `status-line.ts`
- `time-context.ts`
- `relationship.ts`
- `jokes.ts`
- `memes.ts`
- `watching.ts`
- `interruption.ts`
- `together.ts`
- `jealousy.ts`
- `curious.ts`
- `llm.ts`
- `model-guard.ts`
- `st/`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `shape` | 形状控制（每条多长、几条） | [ADR 0091](../adr/0091-reply-shape.md) |
| `shapeAgenda` | 带自己的事 | [ADR 0094](../adr/0094-her-own-agenda.md) |
| `shapeFiller` | 废话轮次 | [ADR 0095](../adr/0095-filler-turns.md) |
| `shapeSplit` | 拆成几条 | [ADR 0096](../adr/0096-split-and-share.md) |
| `shapeFeel` | 情绪轮（先说自己的小情绪） | [ADR 0099](../adr/0099-too-smooth.md) |
| `shortReplies` | 说话更短 |  |
| `rhythm` | 回复节奏（看想 / 打字时间） | [ADR 0075](../adr/0075-reply-rhythm.md) |
| `lagTail` | 回复延迟的长尾 | [ADR 0105](../adr/0105-reply-lag-tail.md) |
| `herNo` | 会拒绝 | [ADR 0103](../adr/0103-her-no.md) |
| `moody` | 看心情不回 | [ADR 0013](../adr/0013-old-project-advice.md) |
| `speechCheck` | 说话的毛病（出口检查） | [ADR 0014](../adr/0014-speech-habits.md) |
| `relationship` | 关系阶段（聊得多了更放得开） | [ADR 0113](../adr/0113-relationship-stage.md) |
| `jokes` | 小梗回头提 | [ADR 0114](../adr/0114-running-jokes.md) |
| `interruptions` | 被第三方打断 | [ADR 0115](../adr/0115-interruptions.md) |
| `together` | 陪玩状态 | [ADR 0111](../adr/0111-together.md) |
| `jealousy` | 吃醋（最轻一档） | [ADR 0123](../adr/0123-jealousy.md) |
| `curious` | 会追问（问他刚说的那件事） | [ADR 0126](../adr/0126-curious.md) |
| `memes` | 知道网上的热梗 | [ADR 0129](../adr/0129-memes.md) |

## 看它有没有变好

周报「说话的样子」「表情和语气」「她的口头禅」；consistency-cli；humanness-cli；blind-judge-cli

## 最相关的 ADR

[ADR 0091](../adr/0091-reply-shape.md)、[ADR 0095](../adr/0095-filler-turns.md)、[ADR 0096](../adr/0096-split-and-share.md)、[ADR 0099](../adr/0099-too-smooth.md)、[ADR 0113](../adr/0113-relationship-stage.md)、[ADR 0114](../adr/0114-running-jokes.md)、[ADR 0115](../adr/0115-interruptions.md)、[ADR 0111](../adr/0111-together.md)、[ADR 0121](../adr/0121-odd-words.md)
