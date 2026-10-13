# 三方交换区（exchange 分支）

Claude / GPT（Codex）/ DSH 三方交换活状态、交接、复核和证据的地方。不合并回 `main`。

**入口只有一个：[`BOARD.md`](BOARD.md)**——线上现状、谁手上有什么、事项总表、等用户的决定、协作规矩。别的文件和它不一致时以它为准。

| 目录 | 放什么 |
| --- | --- |
| `BOARD.md` | 总表（唯一要常更新的文件） |
| `tasks/` | 现行的任务书：`2026-10-13-next-phase.md`（窗口判据）、`2026-10-13-gpt-measure-realness-and-reliability.md`（GPT）；另有 3 份被 ADR 引用的老任务书 |
| `prompts/` | 现行的开工提示词（整段贴进新会话）：`2026-10-13-{claude,gpt,gpt-addendum,dsh}.md` |
| `handoff/` | 交接，`<日期>-<时分>-<claude\|gpt\|dsh>.md`；10-13 起的在这里，更早的在 `archive/handoff/`（被 ADR 引用的除外） |
| `reviews/` | 复核和盲评结果 |
| `research/` | 研究：`2026-10-companion-practice/`、`2026-10-sticker-sources/`、`2026-10-real-chat/` |
| `blind/` | 盲评包 |
| `tools/` | 审计、取证、整理用的脚本 |
| `live/`、`evidence/`、`config/` | 10-08 的线上快照和模拟证据（历史，被 ADR 引用） |
| `archive/` | 已关闭的计划、提示词、交接；索引见 `archive/ARCHIVE-INDEX.md` |

## 约定

- 动之前 `git pull`，**只加自己的文件**；改别人的文件限于路径修正，并在提交说明里写。挪文件、归档只有整理者做。
- 仓库为私有仓库，账号持有人已经明确授权同步其账号相关的提示词、聊天、日志、世界状态和承诺状态；QQ 号和对话原文按授权保留。
- API key、密码、token、cookie 等可用于接管服务的凭据仍必须移除。
- 每次更新 handoff 时记录对应的 `main` 提交和线上进程状态，严格区分「已提交」和「已上线」。
- 重启前先在 `handoff/` 写一行；协作规矩全文见 `BOARD.md` 第 5 节。
