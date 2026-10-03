# CLAUDE.md

基于 SillyTavern 的 QQ 机器人，NapCat（OneBot 11）负责 QQ 接入。结构与理由见 `docs/adr/0001-repository-structure.md`。

## 规则

- 工程决策遵循根目录 `思维链工作流.txt`：先取证再动手，小步提交，每步可验证，重要决策写 ADR（`docs/adr/`）。
- `vendor/SillyTavern`、`vendor/NapCatQQ` 是上游子模块，**默认不修改**。自有代码写在 `packages/`，
  通过 ST 的服务端插件（`plugins/`）或前端扩展（`public/scripts/extensions/third-party/`）机制挂载。
- 绝不提交对 NapCat 源码的修改（其许可证禁止公开发布修改版）。
- `characters/*/legacy/` 是旧项目 astrbot-linmengyao 的原样导入，只读；转换产物另放。
  旧项目的设计文档与观点已过时，不作为本项目依据。角色资料含真实隐私信息，仓库须保持私有。
- 运行时数据、密钥、NapCat 运行包放在 `runtime/`（已被忽略）。

## 环境

- Git 为便携版，安装在 `%LOCALAPPDATA%\Programs\Git`（已加入用户 PATH，新终端生效）。
- 本机尚未安装 Node.js；SillyTavern 要求 Node `>= 20`。
