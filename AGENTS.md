# AGENTS.md

QQ 陪伴机器人（角色：林梦瑶），NapCat（OneBot 11）负责 QQ 接入。
SillyTavern 只用来编写、试聊角色并定义数据格式（角色卡 / 世界书 JSON）；运行时是 `packages/` 下自己的 Node.js / TypeScript 代码，
以 Koishi 4 当外壳（控制台 + OneBot 适配器），我们的逻辑写成插件 `packages/koishi-plugin-qqbot`，核心在 `packages/bot`。
结构见 `docs/adr/0001-repository-structure.md`，运行时决策见 `docs/adr/0002-standalone-runtime.md`、`docs/adr/0008-koishi-runtime.md`（Koishi 的用法与坑见 `docs/koishi.md`），进度见 `docs/roadmap.md`。

## 规则

- 用户要求：每项任务完成并通过适用检查后，进行一次本地 Git 提交；只提交该任务的改动，不夹带无关文件，不自动推送。
- 用户要求：没有特殊说明时尽量不开子代理，由主代理自己完成审查、复现和开发；用户明确要求时才用子代理，届时明确文件所有权，避免并发修改同一文件，由主代理统一整合、验证和提交。
- 工程决策遵循根目录 `思维链工作流.txt`：先取证再动手，小步提交，每步可验证，重要决策写 ADR（`docs/adr/`）。
- `vendor/SillyTavern`、`vendor/NapCatQQ` 是上游子模块，**默认不修改**，只作参考与工具。
  自有代码写在 `packages/`，不挂载进 SillyTavern，也不 import 它的代码；拼提示词的行为以 ST 源码为准自行实现。
- 绝不提交对 NapCat 源码的修改（其许可证禁止公开发布修改版）。
- Koishi 和它的插件（含 AGPL 的控制台系列）原样使用，不改源码；上游的问题在我们的插件里绕开（`docs/koishi.md`）。
- `characters/*/legacy/` 是旧项目 astrbot-linmengyao 的原样导入，只读；转换产物另放。
  旧项目的设计文档与观点已过时，不作为本项目依据。角色资料含真实隐私信息，仓库须保持私有。
- 运行时数据、密钥、NapCat 运行包放在 `runtime/`（已被忽略）。
- 测试只用合成角色（`packages/bot/test/fixtures/synthetic-character/`，ADR 0260），不读真实角色资料；`npm test` 可随时全量跑。
  校验真实资料本身的测试在 `packages/character-tools/test-real/`，改了转换器或真实 `source/` 后在本机跑 `npm run test:real`，失败时只看断言行。
- 架构迁移（ADR 0263）期间，行为基线 `packages/bot/test/baseline/snapshots/` 必须逐字不变；不要为了让测试通过而 `UPDATE_BASELINE=1`。
  只有有意改变行为的单独提交才更新快照，并在提交说明里写清哪里变了、为什么。

## 环境

- Git 为便携版，安装在 `%LOCALAPPDATA%\Programs\Git`（已加入用户 PATH，新终端生效）。
- Node.js v24.22.0 LTS（npm 12.2.1），官方 MSI 安装到 `C:\Program Files\nodejs`（2026-10-18 安装，PATH 中实际解析到这份）。
  核对情况：`node.exe` 的 Authenticode 签名有效（OpenJS Foundation）；安装包的 SHA-256 与 `SHASUMS256.txt` 及其签名**未核对**。
  此前记录的 zip 版 v24.21.0（`%LOCALAPPDATA%\Programs\nodejs`）在 Claude 应用内不可见，是否仍存在未确认。
  升级：下载官方安装包，先核对 SHA-256 与 `SHASUMS256.txt` 一致、`SHASUMS256.txt.sig` 由 nodejs/node README 所列 release key 签名有效，再安装。
  SillyTavern 要求 Node `>= 20`。
- GitHub CLI v2.103.3，官方 `gh_2.103.3_windows_amd64.zip` 解压到 `%LOCALAPPDATA%\Programs\gh`（`bin\` 已加入用户 PATH，新终端生效）。
  安装前核对过：zip 的 SHA-256（`98d0cfa7…0a22e0`）与 GitHub Release 资产摘要、官方 `checksums.txt` 三者一致；`gh.exe` 的 Authenticode 签名有效（GitHub, Inc.）。
  登录账号须是 XIAOGONG710（令牌存于 Windows 凭据管理器）。
  注意：从 Claude / Codex 桌面应用里的命令写到 `AppData` 下的文件和用户 PATH 会被应用隔离，在普通终端里看不到；
  装到 `AppData` 下的工具要在用户自己的终端里装（例如在终端面板运行安装脚本）。
- 长期记忆服务 Hindsight 装在 `runtime/hindsight/`（Python 3.12 由 uv 安装），来源核对、VC++ 运行库的处理和启动方法见 `docs/hindsight.md`。
