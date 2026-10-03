# packages/

本项目自有代码。按 [ADR 0002](../docs/adr/0002-standalone-runtime.md)，这里是**独立的 Node.js / TypeScript 服务与工具**，
不挂载进 SillyTavern，也不 import SillyTavern 的代码；**不直接改 `vendor/` 下的上游源码**。

计划中的包（尚未创建，名称可在实现时调整；避免叫 `runtime`，以免和根目录被忽略的 `runtime/` 数据目录混淆）：

| 包 | 作用 |
| --- | --- |
| `bot/` | QQ 机器人服务：对接 NapCat（OneBot 11）、拼装提示词、调用模型、会话存储 |
| `character-tools/` | 角色资料工具：legacy TOML → SillyTavern 角色卡 / 世界书 JSON 等 |
