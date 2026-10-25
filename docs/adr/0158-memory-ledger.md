# ADR 0158：记忆修改有留痕（memoryAudit）

- 状态：**已实现，默认关，未上线**（分支 `claude/continuity`；开关 `memoryAudit`）
- 日期：2026-10-26
- 关联：[ADR 0157](0157-identity-ledger.md)（同一种哈希链账本）、[ADR 0012](0012-hindsight-tuning.md)（长期记忆）、`privacy-forget.ts`（忘掉某个联系人）
- 用户提出：2026-10-25「记忆修改有留痕」（来自清单：「真实记忆保障：尤其发生矛盾时，不擅自删除、伪造共同经历；重要事件如实记录，纠错也留痕」）

## 做法

长期记忆（Hindsight）的所有写入都经过 `HindsightApi.retain`。`memory-audit.ts` 把这个接口包一层（`auditedApi`）：

- **写入成功之后**在哈希链账本（`runtime/bot/identity/memory.jsonl`）里记一行 `retain`：哪个库、哪篇文档、内容发生的时间、标签、**字数和内容哈希前 16 位——不记原文**（账本不能变成第二份记忆）。写入本身失败不留痕（没写进去），错误照样抛给调用方；账本写不进去（磁盘满）不影响写入，只记日志。
- 建 / 改印象模型（`createMentalModel / updateMentalModel`）记 `model-create / model-update`。
- **忘掉某个联系人**（`privacy-forget` 的 `--apply`）把结果记成 `forget`：删了哪些库、多少文档、多少印象模型、本地文件挪去了哪里，联系人只留哈希。
- 用户手写的纠错 / 补记说明记成 `note`：`npm run continuity -w @qqbot/bot -- memory note "<说明>"`。
- 看：`continuity memory summary | verify | tail [N]`，聊天里 `/设定` 也带一行摘要。启动时验一次，验不过就发用户一行提示。

## 能说明什么 / 不能说明什么

- 能：之后任何时候都能对出「这一条是不是真的写进去过、内容哈希是不是这个」；账本验得过，说明记录没被悄悄改。
- **不能**：Hindsight 的数据库如果被人直接改了（不经过 bot），这里看不到——它没有「列出所有文档」的接口，没法逐条对账。所以这是「bot 的每一次记忆写入都留痕」，不是「数据库的完整审计」。

## 测试

`memory-audit.test`：写入留痕且账本里没有原文；写入失败不留痕、错误照抛；包装不影响用到私有字段的方法；账本写不进去不影响写入；forget / note / 摘要。

## 上线

合并 + `memoryAudit: true` + 重启；回退 = 删掉那一行。
