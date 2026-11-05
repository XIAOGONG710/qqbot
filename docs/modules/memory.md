# 模块：记忆与数据

> 由 `packages/bot/src/platform/modules.ts` 清单生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：长期记忆（Hindsight）、聊天记录、状态文件的读写和校验、归档、遗忘、隐私审计。

## 文件（`packages/bot/src/` 下）

- `memory/`
- `memory/history.ts`
- `memory/archive.ts`
- `memory/backfill.ts`
- `memory/state-schema.ts`
- `memory/tier-record.ts`
- `memory/json-file.ts`
- `memory/transient-io.ts`
- `memory/privacy-audit.ts`
- `memory/privacy-forget.ts`
- `memory/ledger.ts`
- `memory/identity.ts`
- `memory/memory-audit.ts`
- `memory/timeline.ts`
- `memory/dormancy.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `identityLedger` | 设定账本（改动留痕、醒来核对） | [ADR 0157](../adr/0157-identity-ledger.md) |
| `memoryAudit` | 记忆账本（写入 / 删除留痕） | [ADR 0158](../adr/0158-memory-ledger.md) |
| `timeline` | 跨渠道时间线（B 站 / 设备 / 查资料……QQ 里也记得） | [ADR 0159](../adr/0159-timeline.md) |
| `dormancy` | 自愿休眠 / 封存 | [ADR 0161](../adr/0161-dormancy.md) |
| `unlistedFriends` | 名单外的好友也回 |  |
| `feedbackCommands` | “假 / 像”反馈通道 | [ADR 0073](../adr/0073-feedback-channel.md) |
| `deviceControl` | 她能操作他的电脑和手机（有限控制）（模式） | [ADR 0148](../adr/0148-device-control.md) |
| `qqControl` | 账号控制面（资料 / 好友 / 群）（模式） | [ADR 0142](../adr/0142-qq-account-control.md) |
| `qqFriendGate` | 好友申请（名单内同意 / 名单外驳回）（模式） | [ADR 0142](../adr/0142-qq-account-control.md) |

## 看它有没有变好

状态页「长期记忆」；ops/state-check-cli；ops/continuity-cli（设定账本 / 记忆账本）；聊天里发 /设定

## 最相关的 ADR

[ADR 0012](../adr/0012-hindsight-tuning.md)、[ADR 0017](../adr/0017-long-term-memory-like-a-person.md)、[ADR 0043](../adr/0043-context-window-experiment.md)、[ADR 0157](../adr/0157-identity-ledger.md)、[ADR 0158](../adr/0158-memory-ledger.md)、[ADR 0159](../adr/0159-timeline.md)、[ADR 0161](../adr/0161-dormancy.md)、[ADR 0237](../adr/0237-memory-integrity-and-recovery.md)、[ADR 0238](../adr/0238-message-source-identities.md)、[ADR 0239](../adr/0239-pending-input-recall-recovery.md)、[ADR 0240](../adr/0240-memory-stop-progress-and-cache.md)
