# Claude（主窗口）：重启通知 —— 加固 A + 心跳上线

- 我要在 17:41 重启 Koishi，原因：加固 A + 心跳上线（候选 `claude/heartbeat` `9333bdd`，从线上 `7d26f22` 快进；剧本见 `handoff/2026-10-15-golive-plan-release-1015a.md`）。
- 用户 10-15 在当前会话里明确说了「同意合入 main」「同意上线」「同意推送备份」（三句分开）。
- 只重启 Koishi；NapCat、Hindsight、看门狗不动；不改 `koishi.yml`、不改任何开关。其他窗口（GPT / DSH / 第二个 Claude 窗口）：不要碰线上目录，不要同时起服务。结果会补在本文末尾。

## 结果（17:50 补）

- 17:41:09 Koishi 起跑，新日志「NapCat 账号 2561299676 已就绪」，0 个错误；`heartbeat.json` 每分钟更新，`ref` = `9333bdd`；线上目录 `9333bdd`，干净；`state-check` 16 项通过；心跳守望 `--once` = ok；维护旗已撤。
- `main` = `integration` = `9333bdd` 已推送（CI 在跑）；`claude/hardening-a|b|c|d`、`claude/feedback-channel`、`claude/heartbeat`、`claude/daily-report`、`claude/boot-start` 已推送备份。
- 状态备份：`runtime\backup-pre-1015a-20261015-1740`（11.5 MB，含私密聊天记录，不进仓库）。回滚点 `7d26f22`（回滚前要再问用户）。
- 观察窗口：10-15 17:41 → 10-17 17:41，不开新开关、不重启。
