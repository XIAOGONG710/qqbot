# 归档索引

- 整理时间：2026-10-13（用户：「先整合归档整理一下」）。用 `git mv` 挪的，历史和内容都在，要拿回来就挪回原路径。
- 挪走的标准：10-12 及以前的、**没被 `docs/adr/`、`docs/reports/` 按路径引用**的交接、计划、提示词。被引用的老文件原地不动（`BOARD.md` 第 7 节），等有上线时顺手改引用再挪。
- exchange 里互相引用这些文件的路径已一并改成 `archive/...`；旧 README 原样留在 `README-history-to-2026-10-13.md`（里面的路径是挪之前的，没改）。
- 旧 README = 10-08 到 10-12 的流水账（DSH 读取顺序、各批交付表、盲评进度等），现在的入口是 `../BOARD.md`。

| 原路径 | 现路径 | 标题 |
| --- | --- | --- |
| `handoff/2026-10-08-2141.md` | `archive/handoff/2026-10-08-2141.md` | 活状态交接：2026-10-08 21:41 |
| `handoff/2026-10-09-0005.md` | `archive/handoff/2026-10-09-0005.md` | 活状态交接：2026-10-09 00:05（Claude） |
| `handoff/2026-10-09-0015-dsh.md` | `archive/handoff/2026-10-09-0015-dsh.md` | DSH → Claude：真人聊天调研任务书的三个阻塞问题 |
| `handoff/2026-10-09-0930.md` | `archive/handoff/2026-10-09-0930.md` | 交接：10-09 上午（Claude） |
| `handoff/2026-10-09-1445.md` | `archive/handoff/2026-10-09-1445.md` | 交接：10-09 14:45（Claude → GPT / Codex） |
| `handoff/2026-10-09-2150-dsh.md` | `archive/handoff/2026-10-09-2150-dsh.md` | DSH → Claude / GPT：T1 第 1 批（号 1 / 号 2 语料答 A、B、C） |
| `handoff/2026-10-09-2315-dsh.md` | `archive/handoff/2026-10-09-2315-dsh.md` | DSH → Claude / GPT：T1 第 2 批（30 段聊天截图小样 + 统计） |
| `handoff/2026-10-09-2355-dsh.md` | `archive/handoff/2026-10-09-2355-dsh.md` | DSH → Claude：收尾样本另开渠道（裁决 §3 第 1 条）+ 原始数据已删（ |
| `handoff/2026-10-10-0020-dsh.md` | `archive/handoff/2026-10-10-0020-dsh.md` | DSH → Claude：T2 盲评题库 v1 |
| `handoff/2026-10-10-0140-claude.md` | `archive/handoff/2026-10-10-0140-claude.md` | Claude → DSH / Codex：DSH 停工期间代做的 T2 / T3 |
| `handoff/2026-10-10-0145-claude.md` | `archive/handoff/2026-10-10-0145-claude.md` | Claude → GPT / Codex：见面可以答应（ADR 0046）、约好的见面进她的一天 |
| `handoff/2026-10-10-1245-dsh.md` | `archive/handoff/2026-10-10-1245-dsh.md` | DSH → Claude / Codex：对 T2 v1.1 与 T3 草稿的意见 |
| `handoff/2026-10-10-1330-claude.md` | `archive/handoff/2026-10-10-1330-claude.md` | Claude：13:28 上线了 release-1010b |
| `handoff/2026-10-10-1520-claude.md` | `archive/handoff/2026-10-10-1520-claude.md` | Claude：15:17 上线了 N3（真人聊天调研的 P1–P4、P6） |
| `handoff/2026-10-10-1545-claude.md` | `archive/handoff/2026-10-10-1545-claude.md` | Claude：G1 接着做完了、G3 答复；N4 / N5、题库 v1.2 |
| `handoff/2026-10-10-2105-dsh.md` | `archive/handoff/2026-10-10-2105-dsh.md` | DSH → Claude / Codex：H（手写参考）交稿 |
| `handoff/2026-10-10-2220-dsh.md` | `archive/handoff/2026-10-10-2220-dsh.md` | DSH：两件挂给用户的，我自己查清了 —— 一件是**卡点不存在**，一 |
| `handoff/2026-10-10-2310-dsh.md` | `archive/handoff/2026-10-10-2310-dsh.md` | DSH → GPT / Codex：她现在的日常是怎么实现的（静态核实）+ 三条操作 |
| `handoff/2026-10-10-2320-dsh.md` | `archive/handoff/2026-10-10-2320-dsh.md` | 用户裁决：记忆**可以开**，但跑在虚拟机上、内存不够，**暂时不开 |
| `handoff/2026-10-11-0005-claude.md` | `archive/handoff/2026-10-11-0005-claude.md` | Claude → GPT / Codex / DSH：10-10 夜里三次上线，和一条写提示词的教训 |
| `handoff/2026-10-11-0035-claude-to-gpt.md` | `archive/handoff/2026-10-11-0035-claude-to-gpt.md` | Claude → GPT / Codex：一起干活的分工（用户 10-11 00:16 对两边都说了「� |
| `handoff/2026-10-11-1020-dsh.md` | `archive/handoff/2026-10-11-1020-dsh.md` | DSH：Claude Code 09:53 断了；我够不到那台 VM——所以能接的和接不了的 |
| `handoff/2026-10-11-1035-claude.md` | `archive/handoff/2026-10-11-1035-claude.md` | Claude：我回来了（10:30 新会话）——和 GPT 一起干，分工如下 |
| `handoff/2026-10-11-2030-claude-first-photo.md` | `archive/handoff/2026-10-11-2030-claude-first-photo.md` | Claude：第一张真照片的看图全链路：还没有照片 |
| `handoff/2026-10-11-2030-claude-live-tree.md` | `archive/handoff/2026-10-11-2030-claude-live-tree.md` | Claude：live 树没有未提交改动，不建分支 |
| `handoff/2026-10-11-2100-claude.md` | `archive/handoff/2026-10-11-2100-claude.md` | Claude：`076318e` 已上线（21:16）——主动消息断网再试 + 守护查外网 |
| `handoff/2026-10-11-2230-claude.md` | `archive/handoff/2026-10-11-2230-claude.md` | Claude：没说成的事睡前顺带说 + 相机钱的来历（分支 `untold-news`，等� |
| `handoff/2026-10-11-2350-claude-to-gpt.md` | `archive/handoff/2026-10-11-2350-claude-to-gpt.md` | Claude → GPT：你 23:11–23:35 那批被我带进了线上目录（卡已热加载） |
| `handoff/2026-10-12-1045-claude.md` | `archive/handoff/2026-10-12-1045-claude.md` | Claude：下一阶段开工（10-12 上午） |
| `handoff/2026-10-12-1115-claude.md` | `archive/handoff/2026-10-12-1115-claude.md` | Claude：白天这一段（M3 → ADR 0062 草稿、ADR 0061 骨架、盲评先不出） |
| `handoff/2026-10-12-1245-dsh.md` | `archive/handoff/2026-10-12-1245-dsh.md` | DSH：K1 + K2 已推（语料 v2 格式待审）——K3 等你们审过格式、用户单 |
| `handoff/2026-10-12-1302-dsh.md` | `archive/handoff/2026-10-12-1302-dsh.md` | DSH：按 Claude 复核改完 K1/K2 并重推；K3 卡在本机没有采集工具（要用 |
| `handoff/2026-10-12-1325-dsh.md` | `archive/handoff/2026-10-12-1325-dsh.md` | DSH：K3 第一次开跑就撞平台设备限制，按规矩当天停（没采到数据） |
| `handoff/2026-10-12-1345-dsh.md` | `archive/handoff/2026-10-12-1345-dsh.md` | DSH：K3 换号已授权并登录通过，采集按规则压到明天（降速 + 冷却闸 |
| `handoff/2026-10-12-1410-claude.md` | `archive/handoff/2026-10-12-1410-claude.md` | Claude：下午（14:10）——今晚上线的东西备好了；两处线上疑点 |
| `handoff/2026-10-12-1410-dsh.md` | `archive/handoff/2026-10-12-1410-dsh.md` | DSH：K3 第一批（试采）已推 5 段；采集通道当前被平台挡住，等你们 |
| `handoff/2026-10-12-1445-dsh.md` | `archive/handoff/2026-10-12-1445-dsh.md` | DSH：按 Claude 的 K3 复核改完（占位符口径 / 暧昧标签 / 不再求头像 /  |
| `handoff/2026-10-12-1505-dsh.md` | `archive/handoff/2026-10-12-1505-dsh.md` | DSH：号 1 / 号 2 表情包频率算完（K4），只出数字 |
| `handoff/2026-10-12-1515-dsh.md` | `archive/handoff/2026-10-12-1515-dsh.md` | DSH：K3 第二批已推（4 段，其中 2 段是最缺的场景 9）；这一轮用「� |
| `handoff/2026-10-12-1740-claude.md` | `archive/handoff/2026-10-12-1740-claude.md` | Claude → GPT / DSH：表情包「她自己下载」恢复了，来源和接线说明 |
| `handoff/2026-10-12-1745-dsh.md` | `archive/handoff/2026-10-12-1745-dsh.md` | DSH：按 Claude 17:21 复核改完（错数、三处口径、做法撤回）；三件事� |
| `handoff/2026-10-12-1845-dsh.md` | `archive/handoff/2026-10-12-1845-dsh.md` | DSH：K3 最后一批跑完（+4 段，累计 49）；顺带发现「几个格子为什么 |
| `handoff/2026-10-12-1900-dsh.md` | `archive/handoff/2026-10-12-1900-dsh.md` | DSH：K6 交付（ChineseBQB 剩余 98 类判定）＋ K3 最后一批已收尾 |
| `handoff/2026-10-12-2045-claude-companion-practice-A.md` | `archive/handoff/2026-10-12-2045-claude-companion-practice-A.md` | Claude：陪伴实践调研 · A 块（开源项目一行版总表）已交，停在这里 |
| `handoff/2026-10-12-2055-claude-companion-practice-B.md` | `archive/handoff/2026-10-12-2055-claude-companion-practice-B.md` | Claude：陪伴实践调研 · B 块（主动性）已交，停在这里 |
| `handoff/2026-10-12-2102-claude-companion-practice-C.md` | `archive/handoff/2026-10-12-2102-claude-companion-practice-C.md` | Claude：陪伴实践调研 · C 块（记忆与遗忘）已交，停在这里 |
| `handoff/2026-10-12-2108-claude-companion-practice-D.md` | `archive/handoff/2026-10-12-2108-claude-companion-practice-D.md` | Claude：陪伴实践调研 · D 块（关系阶段与摩擦）已交，停在这里 |
| `handoff/2026-10-12-2114-claude-companion-practice-E.md` | `archive/handoff/2026-10-12-2114-claude-companion-practice-E.md` | Claude：陪伴实践调研 · E 块（翻车与红线）已交，停在这里 |
| `handoff/2026-10-12-2117-claude-companion-practice-options.md` | `archive/handoff/2026-10-12-2117-claude-companion-practice-options.md` | Claude：陪伴实践调研 · options.md 已交，等用户挑 |
| `handoff/2026-10-12-2126-claude-adr-drafts.md` | `archive/handoff/2026-10-12-2126-claude-adr-drafts.md` | Claude：用户挑了 B1 C1 D1 E1 E2，ADR 0064–0068 已起草（提议状态，在分� |
| `handoff/2026-10-12-2143-claude-adr-0067-implemented.md` | `archive/handoff/2026-10-12-2143-claude-adr-0067-implemented.md` | Claude：用户回答了前提（两位都知道、都成年）→ ADR 0067 已实现（� |
| `handoff/2026-10-12-2156-claude-adr-0067-live.md` | `archive/handoff/2026-10-12-2156-claude-adr-0067-live.md` | Claude：ADR 0067 已上线（2026-10-12 21:54） |
| `handoff/2026-10-12-2215-claude-claim-adr-0068.md` | `archive/handoff/2026-10-12-2215-claude-claim-adr-0068.md` | Claude（主窗口）：认领 ADR 0068 的实现；其余几份提议 ADR 的待确认我 |
| `handoff/2026-10-12-2255-claude-adr-0068-ready.md` | `archive/handoff/2026-10-12-2255-claude-adr-0068-ready.md` | Claude：ADR 0068（危机回应）实现好了，等用户同意重启；其余提议 ADR |
| `handoff/2026-10-12-2312-claude-research-window-checks-0011-0007.md` | `archive/handoff/2026-10-12-2312-claude-research-window-checks-0011-0007.md` | Claude（做调研 + ADR 0067 的那个窗口）：两个小核对的结果；没改代码 |
| `handoff/2026-10-12-2325-claude-research-window-claims-adr-0064.md` | `archive/handoff/2026-10-12-2325-claude-research-window-claims-adr-0064.md` | Claude（调研窗口）：认领 ADR 0064 的实现 |
| `prompts/2026-10-12-claude.md` | `archive/prompts/2026-10-12-claude.md` | Claude 开工提示词（下一阶段，10-12 起） |
| `prompts/2026-10-12-dsh-research.md` | `archive/prompts/2026-10-12-dsh-research.md` |  |
| `prompts/2026-10-12-dsh.md` | `archive/prompts/2026-10-12-dsh.md` | DSH 开工提示词（下一阶段，10-12 起） |
| `prompts/2026-10-12-gpt.md` | `archive/prompts/2026-10-12-gpt.md` | GPT / Codex 开工提示词（下一阶段，10-12 起） |
| `prompts/2026-10-12-relay-dsh.md` | `archive/prompts/2026-10-12-relay-dsh.md` |  |
| `prompts/2026-10-12-relay-gpt.md` | `archive/prompts/2026-10-12-relay-gpt.md` |  |
| `tasks/2026-10-12-dsh-companion-practice-research.md` | `archive/tasks/2026-10-12-dsh-companion-practice-research.md` | 任务书：别人的陪伴型产品和社区是怎么做的（只读调研，第二轮） |
| `tasks/2026-10-12-dsh-corpus-n2.md` | `archive/tasks/2026-10-12-dsh-corpus-n2.md` | 给 DSH 的任务：真人聊天语料库做大、做细（长期计划 N2） |
| `tasks/2026-10-12-next-phase.md` | `archive/tasks/2026-10-12-next-phase.md` | 下一阶段（10-12 起）：账上的日子进她的话，别人也开始过日子 |
| `README.md`（旧） | `archive/README-history-to-2026-10-13.md` | 三方交换区的旧入口 |
