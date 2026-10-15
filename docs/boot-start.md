# 重启后自己起来：开机拉起任务（任务书 T3c）

## 为什么

2026-10-15 03:29 / 03:33，Windows 更新强制重启了虚拟机两次。NapCat、Hindsight、Koishi、看门狗全没起来：这台机器没有任何开机自启（没有计划任务、没有启动项、没有自动登录），要等有人远程桌面登录后手动起。她因此离线约 6 小时。之前试过 Interactive 类型的计划任务，失败（`0x800710E0`），而且它本来就要有人登录才会跑。

## 这里有什么

| 文件 | 作用 |
| --- | --- |
| `scripts/start-services-at-boot.ps1` | 开机拉起的脚本：按 NapCat → Hindsight → Koishi → 看门狗的顺序起，**每一步先看是不是已经在跑，只补缺的**，所以手动跑、重复跑都不会起两份。最后把看门狗放在前台，任务因此一直活着（任务计划程序把任务起的进程放在一个 job 里，任务结束子进程可能跟着没）。`-DryRun` 只打印会做什么 |
| `scripts/install-services-tasks.ps1` | 注册 / 删除计划任务 `qqbot-boot`。默认只打印计划不改任何东西；`-Install` 弹出凭据框要 Windows 密码；`-Uninstall` 删除 |

## 它会做什么

1. 看维护旗 `%TEMP%\qqbot-maintenance`：**不到 2 小时**说明有人在手动上线 / 重启，脚本什么都不动直接退出；超过 2 小时当成遗留，删掉继续。
2. 等网络（最多 180 秒，等 `api.deepseek.com` 能解析；等不到也往下走，服务和看门狗会自己重试）。
3. NapCat：3001 端口没在听才起 `start-napcat.ps1`（用保存的会话快速登录；要扫码的情况下它起不来，日志里会写）。
4. Hindsight：`/health` 不通才起 `start-hindsight.ps1`，**默认跳过 Hindsight 启动时对模型接口的连通自检**（`HINDSIGHT_API_SKIP_LLM_VERIFICATION`，只对这个进程）。原因：10-15 DeepSeek 排队时这个自检超时、Hindsight 进程退出、记忆服务起不来；重启后网络没准备好也会这样。想保留自检传 `-SkipHindsightLlmCheck:$false`。
5. Koishi：没有 `koishi/bin.js` 进程才起 `start-koishi.ps1`。
6. 看门狗：没在跑才起，放前台。
7. 全部输出在 `runtime\boot\`（`boot.log` 一行一步；每个服务一对 `.out` / `.err`），`runtime/` 被忽略，不进仓库。

## 怎么装（要你做的）

1. 先看会做什么：`.\scripts\start-services-at-boot.ps1 -DryRun`（现在服务都在跑的话，它会每一步都说「已经在跑，不动」）。
2. 看计划：`.\scripts\install-services-tasks.ps1`（不带参数，什么都不改）。
3. 装：`.\scripts\install-services-tasks.ps1 -Install`，在弹出的凭据框里输入 **你的 Windows 密码**。密码不进任何文件、不进命令行，交给任务计划程序保存。
4. 不重启先试：`Start-ScheduledTask -TaskName qqbot-boot`。服务都在跑时它什么都不动，只写 `runtime\boot\boot.log`。
5. 第一次真重启的时候你在旁边看着：重启后等 3 分钟，`runtime\boot\boot.log` 应该一步步写到 watchdog；QQ 在线、Koishi 日志出现「NapCat 账号 … 已就绪」。

## 回滚

`.\scripts\install-services-tasks.ps1 -Uninstall`。已经在跑的服务不受影响。

## 没验证的（诚实说）

- 这些脚本**只通过了语法检查和 `-DryRun`**，没有在真实重启里跑过；NapCat（QQ）在没有桌面会话的任务里能不能正常登录，要第一次真重启才知道。所以第 5 步要你在场。
- 任务计划程序里子进程在任务结束时会不会被带走，我们靠「看门狗放前台、任务不结束」来规避；这一点也要真重启验证。
- 看门狗只管进程和端口，不管「进程在但机器人卡住」；那一类要 T3b 的心跳。
- 这不能阻止 Windows 更新重启本身；限制自动重启（有登录用户时不重启、活动时间避开夜里）是另一件事，用 Windows 更新策略，不需要密码。
