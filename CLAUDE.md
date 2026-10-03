# CLAUDE.md

QQ 陪伴机器人（角色：林梦瑶），NapCat（OneBot 11）负责 QQ 接入。
SillyTavern 只用来编写、试聊角色并定义数据格式（角色卡 / 世界书 JSON）；运行时是 `packages/` 下独立的 Node.js / TypeScript 服务。
结构见 `docs/adr/0001-repository-structure.md`，运行时决策见 `docs/adr/0002-standalone-runtime.md`，进度见 `docs/roadmap.md`。

## 规则

- 工程决策遵循根目录 `思维链工作流.txt`：先取证再动手，小步提交，每步可验证，重要决策写 ADR（`docs/adr/`）。
- `vendor/SillyTavern`、`vendor/NapCatQQ` 是上游子模块，**默认不修改**，只作参考与工具。
  自有代码写在 `packages/`，不挂载进 SillyTavern，也不 import 它的代码；拼提示词的行为以 ST 源码为准自行实现。
- 绝不提交对 NapCat 源码的修改（其许可证禁止公开发布修改版）。
- `characters/*/legacy/` 是旧项目 astrbot-linmengyao 的原样导入，只读；转换产物另放。
  旧项目的设计文档与观点已过时，不作为本项目依据。角色资料含真实隐私信息，仓库须保持私有。
- 运行时数据、密钥、NapCat 运行包放在 `runtime/`（已被忽略）。

## 环境

- Git 为便携版，安装在 `%LOCALAPPDATA%\Programs\Git`（已加入用户 PATH，新终端生效）。
- 本机尚未安装 Node.js；SillyTavern 要求 Node `>= 20`。
