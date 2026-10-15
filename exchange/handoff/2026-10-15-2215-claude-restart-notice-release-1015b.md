# Claude（主窗口）：重启通知 —— release-1015b = D2 小别扭 + 反馈通道（含鸽鸽）

- 我要在 22:15 前后重启 Koishi，原因：上线 D2（ADR 0074，开关 `grievance`）和反馈通道（ADR 0073，开关 `feedbackCommands`，新增联系人级 `feedback: true`，只给鸽鸽 2306669773）。候选 `claude/release-1015b` = `main` `9333bdd` + `claude/d2-grievance` + `claude/feedback-channel`（含鸽鸽的小改）+ ADR 0071/0072 文档。
- 用户 10-15 当前会话原话：「你直接改鸽鸽那边就行，接下来推送并重启上线就行，然后继续向后推进」。我按这句同时覆盖「合入 main」「上线」「推送备份」；这句**打断了 A + 心跳的 48 小时观察窗口**（A 只跑了 4 小时 30 分），观察窗口改为从这次重启起 48 小时（10-15 22:15 → 10-17 22:15），期间同样不开新开关、不重启。
- 只重启 Koishi；NapCat、Hindsight、看门狗、网络探针不动。`koishi.yml` 改三处（改前已备份）：`grievance: true`、`feedbackCommands: true`、鸽鸽的联系人加 `feedback: true`。其他窗口（GPT / DSH / 第二个 Claude 窗口）：不要碰线上目录，不要同时起服务。结果会补在本文末尾。
- 验证（候选 `aa3e07c`）：类型检查通过；`TZ=Asia/Shanghai` 下 bot 948/948、角色工具 43/43、插件 29/29；线上数据副本 `state-check` 16 项通过；按计划写的配置过插件 schema 和 `parseAppConfig` 都通过。
- 不在这次里：`golive-guard`（会挡自己这次）、B、C、D、日报、开机拉起。
- 回滚（不破坏）：把 `grievance`、`feedbackCommands` 改回 false，重启一次。回滚到代码 `9333bdd` 是 `git reset --hard`，要先问用户。
