# 10-19 晚上上线单（B + NapCat 日志级别 + 删旧日志 + 自动登录重启验证）

- 前提：**窗口到 10-19 21:15**，那之前线上不动；**用户当次在场并明确点头**（B 的上线、NapCat 重启、删旧日志、重启虚拟机，各自要点头，可以一次问完但要分开答）。
- 用户 10-17 夜已经点过头的：B 窗口走完后上；同一次维护里 NapCat `fileLogLevel` 改 `warn`；B 上线后删旧日志（先列清单）。**这些仍要用户当次在场再确认一遍**（权限检查也可能拦下「停 Koishi / 快进」，要用户放行）。
- 候选：**B = `claude/release-1019a` `dfd8360`**（叠在 `main` `68c79d1` 上）；D = `claude/release-1019b` `4df3142`（单独一次，B 稳定看 48 小时后）；约 = `claude/release-1019c` `1c62bf0`（D 之后）。

## 0. 开始之前（我先做，不需要重启）

1. 窗口复核：10-17 21:15 起的 Koishi 日志 `错误` / `拒绝启动` / `模型总闸` / `DNS 兜底`、心跳一直在更新、探针和守护日志里的断网段（10-18 约 17.5 小时断网是宿主机侧，不算代码问题）。
2. 内存：可用虚拟内存 > 1.5 GB 时跑一次**全量测试**（守卫开着，380 秒）：`claude/release-1019a` 要 bot 全绿 + 插件 29 + 工具 43。不到 1.5 GB 就不跑，改成上线前再看。
3. 网络：探针最近 10 分钟没有大面积失败再动手（B 的启动不需要模型，但验证「收到：N 字」要）。
4. 在 `handoff/` 写一行重启通知（谁、什么时候、为什么、预计停多久、回滚点 = `68c79d1`）。

## 1. B 上线（Koishi 重启一次，她离线约 1 分钟）

1. 建维护旗 `%TEMP%\qqbot-maintenance`（守护此时什么都不动）。
2. 只停 Koishi（NapCat、Hindsight、守护不动）。
3. 备份 `runtime\bot` → `runtime\backup-pre-1019a-<时间>`。
4. 线上目录核对：`git status` 干净；`HEAD..origin/main` 空；`git diff --name-only HEAD origin/claude/release-1019a` 只有 `packages/bot/src`、对应测试、`docs/sensitive-logs.md`；**没有 `characters/`、没有配置改动**。
5. `git merge --ff-only origin/claude/release-1019a`。
6. `Start-Process scripts\start-koishi.ps1`（隐藏窗口，同 10-15 的做法）。
7. 验证：Koishi 日志第一行「敏感调试关着…」；「NapCat 账号 … 已就绪」；`heartbeat.json` 的 `ref` 变成新提交且每分钟更新；`state-check`（线上数据副本）16/17 项过；`heartbeat-watch --once` ok；0 个 error / warn；有消息进来时日志是「收到：N 字」不再带原文。
8. 撤维护旗；推送 `main` / `integration`。

**回滚**：先问用户；线上目录 `git reset --hard 68c79d1` 再按第 1.2 / 1.6 重启 Koishi（B 的状态文件没有格式变化，不需要恢复备份）。

## 2. NapCat 日志级别（同一次维护里，NapCat 重启一次，QQ 离线约 1 分钟）

1. `runtime\napcat\workdir\config\napcat_<机器人QQ>.json` 把 `fileLogLevel` 从 `"debug"` 改成 `"warn"`（先备份这个文件）。
2. 重启 NapCat：停 NapCat → `scripts\start-napcat.ps1`（快速登录）→ 等 3001 端口 → 日志出现账号上线。**这一步也是登录自启的预演**：隐藏窗口里快速登录能不能成功，QQ 要不要扫码——**用户在场看**，不行就回到有窗口的办法。
3. 如果顺序上放在第 1 节之前：先停 Koishi → 改配置 → 重启 NapCat → 再按第 1 节往下，Koishi 只重启一次。

## 3. 删旧日志（B 已上线、新日志里没有正文以后；不可撤销）

1. **先列清单给用户看**：`runtime\koishi\data\logs\*.log` 和 `runtime\napcat\workdir\logs\*.log` 里**重启之前的**文件（名字、大小、最早 / 最晚时间）。写进 `handoff/`。
2. 用户点头后才删；**只删日志文件**，聊天记录 `runtime\bot\chats`、记忆、日记一概不碰。
3. 删完核对：新日志文件还在写、`wc` 一下大小。

## 4. 自动登录 + 重启验证（用户在场；这次重启也是登录自启第一次真验证）

1. 用户在虚拟机里右键 PowerShell「以管理员身份运行」：`cd $env:USERPROFILE\Desktop`，`powershell -NoProfile -ExecutionPolicy Bypass -File .\enable-autologon.ps1`（先看计划），确认后加 `-Apply`。回滚 `-Undo`。
2. 用户重启虚拟机。1–2 分钟内应：自己登录 → Run 项 `qqbot-boot` 起服务（`runtime\boot\boot.log` 逐步记录）→ NapCat 快速登录成功 → 「NapCat 账号 … 已就绪」→ 心跳每分钟更新 → 守护、心跳守望、探针都在。
3. 不行就看 `boot.log` 最后一行停在哪；`-Undo` 随时可退。**重启期间别人发的消息会在恢复后补回**（那时候 `backfill.ts` 已经会跳过运维提醒）。

## 5. 做完之后

- 看 48 小时：B 的日志里没有原文、没有新的错误；运维提醒（外网断 / 好）能收到。
- 然后单独问用户 D（`release-1019b`）：它需要用户当次点头，单独重启。
- D 稳定后：约（`release-1019c`，配置 `npcAsks: true`，先看用户对月历预览的三个默认值）。
