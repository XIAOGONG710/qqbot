# 运维脚本审查（备份、服务守护）——2026-11-26

范围：`scripts/backup.mjs`、`scripts/backup-state.mjs`（删旧备份）、`scripts/services-watchdog.mjs`（拉起、停进程树、告警）。主代理自己看的，没开子代理；**没有要修的**，记下来免得以后重复审。

## 看过、守得住的

- **备份不出本机**：放在 `runtime/backups/<日期>/`，保留 7 天；没有任何上传。Hindsight 用 `pg_dump` 连 127.0.0.1:5433，状态目录用 PowerShell `Compress-Archive -LiteralPath` 打包，路径按 PowerShell 单引号规则转义（`'` → `''`）。
- **删旧备份只删日期目录**：`prune()` 只看 `^\d{4}-\d{2}-\d{2}$` 的目录名；`backupDirectoriesToPrune` 总留最近 7 份**完整**的备份（有完成标记的），哪怕它们比 7 天老——连着几天备份失败也不会把最后几份好的删光。
- **守护只恢复同一版代码**：不 `git pull`、不 `npm install`、不改配置；挂了才拉起（连续 2 次检查不正常），同一服务 10 分钟内 3 次还不行就停手留日志。维护时建 `%TEMP%\qqbot-maintenance` 目录它就什么都不动。
- **拼 PowerShell 的地方**：`openWindow` 的服务名是写死的常量，路径转义过；`processes()` 的命令是固定字符串。
- **告警发 QQ 默认关**：只有线上数据目录的 `alert.json` 里 `enabled: true` 且写了 `qq` 才发（`packages/bot/src/ops/alert-qq.ts`）。

## 后续（11-26 21:32，DSH 61373580，claude 审过）

- 备份也收 DSH 状态：`dsh-state/` 下按**写死的白名单**收她的灵魂目录（SOUL / LEDGER / JOURNAL / 账本 / 收件箱 / 评分 / 拒绝过的）、`PRIVATE.dat`（原密文，解密仍要原 Windows 用户）、留话队列和常驻任务进度；令牌、服务配置、日志不收；符号链接拒绝，清单对不上就报错（`scripts/backup-desktop-state.mjs`）。
- 完成标记加 SHA-256（同大小损坏也查得出），完成标记和 `hindsight.sql` 都先写临时文件再改名。仍只在本机，上面「不出本机」的结论不变。
- 恢复手册（`docs/operations/restore.md`）跟着改了：恢复时 DSH 那几份也要放回原路径。test:scripts 228/228。

## 记一笔（低，不改）

- **认 Koishi 进程只看命令行里有没有 `node_modules/koishi/`**（`services-watchdog.mjs:281`），不看是不是本仓库目录下的。同一台机器上要是另有一份检出起了 Koishi，也会被当成这一份：算「进程在」，或者在「断开不回连」时被一起 `taskkill /T`。CLAUDE.md 规定只有一个工作目录，现在碰不上；以后要是有第二份检出，把正则改成带上 `root`。
- **守护拉起也算「上线」**：快进了线上目录却没重启时，守护哪天自己拉起就把新代码带上线了。`golive-check` 已经写明（「守护自己拉起也算」），部署手册的流程是快进后立即按计划重启，所以不另改。
- 备份是不加密的 zip，和数据在同一块盘上：防的是「Hindsight 挂了 / 文件写坏」，不防「这台机器丢了」。要防后者得另做离机加密备份，属于新功能，用户要时再说。
