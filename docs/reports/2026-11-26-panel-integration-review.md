# 面板化用（今晚接线）审查：发现和修复（2026-11-26）

- 范围：计划 `docs/plans/2026-11-26-dsh-panel-our-own.md` 今晚的接线——`project-panels.js`（2a97dd48）、`her-state.js`（00cd1bfa、5d8c0d07、bd2d6098）、`her-inner.js`（bb945cd6、97f63e47）、`index.js` 路由（22f49f6b）、`client.js` 标签页（ca1980ee），以及对应的 `scripts/dsh-*.test.mjs`。
- 只改了 `dsh-plugins/dsh-qqbot-services/` 和 `scripts/dsh-*.test.mjs`；`packages/bot` 一行没动（行为基线不受影响）。DSH 关机，没有重载、部署、重启。

## 发现与修复

### 写了线上数据（最要紧）

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| W1 | project-panels.js `metrics()` → `weekly-metrics.ts loadMetricsData` | 它用 `ChatHistory.load(id)`，**不带 `readOnly`**。遇到旧格式（数组）的 `chats/<QQ>.recalled.json` 会当场迁成 v2 写回去——面板进程在替 QQ 进程改线上数据，两边还可能同时写。本机复现确认会改写。 | 子进程里用只读版加载（`panel-job-child.js readOnlyMetricsData`，`history.load(id, { readOnly: true })`，跳过链接和超大文件）；测试里放一份 `[3]`，跑完原样。 |
| W2 | her-state.js 记忆 / 情绪 / 日记 | 先 `peekJson` 看一眼，再调 bot 的 `readOwnerBank` / `loadReviewState` / `loadSelfDiary` / `readSavedFeelings`（默认都是「坏了就改名隔离」的读法）。两次读之间文件变了，或者第二次读碰上非临时的 IO 错误，面板就会把她的文件改名成 `.corrupt-*`。 | 只解析一次，照 bot 的认法取那几个字段；`readSavedFeelings` 改用 `{ invalid: 'throw' }`。 |

### 隐私

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| P1 | her-inner.js `ledger()` | 粗的那几条（90 天以前）`said` 只写「只记得个大概」，但接口里的 `label` 还带着种类（「难过」）。页面不显示，接口却给了。 | 粗的 `label` 一律 null。 |
| P2 | her-inner.js `ledger()` | 只认账里写着的 `withhold`。旧行、手改过的行没这个字段时，疼和她妈那块会按原种类原程度说出来（「很累」），和 `today()`（按来由判）不一致。 | 没写就按来由再判一次（`withholdOf`）；判出来的照样只说换过的话、不带种类和时刻。 |
| P3 | her-inner.js | `FEELINGS.json`、`feeling-ledger.jsonl` 没查是不是链接、多大：会跟着链接读到灵魂目录以外，或者在主线程上读一个很大的文件。 | 是链接、或超过 2 MB / 16 MB 都当没有。 |
| P4 | 子进程回来的数据 | 新增的子进程路径要守同一条线。 | 子进程只回数；父进程再按原来的白名单过一遍（`numbersOnly`、标识符过滤、日期正则）；失败只回固定错误码（`panel_job_failed` / `_timeout` / `_output`），stderr 直接丢掉；给子进程的配置收窄成「数据目录、时区、他是谁」，联系人名单、模型、密钥不进子进程。 |

核对过、没问题的（加了测试固定下来）：`/project` `/her` `/inner` 都在 `authenticatedBrowser` 之后，认证接口抛错也按没过处理；局域网来宾监听只认 `room/guest/`，这三块一律 404；`herInnerPanel` 没开时 `createHerInner` 不建、`/inner/*` 回 `inner_disabled`，什么都不读；三块的异常分支只回固定错误码，不带路径和原文。

只记一笔、没改的：「她的一天」里 `interact_npc` / `leisure` / `work_on_project` 的 subject 原样进说法（B 层「她会说给他听的」，和 QQ 状态行同一套）；提示词构成的标识符过滤允许 `.` `:` `/`，主机名一样的串能过，但这些名字来自 bot 自己的代码。

### DSH 主线程

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| R1 | 效果数、提示词构成、她的状态 | 整份聊天记录、所有清单、几本几十 MB 的账都在 DSH 主线程上同步读和算；效果数的检测器跑整份记录，能卡好几秒。 | 新增 `panel-jobs.js` + `panel-job-child.js`：经 `node-run.js nodeCommand` 起短命子进程（`--import tsx`，同 character-bridge），JSON 进 JSON 出；有超时（效果数 120 秒，其余 90 秒，到点杀掉）、stdout 上限 8 MB、同时最多 2 个。同键的并发请求共用一次计算；效果数和提示词构成保留 10 分钟缓存，她的状态一次子进程算五块（记忆、情绪、她的账、QQ 那边、今天），5 秒缓存，标签页同时打开的 5 个请求只起一个子进程。 |

开关总览、上线前检查只读配置，仍在进程内；她心里的文件小、有上限、默认关，仍在进程内。

### 正确性

| # | 位置 | 问题 | 处理 |
|---|---|---|---|
| C1 | 效果数窗口 | 「到昨天为止」和按天分组都用 DSH 进程的时区，只在页面上提示「不一致」。bot 用配置的 `timeZone`（ADR 0331）。 | 子进程 TZ 设成配置的时区（没写就 Asia/Shanghai），「昨天」也按它算；`zone` 改成 `{ used, configured }`，页面写「日界按 X」。 |
| C2 | her-inner.js 她的一天 | `herDayKey`、钟点用进程时区，her-state 用配置的时区：两个标签页对「今天」可能差几个小时。 | 改按配置的时区（`index.js` 每次从 koishi.yml 取）。 |
| C3 | her-state.js 心境回想次数、她自己写的日记 | `attempts.day` 是 bot 按它的时区写的日历日，面板拿自己进程时区的 `dayKey` 比；日记的日子同理。 | 都按配置的时区算；测试里把进程时区临时设成洛杉矶验证。 |
| C4 | 页面 | 数缺（null）时排序、百分比可能出 NaN；延迟秒数不取整。 | 加了兜底和取整。 |

核对过、没改的：02:00 换天的边界（`herDayOf`）对；主动消息按她的一天数，`sent` 算发了，`dryRun` / `skipped` / `failed` 算试了，未来的不算。bot 自己的 `herDay` 按作息里的睡觉时刻换天，面板固定 02:00（计划里定的）。

## 新文件

- `panel-time.js`：配置时区、她的一天、日历日加减（三块共用）。
- `panel-jobs.js`：子进程运行器（超时、上限、排队）和 `sharedJob`（同键共用 + 短缓存）。
- `panel-job-child.js`：子进程里的三个 job（metrics / inventory / her），只读。
- `scripts/dsh-panel-jobs.test.mjs`。

## 验证

- `npm run test:scripts`：219 个，218 过、1 个原本就跳过、0 失败。
- `npm run typecheck` 通过；`node scripts/dsh-offline-acceptance.mjs` 通过。
- 新测试：只读（旧格式撤回状态不被改写）、并发共用和缓存、失败不缓存、子进程超时 / 输出过大 / 退出码、排队、子进程版和进程内结果一致、配置收窄、时区（檀香山、洛杉矶）、粗的不带种类、旧行再判 withhold、链接和大文件、路由认证和局域网监听。

## 等 DSH 开机再看

- 在真 DSH（Electron + `ELECTRON_RUN_AS_NODE`）里点一遍「她的状态」「项目」，确认子进程起得来、真实数据量下多久出数（机制和角色页的 character-bridge 一样）。
