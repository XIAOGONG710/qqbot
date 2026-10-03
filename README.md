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
├── docs/                   架构决策（adr/）、调研记录（research/）、路线图（roadmap.md）
├── scripts/                本地开发脚本（启动 SillyTavern 等）
├── runtime/                本地运行数据（.gitignore 忽略）
└── 思维链工作流.txt        工程决策流程
```

为什么这样组织，见 [ADR 0001](docs/adr/0001-repository-structure.md)；
为什么运行时独立于 SillyTavern（SillyTavern 只用来编写角色），见 [ADR 0002](docs/adr/0002-standalone-runtime.md)。
进度见 [路线图](docs/roadmap.md)。

## 获取代码

```powershell
git clone --recurse-submodules <本仓库地址>
# 已克隆但缺少子模块时：
git submodule update --init
```

## 升级上游

```powershell
# 跟到上游分支最新提交
git submodule update --remote vendor/SillyTavern

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
.\scripts\start-sillytavern.ps1
```

浏览器打开 http://127.0.0.1:8000/ 。配置和数据在 `runtime/sillytavern/`（`config.yaml`、`data/`），子模块里不产生改动。
首次运行会在子模块里执行 `npm ci`；升级 SillyTavern 子模块后，删掉 `vendor/SillyTavern/node_modules` 再启动，让依赖重装。

## 环境要求

- Git
- Node.js `>= 24`（`packages/` 直接运行 TypeScript；SillyTavern 本身要求 `>= 20`）
