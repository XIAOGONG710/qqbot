# Claude（主窗口）：接手 GPT 任务书的 T1 / T2 / T3b / T3c，四个分支都只在本地

- 时间：2026-10-15 12:40。基线：`main` = `integration` = `c936a7a`；线上目录 `7d26f22`（干净，服务 11:46 已恢复，没动代码）。四个分支都从 `origin/main`（`c936a7a`）起，**没推送、没合 main、没上线、没重启**；工作目录 `qqbot-claude2`（现在停在 `claude/boot-start`）。
- 用户 10-15 说「先继续往下做功能」，我按 `tasks/2026-10-13-gpt-measure-realness-and-reliability.md`（GPT 额度没恢复，Claude 接手）的顺序做。

| 分支 | 提交 | 内容 | 验证 |
| --- | --- | --- | --- |
| `claude/feedback-channel` | `eaf8949`（已叠在 A 上，原 `1bf4069`） | **T1 反馈通道**（ADR 0073）：男朋友档只发「假」/「像」一个字（可带 `/`、标点、一个小黄脸、QQ 回复引用）→ 记进 `feedback/YYYY-MM.jsonl`，不进聊天记录、她不回应、不触发主动计划；实时收和停机后补回两条路都处理，同一消息 id 只记一次；找不到被评价的那一轮（没引用且超 30 分钟、她没说过话）当普通消息；摘要 `npm run feedback-digest`。新开关 `feedbackCommands` **默认关** | bot 844/844、角色工具 43、插件 29，类型检查通过；feedback 11 + digest 3 + app 5 个新测试 |
| `claude/daily-report` | `ac3c9ba` | **T2 每日原始数报告**：`npm run daily-report -w packages/bot -- <日期>`，只读，量 / 表层 / 她过的事 vs 她说起的事 / 反馈 / 服务日志计数；**不评分、不放聊天原话**；他一条没发的日子也有。已在 10-13、10-14 的线上数据上只读跑过，数字合理 | bot 829/829、43、29；4 个新测试 |
| `claude/boot-start` | `73701d2` | **T3c 开机拉起**：`scripts/start-services-at-boot.ps1`（逐步先看是否已在跑、只补缺的；`-DryRun`；看门狗放前台让任务活着；默认跳过 Hindsight 启动时的模型自检）+ `scripts/install-services-tasks.ps1`（默认只打印计划，`-Install` 弹凭据框要 Windows 密码，`-Uninstall` 回滚）+ `docs/boot-start.md` | 两个脚本 ASCII + 解析无错；`-DryRun` 在线上服务都在跑时每步都「不动」，新维护旗退出、旧维护旗当遗留。**没装、没真重启验证**——NapCat 在无桌面会话的任务里能否登录要第一次真重启才知道 |
| `claude/heartbeat` | `9333bdd`（已叠在 A 上，原 `2e34f91`） | **T3b 心跳**：机器人每分钟写 `heartbeat.json`（只有时间、进程号、提交、启动时间、最近连上 / 收到消息的时间，没有聊天内容）；`npm run heartbeat-watch -w packages/bot` 超过 15 分钟没更新就告警（控制台 + `ALERT.txt`，可选 `QQBOT_ALERT_COMMAND` 推送，默认不推送；维护旗免检；没有文件不算故障）。**要等机器人重启才开始写**；守望命令也要有人起，不会自己在重启后起来 | bot 833/833、43、29；心跳 7 个新测试（含命令行 `--once` 的告警 / 恢复 / 推送命令）+ app 1 个 |

- 空跑时抓到并修了一个 bug：PowerShell 函数返回单个元素会被拆成单个对象，`.Count` 为空，单个进程被当成「没在跑」——调用处都用 `@()`。
- 没做：T3a 的 `restarts.log` 和 48 小时拦截（A 候选里的 `golive-check` 是只读版）；T4 两份设计 ADR（0071 / 0072 留着）。
- ADR 编号：`0073` 是 T1；`0071`、`0072` 仍留给 T4。
- DeepSeek 补全接口 12:35 恢复（3.8 秒）；11:37–12:0x 排队不出 token，Hindsight 因此带跳过自检的环境变量起（见 `handoff/2026-10-15-restore-notice-claude.md`）。

## 下一步唯一的动作

窗口结束（13:17）后一起问用户：A 组合入 `main` 和上线（`claude/hardening-a`）、`feedbackCommands` 的字和什么时候开（建议 A 组看满 48 小时之后）、是否装开机任务（要 Windows 密码，或先限制自动重启）。

## 13:05 补：加固的 B、D 已拆出，几个分支叠在一起的试合并通过

| 分支 | 提交 | 内容 |
| --- | --- | --- |
| `claude/hardening-a` | `91fa05e` | A 组（见 `handoff/2026-10-15-0945-claude-hardening-a-candidate.md`），从 `c936a7a` 起 13 个提交 |
| `claude/hardening-b` | `01c2366`（在 A 上 1 个提交） | **B**：聊天正文和完整提示词默认不进日志和 `last-prompt.json`（`QQBOT_SENSITIVE_LOGS=on/15m/2h` 才开）。bot 903/903、43、29。**B 上线后我对线上的日审计要改读 `chats/*.jsonl`，不再读日志正文** |
| `claude/hardening-d` | `275bd94`（在 A 上 1 个提交） | **D**：危机分级 + 解除要「此刻安全」「现实中有人 / 已联系」两样证据，单说「开玩笑的 / 我没事」不解除（取自 `8774041`，只有 ADR 文档冲突）。bot 906/906、43、29。**上线前要给用户看新的解除规则** |
| C | 还没拆 | 公共记忆 v2 + 来源账 + 日记 schema / 旧日记重放 + 记忆进度 schema（`f355a24` `6184a88` 与 `05e53eb` `8240c0c` `dbb8187` `e3a3bc9` 的 C 部分）。最复杂，上线顺序里排在 B 之后 |
| `trial-all` | `18b2039`（临时，用完删） | A + B + D + 反馈通道 + 心跳 + 日报 + 开机拉起 的试合并：只有「两边都往文件末尾 / 同一处加东西」的琐碎冲突，已解；类型检查通过，全量测试见下 |

## 18:35 补：窗口审计、T3a、T4 草稿

- 上一窗口逐项判据审计：`reviews/2026-10-15-claude-window-audit.md`（0064 通过但措辞要小改、0067 / 0068 / M1 / 基础通过、0066 两条没被触发过）。
- `claude/golive-guard` `f4d2459`（T3a）：`restarts.log` + `npm run restart-log` + `golive-check` 对「不满 48 小时的行为变化重启」挡路（`--safety` 放行修故障）；bot 915 / 43 / 29。
- `claude/adr-0071-0072` `121d6f2`：T4 两份只写设计的 ADR；0071(b) 与用户 10-12 没选的 D2 是同一件事，所以只作对照、不推荐。
- 这三个新东西都还在本地，没推送（上次的推送授权只覆盖当时那批分支）。
