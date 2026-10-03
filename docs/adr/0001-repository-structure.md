# ADR 0001：仓库结构——上游以子模块引入，自有代码独立存放

- 状态：已采纳；决策第 2 条中“通过 ST 插件 / 扩展挂载”已被 [ADR 0002](0002-standalone-runtime.md) 取代
- 日期：2026-10-03

## 背景

项目目标是基于 SillyTavern（下称 ST）开发 QQ 机器人，QQ 端通过 NapCat（OneBot 11 协议实现）接入。
需要同时获取两个上游仓库的源码，并且要能长期跟进上游更新，不被自身改动卡住。

已核实的事实（2026-10-03）：

| 项 | SillyTavern | NapCatQQ |
| --- | --- | --- |
| 上游 | `SillyTavern/SillyTavern` | `NapNeko/NapCatQQ` |
| 跟踪分支 | `release`（上游默认，稳定版） | `main`（上游默认） |
| 当前锁定 | `06bde939f`（1.19.0 之后 1 个提交） | `26d7533e`（v4.18.28 之后 4 个提交） |
| 许可证 | AGPL-3.0 | Limited Redistribution License for NapCat |
| 运行要求 | Node `>= 20`（`package.json` engines） | pnpm monorepo（`pnpm-workspace.yaml`） |

ST 提供两个官方扩展点，都在 ST 自己的 `.gitignore` 里：

- 服务端插件：`plugins/<name>/`，由 `src/plugin-loader.js` 加载，需 `enableServerPlugins: true`。
  加载时用 `fs.statSync(...).isDirectory()`，会跟随目录联接。
  插件自动更新只处理“自身就是 git 仓库根”的目录（`CheckRepoActions.IS_REPO_ROOT`），
  因此链接进去的本仓库子目录不会被它执行 `git pull`。
- 前端扩展：`public/scripts/extensions/third-party/<name>/`。

## 决策

```
qqbot/                 本仓库（自有代码 + 文档）
├── vendor/
│   ├── SillyTavern/   git submodule，跟踪 release
│   └── NapCatQQ/      git submodule，跟踪 main，仅作参考 / 调试源码
├── packages/          自有代码（ST 服务端插件、前端扩展等）
├── docs/              架构、ADR
└── runtime/           本地运行数据（不入库）
```

1. 两个上游都以 **git submodule** 形式引入，锁定到具体提交，升级要显式提交一次指针变更。
2. 自有代码放在 `packages/`，用 ST 的插件 / 扩展机制接入，通过目录联接挂载到 ST 中。
   **默认不修改 `vendor/` 下的任何文件。**
   （已被 ADR 0002 取代：`packages/` 改为独立服务，不再挂载进 ST；“不修改 `vendor/`”仍然有效。）
3. NapCat 运行时使用官方 Release 构建产物（放在 `runtime/`），子模块里的源码只用于查阅协议实现和调试。

## 备选方案

| 方案 | 不选的原因 |
| --- | --- |
| Fork ST 作为主仓库，自有代码直接写进 ST 源码树 | 自有代码和上游代码混在一起，每次合并上游都可能冲突；ST 更新很频繁 |
| 把上游源码直接拷进本仓库 | 丢失上游历史，无法用 git 升级，仓库体积大 |
| 不入库，只写脚本按需克隆 | 版本无法随提交锁定，难以复现“某个提交时的完整环境” |

## 后果

- 克隆本仓库需要 `git clone --recurse-submodules`，或事后执行 `git submodule update --init`。
- 升级上游 = 在子模块里切换提交 + 在本仓库提交新指针，可回滚（回退该提交即可）。
- 子模块里的本地修改无处推送：上游仓库我们没有写权限。

## 重新评估条件（何时改变本决策）

当出现**插件 / 扩展 API 无法实现、必须修改 ST 核心**的需求时：

1. 在 GitHub 上 fork ST 到自己账号；
2. 把 `vendor/SillyTavern` 的子模块 URL 改为 fork，保留官方仓库为 `upstream` 远程；
3. 补丁放在单独分支（如 `qqbot/patches`），保持最小化，并在新的 ADR 中记录每个补丁的理由。

## 许可证约束

- **ST（AGPL-3.0）**：若修改 ST 并以网络服务形式提供（QQ 机器人属于此类），需要向用户提供修改后的源码。
  只用插件 / 扩展、不改 ST 核心，可以减少需要公开的范围，但插件是否构成衍生作品仍需按实际情况判断。
- **NapCat（Limited Redistribution）**：禁止商业用途；修改后的代码**不得公开发布**。
  因此本仓库若设为公开，绝不能提交对 NapCat 源码的修改；子模块只引用官方提交，不构成再分发。
