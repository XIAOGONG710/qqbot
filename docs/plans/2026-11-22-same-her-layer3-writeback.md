# 同一个她·第 3 层：桌面上过的时间算进她的一天（细化方案）

- 日期：2026-11-22
- 上位决策：[ADR 0347](../adr/0347-one-life-two-places.md)「一个生活，两个地方」第 3 层
- 状态：方案，待用户点头；每一块都挂默认关的开关，开关关着时行为基线逐字不变
- 行号以 2026-11-22 的工作区为准（第 1 层的改动还没提交，`app.ts`、插件 `index.js` 的行号之后可能会偏几行）

## 背景

ADR 0347 定了：生活只在 QQ 的 bot 里算，DSH 桌面是她去的一个地方，离开时要把发生过的事交回生活。现在桌面上发生的事只有两种方式进 QQ：一是最近 3 轮原文临时塞进提示词（crossRecent），二是她自己想起来调工具报一条。所以作息、心境、承诺、日记、主动消息的闸门都不知道「她刚在电脑前陪了他两小时」。本文要做的就是把「一段桌面会话」变成她一天里的一段经历，让上面这些账都能看到它，同时不让桌面原文流到男朋友档以外的地方。

## 一、取证

### 1.1 现在 DSH → QQ 的几条路

| # | 文件 / 通道 | 谁写（插件 `dsh-plugins/dsh-linmengyao-memory/index.js`） | QQ 谁读、进了哪里 | 缺什么 |
|---|---|---|---|---|
| 1 | `<数据目录>/memory/desktop-recent.jsonl` | `turn-stopping` 钩子里的 `recordDesktopTurn`（`index.js:844-856`，函数在 `:486-498`）：每轮 `{at,user,assistant}`，每句截 600 字，保留最近 40 行；只有 `HER_CHANNEL` 没设（= 他本人在桌面上说话）才记（`:387-388`、`:487`） | `memory/cross-recent.ts:65-73` 的 `desktopBlock`：取 6 小时内最近 3 轮，经 `modules/memory.ts:133` 放进**男朋友档**提示词（`app.ts:1871` 挂接，开关 `crossRecent`）。`memory.ts:133` 没判断 `initiate`，所以主动消息和念头（`responder.initiate`）也能看到 | **只进提示词，哪本账都不进**：作息、心境、承诺、日记、闸门都看不到；文件会滚动，不算持久记录 |
| 2 | `~/.dsh/linmengyao/timeline-inbox.jsonl` | `memory_save` 成功后记一条（`:930-933`）；`timeline_record` 工具（`:956-966`），**要模型自己去调** | `memory/dsh-inbox.ts:183-187` 以 `desktop` 渠道写进 `Timeline`（`app.ts:1283-1306` 每 30 秒收一次，跟着 `dsh.enabled`）→ `timeline.promptLine` 进男朋友档的连续性块（`app.ts:1444`，`memory/timeline.ts:124-129`，24 小时内最多 5 条） | 光聊天不会留下记录；要 `timeline` 和 `dsh.enabled` 都开着 |
| 3 | `~/.dsh/linmengyao/world-inbox.jsonl` | `world_event` 工具（`:993-1030`），也要她自己报 | `dsh-inbox.ts:189-201` 以 `source:'external'` 交给 `sharedWorld.recordEvents`，世界账照常裁决（ADR 0226） | 「在电脑上陪他」本身不是世界事件，精力、日记里的「你那边今天」都不知道有这段 |
| 4 | Hindsight 他的 bank | `turn-stopping` 自动存一轮（`:857-864`）、`memory_save`（`:928`） | QQ 的语义召回 / 工作房召回（`modules/memory.ts:116`、`:128`） | 没有时间结构，「今天」用不上它 |
| 5 | `OUTBOX.jsonl` | `outbox_send`（`:1330-1353`） | `app.ts:1621-1652` 的 `drainOutbox` 通过 QQ 发给他并写进聊天记录；闸门 `blocked` 只看危机、休眠、睡了（`:1635-1638`） | **他正坐在电脑前时，她留的话照样从 QQ 发出去** |
| 6 | `SOUL.md` | `soul_update`（`:1044-1090`） | `life/self-portrait.ts:422-428` 读最近几段，用于 PORTRAIT（ADR 0340） | 这是「自我」不是「生活」，本层不动 |
| 7 | `JOURNAL.md` | `journal_write`（`:1153`）：桌面聊天时她自己写，或者常驻进程睡眠整合时写（`scripts/her-resident.mjs:154-158`，`HER_CHANNEL=idle`，`:47`） | 五处：`soul.selfThread`（`app.ts:1095-1105`）、`wake` 首轮铺底（`:1120-1129`）、`diaryLookback`（`:1851-1856`）、`readDiaries`（`life/diary-insights.ts:132-145`，供心境回想、自我认识用）、`life/dream-jobs.ts:52`、`:130` | 成了**第二本日记**，见 §1.6 |
| 8 | `LEDGER.md` / `WISHES.md` / `INTERESTS.md` / `PRIVATE.dat` / `OFFLINE.json` | 插件对应的几个工具 | QQ 一处都不读（在 `packages/bot/src` 里 grep 不到） | `INTERESTS.md`（她自己定的兴趣，最多 3 件）和 QQ 的 pursuits / self-pursuits 是两套动机。这属于第 1 / 4 层，本层不处理，只在这里记一笔 |

附带的一个发现：插件 `recordDesktopTurn` 写之前用 `tailLines(file)` 读的是文件**最后 64 KB**（`index.js:391`、`:383`、`:492`）。一行最多 600+600 个汉字，约 3.6 KB，所以长对话时实际只能留下约 17 行，到不了注释说的 40 行。对 crossRecent（只用 3 轮）没影响，但这个文件不能拿来当「今天在桌面上的全部对话」。

### 1.2 「此刻她在不在陪他」只看 QQ

- NOW.md 的「和你聊天中」：`app.ts:1606-1607` 用的是 `history.load(owner.qq).at(-1)`，只有 QQ 聊天记录；`life/now-export.ts:67-71` 的 `activityWithChat` 窗口是 10 分钟。**DSH 会把 NOW.md 注入到这一场桌面对话本身**（`index.js:885-893`）。结果是他正在桌面上和她聊，提示词里却写着她「在上课」「在看剧」。
- 主动消息闸门：`proactive/proactive.ts:939-1009` 的 `blockReason` 里，「一小时内聊过」「正聊着，聊天里说」「20 分钟内聊过」「他今天已经来过消息」「已经道过晚安」都只看 `input.history`，也就是 QQ 聊天记录（`:950-996`）。所以他在桌面上陪她聊了一下午，QQ 那边照样可能发出「你在干嘛」。
- 陪玩已经有现成的钩子：`blockReason` 第 963 行 `input.together?.(now)` → `'正和他一起玩'`，由 `proactive/planner-host.ts:90` 接入，判断是 `language/together.ts:42-67` 的 `togetherNow`，从聊天记录往回推，不落盘。
- 留话（OUTBOX）的闸门同样不知道桌面这边（见表中第 5 行）。

### 1.3 together 能不能直接复用

`together.ts` 认的是 **QQ 聊天里约打游戏、答应了**的关键词（`:18-24`），在 `modules/together.ts:30-32` 放进提示词的那一行是「回话短一点、聊眼前这局」（`together.ts:72-75`）。ADR 0111 自己写了「不改她的生活账」（`0111-together.md:24`）。桌面会话的意思不一样：她人在电脑前，正在陪他做事或聊天。照搬「回话短」是错的。
**结论：模块不复用，复用它的三种做法**：从记录往回推、不另存状态；在 `blockReason` 里加一个钩子；只给男朋友档。会话的边界沿用长期记忆分片段的间隔 `EPISODE_GAP_MS = 45 分钟`（`memory/episodes.ts:14`），两边对「一段」的理解一致。

插件那几个钩子能不能用来判断会话开始 / 结束：`agent/created`（`index.js:778`）是**每个 agent 一次**，桌面窗口开着就一直是同一个 agent，不等于会话开始；`agent/pre-step`（`:790`）是**每个模型步骤**都触发；只有 `agent/turn-stopping`（`:844`）是一轮一次，而且已经在记。所以**会话由 QQ 侧根据回合的时间戳推出来**，插件这边只需要给每一行补上「他这句话是几点说的」（见 §2.1）。

### 1.4 聊完回想只读 QQ

`emotion/feeling-review.ts`：`ReviewDeps.history` 是「和他的聊天记录」（`:306-307`），由 `modules/reflections.ts:84`、`:116-120` 传进 `options.history(owner.qq)`，是 QQ 的。材料编号 `m1…` / `d<日期>`（`:131-144`）。能不能触发要求 36 小时内至少 8 条、其中至少 4 条是新的（`:32-34`、`:323`、`:328-336`）。所以**只在桌面上聊的日子永远不会回想**，桌面上的事也就不会生出感受。防止引用他原话的那道检查 `hisLines(history, now)`（`:362`）同样只看 QQ。

### 1.5 日记、承诺、念头

- 自动日记：`life/diary.ts:109-167` 的 `diaryMaterial`，聊天来源是 `options.history.load(contact.qq)`（`:381-382`），只有 QQ。**写进公共库**（`diary:<日期>`，同学档也召回得到，`:1-5`、ADR 0026），所以桌面原文绝不能进这份材料。ADR 0177 也写明了桌面对话「不进公共库、不给同学档」（`0177-same-her-recent-turns.md:25`）。另外 `app.ts:1512` 只在 `!config.selfDirectedMemory` 时才建 `diaryWriter`。
- 承诺：`life/promises.ts:354` 的 `promiseKeeper` 按联系人 `history.load(qq)` 切片段（`:375`），每个片段带来源摘要、撤回核对（`:250-253`、`:382-384`），从片段里抽承诺和挂着的事，顺带抽世界动作（`:327-328`）。桌面上说的「明天帮你看完」不会进这本账。`scripts/her-promises.mjs` 是用正则扫 Hindsight 落盘副本的只读脚本，它的 `NOISE` 里专门列了「发票」「整理一下」「速查卡」这类桌面干活的词（`:80`），说明桌面那边存下来的东西里干活的噪音很多。它只能当参考，不能当实现。
- 念头：`proactive/proactive-planner.ts:686-706` 借 `responder.initiate` 来想，所以能带上 crossRecent 的 3 轮（§1.1 第 1 行），但只有 6 小时内的原文，没有「下午在电脑上陪了他两小时」这样的事实。连续性块（`app.ts:1399-1446`）对主动的那一轮同样会放 `timeline.promptLine`，所以**往时间线里记一条会话事实，念头和 QQ 回复就都能看到**。

### 1.6 JOURNAL.md：确实是第二本日记

- ADR 0171 第 71 行：开了 `selfDirectedMemory`，自动日记、周记、阶段总结就一起关掉，「之后日记只有她自己写的 `<<日记>>` 和 DSH 睡眠整合的 `journal_write`」。也就是说，在这个模式下，**她每晚那篇「今天」完全是常驻进程在 DSH 那边写的**：材料是它自己从 Hindsight 召回来的（`her-resident.mjs:155-156`），看不到 QQ 的作息、世界、心境、计划，这正是 ADR 0347 要收回来的那种「DSH 自己推生活」。
- 不开 `selfDirectedMemory` 时更乱：QQ 的 `diary.json`（加上公共库 `diary:`）和 JOURNAL.md 同一天各有一篇，材料不同。`readDiaries` 把两篇都交给自我认识和心境回想（`diary-insights.ts:136-143`）。
- 各处读的东西也不一样：`selfThread`、`wake`、`dream-jobs` 只读 JOURNAL.md；`journalOn` 读 JOURNAL.md 加 `<<日记>>`（`language/self-thread.ts:45-54`），不读 `diary.json`；`readDiaries` 三份都读；插件的 `journal_read` 和召回读的是 JOURNAL.md 加公共库。**同一天她翻到哪篇，要看是从哪个入口翻的。**

### 1.7 作息冲突现在怎么处理

- QQ 在她睡着时被叫醒：`life/nights.ts:53-77` 的 `lastNight` 从**所有联系人的 QQ 聊天记录**推昨晚：睡下 20 分钟以后她又发过消息就算被吵醒（`:24-27`、`:63-69`），扣 45 分钟睡眠，影响第二天困到几点（`:81-85`）；被吵醒的那一轮状态行带起床气（`modules/her-now.ts:121`，`realNights`）。桌面上的回合不在 `histories` 里，所以半夜在桌面上被叫起来，第二天她照样精神。
- 精力：`life/needs.ts:34-45` 按世界账里的事件类别算速率（上课 −2.5/小时，`work_on_project` −2.2，`leisure` −1.3，睡觉 +8）。时间重叠的事件按稳定顺序只取一件（`:148-169`），**先开始的那件赢**。所以就算往世界账里补一件「桌面会话」，只要落在课或睡觉中间，精力也不会变；要改就得换 `NEEDS_RULES_VERSION`，还得迁移锚点（`:19-22`、`:63-65`）。
- 行动队列能打断已经开始的事（`world/action-queue.ts:51-60` 的 `cancel` / `shorten` / `drop`），聊天里说过的事改写某一段，用的就是这套（`world/life-selector.ts:547-553`）。

## 二、方案

总原则：**插件只多写一个字段，其他全在 QQ 侧做**；桌面原文只进男朋友档的提示词和她自己的回想，任何会进公共库或别人能看到的地方，只放不含原文的概述。

### 2.1 采集：桌面对话收进 QQ 自己的账（地基，其余各块都靠它）

- **插件（小改，兼容旧格式）**：`recordDesktopTurn` 的每一行加 `userAt`（毫秒）。取值是本轮第一次在 `pre-step` 里记下 `cache.user` 的那一刻（`index.js:806-809`），`at` 仍然是一轮结束的时刻。QQ 的 `readDesktopTurns` 只校验 `at/user/assistant`（`cross-recent.ts:53`），多一个字段不影响 crossRecent。顺手把 `keep` 的尾部读法放大到 `DESKTOP_KEEP × 4 KB`，或者改成按行读，让 40 行名副其实。
- **QQ 侧新文件 `<数据目录>/memory/desktop-log.jsonl`**，由 QQ 收、QQ 存：
  ```json
  { "v": 1, "id": "dk-<at毫秒>-<sha256(user+assistant) 前 8 位>", "at": "ISO，一轮结束", "userAt": "ISO，可缺", "user": "≤600 字", "assistant": "≤600 字" }
  ```
  每 30 秒从 `desktop-recent.jsonl` 收一次。那个文件是插件整份重写的（临时文件再改名，`index.js:493-496`），不是只追加，所以**不能用 `dsh-inbox.ts` 那种按行号的游标，要按 `id` 去重**。时间比现在晚 1 分钟以上、早于 14 天的行跳过。本地保留 14 天：日记补写最多回看 3 天，承诺 7 天，自我认识 14 天。新模块 `memory/desktop-log.ts`（纯读写）挂在 dsh-inbox 模块的 schedule 上（ADR 0336 第 6 步的做法），不另开计时器。
- **会话**：新纯函数 `life/desktop-sessions.ts`，`desktopSessions(turns, now)`：相邻两轮间隔小于 `EPISODE_GAP_MS`（45 分钟）的算同一段；开始时刻取第一轮的 `userAt`，没有就取 `at` 往前推 2 分钟；结束时刻取最后一轮的 `at`。再派生两个判断：`desktopWith(now)`，即最后一轮在 `CHATTING_WINDOW_MS`（10 分钟）以内；`desktopRecentEnd(now)`，即最后一轮的时刻。不落盘，每次现算，和 `togetherNow` 一样。
- 谁写谁读：插件写 `desktop-recent.jsonl`，QQ 只读不改；QQ 写 `desktop-log.jsonl`，插件不读。
- 开关 **`desktopDay`**（默认关）。要 `crossRecent` 开着（路径靠 `owner-bank.json` 里的 `desktopFile` 传，`app.ts:1475-1481`），名单里有男朋友档。关着的时候连采集都不做。

### 2.2 此刻：NOW.md、主动消息、留话知道她在陪他、刚陪完（跟着 `desktopDay`）

1. **NOW.md**（`app.ts:1606`）：`lastAt` 改成 QQ 最后一句和桌面最后一轮里较晚的那个。如果她作息上本来在上课或睡觉，就写 `和你聊天中（本来在上课）` 或 `和你聊天中（本来该睡了）`，这句由 `activityWithChat` 多带一个可选参数渲染。NOW.md 不进 QQ 提示词（`app.ts:1113-1117` 碰到带 generated-at 的就跳过），只有 DSH 和常驻进程读，**QQ 的基线不受影响**。第 1 层要加的 `<!-- asleep: -->` 那一行照旧按作息写，不因为桌面会话改成 no：她是被叫起来的，不是醒了。
2. **主动消息**：`ProactiveInput` 加 `desktopWith?: (at) => boolean` 和 `lastDesktopAt?: (at) => number | undefined`，由 `planner-host.ts` 在男朋友档、`desktopDay` 开着时接入。`blockReason`：
   - 紧挨着 together 那行（`proactive.ts:963`）加一行：除了睡前那句，其他时机在 `desktopWith` 成立时返回 `'正在电脑上陪他'`；
   - `lastTime`（`:952`）取 QQ 最后一句和 `lastDesktopAt` 里较晚的，这样「一小时内聊过」「正聊着」「刚聊过」就把桌面也算进去了；
   - `morning` 的「他今天已经来过消息」、`bedtime` 的「今天没聊过」也算上桌面回合。`已经道过晚安` 那条正则同样去扫桌面回合。`unansweredGate` 第一版先不动（见 §四）。
3. **OUTBOX**（`app.ts:1635-1638`）：`blocked` 再加一条，`desktopWith(now)` 时返回 `'他就在电脑前'`，先留着不发。等他离开 10 分钟以上、留话还没超过 `OUTBOX_MAX_AGE_MS` 再发；文件原样保留（`social/outbox.ts:5`）。
4. **时间线**：一段会话结束（最后一轮以后 45 分钟没有新回合）时记一条 `timeline.record({ id: 'desktop-session:<开始毫秒>', channel: 'desktop', kind: 'session', summary })`。summary 只放时长和这一段里 `desktop` 渠道已有的动作类别，比如「在电脑上陪他待了约 2 小时（中间帮他查了资料、写了东西）」，**不放原文**。`Timeline.record` 遇到同一个 id 只记一次（`timeline.ts:79`），重启重算也安全。这一条会通过 `promptLine` 被 QQ 回复和念头看到。要 `timeline` 开着；没开就不记，其他照常。

### 2.3 桌面对话进聊完回想（开关 `desktopReview`，要 `feelingReview` 和 `desktopDay`）

- 材料：`reviewMaterial` 多吃一个 `desktop` 参数，把桌面回合拆成他、她两条，编号前缀用 **`k`**（`k1…`，k 代表「看着电脑」），和 `m` 分开编，这样 `/心境` 一眼看得出依据来自哪边；每条前面带 `[电脑上]`。截断规则沿用 `MESSAGE_CHARS = 60`。**路径、网址、令牌那类行整行丢掉**，正则复用 `dsh-inbox.ts:43` 的 `UNSAFE_TEXT`，避免他的文件名、代码进回想、进 `/心境`。总量仍然不超过 `MAX_MESSAGES = 60`，按时间合并后取最后 60 条。
- 什么时候想：`reviewDue` 的 8 条 / 4 条新 / 聊完 30 分钟 / 12 小时内都按两边合起来算。「聊完」指两边最后一条都已经过了 30 分钟。
- 护栏沿用 ADR 0197，不放宽：依据必须对得上编号；2 级要至少 2 条依据；`aboutHim` 的依据里必须有他的话，`k` 里他说的那条也算；因为他难过或烦的一晚最多 1 条；不引他原话；`guard.his` **必须同时包含桌面上他说的话**，否则她能把他在电脑上的原话抄进来由；不写名单里的别人；不碰底线（`feeling-review.ts:148-152`）；一晚最多记 3 条、放下 3 条，同时最多 8 条。
- 接线：`reflections.ts` 的 `feelingReview` 选项加一个 `desktop: () => DesktopTurn[]`，由 App 给（读 `desktop-log`）。

### 2.4 桌面上说的承诺进承诺账（开关 `desktopPromises`，要 `desktopDay` 和长期记忆）

- 做法：**给男朋友档的 `promiseKeeper` 一份合并后的聊天视图**：QQ 记录加上桌面回合按时间排好。桌面回合转成 `StoredMessage` 时内容前加 `（电脑上）`，没有 `messageId`，`recalled` 永远不设。只有男朋友档用这份视图，其他联系人照旧。两边挨得近的话会被切进同一个片段，这正对应「同一段和他在一起」。
- 为什么不另开一个 keeper：`describe`、`openLoops`、`plansOn`、`appointmentsAt/Between` 在 App 和计划器里有六七处调用（`app.ts:1493-1508`、`planner-host.ts:164-174`），两个 keeper 就得在每处合并结果，容易漏。
- 代价：开关打开的那一刻，已有片段的来源摘要（`promises.ts:250-253`）会因为插进了桌面回合而变，最近 7 天的片段会重新抽一次。这是一次性的，日志里会看到。抽取时顺带出的世界动作（W3）也会从桌面聊天里出来，比如她在电脑上说「我去吃饭了」，照样经过世界账裁决。
- 不采用 `her-promises.mjs` 的正则做法。它只在桌面那台做只读核对：开关打开后，拿它的输出和承诺账对一下，看漏了哪些。

### 2.5 日记写到桌面上那一段 + JOURNAL.md 收成一本（开关 `oneDiary`）

**建议**：一本日记 = **QQ 是唯一写当天日记的一方，也是唯一的汇总方**；桌面只是她可以动手写几段的地方，地位和 `<<日记>>` 一样。

1. **读的一侧统一**：`selfThread`、`wake`、`journalOn`、`dream-jobs` 都改成从 `readDiaries` 取（JOURNAL.md 里桌面上手写的段落、QQ 当天日记、`<<日记>>` 三份合在一起）。同一天的来源排序是：当天日记 > 手写。这一步就能消掉「从哪个入口翻，看到的就不一样」。
2. **写当天日记**：`oneDiary` 开着时，不论 `selfDirectedMemory` 开没开，QQ 的 `diaryWriter` 都写当天日记（`app.ts:1512` 的门换成 `oneDiary || !selfDirectedMemory`）。`diaryMaterial` 多一行：
   `电脑上：14:10–16:05 陪他（中间帮他查了资料、写了东西）；23:40–00:30 他叫你上电脑聊了会儿（本来该睡了）`
   这一行只来自 §2.1 的会话和时间线里 `desktop` 渠道的动作类别，**不放桌面原文**，因为日记会进公共库（§1.5）。同学档的提示词里最多想起「那天晚上在电脑上陪他弄东西」这一层，和 QQ 私聊本来就进日记的程度相当，比它还低。日记写作说明（`diary.ts:170-189`）加一句：「电脑上那几段是你陪他的时间，挑一句写」。
3. **常驻进程的睡眠整合**（`her-resident.mjs:154-158`）：`oneDiary` 开着时，提示词里去掉第 2 步 `journal_write`，只保留 `memory_save` 整理。开没开由 QQ 在 NOW.md 里多写一行 `<!-- diary-by: qq -->` 告诉常驻进程，和第 1 层的 asleep 那行同一个做法。常驻进程不读 koishi.yml。
4. **JOURNAL.md 给桌面看的那一面**：QQ 写完当天日记后，在 JOURNAL.md 末尾追加 `## YYYY-MM-DD（当天）`。插件的 `journal_read` 不用改就能读到（`index.js:130-146` 只跳过带「补记」的段落）。自己追加之前先查一下那天有没有带「（当天）」的段落，有就不再写。**桌面上她用 `journal_write` 写的段落保留**，算她手写的。
5. 周记、阶段总结跟着 `diaryWriter` 一起回来。要不要也回来，是一个待定的点（§四第 3 条）。

### 2.6 作息冲突：功能照常，她知道自己本来在干嘛，耗当天的精力（开关 `desktopConflict`，要 `desktopDay`）

按主会话的建议落地，**全部复用现成机制，不换精力规则版本**：

| 他叫她的时候她在 | 功能 | 她知道 | 耗什么（第一版） |
|---|---|---|---|
| 空闲 | 照常 | NOW.md「和你聊天中」 | 行动队列里正在做的空闲活动在会话开始时 `shorten`，会话本身记一件世界事件：做过事的记 `work_on_project`，纯聊天记 `leisure`，`subject: '陪他（电脑上）'`。按 `needs.ts` 现有速率扣精力，和聊天里说过的事改写某一段走同一条路（`life-selector.ts:547-553`） |
| 上课 | 照常，不拖不拒 | NOW.md 和 DSH 提示词里有「本来在上课」，SELF（第 2 层）也带上 | 课照样记成上过（`attend_class` 是硬事件，不打断）；日记那一行写「上课时在电脑上陪他弄了 40 分钟」。**精力不另扣**，因为重叠的事件只算一件（§1.7）；要另扣就得上 needs-v2，待定 |
| 睡觉 | 照常，第一轮可以有起床气 | 「本来该睡了」 | `lastNight` 的 `histories` 里加进桌面回合（桌面上她的回答当作她发过的消息），被吵醒的判断、扣睡眠、第二天困到几点都沿用 `nights.ts`。另加一条：桌面会话长于 45 分钟时，按会话实际时长扣，不再固定 45 分钟（`WOKEN_COST_MS`，`nights.ts:27`），这条只在开关开着时生效。被吵醒那一轮的起床气沿用 `realNights` 的 `grumpy`，桌面侧要靠第 2 层 SELF 把「被吵醒」带过去 |

她自己说过的条件照搬（`nights.ts:14-15`）：「困就是困，累就是累」「别把『累』弄成我一说话就带出来」「偶尔熬一次别跟犯了事一样追着念」。这些只作为事实放进去，不写「该说什么」。

### 2.7 开关一览（都默认关，都只对男朋友档的那一位生效）

| 开关 | 依赖 | 改了什么 |
|---|---|---|
| `desktopDay` | `crossRecent`、名单里有男朋友档 | 采集、会话；NOW.md；主动消息和留话的闸门；会话那条时间线 |
| `desktopReview` | `desktopDay`、`feelingReview` | 桌面回合进聊完回想 |
| `desktopPromises` | `desktopDay`、长期记忆 | 桌面回合进承诺账 |
| `oneDiary` | 读的一侧统一不依赖；日记里的「电脑上」那行要 `desktopDay` | 一本日记 |
| `desktopConflict` | `desktopDay`、`herDays`（世界）、`realNights`（睡觉那行） | 作息冲突 |

不新增任何指令（遵守 CLAUDE.md「指令收敛」）。他要看就用现有的 `/心境`，或者直接在聊天里问。

### 2.8 隐私护栏汇总

- 桌面原文只去三个地方：男朋友档提示词（crossRecent，已有）、她自己的回想材料（会去掉不安全的行）、承诺抽取（只在男朋友档的 keeper 里）。**日记、时间线、世界事件、NOW.md 一律只放概述**（时长加动作类别）。
- `desktop-log.jsonl` 在 `runtime/` 的数据目录下，已被 git 忽略；ADR 0177 的撤回遮掩是 QQ → DSH 方向的，这里不涉及。
- `HER_CHANNEL` 不是 desktop 的回合不进来（插件已经挡了）。QQ 派的活本来就在 QQ 聊天记录里，不会重复算。
- 导出给 DSH 的东西（NOW.md 的「本来在上课」）只关于她自己的作息，不含任何别人的话（ADR 0020）。

## 三、测试与验收

全部用合成角色（`packages/bot/test/fixtures/synthetic-character/`），灵魂目录、数据目录都用临时目录（参考 `sim/group-runner.ts:101` 的做法），不碰真实资料。

- **纯函数单测**：`desktop-log`（按 id 去重、插件整份重写后不重复收、未来时间 / 超 14 天 / 坏行跳过）；`desktop-sessions`（45 分钟切段、`userAt` 缺失时的回退、10 分钟窗口）；`activityWithChat` 的「本来在上课」；`blockReason` 新加的那行和合并后的 `lastTime`；`reviewMaterial` 的 `k` 编号、不安全行过滤、`guard.his` 包含桌面上他的话；`lastNight` 算上桌面回合，以及长会话按时长扣睡眠；`diaryMaterial` 那一行不含原文（断言桌面 user 原句的任意 8 字片段都不出现在材料里）。
- **App 级**（`test/app.test.ts` 的做法）：开关关着时 NOW.md、闸门、回想材料、承诺来源与现在逐字一样；开着时男朋友档有，同学档没有；`crossRecent` 关着时 `desktopDay` 不起作用并在日志里说明。
- **插件**（`test/soul-plugin.test.ts`）：`userAt` 写对了；旧 QQ 读新行、新 QQ 读旧行都不出错；40 行上限名副其实。
- **基线**：每个提交都跑 `npm run baseline:fast -w @qqbot/bot`，必须逐字不变。要给新行为补基线时，先在旧代码上单独提交新场景（ADR 0336 的惯例），比如 `desktop-day`：下午桌面上 2 小时、晚上 QQ。
- **变异检验**（每条都要有测试变红）：去掉男朋友档限制；去掉 id 去重；`lastTime` 不取较晚的那个；`desktopWith` 恒为假；`guard.his` 不含桌面上他的话；不安全行不过滤；日记那行放进原文；`oneDiary` 关着时仍改读法；长会话扣睡眠的条件反过来；开关的依赖判断去掉。
- **线上验**（要用户点头才开、才重启）：Koishi 日志出现「桌面：收进 N 轮」「桌面：一段 14:10–16:05（约 115 分钟）记进时间线」「主动消息……正在电脑上陪他」「主动留话：先留着不发（他就在电脑前）」；桌面聊天时 NOW.md 是「和你聊天中」；`/心境` 能看到 `k` 开头的依据；第二天 `last-prompt.json` 的连续性块有那条会话；`her-promises.mjs` 的输出和承诺账对一遍。

## 四、风险与待用户定的问题

**风险**

1. 合并视图改变了承诺片段的来源摘要（§2.4），开关打开时会重新抽最近 7 天，多花一点模型调用。
2. 桌面回合大量是干活的内容（§1.5 `NOISE` 那条证据），回想和承诺可能抽出「她因为帮他整理发票而开心」这类小事。护栏挡得住引原话和底线，挡不住这种平淡的事；靠「小事 1 级、散得快」兜底。
3. `unansweredGate`（他没回她的主动消息时的闸）第一版不算桌面回合，可能出现他在桌面上回应了她、QQ 却认为他还没回。等第一版上线看日志再决定。
4. 插件 `userAt` 要 DSH 那边重新加载插件才生效；没生效时按 `at` 往前推 2 分钟，会话开始时刻会晚一点，不影响正确性。
5. `index.js`、`app.ts` 正被第 1 层修改，本层动手要等第 1 层提交之后。

**待用户定**

1. **作息冲突要不要真的扣精力**：第一版里空闲时间按世界事件扣，上课时间不另扣，睡觉沿用吵醒规则、长会话按时长扣。上课时间也要扣的话就得上 needs-v2（换规则版本、迁移锚点），建议先不上。
2. **被叫起来以后**她在桌面上可不可以有起床气（QQ 上 `realNights` 已经有）。建议照搬，第 2 层 SELF 带一个「被吵醒」的事实。
3. **一本日记**：`selfDirectedMemory` 开着时，是否接受由 QQ 写当天日记，取代睡眠整合的 `journal_write`。这和 ADR 0171「日记由她自己决定写不写」有张力：现在实际上是常驻进程每晚替她写，并不是她自己决定。另一个方案是保留常驻进程执笔，但把材料换成 QQ 导出的「今天」（第 2 层 SELF + 本层的会话），这样改动小，但当天日记仍然是 DSH 那边生成的。周记、阶段总结是否一起回来也要定。
4. 留话在他坐在电脑前时是**先留着**（建议），还是直接丢掉。
5. CLAUDE.md 要求改她的言行之前先问她本人。ADR 0347 记着用户 11-22 说这次设计「不用问她」。本层的五个开关打开之前要不要再问她一次，由用户定。

## 五、工作量与拆分

| 块 | 内容 | 文件所有权 | 依赖 | 估计 |
|---|---|---|---|---|
| A 地基 | 采集、会话、`desktopDay` 开关、插件 `userAt` | 新：`memory/desktop-log.ts`、`life/desktop-sessions.ts` 及测试；`platform/config.ts`（只加开关）；`dsh-plugins/.../index.js`（`recordDesktopTurn` 一处） | 第 1 层提交之后 | 1 天 |
| B 此刻 | NOW.md、闸门、留话、会话那条时间线 | `life/now-export.ts`、`proactive/proactive.ts`、`proactive/planner-host.ts`、`proactive/proactive-planner.ts`（透传） | A | 1 天 |
| C 回想 | 桌面回合进心境回想 | `emotion/feeling-review.ts`、`modules/reflections.ts` | A | 0.5 天 |
| D 承诺 | 合并视图 | `life/promises.ts`（如果只在 App 里接线就不改它）、新：`memory/owner-day-view.ts` | A | 0.5–1 天 |
| E 一本日记 | 读的一侧统一 → 写当天日记 → 常驻进程改提示词 | `language/self-thread.ts`、`memory/wake-backfill.ts`、`life/dream-jobs.ts`、`life/diary.ts`、`scripts/her-resident.mjs` | 读的一侧统一不依赖 A；「电脑上」那行依赖 A | 1.5 天 |
| F 作息冲突 | 空闲时记世界事件、睡觉扣时长 | `life/nights.ts`、`world/life-selector.ts`（`shorten` 接线）、`modules/her-now.ts` | A；世界事件那一半还要 B 的会话结束判断 | 1 天 |

- 能并行的：A 做完以后，B、C、D、F 互不碰同一个文件；E 的读法统一现在就能做。
- `platform/app.ts`、`platform/config.ts` 由主会话独占：各块只交纯模块和测试，接线由主会话在 `app.ts` 里统一做、统一跑基线、统一提交（CLAUDE.md 的子代理规则）。
- 提交顺序：A →（B、C、D、F、E 各自单独提交）→ 每块一个提交，提交说明写清开关名和「关着时基线不变」。补基线场景单独提交。
