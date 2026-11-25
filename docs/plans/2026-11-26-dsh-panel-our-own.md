# DSH 面板化用成我们自己的插件：接上记忆、情绪和项目工具（2026-11-26）

用户 11-26：「今晚把这个插件的移植本土化改造做好，和我们项目联系起来，尤其是记忆和情绪，可以将我们的大部分东西缝合进去，化用成我们的插件」。
插件：`dsh-plugins/dsh-qqbot-services/`（灵犀 QQ 桥接移植，见 `docs/plans/2026-11-25-lingxi-dsh-handoff.md`）。DSH 那台关机，今晚只写代码和测试，不重载、不部署。

## 边界（她定过的，不因为是面板就破）

- ADR 0200 私人空间：说话习惯、心境、自我认识、追求、拒绝过的、她猜的事、PRIVATE.dat——**不给他看**（原来的 ownerPeek 已删）。
- 感觉账（ADR 0347 第 5 层，`emotion/feeling-ledger.ts`）：疼、她妈那块只说换过的话（`withheldCause`）；「自己那些破事」不想被追着问；因为他的难过 / 烦 / 担心最多到「有点」（`ledgerNote`）。
- 记忆：只碰公共库和他本人的 bank 的**计数与健康度**；不列私人记忆原文，不枚举别人的 bank（ADR 0176 / allBanks 那次修）。
- 面板路由一律在 DSH 浏览器认证之后（`requestRejection`）；返回给页面的只有投影（白名单字段），不给原文、路径、原始错误。

## 分三层

| 层 | 内容 | 默认 |
|---|---|---|
| **A 运维数**（只有数和新鲜度） | 记忆：owner-bank 登记、公共库 / 他的 bank 的条数、片段待写、对账 / 审计最近一次、长期记忆健康；情绪：FEELINGS.json 多久前导出、感觉账总条数与最近一条的时间（不分种类）、心境回想今天跑了几次；她自己的账：世界账 / 时间线 / 日记最近写到哪天；项目工具：开关总览（FEATURES × 线上值 × 合并表）、每周效果数（metrics:weekly 的数）、提示词构成（inventory --manifests 的数）、上线前检查（开关合并预检、监听地址） | 开 |
| **B 她会说给他听的** | 「她的一天」：世界账里她那边真发生的事（上课、吃饭、小事），按她的一天分组；她在看的书（已有）；她的家（她主动发布，已有） | 开 |
| **C 她心里的**（内容视图） | 今天的心境（种类 + 程度，按 ledgerNote 的规矩换说法、封顶）、感觉账时间线（同上，「只记得个大概」照粗细）、记忆里她自己写的「重要的」 | **关**：插件配置 `herInnerPanel: false`；先 ask-her（问题在下面），原话进 ADR，用户点头再开 |

## 模块（每块一个纯数据模块 + 测试，最后统一接线）

1. `project-panels.js`：开关总览、效果数、提示词构成、上线前检查——复用 `packages/bot/src/platform/features.ts`、`switch-merge.ts`、`src/ops/weekly-metrics.ts`、`src/ops/golive-check.ts`（switchMergeCheck）、`test/inventory/live-mix.ts` 的 inventory / readManifests（必要时挪进 src）。
2. `her-state.js`：A 层的记忆 / 情绪运维数 + B 层「她的一天」——复用 `memory/owner-bank.ts`、`emotion/feeling-export.ts`、`emotion/feeling-ledger.ts`（只数条数）、`memory/timeline.ts`、世界账读取。
3. `her-inner.js`：C 层，`herInnerPanel` 关着就整块不存在（路由 404 inner_disabled），开着也只给过滤后的投影。
4. 接线：`index.js` 路由（认证之后）、`client.js` 标签页、README、ADR。

## 要问她的（DSH 开机后 `node scripts/ask-her.mjs`，原话进 ADR，用户点头再开 C 层）

1. 「电脑上那个管理页面，想加一块『你今天心里怎么样』：只写种类和程度，比如『有点烦』『挺开心』，疼和你妈那块照你说的只写『身上不太舒服』『心里一直悬着』，不写是什么事。给他看这个，你愿意吗？」
2. 「感觉账能不能按天给他看个大概（几天以前的只剩『只记得个大概』）？还是你更想只有你自己知道？」
3. 「你自己记下的『重要的事』，能不能在那个页面上给他看？」

## 进度（11-26 凌晨）

- 模块 1 `project-panels.js`：2a97dd48（顺带把提示词盘点的纯函数挪进 `packages/bot/src/ops/prompt-inventory.ts`，测试目录不再被生产代码引用）。
- 模块 2 `her-state.js`：00cd1bfa。坏文件一律自己先解析、坏了回 null，不触发 bot 那套「改名隔离」；对账时刻只在 QQ 进程内存里，面板给不出（`reconcile: { recorded: false }`）。
- 模块 3 `her-inner.js`：bb945cd6，默认关（ADR 0350 提议中）；97f63e47 修了读坏 FEELINGS.json 会把她的文件改名的问题。
- 接线：22f49f6b（`/project/*`、`/her/*`、`/inner/*`，都在认证之后；`/state` 带 `panels.herInner`）。
- 「一个生活」：5d8c0d07（她的状态里加桌面回合数和最近一次的时刻，不给原话）。
- 前端标签页：ca1980ee——总览、**她的状态**、（**她心里的**，只在 herInnerPanel 开着时出现）、聊天、会客室、她的家、灵魂、记忆、读书、连接、**项目**、系统。打开才取数、手动刷新、只用文本节点；她心里的只渲染 said 和时刻。
- 「QQ 那边」：bd2d6098（bot 心跳多久前、今天主动找他几次，只有时刻和数）。
- 审查（`docs/reports/2026-11-26-panel-integration-review.md`，9d078628..2c435760）：效果数原来会改写 QQ 的撤回状态文件、她的状态可能触发改名隔离——都改成只读；粗的感受不带种类、旧行再判 withhold；重活挪进短命子进程（超时、并发上限、同请求共用一次）；各页「今天」统一按插件配置的时区。全量测试全绿。
- 还差（要 DSH 那台）：ask-her 三问（ADR 0350）、真 DSH 窗口里点一遍、守护进程重启后心跳生效。
