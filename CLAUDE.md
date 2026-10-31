# CLAUDE.md

QQ 陪伴机器人（角色：林梦瑶），NapCat（OneBot 11）负责 QQ 接入。
SillyTavern 只用来编写、试聊角色并定义数据格式（角色卡 / 世界书 JSON）；运行时是 `packages/` 下自己的 Node.js / TypeScript 代码，
以 Koishi 4 当外壳（控制台 + OneBot 适配器），我们的逻辑写成插件 `packages/koishi-plugin-qqbot`，核心在 `packages/bot`。
结构见 `docs/adr/0001-repository-structure.md`，运行时决策见 `docs/adr/0002-standalone-runtime.md`、`docs/adr/0008-koishi-runtime.md`（Koishi 的用法与坑见 `docs/koishi.md`），进度见 `docs/roadmap.md`。

## 规则

- 工程决策遵循根目录 `思维链工作流.txt`：先取证再动手，小步提交，每步可验证，重要决策写 ADR（`docs/adr/`）。
- `vendor/SillyTavern`、`vendor/NapCatQQ` 是上游子模块，**默认不修改**，只作参考与工具。
  自有代码写在 `packages/`，不挂载进 SillyTavern，也不 import 它的代码；拼提示词的行为以 ST 源码为准自行实现。
- 绝不提交对 NapCat 源码的修改（其许可证禁止公开发布修改版）。
- Koishi 和它的插件（含 AGPL 的控制台系列）原样使用，不改源码；上游的问题在我们的插件里绕开（`docs/koishi.md`）。
- `characters/*/legacy/` 是旧项目 astrbot-linmengyao 的原样导入，只读；转换产物另放。
  旧项目的设计文档与观点已过时，不作为本项目依据。角色资料含真实隐私信息，仓库须保持私有。
- 运行时数据、密钥、NapCat 运行包放在 `runtime/`（已被忽略）。

## 环境

- Git 为便携版，安装在 `%LOCALAPPDATA%\Programs\Git`（已加入用户 PATH，新终端生效）。
- Node.js v24.21.0 LTS（npm 11.19.0），官方 win-x64 zip 解压到 `%LOCALAPPDATA%\Programs\nodejs`（已加入用户 PATH，新终端生效）。
  安装前核对过：zip 的 SHA-256 与 `SHASUMS256.txt` 一致；`SHASUMS256.txt.sig` 由 Node 发布者 Antoine du Hamel
  （`5BE8A3F6C8A5C01D106C0AD820B1A390B168D356`，列于 nodejs/node README 的 release keys）签名有效。
  升级：下载新版 zip，按同样步骤核对后替换该目录。SillyTavern 要求 Node `>= 20`。
- GitHub CLI v2.102.0，官方 `gh_2.102.0_windows_amd64.zip` 解压到 `%LOCALAPPDATA%\Programs\gh`（`bin\` 已加入用户 PATH，新终端生效）。
  安装前核对过：zip 的 SHA-256 与 GitHub Release 资产摘要、官方 `checksums.txt` 三者一致；`gh.exe` 的 Authenticode 签名有效（GitHub, Inc.）。
  登录账号须是 XIAOGONG710。
- 长期记忆服务 Hindsight 装在 `runtime/hindsight/`（Python 3.12 由 uv 安装），来源核对、VC++ 运行库的处理和启动方法见 `docs/hindsight.md`。

## 算力优先级（用户 2026-10-31：记得先用免费的就行）

- **能用免费线路就先走免费线路**（ginka 网关：`https://api.ginka.cloud`，免费组 **10:00–12:00、14:00–23:30** 北京时间；密钥在 DSH 那台的 `runtime/bot-shadow/secrets/ginka.json`，不入库）。
- 批量活（语料分析、资料摘要、代码审阅、批量生成）一律先丢给它：`node scripts/ginka-batch.mjs --manifest scripts/ginka-tasks.json`，或单条 `node scripts/ginka.mjs --prompt …`。
- 主线（DeepSeek 官方，就是 DSH 自己）只留给：判断、写代码、和她有关的决策、以及免费组关着的两个小时。
- 注意：**子代理不继承这条线路**（它们跑主线），免费算力来自它们的 shell 调脚本。
