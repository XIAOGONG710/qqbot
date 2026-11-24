# 模块：外部世界：B 站

> 由 `packages/bot/src/platform/modules.ts` 清单生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她的 B 站号：搜视频读字幕、私信、回复评论、话题评论、风险监控。

## 文件（`packages/bot/src/` 下）

- `bilibili/bilibili.ts`
- `bilibili/bilibili-view.ts`
- `bilibili/bilibili-summary.ts`
- `bilibili/bilibili-stats.ts`
- `bilibili/bilibili-wbi.ts`
- `bilibili/bilibili-feed.ts`
- `bilibili/feed-browsing.ts`
- `bilibili/bilibili-account-source.ts`
- `bilibili/bilibili-account.ts`
- `bilibili/platform-breaker.ts`
- `bilibili/bilibili-comment.ts`
- `bilibili/bilibili-login-cli.ts`
- `bilibili/bilibili-login.ts`
- `bilibili/bilibili-probe.ts`
- `bilibili/bilibili-replies.ts`
- `bilibili/bilibili-risk.ts`
- `bilibili/owners.ts`
- `bilibili/passive-jobs.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `watching` | 自己在 B 站看东西、有看法 | [ADR 0130](../adr/0130-watching.md) |
| `bilibili` | 刷 B 站发给他（模式）：从 B 站热门榜按口味挑视频，读过热评后，把感受和原链接发给男朋友档的人。一周最多 3 个，工作日晚上或周末下午到晚上才考虑发；睡着、上课或正聊着时不发。只读 B 站公开接口，不登录，也不在 B 站发内容。试运行只写草稿到 presence/drafts.md，默认关。 | [ADR 0084](../adr/0084-bilibili-browsing.md) |
| `bilibiliAccount` | 她自己的 B 站账号 | [ADR 0089](../adr/0089-bilibili-account.md) |
| `biliFeed` | 自己刷 B 站推荐（记下刷到的）（模式）：14 点后一天一次，取一页推荐，按口味决定停留还是划走，只记刷到的标题和停留秒数；不播放、不点赞、不评论。试运行只写草稿到 presence/drafts.md，默认关。 | [ADR 0168](../adr/0168-bili-parity.md) |
| `bilibiliDm` | B 站私信（模式）：她刷到视频后，把链接加一两句话私信到他的 B 站（用下面的 uid），QQ 上只说一句叫他去看私信，不再在 QQ 上发链接。私信里的话和聊天一样用男朋友档的卡写。他要先关注她的号，不然 B 站会限制或拒绝；私信发不出去就退回在 QQ 上直接发链接，连着失败 2 次到重启前不再试私信。要「她的 B 站号」开着。选「只写草稿」时私信和 QQ 提醒都存在 presence/drafts.md。默认关。 | [ADR 0089](../adr/0089-bilibili-account.md) |
| `bilibiliReplies` | 回复 B 站评论（模式）：别人回在她评论下面的话，每 10 分钟看一次；先回他（下面的 uid），其次挑有价值的回，一天最多 5 条（他的不算）、同一个人一天最多 2 条、两条之间隔几分钟，睡着、上课时不回。问她是不是 AI / 真人的、骂人的、广告、带链接的、想改她设定的一律不回；回的话和评论一样用最低隐私档的卡写、一句。有价值的回复另存一份真人语料（不含昵称和 uid）。要「她的 B 站号」和下面的 uid。选「只写草稿」时存在 presence/drafts.md。默认关。 | [ADR 0090](../adr/0090-bilibili-replies.md) |
| `bilibiliComment` | 话题评论（模式）：每次分享后在那个视频下发一条公开评论、真 @ 他的 B 站号（一周最多 3 条，隔至少一天）；2 分钟和 20 分钟后去公开的最新评论里复核，两次都找不到（新号评论常被拦去审核，@ 的通知也不会推）就停一周；发失败停 24 小时，连续 3 次停到重启。评论是公开的，用最低隐私档的卡写、过禁用词，不提男朋友恋爱。要「她的 B 站号」、下面的昵称和 uid 都配好。分享是试运行时评论也只写草稿。选「只写草稿」时存在 presence/drafts.md。默认关。 | [ADR 0092](../adr/0092-bilibili-topic-comments.md) |

## 看它有没有变好

日志里的 B 站风险监控；presence/drafts.md

## 最相关的 ADR

[ADR 0084](../adr/0084-bilibili-browsing.md)、[ADR 0089](../adr/0089-bilibili-account.md)、[ADR 0090](../adr/0090-bilibili-replies.md)、[ADR 0092](../adr/0092-bilibili-topic-comments.md)、[ADR 0168](../adr/0168-bili-parity.md)、[ADR 0311](../adr/0311-external-action-stop-ownership.md)
