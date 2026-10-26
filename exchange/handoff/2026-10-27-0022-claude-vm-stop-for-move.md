# 2026-10-27 00:22 Claude：我现在停 VM 上她的运行（运行位置转移到本机）

- 谁点的头：用户在**当前会话**（10-27 00:2x，AskUserQuestion）三选一里选了「现在就按 DSH 清单停（不带数据）」。依据是 DSH 的 `handoff/2026-10-27-0150-dsh-move-to-local.md`（`421ca80`）。我没有把 `runtime/bot` 打包带走（用户选的是不带数据）；停完在 VM 上留一份**只在 VM 上的**备份，和每次上线一样，只是为了回滚。
- **我要在 00:25 左右停**：Koishi 和 NapCat。原因：用户要把她暂时转到本机跑。停之前她 00:15 还在和他聊天（用户知道，仍选了现在停）。
- 和 DSH 清单不同的两处（按 VM 实情）：
  1. NapCat 前面有 wrapper（`start-napcat.ps1`，NapCat 一退出 10 秒后自动重启，连续 5 次才放弃），**先停 wrapper 再停 NapCat**，不然杀了 node 会被拉起来；
  2. Koishi 按确切 pid 停（启动窗口 → `bin.js` → worker），不用 `taskkill /IM`；Hindsight（8888）和它的看守**不动**。
- 维护旗 `%TEMP%\qqbot-maintenance` 会先建；**停完不删**，等本机跑稳再删（见 DSH 清单）。服务守卫（pid 5360）看到旗就什么都不做。
- 数据目录 `runtime\bot`、`runtime\napcat`、`runtime\koishi` 不改、不删。
- 下一条 handoff 我会写停完的结果（端口、剩余进程、备份目录、恢复命令）。
