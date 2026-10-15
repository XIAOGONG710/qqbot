# 心跳：进程在，但机器人卡住了怎么办（任务书 T3b）

## 为什么

服务守护（`scripts/services-watchdog.mjs`）只看三样：NapCat 的 3001 端口通不通、Hindsight 的 `/health`、有没有 Koishi 进程。**进程在、端口在，但机器人自己卡住**（事件循环被占死、插件没跑起来、整个进程挂着不动）它看不出来，也不会告诉任何人。心跳补的就是这一格。

## 它是什么

1. **写**：机器人（`startApp`）一启动就在数据目录写 `heartbeat.json`，之后每分钟写一次（原子写）。内容只有 `{ at, pid, ref, startedAt, connectedAt?, lastMessageAt? }`：写的时间、进程号、跑着的提交（启动脚本给的 `QQBOT_GIT_COMMIT`，没有就是 `unknown`）、启动时间、最近一次连上 NapCat 和最近一次收到私聊消息的**时间**。**不含任何聊天内容。**写失败只记一行日志、不影响聊天。停下时不删文件——留着的旧心跳正是「它停了」的证据。
2. **看**：`npm run heartbeat-watch -w packages/bot`（`src/ops/heartbeat-watch-cli.ts`）。默认一直跑，每 60 秒看一次 `heartbeat.json`；超过 `--max-minutes`（默认 15）没更新就告警。`--once`：只看一次，打印结论，退出码 0 正常 / 1 告警。`--dir <数据目录>`（默认 `runtime/bot`）。
3. **告警通道**（可插拔，默认两处）：控制台一行；数据目录里的 `ALERT.txt`（故障开始时写，恢复时删）。**推送留空，用哪个服务由用户定**：设环境变量 `QQBOT_ALERT_COMMAND`（比如一条调 ntfy / Bark 的 `curl`），故障开始和恢复时各运行一次，消息放在环境变量 `QQBOT_ALERT_MESSAGE` 里（不要拼进命令行）。没设就不推送。

## 不告警的情况

- **有维护旗** `%TEMP%\qqbot-maintenance`（手动上线 / 重启时本来就要建的）：免检，保持原来的告警状态。
- **没有 `heartbeat.json`**：不算故障（还没部署这个功能，或机器人从没启动过），只在 `--once` 里打印 `missing`。
- 持续故障不重复告警；恢复时报一次。

## 怎么用

```
# 看一次
npm run heartbeat-watch -w packages/bot -- --once
# 一直看（隐藏窗口里跑，和服务守护一样）
Start-Process node -ArgumentList 'packages/bot/src/ops/heartbeat-watch-cli.ts' -WindowStyle Hidden
```

## 没做 / 要说清楚的

- **要等机器人重启才开始写**（代码改动，下次上线才生效）。上线前这个功能是空的；上线后守望命令才有东西可看。
- 守望命令本身也是个要有人起的进程，**不会自己在重启后起来**；开机拉起脚本（`docs/boot-start.md`）以后可以把它一起带上，现在没有。
- 告警只通知「卡了 / 停了」，**不自动重启**（和服务守护的原则一致：它只留痕、不动手，重启要用户点头）。
- 心跳证明的是「机器人的事件循环还在转」，不证明「她回得出话」（比如模型接口断了，心跳照写）。模型接口的问题由服务守护的外网检查和每日原始数报告（T2）里的服务一节看。
