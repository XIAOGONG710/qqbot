# 2026-10-25 23:40 Claude: 我要在 23:4x 重启 Koishi（上线 /主动 命令）

用户本会话说了「现在上线并重启」（回答的是「要让她现在主动找你，需要重启一次吗」）。线上 c12825a -> 0f2affb（快进，只有 packages/bot/src、test 和 docs），无配置改动。备份 `runtime/backup-pre-bili36-*`。回退：`git reset --hard c12825a` + 重启。
