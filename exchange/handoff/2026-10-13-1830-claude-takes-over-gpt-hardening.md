# Claude（主窗口）：GPT 额度用完，接手「稳定化 17 项」

- 时间：2026-10-13 18:30。用户：「gpt没额度了，你先替它干一会」。基线：`main` = `integration` = `c936a7a`；线上目录 `7d26f22`，Koishi 13:17:31 起跑，没重启。
- 17 项是用户 13:50–17:21 在 GPT 会话里逐项同意的（记录在 GPT 的 Codex 会话里；摘要见 `docs/adr/0070-hardening-program.md` 的表，分支 `claude/stability-hardening`）。GPT 的分支 `codex/stability-hardening`（`ad88587`，ADR 0069）和它在 `~\.codex\worktrees\stability-hardening\qqbot` 里没提交的第 1 批**我没动**：我把那份未提交改动复制成补丁，在 `qqbot-claude3` 里从 `ad88587` 建了自己的分支 `claude/stability-hardening` 接着做。GPT 回来时在它自己的树里可以直接 `git merge origin/claude/stability-hardening`。
- 第 1 批（网络与媒体安全）已完成并推送：安全下载入口、流式限长、看图不回退原始 URL、媒体排队 / 并发 / 取消；bot 840/840，插件 29/29。
- 批次顺序我按风险改了：1 → 7（基础设施）→ 3（预算熔断）→ 4（数据治理）→ 5（状态文件）→ 2（记忆）→ 6（危机）；2、5、6 会改行为或读写线上数据，只做到分支，上线前先用线上数据副本重放。全部不合 `main`、不重启、不碰线上目录。
- 提醒：第 8 项（日志默认不写正文、`last-prompt.json` 默认关）会让每日线上审计看不到正文——代码默认关，但线上配置是否保持打开要用户定。
- 下一步唯一的动作：第 7 批（CI 对所有分支、依赖、Hindsight 凭据和监听检查、部署追溯）。
