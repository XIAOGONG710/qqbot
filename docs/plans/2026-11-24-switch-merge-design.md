# 开关合并的实施设计（2026-11-24）

接 `docs/plans/2026-11-24-subtraction-round.md` 第三节。按开关审计 `docs/reports/2026-11-24-switch-audit.md`「可以合成一个的几组」，
把能合的开关合成一个键，**只改配置的形状、不改她的言行**。这份是可审的实施设计：每组的新键、新旧映射、线上兼容、基线影响、
总表 / 控制台 / 文档的改法、先后顺序和每步验证。只是设计，没有改代码。

结论先说：

- 19 组里 **11 组照审计的分法就能做**（线上等价、基线逐字不变，已用基线实跑核对过，见第〇节）；
  另有 5 组换个分法就能做：深思改三档、日常小事拆成两个键、QQ 表层和戳一戳（两组）重新分成「回复里的小动作 / 在 QQ 上的存在感 / 被戳」、留痕把对账并进账本而不是跟着长期记忆；
  剩下 3 组（夜间自省、追求、心境与回忆的感觉）整组或一半卡在下面的阻塞上。
- **6 处有阻塞**，合并本身做不成「行为不变」，要先有别的决定：
  夜间自省（基线 `review` 场景）、QQ 表层的整组合并（`RICH`、`burst-and-interrupt` 场景）、主动戳他并进戳一戳（`her-now-dsh` 场景）、
  追求（等减法单子二.8）、回忆的感觉（线上 `feltLedgerRecall` 关着，并进来就是给线上开了）、日常小事整组合并（`RICH` 没开 `worldDrama`）。
- 开关数：136 →（本设计能直接做的合并 −42）→（加上减法单子第二节推荐的删除 −19）**75**；阻塞都解开再 −11 是 64；「一个生活」另外 6 个验收完并进层级再 −6 是 **58**。
  和减法单子说的「约 55」差在：「一个生活」那 6 个还没验收、阻塞的 6 处，以及 `aiPhotos` 推荐先留。

---

## 〇、取证：合并后的语义在基线上跑一遍

做法：基线场景的配置是 `Partial<AppConfig>`，`baselineConfig`（`test/baseline/harness.ts:92`）拿 `DEFAULTS` 加场景覆盖直接拼成 `AppConfig`，不经过 `parseAppConfig`。
所以「合并后 app 只读新键」等价于：把每个场景里这一组的旧键都换成**从新键派生出来的值**，再跑场景、比快照。

1. 静态：对 41 个场景，按每组的「旧 → 新 → 旧」算一遍，列出值会变的场景和键。值不变的场景行为必然不变，不用跑。
2. 实跑：值会变的场景，用 `runScenario` + `compareSnapshot`（和 `baseline:fast` 同一套）跑派生后的配置。
   脚本在会话临时目录里（没有进仓库：只读引用 `test/baseline/*`，不改任何文件），实施时每组提交前照样要跑 `baseline:fast` 全量。

结果（2026-11-24，HEAD 48699406 附近）：

| 组 | 静态：值会变的场景 | 实跑 | 结论 |
|---|---|---|---|
| 主动时机 | 31（proactive 关着的 12 个只差子项；开着的 19 个 `hisReactions` false→true、`hisHours` true→false，`review` 另多 4 个时机） | proactive 开着的 19 个**全部一致** | 可做 |
| 夜间自省（一个开关，任一开就开） | 3：`her-notes`、`feelings`、`review` | `her-notes`、`feelings` 一致；`review` 22:00 多一次后台调用 | **阻塞** |
| 夜间自省（全开才开） | 同上 | `review` 少了 `self-diary.json`（`<<日记>>` 本地留一份是 `diaryInsights` 给的） | **阻塞** |
| B 站 | 0 | — | 可做 |
| 真实世界 | 0（`baselineConfig` 写死 `realWeather: false`） | — | 可做 |
| QQ 表层（5 合 1） | 31 | `burst-and-interrupt` 多 `setOnlineStatus`；`proactive-day`、`rich-chat` 多 `setOnlineStatus` | **阻塞** |
| QQ 表层（已读 / 输入中 / 撤回 3 合 1） | 1：`burst-and-interrupt` | 多 `markRead` | **阻塞** |
| 已读 + 撤回重发（2 合 1） | 0 | — | 可做 |
| 在线状态 + 点赞 + 主动戳他（3 合 1） | 0（基线里三个全关） | — | 可做 |
| 删 `reactions`（二.2，顺带核对） | 30 个 RICH 场景 true→false | `proactive-day`、`rich-chat`、`intents` 一致 | 删时全量再核 |
| 戳一戳（3 合 1） | 31（`pokeOut` false→true） | 跑了 14 个，13 个一致；`her-now-dsh` 19:04 多一次 `pokeFriend` | **阻塞** |
| 戳回去并进被戳会回（2 合 1） | 0 | — | 可做 |
| 感觉账并进心境 | 11（`feelingLedger` true→false，但 `herFeelings` 都关着） | 不用跑：唯一读处在 `herFeelings` 分支里（`app.ts` onFeelings） | 可做 |
| 回忆的感觉（`feltLedgerRecall` 并进 `memoryFeelings`） | 0 | — | 基线可做，**线上阻塞**（见第二节 8） |
| 留痕（对账跟着有没有长期记忆） | 3：`memory`、`feelings`、`review` | `review` 一致；`memory` 18:30 多一次后台调用 | 这样分不行 |
| 留痕（两个账本 + 对账 3 合 1） | 0（基线里三个全关） | — | 可做 |
| 深思（布尔合并） | 30（`depthRouting` false→true） | `rich-chat`、`intents` 多了小模型判轻重的调用 | 改成三档就 0 变 |
| 事实检查 | 0 | — | 可做 |
| 生活账 | 0 | — | 可做 |
| 节奏 | 1：`burst-and-interrupt`（`lagTail` false→true） | 一致 | 可做 |
| 追求（布尔合并） | 30（`selfPursuits` false→true） | `proactive-day`、`rich-chat` 20:00 的后台调用变了 | **阻塞**（等二.8） |
| 账号控制 | 0 | — | 可做 |
| 看图 | 41（`readStickers` false→true） | 不用跑：要 `stickerReader`（`app.ts:786`），基线不给 | 可做 |
| 日常小事（5 合 1） | 30（`worldDrama`、`worldThreads` false→true） | `rich-chat`、`her-now` 多出 `world/threads-from.json` | **阻塞** |
| 日常小事（拆成 2 个） | 0 | — | 可做 |
| QQ 空间 | 0 | — | 可做 |
| 拒绝之后并进会拒绝 | 30（`afterNo` false→true） | 跑了 8 个（`rich-chat` `intents` `proactive-day` `together` `closeness` `scenes` `consent` `devices`），全部一致 | 可做（全量以 `baseline:fast` 为准） |

快照里记的是模型调用、transport 动作和数据目录里的文件（日志不记，`harness.ts` 的 `log: () => {}`），所以「一致」= 她说的、做的、写下的都一样。

---

## 一、共用机制（先做一次：提交 M0，不动任何一组）

### 1. 合并表 `packages/bot/src/platform/switch-merge.ts`（新文件，纯数据 + 纯函数）

```ts
export interface SwitchMerge {
    /** 新键（AppConfig / koishi.yml 里的名字） */
    key: string;
    /** 被并进来的旧键，按 FEATURES 里原来的先后 */
    legacy: readonly string[];
    /** 旧键 → 新键的值。只在输入里没写新键、写了至少一个旧键时用；没写的旧键按 DEFAULTS 补 */
    fromLegacy(input: Record<string, unknown>): unknown;
    /** 新键 → 旧键的值（过渡期给还在读旧键的代码用；也是「可表达」的判据） */
    toLegacy(value: unknown, config: Record<string, unknown>): Record<string, unknown>;
}
export const SWITCH_MERGES: readonly SwitchMerge[];

/** 这一组的旧键能不能一字不差地用新键表达：toLegacy(fromLegacy(x)) 和 x 一样（requires 不满足、本来就不起作用的子项不算） */
export function representable(merge: SwitchMerge, input: Record<string, unknown>): boolean;
/** 给日志的说明：哪些旧键被读成了哪个新值、哪些组两边都写了以新键为准、哪些组表达不了 */
export function switchMergeNotes(input: Record<string, unknown>): string[];
```

每一组只在这张表里写一次映射；`parseAppConfig`、Koishi 插件的迁移、`live-mix`、`adr-map` 都调它，不各写一份。

### 2. `parseAppConfig`（`platform/config.ts:851`）的规则

对每一组，按输入里写了什么：

| 输入里 | 新键的值 | 过渡期 AppConfig 里的旧字段 | 日志 |
|---|---|---|---|
| 只有新键 | 新键 | `toLegacy(新键)` | 无 |
| 只有旧键（线上 koishi.yml 现在就是这样） | `fromLegacy(旧键)` | **旧键原样**（不经过派生） | 「旧键 a、b、c 已并进 X（= 值），请改用 X」；表达不了的再加一句「这几项和 X 对不上：…」 |
| 两边都写了 | 新键 | `toLegacy(新键)` | 「X 和旧键 a、b 都写了，以 X 为准」，旧键和派生值不一样的列出来 |
| 都没写 | DEFAULTS | `toLegacy(DEFAULTS)` | 无 |

第二行是关键：**过渡期只要输入里还是旧键，旧字段就原样往下传**，所以哪怕旧键之间互相对不上（比如 7 个开 6 个），
在 app 还读旧字段的这一步也一定和今天一样。只有到这一组的第二步（app 改读新键、旧字段删掉）时，对不上的组合才真的被折成新键的值——
那时规则见各组「旧 → 新」一栏（有总开关的以总开关为准，没有的写明取「任一开」还是「全开」），并且日志里一直有那句「对不上」。
线上快照里每一组都对得上（第二节逐组列了），所以线上不会走到「对不上」。

日志怎么出：`parseAppConfig` 不带 logger，签名不改；另导出 `switchMergeNotes(file)`，独立入口 `main.ts` 和 Koishi 插件 `apply()` 在解析之后各自 `log` 出来
（插件那边接在 `index.ts:911` 那行「开关：…」后面，那行也改成打新键）。

### 3. AppConfig 的过渡形状

- 新键进 `AppConfig` 和 `DEFAULTS`（`DEFAULTS` 同时是 Koishi 表单的默认值，插件测试核对两边一致）。
- 旧字段第一步**留着**，注释改成 `/** @deprecated 已并进 X（开关合并）：输入只有旧键时原样、否则由 X 派生；新代码读 X */`，类型不变。
  `config.proactiveReach` 这种读法在第一步一个都不用改，app 代码可以一组一组地改。
- 基线和单元测试直接拼 `AppConfig`（`baselineConfig`、`live-switches-*.test.ts`），第一步照样设旧字段、照样生效，所以第一步对基线是零变化。
- 第二步（这一组改读新键）：删掉旧字段和它在 `DEFAULTS` 里的那一项；`SWITCH_MERGES` 里这一组的输入映射**留着**（线上 koishi.yml 迁移完、确认过之后才删，见第三节最后一步）。

### 4. Koishi 插件（`packages/koishi-plugin-qqbot/src/index.ts`）

现状要先说清的两件事（核对过 schemastery 源码 `node_modules/schemastery/lib/index.mjs`）：

- 顶层 `Config` 是 `Schema.intersect`，解析时不认识的键原样留在 config 里（非严格模式 `merge(result, data)`），所以把旧键从表单删掉，**插件这次启动还能读到它们**；
- 但 `simplify`（loader 写回 koishi.yml、控制台保存、「按 JSON 编辑」都用它）对 `object` 只保留表单里有的键——**旧键一旦不在表单里，控制台下一次保存就把它们从 koishi.yml 里抹掉**。
  那时如果新键还没写进 yml（新键等于默认值时 Koishi 也不写），重启后这一组就按新键的默认值（多半是关）跑——线上行为就变了。

所以插件分三处改：

1. **表单**：新键用 `toggle('X')` / `choice('X')`（`feature-schema.test.ts` 要求每个 FEATURES 键恰好一行）；
   旧键改成 `legacy('a')`——新的小 helper，`Schema.boolean()` / 模式联合 `.hidden()`、**不带 `.default()`**：控制台不显示，但保存时不会被抹掉（`simplify` 只丢等于默认值的，没有默认值就留着）。
2. **迁移并写回**：照 `migrateThinking`（`index.ts:854`，「思考写在其他参数里」那次的先例，`docs/koishi.md` 第 75 行）加 `migrateSwitches(config)`：
   配置里还有某一组的旧键、而且这一组 `representable` 时，算出新键、删掉这一组的旧键，日志一句「迁移配置：a、b、c 并进 X=…，行为不变」，`ctx.scope.update(migrated)` 写回 koishi.yml，插件按新配置重启。
   表达不了的组**不写回**，只记日志、请用户在表单里选；这一组在过渡期照旧按旧键跑（上一条规则第二行）。
   两个迁移的先后：先 `migrateThinking`，再 `migrateSwitches`（各自 `return` 一次，第二次启动再做下一个，和现在一样）。
3. **`toAppConfigInput`**：新键 `...(config.X !== undefined ? { X: config.X } : {})`；旧键**照传**（`legacy` 键也是 `!== undefined` 才传）。合并逻辑只在 `parseAppConfig` 一处。

写回 koishi.yml 是「改线上配置文件」：值等价，但仍然随上线一起让用户点头。上线前照 `scripts/snapshot-config.mjs` 留一份脱敏快照、并备份 koishi.yml；
迁移后用 `scripts/read-switches.mjs` 再出一份快照放 `exchange/live/`，对着第二节的「线上」一栏核对。

为什么不只靠「隐藏旧键、永不写回」：新键在表单里改回默认值时 Koishi 不写它，旧键又还在，于是旧键赢——用户在表单上关不掉。迁移写回把这个窗口关掉。

### 5. 功能总表 / 状态页 / 文档

- **`features.ts`**：新键一行（`kind`、`modeLabels`、`requires` 照现在的写法），`detail` 里把吸收的每一项列成一句（「开着就有：没回也继续找他（ADR 0100）、约他一起玩（ADR 0107）……」）。
  旧键的行删掉；`FeatureDef` 加一个可选字段 `absorbs?: readonly { key: string; adr: string; label: string }[]`，记被并进来的旧键和它们的 ADR。
- **`dashboard.test.ts`「DEFAULTS 里每个开关要么在 FEATURES 要么在 NOT_SWITCHES」**：过渡期旧键还在 DEFAULTS 里，加一张 `LEGACY_SWITCHES`（由 `SWITCH_MERGES` 生成）一起算「已登记」；
  第二步删了旧字段，它们自然不在了。
- **控制台「状态」页**（`app.ts:2723` `featureStatuses(config)`；`client/dashboard.js` 按分组画，不认具体键名）：自动只显示新键；
  `featureStatuses` 对 `absorbs` 不用做什么——新键开着就是全开着。`modules.ts` 里写死 `featureKeys` 的那几个模块（如 `modules.ts:244`）跟着换键名。
- **`docs/modules/`**：`node packages/bot/src/ops/modules-doc.ts` 重新生成（`modules.test.ts` 核对），开关表里新键一行，说明里带被吸收的项。
- **`scripts/adr-map.mjs`**：现在按 `f.adr === 编号` 找开关；改成也看 `absorbs[].adr`，写成「`proactive`（原 `proactiveReach`）」；
  线上值先按新键找，快照里还是旧键时按旧键找（迁移前后的快照都能出图）。重新生成 `docs/adr/MAP.md`。
- **`test/inventory/live-mix.ts`**（`liveSwitches`，按 `DEFAULTS` 认识的键搬快照）：过渡期旧键仍在 DEFAULTS 里，照搬；第二步之后旧键不认识了，
  改成先过一遍 `fromLegacy`——不然拿 11-20 的快照跑盘点会把这一组当成关。
- **`sim/`**（模拟器的 `scenario.ts` 有自己的 `proactiveReach` 这类布尔）：不是 AppConfig，这一轮不动；模拟器场景的形状以后跟模块迁移一起收。

### 6. 每组两步，一组一个提交

- **步骤 A（配置形状）**：`SWITCH_MERGES` 加这一组；`DEFAULTS` / `AppConfig` 加新键；`features.ts` 新行 + `absorbs`；Koishi 表单新键 + 旧键 `legacy`；配置测试。app 一行不改，基线零变化。
- **步骤 B（改读新键）**：app / 模块 / 宿主文件里的 `config.旧键` 换成读新键（或 `toLegacy` 的那个式子）；删旧字段；`scenarios.ts`、单元测试里的旧键换成新键；重新生成 docs/modules。
- 没有阻塞的组 A+B 放在**一个提交**里（任务要求一组一个提交）；有阻塞的组只做 A 也不划算（多一个键、少不了一个），**整组先不动**，等阻塞解开。

---

## 二、逐组

「线上」一栏取 `exchange/live/koishi-2026-11-20-1855.yaml`，加审计记下的快照后补开：`selfExport`、`selfReceipts`（11-22）、`desktopDay`（11-23）。
快照里没写的按默认值。**上线前要用新快照重核这一栏**。
「基线」一栏：只列这一组设了部分键的场景；`RICH` = `scenarios.ts:56` 那一组，30 个场景摊开它。

### 1. 主动时机 → `proactive`

| | |
|---|---|
| 新键 | `proactive: 'off' \| 'dryRun' \| 'on'`（已有，类型不变，默认 `off`）。语义扩成「开着（含 dryRun）就带下面 7 个时机」 |
| 吸收（7） | `proactiveReach` `proactiveInvite` `proactiveAsk` `comeBack` `smallNews` `proactiveRoom` `hisReactions` |
| 不吸收 | `innerLife`（还管 inner 槽、herPlan，单留）；`curious`（说话那边也用）；`hisHours`、`photoShares`（二.2 推荐删；删之前原样单留，不并） |
| 旧 → 新 | `proactive` 自己决定；7 个子项不影响它的值。可表达：`proactive` 关，或 7 个全开 |
| 新 → 旧 | 7 个 = `proactive !== 'off'` |
| 线上 | `proactive: on`，7 个全 true（`hisHours`、`photoShares` 没写 = 关）→ 可表达，等价 |
| 基线 | `RICH` 开了其中 6 个 + `hisHours`、没开 `hisReactions`；`review` 只开 `proactiveReach`、`comeBack`。proactive 关着的场景：7 个子项全在 `planner-host.ts:87` 的 `config.proactive === 'off'` 之后才读，另一处只是 `app.ts:1659` 一行日志——无影响。proactive 开着的 19 个场景全部实跑一致（连 `hisHours` 改成关一起跑的，所以二.2 删 `hisHours` 也不动这 19 份快照） |
| 第二步要改的 | `proactive/planner-host.ts`（第 88 行那串 `config.X && withX`、`hisReactions` 那行）、`app.ts:1659` 日志；`live-switches-proactive.test.ts`；`RICH` 删掉这 7 个键 |
| 风险 / 阻塞 | 低（读处多，靠全量基线）；无阻塞 |

### 2. 夜间自省 → `nightThoughts`（新键）

| | |
|---|---|
| 新键 | `nightThoughts: boolean`，默认 false |
| 吸收（7） | `speechNotes` `chatReview` `diaryInsights` `readingTakes` `openQuestions` `herGuesses` `feelingReview` |
| 旧 → 新 | 没有总开关；取「任一开就开」 |
| 新 → 旧 | 7 个 = `nightThoughts`（`feelingReview` 照旧还要 `herFeelings`，`app.ts:862`） |
| 线上 | 7 个全 true → 等价 |
| 基线 | `her-notes`（RICH + 前 6 个，没 `feelingReview`）：并成开，实跑一致。`feelings`（只 `feelingReview`）：并成开，实跑一致。`review`（只 `diaryInsights`，为的是 `<<日记>>` 发出去时本地也留一份——`app.ts:1050` 的 `keepDiary` 跟着 `diaryInsights`）：并成开 → 22:00 多一次后台调用；并成关 → 快照里的 `self-diary.json` 没了。两种都不一致 |
| 风险 / 阻塞 | **阻塞：`review` 场景**。解法二选一：(a) 把「本地留一份日记」从 `diaryInsights` 拆出来（它其实是 ADR 0194 读日记的前提，和「一本日记」`oneDiary` 那一层是同一件事），先单独一个不改快照的提交，再合并；(b) `review` 场景改配置，单独提交、更新快照、写清只是测试配置变了（要用户点头）。推荐 (a)，拆之前先看 `modules/self-notes.ts:84` 和 ADR 0347 第 3 层 §2.5 |

### 3. B 站 → `bilibili` + `watching`

| | |
|---|---|
| 新键 | `bilibili: 'off' \| 'dryRun' \| 'on'`（已有，类型不变）；`watching: boolean`（已有） |
| 吸收 | 进 `bilibili`：`bilibiliAccount` `bilibiliDm` `bilibiliReplies` `bilibiliComment` `acquaintances`；进 `watching`：`biliFeed`；`biliStickers` 由 `bilibili` 和 `stickers` 一起定（共 7 个） |
| 不并进 `bilibili` 的 | `watching` 自己留成键（`watched` 场景只开它、不开 `bilibili`，并进去就表达不了）；`memes`（单留，但它「自己去学」要账号，那一处改成看 `bilibili !== 'off'`）；`bilibiliAtName/AtUid/CommentKeywords` 是参数 |
| 旧 → 新 | `bilibili` 自己决定；`watching` 自己决定 |
| 新 → 旧 | `bilibiliAccount = acquaintances = bilibili !== 'off'`；`bilibiliDm = bilibiliReplies = bilibiliComment = bilibili`；`biliFeed = watching ? bilibili : 'off'`；`biliStickers = bilibili !== 'off' && stickers !== 'off'` |
| 线上 | `bilibili on`、账号 true、Dm / Comment / Replies / biliFeed 全 on、watching / acquaintances / biliStickers true、`stickers: send` → 等价 |
| 基线 | 只有 `watched` 设了 `watching`（`bilibili` 关）→ 派生的 `biliFeed` 还是 off；0 个场景值变 |
| 表达不了的（不在线上） | 只开账号不分享视频；开了 `biliStickers` 但 `bilibili` 关（它「12% 的轮次顺手发一个」那一半会跟着没） |
| 第二步要改的 | `bilibili/owners.ts`、`bilibili/passive-jobs.ts`、`app.ts`（acquaintances、biliFeed、biliStickers 三处）、`planner-host.ts`（biliFeed）；`modules.ts` 的 `BILIBILI_DM` 等 4 个常量删掉、`BILIBILI` 的 detail 合并；插件 `config.test.ts` 那 5 条「使用模块说明」的测试并成一条 |
| 风险 / 阻塞 | 低（基线不碰 B 站，靠单元测试）；无阻塞 |

### 4. 真实世界 → `realWorld`（新键）

| | |
|---|---|
| 新键 | `realWorld: boolean`，默认 **true**（同现在 `realWeather` 的默认） |
| 吸收（4） | `realWeather` `realAirQuality` `realDaylight` `realCalendar` |
| 不吸收 | `realTransport`（对象、没数据源，二.2 推荐删） |
| 旧 → 新 | `realWeather` 当总开关 |
| 新 → 旧 | 4 个 = `realWorld` |
| 线上 | `realWeather` 没写（= 默认 true），另 3 个 true → 等价 |
| 基线 | `baselineConfig` 写死 `realWeather: false`，第二步改成 `realWorld: false`；0 个场景值变 |
| 表达不了的 | 默认配置本身：`realWeather` 默认开、另 3 个默认关。合并后新装默认 4 个全开。只影响新装和几个单元测试（`world-config-review.test.ts` 一类），线上不受影响 |
| 第二步要改的 | `world/reality-feeds.ts`（4 处读）；控制台 `realWorldStatus` 不用改（它按数据源画） |
| 风险 / 阻塞 | 低；无阻塞 |

### 5. QQ 表层动作 + 6. 戳一戳 → `qqSurface` + `qqPresence` + `pokes`

审计里是两组（表层 5 个、戳一戳 3 个），按审计的分法两组都在基线上过不去；按「在哪读、基线里怎么开」重新分成三个键就都能做，整组合并留给阻塞解开之后。

| | |
|---|---|
| 新键 | `qqSurface: boolean`（新，默认 false）：回复时的小动作；`qqPresence: boolean`（新，默认 false）：不聊天时在 QQ 上的存在感；`pokes: boolean`（已有）：被戳会回 |
| 吸收 | 进 `qqSurface`：`readReceipts` `selfRecall`（都在 `app.ts` 给 responder 的那几行，1949–1961）；进 `qqPresence`：`onlineStatus` `profileLikes` `pokeOut`（都在 `social/presence-owner.ts`，另 `social/group-room.ts` 读后两个）；进 `pokes`：`pokeBack`（共 5 个） |
| 暂不吸收 | `typingStatus`（单留，见阻塞）；`reactions`（线上 false，二.2 推荐删；删之前单留） |
| 旧 → 新 | `qqSurface`、`qqPresence` 没有总开关，任一开就开；`pokes` 自己是总开关（`pokeBack` 本来就要它） |
| 新 → 旧 | `readReceipts = selfRecall = qqSurface`；`onlineStatus = profileLikes = pokeOut = qqPresence`；`pokeBack = pokes` |
| 线上 | 表层 5 个、戳一戳 3 个全 true，`reactions: false` → 等价 |
| 基线 | `RICH`（30 个场景）开了 `readReceipts` `typingStatus` `selfRecall` `reactions` `pokes` `pokeBack`，没开 `onlineStatus` `profileLikes` `pokeOut`；`poke-recall` 开 `pokes` + `pokeBack`；`burst-and-interrupt` 只开 `typingStatus`。按上面的分法三个新键在所有场景里都是「全开或全关」，0 个场景值变 |
| 审计分法为什么不行 | 表层 5 合 1：`RICH` 和 `burst-and-interrupt` 多出 `setOnlineStatus`（已读 / 输入中 / 撤回 3 合 1 时 `burst-and-interrupt` 多出 `markRead`）；戳一戳 3 合 1：`her-now-dsh` 19:04 多一次 `pokeFriend`（`pokeOut` 要安静了一阵、最后一条是她说的，那个场景恰好碰上） |
| 表达不了的（不在线上） | 只开已读不开撤回重发；只开在线状态不开点赞 / 主动戳他 |
| 第二步要改的 | `app.ts:1949–1961`、`social/presence-owner.ts`、`social/group-room.ts`、`modules/pokes.ts`；插件 `config.test.ts` 里戳一戳那几条 |
| 风险 / 阻塞 | 低；三键的分法无阻塞。**整组合成一个 `qqSurface`（含 `typingStatus`、`qqPresence`）阻塞于 `RICH`、`burst-and-interrupt`、`her-now-dsh` 三处场景配置**。快照差的只是 transport 动作（标已读、在线状态、戳一下），不是她说的话。解法：单独一个提交把这几处场景的配置改成和线上一样（全开），更新快照、提交说明写清「测试配置向线上靠拢，生产行为不变」——这属于「更新快照」，要用户点头；之后 8 → 2（`qqSurface`、`pokes`） |

### 7. 「一个生活」分层 → `oneLife`（新键）

| | |
|---|---|
| 新键 | `oneLife: 'off' \| 'read' \| 'export' \| 'desktop'`，默认 `off`。用字符串不用 0–3：`choice()` 和 `modeLabels` 都按字符串，状态页按 `kind: 'mode'` 画 |
| 各层 | `read` = `crossRecent`（互读最近几轮）；`export` = 再加 `selfExport` + `selfReceipts`；`desktop` = 再加 `desktopDay` |
| 吸收（4） | `crossRecent` `selfExport` `selfReceipts` `desktopDay` |
| 暂不吸收（6） | `ownDays` `desktopReview` `desktopPromises` `oneDiary` `desktopFeelings` `desktopConflict`：线上都关，各自改她说的 / 记的，**每一块验收（ask-her + 用户）开到线上之后**，再并成更高的一层或并进 `desktop`，不单独留键 |
| 旧 → 新 | 取满足整条链的最高一层：`desktopDay && selfExport && selfReceipts && crossRecent` → desktop；`selfExport && selfReceipts && crossRecent` → export；`crossRecent` → read |
| 新 → 旧 | 各层包含下面的层 |
| 线上 | 11-20 快照只有 `crossRecent`；审计和信箱记着 11-22 开了 `selfExport` `selfReceipts`、11-23 开了 `desktopDay` → `desktop`，等价。**这一组最依赖新快照**：上线前必须用 `read-switches.mjs` 重出一份确认四个都开着 |
| 表达不了的 | 跳层（比如开了 `desktopDay` 没开 `selfExport`）、只开 `selfExport` 不开 `selfReceipts` |
| 基线 | 没有场景设这 4 个；0 变。`app.test.ts` 有两条同时设两边的（审计「依赖组合」表），第二步改成设 `oneLife` |
| 第二步要改的 | `life/desktop-host.ts`（`Pick<AppConfig, …>` 那一串）、`memory/cross-recent.ts` 的接线、`life/self-export.ts`、`memory/self-receipts.ts` 的接线；`features.ts` 里 6 个暂不吸收的 `requires: ['desktopDay']` 改成 `requires: ['oneLife']` 并在 `featureStatuses` 里认「至少 desktop 层」（`requires` 现在只认开 / 关，这里要加一种「模式至少到哪一档」，或者在 `configured` 里对 `oneLife` 特判） |
| 风险 / 阻塞 | 中（ADR 0347 还在接线，`docs/plans/2026-11-22-same-her-layer*` 那条线在改同一批文件）。动之前在信箱 `send` 一句「我在改 oneLife 配置」，无阻塞 |

### 8. 心境与回忆的感觉

| | |
|---|---|
| 能做的 | `feelingLedger` 并进 `herFeelings`：新 → 旧 `feelingLedger = herFeelings`；线上 `herFeelings` true、`feelingLedger` 默认 true → 等价。基线 11 个场景 `feelingLedger` 会变成 false，但它们 `herFeelings` 都关，唯一读处在 `config.herFeelings && …` 分支里（`app.ts` onFeelings）→ 无影响。表达不了的：开心境但不记账（不在线上） |
| 做不成的 | `feltLedgerRecall` 并进 `memoryFeelings`：线上 `memoryFeelings` 开、`feltLedgerRecall` 关（默认关，注释写着「改她说话，要用户点头」）。并进来 = 给线上开了它，**这是改她言行，不是合并** |
| 阻塞 | 先按规矩 `ask-her` + 用户点头把 `feltLedgerRecall` 在线上开一阵；开着没问题再合并（那时线上两个都开，可表达）。基线没有场景设它们，到时 0 变 |
| 风险 | `feelingLedger` 那一半低 |

### 9. 留痕 → `ledgers`（新键）

| | |
|---|---|
| 新键 | `ledgers: boolean`，默认 false。意思是「有没有被悄悄改 / 漏写，都记账、都核对」 |
| 吸收（3） | `identityLedger` `memoryAudit` `memoryReconcile` |
| 没采用的分法 | 审计建议 `memoryReconcile` 直接跟着「有没有长期记忆」。实跑：带假 Hindsight 的 `memory` 场景 18:30 多一次后台调用（`review` 一致）——不行。并进 `ledgers` 则基线里三个全关，0 变 |
| 旧 → 新 | 没有总开关；任一开就开 |
| 新 → 旧 | 3 个 = `ledgers`（`memoryReconcile` 照旧还要有 `memory` 一节才起作用，`app.ts:1458`） |
| 线上 | 3 个全 true → 等价 |
| 基线 | 没有场景设这 3 个（`identityLedger` 要真实角色目录和 git，基线本来就不碰）；0 变 |
| 第二步要改的 | `app.ts:1297`、`1309`、`1458` |
| 风险 / 阻塞 | 低；无阻塞。`memoryReconcile` 线上开着、开关层原来没测试（审计「没测过的 6 个」），合并时在 `switch-merge.test.ts` 里补一条 |

### 10. 深思 → `deliberation`（新键，三档）

| | |
|---|---|
| 新键 | `deliberation: 'off' \| 'keywords' \| 'routed'`，默认 `off`；`deliberateModel` 参数不动 |
| 吸收（2） | `deliberate` `depthRouting` |
| 为什么三档 | 布尔合并（`depthRouting` 跟着 `deliberate`）实跑不一致：30 个 RICH 场景都开 `deliberate`、没开 `depthRouting`，并起来每轮多一次小模型判轻重 |
| 为什么换名 | `deliberate` 是布尔；同名改成模式，旧 koishi.yml 的 `deliberate: true` 过不了新的下拉 Schema，插件起不来。换名最省事，旧名走 `legacy` |
| 旧 → 新 | `deliberate` 关 → off（`depthRouting` 单开本来就不起作用，`app.ts:1326`）；开、`depthRouting` 关 → keywords；都开 → routed。总能表达 |
| 新 → 旧 | `deliberate = deliberation !== 'off'`；`depthRouting = deliberation === 'routed'` |
| 线上 | 都开 → routed，等价 |
| 基线 | RICH 的 `deliberate: true` → keywords；0 变 |
| 第二步要改的 | `app.ts:1320–1326`（turnWeigher）、`modules/deliberate.ts`、`deliberateLlm` 的调用处；`deliberate-module.test.ts`、`app.test.ts` |
| 风险 / 阻塞 | 低；无阻塞 |

### 11. 事实检查 → `factCheck`

| | |
|---|---|
| 新键 | `factCheck: 'off' \| 'log' \| 'fix'`（已有，类型不变） |
| 吸收（1） | `factHim`：检查开着就也查「替他说的」 |
| 旧 → 新 / 新 → 旧 | `factCheck` 自己决定；`factHim = factCheck !== 'off'` |
| 线上 | fix + `factHim` true → 等价 |
| 基线 | 只有 `review` 设了，`fix` + `factHim` → 0 变 |
| 表达不了的 | 开检查但不查他那一类（不在线上） |
| 风险 / 阻塞 | 低（`app.ts:1154` 一处）；无阻塞。注意二.6「fix 的取舍」可能改 `factCheck` 的档，和这里不冲突 |

### 12. 生活账 → `autonomousLife`

| | |
|---|---|
| 吸收（2） | `projectChoice` `lifeInPrompt`（都要 `autonomousLife` 的账） |
| 新 → 旧 | 2 个 = `autonomousLife` |
| 线上 | 3 个都开 → 等价 |
| 基线 | 30 个 RICH 场景三个都开，其余都关；0 变 |
| 第二步要改的 | `app.ts` 687、766、969、982、1088、1872 几处 |
| 风险 / 阻塞 | 低；无阻塞 |

### 13. 节奏 → `rhythm`

| | |
|---|---|
| 吸收（1） | `lagTail` |
| 新 → 旧 | `lagTail = rhythm` |
| 线上 | 都开 → 等价 |
| 基线 | `burst-and-interrupt` 只开 `rhythm`：并进去后 `lagTail` 开，实跑一致（连发 + 打断那几分钟里长尾没抽中）；RICH 两个都开 |
| 风险 / 阻塞 | 低；无阻塞 |

### 14. 追求 → 等减法单子二.8

| | |
|---|---|
| 布尔合并 | `selfPursuits` 跟着 `pursuits`：实跑 `proactive-day`、`rich-chat` 20:00 那次后台调用变了（30 个 RICH 场景只开 `pursuits`）→ 不行 |
| 二.8 撤 | `selfPursuits` 直接删（线上行为变，`ask-her` + 用户点头），不是合并；`pursuits` 单留 |
| 二.8 留 | 做成三档 `pursuitMode: 'off' \| 'author' \| 'self'`（换名，理由同深思），基线 RICH → author，0 变 |
| 阻塞 | **等二.8 的决定** |

### 15. 账号控制 → `qqControl`

| | |
|---|---|
| 新键 | `qqControl: 'off' \| 'read' \| 'on'`（已有） |
| 吸收（1） | `qqFriendGate` |
| 新 → 旧 | `qqFriendGate = qqControl === 'on' ? 'allow' : 'off'` |
| 线上 | on + allow → 等价 |
| 表达不了的 | `qqFriendGate: 'all'`（名单外驳回）。线上没用过；要留就给 `qqControl` 加一档，推荐不留 |
| 基线 | 不碰；0 变。`qqAllowFriends` 等仍是 `NOT_SWITCHES` 里的参数 |
| 第二步要改的 | `modules/friend-requests.ts`、`app.ts:2588–2589` |
| 风险 / 阻塞 | 低；无阻塞 |

### 16. 看图 → `media`

| | |
|---|---|
| 吸收（1） | `readStickers`（要 `media` + 看图模型） |
| 新 → 旧 | `readStickers = media` |
| 线上 | `media` 默认 true、`readStickers` true → 等价 |
| 基线 | 41 个场景 `readStickers` 会变成开，但 `app.ts:786` 还要 `stickerReader`，基线 harness 不给 → 无影响 |
| 表达不了的 | 默认配置本身（`media` 默认开、`readStickers` 默认关）：合并后新装默认会读表情包——仍要配了看图模型才真读，图只发给名单里的人 |
| 第二步要改的 | `app.ts:786–799`、`main.ts` |
| 风险 / 阻塞 | 低；无阻塞 |

### 17. 日常小事 → `everydayLife` + `worldDrama`

| | |
|---|---|
| 5 合 1 | 实跑不一致：RICH 没开 `worldDrama` / `worldThreads`，并进 `everydayLife` 后 `rich-chat`、`her-now` 多出 `world/threads-from.json`（对话本身没变，多的是那个文件） |
| 能做的拆法 | `everydayLife` 吸收 `npcAsks` `menu`；`worldDrama` 吸收 `worldThreads`（5 → 2，−3） |
| 新 → 旧 | `npcAsks = menu = everydayLife`；`worldThreads = worldDrama`（`app.ts:570` 照旧还要 `everydayLife`） |
| 线上 | 5 个全开 → 等价 |
| 基线 | RICH 三个（everydayLife / npcAsks / menu）同开，`worldDrama` / `worldThreads` 没有场景设；0 变 |
| 表达不了的 | 开 `worldDrama` 不开 `worldThreads`（不在线上） |
| 剩下那一步 | `worldDrama` 再并进 `everydayLife`：要 RICH 加 `worldDrama`，快照多文件，单独提交、用户点头（同 QQ 表层的解法） |
| 第二步要改的 | `app.ts:570–579`、`planner-host.ts`、`vision/photo-discovery.ts`（`menu`） |
| 风险 / 阻塞 | 拆法低、无阻塞；5 合 1 **阻塞**于 RICH 场景 |

### 18. QQ 空间 → `qzone`

| | |
|---|---|
| 新键 | `qzone: 'off' \| 'dryRun' \| 'on'`（已有） |
| 吸收（4） | `qzoneBrowse` `qzonePeek` `qzoneStrangers` `signature`（都是同一种三档，都在 `social/presence-owner.ts` 读） |
| 新 → 旧 | 4 个 = `qzone` |
| 线上 | 5 个全 on → 等价；`qzoneVisibility: public` 是参数，不动 |
| 基线 | 不碰；0 变 |
| 第二步要改的 | `social/presence-owner.ts`；`modules.ts` 的 `QZONE_BROWSE` `QZONE_PEEK` `SIGNATURE` 常量；插件 `config.test.ts` 那 4 条「使用模块说明」并成一条 |
| 风险 / 阻塞 | 最低；无阻塞 |

### 19. 拒绝之后 → `herNo`

| | |
|---|---|
| 吸收（1） | `afterNo`（只在拒绝那条路上起作用） |
| 新 → 旧 | `afterNo = herNo` |
| 线上 | 都开 → 等价 |
| 基线 | 30 个 RICH 场景开 `herNo`、没开 `afterNo`；实跑了 8 个（含 `rich-chat` `intents` `consent` `devices`）全部一致；全量以 `baseline:fast` 为准 |
| 风险 / 阻塞 | 低（改的是意图行，基线全量必须过）；无阻塞 |

### 不在这一轮的

形状族 7 个（`shape` …）跟着减法单子二.1「fewerRules 转不转正」走：转正整族删，回退才合成一个 `shape`。不在这份设计里。

---

## 三、顺序与每步验证

先做基础，再从「0 个场景值变、读处少」的组开始，主动时机这种读处多、要全量跑的放后面：

| 提交 | 内容 | 为什么在这里 |
|---|---|---|
| M0 | `switch-merge.ts`（空表）+ `parseAppConfig` 规则 + `switchMergeNotes` + Koishi `legacy()` / `migrateSwitches` + `FeatureDef.absorbs` + `LEGACY_SWITCHES` + adr-map / live-mix 认合并表 + 测试 | 机制先单独审；不动任何开关 |
| 1 | QQ 空间 | 全是同类型三档、一个读处文件、基线不碰 |
| 2 | 事实检查 | 一处读 |
| 3 | 账号控制 | 两处读 |
| 4 | 生活账 | 基线 0 变 |
| 5 | 看图 | 基线 0 变（代码证明） |
| 6 | 真实世界 | 新键名、默认 true，先在简单组上走通「新名 + 迁移」 |
| 7 | B 站 | 7 个键、四个文件，基线 0 变 |
| 8 | 感觉账并进心境 | 一处读 |
| 9 | 深思（三档、新名） | 第一个换类型的组 |
| 10 | 节奏 | 一个场景要跑 |
| 11 | 日常小事（拆成 2） | 两个新映射 |
| 12 | 留痕（3 合 1） | 基线 0 变；补 `memoryReconcile` 的开关层测试 |
| 13 | QQ 表层 + 戳一戳（三个键） | 基线 0 变，但读处分在三个文件 |
| 14 | 拒绝之后 | 30 个场景值变（实跑 8 个一致），全量要过；改的是意图行 |
| 15 | （空：原「戳一戳」并进 13） | |
| 16 | 主动时机 | 读处最多、19 个场景要过 |
| 17 | 「一个生活」 | 先在信箱打招呼，和 ADR 0347 那条线错开 |
| 最后 | 线上迁移确认之后：删 `legacy()` 表单项、`SWITCH_MERGES` 的输入映射、`LEGACY_SWITCHES` | 线上 koishi.yml 已是新键（新快照为证）、过一周没问题再删 |

阻塞的（夜间自省、QQ 表层 / 戳一戳整组、追求、回忆的感觉、日常小事整组）不排进来；各自的前置决定有了，再按「一组一个提交」补在后面。

每个提交的检查（都过了才提交、推送）：

1. `npm run typecheck`（全部包）。
2. `npm run baseline:fast -w @qqbot/bot`：**41/41 一致**，不许 `UPDATE_BASELINE=1`。
3. 配置测试：`node --import ./test/time-zone-setup.ts --test test/dashboard.test.ts test/feature-schema.test.ts test/config.test.ts`（在 `packages/koishi-plugin-qqbot` 下），
   和 bot 里碰到这一组的 `live-switches-*.test.ts`、`modules.test.ts`、`feature-details.test.ts`。
4. 每组新增的测试（放在插件 `config.test.ts` 和 bot 的一个新 `switch-merge.test.ts` 里）：
   - 线上快照里这一组的旧键 → `parseAppConfig` 得到的新键和派生旧字段，等于今天直接解析的旧字段（用 `exchange/live/` 最新那份快照，不读真实角色资料）；
   - 只写新键 / 两边都写 / 都不写 三种输入；表达不了的组合：过渡期旧字段原样、日志有那句；
   - Koishi：带旧键的 yml 经 `migrateSwitches` 后只剩新键，`Config(Config.simplify(…))` 往返不变；`legacy` 键在控制台保存后不丢。
5. `node packages/bot/src/ops/modules-doc.ts` 和 `node scripts/adr-map.mjs --out docs/adr/MAP.md` 重新生成（`modules.test.ts`、`adr-map.test.mjs` 核对）。
6. 提交前跑一次 `npm test` 全量（约 11 分钟）——M0、主动时机、「一个生活」这三个提交必跑；其余组至少跑上面 1–5。

上线（重启线上、koishi.yml 被迁移写回）照规矩先问用户，可以攒几组一起上；问的时候附上这几组「线上旧键 → 新键」的对照，上线后出新快照对一遍。

---

## 四、汇总

| 组 | 旧 → 新（键数） | 减 | 风险 | 阻塞 |
|---|---|---|---|---|
| 主动时机 | 8 → 1（`proactive`；`hisHours` `photoShares` 走二.2 删） | −7 | 低（读处多，19 个场景实跑一致，全量再过） | 无 |
| 夜间自省 | 7 → 1（`nightThoughts`） | 0（解开后 −6） | 中 | **`review` 场景：`<<日记>>` 本地留一份挂在 `diaryInsights` 上** |
| B 站 | 9 → 2（`bilibili` `watching`） | −7 | 低 | 无 |
| 真实世界 | 4 → 1（`realWorld`；`realTransport` 走二.2） | −3 | 低 | 无（新装默认变，线上不变） |
| QQ 表层 + 戳一戳 | 8 → 4（`qqSurface` `typingStatus` `qqPresence` `pokes`；`reactions` 走二.2） | −4（解开后再 −2，8 → 2） | 低 | **整组：`RICH`、`burst-and-interrupt`、`her-now-dsh` 场景配置要向线上靠拢（改快照，用户点头）** |
| 「一个生活」 | 4 → 1（`oneLife` 四档）；另 6 个验收后并入 | −3（以后再 −6） | 中（ADR 0347 那条线在改同一批文件） | 另 6 个：各自验收 |
| 心境与回忆的感觉 | 4 → 3（`feelingLedger` 并进 `herFeelings`） | −1（解开后再 −1） | 低 | **`feltLedgerRecall` 线上关着，并进来 = 改言行** |
| 留痕 | 3 → 1（`ledgers`） | −2 | 低 | 无（「对账跟着长期记忆」的分法实跑不行） |
| 深思 | 2 → 1（`deliberation` 三档） | −1 | 低 | 无（布尔合并实跑不行，三档可以） |
| 事实检查 | 2 → 1 | −1 | 低 | 无 |
| 生活账 | 3 → 1 | −2 | 低 | 无 |
| 节奏 | 2 → 1 | −1 | 低 | 无 |
| 追求 | 2 → 1 | 0（解开后 −1） | — | **等二.8**（撤就是删，留就三档） |
| 账号控制 | 2 → 1 | −1 | 低 | 无（`all` 档不留） |
| 看图 | 2 → 1 | −1 | 低 | 无 |
| 日常小事 | 5 → 2（`everydayLife` `worldDrama`） | −3（解开后再 −1） | 低 | **5 合 1：RICH 没开 `worldDrama`** |
| QQ 空间 | 5 → 1 | −4 | 最低 | 无 |
| 拒绝之后 | 2 → 1 | −1 | 低（改意图行，全量过） | 无 |
| **合计** | | **能直接做 −42；阻塞解开再 −11** | | |

开关数（以审计的 136 为起点）：

- 能直接做的合并：136 − 42 = **94**；
- 加上减法单子第二节推荐的删除 19 个（fewerRules 转正带走的 11 个、二.2 的 7 个不含 `aiPhotos`、`ownerPeek`）：**75**；
- 阻塞都解开（夜间自省 −6、QQ 表层 + 戳一戳 −2、回忆的感觉 −1、追求 −1、日常小事 −1）：**64**；
- 「一个生活」另 6 个验收完并进层级：**58**；再删 `aiPhotos`：57。

和减法单子「约 55」的差：审计那个数把「一个生活」10 个当成现在就能并成 1 个，把夜间自省、日常小事、QQ 表层、戳一戳、追求当成整组能合——
基线实跑证明这几组的整组合并会改快照（或改线上言行），要先有前置提交或前置决定。
