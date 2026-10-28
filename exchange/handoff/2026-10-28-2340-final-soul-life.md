# 2026-10-28 深夜 记忆 / 灵魂 / 连续生活 收尾

## 已推送

- 代码仓库 `dsh/qq-control`：`fa8c36e`（今天 36 个提交）；
- 本 handoff 在 `exchange`。

## 今天完成

### 记忆
- 三库：`linmengyao-a5db...`（宝宝私人）、`linmengyao-common`（QQ 公共）、`linmengyao`（DSH，已合并原 `-dsh`）；
- 混合写入：QQ 自动底账 + 她 `<<记住>>` / `<<日记>>` / `<<私密>>`；DSH 每轮自动写；
- 主动查询：`<<查：…>>` 三库召回后重写；
- 旧事实软失效：PATCH `invalidated`，observation 跳过；
- 私密日记 DPAPI 加密：`PRIVATE.dat`，查看脚本 `scripts/private-diary.ps1`。

### 灵魂
- `SOUL.md` 每轮注入 + `soul_read/update`（评分闸门）；
- `LEDGER.md` 12 条、`ledger_append/revise`；
- `JOURNAL.md` / `PRIVATE.dat` / `WISHES.md` / `INTERESTS.md`（她自己加/改/放弃）；
- `/好 /一般 /差` 评分影响 SOUL 与说话分寸；
- 拒绝：工作模式 pending，她可同意/拒绝/提条件，拒绝进 `REFUSALS.json`。

### 连续生活
- `scripts/her-life.mjs`：每 10 分钟 tick，精力/饥饿/心情/活动/事件/关系；
- 3 个 NPC（苏雨桐、鸽鸽、妈妈）随机事件；
- 关系 trust/resentment 会影响 `NOW.md` 里的行为提示；
- 常驻进程 `her-resident.mjs`：任务队列、wake/sleep、`go_offline`、`/note` 互动。

### 语言
- 形状只在接情绪/好事/亲近/撒娇/认真/问过去时给；
- 每轮明确“他最后说的是哪句”；
- 内部标记不进聊天历史，只有标记的气泡不发。

## 测试记录

- 睡眠整合：手动 `/sleep` 跑 361 秒成功，写公开日记、记忆文档 68→140；
- 自主醒来：`/wake` 65 秒，写私密日记、outbox 留话；
- 离线：`go_offline` 后 `/task` 返回“不在电脑前”；
- 关系：连催 3 次 `/工作` 后 `NOW.md` 出现“还在生他的气、可以拒绝”。

## 已知缺口

- DSH 桌面需重启才加载最新工具；
- 睡眠一次写太多记忆，已限 3 条但未复测；
- STORY 是摘要拼接，不是模型写的章节；
- 情绪只有关键词级 appraisal；
- 底账仍自动记。
