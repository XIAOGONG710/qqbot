# 模块：说话（语言）

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她每一句话怎么说：提示词怎么拼、这一轮的意图、每条多长几条、口头禅和书面词、出口检查（助手腔 / 禁用词 / 医书词）、小梗、被打断、关系阶段、陪玩。

## 文件（`packages/bot/src/` 下）

- `language/prompt.ts`
- `language/intent.ts`
- `language/shape.ts`
- `language/turn-weight.ts`
- `language/expression.ts`
- `language/exit-check.ts`
- `language/fact-check.ts`
- `language/speech-check.ts`
- `language/unfinished.ts`
- `language/candidates.ts`
- `language/humanness.ts`
- `language/rough-edges.ts`
- `language/reply.ts`
- `language/qq-faces.ts`
- `language/context-window.ts`
- `language/tokens.ts`
- `language/status-line.ts`
- `language/time-context.ts`
- `language/relationship.ts`
- `language/intimacy.ts`
- `language/jokes.ts`
- `language/idioms.ts`
- `language/memes.ts`
- `language/meme-dict.ts`
- `language/exemplars.ts`
- `language/register.ts`
- `language/self-thread.ts`
- `language/reading.ts`
- `language/scenes.ts`
- `language/asks.ts`
- `language/opinion.ts`
- `language/after-no.ts`
- `language/chat-review.ts`
- `language/speaking.ts`
- `language/speech-notes.ts`
- `language/speech-feedback.ts`
- `language/speech-trend.ts`
- `language/tropes.ts`
- `language/watching.ts`
- `language/texture.ts`
- `language/selfcheck.ts`
- `language/bili-stickers.ts`
- `language/interruption.ts`
- `language/together.ts`
- `language/jealousy.ts`
- `language/curious.ts`
- `language/llm.ts`
- `language/model-guard.ts`
- `st/`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `shape` | 形状控制（每条多长、几条） | [ADR 0091](../adr/0091-reply-shape.md) |
| `shapeAgenda` | 带自己的事 | [ADR 0094](../adr/0094-her-own-agenda.md) |
| `shapeFiller` | 废话轮次 | [ADR 0095](../adr/0095-filler-turns.md) |
| `shapeSplit` | 拆成几条 | [ADR 0096](../adr/0096-split-and-share.md) |
| `shapeAsk` | 被问问题时答完再接着说 | [ADR 0149](../adr/0149-answer-then-continue.md) |
| `shapeLong` | 被认真问想法时说长一点 | [ADR 0150](../adr/0150-long-answers.md) |
| `deliberate` | 认真问她时深思（更强的模型、不套字数） | [ADR 0151](../adr/0151-deliberate.md) |
| `shapeFeel` | 情绪轮（先说自己的小情绪） | [ADR 0099](../adr/0099-too-smooth.md) |
| `shortReplies` | 说话更短 |  |
| `rhythm` | 回复节奏（看想 / 打字时间） | [ADR 0075](../adr/0075-reply-rhythm.md) |
| `lagTail` | 回复延迟的长尾 | [ADR 0105](../adr/0105-reply-lag-tail.md) |
| `herNo` | 会拒绝 | [ADR 0103](../adr/0103-her-no.md) |
| `afterNo` | 拒绝之后（他又提同一类请求时记得上次：拒了他只回「行吧」、或者勉强答应了；要不要还是她定） | [ADR 0214](../adr/0214-after-no.md) |
| `moody` | 看心情不回 | [ADR 0013](../adr/0013-old-project-advice.md) |
| `speechCheck` | 说话的毛病（出口检查） | [ADR 0014](../adr/0014-speech-habits.md) |
| `factCheck` | 逐条事实检查（编的说法 / 对不上事实）（模式） | [ADR 0137](../adr/0137-fact-check.md) |
| `relationship` | 关系阶段（聊得多了更放得开） | [ADR 0113](../adr/0113-relationship-stage.md) |
| `jokes` | 小梗回头提 | [ADR 0114](../adr/0114-running-jokes.md) |
| `idioms` | 被他带出口头习惯（他爱说的词她偶尔顺口用） | [ADR 0138](../adr/0138-idioms.md) |
| `tailCap` | 句尾「吧」「呢」封顶（压回真人的水平） | [ADR 0146](../adr/0146-human-videos.md) |
| `interruptions` | 被第三方打断 | [ADR 0115](../adr/0115-interruptions.md) |
| `together` | 陪玩状态 | [ADR 0111](../adr/0111-together.md) |
| `silenceNotice` | 没回时告诉他原因（作息 / 她的决定 / 故障） | [ADR 0173](../adr/0173-silence-reasons.md) |
| `speechNotes` | 她每晚自己总结说话习惯（「我发现……」，挑几条放进提示词；他可以用 /像AI /像真人 标她说的话给她看；/说话趋势 按周看她说话的数字） | [ADR 0193](../adr/0193-nightly-speech-notes.md) |
| `exemplars` | 看真人怎么回（从已批准的真人语料挑几条当口气参考） | [ADR 0190](../adr/0190-learn-from-real-chat.md) |
| `jealousy` | 吃醋（最轻一档） | [ADR 0123](../adr/0123-jealousy.md) |
| `texture` | 说话的质感（问号 / ～ / 小黄脸 / 叠字） | [ADR 0131](../adr/0131-texture.md) |
| `curious` | 会追问（问他刚说的那件事） | [ADR 0126](../adr/0126-curious.md) |
| `chatReview` | 她每天回顾聊天（每晚看今天数得出来的几处：他说她说错、只回嗯、连问、太长、重复，她自己判断、记一句；私人空间） | [ADR 0221](../adr/0221-chat-review.md) |
| `depthRouting` | 语义路由：关键词没认出来的轮次，问小模型这一句是轻是重——沉重的事 / 要她的看法 / 问她自己 / 质疑她 / 问他们俩的，也走深思（要 deliberate 开着） | [ADR 0202](../adr/0202-depth-routing.md) |
| `memes` | 知道网上的热梗 | [ADR 0129](../adr/0129-memes.md) |

## 看它有没有变好

周报「说话的样子」「表情和语气」「她的口头禅」；consistency-cli；humanness-cli；rough-edges-cli；blind-judge-cli

## 最相关的 ADR

[ADR 0091](../adr/0091-reply-shape.md)、[ADR 0095](../adr/0095-filler-turns.md)、[ADR 0096](../adr/0096-split-and-share.md)、[ADR 0099](../adr/0099-too-smooth.md)、[ADR 0113](../adr/0113-relationship-stage.md)、[ADR 0114](../adr/0114-running-jokes.md)、[ADR 0115](../adr/0115-interruptions.md)、[ADR 0111](../adr/0111-together.md)、[ADR 0121](../adr/0121-odd-words.md)、[ADR 0137](../adr/0137-fact-check.md)、[ADR 0138](../adr/0138-idioms.md)、[ADR 0167](../adr/0167-selfcheck.md)、[ADR 0193](../adr/0193-nightly-speech-notes.md)、[ADR 0195](../adr/0195-speech-feedback.md)、[ADR 0196](../adr/0196-speech-trend.md)、[ADR 0198](../adr/0198-read-through-fixes.md)、[ADR 0202](../adr/0202-depth-routing.md)、[ADR 0205](../adr/0205-trope-shares.md)、[ADR 0203](../adr/0203-fact-check-him.md)、[ADR 0214](../adr/0214-after-no.md)、[ADR 0221](../adr/0221-chat-review.md)、[ADR 0256](../adr/0256-speaking-direct-answer.md)、[ADR 0257](../adr/0257-latest-turn-budget.md)
