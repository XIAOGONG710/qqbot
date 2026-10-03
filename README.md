# qqbot

基于 [SillyTavern](https://github.com/SillyTavern/SillyTavern) 的 QQ 机器人，QQ 端通过 [NapCat](https://github.com/NapNeko/NapCatQQ)（OneBot 11）接入。

## 目录结构

```
qqbot/
├── vendor/
│   ├── SillyTavern/        上游子模块（release 分支），不直接修改
│   └── NapCatQQ/           上游子模块（main 分支），仅作参考
├── packages/               自有代码，通过 ST 插件 / 扩展机制挂载
├── characters/             角色资料（<角色>/legacy/ 为旧项目原样导入，不原地修改）
├── docs/adr/               架构决策记录
├── runtime/                本地运行数据（.gitignore 忽略）
└── 思维链工作流.txt        工程决策流程
```

为什么这样组织，见 [ADR 0001](docs/adr/0001-repository-structure.md)。

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

## 环境要求

- Git
- Node.js `>= 20`（SillyTavern `package.json` 的 engines 要求）
