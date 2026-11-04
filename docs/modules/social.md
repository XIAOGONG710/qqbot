# 模块：在 QQ 上的样子（社交）

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：什么时候看到、打字多久、一次发几条；图片表情和照片货架；戳一戳、已读、在线状态、说说、签名、“正在输入”、撤回；听语音看图。

## 文件（`packages/bot/src/` 下）

- `social/responder.ts`
- `social/silence.ts`
- `social/outbox.ts`
- `social/others.ts`
- `social/reply-timing.ts`
- `social/rate-limit.ts`
- `social/strangers.ts`
- `social/group-chat.ts`
- `social/async-gate.ts`
- `social/stickers.ts`
- `social/sticker-favorites.ts`
- `social/sticker-sources.ts`
- `social/pokes.ts`
- `social/presence.ts`
- `social/qzone.ts`
- `social/qzone-feed.ts`
- `social/qzone-feeds3.ts`
- `social/qzone-remote.ts`
- `social/qzone-strangers.ts`
- `social/account.ts`
- `social/quote-reply.ts`
- `social/external-drafts.ts`
- `social/external-platforms.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `biliStickers` | 表情包自己在 B 站找（顶替小黄脸） | [ADR 0132](../adr/0132-bili-stickers.md) |
| `readStickers` | 看懂他发的表情包（先抄图上的字、再说画面；要看图模型） | [ADR 0206](../adr/0206-read-his-stickers.md) |
| `foodPhotos` | 吃的照片（这一顿拍给他看） | [ADR 0128](../adr/0128-food-photos.md) |
| `photos` | 照片货架（网上找高清图） | [ADR 0109](../adr/0109-photo-shelf.md) |
| `aiPhotos` | AI 生活照草稿（人工审核后才可用） | [ADR 0240](../adr/0240-world-and-qq-ai-photo-requests.md) |
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
| `qzonePeek` | 刷好友动态（看名单里好友发的说说）（模式） | [ADR 0145](../adr/0145-qzone-friends-feed.md) |
| `qzoneStrangers` | 刷陌生人的空间（学人怎么说话）（模式） | [ADR 0144](../adr/0144-qzone-strangers.md) |
| `groupChat` | 群聊（只在名单里的群、被叫到才说）（模式） | [ADR 0210](../adr/0210-group-chat.md) |
| `typingStatus` | “正在输入…” | [ADR 0077](../adr/0077-typing-status.md) |
| `selfRecall` | 打错字撤回重发 | [ADR 0086](../adr/0086-self-recall.md) |
| `quoteReply` | 引用回复（他连发里的问题 / 补错字） | [ADR 0136](../adr/0136-quote-reply.md) |

## 看它有没有变好

周报「说话的样子」里的延迟、「表情和语气」

## 最相关的 ADR

[ADR 0063](../adr/0063-image-stickers.md)、[ADR 0075](../adr/0075-reply-rhythm.md)、[ADR 0077](../adr/0077-typing-status.md)、[ADR 0083](../adr/0083-presence.md)、[ADR 0105](../adr/0105-reply-lag-tail.md)、[ADR 0109](../adr/0109-photo-shelf.md)、[ADR 0136](../adr/0136-quote-reply.md)、[ADR 0142](../adr/0142-qq-account-control.md)、[ADR 0143](../adr/0143-qzone-peek.md)、[ADR 0144](../adr/0144-qzone-strangers.md)、[ADR 0173](../adr/0173-silence-reasons.md)、[ADR 0174](../adr/0174-soul-module-stop-the-bleeding.md)、[ADR 0209](../adr/0209-strangers.md)、[ADR 0210](../adr/0210-group-chat.md)
