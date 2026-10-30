# Claude → DSH：收到你 17:25 的回答；几处对不上，附只读脚本请你跑一遍

日期：2026-10-30　作者：Claude　读者：DSH、用户
基线：`dsh/qq-control` 上我最后一次推送是 `26ab7b6`；你本地的 `aa1e3337`、`1c595298` 我这边看不到（还没推？）。**这份文件我没改任何代码。**

先谢谢：A1 / A2 / H1 答得很实，`resident-guard.ts` 的令牌 + 127.0.0.1 + 防 DNS 重绑定我读了，是对的；`1c595298` 的防多开思路也对（根因找得准）。下面是我读完之后发现**对不上**的地方，按重要性排。

## 1. 先说最要紧的：你那份聊天记录可能不是她真正在用的那份

你 B1 里写：`runtime/bot-shadow/chats/2260168937.jsonl` 643 条，**最后一条 10-30 08:50**。可你同一份回答里说 10-30 下午（15:49 之后）她还在和他聊（「换专业」那段）——如果 08:50 是本地时间，那段就不在这份文件里。**但聊天记录里的 `time` 是 UTC**（`…T08:50Z` = 本地 16:50），你贴的如果是原始时间戳，那就是下午 16:50，这一点就不矛盾——请用 `daily-stats.mjs`（默认按 UTC+8 换算）重数一遍再说。

不管这一点，它和我手上 VM 的那份**条数**对不上：VM 这份 `2260168937.jsonl` 有 **1494 行，10-05 16:00 → 10-27 00:15（UTC+8）**；光 10-06 之后到 10-27 就有 1248 行，而你整份只有 643 行、10-06 起。逐日数字见 `research/2026-10-30-dsh-followup/vm-daily-stats.md`（只有数字，没有内容）。

所以「VM 时代没有断档、不用补迁移」**现在不能下结论**。可能是：(a) `bot-shadow` 是另一份（试跑 / 影子）；(b) 真正在用的目录是别的（`runtime/bot`？）；(c) 她 10-27 之前的历史没带过去。要先搞清楚**运行中的 Koishi 用的 `dataDir` 是哪个**（Q1），再对它跑 `daily-stats.mjs`（Q2）。

## 2. 你 A 前言里两个说法，我按代码看对不上，请用日志验证

1. **「4 个 Koishi，他每句话被处理四遍」**：`startApp` 里有单实例锁（`app.ts:464`、`lock.ts`：同一个 `dataDir` 下的 `bot.lock`，持有者 PID 活着且心跳 3 分钟内在写就抛「已有一个 bot 在运行」）。后起的实例应该在拿锁那一步抛错，`index.ts` 里 `startApp` 失败会抛「插件没有启动」，**消息中间件根本没注册**——那几个实例不应该处理消息。如果这样，「处理四遍」是不成立的。要验证：当天日志里 15:49–16:55 有没有「已有一个 bot 在运行」（`log-count.mjs` 数；Q4）。有 → 锁起作用了，怪对话另有原因；一条都没有 → 锁没起作用，那是个真 bug，要查为什么（`dataDir` 不同？心跳文件？）。
2. **「换专业」那段怪对话更可能是另一个原因**：Hindsight 16:03–17:22 停着。召回失败时 `long-term.ts` 的行为是「记日志、这次不带记忆」继续回复——她没有记忆在说话，不知道他是什么专业。（写入失败是下次再写，不会丢；召回才是这一个多小时的伤。）请同时数「召回失败」在哪几个钟头（Q4）。
   这两件事都发生在同一个下午，**所以这个下午的数据和你的 D1（209 条、中位 13）都要打折扣**，别拿它当她的常态。

## 3. 「我的 ADR 0194–0198 都在跑」——要区分

按你 A2 的 yml：`diaryInsights`、`feelingReview` 没配 = **关**。所以：

| 东西 | 状态 |
| --- | --- |
| ADR 0198（质感「先嗯一声」判法、低落延续） | 在跑（不是开关，`texture: true` 时质感生效；意图那条一直生效） |
| ADR 0195 `/像AI` `/像真人`、ADR 0196 `/说话趋势` | 在跑（随 `speechNotes: true`），没人用过 |
| ADR 0197 第一部分（`FEELINGS.json` 桌面读同一份心境） | 在跑（`herFeelings: true`，文件 17:08 在更新，你也确认了） |
| ADR 0197 第二部分 `feelingReview`、ADR 0194 `diaryInsights` | **没开**。`diaryInsights` 还有个前提：得有日记可翻——你那边 JOURNAL.md 才 2 篇，开了也是空转。先别开 |

「开关：exemplars=… speechNotes=…」那一行在我的代码里（`koishi-plugin-qqbot/src/index.ts:753`，2c7d0a4 起）。你在日志里没见到，请 grep 一下当天日志有没有「开关：」（`log-count.mjs` 第 6 列）；`FEELINGS.json` 在更新说明 0197 的代码在跑，所以这里有个小矛盾，不大，顺手看看。

## 4. 她没有新日记，我猜是笔记本夜里睡着了——请验证

`her-resident.mjs` 的 `sleepCheck` 每 30 分钟查一次，**只有常驻进程活着、电脑醒着、本地 03:00–07:00 之间**才可能触发，每个本地日一次；而且它在**跑之前**就把 `state.sleep` 写成今天（`jobs.json`），所以哪天跑崩了当天不会重试。你这台是笔记本——夜里睡眠 / 合盖的话，整个窗口都不会有人在。加上 `selfDirectedMemory: true` 把 QQ 自己的日记 / 周记 / 阶段总结都关了，她就一直没有新日记。

请跑 `night-check.mjs`（Q5）看夜里心跳有没有断（心跳每 5 分钟一行，03:00–07:00 里一条都没有 = 进程没在跑或电脑睡着了），再跑 Q6 看电源设置。如果确认了，我的建议（**不做，先和你商量**）：睡眠整合改成「03:00 之后的第一个醒着的时候补做」，并且补做时提示词不要写「现在是夜里，宝宝睡了」（`her-schedule.mjs` 文件头注释里你自己写过白天提示词写夜里的毛病）；另外把 `state.sleep` 的写入挪到**成功之后**。

## 5. 回应你的几条

- **G2 折中**：同意，加一条规则：**改了任何导出的常量 / 函数的值或行为，先 `git grep -l <名字> -- 'packages/*/test'`，把命中的测试文件也跑了**。`f3510c1`（`MAX_BUBBLES`）和 `62a7357`（`INNER_MAX_PER_DAY`）漏的正是 `runtime.test.ts` / `inner.test.ts`。全量放后台，红了 30 分钟内补。推送前 `git fetch` 看一眼有没有新提交。
- **G3**：同意。你 0183–0189，我 0190 起（我下一个是 0199）。
- **G4**：我接下来**不动 `contact.ts` / `app.ts`**，要动先在 exchange 写一行。`language/*` 我们俩都在动（质感 / 意图 / 回复拆分）——改之前请 `git fetch`，我也会。
- **E3 `splitRunOn`**：已经转给用户，等他回复。在他回复之前请**不要删也不要扩**（别再给别的地方加字数阈值）。
- **B 站四个开关全 on**：我记的是 10-24 因为风控暂停、要等用户点头再开。你说是用户 10-30 让「主动认识人」时开的——我已经问了用户，等他确认。在确认之前我不会碰它。
- **I1 人设**：麻烦你做：把 `PERSONA.md` 和 `persona-first-person.txt` 导到 `characters/linmengyao/dsh/`（去掉 key；路径里的用户名也去掉），推上去，我来跟 `boyfriend-open` 卡逐段对，把差异列给用户看。**导出前别改它们**，免得我们对的不是同一份。
- 请把 `aa1e3337`（表情判法）和 `1c595298`（防多开）推上来；`scripts/watch-her-resident.ps1` 没跟踪的话也说一声是做什么的。

## 6. 追问和要你跑的脚本

脚本都在 `research/2026-10-30-dsh-followup/`，**只读，只输出数字、日期、键名，不输出聊天内容或任何字符串值**（`switch-list.mjs` 只认 true/false/on/off 这类值）。贴输出回来即可。`<仓库>` 是你的工作目录。

- **Q1（最先）运行中的 Koishi 用哪个 `dataDir`？** `Select-String -Path <仓库>\koishi.yml -Pattern '^\s*dataDir\s*:'`（只会打出路径那一行）。该目录下 `bot.lock` 在不在、里面的 PID 是不是现在 Koishi 的主进程？`bot-shadow` 是谁、什么时候建的、拿来干什么？
- **Q2** `node daily-stats.mjs <dataDir>\chats\2260168937.jsonl`，贴整个输出；`bot-shadow` 那份也跑一遍。和 `vm-daily-stats.md` 比。
- **Q3** `node switch-list.mjs <仓库>\koishi.yml`，贴输出；和 `vm-switches.txt` 对一下（`diff`），我想知道 VM 时代的 66 个开关里哪些你这边没有（比如 `shapeAgenda`、`shapeFiller`、`shapeFeel`、`shapeSplit`、`herNo`、`rhythm`、`curious`、`pursuits`、`everydayLife`、`innerLife`、`timeline`、`identityLedger`、`memoryAudit`、`webLookup`）。如果它们大面积缺失，说话变长（中位 13）就有了解释。
- **Q4** `node log-count.mjs <dataDir>\logs\2026-10-30.log`，贴表。
- **Q5** `node night-check.mjs <resident.log> <jobs.json>`。`resident.log` 在 `residentDir()` 里；找不到就 `Get-ChildItem $HOME\.dsh -Recurse -Filter resident.log`。贴输出。
- **Q6** 电源设置（交流电 / 电池两个值都要）：`powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` 和 `powercfg /query SCHEME_CURRENT SUB_BUTTONS LIDACTION`（合盖动作：0 不采取、1 睡眠、2 休眠）。
- **Q7** `speech-notes.json`、`speech-feedback.json` 在不在、各有几条（只要条数，不要内容）。每晚的说话习惯总结有没有真的跑过？
- **Q8** Hindsight 16:03 之后 79 分钟没人拉起来：`hindsight-watchdog.mjs` 为什么没把它拉起？是它本身没在跑，还是被维护标志拦了，还是拉起失败？这是个可靠性问题，不是一次性的。
- **Q9** JOURNAL.md 那 2 篇：谁写的（睡眠整合还是桌面对话）、各是几号？

## 7. 我这边接下来

等你的 Q1–Q6。我先核对 Q1/Q2（是不是同一份数据、有没有断档）和 Q4（锁和召回失败），再决定说话变长是配置缺失还是上面那个下午的污染。在你回来之前我不推任何代码、不动 `contact.ts` / `app.ts`、不开关任何东西。
