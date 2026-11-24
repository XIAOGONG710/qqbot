# 开关合并的差分核对和代码审查（2026-11-25）

审的范围：步骤 A（4f8cfaed..268279bb，16 组旧开关并进新键）和步骤 B（af089eb5..756427cf、88f11d3c、4d978d9c，app 改读新键、删掉 48 个旧字段）。
合并前的对照提交是 58aae142。没改生产代码。

## 结论

- **线上两份输入完全一致，没有差异**：11-20 的快照（`LIVE_2026_11_20`），以及再加上之后补开的 `LIVE_LATER_ON`，两份都比对过。
  66 个读处的取值在合并前（58aae142）和 HEAD 一模一样。走的是线上真实路径：Koishi 表单 → `migrateSwitches` 写回（simplify）→ 插件重启再读 → `toAppConfigInput` → `parseAppConfig`。
  19 组一轮就迁完，koishi.yml 里一个旧键都不剩；再跑一次 `migrateSwitches` 返回 undefined，说明重复跑不会再变。
  迁移后的解析结果和不迁移直接解析的一样，迁移后经控制台再保存一次（simplify）读回来也一样。
  解析出的新键：11-20 是 `oneLife=read`，加上之后补开的三项是 `oneLife=desktop`，其余 19 个新键和 `EXPECTED_LIVE` 一致。
- **步骤 B 带来的差异，全部出在「表达不了、所以没迁移」的旧键组合上**（共 17 种输入有差异）。线上快照里没有这种组合。
  步骤 A 时，这种组合照旧按旧字段跑，行为不变；步骤 B 之后 app 只读新键，这种组合就按 `fromLegacy` 折成新键：有的功能悄悄被关掉，有的被打开。
  启动日志却还在说「过渡期照旧按旧键」，这句话已经不对了（发现 1）。
- **步骤 A 本身改了几处默认行为**：只写了总开关、没写子项时，子项跟着总开关。设计文档里都写了，属于有意的合并语义，下面单列，不算 bug。
- **`?? 'off'` 那一类问题**：parseAppConfig 总会把新键补全，所以线上走不到。只有直接拼 AppConfig、不经过 parseAppConfig 的地方才会碰上，现在还剩几处没补（发现 4）。

## 怎么核对的

- 在 scratchpad 里用 `git worktree` 检出 58aae142（主工作目录没动）。另写了一个脚本，同一份 koishi.yml 输入分别在两边跑：
  - **合并前**：用 58aae142 的 `Config`、`toAppConfigInput`、`parseAppConfig`，再按 58aae142 app 读旧字段的写法算每个读处。
    这些写法就是步骤 B 各提交 diff 里的「-」行。步骤 A 期间 app、模块、宿主文件一行没动（`git diff --stat 58aae142 268279bb` 只有 config、features、switch-merge、插件、modules-doc 这几个文件）。
  - **HEAD**：走线上路径（`migrateSwitches` → `Config.simplify` → `Config` → `toAppConfigInput` → `parseAppConfig`），再按 HEAD 读新键的写法算同一批读处（diff 里的「+」行）。
  - **步骤 A 末（模拟 268279bb）**：用 HEAD 的 `mergeSwitchInput` 得出旧字段，没写的按 `SWITCH_DEFAULTS` 补，再按合并前的读法算。
    用它来区分一处差异是步骤 A 就有的，还是步骤 B 才有的。
- 一共 66 个读处，覆盖全部 16 组（19 个新键）：presence 启动和各项 flags、aboutHim、好友申请、projectChoice、lifeInPrompt、wake、读表情包、四路真实数据、B 站七处、feed、watchedFacts、感觉账的写和召回、深思和判轻重、lagTail、asks、menu、threads、三本账、recallOwn、markRead、群里戳人和点赞、戳回去、afterNo、七个主动时机、oneLife 的五处。
  环境条件（有作息和世界的卡、有长期记忆、有男朋友档、transport 什么都能做、配了看图模型）一律当成满足，只看开关。
- 输入有 40 种：线上 2 份，什么都没写 1 份，37 种人手里的 koishi.yml 可能写过的部分组合（只写旧键或者既有的总开关）。
- 脚本要用旧提交，所以没放进 `packages/bot/test/`。脚本留在 scratchpad 的 `diff/` 目录下：`decisions.mjs` 是读处表，`inputs.mjs`、`run-old.mjs`、`run-new.mjs`、`compare.mjs` 依次是输入、两边的运行器和比对。
  重跑的办法：`git worktree add --detach <dir> 58aae142`，在里面给 node_modules 建一个 junction 指向主仓库的 node_modules，然后 `node run-old.mjs <dir> old.json`、`node run-new.mjs <repo> new.json`、`node compare.mjs`。
  删 worktree 之前先 `rmdir` 掉那个 junction。
- 第 2 项（迁移和表单保存）：40 种输入全部通过。对写着的每个旧键（包括 `readStickers: false`、`feelingLedger: false` 这种值是 false 的），`Config.simplify(Config(yml))` 都原样保留；
  迁移后 `migrateSwitches` 返回 undefined，说明重复跑不会再变；迁移后的解析结果等于不迁移的解析结果，经控制台再保存一次也不变。

## 发现

| # | 组 | 输入 | 58aae142 → HEAD | 位置 | 严重度 |
|---|---|---|---|---|---|
| 1 | 全部 | 任何「表达不了、没迁移」的旧键组合（见下表） | 步骤 A 照旧按旧字段跑；步骤 B 之后按 `fromLegacy` 折成新键。启动日志仍然说「过渡期照旧按旧键」 | `packages/bot/src/platform/switch-merge.ts:262`（日志文字）；`packages/koishi-plugin-qqbot/src/index.ts:839`、`:871`（注释「行为和合并前一样」「照旧按旧键跑」） | **中**（线上不受影响；但部署前要是 koishi.yml 和 11-20 快照不一样，会悄悄改她的行为，日志还说没改） |
| 2 | herFeelings | `feltLedgerRecall: true`，`herFeelings` 没开 | 感觉账召回 true → false（步骤 A 已如此） | 旧 `app.ts` 那一处读的是 `feelingLedger && feltLedgerRecall`，**不在** herFeelings 分支里；现在是 `app.ts:1882`。`switch-merge.ts:100` 的 ignorable 和设计第二节 8 都说「唯一读处在 herFeelings 分支里」 | 低（`feltLedgerRecall` 默认关，线上也关；HEAD 的行为和 features.ts 里 `requires: ['herFeelings']` 对得上，算是顺手修了。只是注释和设计里的说法不准） |
| 3 | qqControl | `qqControl: on` + `qqFriendGate: all` | 名单外的申请：驳回 → 留着不处理 | `switch-merge.ts:65`，`modules/friend-requests.ts:24` | 低（设计里写了「all 不留、不迁移」；结果偏保守，不会多做动作） |
| 4 | qzone / bilibili / proactive | AppConfig 不经过 parseAppConfig、新键缺失（只有测试和自己拼配置的地方会这样） | 缺失被当成开着 | `social/presence-owner.ts:56`（`config.qzone === 'off'`）、`:87`（`signature: config.qzone`，presence.ts:481/497 只判 `=== 'off'` / `=== 'dryRun'`，undefined 时会**真改签名**）；`bilibili/owners.ts:118`（startBrowsing）、`:164`（日志）；`platform/app.ts:887`、`:1161`、`:1611`（proactive） | 低（合并前就是这样：旧代码在同样位置也是裸比较，88f11d3c 只补了 B 站和深思那几处。线上都经过 parseAppConfig，走不到。建议和 88f11d3c 一样补 `?? 'off'`，尤其是签名那一处） |
| 5 | factCheck / deliberation（仿真） | `sim/run.ts` 不带 `--fact-him` / 深度参数 | 仿真时 aboutHim 和判轻重还按旧的分开开关；app 现在已经跟着 factCheck 和 deliberation | `sim/runner.ts:530`、`:560`；`sim/run.ts:45`、`:150-151` | 低（只是仿真和线上对不上，不影响线上） |

### 发现 1 的明细：步骤 B 才出现差异的输入（全部是没迁移、koishi.yml 里还留着旧键的）

| 输入（koishi.yml） | 留着的旧键 | 58aae142 → HEAD |
|---|---|---|
| `proactive: on` + `proactiveReach` | proactiveReach | 邀约、问他、回来、房间、看他的反应：关 → **开** |
| `bilibili: on` + 账号 + `bilibiliDm: dryRun` | bilibiliAccount、bilibiliDm | 私信：dryRun → **真发**；评论、回复、风险监控、认识的人：关 → 开 |
| `bilibili: off` + 账号 + `bilibiliReplies: on` | bilibiliAccount、bilibiliReplies | 她的 B 站号、回复评论、风险监控：开 → 关 |
| `watching` + `biliFeed: on`，没写 bilibili | biliFeed | 刷推荐：on → off |
| `qzone: on` + `signature: dryRun` | signature | 签名：只写草稿 → **真改**；翻空间、刷好友、刷陌生人：关 → 开 |
| `qzone` 没写 + `qzoneBrowse: on` | qzoneBrowse | presence 不启动了；翻空间：开 → 关 |
| `readReceipts` 单开 | readReceipts | 打错字撤回重发：关 → 开 |
| `pokeOut` 单开 | pokeOut | 在线状态、资料卡点赞、群里点赞：关 → 开 |
| `memoryReconcile` 单开 | memoryReconcile | 设定账本、记忆账本：关 → 开 |
| `realAirQuality` 单开（realWeather 默认开） | realAirQuality | 日照、法定日历：关 → 开 |
| `herFeelings` + `feelingLedger: false` | feelingLedger | 感觉账写文件：关 → 开 |
| `lifeInPrompt` 单开（没开 autonomousLife） | lifeInPrompt | 他回来第一轮带日记（wake）：开 → 关 |
| `readStickers: false` 明写（media 默认开） | readStickers | 读他发的表情包：关 → 开 |
| `crossRecent` + `selfExport`（没开回执） | crossRecent、selfExport | 交出「此刻的她」：开 → 关 |
| `selfExport` + `selfReceipts`（没开 crossRecent） | selfExport、selfReceipts | 交出、回执、dshInbox：开 → 关（合并前 selfExport 并不需要 crossRecent，「一层包一层」是合并时新加的约束） |
| `crossRecent` + `desktopDay`（跳层） | crossRecent、desktopDay | 桌面上的时间、dshInbox：开 → 关 |
| `qqControl: on` + `qqFriendGate: all` | qqFriendGate | 见发现 3 |

设计文档（`docs/plans/2026-11-24-switch-merge-design.md`）「步骤 B 全部做完（2026-11-25）」那段已经接受了这个代价：「表达不了的组合按 `fromLegacy` 折成新键（线上快照每组都表达得了）」。所以这不是实现写错了，是下面三件事要跟上：

1. 日志文字（`switch-merge.ts:262`）和插件里的两段注释还是步骤 A 的说法，应该改成「按 X=值 跑，这几项的旧值不再起作用」。
2. 线上快照是 11-20 的。`live-switches.ts` 自己也写着「上线前要用新快照重核」。部署（迁移要用户点头）之前，应该拿当时的 koishi.yml 重跑一遍 `representable`。
   只要有一组表达不了，部署后就会照上表改她的行为，而且不会自动写回。
3. 可以考虑在 `applyNow` 里遇到表达不了的组时报错、不启动，或者至少把那句提示升成 error，免得悄悄改行为。

### 步骤 A 起就有的默认行为变化（有意的合并语义，设计里都写了）

这些在 58aae142 和 HEAD 之间不一样，但在步骤 A 末就已经这样了，属于「只写新键或都没写时，旧字段由 toLegacy 派生」的规则：

- **什么都没写**：读表情包，关 → 开（media 默认开）；空气质量、日照、法定日历，关 → 开（realWorld 默认开）。设计第二节 16 和第二节 4 都写了。
- **只写了总开关**：`proactive: on` 带上 6 个时机加 reactions；`bilibili: on` 带上账号、私信、评论、回复、风险监控、认识的人（加上 watching 还有 feed）；
  `factCheck: log` 带上 aboutHim；`qqControl: on` 时好友申请变成 allow；`autonomousLife` 带上 projectChoice、lifeInPrompt、wake；`rhythm` 带上 lagTail；
  `everydayLife` 带上 asks 和 menu（再加 worldDrama 还有 threads）；`pokes` 带上戳回去；`herNo` 带上 afterNo。
  合并前用 Koishi 表单的人，这些子项默认是关的，而且 simplify 不会把默认值写进 koishi.yml。所以只开了总开关的人，部署后会多出这些子项。
  线上这些子项本来就全开，不受影响。
- **`bilibili: on` 全开但 `stickers: off`**：stickerUncued，开 → 关。没有影响，因为 `contact.ts:302` 在没有 stickers 时根本不读它。

### 审过、没发现问题的

- **依赖链**：
  - oneLife 那几层：`desktopSource` 原来要求 `desktopDay && crossRecent`，现在要求 `at(desktop)`，而 desktop 包含 export；dshInbox 原来的两项现在要求 `at(export)`。对能表达的输入两边一致。
  - worldThreads 原来要求 everydayLife 和 worldDrama，现在还是。smallNews 原来要求 everydayLife，现在还是。
  - biliStickers 原来要求 stickers 和账号，现在要求 `bilibili` 和 `stickers`。depthRouting 原来要求 deliberate，现在是 routed 档。pokeBack 原来要求 pokes，现在跟着 pokes。
  - 主动时机原来都在 `proactive === 'off'` 那一关后面（`planner-host.ts:83`），现在还是。
- **默认值的写法**：旧的 `?? 'off'` 和 `=== true` 写法，和新键的默认值逐项对过（qzoneBrowse、qzonePeek、qzoneStrangers、realAirQuality、realDaylight、realCalendar、biliFeed、qqFriendGate），差分里只在表达不了的输入上有差异。
- **88f11d3c** 补的那几处 `?? 'off'`（owners.ts 五处，passive-jobs.ts、app.ts 四处，planner-host.ts）都对。
