# 后台模型调用审计（2026-11-24）

只读分析，没有改代码。问题是：除了「回他那一句」以外，bot 还在哪些地方调模型；按线上那一套开关，哪些调用的结果根本到不了她的提示词或行为（只花钱），哪些可以少调。

接着 `docs/reports/2026-11-24-switch-audit.md`（开关审计）。那份已经指出 idioms「段落被 fewerRules 丢、后台抽取照花钱」；这份把所有调模型的地方都过一遍。

## 来源与口径

- 代码以 HEAD `e02fee9d` 为准。`platform/app.ts` 的行号是 HEAD 里的（工作区里另一位正在把桌面接线拆进 `life/desktop-host.ts`，未提交，app.ts 行号会挪，调用本身不变）；其余文件工作区和 HEAD 一致。
- 线上开关：`exchange/live/koishi-2026-11-20-1855.yaml` 的 qqbot 那一块，另加之后补开的 `selfExport`、`selfReceipts`、`desktopDay`。未在快照里的键 = 默认值。
- `fewerRules: true` → App 用 `relaxStyle`（`language/fewer-rules.ts:43`，`platform/app.ts:462` 套上）把 speechCheck、tailCap、texture、shape 及 6 个分项关掉、candidates 置 1；拼提示词时丢 `RULE_SLOTS`（`fewer-rules.ts:24–37`，`interpreter/slots.ts:99`，危机回合除外）。
- **模型配置**：线上 `llm.model = deepseek-flash`、`llm.thinking = high` → 插件转成 `extraBody: { thinking: enabled, reasoning_effort: high }`（`koishi-plugin-qqbot/src/index.ts:655`）。
  凡是拿 `config.llm` 或 `forExtraction(config.llm)` 调的都带着「深度思考」——`forExtraction` 只把 maxTokens 抬高，不关思考（`language/llm.ts:43`）。
  只有三处显式关思考：网页检索的小调用 `askSmall`（`app.ts:1412–1413`）、语义路由 `weigh`（`app.ts:1417`）、表情收藏判断（`social/stickers.ts:705`）。
  没想完的问题用 `deliberateModel = deepseek-v4-pro`、思考 high（`app.ts:914`，`config.ts:1213`）。
- 守卫（`language/model-guard.ts`）：后台一天 4000 次、聊天 6000 次才拦，并发后台 2 路；对花钱多少没有约束力。
- 「聊天」「后台」按守卫里的 `purpose` 分。注意：**内心（think）走的是 `purpose: 'chat'`**（`contact.ts:601` → `app.ts:2244`），不是 ADR 0101 说的「优先让给聊天」的后台。
- 不读真实角色资料，所以「哪些联系人有主动 / 内心」只能按代码说：内心按 `proactiveContacts`（`app.ts:1249`：卡上有 proactive 和 schedule 的档位）建，线上两位联系人（男朋友档、known 档）里 known 档有没有，要看启动日志那一行「主动消息：开：…」（`app.ts:1255`）。
- 每天次数是按代码里的节拍和门槛估的数量级，聊天量按 ADR 0197 记的「线上 5 天回他 117 次」≈ 每天 20–30 轮回复、3–6 段聊天。

## 总表

「线上有人用」：✅ 结果进提示词 / 改她的行为 / 发出去；⚠ 只有很小一部分用上；❌ 线上没人读。「思考」指这次调用带不带 reasoning_effort high。

### A. 每回一句附带的调用（不是回复本身，但跟着每条消息）

| # | 名字 | 调用位置 | 触发 / 频率 | 开关（线上） | 输出去哪 | 线上有人用 | 估计次/天 | 思考 |
|---|---|---|---|---|---|---|---|---|
| A1 | 逐条事实检查（审稿） | `modules/review-facts.ts:34` → `language/fact-check.ts:204`，接线 `app.ts:1196`（purpose chat） | 每条够长的回复一次（去掉标点后够 FACT_MIN_CHARS 字，`fact-check.ts:59–63`；危机、固定说法除外）；审稿提示词带整份设定和事实，输入很长；查出问题按 fix 带说明**整份提示词重写一次**（`contact.ts:620`）再查；后面几步改过稿再查一次（factsFinal） | `factCheck: fix`、`factHim` 开 | 改写 / 删行 | ✅ | 10–30（含重写） | **是**（forExtraction） |
| A2 | 语义路由（轻重分类） | `app.ts:1417`（`language/turn-weight.ts`，经 `modules/deliberate.ts:49`；purpose chat） | 每条能深思、关键词没认出的回复一次 | `depthRouting` + `deliberate` 开 | 决定这一轮换不换 deepseek-v4-pro。fewerRules 下 `deliberate`、`routedHint` 两个槽都在 RULE_SLOTS 被丢，条数上限也不再生效，**剩下的作用只有换模型** | ✅（只剩换模型） | ~20 | 否（80 token） |
| A3 | 要不要上网查 | `platform/web.ts:379`（`askSmall`，`app.ts:1424`） | 他的话 ≥6 字、带问句标记、不是私事；查到后提炼 / 换词再调 1–2 次（`web.ts:509/519`，有每日上限） | `webLookup: auto` | 「查到的」一行进提示词 | ✅ | 3–10 | 否 |
| A4 | 看图 / 读表情 | `vision/media.ts:279`、`:302`（看图模型） | 他发图 / 表情时；表情读过有缓存 | `vision`、`readStickers` 开 | 图上写着什么进聊天记录 | ✅ | 看他发多少 | — |

### B. 内心（只想一想，ADR 0101）

| # | 名字 | 调用位置 | 触发 / 频率 | 开关（线上） | 输出去哪 | 线上有人用 | 估计次/天 | 思考 |
|---|---|---|---|---|---|---|---|---|
| B1 | 想一想 | `proactive/proactive-planner.ts:783` `think()` → `social/responder.ts:607`（`initiate({ think: true })`）→ `platform/contact.ts:601` → `app.ts:2244`（**purpose chat，整份聊天提示词**） | 见下节 | `innerLife` 开（要 `proactive` 不是 off、`schedule` 开），每个主动联系人各一套 | 念头存进主动状态；`inner` 槽（最近 6 小时里最后 2 条，`proactive/inner.ts:70–71`）、SELF.json、想告诉 / 想问他的变成主动消息、今天的打算、想查的去查 | ✅（约 1/3 的念头从没进过提示词，但可能变成主动消息） | 男朋友档 8–12（重试另算，见下）；known 档若也有则翻倍 | **是**（主模型） |

### C. 夜里 / 聊完想一次（`modules/reflections.ts`，接线 `app.ts:886–916`；都只给男朋友档）

| # | 名字 | 调用位置 | 触发 / 频率 | 开关（线上） | 输出去哪 | 线上有人用 | 估计次/天 | 思考 |
|---|---|---|---|---|---|---|---|---|
| C1 | 她自己定追求 | `life/self-pursuits.ts:301`（`reflections.ts:89`） | 20 点后，距上次 20 小时，失败最多试 3 次；**没有「有没有材料」的门槛，每晚必调** | `selfPursuits` + `pursuits` 开 | `self-pursuits.json` → `selfAwareReader`（`app.ts:1813`）→ 只进心境模块的 appraisals（`modules/feelings.ts:47–49`） | ⚠ 几乎没有（见「可以直接省」2） | 1 | 是 |
| C2 | 说话习惯 | `language/speech-notes.ts:404` | 22–3 点，20 小时一次；她这几天回得够多才想 | `speechNotes` 开 | `speechNote` 槽（her-notes，总是放）；「我现在的样子」和学习问题的材料 | ✅ | 1 | 是 |
| C3 | 聊天回顾 | `language/chat-review.ts:284` | 22 点后一次；当天有她的回复才想 | `chatReview` 开 | `review` 槽（他难受时不放） | ✅ | 1 | 是 |
| C4 | 聊完回想心境 | `emotion/feeling-review.ts:409` | 每 10 分钟看一眼：一段聊天结束 30 分钟后、≥4 条新消息、距上次 ≥1 小时，一天最多 8 次（`:376–381`） | `feelingReview` + `herFeelings` 开 | appraisals → `feeling` 槽（`feelings.ts:57`）、桌面 FEELINGS | ✅ | 3–6（上限 8） | 是 |
| C5 | 自我认识 | `life/diary-insights.ts:311` | 22 点后；日记有新的才想 | `diaryInsights` 开 | `insight` 槽（聊到才放）、桌面导出、「我现在的样子」材料 | ✅ | ≤1 | 是 |
| C6 | 读完看完的想法 | `life/reading-takes.ts:262` | 夜里一次；今天有读到 / 看了的才想 | `readingTakes` 开 | `takes` 槽（聊到那本书 / 视频才放） | ✅ | ≤1 | 是 |
| C7 | 没想完的问题 | `life/open-questions.ts:306`，模型在 `app.ts:914`（**直接 chatCompletion，没经执行器**） | 22 点后；白天记下了「不知道」的问题才想 | `openQuestions` 开 | `thoughts` 槽（他再问到才放） | ✅ | ≤1 | 是，**v4-pro** |
| C8 | 她猜的事 | `life/her-guesses.ts:420` | 22 点后；有候选 / 挂着的才想 | `herGuesses` 开 | `guesses` 槽、内心想一想的题目 | ✅ | ≤1 | 是 |
| C9 | 我现在的样子 | `life/self-portrait.ts:218`（格式不对再追问一次 `:221`） | 22 点后；材料变了才想 | `selfPortrait` 开 | `portrait` 槽，男朋友档每轮都带 | ✅ | 1–2 | 是 |
| C10 | 学习问题 / 夜里做梦 / 午睡小梦 / 一月回看 | `life/dream-jobs.ts:97`、`:168`、`:126`、`:145`（`modules/dreams`，接线 `app.ts:948–962`） | 20 点后一次；睡着那几小时一次；13–15 点约 45% 的天；25 天一次 | `herFeelings` 开 + 男朋友档 | `question` 槽；`dreams` 槽；回看写进记忆 | ✅ | 2–2.5 | 是 |

### D. 抽取类

| # | 名字 | 调用位置 | 触发 / 频率 | 开关（线上） | 输出去哪 | 线上有人用 | 估计次/天 | 思考 |
|---|---|---|---|---|---|---|---|---|
| D1 | **他的口头习惯** | `modules/idioms.ts:63`（模块在 `app.ts:854–861` 建） | 补完消息后一次 + 每 6 小时看一眼（`language/idioms.ts:50`）；真调要 30 天里他 ≥60 条、≥20 条新的、距上次 ≥20 小时（`idioms.ts:252–258`）；只男朋友档 | `idioms` 开 | `idioms/<QQ>.json` → 唯一读者是 `idiom` 槽（`modules/idioms.ts:30`），属 RULE_SLOTS，fewerRules 下被丢；危机回合本来就不放（playfulAllowed）。别的读者只有遗忘 / 隐私清点（删文件用） | ❌ | ≤1 | 是 |
| D2 | 小梗 | `modules/jokes.ts:58` | 同上的节拍（20 小时、≥40 条、≥12 条新的） | `jokes` 开 | `joke` 槽（不在 RULE_SLOTS） | ✅ | ≤1 | 是 |
| D3 | 她答应的事 | `life/promises.ts:644`、`:750`（`app.ts:1589`） | 名单里每个人每段聊天结束（安静 45 分钟）一次；聊着聊着约见面时先抽一次 | 长期记忆开 | 承诺账 → `promised` 槽、时间块、日记打算、世界账 | ✅ | 3–8 | 是 |
| D4 | 待跟进 | `proactive/proactive-planner.ts:453`（`planner-host.ts:185`） | 每个主动联系人每段聊天结束一次 | `proactive` 开 | 主动消息的跟进 | ✅ | 3–6 | 是 |
| D5 | 口味 | `app.ts:1445`（`life/tastes.ts`） | 一天最多一次 | `tastes` 开 | 提示词一行 | ✅ | ≤1 | 是 |
| D6 | 网络热梗 | `language/memes.ts:315`（挑词）、`:332`（每个新词解释）；`bilibili/passive-jobs.ts:147` | 每 6 小时一轮（`memes.ts:58`）：挑词 1 次 + 新词最多 8 个各 1 次（`:62`） | `memes` + `bilibiliAccount` 开 | `meme` 槽（约一半轮次给 3 个）、梗词典 | ✅ | 4–36（常见 10–20） | 是 |
| D7 | 群友印象 | `social/group-room.ts:443` | 她在群里说完一批后，最多一个人、14 天才重写 | `groupChat: on` | 群里的提示词 | ✅ | 很少（只在被叫到时） | 是 |

### E. 对外 / 生活里的

| # | 名字 | 调用位置 | 触发 / 频率 | 开关（线上） | 输出去哪 | 线上有人用 | 估计次/天 | 思考 |
|---|---|---|---|---|---|---|---|---|
| E1 | 走开前说一声 | `life/leave-note.ts:130`（`app.ts:970`） | 进入洗澡 / 上课这类时段、聊天正在进行时；一天 ≤3 | `proactive` 开 | 发 QQ | ✅ | 0–3 | 是 |
| E2 | QQ 空间说说 | `social/qzone.ts:70`（+有图时看图 `:51`），`presence-owner.ts:73` | 距上次 ≥20 小时（`presence.ts:147`） | `qzone: on` | 发出去 | ✅ | ≤1 | 是 |
| E3 | B 站评论 / 回评论 | `bilibili/bilibili-comment.ts:79`、`:123`（`owners.ts:104`、`:222`） | 刷 B 站时；回评论每 10 分钟查一次 | `bilibiliComment`、`bilibiliReplies: on` | 发出去 | ✅ | 看量 | 是 |
| E4 | 表情收藏 | `social/stickers.ts:437`/`:455`（看图）+ `:705`（收不收） | 每小时最多 3 张、公开目录每天 ≤3；他发的表情也看 | `stickers: send`、`biliStickers` | 收藏库 → 发表情 | ✅ | 6–15 | 判断那次否 |
| E5 | 照片货架 | `vision/photo-sources.ts:253`、`:378`（看图） | 每 6 小时，凑够猫 8、风景 6 张就不找 | `photos` 开 | 他要看照片时发 | ✅ | 0–几 | — |
| E6 | 看视频的画面总览 | `bilibili/passive-jobs.ts:76`（看图） | 每天看一个视频时一两张 | `watching` 开 | `watched` 行里的「画面总览」 | ✅ | 1–2 | — |

### F. 线上不调的（列出来免得重复查）

- 日记 `app.ts:1624`：`writesDiary = oneDiary || !selfDirectedMemory`（`app.ts:1607`），线上 selfDirectedMemory 开、oneDiary 关 → 不建。
- 最近几轮 + 要点 `app.ts:1877`：`contextTurns: 0`。
- 挑候选（多生成几个）：relaxStyle 置 1。出口检查重写（`exit-check.ts:340`）、形状重写（`shape.ts:394`）、话说到一半（`unfinished.ts:108`）：speechCheck / shape 被 relaxStyle 关。危机改写（`exit-check.ts:424`）只在危机回合。
- AI 生活照（`aiPhotos` 关）、DSH 顾问（`dsh-link.ts:304`，只在 /dsh 或桌面问时）、「此刻的她」快照（`contact.ts:744`，不调模型）。
- exemplars：不调模型（只读语料），它的段落被 fewerRules 丢掉是另一回事。

### G. 进程外：Hindsight 自己调的模型（不经守卫、不在合成跑的计数里）

- 每段聊天写入时 Hindsight 调一次 DeepSeek 抽取，进行中的片段每多 30 条整段重写一次（`docs/hindsight.md:233`）；关系概况 Mental Model 在整合后自动刷新。模型 deepseek-flash，关思考（`docs/hindsight.md:22`）。
- 我们这边触发它的是长期记忆同步（每 5 分钟，`app.ts:228`）和她自己记的话（`rememberSelfNote`）。量级和 D3 同阶（每段聊天 1 次以上）。

## 内心（think）单独说

- **多久一次**（`proactive-planner.ts:734–760`，常量 `proactive/inner.ts:57–66`）：上一次之后 90–150 分钟；他说过话、之后 20 分钟没人说就提前，但离上次至少 30 分钟；睡着不想，起床 45 分钟后想第一次；失败 10 分钟后再试。
- **上限名义上一天 12 次，但数的是「留下的念头」，不是调用**（`:750–752` 数 `inner.thoughts`）：
  - 写成了对他说话 / 书面腔会当场再生成一次（`:797–812`，一次 think 最多 2 次调用）；
  - 「想了但不留」（重复、太短、第二次还是对他说话）不进 `thoughts`，不占名额；
  - 「没想成」（预算放不下、模型没连上）10 分钟后重来，也不占名额。
  所以实际调用数没有硬上限，只被「至少隔 30 分钟」和醒着的时长挡着。聊天多的一天，男朋友档一套就能到 12 次留下 + 若干次重来。
- **每次多贵**：走回复器的主动通道，拼的是和回他一模一样的整份提示词（角色卡、记忆召回、聊天记录、「此刻」块），用主模型、思考 high，只是不检查、不发送（`responder.ts:601–609`）。是单次最贵的后台调用。
- **按联系人各一套**（`planner-host.ts:88–100`）：`innerLife` 只看开关，不看档位。known 档的卡如果带主动设置，她对那位也每天想 8–12 次。
- **用了多少**：`inner` 槽只放最近 6 小时里最后 2 条（`inner.ts:70–71`）。按 2 小时一次算，三条里有一条从没进过任何提示词；它还可能变成「想告诉他 / 想问他」的主动消息（一天最多 2 条，ADR 0101 第 4 条）、今天的打算、想查的东西。
- ADR 0101 写的是「每天多约 10 次后台调用，优先让给聊天，费用可忽略」——实际是 chat 通道、整份提示词、带思考。合成两天跑里 38 次给联系人的生成有 24 次是 think（见下）。

## 合成两天跑（线上开关 + selfExport / selfReceipts / desktopDay）

跑的是 `test/inventory/live-mix.ts` 的场景（合成角色，男朋友档「阿明」+ 同学档「小周」，12-14 07:30 到 12-15 22:00，他说 13 句、同学 1 句），
另包了一层假模型，把每次调用的提示词开头记下来按调用位置归类（脚本在临时目录，不进仓库）。共 **139 次：后台 83、chat 56**，和协调方那次一致。

| 调用位置 | 次数 | 备注 |
|---|---|---|
| D4 待跟进 | 30 | **10 段聊天 × 每段 3 次**：假模型回 `[]`，不是待跟进要的对象，解析失败就 5 分钟后再抽，3 次才放弃（`proactive-planner.ts:463–466`）。线上模型正常时每段 1 次 |
| B1 内心 | 24 | 18 次想 + 6 次「写成了对他说话」当场重来；全是男朋友档（合成卡的同学档没有主动）。第一天 08:32–23:57 想了 11 次，第二天到 21:23 想了 7 次 |
| C4 聊完回想心境 | 16 | 同样因为假模型回 `[]` 解析失败，每小时重试一次，两天顶到每天 8 次的上限 |
| 回复 + 主动（整份） | 14 | 回复 12（其中 1 次深思换 v4-pro）、主动 2 |
| A1 事实检查 | 9 | 只查够长的回复（`fact-check.ts:59–63`），没查出问题所以没有重写 |
| A2 语义路由 | 9 | 同学档的回复也问 |
| C9 我现在的样子 | 8 | 4 次 + 4 次格式追问（假模型的格式不对） |
| C1 追求 / C2 说话习惯 / C6 读完看完 / C8 她猜的事 | 各 4 | 每晚失败后 2 小时重试，一晚最多 3 次 |
| C3 聊天回顾 | 3 | 同上 |
| C10 学习问题 2、午睡小梦 2、夜里做梦 1 | 5 | |
| D2 小梗 | 2 | |
| A3 要不要上网查 | 2 | |
| D1 口头习惯 | 1 | 启动补完消息后那一次；结果线上不进提示词 |

读法：
- 83 次后台里大约一半是「假模型回的东西解析不了 → 重试」造成的（待跟进 20 次多余、心境回想 10 次左右多余、夜里那几样每样多 2–3 次）。线上模型正常回 JSON 时，后台大约是 35–45 次 / 两天。
  反过来说，**线上模型一旦回坏格式，这几样会顶着各自的重试上限一直调**（待跟进每段 3 次、心境回想每天 8 次、夜里每样每晚 3 次），值得在日志里留意「抽取失败」「回复里没有可用的 JSON」。
- 内心 24 次是 chat 通道里最多的一类，比回他（12 次）还多一倍；每次是整份提示词。
- 合成跑没有接 B 站、QQ 空间、表情、照片、热梗（要账号和网络），也没有 Hindsight，所以 D6、E 类、G 类不在这 139 次里。

## 线上每天大概多少次

| 类 | 次 / 天（量级） | 带思考 | 备注 |
|---|---|---|---|
| 回复本身 | 20–30 | 是 | 参照 |
| A 每回一句附带 | 35–60 | 事实检查带，路由 / 检索不带 | 事实检查（含重写）最贵 |
| B 内心 | 8–15（男朋友档）；known 档若有再加一份 | 是，整份提示词 | 单次最贵 |
| C 夜里 / 聊完 | 12–18 | 是（C7 是 v4-pro） | 大头是心境回想 3–6 |
| D 抽取 | 20–55 | 是 | 热梗 10–20、承诺 + 待跟进 6–14 |
| E 对外 / 生活 | 10–25 | 部分 | 看图为主 |
| G Hindsight | 5–15 | 否 | 进程外 |

后台（B–E）合计每天 50–110 次，回复本身的 2–4 倍；其中「输出没人用」的只有 D1 和几乎没人用的 C1，量不大（每天 2 次左右）。真正的钱在 B（整份提示词 × 思考 × 次数）、A1（每条回复多一次带思考的审稿）、D6（热梗每 6 小时一轮）和「抽取类都带着 reasoning_effort high」。

## 排序

### 可以直接省的（输出没人用）

1. **口头习惯的后台学习**：`packages/bot/src/modules/idioms.ts:63`（调用），模块在 `packages/bot/src/platform/app.ts:854`（`const idioms = config.idioms ? idiomsModule(...)`）建。
   结果只进 `idiom` 槽（`modules/idioms.ts:30`），`idiom` 在 RULE_SLOTS（`language/fewer-rules.ts:36`），fewerRules 开着时被丢（`interpreter/slots.ts:99`）；危机回合虽然不丢 RULE_SLOTS，但 idioms 模块自己在危机回合不放（`playfulAllowed`）。线上每天 ≤1 次、带思考，纯浪费。
   省法二选一：关 `idioms` 开关（改线上开关，要用户点头）；或代码里 `config.idioms && !config.fewerRules` 才建学习的那一半（不改变她言行，可以直接做；fewerRules 撤了就自动恢复）。
2. **她自己定追求的每晚反思**（几乎没人用，有一点残余作用）：`packages/bot/src/life/self-pursuits.ts:301`（调用），定时在 `packages/bot/src/modules/reflections.ts:89`，接线 `packages/bot/src/platform/app.ts:897`。
   - 追求的文字早就不进提示词（`interpreter/slots.ts:37`「她的追求不再注入」，没有槽）；`/追求` 指令已收掉（指令收敛）；
   - 她自己提的追求没有 steps，`customView` 不产生 appraisals（`life/pursuits.ts:194–204`）；她给作者那两条记的进度只拼进 view 的 text，text 没人读；
   - 唯一残余：她把作者给的两条（课程 / 相机）暂停或放下时，那两条的心境来由跟着没了。
   每晚 1 次、没有材料门槛、带思考。因为有这一点残余作用，按规矩撤之前先 `ask-her`。

### 可以降频 / 降配的（结果有用，但调得比需要的多或贵）

1. **内心想一想**（`proactive-planner.ts:734–760`）：上限改成数调用而不是数留下的念头；间隔放宽（念头只看最近 2 条，2 小时一次已经有三分之一没人看）；只给男朋友档。改的是她想事情的频率，属于「改她的行为」，要先问她。
2. **抽取类关思考**：D1–D7、C10、A1 都经 `forExtraction`，不关思考（`language/llm.ts:43`）。仿 `quietLlm`（`app.ts:1412`）给抽取、审稿配一份关思考的配置，次数不变、每次便宜很多。抽取 JSON 的质量可能变，先在模拟器对一轮再定。
3. **网络热梗**每 6 小时一轮（`language/memes.ts:58`）→ 12 或 24 小时：梗 45 天才过期、最多留 40 个，一天刷 4 遍榜收益很小。文件头写的就是「每 12 小时一次」，和常量不一致。
4. **承诺和待跟进抽两遍同一段**（`life/promises.ts:644` 与 `proactive/proactive-planner.ts:453`）：同一段聊天结束时各调一次、各拼一份转写。合成一次调用、两边分用，每段聊天省一次。
5. **聊完回想心境**一天最多 8 次（`emotion/feeling-review.ts:381`）：可以降到 3–4，或要求新消息更多（MIN_NEW 4）。会改她心境的来由，要先问她。
6. **事实检查** factsFinal：fewerRules 下后面几步（出口检查、形状、话说到一半）都关了，稿子很少再变，第二次查本来就少；主要的钱在第一次审稿和重写。若保留 fix，至少审稿那次关思考（同 2）。

### 要用户决定的

1. **fewerRules 的去留**：它定了 idioms（D1）和 exemplars 白干、语义路由（A2）只剩换模型。留 fewerRules 就该省 D1；撤 fewerRules，D1 又有用。
2. **known 档要不要有内心**：看启动日志「主动消息：开：…」那一行，known 档在里面就说明她对那位也每天想 8–12 次整份提示词。
3. **语义路由（A2）**：每条回复一次小调用，fewerRules 下只剩「换不换 v4-pro」这一个作用。值不值，要看深思轮次的效果数（ADR 0348 的周数里可以加一项）。
4. **事实检查 fix（A1）**：每条回复多一次带思考的审稿，查出问题还要整份提示词重写一次，是附带调用里最贵的。降成 log、只查主动消息，或关思考，要用户定。
5. **没想完的问题用 v4-pro + 思考（C7）**：每晚最多一次，单价最高，用户 10-31 定的「让她真正思考」。
6. **Hindsight 的抽取（G）**：不在我们的守卫里，也不在合成跑的计数里；要知道真实花了多少，得从 DeepSeek 账单或 Hindsight 日志按天数。
7. ADR 0101 里「费用可忽略、优先让给聊天」和现状不符（走 chat 通道、整份提示词、带思考），要不要改 ADR 的说法或改实现。
