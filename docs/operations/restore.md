# 备份恢复手册（四个阶段）

备份在 `runtime/backups/<日期>/`。新版 `.complete.json` 记录 `hindsight.sql` 与 `her-state.zip` 的大小和 SHA-256。状态包包含 Koishi 数据目录，以及 `dsh-state` 下按清单收录的 DSH 日记、账本、留话队列和常驻任务进度等。令牌、服务配置与日志不在备份范围内。恢复分四步走，前三步都能离线演练，**第四步会覆盖当前数据，只在拿到当次授权后手动做**。

面板上（系统 → 备份清单 → 分阶段）能点前三步，第四步只列出步骤、不会执行。

## 一、制品校验（不写盘）

```powershell
node --test scripts/dsh-restore-stages.test.mjs
node -e "const {createRestoreStages}=await import('./scripts/restore-stages.mjs');console.log(await createRestoreStages({root:'.'}).artifacts('2026-11-24'))"
```

检查完成标记、制品大小、源目录和 SHA-256。只记录大小的旧备份仍可做文件演练，但无法用完成标记验证同大小损坏。任何一项不符就停下，换前一份备份。

## 二、文件隔离恢复（只写临时目录）

```powershell
node scripts/restore-drill.mjs --backup runtime/backups/2026-11-24
```

把状态包解压到 `runtime/restore-drills/<时间戳>/`，做只读检查：不能出现 `logs` / `secrets` / `bot.lock` / `last-prompt.json` / `config*`，不能有符号链接，AI 照片草稿与视觉参考的哈希和格式都要对得上。检查完默认删掉临时目录，`--keep` 才保留。失败时目录整体删除，不留半成品。

新版还核对 `dsh-state/manifest.json`。其中 `soul`、`resident` 与 `outbox` 分别对应原灵魂目录、常驻目录和自定义留话文件。加密私密日记按原密文保存，解密仍依赖原 Windows 用户。

## 三、隔离数据库恢复（不连正式库）

```powershell
node -e "const {createRestoreStages}=await import('./scripts/restore-stages.mjs');console.log(await createRestoreStages({root:'.'}).database('2026-11-24'))"
```

把 `hindsight.sql` 复制进系统临时目录里的一次性假库（库名固定 `hindsight_restore_drill`），校验 dump 头部（`PGDMP` / `SET` / `CREA` / `--`），然后**只打印恢复命令、不执行**。真正的恢复在隔离的 PostgreSQL 实例里跑：

```powershell
node scripts/hindsight-restore-drill.mjs --backup runtime/backups/2026-11-24 --database-url $env:QQBOT_RESTORE_DATABASE_URL --confirm-isolated
```

SQL 导入使用单个事务。语句失败时回滚本次导入，避免留下半恢复的库。隔离实例里核对记忆条数、文档数和最近一次对话时间。对得上再进第四步。

## 四、正式切换（需要单独授权）

覆盖当前数据，不做自动执行。照下面的顺序手动来：

1. 确认本机与线上都在 `main`，制品校验、文件隔离恢复、隔离数据库恢复 三步都是绿的，行为基线 39/39 一致。
2. 停线上服务（`/休眠` 或运维手动停），确认没有新的写入。
3. 把 Koishi 配置中的数据目录改名留存。涉及 DSH 状态时也保留原灵魂目录、常驻状态及留话队列的副本。
4. 从隔离解压目录将 Koishi 数据放回配置指定位置。按清单把 `dsh-state` 中各文件放回原来的 DSH、常驻或自定义留话路径，再逐项核对。
5. 在隔离实例里恢复 `hindsight.sql`，核对记忆条数与最近对话，再切到正式库。
6. 启动服务，看运维事件与召回诊断各 10 行，确认没有 `failed`。
7. 一切正常后再删 `bot.before-restore-*` 与隔离实例；有异常就整体换回旧目录，不逐个文件修。

## 回滚

- 文件：把 `runtime/bot.before-restore-*` 改回 `runtime/bot`，重启。
- 数据库：正式库在切换前先打一份快照，回滚就是把它导回去；隔离实例保留到 48 小时观察结束。
- 演练残留：`runtime/restore-drills/` 下的目录都是临时的，确认没有正在跑的演练后可以直接删。

## 不要做的事

- 不在面板上找「正式切换」按钮——没有这个按钮，只有步骤。
- 不让备份脚本或恢复脚本去重启服务、写 `runtime/bot`。
- 不把 `her-state.zip` 直接解到 `runtime/bot` 上（先解到 `runtime/bot.before-restore-*` 旁边的新目录，核对完再替换）。
- 恢复过程中不跑 `npm test` 之类会写 `runtime/` 的命令。
