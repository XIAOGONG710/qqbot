# 模块：节奏、图片和在 QQ 上的样子

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：什么时候看到、打字多久、一次发几条；图片表情和照片货架；戳一戳、已读、在线状态、说说、签名、“正在输入”、撤回；听语音看图。

## 文件（`packages/bot/src/` 下）

- `responder.ts`
- `reply-timing.ts`
- `rate-limit.ts`
- `async-gate.ts`
- `stickers.ts`
- `sticker-favorites.ts`
- `sticker-sources.ts`
- `photos.ts`
- `photo-sources.ts`
- `pokes.ts`
- `presence.ts`
- `qzone.ts`
- `qzone-feed.ts`
- `qzone-remote.ts`
- `qzone-strangers.ts`
- `account.ts`
- `quote-reply.ts`
- `media.ts`
- `safe-image.ts`
- `vision.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `biliStickers` | 表情包自己在 B 站找（顶替小黄脸） | [ADR 0132](../adr/0132-bili-stickers.md) |
| `foodPhotos` | 吃的照片（这一顿拍给他看） | [ADR 0128](../adr/0128-food-photos.md) |
| `photos` | 照片货架（网上找高清图） | [ADR 0109](../adr/0109-photo-shelf.md) |
| `stickers` | 图片表情（模式） | [ADR 0063](../adr/0063-image-stickers.md) |
| `media` | 听语音、看图 | [ADR 0052](../adr/0052-voice-and-images.md) |
| `pokes` | 被戳会回 | [ADR 0079](../adr/0079-poke.md) |
| `pokeBack` | 戳回去 | [ADR 0079](../adr/0079-poke.md) |
| `pokeOut` | 主动戳他 | [ADR 0087](../adr/0087-poke-out.md) |
| `recalls` | 看得到他撤回 | [ADR 0082](../adr/0082-recalls.md) |
| `readReceipts` | 已读回执 | [ADR 0083](../adr/0083-presence.md) |
| `reactions` | 表情回应 | [ADR 0083](../adr/0083-presence.md) |
| `onlineStatus` | 在线状态 | [ADR 0083](../adr/0083-presence.md) |
| `profileLikes` | 资料卡点赞 | [ADR 0083](../adr/0083-presence.md) |
| `signature` | 个性签名（模式） | [ADR 0083](../adr/0083-presence.md) |
| `qzone` | 说说（模式） | [ADR 0083](../adr/0083-presence.md) |
| `qzoneBrowse` | 自己翻空间动态（模式） | [ADR 0142](../adr/0142-qq-account-control.md) |
| `qzonePeek` | 看好友的空间（模式） | [ADR 0143](../adr/0143-qzone-peek.md) |
| `qzoneStrangers` | 刷陌生人的空间（学人怎么说话）（模式） | [ADR 0144](../adr/0144-qzone-strangers.md) |
| `typingStatus` | “正在输入…” | [ADR 0077](../adr/0077-typing-status.md) |
| `selfRecall` | 打错字撤回重发 | [ADR 0086](../adr/0086-self-recall.md) |
| `quoteReply` | 引用回复（他连发里的问题 / 补错字） | [ADR 0136](../adr/0136-quote-reply.md) |

## 看它有没有变好

周报「说话的样子」里的延迟、「表情和语气」

## 最相关的 ADR

[ADR 0063](../adr/0063-image-stickers.md)、[ADR 0075](../adr/0075-reply-rhythm.md)、[ADR 0077](../adr/0077-typing-status.md)、[ADR 0083](../adr/0083-presence.md)、[ADR 0105](../adr/0105-reply-lag-tail.md)、[ADR 0109](../adr/0109-photo-shelf.md)、[ADR 0136](../adr/0136-quote-reply.md)、[ADR 0142](../adr/0142-qq-account-control.md)、[ADR 0143](../adr/0143-qzone-peek.md)、[ADR 0144](../adr/0144-qzone-strangers.md)
