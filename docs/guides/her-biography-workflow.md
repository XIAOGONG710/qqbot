# 给她补人设、写自传和小说：怎么放、怎么转、怎么同步（2026-11-28）

用户 11-28 定的顺序里，第 ② 步是补她的人物设定、写自传和小说。仓库已经公开（用户 11-28 确认），真实资料**只在本机**，这页说清楚放在哪、怎么变成她用得上的东西、以及现在多出来的两件事：备份和同步。

## 放在哪（都在本机，Git 不跟踪）

| 内容 | 位置 | 说明 |
|---|---|---|
| 自传正文（作者定稿，正文不改） | `characters/linmengyao/biography/autobiography-v1.md` | 改了出新版本就另存 `-v2.md`，ADR 0022 |
| 自传切块（年表 + 一件事一块 + 留白） | `characters/linmengyao/source/biography.yml` | 运行时「有线索才想起」读的是这份，不是正文；格式见 `packages/character-tools/src/biography-to-card.ts` 的 `checkBiography` |
| 人设硬事实 | `characters/linmengyao/source/persona.yml` | 自传里定下的硬事实同步到这里（ADR 0022 第 2 节） |
| 小说 | 还没有现成的位置 | 先按草稿放 `characters/linmengyao/biography/` 下；要她「记得」小说里的事，得像自传一样切块进 `biography.yml`，或另开一种资料——写完了再一起定 |
| 生成的角色卡 | `characters/linmengyao/st/` | 生成物，别手改 |

`.gitignore` 已经挡住整个 `characters/linmengyao/`，不会被误提交。

## 怎么转成她用得上的

1. 改 `source/` 下的文件（或在 Koishi 控制台「林梦瑶」页改，保存时自动生成）。
2. 生成角色卡：`npm run convert -w @qqbot/character-tools`。档位隐私检查不过就什么都不写，按报错改。
3. 校验真实资料：`npm run test:real -w @qqbot/character-tools`（失败时只看断言行，别把内容贴到别处）。
4. 写自传的规矩（ADR 0022）：他的真名不写（切块时换成「他」）；每块写档位可见性和触发词 `keys`；不想讲 / 记不清 / 不说出口的地方用留白 `gap`。

## ⚠ 现在多出来的两件事（资料撤出 Git 之后）

- **备份**：以前 Git 就是备份和版本历史，现在**没有了**。每日备份（`scripts/backup.mjs`）只备线上数据目录和 DSH 状态，**不备 `characters/linmengyao/`**。写自传和小说期间，请自己另存一份到仓库之外（比如定期复制整个 `characters/linmengyao/` 到网盘或另一块盘）。
- **同步到线上那台**：以前 DSH 那台 `git pull` 就拿到最新角色卡、插件热加载；现在 `characters/` 不走 Git，**写完转好的卡不会自己到线上**。要么在线上那台（DSH）直接写和转换，要么写完手动把 `source/`（和生成的 `st/`）复制过去再转换一遍。这一步上线时要用户点头（改真实角色资料、插件会热加载）。

这两件事要不要做成工具（比如把 `characters/linmengyao/` 打包进每日备份、或一条安全的同步命令），等用户写完一部分再定。
