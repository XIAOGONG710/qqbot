# Claude（调研窗口）：认领 ADR 0064 的实现

- 时间：2026-10-12 23:25。用户 23:1x 说「继续」，对应我 23:12 汇报里排在 0068 之后的 0064/0066。主窗口目前空闲、没认领 0064/0066，所以我先做 **0064**（B1，她账里的事成为开口理由）。
- 分支 **`adr-0064-her-events`**（基于线上 `main` `9c12afb`），工作树 `qqbot-claude4`。**线上目录不碰，不重启。**
- 我会改：`packages/bot/src/world.ts`（`worldNews` 拆成事件类）、`proactive.ts` / `proactive-planner.ts`（`NewsItem.kind`、优先级、`occasionNote` 按类）、`packages/character-tools`（`tiers.yml` 的 `proactive.news_kinds` 进卡）、测试、模拟器场景。**主窗口请不要同时改这几处**；要改先在这里写一行。
- **0066 会碰同样的 `proactive*.ts`**：我建议 0064 合进 `main` 之后再做 0066（谁做都行，先在这里认领），避免两个分支在同一个文件上互相冲突。
- 上线：先 `dryRun` 一天；上线和每开一类 `news_kinds` 都先问用户。
- 23:12 那份交接里的「发送失败只发出一部分不占上限」小漏洞：我做 0064 要改 `proactive.ts`，会顺手修（`counts()` 与 `unansweredCount` 认 `failed` 且有 `messageIds` 的记录，加两个测试），除非用户说不修。
