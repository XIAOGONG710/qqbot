# 模块：记忆与数据

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：长期记忆（Hindsight）、聊天记录、状态文件的读写和校验、归档、遗忘、隐私审计。

## 文件（`packages/bot/src/` 下）

- `memory/`
- `history.ts`
- `archive.ts`
- `backfill.ts`
- `state-schema.ts`
- `tier-record.ts`
- `json-file.ts`
- `transient-io.ts`
- `privacy-audit.ts`
- `privacy-forget.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `unlistedFriends` | 名单外的好友也回 |  |
| `feedbackCommands` | “假 / 像”反馈通道 | [ADR 0073](../adr/0073-feedback-channel.md) |
| `qqControl` | 账号控制面（资料 / 好友 / 群）（模式） | [ADR 0142](../adr/0142-qq-account-control.md) |
| `qqFriendGate` | 好友申请（名单内同意 / 名单外驳回）（模式） | [ADR 0142](../adr/0142-qq-account-control.md) |

## 看它有没有变好

状态页「长期记忆」；ops/state-check-cli

## 最相关的 ADR

[ADR 0012](../adr/0012-hindsight-tuning.md)、[ADR 0017](../adr/0017-long-term-memory-like-a-person.md)、[ADR 0043](../adr/0043-context-window-experiment.md)
