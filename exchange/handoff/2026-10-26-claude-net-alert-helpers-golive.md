# 2026-10-26 Claude：我要重启服务守护进程（上线 claude/net-alert-helpers，ADR 0165）

用户本会话说了「上线吧，以后断网就发送」。**只重启 services-watchdog 这一个进程，不重启 Koishi / NapCat / Hindsight。**

- 线上 6618885 -> 快进到 `claude/net-alert-helpers`（只改 `ops/alert-qq.ts`、`scripts/services-watchdog.mjs`、文档、测试；Koishi 不加载这些）
- `runtime/bot/alert.json` 加 `helpers`（鸽鸽的 QQ；已先备份成 `alert.json.bak-helpers-*`）；回退 = 删掉 `helpers` 那一项，或恢复备份
- 断网（最近 10 次里 7 次连不上）那一刻，除了给宝宝的【运维提醒】，鸽鸽收到一句她自己说的「鸽鸽，我这边断网了，连不上外网，现在回不了消息。」；恢复时不发给他
- 重启后检查：新守护进程在跑、3001 / 5140 / 8888 还通、Koishi 进程没变
