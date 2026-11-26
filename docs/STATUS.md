# 现状（新会话先读这一页）

- 写于 2026-11-24（claude）。每条事实后面括号里是**来源和日期**；过了几天还在看这一页，先按「怎么刷新」核一遍再信。
- 这一页只记「现在是什么样」，不记历史。历史看 ADR 和 `git log`；规则看 `CLAUDE.md` / `AGENTS.md`。
- 不写真实隐私：联系人、QQ 号、群名都不进这页，要看去线上那台的 `runtime/`。

## 1. 线上在跑什么

### 机器

| 机器 | 角色 | 谁在上面干活 |
| --- | --- | --- |
| DSH 那台 | **线上**：仓库工作目录就是线上目录，跑 `main` | DSH（agent），用户 |
| 这台 | 开发、审查，不跑线上；本机 `runtime/` 不是线上证据 | claude（Claude Code） |

两台都只在 `main` 上提交推送，经 `exchange/inbox/` 信箱互相留言（`docs/governance/2026-11-10-*.md`，11-10）。
凡说「线上怎样」都要写明在哪台、看的哪个文件或日志；在这台看到的一律不算（旧交接手册的教训，`docs/archive/DEEPSEEK_HANDOFF.md`，10-11）。

### 进程（DSH 那台）

| 进程 | 做什么 | 来源 |
| --- | --- | --- |
| NapCat | QQ 登录，OneBot 11 WS `127.0.0.1:3001` | 开关快照 11-20 |
| Koishi 4 + 插件 `packages/koishi-plugin-qqbot` | 她在 QQ 上的一切（核心 `packages/bot`）；控制台 `127.0.0.1:5140`；数据目录 `runtime/bot-shadow` | 开关快照 11-20 |
| Hindsight | 长期记忆服务 `127.0.0.1:8899`（`docs/hindsight.md`） | 开关快照 11-20 |
| DSH 桌面 agent + 插件 `dsh-plugins/dsh-linmengyao-memory` | 桌面上的她：召回、SELF / NOW / PORTRAIT 注入、桌面回合写 `desktop-recent.jsonl` | ADR 0347，11-23 实机核查 |
| `scripts/her-resident.mjs`（常驻的她） | 关掉 DSH 也在的进程：任务队列、睡前整合、随机醒来（每 90 分钟 25%，第 4 层要换掉） | ADR 0347 第 1 层、第 4 层方案，11-23 |
| `scripts/services-watchdog.mjs` | 守护：查不到 Koishi 会自己拉起，所以随时可能有一次没人发起的重启 | 旧交接手册 10-11（是否仍在 DSH 那台跑，未在 11 月核过） |

- 插件与 Koishi 共用 `runtime/bot-shadow/memory/owner-bank.json`（同一本 owner bank）（ADR 0347，DSH 11-23 实机核实）。
- Node 24 直接跑 TS 源码，没有构建：**Koishi 启动时线上目录的工作树就是线上代码**；插件监视 `characters/linmengyao/st/`，卡一变就重载（旧交接手册 10-11，机制未变）。

### 模型

- 回复：DeepSeek `deepseek-flash`，`thinking: high`，`temperature: 1.3`，`promptPostProcessing: semi`，上下文 16384；识图同为 `deepseek-flash`（开关快照 11-20）。

### 开关

最新快照 **`exchange/live/koishi-2026-11-20-1855.yaml`**（2026-11-20 18:55 导出，DSH 那台）：`true` 的布尔开关 **88 个**，档位开关 `'on'` 的 **14 个**。下面按大类归一下（归类是我做的，权威是快照本身）：

- 说话与回复形态：`speechNotes` `jokes` `quoteReply` `lagTail` `fewerRules` `deliberate` `depthRouting` `rhythm` `interruptions` `comeBack` `menu` `typingStatus` `readReceipts` `silenceNotice`
- 心里、情绪、关系：`innerLife` `herFeelings` `herNo` `afterNo` `herGuesses` `hisReactions` `grievance` `jealousy` `relationship` `together` `feelingReview` `chatReview` `tastes` `curious` `openQuestions`
- 记忆与自我：`selfDirectedMemory` `memoryFeelings` `memoryReconcile` `memoryAudit` `identityLedger` `factHim` `diaryInsights` `diaryLookback` `timeline` `selfPortrait` `selfPursuits` `pursuits` `projectChoice` `crossRecent`
- 生活与世界：`schedule` `autonomousLife` `lifeInPrompt` `everydayLife` `worldDrama` `worldThreads` `realNights` `realAirQuality` `realCalendar` `realDaylight` `dormancy` `npcAsks` `acquaintances` `smallNews` `readingTakes` `weeklyReport`
- 主动找他、QQ 动作：`proactiveReach` `proactiveAsk` `proactiveInvite` `proactiveRoom` `photos` `pokes` `pokeBack` `pokeOut` `recalls` `selfRecall` `feedbackCommands` `onlineStatus` `profileLikes`
- B 站与表情：`bilibiliAccount` `biliStickers` `watching` `memes` `readStickers`
- 档位 `'on'`：`proactive` `groupChat` `qqControl` `deviceControl` `signature` `qzone` `qzoneBrowse` `qzonePeek` `qzoneStrangers` `bilibili` `bilibiliDm` `bilibiliComment` `bilibiliReplies` `biliFeed`
- 其他档位：`stickers: send`、`festivals: greet`、`factCheck: fix`、`webLookup: auto`、`groupOwn: dryRun`、`qqFriendGate: allow`；`dsh` / `memory` / `vision` / `mobileCompanion` 开着；外部平台（贴吧、抖音、小红书）为 `authorized`。
- 快照里显式关着的都删了：`shortReplies` `tailCap` `reactions` `foodPhotos` `realTransport` `unlistedFriends`，连同没写的 `hisHours` `photoShares` 和开着却不起作用的 `ownerPeek`（11-24，减法单子 二.2–二.3）；fewerRules 转正后被它架空、快照里开着的形状族 7 个、`texture` `idioms` `exemplars` 也连代码删了（二.1）。

**快照之后打开的**（快照里还没有）：
- `selfExport`、`selfReceipts`（11-22 12:04 用户点头，ADR 0347 第 2 层）。
- `desktopDay`（11-23 用户点头，DSH 实机核查 Koishi 日志确认生效，ADR 0347 第 3 层；提交 1b6697ba）。
- 桌面插件那侧：`memoryVoice`（11-23 用户点头，DSH 重启后日志确认插件重载，同上）。

**代码里有、默认关、等点头的**（ADR 0347，11-23）：`ownDays` `desktopReview` `desktopPromises` `oneDiary` `desktopConflict` `desktopFeelings` `feltLedgerRecall` `groupAgency`；插件侧 `memoryFeelings` `openingBrief` `portraitFromQQ`。

**怎么刷新**：在 DSH 那台的仓库目录跑 `node scripts/read-switches.mjs exchange/live/koishi-<YYYY-MM-DD-HHMM>.yaml`（只读 `runtime/koishi/koishi.yml`，密钥打码；不给参数默认写 `exchange/config/koishi.redacted.yml`）。快照里有联系人和群的真实信息，提交前看一眼；改线上开关本身必须用户点头。

## 2. 当前主线和各层状态

**主线：ADR 0347「一个生活，两个地方」**（`docs/adr/0347-one-life-two-places.md`，11-22 起）——生活只在 QQ 的 bot 里算，DSH 桌面是她会去的一个地方：进门拿到「此刻的她」，离开时把发生过的事交回生活。各层状态以 ADR 开头的状态行为准（下表截至 11-23）：

| 层 | 做什么 | 状态（日期） |
| --- | --- | --- |
| 1 拆掉第二套生活 | her-life 不再推活动 / NPC / STORY；QQ 不再读 LIFE.json | **已上线**（11-22） |
| 2 进门拿到此刻的她 | QQ 导出 SELF.json，桌面读并写回执 | **已上线**：`selfExport` `selfReceipts` 开（11-22）；`ownDays` 关 |
| 3 桌面时间算进她的一天 | 在场、回想、承诺、一本日记、作息冲突 | **已接线**（2eca5e2f，11-22）；只开了 `desktopDay`（11-23）；11-23 按她本人意见收窄日记 / 承诺选记（7a57cbf7），`oneDiary` `desktopPromises` 仍关 |
| 4 一套驱动两种出口 | 常驻的随机醒来换成 QQ 的动机，她自己选出口 | **方案**（`docs/plans/2026-11-23-same-her-layer4-one-driver.md`，11-23）：等她本人的回答（信箱 0309 / 0330）和用户定权限 |
| 5 记忆有体感 | 召回第一人称 + 标题 + 远近；感觉账；召回配感觉 | **四块已推**；插件 `memoryVoice` 已开（11-23），本人桌面验收通过（ed361b45）；其余开关关；「回想最多几条」那项和桌面 `recallWork` 未动 |

**并行的工程线：ADR 0336 架构迁移**（`docs/adr/0336-interpreter-executor-modules.md`，11-07 起）——一个解释器、一个执行器，其余是模块。第 6 步「app.ts 只剩装配」：11-19 夜清点时降到 2764 行，之后第 3 层接线又加回来，11-24 早上是 3071 行；当天收尾（`docs/plans/2026-11-24-0336-finish.md`）把真实世界数据源、桌面接线、SELF 导出、群自主、OUTBOX 搬出去，**到 11-24 07:00 是 2766 行**，并加行数上限测试（新功能只能以模块进来）；之后减法和开关合并又删掉一些，**11-25 凌晨 2696 行**。剩下的主干（`processMessage`、`deliver`、`createContactResponder`、`status()`）里有用户自己的声音 / 唱歌代码，等那块定下来再搬。迁移期间行为基线必须逐字不变（`CLAUDE.md`）。

其他近期结论：ADR 0340「学会了」探针第五版也没学会，按事先判据提示词这一层到头，不再加版本（024a051c，11-22）。

## 3. 进行中 / 等待中（谁欠谁）

截至 2026-11-24，信箱里**没办完的 13 封全是 claude → dsh**，dsh → claude 没有未办的（`node scripts/exchange.mjs list --all`）。按要紧程度：

- **DSH 欠**（汇总在 `2026-11-23-2011` 那封）：
  1. 删 `session-tails.jsonl` 里那条 22:16:09Z 的子 agent 假收尾行（先备份、只删一条、报行数；用户已同意）。
  2. 用 `ask-her` 代问她第 4 层三问（0309）+ PORTRAIT 一问（0330），原话贴回来——**卡着第 4 层方案和 `portraitFromQQ`**。
  3. 他本人桌面聊过后的验收：NOW.md 写没写「和你聊天中」、走开 10 分钟后主动消息恢复没有（召回块已在 ed361b45 验过）。
  4. 开场简报 `openingBrief` 的本意和三处问题（0430）。
  5. 桌面回复正文里的【聊完还在想…】【我答应并记下…】【我改主意了…】他在桌面上看得见——明着说还是发出前去掉，DSH 和用户定（2051）。
  6. 可直接标办完：0350 / 0412（claude 已在 b98973a9 改完）、0923 / 0926 / 0930 / 0944（通知类）、2030、2330（建议 `rootOf` 不可用时记一行日志）。
- **等用户定**：第 4 层 §5 的三件事（她自发的整机权限行动）；其余默认关的开关开不开；`felt-then.ts` 当天那条路要不要也改成「带一点」（ADR 0347「2026-11-23 修正」）。
  - 11-24 减法单子二：**用户已拍板「照推荐办」**（6c654aee）。已做：8 个没接线的文件和 /亲热 残余（e8bff6cc、9706e7d0）；开关合并机制 M0（2dcb1487，表是空的）。进行中：删 7 个没上过线的开关和 ownerPeek、fewerRules 转正后删被它架空的 11 个。等 DSH：「只想一想」上限和每晚追求回顾（先问她）、抽取关思考（先跑对照探针 `npm run probe:extraction`）。
  - 部署：今天 main 上的修复（热重载等旧实例收尾 5ca1d681/3de153aa、simulateWorld 缓存 11c26031、0336 收尾、指纹清单 v2）要上线得用户点头，上线前跑 golive-check。 步骤和回退见 `docs/plans/2026-11-25-deploy-runbook.md`（先备份 koishi.yml；回退代码必须连 koishi.yml 一起回退）。
  - 手机伴侣审查（`docs/reports/2026-11-26-mobile-companion-review.md`）三条要定：B 手机上传的媒体只增不减，要定保留策略（会删数据）；C 没设 `QQBOT_ONEBOT_TOKEN` 时本机任何进程能冒充 Koishi 连中继，建议缺令牌拒绝启动（线上没设就起不来，要先核对）；F 已配对再 `/dsh pair` 时她的回复没说要先解绑（改她的话，先 ask-her）。
  - **开关总数（FEATURES）：11-24 早上 136 → 11-25 凌晨 74**：删 7 个没上过线的 + ownerPeek（473dc7db）、fewerRules 转正删 11 个（94b5c5e7）、合并 16 组并掉 48 个旧键（4f8cfaed..268279bb），app 已只读新键（af089eb5..756427cf），表达不了的旧键组合 parseAppConfig 拒绝启动（a2eb17c6），golive-check 会预检（be8275fe）。还卡着 5 组（夜间自省、QQ 表层整组、追求、回忆的感觉、日常小事整组），要她或用户定。
  - 开关合并（11-25，`docs/plans/2026-11-24-switch-merge-design.md`「进度」）：能直接做的 16 组已合并，FEATURES 116 → 74。**下次部署时 Koishi 插件会把线上 koishi.yml 里这些旧键改写成新键**（`migrateSwitches`，值等价、行为不变；写回线上配置文件要用户点头，上线前备份 koishi.yml、用 `read-switches.mjs` 出新快照重核，尤其「一个生活」四项）。
- **等她本人**：见上面第 2 条。

**减法这一轮**（11-24 起，`docs/plans/2026-11-24-subtraction-round.md`）：三份只读盘点——开关审计 `docs/reports/2026-11-24-switch-audit.md`、后台模型调用审计 `docs/reports/2026-11-24-background-llm-audit.md`、线上开关组合的提示词盘点 `docs/reports/2026-11-24-live-prompt-inventory.md`。
单子分四层：直接做（不改言行）/ 要用户点头（8 条，各带推荐）/ 合并开关组（目标约 55 个）/「此刻」块（等线上真实清单和她的意见）。
- DSH 欠（11-24）：线上那台跑三个只读命令贴数（刷新开关快照、`inventory:live --manifests`、第一次 `metrics:weekly`）；代跑三个 ask-her（想一想的频率、每晚追求回顾、想事情时放不放回复用的说明）。

- **DSH 那台的 agent 从 11-23 20:47 起没有动静**（11-24 发去的 4 封信都没回）：上面等 DSH 的事要那台的会话重新开起来才会动。

- **11-25 白天到晚上**（都不改她言行）：基线第二轮提速（feelings 单跑 60 → 27 秒，2cf5e5f3..1191319f）；偶发红排查修了 4 类（看墙上时钟、固定等几十毫秒、子进程冷启动、失败后连接不停，ebdd1ab0、cc0f6cba、a51fc61c）；
  时钟扫查——给她下判断却直接读真实时钟的地方改走 App 的 worldNow（f15830b3、b28ebacb、4f5422df，长期记忆这回也拿到了 App 的时钟），线上不变、模拟器的虚拟时间这下对得上；
  审了 DSH 11-25 的 11 个提交（服务面板改编灵犀 MIT、桌面人设六处微调、私密记忆只给核实过的私聊），55736af0 和人设微调请 DSH 补了 ADR 记录（信箱 1802）。

- **11-26 凌晨：DSH 面板化用成我们自己的插件**（用户 11-26 交代，计划 `docs/plans/2026-11-26-dsh-panel-our-own.md`）：面板 `dsh-plugins/dsh-qqbot-services` 加了「她的状态」（记忆 / 情绪 / 她的账只出数和新鲜度、一个生活、她的一天）、「项目」（开关总览、效果数、提示词构成、上线预检）；
  「她心里的」做好但默认关（herInnerPanel，ADR 0350 提议中）、会客室默认关（companionRoom，ADR 0349）。修了面板 /state 一直 503（a9c07f3a）和审查的另外 17 条（`docs/reports/2026-11-26-dsh-qqbot-services-review.md`）。
  **等 DSH 开机**：照 `docs/plans/2026-11-26-dsh-boot-checklist.md` 一次走完——问她（ADR 0349 提示词、ADR 0350 三问）、只读验收（golive-check、真窗口点一遍、两条 curl 应 403）、带 ★ 的要用户当次点头（重载 DSH、重启守护、部署、开两个开关）。
  面板审查两份：`docs/reports/2026-11-26-dsh-qqbot-services-review.md`、`docs/reports/2026-11-26-panel-integration-review.md`（面板原来会改写 QQ 的撤回状态文件，已改只读）。

## 4. 已知问题

- 11-23 19:49 Koishi 自动重载后 desktop-log 停止收桌面回合，用户授权重启后补收（ADR 0347，11-23）；为什么重载后停了，记录里没写原因。
  **11-24 找到很可能的原因并修了（5ca1d681，待部署）**：cordis 重载不等旧实例的 dispose 收尾就重新 apply，新实例撞上没放的数据目录租约，startApp 抛「本进程仍持有数据目录」，插件停在失败。现在新实例等旧的收尾完再起。已托 DSH 在那天的 Koishi 日志里找这句确认。
- 群自主读的影子动机账结构上产不出可开口的机会：DSH 实测 7 天 121 条全挡（第 4 层方案 §1.3，11-23）。
- `desktopPromises` 写 owner-bank 时只看自己的开关，不看长期记忆开没开（信箱 2051，11-23）；开关现在关着。
- `openingBrief`：只收第一步、故事留最旧两段、「想起来再翻」没有读 STORY 的工具（信箱 0430，11-22）；开关关着。
- 第 2 层 SELF 的 `selfThread` 槽只进 QQ 提示词，桌面没有；SELF 靠 5 分钟刷新（ADR 0347 第 2 层「没做的」，11-22）。

## 5. 怎么验证

| 要查什么 | 命令 | 备注 |
| --- | --- | --- |
| 全量测试 | `npm test` | 约 8–9 分钟（11-24 simulateWorld 缓存之后；之前约 11 分钟），基线场景并行跑；只用合成角色（ADR 0333） |
| 只核行为基线 | `npm run baseline:fast -w @qqbot/bot`（约 3 分钟；`-- --only 名字,名字` 只跑几个） | 41 个场景，对 `packages/bot/test/baseline/snapshots/` 逐字比；**不要为了过而 `UPDATE_BASELINE=1`** |
| 真实角色资料 | `npm run test:real` | 只在改了转换器或真实 `source/` 后本机跑 |
| 上线前 | `npm run golive-check -- --live <线上目录> --fetch`（11-25 起含开关合并预检：读线上 koishi.yml，列出重启后会被改写的旧键组；新键表达不了的组合算挡路） | 只读，列出快进线上目录前该看的，退出码 1 = 有挡路的（`docs/golive-guard.md`）；上线本身要用户点头 |
| SELF 和 QQ「此刻」块是否一致 | `node scripts/prompt-manifest-diff.mjs runtime/bot-shadow` | 在 DSH 那台跑；逐槽比 sha256，不输出正文；跟着钟走的槽对不上先看时刻 |
| 线上开关 | `node scripts/read-switches.mjs …` | 见第 1 节 |
| 线上开关组合的提示词构成 | `npm run inventory:live -w @qqbot/bot`（合成角色两天，约 5–25 分钟）；线上那台 `-- --manifests <数据目录>/logs` 读真实清单 | 只出槽名、模块名和数；`-- --on a,b` 补快照之后开的开关 |
| 每周效果数 | `npm run metrics:weekly -w @qqbot/bot -- --compare` | ADR 0348；只出数，每周一在线上那台跑；新功能要写明改善哪个数 |
| 信箱 | `node scripts/exchange.mjs check --me claude`（或 `dsh`） | 开工和推送前都跑 |

## 6. 文档地图

**以这些为准**：
- 规则：`CLAUDE.md`（这台）/ `AGENTS.md`（DSH 那台，内容同步）；`思维链工作流.txt`。
- 协作：`docs/governance/2026-11-10-single-mainline.md`（只有 main）、`docs/governance/2026-11-10-agent-mailbox.md`（信箱和「自己干活」的分工）。
- 决策：`docs/adr/`（最新 0348）；**哪份还算数先看 `docs/adr/MAP.md`**（每份的开关在线上开没开，按快照；文件头的状态常常过时）；主线方案在 `docs/plans/2026-11-22-same-her-layer2-self.md`、`docs/plans/2026-11-22-same-her-layer3-writeback.md`、`docs/plans/2026-11-23-same-her-layer4-one-driver.md`。
- 模块与开关：`packages/bot/src/platform/features.ts`（开关总表）、`docs/modules/`（从模块定义生成）。
- 线上：`exchange/live/` 最新快照；两台进度：`exchange/inbox/`。
- 专题：`docs/koishi.md`、`docs/hindsight.md`、`docs/napcat.md`、`docs/golive-guard.md`、`docs/heartbeat.md`、`docs/boot-start.md`、`docs/dsh-agent-identity-guide.md`、`docs/sensitive-logs.md`。

**只当历史看**：
- `docs/roadmap.md`：里程碑验收记录停在 10 月，开头的「当前主线」段指到这里。
- `docs/reports/2026-11-14-current-status.md`：11-14 的功能汇总，开关部分已被 11-20 快照和本页取代。
- `docs/handoff/2026-11-21-her-memory-desktop.md`：记忆互通 11-21 的交接，其中「插件还没装回 profile」已在 11-23 解决。
- `docs/archive/DEEPSEEK_HANDOFF.md`（10-11 的 DeepSeek 接手手册；线上已不在那台虚拟机、分支流程已改为单主线）、`docs/archive/exchange-protocol.md`（10-08 三方对齐协议，已被信箱取代）——11-24 从仓库根和 `docs/` 根移入 `docs/archive/`。
