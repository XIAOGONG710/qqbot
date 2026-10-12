# Claude（调研窗口）：ADR 0064 实现好了，在分支上，没合并、没上线

- 时间：2026-10-13 02:05。用户 23:1x 说「继续」，我 23:25 在 `exchange/handoff/` 认领了 0064。
- 分支 **`adr-0064-her-events`**（基于 `main` `9c12afb`，已推送，两个提交 `355bb59`、`19bed59`），工作树 `qqbot-claude4`。**线上目录没碰，没重启。** 没合并进 `main`（等用户说）。
- 测试：bot **789/789**（770 + 19 个新的）、character-tools 43/43（+1）、koishi 插件 29/29；三个包类型检查干净。
- 真模型（纯虚构对话）：新场景 `proactive-news-homework` 3 次（2 次 22:15 单发「写完了，数据结构的」，1 次生成成空的、睡前顺带说时编了「写到十二点」）、`proactive-news-unwell` 3 次（2 次 09:45 单发「肚子疼得厉害，躺床上了」，没有求哄；1 次出口检查删了小黄脸气泡只剩「宝宝」）、相机场景回归（`proactive-news` 的两次「PN01 没提相机」在没改的 `main` 上也是 2/3）。细节在 ADR 0064 的「验证（2026-10-13）」。

## 改了什么

- `proactive.ts`：`NEWS_KINDS`（camera / homework_done / unwell）、`ProactiveSettings.newsKinds`（没写 = 只有相机，旧卡行为不变）、`NewsItem.kind`、同天按类排优先级、`occasionNote` 每类一句、`candidateLabel` 带 `[事件类 id]`、**`counts()` / `unansweredCount` 认「发送出错但前几个气泡已发出」**（我 23:12 交接里说的小漏洞，顺手修了）。
- `world.ts`：`worldNews(now, kinds)`（相机 + 作业写完）、`unwellNews(day, schedule, bodyAt)`。
- `proactive-planner.ts`：`newsFrom(worldAt, schedule, { kinds, bodyAt })` 看三个快照；`input()` 再按卡过滤。
- `app.ts` / `sim/runner.ts` / `sim/scenario.ts`（场景字段 `newsKinds`）；character-tools（`tiers.yml` 的 `proactive.news_kinds` → 卡的 `newsKinds`）；控制台档位页多一个复选框（顺手补上缺的「下雨」「她那边的事」两个时机名）。
- **没改** `tiers.yml`、`characters/`、`koishi.yml`：卡上还没开新类，合并上线后和现在行为一样（除了发送出错那个小修）。

## 给主窗口

- 我动了 `proactive.ts` / `proactive-planner.ts`（你认领过的文件），但在 23:25 的认领里写了。**0066 请等 0064 合并之后再做**（都碰 `proactive*.ts`），或者在这里写一行谁先谁后。
- 合并后上线只需要：线上目录先 `git status` 干净、看 `HEAD..origin/main`、写「我要在 hh:mm 重启」、用户当次同意。开哪一类要另问用户（`tiers.yml` 男朋友档加 `news_kinds`）。

## 要用户定

1. 合并进 `main` 吗？（只有代码，不碰卡。）
2. 开哪一类、什么时候：`homework_done` 照真卡算 6 周约 15 天（每周两三次，22:05–22:20），会占掉那几天的睡前；`unwell` 6 周里只有 1 次（感冒），因为痛经 70% 的概率要碰上才有。建议先开 `homework_done`，`unwell` 等第一次出现的那天再看日志。
