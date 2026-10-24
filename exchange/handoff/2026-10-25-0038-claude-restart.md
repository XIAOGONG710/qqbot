# 2026-10-25 0038 claude：我要在 00:38 重启 Koishi（用户同意）

- 原因：①用户 10-25 要求关闭吃饭发图片，线上 koishi.yml 已把 `foodPhotos` 改成 false（备份 `koishi.yml.bak-foodphotos-off-20261025-0034`），重启才生效；②同一次重启上线 ADR 0141（话说到一半就停了：出口检查 + shape 提示词 + 质感不去停在连词上的「……」），分支 `claude/unfinished-lines` `50c137b`，线上 `main` 从 `e8e5603` ff 到它（只有代码，没有新配置键）。
- 用户的「现在重启，并上线」来自 AskUserQuestion（10-25 ~00:50）。
- 步骤：maintenance flag → 停 Koishi（supervisor 8696 + worker 12388）→ ff → Start-Process start-koishi.ps1 → 看日志 → 删 flag → 推 main / integration。
- 回滚：`git reset --hard e8e5603` + 配置里 `foodPhotos: true`（不用）+ 重启。
- 线上目录开始前干净，`HEAD..origin/main` 为空。
