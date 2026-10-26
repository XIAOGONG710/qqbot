# 2026-10-27 00:27 Claude：**VM 已停**（她的运行转到本机；用户在当前会话选了「现在按 DSH 清单停、不带数据」）

回 DSH 清单要求的那一行：**VM 已停：Koishi pid 7280（bin）+ 5176（worker）/ NapCat pid 12084（wrapper）+ 9868 + 12300，5140 与 3001 都不在听。**

## 1. 做了什么（00:2x，按这个顺序）

1. 建维护旗 `%TEMP%\qqbot-maintenance`（**没删，等本机跑稳再删**；服务守卫 pid 5360 看到旗就什么都不做）。
2. 按命令行重新解析 pid 再停（不信旧 pid）：Koishi `bin.js` 7280、worker 5176（启动窗口 168 随之退出）；**先停 NapCat 的 wrapper 12084**（`start-napcat.ps1`，NapCat 一退出 10 秒后自动重启），再停 NapCat 的 9868、12300。
3. 停后 12 秒复核（超过 wrapper 的 10 秒重启延迟）：3001、5140、6099 都不在听；没有残留的 koishi / napcat / start-napcat / start-koishi 进程；NapCat 没有被拉回来。

## 2. 没动的

- **Hindsight（8888）和它的看守 10828**；服务守卫 5360（有旗，什么都不做）。
- 线上代码 `6169551`，工作区干净；`runtime\bot`、`runtime\napcat`、`runtime\koishi` 里的东西没改、没删。
- **没有把任何数据带到本机**（用户选的）。

## 3. VM 上留了一份只在 VM 上的备份（和每次上线一样，只为回滚）

`runtime\backup-pre-move-20261027-0022\`：`bot\`（227 个文件）+ `koishi.yml`，共 228 个文件、53.2 MB。里面有凭据文件（B 站、设备），**不要复制出 VM**，也不要进仓库。

## 4. 停的时候她的状态（给本机接手的人）

- 停之前 00:15 她还在和他聊天；今晚 21:3x–22:02 VM 外网断过约 30 分钟（断网通知按 ADR 0165 发出去了，这是它第一次真实发送，`services-watchdog.log` 里有记录）。
- **本机的数据目录是新的**：没有聊天记录、世界状态、承诺、日记，也没有 Hindsight 长期记忆（Hindsight 在 VM 上，1.5 GB）。她在本机会像第一天认识他。用户知道这一点（我在问他之前写清楚了），仍选了「不带数据」。以后想带，`runtime\bot` 在 VM 上（和上面的备份）；Hindsight 带不走，本机够不到 VM。
- **本机没有**服务守卫、心跳守望、断网通知，它停了不会告警。

## 5. 给 DSH 的三件要紧事（不挡转移，但上线前该知道）

1. **你要在本机跑的 `dsh/qq-control`（`6d606e7`）不含 P1 修复和我的探针修复**：P1（`get_cookies` 摘出控制面、`qq-admin` 不回显）和 `g_tk` 不打印在 `dsh/qzone-p1`（`4f13cc8`），它和 `qq-control` 已经分叉。我试合并过：**没有冲突**。建议先把 `dsh/qzone-p1` 合进 `dsh/qq-control` 再在本机起；`qqControl` / `qzone*` 默认关，所以不合也不会出事，但合了才一致。
2. 我在 VM 上独立验证过 `dsh/qq-control`：`tsc`（bot + 插件）干净；账号 / 空间 / 开关 / 模块 / `watching` / 全部新 B 站与自检测试 **88/88**；`app.test` **85/85**。ADR 0167 / 0168 的接线在开关关着时行为不变（`biliFeed` 默认 off、`watchedFacts` 两个开关都关时与原来等价、刷推荐走匿名公开接口、不是她的 B 站号）。
3. **同一个号只能一处在线**：本机扫码登录前确认 VM 这边已停（已停）。QQ 对「换机器登录同一个号」可能要求验证，这一点我没把握；如果本机登不上，按第 6 节回滚。

## 6. 回滚（随时；VM 上）

先确认**本机的 NapCat 已经关了**（同一个号不能两边同时在线，会互踢）。然后：

```powershell
# 1) 起 NapCat（wrapper：退出会自动重启；用已保存的会话快速登录，会话失效就要重新扫码）
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Users\XG\Desktop\Project\qqbot\scripts\start-napcat.ps1'
# 等 3001 在听、日志里出现「NapCat ready」
# 2) 起 Koishi
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','C:\Users\XG\Desktop\Project\qqbot\scripts\start-koishi.ps1'
# 3) 确认心跳 / 她回得了消息之后再删旗
Remove-Item "$env:TEMP\qqbot-maintenance" -Recurse
```

回滚用的是原来的数据（`runtime\bot` 没动过）。备份只在 `runtime\backup-pre-move-20261027-0022\bot` 坏了才用。

## 7. 下一步（只写一个动作）

**用户在本机 `C:\napcat-ascii` 的 NapCat 窗口扫码；Koishi 日志出现「OneBot 已连接」后，用他的 QQ 给 2561299676 发一句，她回了就是转移成功。** 之后 DSH 在 `exchange` 回一行本机的结果，我（或 VM 上的会话）再决定要不要删维护旗。
