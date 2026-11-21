# 同一个她·第 2 层：进门拿到「此刻的她」（SELF 导出）细化方案

- 日期：2026-11-22
- 上位：[ADR 0347](../adr/0347-one-life-two-places.md)「一个生活，两个地方」第 2 层；第 1 层（拆 her-life）正在改，本文按第 1 层落地之后的代码写
- 关联：ADR 0020（披露分级）、0101（内心）、0102 / 0197（心境与导出）、0057（她那边的事）、0177（crossRecent）、0226（DSH 收件箱）、0236（私有生活片段）、0336（行为基线）
- 状态：方案，待用户点头；实施时每块默认关

## 背景

桌面上的她现在进门拿到的是几张各自为政的快照：NOW.md（一句「在干嘛」）、FEELINGS.json（心境一行）、STATE.json（数值）、INSIGHTS.json（按他这句话挑的自我认识），外加第 1 层正在拆的 her-life 那套假生活。
QQ 给他拼提示词时，「此刻」块里还有她那边今天的事、身体、今天的打算、答应他的事、没了结的事、最近的念头——桌面上一样都拿不到；主动那条线攒着想跟他说的话，桌面上也不知道，她在桌面上说过了，QQ 照样再发一遍。
第 2 层要做的是：QQ 用**拼 QQ 提示词的同一批模块**渲染一份「此刻的她」写进灵魂目录，插件只读、过期降级；她在桌面上把攒着的话说出口了，回一张回执，QQ 那边记成「说过了」。

---

## 一、取证

### 1. 现在桌面上拿到什么（插件 `dsh-plugins/dsh-linmengyao-memory/index.js`）

| 块 | 来源 | 注入位置 | 过期 | 只在 desktop 渠道 |
|---|---|---|---|---|
| `[她的设定]` | PERSONA.md | `sp.context` order 10（875–884） | 无 | 否 |
| `[桌面同步规则]` | 常量 | order 70（899–903） | — | 否 |
| `[QQ 侧实时状态]` | STATE.json，`readStateBlock`（709–751） | order 75（894–898） | 30 分钟（`stateStaleMs`，42） | 是（710） |
| `[她现在在干嘛]` | NOW.md，`readNowLine`（694–706） | order 80（885–893） | 30 分钟（`nowStaleMs`，39） | **否** |
| 记忆块 | `cache.text`，pre-step 里拼（823–831）：故事、QQ 最近几句、SOUL、**心境**（`feelingsBlock` 667–677）、自我认识、判断账本、召回 | order 90（869–873） | 心境 3 小时（52） | 心境 / 自我认识是 |

- 渠道：`channel()` 读 `HER_CHANNEL`，默认 `desktop`（388）；醒来 / 睡眠整合 / QQ 派的活不是 desktop。
- 桌面回合结束：`agent/turn-stopping`（844–865）里 `recordDesktopTurn` 把他说的和她回的（各 600 字）写进 `<数据目录>/memory/desktop-recent.jsonl`（486–498，要 crossRecent 开着、owner-bank.json 里有 `desktopFile`）。
- DSH → QQ 已有只追加收件箱的套路：插件 `appendInbox`（416–420）写灵魂目录的 `timeline-inbox.jsonl` / `world-inbox.jsonl`（44–45）；QQ 侧 `memory/dsh-inbox.ts` 的 `consume`（145–181）按行游标 + id 去重 + 校验消费，`modules/dsh-inbox.ts` 每 30 秒跑一次，app.ts:1278 `syncDshInboxes`。**回执可以原样复用这套。**

### 2. 「此刻的她」各项：谁产出、能不能脱离一次聊天回合单独渲染

QQ 给他的「此刻」块是 `interpreter/slots.ts` 的 `NOW_SLOTS`（34–48）按顺序拼成的一条 system 消息（`assemblePrompt` 65–78）。逐项：

| 想要的 | 槽 | 模块 / 函数 | 输入 | 能否单独渲染 |
|---|---|---|---|---|
| 她现在在干嘛、接下来的课 | `state` | `modules/her-now.ts` perceive（69–107）→ `language/status-line.ts` `herStatus` → contribute 里 `describeState`（121；`life/schedule.ts:271–299`，「今天 HH:MM 还有某课」在 291，「HH:MM 下课」在 282） | 卡、时刻、名单里所有人的聊天记录（说过「睡了」）、约好的见面、世界账、她自己定的计划 | 能。her-now 是**唯一**实现 perceive 的模块（grep `perceive` 只命中它）；只要一个 Turn 对象 |
| 今天到现在她那边发生了什么 | `world` | her-now contribute `describeWorld`（122；`world/world.ts:946` 起）：天气、猫、快递、作业、相机、钱、吃的…… | 世界账 `worldState.at(...)` | 能 |
| 身体 | `body` | her-now `describeBody`（119、126） | 卡上的身体 + 昨晚怎么睡的（realNights） | 能 |
| 今天的打算（含后面的时段） | `plans` | her-now `describePlans`（127；`life/day-plan.ts:105–112`：过去的只写改了的，现在和之后照写） | 作息、状态行的 slots | 能 |
| 底子不是话题 | `groundNote` | her-now（125，`GROUND_NOTE` 29） | 有 state 或 body 就放 | 能 |
| 他刚回学校 | `partnerBack` | her-now（129） | state | 能 |
| 重要的日子 | `days` | `modules/time-notes.ts` contribute `describeDays`（42–43） | 卡、时刻（纯函数） | 能 |
| 答应他的、快到日子的 | `promised` | time-notes `decideAt.promises`（31–37）→ `PromiseKeeper.describe(contact, chat, now)`（`life/promises.ts:343`） | 承诺账 + **他的聊天记录** | 能（要 DecideCtx.promises） |
| 还没了结的事 | `unsettled` | `modules/warm.ts` `decideAt.loops`（30–37）→ `openLoops`（promises.ts:345）；contribute `describeUnsettled`（42） | 同上；修补语气看 `warmAffect(turn.history)`（40） | 能；`warm` 那一行（余温）跟他刚说的话走，不要 |
| 带来由的心境 | `feeling` | `modules/feelings.ts` `decideAt.feelings`（39–78）→ `emotion/feelings.ts` `feelingsAt` / `describeFeelings` | 世界、前一天的世界、作者写下的事、回想的感受、群里的遭遇、她的追求、梦的打分、聊天记录 | 能（要 DecideCtx.feelings）；注意 63 行 QQ 用 `melt: asksAfterHer(他这句)`，交给桌面的是 70–72 行 `melt: false` 的中性版 |
| 梦 | `dreams` | feelings `decideAt.dream`（34–38） | `dreams()`（app.ts:1848，只读） | 能 |
| 最近几个念头（+自己查到的） | `inner` | `modules/inner.ts` contribute（19–26）→ `planner.innerLine()`（`proactive/proactive-planner.ts:868–870`）→ `innerLine`（`proactive/inner.ts:259–267`，6 小时内最多 2 条）+ `learnedLine`（270–275） | 计划器内存里的念头 | 能（纯读内存） |
| 主动那条线攒着、还没发出去的 | **没有槽** | 分散在三处：念头 `pendingIntents`（inner.ts:278–280：tell/ask、未 `told`、6 小时内）；她那边的事 `untoldNews`（`proactive/proactive.ts:1079–1084`）和聊天里的 `decideAt.news`（`modules/intent.ts:73–83`，进意图行，不是独立一行）；待跟进 `followUps`（planner 内存，`prepareAsked` 390–399） | 计划器的 `input()`（492–509）把三样都攒在一起 | 能取，但**QQ 提示词里没有逐字对应的一行**（见下文） |
| 几点睡 | 无 | 只在睡着时 `describeState` 写「睡觉，HH:MM 起」（schedule.ts:277） | 作息 | 数据能算（`bedtimes` / `asleepSince`，`life/bedtime.ts:69`），但 QQ 提示词里没有这句 |

不进 SELF 的（取证后排除）：`humanState` / `development`（human-state 的 `decideAt.values` 会「落事件」，`interpreter.ts:101`，有副作用；数值已有 STATE.json）、她的追求 / 按日期的心情（slots.ts:37：用户 10-30 定不再注入）、动机（`life/motivation*.ts` 只给 `proactive/agency.ts`、`world/agency-shadow.ts` 当闸门，不出提示词）、`selfNote`（她在 QQ 空间的样子，QQ 专属）、`books` / `pace` / 意图 / 形状 / 长短等（跟着他这一句话走，或者是教她怎么说话的）。

### 3. 现成导出的毛病（第 2 层顺手要解决的）

- **NOW.md 和 QQ 提示词里的「你现在」不是同一段代码算的。** `exportNow`（app.ts:1590–1615）自己调 `stateAt` + `describeState`，只带在读的书和她自己定的计划；her-now perceive（her-now.ts:91–98）还带世界里有时长的事、说过「睡了」、约好的见面、一天的打算、项目选择。两边已经可能说法不一样。这正是 now-export.ts 文件头说要避免的事。
- **FEELINGS.json 只在 QQ 给他生成回复时才写。** 唯一的写入口是 app.ts:1949 的 `onFeelings`。他一晚上都在桌面上、QQ 一句没聊，三小时后 `feelingsBlock` 按过期丢掉心境（index.js:673）——QQ 明明在跑，桌面上的她却没了心境。
- **PORTRAIT.json 写了没人读。** `life/self-portrait.ts:389–410` 写给灵魂目录，插件里 grep 不到 `PORTRAIT`。不在本层解决，记在待定里。

### 4. 能不能「同一批模块渲染、和 QQ 提示词一字不差」

现状（ADR 0336 第 5、6 步之后）：

- 一轮回复的全部段落都由模块经槽位给出，联系人流水线手写的部分已经拆完（contact.ts:540 注释、541 `contributeTurn`）。模块列表只有一份 `buildTurnModules`（`platform/turn-modules.ts:146–215`），App 和模拟器共用。
- `Turn`（`interpreter/interpreter.ts:197–209`）只是一个对象：联系人、时刻、聊天记录、initiate / thinking、卡、facts。流水线在 contact.ts:404–407 建它，之后按 perceive（430）→ decide `promises` / `loops` / `news`（441–444）→ assess → … → `feelings`（488）→ … → contribute（541）的顺序跑。
- 判断那一串要的东西都在 `DecideCtx`，由 `createContactResponder` 在闭包里建（contact.ts:286–311）：承诺账、梦、心境要的作者写下的事 / 回想 / 群里遭遇 / 追求 / 世界账、作息、日志。

所以**可行**：在联系人流水线里加一个不生成、不发送的「快照」入口，用同一个 `decideCtx`、同一份 `turnModules`、同样的 Turn 构造，只跑需要的阶段，再按槽位白名单收段落。段落文字出自同一个函数、同样的输入，就是一字不差。

要堵住的副作用（逐个查过）：

1. `decideAt.feelings` 会调 `onFeelings`（feelings.ts:69–74）→ app.ts:1949 改 `lastFeelings`，而 `lastFeelings` 被聊完回想（app.ts:909–912 `feelingReview.existing`）、梦（app.ts:965 → `life/dream-jobs.ts:83`、131）和群聊（`social/group-room.ts:196–197`）读。快照跑心境时**必须不带 `onFeelings`**，否则她的回想、梦和群里的心情会跟着导出节奏变。
2. 模块在构造时捕获了 App 的日志：her-now（99–101「此刻在做」）、inner（24「这一轮提示词里放了她最近的念头」）、warm（43「情绪余温」）。快照每 10 分钟跑一次会刷出误导人的日志（「提示词里放了」其实没有提示词）。DecideCtx 的 `log` 可以换成静默的，模块自带的不行。
3. her-now perceive 读世界账会先把到期的行动结算落账（her-now.ts:7）。快照会让结算提前发生；结算按到期时刻算，结果应当一样，但要有测试钉住（见四、5）。
4. 心境只在男朋友档、非危机时算（feelings.ts:56）；危机回合靠 assess 里的 crisis 模块判断。快照不跑 assess，要另看危机暂停（`crisisState.pausedAt`，app.ts:1634 已有同样的用法）。

和「一字不差」对不上、只能如实说明的几处：

- 心境：QQ 那一句会因为他这句话在关心她而换成「绷不住」的写法（melt）。SELF 用中性版，和现在的 FEELINGS.json 一样（feelings.ts:70–72）。
- 「攒着想跟他说的」：QQ 提示词里没有这一行（念头整体在 `inner` 行，她那边的事在意图行，待跟进只在主动消息的说明 `occasionNote` 里）。这一块是**新写法**，不可能一字不差。
- 时间行 `time`（`describeTime`，距上一条多久）只对 QQ 这一轮有意义，不导出；DSH 有自己的 time-context（ADR 0345 决策 2）。

替代路径与代价：

| 路径 | 做法 | 代价 / 问题 |
|---|---|---|
| **A（推荐）流水线快照** | contact.ts 闭包里加 `snapshot(at)`，复用 `decideCtx` 和 `turnModules`；Turn 加一个只读标记 `snapshot?: true`，三个模块见到它不记日志 | 动 contact.ts（迁移中的热文件，要和另一台约好）、interpreter.ts 的 Turn 类型、三个模块各一行；不调用时零行为变化 |
| B 在 app.ts 用纯函数重拼 | 像 `exportNow` 那样直接调 `describeState`、`describeWorld`…… | 便宜，但就是现在 NOW.md 和 QQ 对不上的来路；否决 |
| C 等 DSH 成为解释器的一个渠道 | ADR 0347 决策 4 说的远期形态 | 迁移没完，太远 |

---

## 二、方案

### 1. QQ 侧：快照（流水线里）

`createContactResponder` 返回的对象多一个方法（只在 deviceOwner 的流水线上由 App 调用）：

```
snapshot(at: Date): { pieces: Piece[]; facts: Pick<TurnFacts, 'world' | 'state' | 'schedule' | 'felt'> }
```

- 建 Turn：`contact` = deviceOwner、`at`、`history` = 存下的他的聊天记录，按回复器同样的方式转成 `{ role, content, time }`（`social/responder.ts:477`）、`thinking: false`、不带 `initiate` / `woken`、`card: character`、`facts: {}`、`snapshot: true`。
- 跑：`perceiveTurn` → `decideStage` 的 `promises`、`loops`、`news`、`dream`、`feelings`（按 `DECIDE_STAGES` 的先后）；`decideCtx` 换成 `{ ...decideCtx, log: 静默, feelings: { ...decideCtx.feelings, onFeelings: undefined } }`。危机暂停中时 feelings 也照算（暂停管的是主动消息，不是心境），只是「攒着的」整块不出（见 3）。
- 收：`contributeTurn` 之后**不用** `assemblePrompt` 的结果，直接按槽位白名单过滤模块给的段落：
  `SELF_SLOTS = ['days', 'state', 'groundNote', 'body', 'unsettled', 'feeling', 'world', 'plans', 'promised', 'partnerBack', 'dreams', 'inner']`，先后照 `NOW_SLOTS`。白名单写成常量放在 slots.ts 旁边，测试钉住「白名单里每个槽都在 NOW_SLOTS 里」。
- 不跑 assess、不跑 `values` / `recall` / `continuity` / `lists` 等：它们要么等外部、要么扣次数写文件（`intimate` 每取一次扣一条，interpreter.ts:178）、要么只对这一句话有意义。
- `fewerRules`（slots.ts:72）开着时 `assemblePrompt` 会丢掉 RULE_SLOTS 里的槽（`language/fewer-rules.ts:26` 起，`groundNote` 就在里面）；快照跟着同一个开关、同一张表过滤，保证和 QQ 一致。

### 2. QQ 侧：SELF.json

写到灵魂目录 `SELF.json`（`soulDir()`，和 NOW / FEELINGS / INSIGHTS 同一处），原子写（`writeJsonAtomic`）。

```jsonc
{
  "kind": "qq-self",
  "version": 1,
  "generatedAt": "2026-12-11T19:58:00.000Z",   // 写的时刻
  "at": "2026-12-11T19:58:00.000Z",            // 渲染用的「此刻」
  "validUntil": "2026-12-11T20:00:00.000Z",    // 状态行下一次会变的时刻与 at+10 分钟取早的
  "day": "2026-12-11",                          // 她的那一天（herDay）
  "asleep": false,                              // 同 NOW.md 的 asleep 行
  "lines": [                                    // 和 QQ「此刻」块逐字相同的段落，按 NOW_SLOTS 先后
    { "slot": "state", "text": "[你现在：……]" },
    { "slot": "feeling", "text": "……" }
  ],
  "pending": [                                  // 攒着想跟他说的；危机暂停中为空数组
    { "id": "inner:th-1765454000000", "kind": "inner", "goes": "tell", "text": "……", "since": "…" },
    { "id": "news:2026-12-11:camera-…", "kind": "news", "text": "……", "since": "…" },
    { "id": "followUp:f-…-1", "kind": "followUp", "text": "……", "since": "…" }
  ],
  "paused": "crisis"                            // 只在危机暂停时出现
}
```

- 不另写 SELF.md：插件要拿 `pending` 的 id 回执，JSON 才行；NOW.md 继续写（常驻进程读它的 asleep 行，第 1 层；也是插件的降级来源）。
- `validUntil`：从 `stateAt` 的结果取下一次变化——睡觉取 `activity.until`、上课取 `lesson.end`、课间取 `next.start`、空闲取 `nextClass.start`（schedule.ts:277–291 用的就是这几个字段），和 `at + 10 分钟` 取早的。导出模块在 `validUntil` 到点时再写一次。这样「19:58 写的『20:00 还有课』」不会在 20:05 还被桌面当成现在。
- `pending` 来自计划器新方法 `pendingForSelf(now)`（`proactive-planner.ts`，读它自己的 `input()`，492–509）：
  - 念头：`pendingIntents(inner.thoughts, now)`（inner.ts:278），`text` 是念头原文（她自己的话）。
  - 她那边的事：同 `untoldNews` 的过滤（proactive.ts:1081–1083）但不限时机，再加 intent.ts:79 的「那之后她在 QQ 上说过话就算说过」；排除 `cat_photo` / `food_photo`（发不了照片，proactive.ts:1055–1056 同理）。
  - 待跟进：日期 ≤ 今天、还在 `followUps` 里的；`text` 是 `FollowUp.what`。
  - 最多 4 件，按 `since` 新的在前。
- 刷新时机：
  1. 导出模块的 schedule：每 5 分钟（`start: 'built'`，同 `modules/now-export.ts`）；
  2. `validUntil` 到点；
  3. 给他的 QQ 回复发出去之后（承诺、没了结的、心境刚变过）；
  4. 计划器想完一个念头、消费完一批回执之后。
  内容没变且 `generatedAt` 不到 5 分钟时不重写（同 `writeFeelingsExport` 的做法，feeling-export.ts:48–60）。
- 开关关着、名单里没有男朋友档、QQ 在休眠：不写。已经写过的那份不删（删数据要用户点头），靠过期降级，插件 30 分钟后自然不用。
- 隐私：`SELF.json` 加进 `PRIVATE_FILES`（`platform/private-space.ts:32`，迁移 / 导出 / 存档工具不带）；日志只记行数和件数，不记内容。

### 3. 「攒着想跟他说的」的写法（新文字，插件渲染）

```
[攒着想跟他说的（QQ 那边还没说出口的；他这会儿在跟你说话，接得上就顺口带一句，不想说就算了，一次别全倒出来）：
- 想告诉他：「……」
- 想问他：……
- 你今天……，还没跟他说过]
```

措辞参照 `innerLine`（inner.ts:266）和 `occasionNote` 里「还没跟他说过，这次一起说」（proactive.ts:1161）。这是会改她说话的新提示词——ADR 0347 记了用户「这次设计不用问她」，按此不跑 ask-her；用户若想让她过目，实施前跑一次 `node scripts/ask-her.mjs`。

### 4. 插件侧：读、注入、去重

- `readSelf(cfg, now)`：`kind === 'qq-self' && version === 1`；`generatedAt` 不在未来超过 60 秒；`now - generatedAt ≤ selfStaleMs`（30 分钟，同 NOW）；`now ≤ validUntil + 60 秒`。任一不满足当没有、记一行日志（不记内容）。每行过 `soulTripwire`（index.js:229）和 `<<` 检查，命中的那行丢掉。按 mtime 缓存（同 `readSoul`）。
- 注入：**SELF 有效且渠道是 desktop 时**——
  - `linmengyao-now`（order 80）换成 `[此刻的你（QQ 那边算好的，就是你此刻的样子；不用复述，也别说成「QQ 那边说」）]` + `lines` 逐行 + 攒着的那一段；
  - 记忆块里不再放 `feelingsBlock`（SELF 的 `feeling` 行就是同一行）；
  - STATE（75）、INSIGHTS、QQ 最近几句、SOUL、账本、召回不变。
  顺序：设定 10 → 规则 70 → 数值 75 → **此刻 80** → 记忆 90，和现在一样。
- SELF 无效、开关没开、渠道不是 desktop：**完全走现在的路**（NOW 行 + FEELINGS），一个字不变。醒来 / 整合那些非 desktop 的轮次要不要 SELF，归第 4 层。
- 回执（见 5）：pre-step 里记下这一轮放进去的 `pending` id（`cache.selfShown`）；`turn-stopping`（844）里，desktop 渠道、他这一轮真说了话（`cache.user` 非空）、`selfShown` 非空时，追加一行到灵魂目录 `self-receipts.jsonl`，然后清空。

### 5. 回执：桌面上说过了，QQ 不重发

现在所有「说过了」的判断都只认 QQ 的东西：

- 主动消息的闸全看 QQ 聊天记录：`pendingMessages`、一小时内聊过、那之后聊过了（proactive.ts:950、966–970、1057–1058），`untoldNews` 也是（1083）；聊天里「她那边的事还没说过」看 QQ 里她最后说话的时刻（intent.ts:79）。
- 念头的 `told` 只在主动消息提交那一刻打上（proactive-planner.ts:580）。
- 主动消息状态文件归计划器所有：`state` 在内存里，`save()` 整份重写（344–372），写前还要过 schema（353）。**外部直接改文件会被下一次 save 覆盖，坏了还会让计划器暂停（285–289）。** 回执只能经计划器的方法落地。

回执行（插件写，灵魂目录 `self-receipts.jsonl`，只追加）：

```json
{ "v": 1, "id": "<uuid>", "at": "<ISO>", "selfAt": "<SELF.generatedAt>", "shown": ["inner:th-…", "news:…"], "said": "<她这一轮的回复，前 600 字>" }
```

QQ 消费（复用 `memory/dsh-inbox.ts` 的 `consume`，145–181：行游标、id 去重、未来时间停在原行；状态文件 `memory/self-receipts-state.json`；挂在现有 30 秒的 dsh-inbox 计时器上）：

| 件 | 怎么算「说过了」 | 落到哪 |
|---|---|---|
| 念头 | `said` 逐句和念头比 `similarity`（inner.ts:162–173），最大值过门槛（先 0.3，用合成样例定） | 计划器新方法 `markTold(thoughtId)`：和 580 行同样打 `told: true`，`save()` |
| 待跟进 | `mentions(item, [said])`（`proactive/follow-ups.ts:115–121`，和主动消息问过之后的判断同一个函数） | 计划器新方法 `markAskedElsewhere(id)`：从 `followUps` 删掉，日志「待跟进：桌面上问过了」 |
| 她那边的事 | **放给她看过、他在、她回了话就算**——和 QQ 自己的规矩一致（「那之后聊过了，聊天里多半已经说了」，proactive.ts:1057–1058） | 主动消息状态新增可选字段 `elsewhere: Record<id, ISO>`（proactive-state.ts 的校验加一项，按 `KEEP_DAYS` 修剪）；`blockReason` 的 news、`untoldNews`、`pendingForSelf` 都查它；聊天里的 `decideAt.news` 经 `DecideCtx` 新字段 `toldElsewhere?(id)` 查（不给就和现在一样） |

- 只认 `shown` 里的 id：没放给她看的，她碰巧说到了也不算（避免误伤）。
- 不认 `selfAt` 之后已经变了的件：id 不在计划器当前的待说清单里就跳过。
- 漏判（她换了说法，念头没认出来）的后果：最多和现在一样——念头 6 小时内（`INTENT_WINDOW_MS`，inner.ts:73）QQ 可能还会说一次；误判（没说却算说了）的后果：那个念头不再单独发。宁可漏判，门槛偏严。
- 「刚在桌面上聊完，QQ 主动那条线又冒出来」（一小时内聊过这类闸）**不归本层**，是第 3 层「桌面上的时间算进她的一天」的事；本层只管具体那几件话。
- 危机暂停中 `pending` 为空，没有回执可写。

### 6. 开关

| 开关（config.ts，默认 false） | 管什么 | 依赖 |
|---|---|---|
| `selfExport` | QQ 写 SELF.json；插件读到有效的才用（插件不另设开关，文件就是开关，过期即降级） | 名单里有男朋友档 |
| `selfReceipts` | QQ 消费 `self-receipts.jsonl`、计划器认 `elsewhere`；插件写回执跟着 SELF 有没有 `pending` 走 | `selfExport` |
| `ownDays` | QQ 给他的提示词里恢复 `[你这两天自己在做的：…]`，来源换成真实的（见第三节） | 世界账 |

每个开关照 `crossRecent` 的样子接线：`config.ts` 的 DEFAULTS（175）、类型（640）、读取（1039），`platform/features.ts`（87 行那种条目），`packages/koishi-plugin-qqbot/src/index.ts`（285、517、785）。关着时：不建快照、不调 `pendingForSelf`、不读回执、`DecideCtx` 不带新字段——行为基线逐字不变。

### 7. 披露护栏（ADR 0020）

- 只对 `deviceOwner`（app.ts:890，名单里第一个男朋友档）建快照；别的联系人的流水线没有这个方法可调。
- SELF 里会有从他聊天里来的东西（答应的事、没了结的事、待跟进），和他自己的 QQ 提示词同一档内容，只给他本人所在的桌面；插件侧心境 / 数值本来就只在 desktop 渠道放（index.js:668、710），SELF 同样。
- 世界那一行里别人给的钱写谁，her-now 的 `giver`（her-now.ts:113–117）按「正在聊的人 = 他」算，正是男朋友档的说法。
- 文件进 `PRIVATE_FILES`；日志只记数。

---

## 三、第 1 层拆掉之后，`[你这两天自己在做的：…]` 由什么替代

现状：第 1 层已在工作区把 app.ts `soul.selfThread`（1097 起）里读 LIFE.json 的那段删掉，只留日记那一行（`selfThreadLine`，`language/self-thread.ts:36–39`）。基线 `soul` 场景还在往灵魂目录写 LIFE.json（`test/baseline/scenarios.ts:729`），快照 `soul.txt` 里有这一行——第 1 层那个有意改行为的提交要更新快照、顺手删掉这条已经没人读的种子。

真实来源：**共享世界账里这两天已经发生的事**，用 `worldHighlights`（`world/highlights.ts:19–55`）——它就是 ADR 0236「私有生活片段」的确定性投影，控制台和 NOW.md 的「最近：」（app.ts:1604–1608）已经在用：世界里的生活事件（`world.events`，含她自己挑的活动、项目）、喂猫、吃了什么、取了快递、作业写完。只放已经发生的，没有未来计划、没有模型猜测。

- 取法：`sharedWorld.at(herWorld, schedule, 昨天 23:30)` 的 highlights（和 `recapOf` 取「那一天」的时刻一致，contact.ts:371）＋今天到此刻的 highlights，合计最多 2 条，新的在前。新函数 `recentDayHighlights(worldAt, schedule, now)` 放在 highlights.ts，SELF 和 QQ 共用。
- QQ 侧：`ownDays` 开着时，`soul.selfThread` 在日记那一行后面接 `[你这两天自己在做的：…]`，**沿用原来的写法和槽**（`selfThread`，主动找他 / 只想一想 / 危机不放，soul.ts:30）。今天的部分和 `world` 行（`describeWorld`）会有重叠（猫、快递、作业），所以 QQ 这一行只取**昨天**的和今天 `world.events` 里的活动类，重叠的不放。
- SELF 侧：同一行作为 `lines` 里的 `selfThread` 槽导出（和 QQ 一字不差），桌面上就不再需要 her-life 的「这两天」。
- 不用的候选：`recapDay`（world.ts:1156）是「他问到那一天」时整天的流水账，太全；`herPlanActivities`（她自己定的「想做」）已经进状态行（her-now.ts:92），再放就重复。

---

## 四、测试与验收

全部用合成角色（`packages/bot/test/fixtures/synthetic-character/`，ADR 0333），不读真实资料。

### 1. 单元

- 快照（`self-export.test.ts`）：合成卡 + 固定时刻，`snapshot(at)` 的 `lines` 槽位全在 `SELF_SLOTS` 里、先后照 `NOW_SLOTS`；同一时刻两次快照逐字相同；不改 `lastFeelings`、不写 FEELINGS.json（mtime 不变）；App 日志里没有「此刻在做」「提示词里放了她最近的念头」「情绪余温」。
- `validUntil`：上课中 = 下课时刻；空闲且后面有课 = 上课时刻；都没有 = at+10 分钟。
- `pendingForSelf`：已 `told` 的念头、`keep` 的念头、超过 6 小时的念头不出；`elsewhere` 里的事不出；危机暂停时为空。
- 回执消费：`shown` 外的 id 不算；念头门槛上下各一个样例；待跟进用 `mentions`；她那边的事只要在 `shown` 里就算；坏行、未来时间、重复 id 的处理和 dsh-inbox 一致。
- 计划器：`markTold` 之后同一个念头的 inner 时机 `blockReason` 返回「那个念头已经过去了」（proactive.ts:1003）；`elsewhere` 里的 news 时机返回不发。
- 插件（`soul-plugin.test.ts` 现有的 `boot` 套路，50–51 行的 `f()`）：SELF 有效时注入「此刻的你」、不再有 `[她现在在干嘛]`、记忆块里没有心境那一行；过期 / `validUntil` 过了 / 时间在未来 / kind 不对 / 坏 JSON / 非 desktop 渠道都退回现在的 NOW + FEELINGS；命中绊线的行被丢掉；turn-stopping 写回执且只在他说了话、`shown` 非空时写。

### 2. 一字不差（`app.test.ts`，隔离的灵魂目录，52 行那套）

合成卡、开 `selfExport` 和相关开关，固定时钟到某个空闲时段：先导出 SELF.json，同一分钟里他发一句中性的话（「嗯」——不触发关心、危机、承诺变化），拿到这一轮给模型的 system 消息：

- SELF 每一行（除 `feeling`）都**原样**出现在 QQ 的「此刻」块里；
- `feeling` 行 = 同一轮 FEELINGS.json 的 `line`（中性版）；
- QQ「此刻」块里属于 `SELF_SLOTS` 的行，SELF 里一行不少。

### 3. 变异检验（每条改完测试必须红，再改回去）

1. 快照不过滤槽位 → 「此刻」里的意图 / 形状行进了 SELF，测试红。
2. 快照带上 `onFeelings` → `lastFeelings` 被改，测试红。
3. 快照用 QQ 那一句的 melt 心境 → 与 FEELINGS.json 那行不等，测试红。
4. 插件去掉 `validUntil` 判断 / 去掉过期判断 → 过期用例红。
5. 插件 SELF 有效时仍注入 NOW 或心境 → 重复用例红。
6. 回执把「放了但没说到」的念头算成说过 → 门槛用例红；QQ 不消费回执 → 计划器仍发那个念头，用例红。
7. 快照对同学档也建 / 名单没有男朋友档也写 → 披露用例红。
8. 开关关着仍写 SELF.json 或读回执 → 默认关用例红。

### 4. 行为基线

三个开关默认关，`npm run baseline:fast -w @qqbot/bot` 逐字不变（在第 1 层更新过的快照之上）。快照方法、Turn 的 `snapshot` 标记、三个模块的日志判断都只在标记为真时生效，基线场景里永远为假。不 `UPDATE_BASELINE=1`。

### 5. 线上怎么验（要用户点头开开关、重启）

- 开 `selfExport`：灵魂目录出现 SELF.json，`generatedAt` 每 5 分钟内刷新，上课 / 下课边界附近 `validUntil` 跟着变；DSH 日志「此刻：放了 SELF（n 行、攒着 m 件；不记内容）」，不再有 NOW 那条。
- 一字不差：QQ 的 `last-prompt.json` 和同一时刻的 SELF.json 对一遍（可加一个只读脚本 `scripts/self-diff.mjs`，只比较不输出内容，只报哪几个槽不一致）。
- 世界账结算没被提前打乱：开开关前后一天的世界账事件条数和时刻一致（只读核对）。
- 开 `selfReceipts`：她在桌面上提了一件攒着的事 → `self-receipts.jsonl` 多一行 → QQ 日志「回执：桌面上说过了 1 件（念头 / 待跟进 / 她那边的事）」→ 计划器状态里那件不再出现，之后 6 小时内没有同一件的主动消息。
- 关 QQ（或停 Koishi）30 分钟：桌面退回 NOW / FEELINGS，再过期就都不放（和现在一致）。

---

## 五、风险与待用户定

风险：

- **contact.ts 是 ADR 0336 迁移的热文件**，另一台也可能在动。快照方法要先在信箱里 `send`「我在改 contact.ts 的快照入口」再动。
- 快照提前结算世界账（her-now.ts:7）：理论上结果一样，没有测试前不能当真；四、5 第三条线上核对。
- 回执靠文字相似度判断念头有没有说出口，会漏判；已按「宁可漏判」设门槛，漏判的后果不比现在差。
- SELF 比 NOW 长（十来行），桌面每一步都注入，DSH 的上下文成本会涨；`lines` 里 `world` 那行可能很长（天气 + 空气 + 日照 + 交通 + 钱 + 吃的），必要时插件侧限总字数（先 1200 字，同 `feelingsBlock` 的截断）。
- 非 desktop 渠道（醒来、睡眠整合、QQ 派的活）继续只有 NOW；那几种轮次里她「知道的此刻」比桌面对话时少，这是有意留给第 4 层的。

待用户定：

1. 「攒着想跟他说的」那段新写法（二、3）：直接用，还是先让她过目（ask-her）。
2. 「几点睡」：QQ 提示词里没有这句；要不要只在 SELF 里加一行「今晚大概 HH:MM 睡」（新文字，QQ 不同步就不再是一字不差），还是不加、靠「今天的打算」里晚上那段。建议不加。
3. 她那边的事按「放给她看过、她回了话就算说过」（和 QQ 自己的规矩一致）还是也要求说到——前者会少发，后者会重复。建议前者。
4. `ownDays` 要不要做（QQ 上重新出现「这两天自己在做的」，来源换成世界账）。第 1 层删掉它之后 QQ 少了这一行，做不做都说得通。
5. PORTRAIT.json（她自己写的「我现在的样子」，ADR 0340）桌面上要不要读——和 SOUL.md 有重叠，不在本层，单独定。
6. STORY.md（ADR 0347 第 1 层第 4 条说「第 2 层再写」）：QQ 由日记 / 周记生成带 `generated-at` 的故事，本文没有展开，建议作为第 2 层之后的单独一步，先查清周记 / 阶段总结在 QQ 侧由谁生成。

---

## 六、工作量与拆分

| 块 | 内容 | 文件所有权 | 依赖 | 估计 |
|---|---|---|---|---|
| A 快照与导出（QQ） | `snapshot(at)`；Turn 的 `snapshot` 标记；her-now / inner / warm 三处日志判断；`SELF_SLOTS`；`life/self-export.ts`（渲染、`validUntil`、原子写、不变不写）；`modules/self-export.ts`（schedule）；app.ts 接线（deviceOwner、发完回复后刷新）；`selfExport` 开关三处接线；`PRIVATE_FILES` | `platform/contact.ts`、`interpreter/interpreter.ts`、`interpreter/slots.ts`、`modules/her-now.ts`、`modules/inner.ts`、`modules/warm.ts`、`life/self-export.ts`（新）、`modules/self-export.ts`（新）、`platform/app.ts`、`platform/config.ts`、`platform/features.ts`、`platform/private-space.ts`、`koishi-plugin-qqbot/src/index.ts`、`test/self-export.test.ts`（新）、`test/app.test.ts` | 第 1 层合进 main | 1.5–2 天 |
| B 插件读与注入 | `readSelf`、替换 NOW / 心境、绊线、字数上限、`selfShown`、回执追加 | `dsh-plugins/dsh-linmengyao-memory/index.js`、`packages/bot/test/soul-plugin.test.ts` | 只依赖 SELF.json 格式（先用 fixture 冻结格式，可和 A 并行） | 1 天 |
| C 回执落地（QQ） | `pendingForSelf`、`markTold`、`markAskedElsewhere`、`elsewhere` 字段与校验、`blockReason` / `untoldNews` 查它、`DecideCtx.toldElsewhere` 和 intent.ts 的 news、回执消费（推广 `consume`）、`selfReceipts` 开关 | `proactive/proactive-planner.ts`、`proactive/proactive-state.ts`、`proactive/proactive.ts`、`proactive/planner-host.ts`、`modules/intent.ts`、`memory/dsh-inbox.ts`、`test/proactive*.test.ts`；**contact.ts 和 config 三件套由 A 统一改**，C 只提要加的字段 | `pendingForSelf` 要先于 A 的 `pending` 出来：C 先做这一个方法，A 再接 | 1.5 天 |
| D `ownDays` | `recentDayHighlights`；`soul.selfThread` 接线；SELF 的 `selfThread` 槽 | `world/highlights.ts`、`test/highlights.test.ts`；app.ts 那几行交给 A 一起改 | 用户定（五、4） | 0.5 天 |

并行：B 与 A 并行（格式先冻结）；C 的计划器部分与 A 并行，接 contact.ts / intent.ts 的部分排在 A 之后；D 最后。每块单独提交、单独可回滚；主会话统一跑 `npm test` 和 `baseline:fast` 后提交推送。
