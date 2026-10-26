# 2026-10-27 01:5x DSH：请暂停 VM 上她的运行，本机接手（用户指令）

- 用户 10-27：「推送吧，让 claude 那边暂停她的运行，暂时转移到本机」。
- 这是一次**运行位置转移**，不是上线新功能：代码没变化（`dsh/qq-control` = `6d606e7`），只把「谁在跑这个 QQ」从 VM 换到本机。

## 一、Claude（VM 侧）要做的

**目标**：把 VM 上的 NapCat 和 Koishi 停掉，让 QQ 号腾出来；**不删任何数据、不改任何配置**。

```powershell
# 1) 维护旗（服务守监会因此不动）
mkdir "$env:TEMP\qqbot-maintenance" -Force

# 2) 停 Koishi：先看谁在听 5140
Get-NetTCPConnection -LocalPort 5140 -State Listen | Select-Object OwningProcess
# 停掉那个 pid（通常还有一个 supervisor 父进程，一起停）
Stop-Process -Id <pid> -Force

# 3) 停 NapCat（它就是那台 QQ）：看 3001 / 6099
Get-NetTCPConnection -LocalPort 3001 -State Listen | Select-Object OwningProcess
Get-NetTCPConnection -LocalPort 6099 -State Listen | Select-Object OwningProcess
Stop-Process -Id <pid> -Force
```

停完在 `exchange` 回一行：**「VM 已停：Koishi pid / NapCat pid，5140 与 3001 都不在听」**，并写清恢复方法（见第四节）。

注意：
- 不要 `taskkill /IM node.exe`（会误伤 Hindsight 等）；
- 数据目录 `runtime\bot`、`runtime\napcat` 原样保留，不备份也行（没改东西）；
- 维护旗等本机跑起来、确认稳定后再删（`rmdir "$env:TEMP\qqbot-maintenance"`）。

## 二、本机（DSH 侧）已经准备好的

- 代码：`C:\Users\22601\Desktop\qqbot-dsh-control`，分支 `dsh/qq-control`（`6d606e7`，含 main 到 10-26 02:43 的全部代码 + 我们这些天的 B 站只读能力）；依赖用 junction 指向本机 `node_modules`。
- 实例：`qqbot-dsh-control\runtime\koishi`（从旧影子实例复制的 `koishi.yml`，账号 2561299676、ws://127.0.0.1:3001、dataDir `runtime/bot-shadow`）。
- 本机 NapCat：`C:\napcat-ascii` 正在跑（6099 在听），**停在扫码登录**，3001 还没起来——等 VM 那边腾出号之后再扫。
- 本机 Koishi：本轮已重新拉起（5140），在等 3001。

## 三、用户在本机的动作（只有一步）

1. 在**本机** `C:\napcat-ascii` 那个 NapCat 窗口扫码（二维码过期就让它刷新）；
2. 扫完等 5–10 秒，Koishi 日志应出现「OneBot 已连接」，本机 3001 起来；
3. 用你的 QQ 给 2561299676 发一句，看她回不回——回了就是转移成功。

**数据是新的**：`runtime/bot-shadow` 没有线上的聊天记录、记忆、世界状态。要「接着原来的她」跑，需要把 VM 的 `runtime\bot` 拷到本机 `qqbot-dsh-control\runtime\bot-shadow`（或改 `koishi.yml` 的 `dataDir` 指过去）。这一步要用户自己做（或授权 Claude 打包，但 VM 出口带宽/文件大小未知）。

## 四、回滚（随时）

VM 上把两个服务起回来即可：

```powershell
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<线上目录>\scripts\start-napcat.ps1'
Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','<线上目录>\scripts\start-koishi.ps1'
```

本机这边停 Koishi 就释放（NapCat 也可以关掉窗口）。

## 五、红线

- 同一个号只能一处在线：本机登录成功 = VM 那边一定已经停干净；两边同时开会被互踢。
- 本机跑的是**未合并的分支**（`dsh/qq-control`），如果只想跑「和线上一样的代码」，切 `origin/main`（`6169551`）再起；我们的新增开关默认全关，不影响行为。
- 本机这条线暂时没有看门狗 / 心跳守望 / 网络探针；它停了不会告警。
