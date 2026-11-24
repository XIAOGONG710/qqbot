# 11-24 agent 提交独立审查（0fedf7f8..48699406，附 5ca1d681）

范围：`git log 0fedf7f8..HEAD` 里的代码提交（纯文档 / exchange 提交跳过）。只读审查，没改代码。
审法：逐个提交读 diff，搬出去的宿主文件逐行和 app.ts 原文对照（构造时机、闭包捕获的变量、`let`/`const` 声明位置与 TDZ、停法登记先后、错误路径）；
删掉的代码在删之前那一版全仓（含 `scripts/*.mjs`、koishi 插件、测试；`vendor/`、`characters/`、`docs/` 除外）搜调用方；
新输出（指纹清单 v2、每周效果数、ADR 地图）看有没有正文 / 号码外泄。
验证：`npm run typecheck`（全部 workspace，含 noUnusedLocals）通过；相关测试 229/229 通过
（prompt-manifest、weekly-metrics、lock、lifetime、live-switches-fewer-rules、app-size、desktop-*、group-agency、live-mix、
memory-diary-outbox-integration-review、now-export、one-diary、outbox、owner-day-view、proactive-desktop、self-export、self-receipts、weather-evidence）。
工作区里 `packages/bot/src/world/world.ts` 有一份**没提交**的改动（simulateWorld 结果缓存），是别的会话在做的，不在本次范围内，没审。

## 结论

**没有发现会影响线上行为的 bug。** ADR 0336 收尾的六次搬家都是原样搬：副作用先后、立刻刷新的那一次、停法登记、日志行、闭包读到的变量都和原来一致；
删掉的死代码在删之前确实没有任何运行时入口（没有动态 import、字符串键查找、插件或脚本引用）；指纹清单 v2 和每周效果数都不带正文。
找到的是一个工具输出错误（ADR 地图的「线上开没开」列有十来个开关标错）和一个测试耦合风险，其余是小问题。

| # | 严重度 | 提交 | 位置 | 一句话 |
|---|---|---|---|---|
| 1 | risk | 48699406 | `scripts/adr-map.mjs:29` | ADR 地图把 `dsh: {enabled: true}` 标成「关」，又没算 fewerRules 在运行时关掉的 shape/texture/speechCheck 等，自称「以这一列为准」 |
| 2 | risk | e02fee9d / 1a1440b0 | `packages/bot/test/live-mix.test.ts:46` | `npm test` 读真实线上快照（含真实联系人），删开关的提交会让全量测试变红，直到另一台导出新快照 |
| 3 | nit | f0fd7819 | `packages/bot/src/platform/app.ts:1071` / `:1598` | `ownDaysNow` 原来是会提升的函数声明，现在是后面才声明的 `const nowExporter`；现在调不到，但以后构造期调用会被 catch 吞掉并连带丢日记那一行 |
| 4 | nit | 30901fd1 | `packages/bot/src/platform/app.ts:812-813` | 结论正确（核对过）；附带效果：fewerRules 开着时 `idioms/<QQ>.json` 不再更新 |
| 5 | nit | 2f64cd81 | `packages/bot/src/social/group-room.ts:503-509` | group 行的 `qq` 填的是群号，和联系人 QQ 共用一个字段 |
| 6 | nit | dcdd9dd6 | `packages/bot/src/ops/weekly-metrics.ts:304-315` | 「all」范围把陌生人 / 非名单联系人的聊天也算进去，`contacts` 数的是文件个数 |
| 7 | nit | 65ad9c42 | 三个子进程测试 | 等待上限从 5–15 秒放宽到 60–180 秒，真卡死要等 3 分钟才报 |
| 8 | nit | 5ca1d681（审查期间新到） | `packages/koishi-plugin-qqbot/src/index.ts`（`pendingStops`） | 模块级 Set，模块被重新 import 后就不起作用（锁表是挂在 globalThis 上的） |

## 1. ADR 地图的「线上」列有错（risk）

- 提交：48699406，`scripts/adr-map.mjs:29`（`onOff`），用在 `:44`；生成的 `docs/adr/MAP.md`。
- 问题一：`onOff` 只认 `true` 和非 off 的字符串，其他值一律算「关」。线上快照（`exchange/live/koishi-2026-11-20-1855.yaml:179`）里是 `dsh: { enabled: true }`，
  MAP.md:220 却写「`dsh` 关」。
- 问题二：线上 `fewerRules: true`，App 启动时 `relaxStyle` 会把 speechCheck、tailCap、texture、shape、shapeAgenda/Filler/Feel/Split/Ask/Long 都关掉
  （`packages/bot/src/platform/app.ts:455`、`language/fewer-rules.ts:43`）。MAP.md 里这些标的是快照值：`shape` / `shapeAgenda` / `texture` / `shapeAsk` 标「开」（MAP.md:100、103、140、156 等），
  `speechCheck` 标「默认」（MAP.md:24，默认是 true）。实际运行时它们都是关的。
- 会出什么事：MAP.md 头上写着「以这一列为准」。下一个会话照着它判断「shape 在线上开着、动它会改变她说话」或者「DSH 没开」，就会做错判断，
  比如减法那一轮拿它挑可以删的开关，或者在 ask-her 里描述错现状。
- 怎么修：`onOff` 认 `{ enabled }` 对象（`value?.enabled === true`），其他对象标「（对象）」不要标「关」；
  快照里 `fewerRules` 为真时，对 `relaxStyle` 覆盖的那几个键标「关（fewerRules）」，最好直接 import `relaxStyle`，不要另抄一份键名单。
  `scripts/adr-map.test.mjs` 补上这两种情况；修完重新生成 MAP.md。

## 2. 全量测试读真实线上快照（risk）

- 提交：e02fee9d（1a1440b0 改过），`packages/bot/test/live-mix.test.ts:46-51`。
- 测试「仓库里最新的线上快照能解析，开着的开关配置都认识」在 `npm test` 里读 `exchange/live/koishi-*.yaml` 的最新一份。这份快照带真实联系人（QQ 号、称呼）。
  测试只看键，没把号码打出来，但 CLAUDE.md 定的是「测试只用合成角色，不读真实资料」，这里擦边了。
- 会出什么事：这一轮正在做减法（删开关）。一旦从 `DEFAULTS` 删掉一个快照里还有的键，`live.unknown` 就不再为空，
  `npm test` 会一直红，要等线上那台导出新快照（得找另一台 / 用户）才能好，这个红和删开关那次提交本身对不对无关。删开关的人很容易为了让它变绿去改快照或断言。
- 怎么修：把这条挪出 `npm test`（比如放进 `inventory:live` 运行时的自检，或放到 `test-real/` 那种本机才跑的位置）；
  或者断言改成只看「快照里开着、但 DEFAULTS 不认识」的键，并允许一个「已删开关」名单。

## 3. ownDays 现在依赖 const 的声明顺序（nit）

- 提交：f0fd7819，`packages/bot/src/platform/app.ts:1071` 引用 `nowExporter.ownDays()`，`nowExporter` 是 `:1598` 才声明的 `const`。
- 原来 `ownDaysNow` 是函数声明，会提升，构造期间什么时候调都行。现在要是 `soul.selfThread` 在 1598 行之前被调用，会抛 TDZ ReferenceError，
  被外层 `catch { return undefined; }` 吞掉，同时把 `journal` 那一行也丢了，而且不会留日志。
- 现在调不到：selfThread 只在拼每一轮提示词、以及 SELF 导出（`start: 'built'`）时调，都在 App 搭好之后。所以只是个隐患。
- 怎么修（可选）：把 `nowHost(...)` 的构造挪到 selfThread 所在的那个对象之前（它的依赖 `worldCard` / `sharedWorld` / `history` / `desktopSource` 在 1071 行之前都有了，只有 `diaries` 在 1513 行），
  或者在那里写成 `config.ownDays ? nowExporterRef?.ownDays() : undefined`。

## 4. idioms × fewerRules（nit，结论正确）

- 提交：30901fd1，`packages/bot/src/platform/app.ts:812-813`。
- 核对过：唯一的产出是 `idiom` 槽（`modules/idioms.ts:26-30`）；`idiom` 在 `RULE_SLOTS` 里；少规矩开着时只有危机回合会保留规则槽，
  判断用的是同一个 `turn.facts.crisis`（`interpreter/interpreter.ts:334`、`interpreter/slots.ts:99`），而 `playfulAllowed` 在 `crisis` 时返回 false（`modules/playful.ts:11`）。
  所以 fewerRules 开着时这个槽确实永远放不进去，不建这个模块不会改变她说的话。`idioms/` 目录的遗忘 / 导出 / 隐私审计都按目录处理（`memory/forget-job.ts:48-53`），不依赖模块在不在。
- 附带效果（提交说明里都写了）：`idioms/<QQ>.json` 在 fewerRules 开着期间不更新；每轮少消耗一次 `Math.random`，同一轮后面别的抽签序列会挪位（分布不变）。
  以后关掉 fewerRules 时，重启后第一次学习之前会先用旧的口头习惯，旧到什么程度取决于 fewerRules 开了多久。不用修，记一笔就行。

## 5. 指纹清单 v2：group 行的 qq 是群号（nit）

- 提交：2f64cd81，`packages/bot/src/social/group-room.ts:503-509`，`packages/bot/src/platform/prompt-manifest.ts`（`PromptManifest.qq` 的注释）。
- 群号和 QQ 号是两套编号，数字上可能撞。现在的消费方都先按 `kind` 筛（`scripts/prompt-manifest-diff.mjs:28` 只认 reply/initiate；`test/inventory/live-mix.ts` 不按 qq 聚合），所以没问题。
  以后谁按 `qq` 去删 / 导出某个联系人的清单行，没先筛 `kind`，就会把同号群的行也算进去。
- 隐私核对过：v2 新加的三种都只记消息条数、角色、字数和 sha256，`reason` 只是枚举（`SpeakReason`），`stage` 是 REVIEW_STAGES 里的名字，`calls` 是数字，没有正文。
  文件名已经在 `PRIVATE_PATTERNS` 里（`platform/private-space.ts:41`、`scripts/ginka-guard.mjs:26`）。
  candidate 只在 `plan` 存在时才记，这时 `turnNow` 一定有值；review 的 `regenerate` 调的是原始 `generate`，不经过候选那一层，不会重复记 candidate 行。
- 怎么修（可选）：group 行改用单独的 `group` 字段，或者在 `qq` 的类型注释和 `latestManifest` 一类工具里写明「先筛 kind」。

## 6. 每周效果数的统计范围（nit）

- 提交：dcdd9dd6，`packages/bot/src/ops/weekly-metrics.ts:304-315`、`:288`。
- `loadMetricsData` 把 `chats/` 下所有 `<数字>.jsonl` 都读进来，包括名单外的陌生人和 classmate 档；`contacts` 是文件个数，不是这一周真有聊天的人数；
  也没有按 `TierRecord.since` 去掉换档之前的记录（App 里 `currentTierHistory` 是去掉的）。
  这样「all」范围里的助手腔、延迟、主动占比会混进对陌生人的回复，周和周之间比的时候会跟着陌生人多少一起波动。
- 隐私核对过：`Turn.text.content` 只留在内存里；写进 `weekly-metrics.jsonl` 和打印出来的只有数，范围只带 QQ 后四位。导入的 `sim/learning-probe.ts` 等模块都有 main 守卫，import 时不会跑起来。
- 怎么修（可选）：默认只统计配置名单里的联系人（或按档位分组出数），`contacts` 改成窗口里真有消息的人数。

## 7. 子进程测试的等待上限放宽（nit）

- 提交：65ad9c42：`memory-sticker-persistence-review`（外层 180 秒）、`moment-cli-review`（60 秒）、`proactive-helper-review`（spawnSync 60 秒）。
- 测的东西没变，只是真出现死锁时要等 1–3 分钟才失败。在并行全量下这样放宽可以接受，记一笔就行。

## 8. 审查期间新到的 5ca1d681（koishi 热重载等收尾）：一条小问题（nit）

- 这个提交是在审查过程中推上来的，顺带看了：思路对，`trackStop` 把成功和失败都当成「收尾结束」，等的过程中实例被停用了就不再起。
- `packages/koishi-plugin-qqbot/src/index.ts` 里的 `pendingStops` 是模块级的 `Set`。`platform/lock.ts` 的租约表特意挂在 `globalThis[Symbol.for('qqbot.active-data-locks')]` 上，
  理由是「模块重新加载后还在」。所以如果插件文件本身被重新 import（HMR 一类），新模块拿到的是空的 `pendingStops`，当场就起，照样撞上全局租约抛错。
  线上 koishi-app 没装 HMR 插件，只改 koishi.yml 的重载不会重新 import 模块，所以现在不会触发。
- 另外：旧实例的 `app.stop()` 一直不结束的话，新实例就一直等，只在开始等时记一行日志。
- 怎么修（可选）：`pendingStops` 也挂到 `globalThis` 的 `Symbol.for(...)` 上；等的时候加个上限（比如超过 N 分钟再记一行、提示人工处理）。

## 核过、没问题的

- **world/reality-feeds.ts（72193101）**：五个取数器的构造、`useReal*` 接读口、立刻取的那一次、`lifetime.own` 的登记顺序、日志行都和原来一样；
  `stopped` 改成 `() => stopped` 读的还是同一个 `let`（app.ts:466）；`upkeep` / `status()` 里键的先后不变；
  `noteUserWeather` 的判断条件和原来的 `typed && weatherEvidence && weatherPlaces && worldCard && ledgerWorld` 一样，先记日志再 poke 的顺序也一样（app.ts:2391）。
- **life/desktop-host.ts（416c3564）**：缓存、`calledAt`、日志都在原位置构造；`attachWorld` 在原来算 `desktop-conflict-since.json` 的位置调（app.ts:1294），
  早于搭 App 时那一次 `syncDshInboxes()`，`dsh-inbox` 模块的定时器要到 built 才开，所以 `syncInbox` 拿到 `world` 之前不会被调；
  `sharedWorld` / `timeline` / `lifeQueue` / `worldCard` 都是 `const`，交进去的值和原来闭包读到的一样；`worldReady()` 在原来置标志的位置。
- **life/self-export-host.ts（40be3a1d）**：`crisisState.pausedAt` 返回 boolean，和 `crisisPaused` 的类型一致；`dormancy`（1359 行）、`crisisState`（2054 行）、`planners`（2095 行）都是在闭包里用到时才取，
  和原来一样；`syncReceipts` 在 `desktop.syncInbox` 之后，顺序不变；搭 App 时第一次同步，`plannerOf` 仍然返回 undefined。
- **life/now-host.ts（f0fd7819）**：`soulDir()` 和原来一样只取一次；`diaryByQq` 在构造时定死，`config.oneDiary`、`diaries`（`const`，1513 行）本来就不会变。（见第 3 条）
- **social/group-agency-wiring.ts、social/outbox-host.ts（5b89102d、6f01bf47）**：逐字搬过去；`agencyShadow` 是 `const`（646 行）；outbox 的 `crisisState` / `dormancy` 还是每一拍现取；
  `OUTBOX_BLOCKING` 挪到模块顶层，是常量，没影响。
- **lifetime 登记**：65ad9c42 把扫描范围扩到 src 下所有文件，停止顺序仍由 `STOP_ORDER` 决定，和登记的先后无关。
- **死代码删除（188ffccc、3933ff34、e747332d、e04f8501、12c598ea）**：删掉的导出（`homeAlternative`、`DshFetch`、`Recalled`、`describe*ForOwner`、`speechTrend`、`recordFeedback`、`parseFeedbackCommand`、
  `ASK_EVERY`、`worldLogger`、lock.ts 的 `startHeartbeat`）在删之前那一版全仓（含 `scripts/`、koishi 插件、`runtime/`）都没有调用方；
  `speech-trend.ts` 也没有按路径动态加载的地方。其余删的都是 tsc `noUnusedLocals` 报出来、没导出的局部变量或 import，初始化时没有副作用
  （删掉的 `readWorkMode` 只读不写）。`heartbeat.ts` 的 `startHeartbeat` 是另一个函数，还在用（app.ts:1225）。
- **noUnusedLocals（2cb5b71a、b6d82b7b）**：全部 workspace typecheck 通过；Koishi 加载插件时只转译、不做类型检查，所以不影响运行。
- **test/inventory/live-mix.ts、baseline harness（e02fee9d）**：harness 只加了一个可选的 `manifest` 钩子，基线场景都不传，快照不受影响；
  从快照搬开关时，字符串和对象类的路径（`dataDir`、`dsh`、联系人等）不搬，不会碰到真实目录。
