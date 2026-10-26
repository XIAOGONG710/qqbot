# 2026-10-26 Claude: 我要重启 Koishi（上线 claude/continuity，ADR 0157–0163）

用户本会话说了「按照你的推荐来」（回答的是「上线哪几个」，推荐 = identityLedger、memoryAudit、timeline、webLookup: explicit）。线上 aa5e923 -> 6618885（快进，只有 packages 和 docs），koishi.yml 在 `tailCap: true` 后加四行。dormancy / tastes / acquaintances 保持关。备份 `runtime/backup-pre-bili38-*`、`koishi.yml.bak-bili38-*`。回退：删掉那四行重启；整体回退 `git reset --hard aa5e923`。
