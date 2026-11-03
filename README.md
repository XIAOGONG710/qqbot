# qqbot

基于 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的 QQ 机器人，QQ 端通过 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11）接入。

## 目录结构

```
qqbot/
├── vendor/
│   ├── SillyTavern/        上游子模块（release 分支），不直接修改
│   └── NapCatQQ/           上游子模块（main 分支），仅作参考
├── packages/               自有代码：独立的 QQ 机器人服务与工具（Node.js / TypeScript）
├── characters/             角色资料（<角色>/legacy/ 为旧项目原样导入，不原地修改）
├── docs/                   架构决策（adr/）、调研记录（research/）、路线图（roadmap.md）、NapCat 安装记录（napcat.md）
├── scripts/                本地脚本（启动 SillyTavern、NapCat、bot）
├── runtime/                本地运行数据（.gitignore 忽略）
└── 思维链工作流.txt        工程决策流程
```

为什么这样组织，见 [ADR 0001](docs/adr/0001-repository-structure.md)；
为什么运行时独立于 SillyTavern（SillyTavern 只用来编写角色），见 [ADR 0002](docs/adr/0002-standalone-runtime.md)。
进度见 [路线图](docs/roadmap.md)。

所有提交到 `main` 和拉取请求都会在 Windows + Node 24 上运行类型检查与全量测试。Koishi 状态页显示当前运行提交、分支、工作树是否干净和启动时间，线上版本不再只靠操作记录判断。

## 获取代码

```powershell
git clone <本仓库地址>
```

两个上游子模块（`vendor/SillyTavern`、`vendor/NapCatQQ`）只作参考，运行和测试都不用它们，所以默认不拉
（`.gitmodules` 里 `update = none`，所以 `git clone --recurse-submodules` 也会跳过它们）。需要对照上游源码时再按需拉，
命令行上要带 `--depth 1`，这样只取锁定的那一个提交（不带的话会拉全部历史，NapCatQQ 约 380 MB）：

```powershell
git submodule update --init --checkout --depth 1 vendor/NapCatQQ
git submodule update --init --checkout --depth 1 vendor/SillyTavern
```

## 升级上游

```powershell
# 跟到上游分支最新提交
git submodule update --remote --checkout vendor/SillyTavern

# 或切到指定版本
git -C vendor/SillyTavern fetch --tags
git -C vendor/SillyTavern checkout 1.19.0

# 记录新的锁定版本（可通过回退该提交回滚）
git add vendor/SillyTavern
git commit -m "chore(vendor): bump SillyTavern to <版本>"
```

## 当前上游版本

| 子模块 | 分支 | 提交 | 最近标签 |
| --- | --- | --- | --- |
| SillyTavern | release | `06bde939f` | 1.19.0 |
| NapCatQQ | main | `26d7533e` | v4.18.28 |

## 用 SillyTavern 编写 / 试聊角色

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-sillytavern.ps1
```

浏览器打开 http://127.0.0.1:8000/ 。配置和数据在 `runtime/sillytavern/`（`config.yaml`、`data/`），子模块里不产生改动。
首次运行会在子模块里执行 `npm ci`；升级 SillyTavern 子模块后，删掉 `vendor/SillyTavern/node_modules` 再启动，让依赖重装。

## 运行 QQ 机器人

先启动 NapCat（见 [docs/napcat.md](docs/napcat.md)），再启动 bot（配置见 [packages/bot/README.md](packages/bot/README.md)）：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start-napcat.ps1   # 一个终端
powershell -ExecutionPolicy Bypass -File .\scripts\start-bot.ps1      # 另一个终端
```

## 手机伴侣

DSH 开启并在 Koishi 中打开 `mobileCompanion.enabled` 后，可在 QQ 发送 `/dsh pair` 获取一次性配对码，设备遗失时用 `/dsh unpair` 立即撤销旧会话。DSH 默认复用主模型配置，也可在 `dsh` 下单独指定兼容接口地址、模型和超时（密钥仍只从 `QQBOT_LLM_API_KEY` 读取）。零依赖 PWA 位于 [`packages/mobile-companion-app`](packages/mobile-companion-app)：用静态服务器托管后，在手机浏览器添加到主屏幕，再填写 Koishi 的 WebSocket 或 HTTPS 地址。它支持文字、麦克风录音、音频 / 图片引用、服务端表情，以及经确认的通知、振动、计时器和 HTTPS 链接动作；若宿主为 `media.voiceDataToText` 接入 STT，手机语音会直接转成文字交给 DSH，否则保留为安全的“收到语音”占位；不提供任意 shell 或系统高权限。

## 环境要求

- Git
- Node.js `>= 24`（`packages/` 直接运行 TypeScript；SillyTavern 本身要求 `>= 20`）
- `scripts/*.ps1` 用 `powershell -ExecutionPolicy Bypass -File <脚本>` 运行：Windows 默认执行策略禁止直接运行脚本，
  这样只对这一次运行放行，不改系统设置。

## 质量检查

根目录提供统一的只读检查入口；参数会转发到 bot 工作区：

```powershell
npm test
npm run typecheck
npm run audit:gate
npm run state-check -- runtime/bot
npm run dsh:link -- --help
```

`golive-check` 只用于上线前审查，不会自动重启、部署或提交改动。
