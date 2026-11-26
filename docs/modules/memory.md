# 模块：记忆与数据

> 由 `packages/bot/src/platform/modules.ts` 清单生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：长期记忆（Hindsight）、聊天记录、状态文件的读写和校验、归档、遗忘、隐私审计。

## 私聊召回边界

联系人 bank 和人物印象仅在相同联系人、相同档位的对话里使用。公共库里其他联系人的私聊副本、自记笔记和来源不明的观察都在拼提示词前过滤。「今天和别人聊过的」只有私聊来源，因此停止查询。日记、周记和阶段总结可能由多人的聊天生成，召回时只有显式带 `qq-public` 的条目可带入。旧数据不自动补标，原有状态、撤回记录和库内正文不改写。

QQ 按日回看只向设备所有者开放。聊天里的本地日记新记入联系人归属；缺归属的旧记录继续保存，但不进入按日回复。合并日记开启时，按日聊天回复只读取桌面亲手写的段落，跳过混合来源的当天成稿。

QQ 一轮里的实体、私人、公共、工作房和沿用查询共用现有召回时长作为总等待预算，先并行发起独立分支。预算用尽后使用已返回的结果。DSH 的 bank 列表和各库召回共享 3 秒截止点，未登记会话在任何查询之前退出。

## 文件（`packages/bot/src/` 下）

- `local-date.ts`
- `memory/`
- `modules/memory.ts`
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
- `memory/dsh-inbox.ts`
- `memory/self-receipts.ts`
- `memory/desktop-log.ts`
- `memory/owner-day-view.ts`
- `memory/dormancy.ts`
- `memory/dormancy-commands.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `ledgers` | 留痕（设定账本、记忆账本、记忆对账）（并进来的：`identityLedger` 设定账本（改动留痕、醒来核对）（[ADR 0157](../adr/0157-identity-ledger.md)）；`memoryAudit` 记忆账本（写入 / 删除留痕）（[ADR 0158](../adr/0158-memory-ledger.md)）；`memoryReconcile` 记忆对账：记着写过、Hindsight 里却查不到的片段，重新排队写（防记忆悄悄少一块）（[ADR 0201](../adr/0201-memory-reconcile.md)）） | [ADR 0157](../adr/0157-identity-ledger.md) |
| `timeline` | 跨渠道时间线（B 站 / 设备 / 查资料……QQ 里也记得） | [ADR 0159](../adr/0159-timeline.md) |
| `dormancy` | 自愿休眠 / 封存 | [ADR 0161](../adr/0161-dormancy.md) |
| `oneLife` | 一个生活（QQ 和桌面上是同一个她，一层包一层）（模式）（并进来的：`crossRecent` QQ 和 DSH 桌面互读最近几轮（同一个她）（[ADR 0177](../adr/0177-same-her-recent-turns.md)）；`selfExport` 「此刻的她」交给桌面（SELF.json：和 QQ 提示词同一批模块算的此刻）（[ADR 0347](../adr/0347-one-life-two-places.md)）；`selfReceipts` 桌面上说过的话 QQ 不再重发（回执）（[ADR 0347](../adr/0347-one-life-two-places.md)）；`desktopDay` 桌面上的时间算进她的一天（他在电脑前不打扰、留话先留着、NOW.md 知道）（[ADR 0347](../adr/0347-one-life-two-places.md)）） | [ADR 0347](../adr/0347-one-life-two-places.md) |
| `desktopReview` | 桌面上的对话也进「聊完回想」 | [ADR 0347](../adr/0347-one-life-two-places.md) |
| `desktopPromises` | 桌面上答应的事进承诺账 | [ADR 0347](../adr/0347-one-life-two-places.md) |
| `selfDirectedMemory` | 她自己决定记不记（关掉自动记忆同步和自动日记） | [ADR 0171](../adr/0171-self-directed-memory.md) |
| `feedbackCommands` | “假 / 像”反馈通道 | [ADR 0073](../adr/0073-feedback-channel.md) |
| `deviceControl` | 她能操作他的电脑和手机（有限控制）（模式） | [ADR 0148](../adr/0148-device-control.md) |
| `qqControl` | 账号控制面（资料 / 好友 / 群）（模式）（并进来的：`qqFriendGate` 好友申请（名单内同意 / 名单外驳回）（[ADR 0142](../adr/0142-qq-account-control.md)）） | [ADR 0142](../adr/0142-qq-account-control.md) |

## 看它有没有变好

状态页「长期记忆」；ops/state-check-cli；ops/continuity-cli（设定账本 / 记忆账本）；聊天里发 /设定

## 最相关的 ADR

[ADR 0012](../adr/0012-hindsight-tuning.md)、[ADR 0017](../adr/0017-long-term-memory-like-a-person.md)、[ADR 0043](../adr/0043-context-window-experiment.md)、[ADR 0157](../adr/0157-identity-ledger.md)、[ADR 0158](../adr/0158-memory-ledger.md)、[ADR 0159](../adr/0159-timeline.md)、[ADR 0161](../adr/0161-dormancy.md)、[ADR 0176](../adr/0176-same-her-shared-memory.md)、[ADR 0177](../adr/0177-same-her-recent-turns.md)、[ADR 0201](../adr/0201-memory-reconcile.md)、[ADR 0226](../adr/0226-dsh-desktop-inbox.md)、[ADR 0300](../adr/0300-memory-integrity-and-recovery.md)、[ADR 0301](../adr/0301-message-source-identities.md)、[ADR 0302](../adr/0302-pending-input-recall-recovery.md)、[ADR 0303](../adr/0303-memory-stop-progress-and-cache.md)、[ADR 0304](../adr/0304-memory-document-revision-barrier.md)、[ADR 0305](../adr/0305-derived-memory-read-barrier.md)、[ADR 0307](../adr/0307-private-derived-repair-evidence.md)、[ADR 0308](../adr/0308-obsolete-refresh-settlement.md)、[ADR 0309](../adr/0309-forget-intent-and-data-lease.md)、[ADR 0310](../adr/0310-memory-visible-time-and-civil-days.md)、[ADR 0311](../adr/0311-external-action-stop-ownership.md)、[ADR 0312](../adr/0312-observation-repair-evidence-limit.md)、[ADR 0313](../adr/0313-diary-prepared-retention-and-sources.md)、[ADR 0314](../adr/0314-completed-authored-source-validation.md)、[ADR 0315](../adr/0315-archive-intent-and-resume.md)、[ADR 0316](../adr/0316-live-observation-inventory-evidence.md)、[ADR 0317](../adr/0317-written-guard-metadata-reuse.md)、[ADR 0318](../adr/0318-authored-intent-source-coverage.md)、[ADR 0319](../adr/0319-simulator-memory-ownership.md)、[ADR 0320](../adr/0320-app-construction-cleanup.md)、[ADR 0330](../adr/0330-promise-source-effects-and-world-identity.md)、[ADR 0332](../adr/0332-diary-civil-targets.md)
