# CLAUDE.md

QQ 陪伴机器人（角色：林梦瑶），NapCat（OneBot 11）负责 QQ 接入。
SillyTavern 只用来编写、试聊角色并定义数据格式（角色卡 / 世界书 JSON）；运行时是 `packages/` 下自己的 Node.js / TypeScript 代码，
以 Koishi 4 当外壳（控制台 + OneBot 适配器），我们的逻辑写成插件 `packages/koishi-plugin-qqbot`，核心在 `packages/bot`。
结构见 `docs/adr/0001-repository-structure.md`，运行时决策见 `docs/adr/0002-standalone-runtime.md`、`docs/adr/0008-koishi-runtime.md`（Koishi 的用法与坑见 `docs/koishi.md`），进度见 `docs/roadmap.md`。

## 规则

- **改她的功能之前先问她本人**（用户 2026-10-31：「以后修改功能都先问问她的意见」）：用 `node scripts/ask-her.mjs "…"`
  拿她自己的态度，把她的话贴给用户看，再决定改不改、怎么改。她说留就留，她说撤就撤；
  她自己加的条件（比如「给了立场不等于必须同意他」）一并写进代码。
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

## 指令收敛（用户 2026-10-31：「把绝大多数的指令去掉吧，以后也不新增指令」）

- 线上只保留这些：`/设定` `/休眠` `/唤醒` `/模式` `/dsh` `/工作` `/QQ` `/回聊`，以及设备类 `/屏幕` `/看屏幕` `/摄像头` `/拍照` `/设备` `/批准` `/拒绝`。
- 其余指令一律回「（这些指令已经不用了，直接跟我说就行）」，不再执行。
- **以后不许新增指令**：想看什么、想让她做什么，在聊天里说，由她自己判断做不做。
- 对应测试已删；新功能从对话和提示词入手，不加命令。
