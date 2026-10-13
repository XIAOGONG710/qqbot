# Claude（主窗口）：GPT 额度用完，接手「稳定化 17 项」

- 时间：2026-10-13 18:30。用户：「gpt没额度了，你先替它干一会」。基线：`main` = `integration` = `c936a7a`；线上目录 `7d26f22`，Koishi 13:17:31 起跑，没重启。
- 17 项是用户 13:50–17:21 在 GPT 会话里逐项同意的（记录在 GPT 的 Codex 会话里；摘要见 `docs/adr/0070-hardening-program.md` 的表，分支 `claude/stability-hardening`）。GPT 的分支 `codex/stability-hardening`（`ad88587`，ADR 0069）和它在 `~\.codex\worktrees\stability-hardening\qqbot` 里没提交的第 1 批**我没动**：我把那份未提交改动复制成补丁，在 `qqbot-claude3` 里从 `ad88587` 建了自己的分支 `claude/stability-hardening` 接着做。GPT 回来时在它自己的树里可以直接 `git merge origin/claude/stability-hardening`。
- 第 1 批（网络与媒体安全）已完成并推送：安全下载入口、流式限长、看图不回退原始 URL、媒体排队 / 并发 / 取消；bot 840/840，插件 29/29。
- 批次顺序我按风险改了：1 → 7（基础设施）→ 3（预算熔断）→ 4（数据治理）→ 5（状态文件）→ 2（记忆）→ 6（危机）；2、5、6 会改行为或读写线上数据，只做到分支，上线前先用线上数据副本重放。全部不合 `main`、不重启、不碰线上目录。
- 提醒：第 8 项（日志默认不写正文、`last-prompt.json` 默认关）会让每日线上审计看不到正文——代码默认关，但线上配置是否保持打开要用户定。
- 下一步唯一的动作：第 7 批（CI 对所有分支、依赖、Hindsight 凭据和监听检查、部署追溯）。

## 18:50 进度（第 1、7、3、4 批已完成并推送）

分支 `claude/stability-hardening`（`400b423`），bot 861/861、插件 29/29、依赖审计门通过；ADR 在 `docs/adr/0070-hardening-program.md`（每批一节）。线上没动、没重启。
- 第 1 批：图片安全下载入口（SSRF / 流式限长 / 不回退原始 URL）+ 媒体排队、并发、取消。
- 第 7 批：依赖审计门 + 基线、监听检查、上线前检查脚本（`npm run golive-check -w packages/bot`）、CI 对所有分支、Hindsight 口令走环境变量（轮换步骤只写了没做）。
- 第 3 批：模型调用总闸（并发 4 / 后台 2、日额度 4000、连续 5 次没连上熔断）。
- 第 4 批：日志默认不写聊天正文、`last-prompt.json` 默认不留（`QQBOT_SENSITIVE_LOGS`）、日志一行一条、联系人导出和回收式遗忘。
- **还没做、会改行为或读写线上数据，先不写代码，等用户看设计**：第 5 批（状态文件 schema / 迁移 / 历史缓存）、第 2 批（记忆：公共库筛选、控制性记忆不当指令）、第 6 批（危机识别分级；我自己的 `crisis.ts`，GPT 指出的「我没事」先于同条危机词的问题成立）。
- 上线时要用户定：线上服务环境是否设 `QQBOT_SENSITIVE_LOGS=on`（不设，日常线上审计就看不到正文了）。
