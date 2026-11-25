# 2026-11-26 DSH 插件 dsh-qqbot-services 正确性与安全审查

- 范围：`dsh-plugins/dsh-qqbot-services/`（index / chat / client / companion-room / config-editor / character-bridge / local-panels / local-status / logs-view / public-memory / history-media / room-guest.* / controller / node-run / status-fallback / home-scene）、`scripts/dsh-*.test.mjs`、引用到的 `scripts/restore-stages.mjs`、`scripts/update-check.mjs`，以及核心包里的 `packages/bot/src/memory/history.ts`（`readOnly`）和 `packages/bot/src/platform/onebot.ts`（`isDesktopManualMessage`）。
- 基准：`HEAD = cd836e32`（会客室默认关那次提交）。行号都按这个提交算。审查期间另一台机器还在改 home-scene、local-status 测试等文件，没提交的改动不在本次范围里。
- 方式：只读代码，加上一次本地复现（下面第 1 条）。没有改代码，没有重载 DSH。
- 严重度：**bug**（行为错了）/ **security**（安全）/ **risk**（某些条件下出问题）/ **nit**（小问题）。

## 总表（按严重度排序）

| # | 严重度 | 位置 | 一句话 | 状态 |
|---|---|---|---|---|
| 1 | **bug（严重）** | index.js:196、506、520–522 | `summarizeWatchdog` / `summarizeRecallLog` 只做了转导出，模块里没有这两个名字，`/state` 和 `/details/logs` 每次都是 503 | 已修（a9c07f3a） |
| 2 | bug | logs-view.js:104、123；client.js:642 | 召回日志按状态筛选时比的是 `row.event`，召回行上没有这个字段，选任何筛选都得 0 条 | 已修（0ba464f0） |
| 3 | bug | logs-view.js:55；index.js:207 | 「备份：不健康/没做成/出错」不再算 `failed`，诊断报告里也会丢掉 `backup` 类事件，备份失败从诊断里看不到了 | 已修（0ba464f0） |
| 4 | bug | local-status.js:40、47 | 用「守护日志最后一行在 2 分钟内」判断守护在不在跑，但守护只在出事时才写日志；另外月、日都是一位数时 `slice(0,19)` 会切进正文，解析失败 | 已修（0ba464f0），守护重启后心跳才生效 |
| 5 | bug | local-panels.js:47–49 | 「不刷新只回本地两个提交、不碰远端」没有生效：`check.check()` 在判断之前已经跑完 `ls-remote` + `fetch` | 已修（0ba464f0） |
| 6 | risk | index.js:387–394；restore-stages.mjs:113–114 | `/backup/stage` 没有 try/catch：`switchPlan` 找不到备份时会抛错，读请求体出错也会抛，handler 的 Promise 被拒绝 | 已修（162e6923） |
| 7 | risk | restore-stages.mjs:25–38、70–110 | 「文件隔离恢复」用 `execFileSync` 跑 PowerShell 解压（最长 10 分钟）、`readFileSync` 读整份 dump，全程同步，会卡住 DSH 进程的事件循环 | 已修（162e6923），改异步 + 流式，没放进子进程 |
| 8 | risk | index.js:479–497 | 30 秒前的子进程探测结果铺在新的本地探测结果之上，旧值会盖掉新值，启动流程看到的可能是过时状态 | 已修（162e6923） |
| 9 | risk | character-editing.ts:193；character-bridge.js:16 | 保存时快照 token 可以不传，不传就跳过冲突检查；两个保存子进程之间也没有锁 | 已修（162e6923），在 bridge 里修，核心层没动 |
| 10 | risk | config-editor.js:41–44 | 用 js-yaml 默认 schema 整份 load/dump 重写 koishi.yml：注释丢失（界面有提示），日期样式的标量会被改成时间戳 | 已修（162e6923），CORE_SCHEMA + 预览核对；注释仍会丢 |
| 11 | risk | update-check.mjs:23–27、59；index.js:514–517 | 面板里跑 `git status` / `git fetch`：可能和两台 agent 的 git 操作抢 `index.lock`，凭据管理器也可能弹窗 | 已修（162e6923） |
| 12 | risk | companion-room.js:117 | 来宾的 POST 要一直等到模型回复（含排队的被叫回合）才返回，期间这个来宾发不了下一条 | 已修（162e6923） |
| 13 | nit | public-memory.js:16、120；client.js:583 | `MAX_ITEMS = 12×5`，每页 8 条时最多可到 8 页，但服务端只认到第 5 页，第 6–8 页会悄悄回第 1 页的内容 | 已修（4ae41fcc） |
| 14 | nit | local-panels.js:56；index.js:574 | 备份目录不存在时 `lstatSync` 直接抛错，前端看到的是 503「演练失败」，不是 404 | 已修（4ae41fcc） |
| 15 | nit | restore-stages.mjs:60、65 等 | 阶段结果把 `backup` 绝对路径和原始 `error.message`（可能带本机路径）原样发给面板 | 已修（4ae41fcc） |
| 16 | nit | character-bridge.js:37 | 子进程只要往 stderr 写一个字节就判失败，一条无害的 Node/Electron 警告就会让角色页整个不可用 | 已修（162e6923） |
| 17 | nit | config-editor.js:62 | 每次 apply 留一个 `koishi.yml.qqbot-<ticket>.bak`，从不清理；里面是含令牌的整份配置 | 已修（4ae41fcc） |
| 18 | nit | client.js:686 | 导出日志时 `click()` 之后立刻 `revokeObjectURL`，部分环境下载会失败（同文件 741 行已经用了延时） | 已修（4ae41fcc），无测试 |
| 19 | 测试 | scripts/dsh-*.test.mjs | 没有一个测试调用过 `apply()`，所以第 1 条测不出来；local-status 测试用的日志格式和守护真实写出的不一样；召回筛选没有测试 | 大部分补上（见文末「修复记录」） |

审过、没发现问题的部分见文末「已核对、未发现问题」。

---

## 1. bug（严重）：`/state` 和 `/details/logs` 永远 503

**位置**：`index.js:196`、`index.js:506`、`index.js:520–522`（使用处在 `index.js:433`）

```js
export { summarizeWatchdog, summarizeRecallLog } from './logs-view.js'   // :196
const events = () => summarizeWatchdog(tail(...))                        // :506
```

`export { x } from '…'` 只做转导出，不会在本模块里建立 `x` 这个局部绑定。从 `545d8eea` 把这两个函数挪进 logs-view.js 以后，`apply()` 里的 `events()` 和 `details('logs')` 每次调用都抛 `ReferenceError: summarizeWatchdog is not defined`。

**复现**：用假的 `ctx`（`webServer.register` 记下 handler，`connection.requestRejection` 返回 `undefined`）调 `apply(ctx, {})`，再请求 `GET /api/qqbot-services/state`，得到 `503 {"error":"status_unavailable"}`；`/details/logs` 得到 `503 details_unavailable`。先往 `globalThis` 塞这两个名字再跑，两个路由都回 200。复现脚本只放在临时目录，没有提交。

**后果**：`client.js:987–995` 里「聊天 / 会客室 / 她的家 / 灵魂 / 读书 / 记忆」这几个标签页都以 `state &&` 为前提，`/state` 一直 503 时这些页全是空的，总览只显示「读取失败（503），正在重试」。这和 `c8623c31`、`1e3dc489` 的提交说明里描述的「每个标签都空白」是同一个现象，但当时把原因归到了子进程探测上，所以那两次修复都没有治好它。交接日志里写的「19 个只读请求 19 个 200」，和当前 HEAD 的代码对不上，需要重新核实那次实际跑的是哪份代码。

**修复**：在文件顶部加一行局部导入，例如 `import { summarizeWatchdog, summarizeRecallLog } from './logs-view.js'`，转导出那行保留。再补一个冒烟测试：用假 ctx 调 `apply()`，断言 `/state` 和 `/details/logs` 返回 200（见第 19 条）。

## 2. bug：召回日志的状态筛选永远是 0 条

**位置**：`logs-view.js:104`、`logs-view.js:123`；`client.js:642`

召回行的结构是 `{ at, items, selected, chars, important, failed }`，没有 `event` 字段。界面上提供 `matched / no-match / not-queried / failed` 四个筛选，但 `list()` 和 `exportText()` 都用 `wanted.includes(row.event)` 过滤。只要选了任何一个，列表就是「这一组里没有记录」，导出也只剩表头。

**修复**：按来源决定比哪个字段，例如 `const key = source === 'recall' ? 'important' : 'event'`。测试补一条：`list({ source: 'recall', events: ['matched'] }).total === 1`。

## 3. bug：备份失败不再被当作失败，诊断里也看不到

**位置**：`logs-view.js:55`（新增的 `text.startsWith('备份：') ? 'backup'` 排在 `失败|不健康|出错` 之前）；`index.js:207`（`kinds` 里没有 `backup`）

守护真实写出的是 `备份：不健康——…`、`备份：没做成（…）`、`备份：QQ 通知出错（…）`（见 `services-watchdog.mjs:133/141/333`）。在 `545d8eea` 之前它们会被归为 `failed`，现在一律归为 `backup`。结果有三点：

1. 「运行异常」筛选里不再出现备份失败。
2. `diagnosticReport` 只认 `watching / recovered / starting / failed` 这四类，`backup` 事件会被整条丢掉，「复制诊断」里看不到备份出过事。
3. 正常的「备份：已通过她的 QQ 告诉用户」和失败的那几条显示成同一个「备份」。

**修复**：先判断失败关键词，再落到 `backup`。或者给备份单独分 `backup-failed` 和 `backup` 两类，并加进 `diagnosticReport` 的 `kinds`。

## 4. bug：本地探测里「自动守护」几乎总是显示未运行

**位置**：`local-status.js:40`、`local-status.js:47`

- 守护的 `say()` 只在发生事件时写日志：启动、拉起、恢复、告警。没有心跳行（`services-watchdog.mjs:42–46`、`387–389`）。服务一切正常时，最后一行可能是几个小时之前的，`now - at < 120_000` 不成立，所以显示「未运行」。
- 时间戳来自 `toLocaleString('zh-CN', { hour12: false })`，月和日都不补零。比如 `2026/1/5 08:05:03` 只有 17 个字符，`slice(0, 19)` 会切进两个正文字符，`Date.parse` 返回 NaN。已实测：`"2026/1/5 08:05:03 服"` 解析成 NaN。
- 这个函数每 3 秒的探测都会 `readFileSync` 读一遍整份日志，日志长期增长后开销会越来越大。

只要子进程探测（`detailedStatus`）成功，它的结果会盖掉这里的错误值。但 `1e3dc489` 之所以加本地探测，正是因为子进程在 DSH 里跑不起来；子进程失败时，用户看到的就是这里的错误值。

**修复**：判断守护进程是否存活要换信号，比如让守护每 N 秒写一个心跳文件或 pid 文件；或者本地探测干脆不判断守护，返回 `null`，界面显示「未知」。解析时间戳要用正则 `^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{2}):(\d{2}):(\d{2})` 取出各段再构造 Date，不要用固定宽度切片。读日志改用 index.js 里已有的 `tail()`。

## 5. bug：「版本状态」每次打开都会访问远端

**位置**：`local-panels.js:47–49`

```js
const result = await check.check()            // 已经跑了 ls-remote + fetch + status + merge-base…
if (query?.get('refresh') !== '1') return { local: result.local, tracked: result.tracked }
```

注释说「不刷新时只回本地已知的两个提交，避免每次都碰远端」，但判断放在 `check()` 之后，判断之前远端已经访问过了。所以每次打开「系统」标签都会对 GitHub 做一次 `ls-remote` 和 `fetch`，写入 FETCH_HEAD，单次超时可能长达 15 秒。

**修复**：不刷新时只跑 `rev-parse HEAD` 和 `rev-parse refs/remotes/origin/main`（或者给 `createUpdateCheck` 加一个 `localOnly` 参数），不调用 `check()`。

## 6. risk：`/backup/stage` 的异常没有被兜住

**位置**：`index.js:387–394`；`restore-stages.mjs:113–114`

其他会读请求体的路由都包了 `try { … } catch { send(503) }`，只有这一个没包。下面两种情况会让 handler 返回的 Promise 被拒绝，交给 DSH 的 web server 处理，结果可能是请求一直挂着、只记一条未处理的 rejection，或者更糟：

- `stage: 'switch'` 会调用 `switchPlan(day)`，其中 `directory(day)` 在备份不存在时直接 `throw`。只要日期格式合法、但当天没有备份就会触发。
- `readJson` 在客户端中途断开时，`for await` 会抛错。

**修复**：和其他路由一样包一层 try/catch。`switchPlan` 找不到备份时返回 `{ ok:false }`，不要抛错。

## 7. risk：分阶段恢复在 DSH 进程里同步跑长任务

**位置**：`restore-stages.mjs:25–30`（`execFileSync` 跑 PowerShell `Expand-Archive`，超时 10 分钟）、`:32–38`（`head()` 和 `digest()` 都用 `readFileSync` 读整个文件，`head` 为了 5 个字节读完整份 dump）、`:96`（`cpSync` 复制整份 dump）

这些阶段通过 `index.js:394` 直接在插件所在的 DSH 进程里执行。整个过程都是同步的，期间 DSH 的所有 HTTP 请求（包括面板本身）和定时器都停住；dump 有几百 MB 时，还会在 DSH 进程里额外占用同样大小的内存。演练（`restoreDrill`）已经放进子进程，只有这里没有。

**修复**：和 `restoreDrill` 一样放进子进程（`node scripts/restore-stages.mjs --stage … --day …`），或者至少改用异步的 `execFile`，并用流式读取算摘要和读文件头。另外给阶段加和 `drilling` 一样的防重入标志。

## 8. risk：过时的子进程探测结果盖掉新的本地探测

**位置**：`index.js:479–497`

`{ ...await localStatus(), ...(detailedStatus() ?? {}) }` 把最多 30 秒前（再加上最长 20 秒的执行时间）的子进程结果铺在刚测出来的本地结果上面。`controller.run()` 在启动服务后每 2.5 秒调用 `status(true)` 判断服务是否就绪，这时：

- 旧的 `napcat:false` 会把新测到的 `true` 盖掉，等待时间被拉长。
- 反过来，旧的 `true` 也可能让本来没就绪的服务被当作「已运行，跳过启动」。

另外，子进程一直失败时，每 30 秒会往 `panel-probe.log` 追加一行，没有上限。

**修复**：本地能直接测的字段（napcat、hindsight、koishiListening、maintenance）以本地结果为准，子进程结果只补本地测不到的字段（launchers、koishiProcesses、lastConnection、watchdog）。也就是把展开顺序反过来，或者逐个字段合并。

## 9. risk：角色资料保存可以绕过冲突检查，并发保存会互相覆盖

**位置**：`packages/character-tools/src/character-editing.ts:193`；`character-bridge.js:16`

`if (token !== undefined && token !== now)`：token 不传，就完全不做快照比较。bridge 允许请求体里没有 token，所以任何不带 token 的 `/character/save` 请求都会直接覆盖 `source/` 和 `st/`。面板前端总会带 token，但服务端不该依赖前端。另外，每次保存是一个独立的子进程（冷启动约 0.6 秒），两次几乎同时的保存会都通过 token 检查，然后先后写文件，最后一次覆盖前一次，两边的回滚日志也可能交错。

**修复**：bridge 对 `save` 要求必须带字符串 token。在 bridge 里给 save 加进程内的串行队列（同一时间只跑一个 save 子进程）；或者 CLI 写入时用 `wx` 方式创建锁文件。

## 10. risk：整份重写 koishi.yml 可能改动无关配置

**位置**：`config-editor.js:41–44`

`yaml.load()` 用的是 js-yaml 默认 schema：`2026-11-01` 这样不加引号的日期会被读成 Date，再 `dump()` 出去就变成 `2026-11-01T00:00:00.000Z`；锚点、别名会被展开。界面的确认框只提醒了「排版与注释会重新生成」。目前的配置里未必有这类值，但这条写入路径会碰到所有插件的配置。

**修复**：读写都用 `{ schema: yaml.JSON_SCHEMA }`（或 CORE_SCHEMA）。更稳妥的做法是只替换 `plugins['qqbot:…']` 下的 `contacts` 和三个模式字段（比如换用保留注释的 `yaml` 库的 Document API）。另外在 preview 阶段对比 dump 前后，确认只有被编辑的字段变了，再签发 ticket。

## 11. risk：面板里跑 git 会碰到锁和凭据弹窗

**位置**：`update-check.mjs:23–27`、`:59`；`index.js:514–517`

- `git status --porcelain` 会顺手刷新 index，需要短暂拿 `index.lock`。两台 agent 都在这个仓库里频繁 `pull --rebase` 和 `commit`，碰巧撞上时，对方会收到 `index.lock exists` 错误。
- `git fetch origin` 在没有缓存凭据时，Git Credential Manager 可能从 DSH 进程弹出 GUI 窗口，`windowsHide` 挡不住这个窗口。

**修复**：`runGit` 统一加 `--no-optional-locks`，环境变量设 `GIT_TERMINAL_PROMPT=0` 和 `GCM_INTERACTIVE=never`。再加上第 5 条的修复，只有点了「检查远端」才去 fetch。

## 12. risk：来宾发言的请求要等模型回复才返回

**位置**：`companion-room.js:117`

`post()` 用 `await consider(...)` 等模型回复：单次请求最多 12 秒；如果这期间又有人 `@林梦瑶`，`requested` 会接着在同一个循环里排队处理。来宾页（`room-guest.js:63–67`）在这段时间里 `posting = true`，发不了下一条，最后还可能因为请求超时显示「未能确认送达」。消息其实早就进了房间，这个提示是误导。

**修复**：消息写入房间后立即返回 200，用 `void consider(...)` 在后台处理回复，回复照样通过轮询 `messages` 显示出来。

## 13. nit：公共记忆翻页上限前后不一致

**位置**：`public-memory.js:16`（`MAX_ITEMS = 12 × 5 = 60`）、`:120`（`rawPage <= MAX_PAGE (5)`，超出就回 1）；`client.js:583`

面板每页 8 条。召回结果有 41–60 条时，界面算出 6–8 页，但服务端请求第 6 页时会回第 1 页的内容，前端照样把页码设成 6，于是页码和内容对不上。

**修复**：服务端用 `Math.ceil(MAX_ITEMS / limit)` 作为页数上限。或者把条数截断到 `limit × MAX_PAGE`，`total` 也按截断后的数算。

## 14. nit：备份不存在时返回 503，不是 404

**位置**：`local-panels.js:56`；`index.js:574`

`lstatSync(backup)` 在目录不存在时直接抛 ENOENT，`restoreDrill` 里应有的 `return 404` 走不到，被外层 catch 变成 503 `restore_drill_failed`，详情页的 restore-check 也一样。

**修复**：`lstatSync(backup, { throwIfNoEntry: false })`，返回 undefined 时 `return null`。

## 15. nit：阶段结果里带本机绝对路径和原始错误文本

**位置**：`restore-stages.mjs:60`（`backup` 是绝对路径）、`:65`、`:83`、`:106`（`error.message`，fs 错误里带完整路径）；`client.js:806` 会把它原样显示出来

接口只有本机房主能访问，影响不大。但其他模块都坚持「错误正文不外传」，这里不一致。如果有人把截图或「复制诊断」转发出去，本机路径就跟着出去了。

**修复**：返回固定的错误码，原始 message 只写本机日志。`backup` 改成只给 day。

## 16. nit：stderr 有任何输出就判失败

**位置**：`character-bridge.js:37`

`--import tsx` 在 Electron 跑成 Node（`ELECTRON_RUN_AS_NODE`）或者 Node 升级时，可能输出一行 ExperimentalWarning 或 DeprecationWarning。按现在的写法，角色页会整个读不出来，原因也不会显示。

**修复**：只看退出码和 JSON 能不能解析。stderr 截取前几百字节写进 `panel-probe.log` 备查（注意脱敏），不作为失败依据。可以考虑加 `--no-warnings`。

## 17. nit：配置备份文件只增不删

**位置**：`config-editor.js:62`

每次 apply 都在 koishi.yml 旁边留一份 `koishi.yml.qqbot-<ticket>.bak`，内容是整份配置，可能含 OneBot 令牌、API key 等；从来不清理。在 Windows 上 `mode: 0o600` 不起作用。

**修复**：只保留最近 N 份，比如 5 份，或者统一放进 `runtime/` 下的单独目录。

## 18. nit：日志导出时 object URL 释放得太早

**位置**：`client.js:686`

`link.click()` 之后立刻 `revokeObjectURL`，在 Firefox 等环境里下载可能失败。同一个文件 741 行已经用了 `setTimeout(…, 1000)`，这里改成一样的写法即可。

## 19. 测试有没有测到它声称的内容

- **apply() 完全没有覆盖**：所有 `dsh-*.test.mjs` 都直接调 `createHandler(...)`，自己传入 `events` 和 `details`。真实 `apply()` 里的接线（第 1 条的漏导入、`details('logs')`、`companion` 的组装）一行都没有执行到，所以 `test:scripts` 全部通过，第 1 条照样测不出来。**建议**：加一个冒烟测试，用假的 `ctx.webServer`、`ctx.connection`、`ctx.on` 调 `apply(ctx, { repoRoot: 临时合成仓库 })`，对 `/state`、`/details/logs`、`/logs/list` 断言 200。
- **dsh-local-status.test.mjs**（HEAD 版本第 25、53 行）：用的日志格式是 `2026-11-26 00:20:00 tick`，而守护真实写的是 `2026/11/26 0:20:00 …` 这种不补零的斜杠格式，而且守护不写 tick 行。测试按自己假设的格式通过了，第 4 条的两个问题它都覆盖不到。（工作区里另一台机器正在改这个文件，改成了 `localStamp(...)`，要确认新的 helper 用的是真实的 `toLocaleString('zh-CN', { hour12: false })` 格式，并且有一条日期是一位数月、日的用例。）
- **dsh-logs-view.test.mjs**：「按状态筛选」只测了 operations，召回筛选（第 2 条）没有测；测试数据里的 `备份：完成` 是成功行，没有失败的备份行，所以第 3 条的回归也测不出来。
- **dsh-local-panels.test.mjs「only the owner can … dispatch a date-scoped isolated drill」**：`restoreDrill` 是测试替身，没有覆盖到真实实现里 `restore-check` 抛 ENOENT 变成 503 的路径（第 14 条）。
- **dsh-update-check.test.mjs**：测的是 `check()` 本身。`local-panels` 里「不刷新不碰远端」这个分支没有测试，所以第 5 条没被发现。建议用一个会记录调用参数的 `runGit` 替身，断言不刷新时没有出现 `ls-remote` 和 `fetch`。
- 其余测试（会客室隔离、LAN 只暴露房间路由、确认码一次性和摘要绑定、history-media 白名单、公共库投影、恢复阶段的隔离与清理）断言的内容和测试名一致，没有发现「测试名说的和实际断言的不符」的情况。

---

## 已核对、未发现问题

- **认证顺序**：`createHandler` 先过 `allowedRequest`（回环地址、Host、Origin、不能带转发头、`sec-fetch-site` 不能是 cross-site、POST 必须带自定义头），只放行来宾房间路由，然后就是 `authenticatedBrowser`（`requestRejection`）。其余所有房主路由（场景资源、房主房间、home、character、config、memory、logs、details、sticker、chat、backup、state、start）都在它之后。`room_disabled` 也在认证之后，来宾路由在房间关闭时不存在。
- **LAN 来宾监听**：`createLanGuestHandler` 只把 `/room/guest/` 交给 `roomRoute(..., owner=false)`；Host 精确匹配，POST 必须带同源 Origin 和自定义头；`invite`、`close` 只在 owner 分支里。来宾凭证是 24 字节随机数（32 位 base64url），邀请 15 分钟、一次有效，房间满员时不消耗邀请。`join` 是同步执行的，不存在并发重复兑换。
- **请求体**：JSON 上限 16 KB，`content-type` 必须是 `application/json`，解析失败返回 400；上传必须是 `application/octet-stream`，上限 512 KB，并且先检查成员身份再读请求体。
- **路径穿越**：day 是 `^\d{4}-\d{2}-\d{2}$`，sticker id 是 12 位十六进制，聊天媒体 id 是 43 位 base64url，房间媒体 id 是纯数字，场景资源走 Map 白名单。sticker 先 `lstat` 排除符号链接、检查大小、比对文件头签名；index.json 里的文件名必须和 id 对应。
- **媒体类型**：房间媒体、聊天媒体都按 `sniffMime` 实测的类型下发（只有 png、jpeg、webp、gif 和几种音频，没有 svg 或 html），并带 `nosniff`。QQ 媒体只从四个 QQ 的 HTTPS 域名拉取，`redirect: 'error'`、5 MB 上限、5 秒超时，id 用 HMAC 生成、5 分钟过期。
- **XSS**：client.js 全部用 `React.createElement` 渲染，没有 `dangerouslySetInnerHTML`。room-guest.js 只用 `textContent` 和 `createElement`。没有任何 `innerHTML`。
- **CSP**：来宾页是 `default-src 'none'; script-src 'self'; img-src blob:; media-src blob:; frame-ancestors 'none'`，场景页是 `frame-ancestors 'self'`，都合理。
- **NapCat WebSocket**：`exchange()` 在成功、失败、超时、`error`、`close` 各条路径都只结束一次，并且清掉计时器、关闭 socket；只认对应 `echo` 的回包，读操作有白名单。
- **手动代发**：确认码是一次性的，2 分钟过期，摘要绑定了 cookie、key、accountId、text；发送时在同一个 socket 上重新核对登录账号；房主 QQ 在启动后变了就拒绝发送。
- **`history.ts` 的 `readOnly`**：`readOnly` 时不 `flushIncoming`、不迁移旧撤回状态、不缓存，面板每次都新建 `ChatHistory`，不会改写线上数据。唯一的副作用是构造函数里的 `mkdirSync(chats)`，调用方已经确认过该目录存在。
- **`isDesktopManualMessage`**：要求 `sender === selfId` 并且文本以前缀开头，别人不能伪造；backfill、引用、转发三处都接上了。`renderForward` 只有 quoted-context 一个调用方，并且传了 `selfId`。
- **Windows**：`launchService` 在 `spawn` 返回后才关闭日志 fd，这时句柄已经传给子进程，没问题。`nodeCommand` 在 Electron 下会设置 `ELECTRON_RUN_AS_NODE`。我还实测了 `child.stdin.end()` 在子进程不存在或提前退出时会不会让 DSH 进程崩溃：没有崩溃。

---

## 修复记录（2026-11-26，第 2–18 条）

每条都先写了在旧代码上失败、修好后通过的测试（第 18 条是浏览器下载行为，没有测试）。`npm run test:scripts` 全绿，`scripts/dsh-offline-acceptance.mjs` 通过。没有改 TypeScript，没有重载 DSH、没有重启线上服务。

| # | 提交 | 怎么修的 | 测试 |
|---|---|---|---|
| 2 | 0ba464f0 | 召回来源按 `important` 筛选，列表和导出共用 `kindOf` | dsh-logs-view：召回筛选 |
| 3 | 0ba464f0 | 备份行先看失败词（失败 / 不健康 / 出错 / 没做成 / 没发出去）归 `failed`，其余才是 `backup`；`diagnosticReport` 也收 `backup`（显示「有记录」） | dsh-logs-view：失败备份行 + 诊断 |
| 4 | 0ba464f0 | 守护每次检查前写 `runtime/services-watchdog.heartbeat.json`（`{ pid, at }`，`scripts/watchdog-heartbeat.mjs`）；面板看 pid 还在、心跳 20 分钟内（一次检查可能被备份拖 15 分钟）。没心跳（守护还是旧版）时日志 2 分钟内有一行算在跑，否则是 `null`，面板显示「状态未知」，控制器接受 `null`。时刻逐段解析，只读日志末尾 4 KB | dsh-local-status：真实格式（一位数月日）、心跳新旧、pid 已死、没心跳时的 null |
| 5 | 0ba464f0 | `createUpdateCheck().known()` 只跑两次 `rev-parse`；不刷新时在 `check()` 之前就返回 | dsh-local-panels：记录 runGit，不刷新时没有 ls-remote / fetch |
| 6 | 162e6923 | 路由包 try/catch（503 `restore_stage_failed`）；`switchPlan` 找不到备份回 `{ ok:false }`，路由 404 | dsh-restore-stages：缺备份 404、请求体断开 503、阶段抛错 503 |
| 7 | 162e6923 | 解压改异步 `execFile`，dump 头只读 5 字节，摘要流式，复制用 `copyFile`；路由同一时间只跑一个阶段（409 `stage_busy`）。没有放进子进程：异步以后事件循环不再被卡住，`verifyRestoredState` 仍是同步的，但它只读解出来的小文件 | dsh-restore-stages：解压未完成时事件循环照转、流式摘要与整读一致 |
| 8 | 162e6923 | `mergeStatus`：本地测得到的字段以本地为准，子进程只补 `net / koishiProcesses / lastConnection / launchers`，守护本地是 `null` 时才用子进程的；探测日志同一原因只记一行 | dsh-local-status：mergeStatus |
| 9 | 162e6923 | bridge 里 `save` 必须带字符串 token，不带不起子进程；保存排队串行。核心 `character-editing.ts` 没改（Koishi 控制台也在用它） | 新增 dsh-character-bridge：无 token、并发不重叠、失败不堵队列 |
| 10 | 162e6923 | 读写都用 `CORE_SCHEMA`；签 ticket 前按默认 schema 比较，除了编辑的字段别的都相同才放行（否则 422 `config_roundtrip_unsafe`）。注释和排版仍会重新生成（界面已有提示） | dsh-config-editor：不加引号的日期、锚点 + `<<` 合并键 |
| 11 | 162e6923 | `panelGit`：`--no-optional-locks`，`GIT_TERMINAL_PROMPT=0`、`GCM_INTERACTIVE=never` | dsh-local-panels：panelGit 参数与环境 |
| 12 | 162e6923 | `post()` 写进房间就回 200，回复循环在后台跑（`room.idle()` 供测试等待），generation 守卫不变 | dsh-companion-room：模型没回时 POST 已返回、同一来宾可接着发 |
| 13 | 4ae41fcc | 页数上限改成 `ceil(60 / limit)` | dsh-public-memory：每页 8 条翻到第 8 页 |
| 14 | 4ae41fcc | `lstatSync(..., { throwIfNoEntry: false })`；`/details/restore-check` 回 404 | dsh-local-panels：缺备份 404 |
| 15 | 4ae41fcc | 阶段只回固定错误码，原始 message 写 `panel-probe.log`；回 `day` 不回绝对路径，保留目录给相对路径；面板把错误码翻成中文 | dsh-restore-stages：结果里没有本机路径 |
| 16 | 162e6923 | 只看退出码和 JSON；stderr 脱敏后记前 400 字节；加 `--no-warnings` | dsh-character-bridge：stderr 警告不失败 |
| 17 | 4ae41fcc | apply 成功后只留最新 5 份 `koishi.yml.qqbot-*.bak`，别的文件不碰 | dsh-config-editor：清理 |
| 18 | 4ae41fcc | 隔 1 秒再 `revokeObjectURL` | 无（浏览器行为） |

补充两点：

- 第 4 条原文举的 `2026/11/26 0:20:00` 不对：Node 的 `toLocaleString('zh-CN', { hour12: false })` 小时补零（`2026/1/5 08:05:03`、`00:05:03`），只有月、日不补零。解析时小时按一到两位都接受。
- 心跳要等线上守护重启后才会写；重启线上服务要用户点头，这次没有做。重启前面板看不到心跳，按日志判断，最差显示「状态未知」。

