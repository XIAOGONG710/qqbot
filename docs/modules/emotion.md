# 模块：心境与安全

> 由 `packages/bot/src/platform/modules.ts` 清单生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她的心境（开心 / 难过 / 流泪）、小别扭和和好、危机最小规则、按联系人披露她是程序、反馈通道、作者写下的大事。心境、别扭、拒绝与反馈受下列配置控制；危机与身份披露底线不设关闭开关。

## 文件（`packages/bot/src/` 下）

- `emotion/affect.ts`
- `emotion/express.ts`
- `emotion/feelings.ts`
- `emotion/feeling-export.ts`
- `emotion/feeling-review.ts`
- `emotion/felt-then.ts`
- `emotion/moments.ts`
- `emotion/grievance.ts`
- `emotion/crisis.ts`
- `emotion/crisis-state.ts`
- `emotion/disclosure.ts`
- `emotion/feedback.ts`
- `emotion/feedback-digest.ts`
- `emotion/feedback-digest-cli.ts`

## 开关

| 配置 | 功能 | ADR |
| --- | --- | --- |
| `herNo` | 会拒绝 | [ADR 0103](../adr/0103-her-no.md) |
| `herFeelings` | 心境（开心 / 难过 / 流泪；桌面上的她读同一份；ownerPeek 开着时 /心境 看） | [ADR 0102](../adr/0102-feelings.md) |
| `grievance` | 小别扭 / 和好 | [ADR 0074](../adr/0074-small-grievance.md) |
| `feedbackCommands` | “假 / 像”反馈通道 | [ADR 0073](../adr/0073-feedback-channel.md) |

## 看它有没有变好

周报日志计数里的「心境」「会拒绝」；危机相关永远是最高优先级，没有“指标”，只有测试和 ADR 0068 的底线

## 最相关的 ADR

[ADR 0067](../adr/0067-disclosure-per-contact.md)、[ADR 0068](../adr/0068-crisis-response.md)、[ADR 0074](../adr/0074-small-grievance.md)、[ADR 0102](../adr/0102-feelings.md)、[ADR 0103](../adr/0103-her-no.md)、[ADR 0191](../adr/0191-crisis-concern-split.md)、[ADR 0192](../adr/0192-drop-strain-tier.md)、[ADR 0197](../adr/0197-feelings-shared-and-reviewed.md)、[ADR 0218](../adr/0218-memory-feelings.md)、[ADR 0073](../adr/0073-feedback-channel.md)、[ADR 0327](../adr/0327-moment-cli-safe-writes.md)、[ADR 0328](../adr/0328-emotion-evidence-and-recovery.md)
