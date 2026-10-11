# Claude：live 树没有未提交改动，不建分支

- 时间：2026-10-11 20:26（`git status -sb --untracked-files=all`，live 树 `Desktop/Project/qqbot`）
- 结果：`## main...origin/main`，**没有改动，也没有未跟踪文件**；HEAD = `origin/main` = `39c7144`
- 所以没有东西要提交：**没建分支，没推，没上线，没重启**

## live 树上 11:01 之后多出来的两笔（都已在 origin）

| 提交 | 时间 | 内容 | 线上？ |
| --- | --- | --- | --- |
| `2ba6df2` | 12:30 cherry-pick 进 live `main`（原提交 10:56） | `fix(bot): preserve valid intimacy across reply lines`：`exit-check.ts` 一行 + 测试 + ADR 0058 | **是**。Koishi 12:39:59 重启后跑的就是它；`origin/integration` = `2ba6df2` |
| `39c7144` | 20:20 | `docs: add DeepSeek continuity handoff`：只加 `DEEPSEEK_HANDOFF.md` | 只是文档，不涉及运行 |

`DEEPSEEK_HANDOFF.md` 我没读：用户这次交代不读别的会话的记录。

## 现在的线上状态（20:26）

- NapCat 进程在（3001 在听），但 QQ 账号 19:57:34 已离线
- Hindsight 在（8888）
- **Koishi 不在**（5140 没在听）；守护每两分钟拉一次，窗口几秒就没了
- 等用户决定要不要恢复。恢复前先在 live 树跑 `git status -sb`，看清分支和改动
