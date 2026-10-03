# packages/

本项目自有代码。按 [ADR 0002](../docs/adr/0002-standalone-runtime.md)，这里是**独立的 Node.js / TypeScript 服务与工具**，
不挂载进 SillyTavern，也不 import SillyTavern 的代码；**不直接改 `vendor/` 下的上游源码**。

包名避免叫 `runtime`，以免和根目录被忽略的 `runtime/` 数据目录混淆。

| 包 | 作用 | 状态 |
| --- | --- | --- |
| `bot/` | QQ 机器人服务：对接 NapCat（OneBot 11）、拼装提示词、调用模型、会话存储 | 计划中 |
| `character-tools/` | 角色资料工具：legacy TOML → SillyTavern 角色卡 / 世界书 JSON | 已建 |

## 开发

根目录是 npm workspace：

```powershell
npm install          # 安装所有包的依赖
npm test             # 各包的单元测试（node --test）
npm run typecheck    # 各包的类型检查（tsc，不产出文件）
```

源码直接由 Node（>= 24）运行 `.ts`（类型剥离），没有构建步骤。
因此只能用可擦除的 TypeScript 语法（`erasableSyntaxOnly`：不用 enum、namespace、参数属性），相对导入要写 `.ts` 扩展名。
