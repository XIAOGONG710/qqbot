# 2026-10-25 22:00 Claude: 我要在 22:0x 重启 Koishi（上线 claude/human-videos）

- 用户本会话说了「上线」。线上 00f141d -> bb3f77e（快进，origin/main 没有别人的新提交）：ADR 0146–0154。
- 角色卡会变（人设微调：搞笑女 / 会想事情 / 看场合嘴硬 / 说话带废话），koishi.yml 加三行：`shapeAsk: true`、`shapeLong: true`、`deliberate: true`。
- `tailCap`、`deviceControl` 保持关。备份：`runtime/backup-pre-bili34-*`、`koishi.yml.bak-bili34-*`。
- 回退：`git reset --hard 00f141d` + 还原 yml + 重启。
