# 模块：外部世界：小红书、抖音

> 由 `packages/bot/src/modules.ts` 生成（`node packages/bot/src/ops/modules-doc.ts`），不要手改；改清单后重新生成。

**管什么**：她的小红书 / 抖音专号：开真浏览器让网页自己发请求，我们只读它收到的内容（不仿造签名）；刷首页、搜、点开读正文和热评、截帧、扫码登录、风控熔断、导航预算。还没有开关、没有接进机器人。

## 文件（`packages/bot/src/` 下）

- `browser-cdp.ts`
- `social.ts`
- `social-xhs.ts`
- `social-douyin.ts`
- `social-login.ts`
- `social-session.ts`

## 开关

这个模块没有独立的开关（它是底线 / 基础设施，永远开着）。

## 看它有没有变好

npm run social -w @qqbot/bot -- status / probe；npm run platform -w @qqbot/bot -- status（熔断）

## 最相关的 ADR

[ADR 0147](../adr/0147-platform-accounts.md)、[ADR 0166](../adr/0166-xhs-douyin-accounts.md)
