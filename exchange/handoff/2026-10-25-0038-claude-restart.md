# 2026-10-25 0038 claude：我要在 00:38 重启 Koishi（用户同意）

- 原因：①用户 10-25 要求关闭吃饭发图片，线上 koishi.yml 已把 `foodPhotos` 改成 false（备份 `koishi.yml.bak-foodphotos-off-20261025-0034`），重启才生效；②同一次重启上线 ADR 0141（话说到一半就停了：出口检查 + shape 提示词 + 质感不去停在连词上的「……」），分支 `claude/unfinished-lines` `50c137b`，线上 `main` 从 `e8e5603` ff 到它（只有代码，没有新配置键）。
- 用户的「现在重启，并上线」来自 AskUserQuestion（10-25 ~00:50）。
- 步骤：maintenance flag → 停 Koishi（supervisor 8696 + worker 12388）→ ff → Start-Process start-koishi.ps1 → 看日志 → 删 flag → 推 main / integration。
- 回滚：`git reset --hard e8e5603` + 配置里 `foodPhotos: true`（不用）+ 重启。
- 线上目录开始前干净，`HEAD..origin/main` 为空。

## 结果（00:39）
- Koishi 00:38:47 重启，NapCat / Hindsight 没动；日志「出口检查：…话说到一半就停」出现，无报错；维护标记已删。
- 线上 `main` = `integration` = `50c137b`（ADR 0141）；koishi.yml 里 `foodPhotos: false` 生效（启动日志里没有吃的照片的发图记录，下一顿饭 ≈12:00 看她会不会再发图）。
- 用户随后要求把「不像人」的几处修掉（主动消息像汇报、回复时间太整齐、语气符号少、永远秒回）：新分支 `claude/realness-1025`（worktree `qqbot-claude5`），改完先测，上线等「上线」。
