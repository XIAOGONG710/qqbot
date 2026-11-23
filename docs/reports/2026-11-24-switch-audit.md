# 开关审计（2026-11-24，减法准备）

只读分析，没有改代码。给「做减法」那一轮用：每个开关现在线上是什么、管什么、喂哪些槽、谁的 ADR、多久没动、有几个测试碰它，以及建议。

## 来源与口径

- 代码以 HEAD 0fedf7f8 为准。读的时候工作区里另有人在把 app.ts 的桌面 / 真实世界接线拆到 `life/desktop-host.ts`、`world/reality-feeds.ts`（未提交），读取处会挪、行号可能变，开关本身不变。
- 开关清单：`packages/bot/src/platform/features.ts` 的 `FEATURES`（功能总表，features.test.ts 保证 config 里每个布尔 / 模式开关都在这里）共 134 个，另加两个不在总表里的开关样配置 `realTransport`、`adultSiteUrls`，合计 **136** 行。
  任务说的「约 116 个」是旧数；`DEFAULTS` 现在有 155 个键，其中 19 个在 `NOT_SWITCHES`（模型、提示词、名单类参数），不算开关。
- 线上值：`exchange/live/koishi-2026-11-20-1855.yaml`（qqbot 插件那一块）。Koishi 不把等于默认值的项写进 koishi.yml，所以「未在快照」= 线上用默认值。
  快照之后补开的按 ADR 0347 状态行和信箱 2026-11-23-0307 记：`selfExport`、`selfReceipts`（11-22）、`desktopDay`（11-23）。`memoryVoice` 是桌面插件的开关，不在 QQ 配置里，本表不列。
- 槽 / 模块：槽表 `packages/bot/src/interpreter/slots.ts`（2 + 12 + 79 = 93 个槽），模块 `packages/bot/src/modules/`（77 个文件）。按开关在 `platform/app.ts`、`platform/turn-modules.ts` 的接线和模块里 `slot:` 的写法人工核对。
- ADR：取 `FEATURES` 里的 adr 字段，核对过 `docs/adr/` 下都有对应文件。
- 实现最后提交：`git log -1 --format=%cs -- <主实现文件>`；主实现文件先按文件名 / 文件头「配置 X」自动挑，挑到模拟器或汇总文件的人工改过（主动族统一算 `proactive/proactive.ts`，形状族算 `language/shape.ts`）。
- 测试文件数：`packages/bot/test`、`packages/koishi-plugin-qqbot/test`、`packages/chat-bridge/test`、`packages/mobile-companion/test` 下，把这个开关当配置写（`键: true/false/'值'`、`config.键`、`'键'`）的文件数。
  只按函数名测、不经过开关的测试不算，所以 0 不等于「完全没测」，而是「没有测试在开关这一层碰它」。「专测」= 有和主实现文件同名的 `*.test.ts`。
  键名是常用词的（schedule、media、menu、together、reactions、photos……）会多算几份同名属性，只当量级看。
- 引入日期：`git log -S"键:" -- config.ts` 最早一次。「默认关超过两周、线上没用过」以今天 2026-11-24 算，即引入早于 11-10。
- 线上 `fewerRules: true`（11-20 起）。它在 `platform/app.ts:470` 用 `relaxStyle`（`language/fewer-rules.ts:43`）把 speechCheck、tailCap、texture、shape 和 6 个形状分项强制关掉、candidates 置 1，
  并在 `interpreter/slots.ts` 里丢掉 `RULE_SLOTS` 的 21 个槽。所以表里写「被 fewerRules 关」的开关，快照里是 true，**线上实际不生效**。

## 总数

- 开关 136 个；默认关 129 个；线上开着 118 个（含快照之后补开的 3 个、dsh），其中 11 个被 fewerRules 架空。
- 建议：保留 48 · 合并 56 · 候选删除 20 · 需要数据才能判断 12。
- 线上开着、但没有测试在开关这一层碰它的：6 个（见下文）。
- 死键：1 个（`ownerPeek`）。读了但不在 Koishi 表单里的：只有 `onebot`（独立入口专用，按设计）和环境变量那几项。

## 逐个开关

列：类型 / 默认 · 线上值 · 管什么 · 喂哪些槽 / 模块 · ADR · 实现最后提交（引入日期） · 测试文件数 · 建议（备注）。按 `FEATURES` 的分组排。

### 说话

| 开关 | 类型 / 默认 | 线上值 | 管什么 | 槽 / 模块 | ADR | 实现最后提交（引入） | 测试 | 建议 |
|---|---|---|---|---|---|---|---|---|
| `shape` | bool / false | true（被 fewerRules 关） | 每轮条数 / 字数上限，超了重写或截断 | 槽 shape、length；模块 shape / length | 0091 | 2026-11-06 `language/shape.ts`（2026-10-21） | 12（专测） | 候选删除：fewerRules 开着时被 relaxStyle 强制关，线上实际不生效；fewerRules 回退则保留为形状族唯一开关 |
| `shapeAgenda` | bool / false | true（被 fewerRules 关） | 适用轮次顺带说一件自己的事 | 槽 shape（模块 shape） | 0094 | 2026-11-06 `language/shape.ts`（2026-10-21） | 4（专测） | 候选删除：同 shape；fewerRules 回退则合并到 shape |
| `shapeFiller` | bool / false | true（被 fewerRules 关） | 约 7% 只回无内容的话、跟着拖音 | 槽 shape | 0095 | 2026-11-06 `language/shape.ts`（2026-10-21） | 3（专测） | 候选删除：同上 |
| `shapeSplit` | bool / false | true（被 fewerRules 关） | 按抽到的条数拆成几条 | 槽 shape | 0096 | 2026-11-06 `language/shape.ts`（2026-10-22） | 3（专测） | 候选删除：同上 |
| `shapeAsk` | bool / false | true（被 fewerRules 关） | 被问问题时答完再接着说 | 槽 shape | 0149 | 2026-11-18 `modules/shape.ts`（2026-10-25） | 3（专测） | 候选删除：同上 |
| `shapeLong` | bool / false | true（被 fewerRules 关） | 被认真问想法时放宽字数 | 槽 shape、length | 0150 | 2026-11-18 `modules/shape.ts`（2026-10-25） | 3（专测） | 候选删除：同上 |
| `deliberate` | bool / false | true | 认真问时换强模型深思 | 槽 deliberate、routedHint（属 RULE_SLOTS）；换模型照旧 | 0151 | 2026-11-16 `modules/deliberate.ts`（2026-10-25） | 9 | 保留：fewerRules 下提示行被丢，只剩换模型 |
| `shapeFeel` | bool / false | true（被 fewerRules 关） | 约 18% 先说自己的小情绪 | 槽 shape | 0099 | 2026-11-06 `language/shape.ts`（2026-10-22） | 3（专测） | 候选删除：同上 |
| `shortReplies` | bool / false | false | 约一半轮次只回短句（软提示） | 槽 length | 0024 | 2026-11-06 `language/expression.ts`（2026-10-19） | 7（专测） | 候选删除：ADR 0091 写明 shape 取代它；线上显式 false |
| `rhythm` | bool / false | true | 回复前看 / 想 / 打字的延迟 | 无槽（reply-timing） | 0075 | 2026-11-06 `social/reply-timing.ts`（2026-10-19） | 4（专测） | 保留 |
| `lagTail` | bool / false | true | 延迟长尾 + 断网很久后那一句 | 槽 time（模块 time-block） | 0105 | 2026-11-15 `modules/time-block.ts`（2026-10-22） | 6 | 合并到 rhythm：都是回复延迟 |
| `herNo` | bool / false | true | 会拒绝 | 意图行（模块 intent → intent-line） | 0103 | 2026-11-02 `language/after-no.ts`（2026-10-22） | 5（专测） | 保留 |
| `afterNo` | bool / false | true | 被拒后他又提同类请求时给方向 | 意图行 | 0214 | 2026-11-02 `language/after-no.ts`（2026-11-02） | 1（专测） | 合并到 herNo：只在 herNo 的路径上起作用 |
| `moody` | bool / true | 未在快照（=默认 true） | 一串反应词时偶尔不回 | 无槽（social/silence） | 0013 | 2026-11-22 `social/silence.ts`（2026-10-05） | 52（专测） | 保留：默认开 |
| `speechCheck` | bool / true | 未在快照（=默认 true）（被 fewerRules 关） | 出口检查（助手腔 / 算账 / 重复 / 话说一半） | 无槽；模块 review-exit、review-unfinished、candidates | 0014 | 2026-11-20 `language/speech-check.ts`（2026-10-05） | 60（专测） | 需要数据才能判断：默认开，但 fewerRules 开着时被 relaxStyle 关；要等 fewerRules 定去留 |
| `factCheck` | mode / off | fix | 逐条事实检查，fix 档重写 | 无槽；模块 review-facts | 0137 | 2026-11-22 `language/fact-check.ts`（2026-10-24） | 5（专测） | 保留 |
| `relationship` | bool / false | true | 关系阶段（聊得多更放得开） | 槽 closeness（模块 closeness） | 0113 | 2026-10-27 `language/relationship.ts`（2026-10-22） | 25（专测） | 保留 |
| `jokes` | bool / false | true | 小梗回头提（后台抽取） | 槽 joke（模块 jokes） | 0114 | 2026-11-05 `language/jokes.ts`（2026-10-22） | 34（专测） | 保留 |
| `idioms` | bool / false | true（段落被 fewerRules 丢） | 学他的口头习惯（后台抽取） | 槽 idiom（RULE_SLOTS） | 0138 | 2026-11-05 `language/idioms.ts`（2026-10-24） | 29（专测） | 候选删除：fewerRules 下段落被丢，但后台仍在调模型抽取：线上只花钱不生效 |
| `tailCap` | bool / false | false（被 fewerRules 关） | 句尾「吧」「呢」封顶 | 无槽；candidates / review-exit | 0146 | 2026-11-16 `modules/candidates.ts`（2026-10-25） | 6（专测） | 候选删除：线上显式 false，且 fewerRules 下 relaxStyle 也关 |
| `interruptions` | bool / false | true | 被第三方打断岔一句 | 槽 interrupt | 0115 | 2026-11-09 `modules/interruptions.ts`（2026-10-22） | 4 | 保留 |
| `together` | bool / false | true | 陪玩状态 | 槽 together；主动消息让路 | 0111 | 2026-11-05 `language/together.ts`（2026-10-22） | 5（专测） | 保留 |
| `silenceNotice` | bool / false | true | 没回时在回复里酌情解释 | 无槽（social/silence） | 0173 | 2026-11-22 `social/silence.ts`（2026-10-29） | 1（专测） | 保留 |
| `speechNotes` | bool / false | true | 每晚总结说话习惯 | 槽 speechNote（模块 her-notes） | 0193 | 2026-11-20 `language/speech-notes.ts`（2026-10-30） | 6（专测） | 合并到 夜间自省（新键） |
| `fewerRules` | bool / false | true | 丢掉 21 个「教她说话」的槽 + 关风格开关 | 影响 RULE_SLOTS 21 槽；relaxStyle 关 10 个开关 | 0342 | 2026-11-20 `language/fewer-rules.ts`（2026-11-20） | 1（专测） | 需要数据才能判断：11-20 起试；它的去留决定 shape 族、texture、tailCap、speechCheck、idioms、exemplars 的去留 |
| `exemplars` | bool / false | true（段落被 fewerRules 丢） | 真人例子当口气参考 | 槽 exemplar（RULE_SLOTS） | 0190 | 2026-10-30 `language/exemplars.ts`（2026-10-30） | 3（专测） | 候选删除：fewerRules 下段落被丢，线上不生效 |
| `jealousy` | bool / false | true | 吃醋（最轻一档） | 意图行 | 0123 | 2026-10-30 `language/jealousy.ts`（2026-10-23） | 3（专测） | 保留 |
| `texture` | bool / false | true（被 fewerRules 关） | 问号 / ～ / 小黄脸 / 叠字 | 无槽（模块 decorate 改写） | 0131 | 2026-11-01 `language/texture.ts`（2026-10-23） | 7（专测） | 候选删除：fewerRules 下 relaxStyle 关，线上不生效 |
| `curious` | bool / false | true | 会追问；主动「想了解他」 | 意图行；主动消息 | 0126 | 2026-10-27 `language/curious.ts`（2026-10-23） | 6（专测） | 保留 |
| `chatReview` | bool / false | true | 每晚回顾聊天 | 槽 review（her-notes） | 0221 | 2026-11-12 `language/chat-review.ts`（2026-11-03） | 3（专测） | 合并到 夜间自省（新键） |
| `depthRouting` | bool / false | true | 小模型判轻重，重的也走深思 | 槽 routedHint（RULE_SLOTS） | 0202 | 2026-10-30 `language/turn-weight.ts`（2026-10-30） | 3（专测） | 合并到 deliberate：要 deliberate；两个都开 |
| `memes` | bool / false | true | 知道网上热梗 | 槽 meme、memeDict | 0129 | 2026-11-05 `language/memes.ts`（2026-10-23） | 9（专测） | 保留 |

### 她的日子

| 开关 | 类型 / 默认 | 线上值 | 管什么 | 槽 / 模块 | ADR | 实现最后提交（引入） | 测试 | 建议 |
|---|---|---|---|---|---|---|---|---|
| `tastes` | bool / false | true | 从真经历里长出偏好 | 模块 tastes / continuity | 0162 | 2026-11-05 `life/tastes.ts`（2026-10-26） | 7（专测） | 保留 |
| `acquaintances` | bool / false | true | B 站回复她的人登记、再见认得 | 模块 continuity | 0163 | 2026-11-05 `life/acquaintances.ts`（2026-10-26） | 3（专测） | 合并到 bilibiliReplies：只有 B 站回复会产生条目 |
| `ownDays` | bool / false | 未在快照（=默认 false） | 「这两天自己在做的」改用世界账 | 槽 selfThread（模块 soul） | 0347 | 2026-11-22 `world/highlights.ts`（2026-11-22） | 1（专测） | 需要数据才能判断：11-22 新加，线上关 |
| `oneDiary` | bool / false | 未在快照（=默认 false） | 一本日记（QQ 写、抄给桌面） | 槽 selfThread、wake（模块 soul） | 0347 | 2026-11-23 `life/one-diary.ts`（2026-11-22） | 0（专测） | 需要数据才能判断：11-22 新加，线上关 |
| `desktopFeelings` | bool / false | 未在快照（=默认 false） | 桌面上的事也进心境 | 槽 feeling（模块 feelings） | 0347 | 2026-11-22 `modules/feelings.ts`（2026-11-22） | 1（专测） | 需要数据才能判断：11-22 新加；11-23 刚修过「开了也是空的」 |
| `desktopConflict` | bool / false | 未在快照（=默认 false） | 叫她上电脑时知道本来在干嘛 | 槽 state（模块 her-now） | 0347 | 2026-11-22 `life/desktop-conflict.ts`（2026-11-22） | 0（专测） | 需要数据才能判断：11-22 新加，线上关 |
| `selfPursuits` | bool / false | true | 她每晚自己定 / 放下追求 | 无槽（追求不再注入）；模块 reflections | 0178 | 2026-10-31 `life/self-pursuits.ts`（2026-10-29） | 2（专测） | 合并到 pursuits：要 pursuits；两个都开 |
| `diaryInsights` | bool / false | true | 翻日记写对自己的认识 | 槽 insight（her-notes） | 0194 | 2026-11-22 `life/diary-insights.ts`（2026-10-30） | 4（专测） | 合并到 夜间自省（新键） |
| `selfPortrait` | bool / false | true | 「我现在的样子」每晚重写 | 槽 portrait（afterMain，模块 portrait） | 0340 | 2026-11-20 `life/self-portrait.ts`（2026-11-20） | 1（专测） | 需要数据才能判断：11-20 起试 |
| `herDays` | bool / true | 未在快照（=默认 true） | 每日心情、在读的书、她那边 | 槽 books、state、world、npcs、practice、obstacle | 0015 | 2026-11-20 `life/her-days.ts`（2026-10-05） | 60（专测） | 保留：默认开 |
| `schedule` | bool / true | true | 作息 | 槽 state、time 等（her-now 等十余个模块读） | 0007 | 2026-11-06 `life/schedule.ts`（2026-10-05） | 89（专测） | 保留：默认开 |
| `autonomousLife` | bool / false | true | 空闲时自主过日子（事件账） | 无直接槽（lifeInPrompt / projectChoice 读它的账） | 0040 | 2026-11-05 `life/actions.ts`（2026-10-09） | 10（专测） | 保留 |
| `projectChoice` | bool / false | true | 作业接管空闲安排 | 槽 state（her-now） | 0056 | 2026-11-05 `life/projects.ts`（2026-10-10） | 11（专测） | 合并到 autonomousLife：要 autonomousLife |
| `lifeInPrompt` | bool / false | true | 生活账进提示词（拍照修图几天） | 槽 practice、life | 0045 | 2026-11-12 `modules/practice.ts`（2026-10-10） | 12 | 合并到 autonomousLife：要 autonomousLife |
| `realWeather` | bool / true | 未在快照（=默认 true） | 真实天气 | 世界账 → 槽 world / state | 0048 | 2026-11-17 `world/world.ts`（2026-10-10） | 49（专测） | 保留：默认开；可作「真实世界」的总开关 |
| `realAirQuality` | bool / false | true | 真实空气质量 | 世界账 → 槽 world | 0227 | 2026-11-17 `world/world.ts`（2026-11-03） | 1（专测） | 合并到 realWeather |
| `realDaylight` | bool / false | true | 真实日照 | 世界账 → 槽 world | 0228 | 2026-11-17 `world/world.ts`（2026-11-03） | 1（专测） | 合并到 realWeather |
| `realCalendar` | bool / false | true | 法定节假日与调休 | 世界账 → 槽 world / days | 0231 | 2026-11-17 `world/world.ts`（2026-11-03） | 1（专测） | 合并到 realWeather |
| `everydayLife` | bool / false | true | 日常小事 / 小测 | 槽 world；意图、心境 | 0106 | 2026-11-20 `life/everyday.ts`（2026-10-22） | 11（专测） | 保留 |
| `worldDrama` | bool / false | true | 一天之内的小起伏 | 槽 world、feeling | 0211 | 2026-11-02 `world/threads.ts`（2026-11-02） | 5 | 合并到 everydayLife |
| `worldThreads` | bool / false | true | 她那边的事有后续 | 槽 world | 0216 | 2026-11-02 `world/threads.ts`（2026-11-02） | 1 | 合并到 everydayLife：要 everydayLife + worldDrama |
| `diaryLookback` | bool / false | true | 问到前几天时给她那天的日记 | 槽 recap（模块 memory） | 0217 | 2026-11-22 `language/self-thread.ts`（2026-11-02） | 0（专测） | 保留：线上开，测试里没有设它的 |
| `memoryFeelings` | bool / false | true | 回忆附当时的感觉 | 槽 recalled / recap（memory） | 0218 | 2026-11-20 `emotion/felt-then.ts`（2026-11-02） | 1（专测） | 保留：与 feltLedgerRecall 做同一件事，两条来源 |
| `feelingLedger` | bool / true | 未在快照（=默认 true） | 感觉账（只写文件） | 无槽 | 0347 | 2026-11-23 `emotion/feeling-ledger.ts`（2026-11-22） | 0（专测） | 合并到 herFeelings：默认开、要 herFeelings；不进提示词 |
| `feltLedgerRecall` | bool / false | 未在快照（=默认 false） | 召回旧事配账里的感觉 | 槽 recalled（memory） | 0347 | 2026-11-23 `emotion/feeling-ledger.ts`（2026-11-22） | 0（专测） | 合并到 memoryFeelings：11-22 新加；与 memoryFeelings 重叠 |
| `realNights` | bool / false | true | 昨晚真的怎么睡 | 槽 state（her-now） | 0219 | 2026-11-22 `life/nights.ts`（2026-11-02） | 3（专测） | 保留 |
| `menu` | bool / false | true | 每顿吃什么 | 世界事实 / 槽 state、world | 0125 | 2026-11-05 `life/menu.ts`（2026-10-23） | 6（专测） | 合并到 everydayLife |
| `pursuits` | bool / false | true | 她自己的追求 | 意图（先弄完这一小段）；追求本身不注入 | 0104 | 2026-11-20 `life/pursuits.ts`（2026-10-22） | 7（专测） | 保留 |
| `herFeelings` | bool / false | true | 心境（开心 / 难过 / 流泪） | 槽 feeling、pace、dreams（模块 feelings） | 0102 | 2026-11-23 `emotion/feelings.ts`（2026-10-22） | 9（专测） | 保留 |
| `feelingReview` | bool / false | true | 聊完回想、记有依据的感受 | 间接进槽 feeling；模块 reflections | 0197 | 2026-11-22 `emotion/feeling-review.ts`（2026-10-30） | 3（专测） | 合并到 夜间自省（新键）：要 herFeelings |
| `readingTakes` | bool / false | true | 读完 / 看完的想法 | 槽 takes（her-notes） | 0204 | 2026-10-30 `life/reading-takes.ts`（2026-10-30） | 3（专测） | 合并到 夜间自省（新键） |
| `herGuesses` | bool / false | true | 她猜的事和后来的结果 | 槽 guesses（her-notes） | 0213 | 2026-11-02 `life/her-guesses.ts`（2026-11-02） | 2（专测） | 合并到 夜间自省（新键） |
| `openQuestions` | bool / false | true | 没想完的问题夜里再想 | 槽 thoughts（her-notes） | 0207 | 2026-10-31 `life/open-questions.ts`（2026-10-31） | 4（专测） | 合并到 夜间自省（新键） |
| `ownerPeek` | bool / false | true | （已不起作用） | 无 | 0200 | 2026-11-22 `platform/private-space.ts`（2026-10-30） | 2（专测） | 候选删除：peekRefused 没有调用者，开关读了等于没读；用户 11-19 定为先留着，删要用户点头 |
| `grievance` | bool / false | true | 小别扭 / 和好 | 模块 crisis、intent、closeness 等 | 0074 | 2026-11-05 `emotion/grievance.ts`（2026-10-15） | 15（专测） | 保留 |
| `npcAsks` | bool / false | true | 闺蜜约 / 迟到 / 改约 | 槽 obstacle、world（meetup） | 0061 | 2026-11-06 `world/npc-asks.ts`（2026-10-18） | 3（专测） | 合并到 everydayLife |
| `festivals` | mode / off | greet | 公共节日（notes / greet） | 槽 time、days；主动问候 | 0076 | 2026-11-06 `world/festivals.ts`（2026-10-19） | 6（专测） | 保留 |

### 主动找他

| 开关 | 类型 / 默认 | 线上值 | 管什么 | 槽 / 模块 | ADR | 实现最后提交（引入） | 测试 | 建议 |
|---|---|---|---|---|---|---|---|---|
| `hisReactions` | bool / false | true | 主动分享前看他的反应 | 无槽（主动计划器） | 0212 | 2026-11-06 `proactive/his-reactions.ts`（2026-11-02） | 0（专测） | 合并到 proactive：线上开，测试里没有设它的 |
| `proactive` | mode / off | on | 主动消息总开关 | 主动消息提示词；模块 inner、follow-ups | 0011 | 2026-11-22 `proactive/proactive.ts`（2026-10-05） | 65（专测） | 保留 |
| `proactiveReach` | bool / false | true | 没回也继续 / 催他 | 主动计划器 | 0100 | 2026-11-22 `proactive/proactive.ts`（2026-10-22） | 3（专测） | 合并到 proactive |
| `innerLife` | bool / false | true | 内心念头 / 惦记 | 槽 inner；主动计划器 | 0101 | 2026-11-22 `modules/inner.ts`（2026-10-22） | 3（专测） | 保留 |
| `proactiveInvite` | bool / false | true | 约他一起玩 | 主动计划器 | 0107 | 2026-11-22 `proactive/proactive.ts`（2026-10-22） | 3（专测） | 合并到 proactive |
| `proactiveAsk` | bool / false | true | 问问他的意见 | 主动计划器 | 0116 | 2026-11-22 `proactive/proactive.ts`（2026-10-22） | 3（专测） | 合并到 proactive |
| `photoShares` | bool / false | 未在快照（=默认 false） | 喂完猫发张照片 | 主动计划器 | 0110 | 2026-11-22 `proactive/proactive.ts`（2026-10-22） | 2（专测） | 候选删除：33 天从没上线；要 photos 货架里有猫图 |
| `comeBack` | bool / false | true | 说了等下之后回来 | 主动计划器 | 0112 | 2026-11-22 `proactive/proactive.ts`（2026-10-22） | 3（专测） | 合并到 proactive |
| `hisHours` | bool / false | 未在快照（=默认 false） | 按他在线的钟头挪主动时机 | 主动计划器 | 0117 | 2026-11-22 `proactive/proactive.ts`（2026-10-22） | 4（专测） | 候选删除：33 天从没上线 |
| `smallNews` | bool / false | true | 主动讲今天的小事 | 主动计划器 | 0127 | 2026-11-22 `proactive/proactive.ts`（2026-10-23） | 3（专测） | 合并到 proactive |
| `proactiveRoom` | bool / false | true | 主动名额留余地 | 主动计划器 | 0124 | 2026-11-22 `proactive/proactive.ts`（2026-10-23） | 3（专测） | 合并到 proactive |

### 照片和表情

| 开关 | 类型 / 默认 | 线上值 | 管什么 | 槽 / 模块 | ADR | 实现最后提交（引入） | 测试 | 建议 |
|---|---|---|---|---|---|---|---|---|
| `biliStickers` | bool / false | true | 表情包在 B 站找 | 无槽（发表情） | 0132 | 2026-11-05 `language/bili-stickers.ts`（2026-10-23） | 4（专测） | 合并到 stickers |
| `readStickers` | bool / false | true | 看懂他发的表情包 | 无槽（聊天记录里的「[动画表情：…]」） | 0206 | 2026-11-17 `vision/media.ts`（2026-10-31） | 0（专测） | 合并到 media：要 media + vision；线上开，测试里没有设它的 |
| `foodPhotos` | bool / false | false | 吃的照片 | 槽 photo（media-offers） | 0128 | 2026-11-19 `vision/photo-discovery.ts`（2026-10-23） | 2 | 候选删除：线上显式 false，32 天 |
| `photos` | bool / false | true | 照片货架 | 槽 photo（media-offers） | 0109 | 2026-11-06 `vision/photos.ts`（2026-10-22） | 11（专测） | 保留 |
| `aiPhotos` | bool / false | 未在快照（=默认 false） | AI 生活照草稿 | 无槽 | 0240 | 2026-11-04 `vision/ai-photo-drafts.ts`（2026-11-04） | 2（专测） | 候选删除：20 天没上线；要独立生图服务 + 视觉审查，线上没配 |
| `stickers` | mode / off | send | 图片表情（collect / send） | 槽 sticker（media-offers） | 0063 | 2026-11-05 `social/stickers.ts`（2026-10-12） | 13（专测） | 保留 |
| `media` | bool / true | 未在快照（=默认 true） | 听语音、看图 | 聊天记录文本；media-offers | 0052 | 2026-11-17 `vision/media.ts`（2026-10-10） | 57（专测） | 保留：默认开 |

### B 站

| 开关 | 类型 / 默认 | 线上值 | 管什么 | 槽 / 模块 | ADR | 实现最后提交（引入） | 测试 | 建议 |
|---|---|---|---|---|---|---|---|---|
| `watching` | bool / false | true | 自己在 B 站看东西、有看法 | 槽 watched；synced-jobs | 0130 | 2026-11-05 `language/watching.ts`（2026-10-23） | 9（专测） | 保留 |
| `bilibili` | mode / off | on | 刷 B 站发给他 | 无槽（时间线记） | 0084 | 2026-11-20 `bilibili/bilibili.ts`（2026-10-19） | 12（专测） | 保留：B 站族的总开关 |
| `bilibiliAccount` | bool / false | true | 她自己的 B 站号登录 | 无槽 | 0089 | 2026-11-05 `bilibili/bilibili-account.ts`（2026-10-20） | 11（专测） | 合并到 bilibili |
| `biliFeed` | mode / off | on | 自己刷推荐（记下刷到的） | 无槽；喂 watching / memes | 0168 | 2026-11-19 `bilibili/passive-jobs.ts`（2026-10-26） | 4 | 合并到 watching |
| `bilibiliDm` | mode / off | on | B 站私信 | 无槽 | 0089 | 2026-11-19 `bilibili/owners.ts`（2026-10-20） | 5 | 合并到 bilibili |
| `bilibiliReplies` | mode / off | on | 回复 B 站评论 | 无槽 | 0090 | 2026-11-05 `bilibili/bilibili-replies.ts`（2026-10-21） | 7（专测） | 合并到 bilibili |
| `bilibiliComment` | mode / off | on | 话题评论 | 无槽 | 0092 | 2026-11-05 `bilibili/bilibili-comment.ts`（2026-10-20） | 5（专测） | 合并到 bilibili |

### 在 QQ 上的样子

| 开关 | 类型 / 默认 | 线上值 | 管什么 | 槽 / 模块 | ADR | 实现最后提交（引入） | 测试 | 建议 |
|---|---|---|---|---|---|---|---|---|
| `pokes` | bool / false | true | 被戳会回 | 「[戳了戳你]」进回复流程（模块 pokes） | 0079 | 2026-11-19 `modules/pokes.ts`（2026-10-19） | 5（专测） | 保留 |
| `pokeBack` | bool / false | true | 戳回去 | 模块 pokes | 0079 | 2026-11-19 `modules/pokes.ts`（2026-10-19） | 5（专测） | 合并到 pokes |
| `pokeOut` | bool / false | true | 主动戳他 | 无槽（presence-owner） | 0087 | 2026-11-19 `social/presence-owner.ts`（2026-10-19） | 6 | 合并到 pokes |
| `recalls` | bool / false | true | 看得到他撤回 | 聊天记录（模块 recalls） | 0082 | 2026-11-19 `modules/recalls.ts`（2026-10-19） | 13 | 保留 |
| `readReceipts` | bool / false | true | 已读回执 | 无槽 | 0083 | 2026-11-06 `social/responder.ts`（2026-10-19） | 5 | 合并到 QQ 表层（新键） |
| `reactions` | bool / false | false | 表情回应 | 无槽 | 0083 | 2026-11-06 `social/responder.ts`（2026-10-19） | 7 | 候选删除：线上显式 false，36 天 |
| `onlineStatus` | bool / false | true | 在线状态 | 无槽 | 0083 | 2026-11-19 `social/presence-owner.ts`（2026-10-19） | 8 | 合并到 QQ 表层（新键） |
| `profileLikes` | bool / false | true | 资料卡点赞 | 无槽 | 0083 | 2026-11-19 `social/presence-owner.ts`（2026-10-19） | 9 | 合并到 QQ 表层（新键） |
| `signature` | mode / off | on | 个性签名 | 无槽 | 0083 | 2026-11-06 `social/presence.ts`（2026-10-19） | 11（专测） | 合并到 qzone |
| `qzone` | mode / off | on | 说说 | 无槽 | 0083 | 2026-10-27 `social/qzone.ts`（2026-10-19） | 11（专测） | 保留：QQ 空间族的总开关 |
| `qzoneBrowse` | mode / off | on | 自己翻空间动态 | 一行进提示词 | 0142 | 2026-11-19 `social/presence-owner.ts`（2026-10-25） | 4 | 合并到 qzone |
| `qzonePeek` | mode / off | on | 刷好友动态 | 一行进提示词 | 0145 | 2026-11-19 `social/presence-owner.ts`（2026-10-25） | 3 | 合并到 qzone |
| `qzoneStrangers` | mode / off | on | 刷陌生人空间学说话 | 无槽 | 0144 | 2026-10-27 `social/qzone-strangers.ts`（2026-10-25） | 2（专测） | 合并到 qzone |
| `groupChat` | mode / off | on | 群聊 | 私聊里的槽 group；群里的回复 | 0210 | 2026-11-22 `social/group-chat.ts`（2026-11-02） | 4（专测） | 保留 |
| `groupOwn` | mode / off | dryRun | 群里带着此刻自己冒一句 | 模块 group-room | 0341 | 2026-11-22 `social/group-self.ts`（2026-11-20） | 0（专测） | 需要数据才能判断：11-20 起 dryRun；测试里没有设它的 |
| `groupAgency` | mode / off | 未在快照（=默认 off） | 群里开口由她自己的动机定 | 模块 group-room | 0343 | 2026-11-22 `social/group-room.ts`（2026-11-20） | 1 | 需要数据才能判断：11-20 新加，线上关 |
| `typingStatus` | bool / false | true | “正在输入…” | 无槽 | 0077 | 2026-11-06 `social/responder.ts`（2026-10-19） | 5 | 合并到 QQ 表层（新键） |
| `selfRecall` | bool / false | true | 打错字撤回重发 | 无槽 | 0086 | 2026-11-06 `social/responder.ts`（2026-10-19） | 3 | 合并到 QQ 表层（新键） |
| `quoteReply` | bool / false | true | 引用回复 | 槽 quote（模块 quote） | 0136 | 2026-10-27 `social/quote-reply.ts`（2026-10-24） | 4（专测） | 保留 |

### 记忆和安全

| 开关 | 类型 / 默认 | 线上值 | 管什么 | 槽 / 模块 | ADR | 实现最后提交（引入） | 测试 | 建议 |
|---|---|---|---|---|---|---|---|---|
| `identityLedger` | bool / false | true | 人设文件哈希链留痕、启动核对 | 无槽；模块 continuity（/设定） | 0157 | 2026-11-05 `memory/identity.ts`（2026-10-26） | 2（专测） | 合并到 留痕（与 memoryAudit 合一） |
| `memoryAudit` | bool / false | true | 长期记忆写入 / 遗忘留痕 | 无槽 | 0158 | 2026-11-05 `memory/memory-audit.ts`（2026-10-26） | 2（专测） | 合并到 identityLedger |
| `timeline` | bool / false | true | 跨渠道事件（B 站 / 设备 / 查资料）进 QQ | 槽 continuity（模块 continuity） | 0159 | 2026-11-06 `memory/timeline.ts`（2026-10-26） | 23（专测） | 保留 |
| `dormancy` | bool / false | true | /休眠 /唤醒 封存 | 无槽（保留指令） | 0161 | 2026-11-20 `memory/dormancy.ts`（2026-10-26） | 4（专测） | 保留 |
| `crossRecent` | bool / false | true | QQ 和 DSH 桌面互读最近几轮 | 槽 desktop、work（模块 memory） | 0177 | 2026-11-23 `memory/cross-recent.ts`（2026-10-29） | 2（专测） | 保留：「一个生活」各层的地基 |
| `selfExport` | bool / false | 未在快照（=默认 false） → 开（11-22） | 把此刻的她写成 SELF.json 给桌面 | 无 QQ 槽；导出 SELF_SLOTS 13 个槽 | 0347 | 2026-11-22 `life/self-export.ts`（2026-11-22） | 1（专测） | 合并到 crossRecent（「一个生活」层级）：11-22 起线上开 |
| `selfReceipts` | bool / false | 未在快照（=默认 false） → 开（11-22） | 桌面说过的话 QQ 不重发 | 无槽；计划器 toldElsewhere | 0347 | 2026-11-22 `memory/self-receipts.ts`（2026-11-22） | 1（专测） | 合并到 selfExport：要 selfExport；11-22 起线上开 |
| `desktopDay` | bool / false | 未在快照（=默认 false） → 开（11-23） | 桌面时间算进她的一天 | 无新槽；NOW.md、主动消息、时间线 | 0347 | 2026-11-22 `life/desktop-now.ts`（2026-11-22） | 1 | 合并到 crossRecent（「一个生活」层级）：11-23 起线上开；要 crossRecent |
| `desktopReview` | bool / false | 未在快照（=默认 false） | 桌面对话进聊完回想 | 模块 reflections（夜间） | 0347 | 2026-11-22 `emotion/feeling-review.ts`（2026-11-22） | 0（专测） | 需要数据才能判断：11-22 新加，线上关 |
| `desktopPromises` | bool / false | 未在快照（=默认 false） | 桌面答应的事进承诺账 | 间接进槽 promised | 0347 | 2026-11-23 `memory/owner-day-view.ts`（2026-11-22） | 1（专测） | 需要数据才能判断：11-22 新加，线上关 |
| `selfDirectedMemory` | bool / false | true | 她自己决定记不记（关自动记忆和日记） | 槽 selfMemory、understanding、traces；<<查>> | 0171 | 2026-11-18 `modules/review-pull.ts`（2026-10-28） | 2 | 保留 |
| `factHim` | bool / false | true | 事实检查多查「替他说的」 | 模块 review-facts | 0203 | 2026-11-22 `language/fact-check.ts`（2026-10-30） | 3（专测） | 合并到 factCheck：可做成 factCheck 的一档 |
| `memoryReconcile` | bool / false | true | Hindsight 对账、漏写的重排 | 无槽 | 0201 | 2026-11-22 `memory/long-term.ts`（2026-10-30） | 0 | 合并到 memory.enabled：有长期记忆就该对账；线上开，测试里没有设它的 |
| `unlistedFriends` | bool / false | false | 名单外好友也回 | 无槽 | 0209 | 2026-11-19 `social/private-admission.ts`（2026-10-04） | 11 | 候选删除：51 天从没上线（线上显式 false） |
| `feedbackCommands` | bool / false | true | “假 / 像”反馈通道 | 无槽 | 0073 | 2026-11-05 `emotion/feedback.ts`（2026-10-15） | 9（专测） | 保留 |
| `deviceControl` | mode / off | on | 操作他的电脑和手机 | 槽 devices（模块 devices） | 0148 | 2026-11-14 `modules/devices.ts`（2026-10-25） | 7 | 保留 |
| `qqControl` | mode / off | on | 账号控制面 | 模块 friend-requests | 0142 | 2026-11-19 `modules/friend-requests.ts`（2026-10-25） | 2 | 保留 |
| `qqFriendGate` | mode / off | allow | 好友申请同意 / 驳回 | 模块 friend-requests | 0142 | 2026-11-19 `modules/friend-requests.ts`（2026-10-25） | 2 | 合并到 qqControl |

### 工具

| 开关 | 类型 / 默认 | 线上值 | 管什么 | 槽 / 模块 | ADR | 实现最后提交（引入） | 测试 | 建议 |
|---|---|---|---|---|---|---|---|---|
| `webLookup` | mode / off | auto | 搜索 / 读网页 | 当轮资料（continuity / shell） | 0160 | 2026-11-18 `platform/web.ts`（2026-10-26） | 4（专测） | 保留 |
| `weeklyReport` | bool / false | true | 周报 | 无槽（synced-jobs） | 0118 | 2026-11-05 `platform/weekly-report.ts`（2026-10-22） | 3（专测） | 保留 |
| `dsh` | bool / false | enabled: true | 外部顾问 / 工作模式 | 槽 work、desktop、workMode 等 | 0223 | 2026-11-22 `platform/owner-commands.ts`（2026-11-03） | 13 | 保留：配置是 dsh.enabled |

### 不在功能总表里的

| 开关 | 类型 / 默认 | 线上值 | 管什么 | 槽 / 模块 | ADR | 实现最后提交（引入） | 测试 | 建议 |
|---|---|---|---|---|---|---|---|---|
| `realTransport` | obj / 关 | enabled: false | 真实交通 | 世界账 | — | 2026-11-17 `world/world.ts`（2026-11-04） | 3（专测） | 候选删除：20 天没上线；要可信 HTTPS 端点，线上 enabled: false |
| `adultSiteUrls` | list / [] | 未在快照（=默认 []） | 成人网站访问（留空即关） | 主动计划器 | — | 2026-11-18 `proactive/adult-sites.ts`（2026-11-18） | 0（专测） | 需要数据才能判断：11-18 新加，线上空 |

## 前 20 个删除候选

排序：先是没有争议的（死键、被取代、两周以上没用过），再是「线上开着但被 fewerRules 架空」的那 10 个——这 10 个的去留取决于 fewerRules 转不转正，要先定 fewerRules。

按 CLAUDE.md：删一个线上没开的开关不改变她的言行，可以直接做；后 10 个虽然线上已不生效，但会改行为基线（`test/baseline/snapshots/`），要单独提交、写清为什么，并且先问她本人、用户点头。

| # | 开关 | 线上 | 引入 | 理由 |
|---|---|---|---|---|
| 1 | `ownerPeek` | true | 2026-10-30（25 天） | 死键：唯一的读处 `peekRefused`（platform/private-space.ts:24）没有调用者，开不开行为一样。用户 11-19 定为「留着开关、只改说法」，删要用户再点头。 |
| 2 | `shortReplies` | false | 2026-10-19（36 天） | ADR 0091 明说形状控制取代它（软提示模型不听）；线上一直显式 false，引入 36 天。 |
| 3 | `tailCap` | false（被 fewerRules 关） | 2026-10-25（30 天） | 11-02 起五份快照都是显式 false；就算打开，fewerRules 下也被 relaxStyle 关掉。 |
| 4 | `hisHours` | 未在快照（=默认 false） | 2026-10-22（33 天） | 默认关 33 天，五份快照里都没开过；只调主动时机，没有别的东西依赖它。 |
| 5 | `photoShares` | 未在快照（=默认 false） | 2026-10-22（33 天） | 默认关 33 天，从没开过；还要 photos 货架里恰好有猫图才会动。 |
| 6 | `reactions` | false | 2026-10-19（36 天） | 线上显式 false，引入 36 天；接线只有 app.ts 给 responder 挂的一个 react 回调。 |
| 7 | `foodPhotos` | false | 2026-10-23（32 天） | 线上显式 false，引入 32 天；photo-discovery / 计划器里三处判断可一起拿掉。 |
| 8 | `unlistedFriends` | false | 2026-10-04（51 天） | 引入 51 天，线上一直显式 false；名单外不回已经是事实上的策略（private-admission 里还有签名写明是 AI 的前提）。 |
| 9 | `aiPhotos` | 未在快照（=默认 false） | 2026-11-04（20 天） | 引入 20 天没上线；要独立生图服务 + 视觉审查 + 人工审核，线上一样都没配。代码量不小（vision/ai-photo-*）。 |
| 10 | `realTransport` | enabled: false | 2026-11-04（20 天） | 引入 20 天没上线；要宿主配可信 HTTPS 端点，线上 `enabled: false`、没有数据源。 |
| 11 | `idioms` | true（段落被 fewerRules 丢） | 2026-10-24（31 天） | 段落只进 `idiom` 槽，属于 RULE_SLOTS，fewerRules 下被丢；但后台抽取照跑、照调模型——线上只花钱不生效。 |
| 12 | `exemplars` | true（段落被 fewerRules 丢） | 2026-10-30（25 天） | 段落只进 `exemplar` 槽（RULE_SLOTS），fewerRules 下被丢，线上不生效。 |
| 13 | `texture` | true（被 fewerRules 关） | 2026-10-23（32 天） | fewerRules 下被 relaxStyle 强制关，线上不生效。 |
| 14 | `shape` | true（被 fewerRules 关） | 2026-10-21（34 天） | 形状族的总开关，fewerRules 下被 relaxStyle 强制关。fewerRules 转正就整族（7 个）一起删；回退就保留 shape、把 6 个分项并进来。 |
| 15 | `shapeAgenda` | true（被 fewerRules 关） | 2026-10-21（34 天） | 同 shape。 |
| 16 | `shapeFiller` | true（被 fewerRules 关） | 2026-10-21（34 天） | 同 shape。 |
| 17 | `shapeSplit` | true（被 fewerRules 关） | 2026-10-22（33 天） | 同 shape。 |
| 18 | `shapeAsk` | true（被 fewerRules 关） | 2026-10-25（30 天） | 同 shape。 |
| 19 | `shapeLong` | true（被 fewerRules 关） | 2026-10-25（30 天） | 同 shape。 |
| 20 | `shapeFeel` | true（被 fewerRules 关） | 2026-10-22（33 天） | 同 shape。 |

另外两个接近候选、但还不够两周的：`groupAgency`（11-20，线上关）、`adultSiteUrls`（11-18，线上空），放在「需要数据」。

## 可以合成一个的几组

| 组 | 开关 | 说明 |
|---|---|---|
| 形状族 | `shape` `shapeAgenda` `shapeFiller` `shapeSplit` `shapeAsk` `shapeLong` `shapeFeel` | 7 个线上全开（又全被 fewerRules 关）。分项都要 shape 开着；留就合成一个 `shape`（子项永远跟着开），不留就整族删。 |
| 「一个生活」（ADR 0347） | `crossRecent` `selfExport` `selfReceipts` `desktopDay` `ownDays` `desktopReview` `desktopPromises` `oneDiary` `desktopFeelings` `desktopConflict` | 一个 ADR 下 10 个开关，彼此 requires 成链（selfReceipts←selfExport，desktop*←desktopDay←crossRecent）。建议做成一个分层取值：0 关 / 1 互读 / 2 加此刻导出和回执 / 3 加桌面时间，各块验收完就并进层级里，不再单独留键。 |
| 夜间自省 | `speechNotes` `chatReview` `diaryInsights` `readingTakes` `openQuestions` `herGuesses` `feelingReview` | 同一个模式：22 点后想一次、写进私人空间、聊到相关的才由 her-notes 放进提示词。线上全开。合成一个开关（或挂在 herFeelings 下），每样的「放不放进提示词」由内容自己决定。 |
| 心境与回忆的感觉 | `herFeelings` `feelingLedger` `memoryFeelings` `feltLedgerRecall` | feelingLedger 默认开、只写文件；memoryFeelings 和 feltLedgerRecall 都是「召回旧事时附当时的感觉」，只是来源不同（日记 / 感觉账）——同一件事两个开关，并成 memoryFeelings 一个、来源在代码里选。 |
| 主动时机 | `proactive` `proactiveReach` `proactiveInvite` `proactiveAsk` `comeBack` `smallNews` `proactiveRoom` `hisReactions` `hisHours` `photoShares` | 全是 planner-host 里 `config.X && withX` 那一串。线上开着的 7 个并进 proactive（on 就全有），没开过的 hisHours、photoShares 删掉。innerLife 管的不只主动（还有 inner 槽、herPlan），单留。 |
| 日常小事 | `everydayLife` `worldDrama` `worldThreads` `npcAsks` `menu` | 都往世界账里加「她那边发生的事」，线上全开；worldThreads 要前两个。 |
| 真实世界 | `realWeather` `realAirQuality` `realDaylight` `realCalendar` `realTransport` | 都在 world/world.ts 里取外部数据填世界账。前四个线上全开，并成一个；realTransport 没有数据源，删。 |
| B 站 | `bilibili` `bilibiliAccount` `bilibiliDm` `bilibiliReplies` `bilibiliComment` `acquaintances` `biliFeed` `watching` `biliStickers` | 线上全开。bilibiliAccount 是登录前提、Dm/Replies/Comment 都在 bilibili/owners.ts 一处读——并成 bilibili 一个模式；biliFeed 并进 watching；acquaintances 只来自 B 站回复；biliStickers 并进 stickers。 |
| QQ 空间与资料面 | `qzone` `qzoneBrowse` `qzonePeek` `qzoneStrangers` `signature` | 全在 social/presence-owner.ts 读，线上全 on。 |
| QQ 表层动作 | `readReceipts` `typingStatus` `onlineStatus` `profileLikes` `selfRecall` `reactions` | 都是 NapCat 的一个小动作、不进提示词。线上开着的 5 个合成一个；reactions 线上 false，删。 |
| 戳一戳 | `pokes` `pokeBack` `pokeOut` | ADR 0079 / 0087，线上全开。 |
| 意图阶梯的小分支 | `herNo` `afterNo` | afterNo 只在拒绝路径上起作用。 |
| 深思 | `deliberate` `depthRouting` | depthRouting 要 deliberate；两个都开。 |
| 事实检查 | `factCheck` `factHim` | factHim 要 factCheck，可做成 factCheck 的一档。 |
| 生活账 | `autonomousLife` `projectChoice` `lifeInPrompt` | 后两个要 autonomousLife 的账，线上三个都开。 |
| 留痕 | `identityLedger` `memoryAudit` `memoryReconcile` | 都是「有没有被悄悄改 / 漏写」的账，线上全开；memoryReconcile 可以直接跟着 memory.enabled。 |
| 节奏 | `rhythm` `lagTail` | 都是回复延迟。 |
| 追求 | `pursuits` `selfPursuits` | selfPursuits 要 pursuits，两个都开。 |
| 账号控制 | `qqControl` `qqFriendGate` | qqFriendGate 是 qqControl 的一部分。 |
| 看图 | `media` `readStickers` | readStickers 要 media + vision。 |

全按上表合并（每组留一个）+ 删掉前 20 个候选，开关从 136 个降到 55 个。若 fewerRules 回退、形状族保留 shape 一个，则是 56 个。

## 线上开着、但没有测试一起碰它们的

### 1. 线上开着、没有任何测试在开关这一层设它

| 开关 | 线上 | 专测文件 | 说明 |
|---|---|---|---|
| `diaryLookback` | true | 有（只测函数） | 问到前几天时给她那天的日记 |
| `feelingLedger` | 未在快照（=默认 true） | 有（只测函数） | 感觉账（只写文件） |
| `hisReactions` | true | 有（只测函数） | 主动分享前看他的反应 |
| `readStickers` | true | 有（只测函数） | 看懂他发的表情包 |
| `memoryReconcile` | true | 无 | Hindsight 对账、漏写的重排 |
| `groupOwn` | dryRun | 有（只测函数） | 群里带着此刻自己冒一句 |

### 2. 线上同时开着、有依赖关系的组合：哪些测试文件同时设了两边（「无」= 没有测试把这两个一起开过）

| 开关 | 依赖 / 相互作用 | 同时设两边的测试文件 |
|---|---|---|
| `selfReceipts` | `selfExport` | `bot/test/app.test.ts` |
| `desktopDay` | `crossRecent` | `bot/test/app.test.ts` |
| `worldThreads` | `everydayLife` | `koishi-plugin-qqbot/test/dashboard.test.ts` |
| `worldThreads` | `worldDrama` | `koishi-plugin-qqbot/test/dashboard.test.ts` |
| `memoryFeelings` | `herFeelings` | **无** |
| `feelingLedger` | `herFeelings` | **无** |
| `feelingReview` | `herFeelings` | `bot/test/app.test.ts`、`bot/test/baseline/scenarios.ts` |
| `factHim` | `factCheck` | `bot/test/baseline/scenarios.ts`、`koishi-plugin-qqbot/test/dashboard.test.ts` |
| `depthRouting` | `deliberate` | `bot/test/app.test.ts`、`bot/test/deliberate-module.test.ts` |
| `fewerRules` | `shape` | `bot/test/fewer-rules.test.ts` |
| `fewerRules` | `speechCheck` | `bot/test/fewer-rules.test.ts` |
| `fewerRules` | `texture` | `bot/test/fewer-rules.test.ts` |
| `fewerRules` | `idioms` | **无** |
| `fewerRules` | `exemplars` | **无** |
| `fewerRules` | `deliberate` | **无** |

### 3. 整套线上组合

基线 `test/baseline/scenarios.ts` 每个场景只开一小组开关，仓库里还没有按线上那一套整体跑过的已提交测试。
工作区里有一份未提交的 `packages/bot/test/inventory/live-mix.ts`（按快照在合成角色上跑、统计提示词指纹），正是补这个缺口的；本报告没有用它，也没有动它。

## 死键与表单不一致

核对了四层：`DEFAULTS`（155 键）、`AppConfig` 接口、`parseAppConfig` 的返回、Koishi 插件 `Config` 表单和 `toAppConfigInput`。

- `DEFAULTS` 的每个键都在 Koishi 表单里、都由 `toAppConfigInput` 传下去、都由 `parseAppConfig` 解析；`AppConfig` 接口和解析结果一一对应。没有「表单有、解析没有」或反过来的。
- 每个键在 `packages/bot/src`（除 config / features / modules 三个汇总文件）都至少有一处 `config.键` 的读取。
- **死键 `ownerPeek`**：读处只有 `platform/private-space.ts` 的 `peekRefused`，而 `peekRefused`、`PEEK_OFF_NOTICE` 在整个仓库里没有调用者（11-19 删 app.ts 那段之后）。配置页已写「已不起作用」。
- **形同虚设（读了，但线上被别的开关盖掉）**：fewerRules 开着时的 shape ×7、speechCheck、tailCap、texture（relaxStyle 覆盖），idioms、exemplars（段落被丢）。
- **读了但不在 Koishi 表单里**：`onebot`（只有独立入口 main.ts 用，Koishi 下连接归 adapter-onebot，按设计）；`llm.fallback` 和 `QQBOT_LLM_BASE_URL` / `QQBOT_LLM_MODEL` 覆盖只从环境变量来（2026-10-31 的决定）。
- **表单有、但不进 AppConfig**：`mobileCompanion.*`（插件自己读，index.ts:1028）、`memory.enabled` / `vision.enabled`（插件拿来决定传不传那一节）、`llm.thinking`（插件转成 extraBody）。都按设计。
- 快照里的 `memory.enabled`、`vision.enabled`、`llm.thinking`、`mobileCompanion` 是插件层的键，不是死键。`externalPlatforms` 三项线上都是 `authorized`，它在 `NOT_SWITCHES` 里、不在功能总表，状态页看不到——建议补进总表或在状态页单列。

## 建议的下一步

1. 先定 `fewerRules` 去留（11-20 起试）。它决定 10 个开关（形状族 7 个、texture、tailCap、speechCheck）的命运，另外 idioms（段落被丢、后台抽取照花钱）和 exemplars（段落被丢）也跟着它走。
2. 不改她言行、可以直接做的：删 `hisHours`、`photoShares`、`reactions`、`foodPhotos`、`unlistedFriends`、`aiPhotos`、`realTransport`、`shortReplies`、`tailCap`（线上都没开），各自单独提交。`ownerPeek` 要用户再点头。
3. 给线上开着、开关层没测的补测试：先补 `diaryLookback`、`hisReactions`、`readStickers`、`memoryReconcile`、`groupOwn`（dryRun）这几个已经跑了一阵的。
4. 合并按组做，每组一个提交；合并本身不改变行为（线上那几项本来都开着），但会改 Koishi 表单的键，要处理旧 koishi.yml 的兼容（`toAppConfigInput` 里读旧键）。

—— 生成：取数脚本读 `features.ts` / `config.ts` / 快照 / git log，再加人工核对的「管什么」「槽」「建议」两列。
