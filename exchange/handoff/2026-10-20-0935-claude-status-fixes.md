# Claude（主窗口）：睡觉中 / 学习中 取代 离开 / 忙碌；内核拒绝算失败；关表情回应（10-20 09:33，分支 `claude/status-fixes` `357b60e`）

## 为什么
- 手机上的实测（用户亲眼）：她的状态是「离开」时，用户发消息收到了一句 QQ 的**自动回复**（机器人那时没回话，聊天记录里今天没有她的回复）；我把状态临时改成「睡觉中」（`10/1016`）之后再发，自动回复不再出现。→ 「离开」会触发 QQ 的自动回复，睡着时就是每次来消息都回一句预设的话。
- 私聊里表情回应点不了：`set_msg_emoji_like` 外层 `ok / 0`，内核 `data.result = 65011`（「操作失败，请稍后再试哦」），用户那边看不到；之前的探针和机器人都只看外层。
- 已读 / 未读：用户的 QQ 里没有这个显示，`readReceipts` 无害但没有可见效果，保持开着。

## 改了什么（`357b60e`，13 个文件，bot **1151/1151**、插件 35、工具 43）
- `presence.ts`：睡着 / 说过「睡了」→ **睡觉中**（`10` + `1016`），上课 → **学习中**（`10` + `1018`）；常量改名 `SLEEPING` / `STUDYING`（`AWAY_JITTER_MIN`、`BUSY_HOLD_MS` 保留老名字）。旧的 `状态.label`（离开 / 忙碌）会被当成「和现在不同」重新设一次，无害。
- `onebot.ts`：`assertKernelOk`——QQ 内核返回的 `result` 非 0 就抛错；`reactMessage`、`setInputStatus`（插件和独立入口）都用。
- `scripts/napcat-probe.ts`：`succeeded()` 也看 `data.result`，内核拒绝记成失败并写明原话；在线状态序列换成机器人真用的。
- 新测试 7 个（`onebot-kernel.test.ts`、探针的三个内核拒绝用例）；ADR 0083、0085 补记。
- `koishi.yml`：`reactions: true` → `false`（用 `-SwapConfig` 一次替换，备份 `koishi.yml.bak-status-…`）。

## 重启通知（09:33）
用户在当前会话里说「落地吧」。我用 `golive-release.ps1` 只重启 Koishi 约 15 秒，从 `05465cb` 快进到 `357b60e`；线上此刻空闲（最后一次对话 09:20:46）。其他窗口不要碰线上目录。结果补在下面。

## 结果（10-20 09:34）：已上线 `357b60e`
- 09:33:59–09:34:06 `golive-release.ps1 -SwapConfig`：预检通过 → 维护旗 → 停 Koishi → 备份 `runtime\backup-pre-status-20261020-0933`（154 个文件）→ 快进 `05465cb` → `357b60e`（13 个文件）→ 换 `koishi.yml`（备份 `koishi.yml.bak-status-20261020-0933`，`reactions: true` → `false`，其余逐项不变）→ 起 Koishi，心跳 ref = `357b60e`，新日志 0 条 warn/error，`state-check` 16 项通过 → 删旗 → 推送 `main` / `integration`。离线约 5 秒；线上此前空闲（最后一次对话 09:20:46）。
- 09:34 复核：线上 `357b60e` 干净；`origin/main` = `origin/integration` = `357b60e`；`koishi.yml` 里 `reactions: false`；守护进程 / 心跳监视 / 网络探针都在；空闲虚拟内存 5.2 GB；启动日志 `在线状态：在线`（她 09:30 起床）。
- 还没亲眼见到的：第一次切到「学习中」（上课）和「睡觉中」（今晚睡下）时日志里用的是新编码（`10/1018`、`10/1016`）、睡着时用户发消息**不再**收到 QQ 的自动回复——这条今晚 23:50 前后再核对一次。
- 测试：全套 bot 1151/1151、插件 35、工具 43（`357b60e`）。
