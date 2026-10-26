# 2026-10-27 00:4x DSH：本机向 VM 看齐（开关 / 自启 / 看门狗），数据仍然过不来

- 用户 10-27「尝试进行补齐」：把本机实例和她原来的运行环境对齐。
- 结论：**开关和运维补上了一半；数据（历史 / 长期记忆 / 日记 / 世界）过不来，VM 从本机不可达**。

## 做了什么

### 1. 开关对齐（照 Claude 10-26 实读的线上清单）

本机 `runtime/koishi/koishi.yml` 加上了 VM 上那批「开」：`proactive: on`、`autonomousLife`、`projectChoice`、`lifeInPrompt`、`grievance`、`feedbackCommands`、`stickers: send`、`npcAsks`、`festivals: greet`、`rhythm`、`shortReplies`、`typingStatus`、`pokes`、`pokeBack`、`recalls`、`selfRecall`、`pokeOut`、`readReceipts`、`onlineStatus`、`profileLikes`、`signature: on`、`qzone: on`、`shape*`（7 个）、`proactiveReach`、`innerLife`、`herFeelings`、`herNo`、`proactiveInvite`、`photos`、`proactiveRoom`、`weeklyReport`、`menu`、`curious`、`smallNews`、`texture`、`quoteReply`、`factCheck: fix`、`idioms`、`lagTail`、`everydayLife`、`pursuits`、`deliberate`、`tailCap`、`identityLedger`、`memoryAudit`、`timeline`、`webLookup: explicit`、`comeBack`、`interruptions`、`jokes`、`proactiveAsk`、`together`、`relationship`；重开的两项 `reactions: false`、`foodPhotos: false`。

重启后日志：「主动消息：开：2260168937（宝宝，boyfriend）」「NapCat 账号 2561299676 已就绪」，5140 在听，无 error。

### 2. 运维兜底（临时）

- `C:\Users\22601\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\qqbot-local.cmd`：登录后启动看门狗；
- `C:\Users\22601\qqbot-local\watchdog.ps1`：每分钟看 5140，掉了就拉起 Koishi；NapCat 掉了只记一行（要扫码，不自动）。
- **没做**：开机自动登录（要 Windows 密码）、Hindsight、告警外发。

### 3. 数据：过不来

- `ping 192.168.139.138` 100% 丢失，3389/445 不通 → 本机够不到 VM（和 BOARD 第 2 条一致）。
- 所以 VM 的 `runtime\bot`（聊天记录、长期记忆、日记、世界、照片、表情包）**没有拷过来**；本机只有连上后补回的 36 条 QQ 聊天 + 今天新生成的状态。
- B 站号「梦瑶不熬夜」在本机登录成功，凭证在 `runtime\bot-shadow\secrets\bilibili.json`；B 站只读能力（搜索 / 字幕 / watching / 推荐草稿）已开，和 VM 的「B 站全静默」是有意不同。

## 现在的差异（补齐后）

| 项 | VM | 本机 |
| --- | --- | --- |
| 代码 | `6169551` | `46539d9`（线上 + 未合并改动） |
| 开关 | 那批「开」 | **已对齐**（memory / B 站不同） |
| 长期记忆 | 开（Hindsight） | **关**（本机没装） |
| 历史 / 日记 / 世界 | 有 | **没有**（只有补回的 36 条） |
| 自启 / 看门狗 | 有（服务守卫、心跳、断网通知） | **登录自启 + 简易看门狗**；无心跳/断网通知/开机自登 |
| B 站 | 全静默 | 只读开（登录了） |
| 数据目录 | `runtime/bot` | `runtime/bot-shadow` |

## 提醒

- 批量恢复开关违背「一次一个变量」，这次是“恢复原状”不是“开新功能”，但之后任何新开关仍要一次一个。
- 两份数据已经分叉；以后要把本机聊的并回 VM（或反之），聊天记录可以拷，长期记忆/日记不能简单合并，需要单独设计迁移。
- 本机 QQ 与 VM 不能同时在线：VM 恢复前必须先停本机（或反过来）。
