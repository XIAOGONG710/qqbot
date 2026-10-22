# 模块：接入、配置与运维

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：Koishi / NapCat 接入、配置、启动与锁、心跳、日志、网络兜底、功能总表、周报、一致性检查、模块总表、模拟器。

## 文件（`packages/bot/src/` 下）

- `app.ts`
- `main.ts`
- `contact.ts`
- `config.ts`
- `features.ts`
- `modules.ts`
- `modules-doc.ts`
- `weekly-report.ts`
- `consistency.ts`
- `onebot.ts`
- `lock.ts`
- `log.ts`
- `heartbeat.ts`
- `runtime-info.ts`
- `dns-fallback.ts`
- `qr.ts`
- `sensitive.ts`
- `ops/`
- `sim/`
- `vendor/`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `weeklyReport` | 周报 | [ADR 0118](../adr/0118-weekly-report.md) |

## 看它有没有变好

控制台「状态」页（ADR 0120）；ops/golive-check-cli；ops/heartbeat-watch-cli

## 最相关的 ADR

[ADR 0002](../adr/0002-standalone-runtime.md)、[ADR 0008](../adr/0008-koishi-runtime.md)、[ADR 0118](../adr/0118-weekly-report.md)、[ADR 0119](../adr/0119-consistency-check.md)、[ADR 0120](../adr/0120-status-dashboard.md)
