# 模块：心境与安全

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她的心境（开心 / 难过 / 流泪）、小别扭和和好、危机最小规则、按联系人披露她是程序、反馈通道、作者写下的大事。

## 文件（`packages/bot/src/` 下）

- `emotion/affect.ts`
- `emotion/feelings.ts`
- `emotion/moments.ts`
- `emotion/grievance.ts`
- `emotion/crisis.ts`
- `emotion/crisis-state.ts`
- `emotion/disclosure.ts`
- `emotion/feedback.ts`
- `emotion/feedback-digest.ts`
- `emotion/feedback-digest-cli.ts`

## 开关

这个模块没有独立的开关（它是底线 / 基础设施，永远开着）。

## 看它有没有变好

周报日志计数里的「心境」「会拒绝」；危机相关永远是最高优先级，没有“指标”，只有测试和 ADR 0068 的底线

## 最相关的 ADR

[ADR 0067](../adr/0067-disclosure-per-contact.md)、[ADR 0068](../adr/0068-crisis-response.md)、[ADR 0074](../adr/0074-small-grievance.md)、[ADR 0102](../adr/0102-feelings.md)、[ADR 0103](../adr/0103-her-no.md)、[ADR 0191](../adr/0191-crisis-concern-split.md)
