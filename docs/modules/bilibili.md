# 模块：外部世界：B 站

> 由 `packages/bot/src/platform/modules.ts` 清单生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她的 B 站号：搜视频读字幕、私信、回复评论、话题评论、风险监控。

## 文件（`packages/bot/src/` 下）

- `bilibili/bilibili.ts`
- `bilibili/bilibili-view.ts`
- `bilibili/bilibili-summary.ts`
- `bilibili/bilibili-stats.ts`
- `bilibili/bilibili-inbox.ts`
- `bilibili/bilibili-asr.ts`
- `bilibili/bilibili-schema.ts`
- `bilibili/bilibili-wbi.ts`
- `bilibili/bilibili-feed.ts`
- `bilibili/feed-browsing.ts`
- `bilibili/bilibili-limit.ts`
- `bilibili/bilibili-account-source.ts`
- `bilibili/bilibili-account.ts`
- `bilibili/platform-breaker.ts`
- `bilibili/bilibili-comment.ts`
- `bilibili/bilibili-login-cli.ts`
- `bilibili/bilibili-login.ts`
- `bilibili/bilibili-probe.ts`
- `bilibili/bilibili-replies.ts`
- `bilibili/bilibili-risk.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `watching` | 自己在 B 站看东西、有看法 | [ADR 0130](../adr/0130-watching.md) |
| `bilibili` | 刷 B 站发给他（模式）：从 B 站热门榜按口味挑视频，读过热评后，把感受和原链接发给男朋友档的人。一周最多 3 个，工作日晚上或周末下午到晚上才考虑发；睡着、上课或正聊着时不发。只读 B 站公开接口，不登录，也不在 B 站发内容。试运行只写草稿到 presence/drafts.md，默认关。 | [ADR 0084](../adr/0084-bilibili-browsing.md) |
| `bilibiliAccount` | 她自己的 B 站账号 | [ADR 0089](../adr/0089-bilibili-account.md) |
| `biliFeed` | 自己刷 B 站推荐（记下刷到的）（模式）：14 点后一天一次，取一页推荐，按口味决定停留还是划走，只记刷到的标题和停留秒数；不播放、不点赞、不评论。试运行只写草稿到 presence/drafts.md，默认关。 | [ADR 0168](../adr/0168-bili-parity.md) |
| `bilibiliDm` | B 站私信（模式） | [ADR 0089](../adr/0089-bilibili-account.md) |
| `bilibiliReplies` | 回复 B 站评论（模式） | [ADR 0090](../adr/0090-bilibili-replies.md) |
| `bilibiliComment` | 话题评论（模式） | [ADR 0092](../adr/0092-bilibili-topic-comments.md) |

## 看它有没有变好

日志里的 B 站风险监控；presence/drafts.md

## 最相关的 ADR

[ADR 0084](../adr/0084-bilibili-browsing.md)、[ADR 0089](../adr/0089-bilibili-account.md)、[ADR 0090](../adr/0090-bilibili-replies.md)、[ADR 0092](../adr/0092-bilibili-topic-comments.md)、[ADR 0168](../adr/0168-bili-parity.md)、[ADR 0311](../adr/0311-external-action-stop-ownership.md)
