# 模块：在 QQ 上的样子（社交）

> 由 `packages/bot/src/platform/modules.ts` 清单生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：什么时候看到、打字多久、一次发几条；图片表情和照片货架；戳一戳、已读、在线状态、说说、签名、“正在输入”、撤回；听语音看图。

## 文件（`packages/bot/src/` 下）

- `social/responder.ts`
- `modules/media-offers.ts`
- `social/silence.ts`
- `social/outbox.ts`
- `social/outbox-host.ts`
- `social/others.ts`
- `social/reply-timing.ts`
- `social/rate-limit.ts`
- `social/strangers.ts`
- `social/private-admission.ts`
- `social/group-chat.ts`
- `social/group-room.ts`
- `social/group-agency-wiring.ts`
- `social/group-people.ts`
- `social/group-affect.ts`
- `social/group-impression.ts`
- `social/group-import.ts`
- `social/group-memory.ts`
- `social/group-style.ts`
- `social/group-self.ts`
- `social/group-opportunity.ts`
- `social/desktop-affect.ts`
- `social/async-gate.ts`
- `social/stickers.ts`
- `social/sticker-favorites.ts`
- `social/sticker-sources.ts`
- `social/pokes.ts`
- `social/presence.ts`
- `social/presence-owner.ts`
- `social/qzone.ts`
- `social/qzone-feed.ts`
- `social/qzone-feeds3.ts`
- `social/qzone-remote.ts`
- `social/qzone-strangers.ts`
- `social/account.ts`
- `social/quote-reply.ts`
- `social/external-drafts.ts`
- `social/external-platforms.ts`
- `social/official-adapter.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `biliStickers` | 表情包自己在 B 站找（顶替小黄脸） | [ADR 0132](../adr/0132-bili-stickers.md) |
| `readStickers` | 看懂他发的表情包（先抄图上的字、再说画面；要看图模型） | [ADR 0206](../adr/0206-read-his-stickers.md) |
| `foodPhotos` | 吃的照片（这一顿拍给他看） | [ADR 0128](../adr/0128-food-photos.md) |
| `photos` | 照片货架（网上找高清图） | [ADR 0109](../adr/0109-photo-shelf.md) |
| `aiPhotos` | AI 生活照草稿（人工审核后才可用） | [ADR 0240](../adr/0240-world-and-qq-ai-photo-requests.md) |
| `stickers` | 图片表情（模式）：第一阶段只处理男朋友档。先用「只收藏核对」观察描述；完成真图核对和 NapCat 真发预检后，再选「收藏并发送」。需要打开「看懂图片内容」，默认关。 | [ADR 0063](../adr/0063-image-stickers.md) |
| `media` | 听语音、看图 | [ADR 0052](../adr/0052-voice-and-images.md) |
| `pokes` | 被戳会回 | [ADR 0079](../adr/0079-poke.md) |
| `pokeBack` | 戳回去 | [ADR 0079](../adr/0079-poke.md) |
| `pokeOut` | 主动戳他 | [ADR 0087](../adr/0087-poke-out.md) |
| `recalls` | 看得到他撤回 | [ADR 0082](../adr/0082-recalls.md) |
| `readReceipts` | 已读回执 | [ADR 0083](../adr/0083-presence.md) |
| `reactions` | 表情回应 | [ADR 0083](../adr/0083-presence.md) |
| `onlineStatus` | 在线状态 | [ADR 0083](../adr/0083-presence.md) |
| `profileLikes` | 资料卡点赞 | [ADR 0083](../adr/0083-presence.md) |
| `signature` | 个性签名（模式）：隔 3–5 天换一条（节日当天是祝福，下雨天有雨天的；NapCat 的 set_self_longnick）。选「只写草稿」时草稿存在数据目录的 presence/drafts.md 里，不真改。默认关。 | [ADR 0083](../adr/0083-presence.md) |
| `qzone` | 说说（模式）：一周两三条，模仿「空友爱看」里常见的那种——随手一两句，有图就围着图写（图放在数据目录的 presence/photos/ 里，需要开「看懂图片内容」）。用最低隐私档的卡来写并过禁用词；选「只写草稿」时存在 presence/drafts.md 里，不真发。默认关。 | [ADR 0083](../adr/0083-presence.md) |
| `qzoneBrowse` | 自己翻空间动态（模式）：白天醒着时每两个多小时读一页 QQ 空间动态（「空友爱看」那种混着陌生人的流），摘成一行「你刚才翻空间看到…」进她的提示词，6 小时内她可以自己提起。选「只写草稿」只存 presence/drafts.md、不进提示词。NapCat 上读空间的动作名各版本不同，读不到就只记一行、不假装看到。默认关。 | [ADR 0142](../adr/0142-qq-account-control.md) |
| `qzonePeek` | 刷好友动态（看名单里好友发的说说）（模式）：用她自己的登录态（NapCat 的 get_cookies）读她自己的好友动态页，挑出名单里好友 3 天内新发的说说（不进对方空间、不留访客记录），10:00–22:00、每 4 小时最多一次；摘成一行带时间进提示词，6 小时内她可以自己提起。名单是下面「允许动作的好友」；读不到（登录态过期 / 断网 / 风控）6 小时后再试。默认关。 | [ADR 0145](../adr/0145-qzone-friends-feed.md) |
| `qzoneStrangers` | 刷陌生人的空间（学人怎么说话）（模式） | [ADR 0144](../adr/0144-qzone-strangers.md) |
| `groupChat` | 群聊（模式）：只在名单群里活动。off 关闭；read 只看只记、不说话；dryRun 只把草稿写入 groups/drafts.md、不发送；on 允许发言。她基本潜水，被叫到、有人损他或聊到熟悉话题时才考虑接话；普通回复每群每小时最多 6 条、每天最多 30 条。不主动进群，不接邀请。 | [ADR 0210](../adr/0210-group-chat.md) |
| `groupOwn` | 群里她也有自己（带着此刻进群，冷场、有事时自己冒一句）（模式） | [ADR 0341](../adr/0341-her-own-presence-in-groups.md) |
| `groupAgency` | 群自主（开口由她自己的动机决定，抽签退位）（模式） | [ADR 0343](../adr/0343-group-agency-from-shadow.md) |
| `typingStatus` | “正在输入…” | [ADR 0077](../adr/0077-typing-status.md) |
| `selfRecall` | 打错字撤回重发 | [ADR 0086](../adr/0086-self-recall.md) |
| `quoteReply` | 引用回复（他连发里的问题 / 补错字） | [ADR 0136](../adr/0136-quote-reply.md) |

## 看它有没有变好

周报「说话的样子」里的延迟、「表情和语气」

## 最相关的 ADR

[ADR 0063](../adr/0063-image-stickers.md)、[ADR 0075](../adr/0075-reply-rhythm.md)、[ADR 0077](../adr/0077-typing-status.md)、[ADR 0083](../adr/0083-presence.md)、[ADR 0105](../adr/0105-reply-lag-tail.md)、[ADR 0109](../adr/0109-photo-shelf.md)、[ADR 0136](../adr/0136-quote-reply.md)、[ADR 0142](../adr/0142-qq-account-control.md)、[ADR 0143](../adr/0143-qzone-peek.md)、[ADR 0144](../adr/0144-qzone-strangers.md)、[ADR 0173](../adr/0173-silence-reasons.md)、[ADR 0174](../adr/0174-soul-module-stop-the-bleeding.md)、[ADR 0209](../adr/0209-strangers.md)、[ADR 0210](../adr/0210-group-chat.md)、[ADR 0311](../adr/0311-external-action-stop-ownership.md)、[ADR 0347](../adr/0347-one-life-two-places.md)
