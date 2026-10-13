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

## 20:29–20:31 已恢复（用户在本会话里说「恢复吧，重新登 QQ 拉起 Koishi」）

代码没变，还是 `2ba6df2`（HEAD `39c7144` 只多一个文档），不算上线。

1. 20:28 建 `%TEMP%\qqbot-maintenance`；live 树 `## main...origin/main`，没有改动
2. 20:29 关掉旧 NapCat 窗口（PID 4276 整棵树，10-10 09:39 起的），新开 `start-napcat.ps1`：快速登录成功，20:29:40 OneBot 适配器起来，3001 在听
3. 20:30 新开 `start-koishi.ps1`：16 秒后 5140 在听。日志 `2026-10-11-5.log`：20:30:22「NapCat 账号 2561299676 已就绪」，`connect to server: ws://127.0.0.1:3001/`。旧的 `bot.lock`（PID 14960）按锁的逻辑自动清掉了
4. 20:31 删维护目录；守护 20:30:27 记「napcat：恢复正常」「koishi：恢复正常」
5. 真实天气 20:30 取到了（`weather/*.json` 更新），外网正常。下一条主动是 23:37 睡前

**没查明的**：19:57 账号为什么离线；守护 20:00–20:25 拉起的窗口为什么几秒就没了（我手动用同样的 `Start-Process` 就起来了）。下次再出现，先看那个窗口里的报错。
