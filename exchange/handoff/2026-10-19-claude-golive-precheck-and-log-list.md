# 10-19 17:20 上线前检查（只读）和待删日志清单（Claude）

给今晚 21:15 之后的 B 上线用（流程见 `2026-10-19-claude-golive-runbook.md`）。以下全是只读核对，线上没动。

## 一、上线前检查（runbook 第 0 节）

| 项 | 结果（10-19 17:15） |
| --- | --- |
| 线上目录 | `main` = `68c79d1`，`git status` 干净，`HEAD..origin/main` 空 |
| B 候选 | `claude/release-1019a` = `dfd8360`，没有新提交（所以 10-18 22:20 的 bot 967/967、插件 29/29、工具 43/43 仍然有效，不用重跑） |
| B 的改动文件 | 只有 `packages/bot/src`（app / contact / exit-check / onebot / proactive-planner / proactive / promises / responder / sensitive / sim/runner / stickers）、对应测试、`docs/sensitive-logs.md`；**没有 `characters/`、没有配置改动** |
| 心跳 | 线上 Koishi 进程 10-17 21:15 起，心跳每分钟更新，`lastMessageAt` 17:00 前后（今天的探针期间她照常回了话） |
| NapCat 账号 | 在线的是 **2561299676（繁星）**，所以 `fileLogLevel` 要改的是 `runtime\napcat\workdir\config\napcat_2561299676.json`（现在是 `debug`，`consoleLogLevel` 是 `info`）；同目录的 `napcat_1024095976.json` 是另一个账号的，**不要动** |
| packet 服务 | 10-19 16:52 探针验过可用（`nc_get_packet_status` ok）；NapCat 重启后这一项也要再看一眼（探针 `--steps login,packet`） |

## 二、待删日志清单（runbook 第 3 节；先给你看，你点头才删，只删日志文件）

**Koishi**：`runtime\koishi\data\logs\*.log` 共 98 个文件，约 1.7 MB，从 `2026-10-04-1.log`（10-05 03:26）到 `2026-10-19-1.log`（当前这个，B 上线重启后就不再写）。里面有 B 之前的聊天正文。

**NapCat**：`runtime\napcat\workdir\logs\*.log` 共 5 个，约 2.5 MB：

| 文件 | 大小 | 最后写入 |
| --- | --- | --- |
| `2026-10-10_09-39-55.610.log` | 1.27 MB | 10-11 19:57 |
| `2026-10-11_20-29-35.813.log` | 166 KB | 10-12 09:39 |
| `2026-10-12_12-23-37.562.log` | 827 KB | 10-15 03:23 |
| `2026-10-15_11-30-03.437.log` | 141 KB | 10-17 02:30 |
| `2026-10-17_21-14-15.154.log` | 152 KB | 现在还在写（NapCat 重启后换新文件） |

**不碰**：`runtime\bot\chats`（聊天记录）、记忆、日记、`runtime\koishi\data\` 里除 `logs\` 以外的一切。磁盘还有 86 GB 空闲，删日志不是为了腾空间，只是为了不留正文。

另外：今天的探针报告 `qqbot-claude2\runtime\probe\1019-1.json`、`1019-2.json` 不含正文，可留可删。

## 三、窗口复核（Koishi 日志，10-17 21:15 至 10-19 17:15）

`2026-10-17-1.log`、`2026-10-18-1.log`、`2026-10-19-1.log` 里 `错误`、`拒绝启动`、`模型总闸`、`DNS 兜底`、`[E]`、`[W]` 都是 0 条。网络探针和守护日志里的断网段（10-18 约 17.5 小时）是宿主机侧，已知，不算代码问题。窗口到 21:15，之后可以按 runbook 走。
