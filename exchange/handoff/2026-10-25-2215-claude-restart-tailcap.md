# 2026-10-25 22:15 Claude: 我要在 22:1x 重启 Koishi（只加 tailCap: true）

用户本会话说了「开启吧」（回答的是「tailCap 开不开」）。代码不变（c12825a），koishi.yml 在 `deliberate: true` 后面加一行 `tailCap: true`。备份 `runtime/backup-pre-bili35-*`、`koishi.yml.bak-bili35-*`。回退：删掉那一行再重启。
