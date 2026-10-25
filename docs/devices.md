# 让她有限地操作你的电脑和手机（设置与收回）

对应 [ADR 0148](adr/0148-device-control.md)。**默认全关**；下面每一步都是你自己点头的一步，代码上线、开关、重启各自单独做。

## 它能做什么、不能做什么

| 档位 | 动作 | 谁触发 |
| --- | --- | --- |
| 自动（有次数限制：每小时 4 次、每天 12 次，同样的 10 分钟内只做一次） | 弹通知（电脑 / 手机）、定时提醒、电脑上放 / 停 / 下一首、调音量（最高 60）、打开你登记过的网页或应用、让手机响（找手机） | 她，在回复里写一行指令 |
| 要你批准 | 锁屏、让电脑休眠 | 她提议 → 系统给你发一行说明 → 你回 `批准`（5 分钟内有效，一次一个，每天最多 6 次提议） |
| 只有你能触发 | 看一眼电脑屏幕（`/屏幕`）、用电脑摄像头拍一张（`/摄像头`） | 你发命令；她的回复里写了也不执行；每次隔 10 秒、每天最多 20 次 |
| **不存在** | 读写文件、执行命令、键盘鼠标输入、输密码、安装 / 删除、支付、以你的名义给别人发消息 | — |

你的命令（都只认你一个人发来的**纯文字**消息，不进聊天记录）：`批准`、`拒绝`（或 `取消`）、`/屏幕`、`/屏幕 你看这个报错`、`/摄像头`、`/设备`（看连着什么、有没有待批准的）。没有待批准的时候 `批准` 就是一句普通的话。

## 隐私，先说清楚

- **`/屏幕`、`/摄像头` 的图会交给看图模型**（和你发给她的照片同一条通道，DeepSeek 的云端）。屏幕上有什么，模型就看得到。提示词里要求它不抄密码、账号、证件号和别人的聊天原文，但这只是要求，不是保证。所以：别在屏幕上有银行 / 密码 / 别人隐私的时候发 `/屏幕`。
- 看完的**文字描述**（两三句）会作为你这一条消息进聊天记录，也就可能进长期记忆；**图片本身不保存**。
- 电脑每次被看，右下角会弹一条提示（电脑端配置里的 `announceText`）。
- 通知文字会经过 ntfy 服务器（手机那一头，默认 ntfy.sh）。话题名当密码用；想更稳就自己架 ntfy，把 `baseUrl` 换掉。
- 手机这一头**只能收通知**，天生做不到拍照、读短信、装软件。

## 设置（第一次）

### 1. 代码上线（我来做，要你点头）

分支 `claude/human-videos`（工作树 `qqbot-claude7`）里有全部代码。上线 = 合并 + 重启一次，开关还是关着，没有任何行为变化。

### 2. 生成令牌和电脑端配置（你自己跑，令牌不会打印出来）

在线上目录运行：

```
! npm run devices -w @qqbot/bot -- init
```

它写两个文件到 `runtime/bot/secrets/`：`devices.json`（令牌、取件中心地址、手机的 ntfy 话题）和 `device-agent.config.json`（填好令牌的电脑端配置）。手机的 ntfy 话题会在终端显示一次。想看状态：`npm run devices -w @qqbot/bot -- status`。

### 3. 虚拟机放行一个端口（只放宿主机）

电脑上的小程序是**主动连虚拟机**的（宿主机上不用开任何入站端口）。虚拟机的防火墙要放行取件中心的端口，并且只放宿主机的地址（管理员 PowerShell）：

```
New-NetFirewallRule -DisplayName "qqbot-device-hub" -Direction Inbound -Protocol TCP -LocalPort 7789 -RemoteAddress 192.168.139.1 -Action Allow
```

`192.168.139.1` 是 VMware NAT 网络里宿主机的地址（虚拟机的网关是 `.2`）；如果小程序连不上，在虚拟机里 `netstat -ano | findstr 7789` 看有没有来自别的地址的连接，把 `-RemoteAddress` 改成那个。

### 4. 电脑上装小程序

把 `scripts/device-agent.ps1` 和上一步生成的 `device-agent.config.json` 复制到电脑上同一个文件夹（比如 `C:\qqbot-agent\`），然后改配置：

- `allow`：你**不想让她做的动作**设成 `false`（不写等于不允许，默认拒绝）。`lock`、`sleep`、`capture_screen` 先想清楚再开；`capture_camera` 需要装 ffmpeg 并填 `ffmpeg`、`cameraName`，不装就一直是关的。
- `links`、`apps`：你登记的网页（名字 → https 地址）和应用（名字 → 本机路径）。**名字要和 `koishi.yml` 里的 `deviceLinks` / `deviceApps` 一致**，她只能说名字。
- `maxVolume`、`announceText`、`title`。

运行（先手动跑，看有没有报错）：

```
powershell -NoProfile -ExecutionPolicy Bypass -File C:\qqbot-agent\device-agent.ps1
```

它的日志在同一个文件夹的 `device-agent.log`（只有动作名和成功 / 失败，没有内容）。想开机自启：任务计划程序里建一个「登录时」触发、隐藏窗口运行上面这条命令。

### 5. 手机（Android）

装 **ntfy** 应用，订阅服务器 `https://ntfy.sh`（或你自己的）的那个话题（`init` 时显示的，也在 `devices.json` 里）。系统设置里允许 ntfy 通知；想让「找手机」响得出来，给 ntfy 的**紧急**频道开声音 / 免打扰例外。

### 6. 打开开关：先试运行

`runtime/koishi/koishi.yml` 里加：

```yaml
deviceControl: dryRun
deviceLinks:
  - 音乐=https://music.163.com/
deviceApps:
  - 记事本
```

重启一次。日志里应该有「设备控制：试运行……」。`dryRun` 时她提议的动作**只写草稿**（`runtime/bot/devices/drafts.md`），不执行。先看一两天，看她会不会乱用；觉得对了，把 `dryRun` 改成 `on` 再重启。

## 收回（任何一种都行，从快到彻底）

1. 电脑上：在小程序文件夹里新建一个叫 `device-agent.stop` 的空文件，或 `Ctrl+C`，或把配置里的 `enabled` 改成 `false`——电脑这一头立刻不做事。
2. `koishi.yml` 里 `deviceControl: off` + 重启——她那边什么指令都不认，指令行照样会被摘掉不给你看。
3. 虚拟机里删掉防火墙那条规则。
4. 换令牌：`init --force`（旧令牌立刻失效，电脑端配置要重新复制）；换手机话题：改 `devices.json` 里的 `phone.topic`，手机重新订阅。

## 熔断

- 取件中心 10 分钟内收到 5 次错误令牌，或 ntfy 返回 401 / 403 / 429 → 对应平台（`devices` / `phone`）**持久熔断**：之后所有动作不发，重启也不恢复。
- 只有你在本机运行 `npm run platform -w @qqbot/bot -- resume devices --acknowledge-account-risk`（或 `phone`）才恢复。`npm run devices -w @qqbot/bot -- status` 能看到熔断状态和最近 24 小时的审计汇总。
