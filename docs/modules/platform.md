# 模块：接入、配置与运维

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：Koishi / NapCat 接入、配置、启动与锁、心跳、日志、网络兜底、设备控制（电脑 / 手机，ADR 0148）、功能总表、周报、一致性检查、模块总表、模拟器。

## 文件（`packages/bot/src/` 下）

- `platform/app.ts`
- `platform/main.ts`
- `platform/work-bridge.ts`
- `platform/instruction-source.ts`
- `platform/work-mode.ts`
- `platform/soul-rating.ts`
- `platform/resident-guard.ts`
- `platform/contact.ts`
- `platform/config.ts`
- `platform/features.ts`
- `platform/modules.ts`
- `platform/modules-doc.ts`
- `platform/weekly-report.ts`
- `platform/consistency.ts`
- `platform/onebot.ts`
- `platform/lock.ts`
- `platform/log.ts`
- `platform/heartbeat.ts`
- `platform/runtime-info.ts`
- `platform/dns-fallback.ts`
- `platform/qr.ts`
- `platform/device-actions.ts`
- `platform/device-hub.ts`
- `platform/device-phone.ts`
- `platform/device-service.ts`
- `platform/sensitive.ts`
- `platform/web.ts`
- `platform/consent.ts`
- `platform/private-space.ts`
- `platform/wechat-id.ts`
- `platform/shell-tool.ts`
- `platform/wechat-bridge.ts`
- `dsh-link.ts`
- `dsh-continuity.ts`
- `dsh-state-export.ts`
- `mobile-companion-dsh.ts`
- `ops/`
- `sim/`
- `vendor/`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `webLookup` | 搜索 / 读网页（模式） | [ADR 0160](../adr/0160-web-lookup.md) |
| `weeklyReport` | 周报 | [ADR 0118](../adr/0118-weekly-report.md) |
| `dsh` | 外部顾问（按需咨询） | [ADR 0223](../adr/0223-dsh-bridge.md) |

## 看它有没有变好

控制台「状态」页（ADR 0120）；ops/golive-check-cli；ops/heartbeat-watch-cli；ops/history-migrate-cli（一次性迁移，ADR 0199）

## 最相关的 ADR

[ADR 0002](../adr/0002-standalone-runtime.md)、[ADR 0008](../adr/0008-koishi-runtime.md)、[ADR 0118](../adr/0118-weekly-report.md)、[ADR 0119](../adr/0119-consistency-check.md)、[ADR 0120](../adr/0120-status-dashboard.md)、[ADR 0160](../adr/0160-web-lookup.md)、[ADR 0172](../adr/0172-work-mode-full-access.md)、[ADR 0174](../adr/0174-soul-module-stop-the-bleeding.md)、[ADR 0175](../adr/0175-bare-arm-framework-test.md)、[ADR 0179](../adr/0179-instruction-source.md)、[ADR 0190](../adr/0190-learn-from-real-chat.md)、[ADR 0199](../adr/0199-history-migration.md)、[ADR 0200](../adr/0200-private-space.md)
