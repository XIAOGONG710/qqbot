# Super-agent 架构档案（dsh-superagent 原型蒸馏）

来源：dsh-superagent-prototype v0.1.0（MIT）

归档对象：`the official prototype clone (deepseek-ai/dsh-superagent-prototype, MIT)`（git `8c32a9d`，MIT，`README.md` 自述为“research prototype for reference only”）。

用途：给 Lead 落地 Super-agent 时的实现规格。凡标注「原型未实现」处，是论文方向但代码里没有的东西，不要当成既有能力；凡标注「源码」的，行号对应当前 checkout，可直接抄。

参考文档（按原型自己的阅读顺序）：`docs/000-philosophy.md`（注意力宪法）→ `001-domain.md`（领域）→ `002-authorization.md`（授权）→ `003-execution.md`（执行）→ `004-prompts.md`（提示词）→ `005-panel.md`（面板）→ `006-deployment.md`（部署）→ `007-architecture.md`（实现索引，617 行）→ `008-cookbook.md`（新增 Source 的完整示例）。

---

## 0. 一句话定位与五个模块

**一句话**：把「某个人在某个来源里发的一条消息」经**确定性准入**判定成一张**带授权范围（Mandate）的工单（Ticket）**，交给一个**持久在线的 Executor Session** 在**自己的目录**里做完，再把结果回到原对话；**Router 只做路由与交付判断，永不做技术决策**。

| # | 论文模块 | 原型里的落地 | 主要代码 | 状态 |
|---|---|---|---|---|
| 1 | 双层 Router / Worker | Main Session（`orchestrator`，preset `dsh-superagent-router`）+ 每 Ticket 一个 Executor Session（`worker-<ticketId>`，preset `dsh-superagent-worker`）；工具集、模型、提示词全部按角色分离 | `src/app/sessions.ts:48,138-155`；`src/executor/dsh.ts:24,424-470`；`cordis.patch.yml:20-193` | ✅ 完整 |
| 2 | 事件驱动 Trigger | Source 插件产出不可变 `Trigger` → `Engine.receive` 落库并按 Thread 扇出/入队 → `Passes` 2 s 一拍驱动 Eval 与持久化副作用队列 `Effects` | `src/core/intake.ts`、`src/app/passes.ts:28,56-68`、`src/app/effects.ts` | ✅ 完整 |
| 3 | 订阅直通 Thread | `Subscription`（Thread 持有）× `Ticket` 多对多；订阅 Thread 上的任何消息**绕过门禁**直接作为上下文进入 Ticket；人的消息由 Executor 自己决定归属，Router 只能 stop | `001-domain.md:37`、`002-authorization.md:18-44`、`src/core/model.ts:75-88`、`src/app/tools/executor.ts` | ✅ 完整 |
| 4 | 上下文缓存化 Inline & Spill / 链式召回 | 小内容**内联**进消息，大内容**截断 + `chars` + `read` 资源指针**（spill）；`TextCache` 进程内 LRU；assessment 每次 Eval 一个有界读缓存；资源分页 4000/8000 字符、20/50 条 | `src/executor/dsh.ts:113-128`、`src/app/cache.ts`、`src/app/assessment.ts:41-45,117-268`、`src/app/resources.ts`、`007-architecture.md:577` | ✅ 机制在，**无跨重启缓存**（设计如此） |
| 5 | 持久在线：存算分离 + Watchdog | 状态全在一个 SQLite（`<stateDir>/orchestrator.sqlite`，schema 11）；Session 可丢、可重建；启动 `resume()` 重放中断 Assignment；`HealthBoard` + `Effects` 重试 + 30 min 后台配额 + 小时级 `status` 脚本 | `src/app/store.ts:51-119`、`src/app/effects.ts`、`src/executor/dsh.ts:524-537,601-672`、`scripts/dsh-superagent`、`006-deployment.md:113-141` | ⚠️ **无独立 Watchdog 判据**，只有“重试 / 超时 / 健康条目”，见 §6 |

论文与原型的关系已在 `README.md` 声明：文章里的一些设计是未来方向，原型未实现；本档案 §6、§9 会明确指出缺口，不把论文名词当既有代码。

---

## 1. 五个模块逐条

### 1.1 双层 Router / Worker

**分层不是“多 Agent 协作”，而是“权限与注意力分层”**：

| | Main Session（Router / orchestrator） | Executor Session（Worker） |
|---|---|---|
| Session id | `masterId = orchestrator-<hash(stateDir)>`，存 `KV.runtime.masterId`（`src/app/runtime.ts:104-105`） | `worker-<ticketId>`（`src/executor/dsh.ts:24`） |
| preset | `dsh-superagent-router`（`src/app/sessions.ts:48`） | `dsh-superagent-worker`（同） |
| 模型配置 | `settings.eval.model`（可为 null → profile 默认） | `settings.executor.model` |
| 工具 | 14 个应用工具 + DSH 的 `skill/bash/read/read_image/job_*`；**`tools.restrict` 白名单只有这 7 个**（`src/app/sessions.ts:263`） | 6 个应用工具 + `WORK_TOOLS` 白名单（`src/app/sessions.ts:61-62`） |
| 提示词 | 完整自装配（`complete: true`，无 persona，`src/app/sessions.ts:249`） | persona + DSH coding prompt + 仓库 `AGENTS.md` + dsh-superagent 角色段 |
| 等待纪律 | 禁止 `sleep`、`timeoutMs>30s`、job wait>5s（`noWait`，`src/app/sessions.ts:77-86,264`） | shell 前台 5 s 转后台；等待 job 也 5 s（preset 配置） |
| 职责 | 判准入、开/挂/停/忽略工单、转述人的问题、交付结果 | 调查、实现、验证、开 PR、处理自己 Thread 上的人消息 |

关键纪律（`prompts/shared.md`、`prompts/orchestrator.md`）：

- Router **不得**读代码、读日志、评估技术范围、设计解法、替 worker 解阻；“路由”不授权改写需求（不追加实现计划/验收标准/policy 清单）。
- Worker 从**原始来源**和常驻 policy 推导需求，不能把 router 的 note 当需求。
- 两个 Session 都有 `danger-full-access` 权限（`src/app/sessions.ts:152`），隔离靠**目录 + 账号 wrapper + 提示词**，**不是安全边界**（`003-execution.md:78-80` 原文承认）。

### 1.2 事件驱动 Trigger

- Source 插件（`SourceKind`，`src/sources/kind.ts:85-113`）负责：定 `kind/id/title/schema/fields/health`，声明 `scope`（哪些消息算“听到”）、`channel`（怎么回）、`threadContext`（assessment 怎么读）、`policy`（白名单/准入表/bot 列表）、`environment`（工单目录的环境变量）。
- Source 只把事件**翻译**成 `Trigger`（`src/core/model.ts:23-39`），并自己做**第一道过滤**（bot 自己的消息、不在监听范围的消息 → 记录为 `filtered` 但不进域，`007-architecture.md:68`）。
- 触发链路：`Passes.receive(trigger)` → `Engine.receive` → 存 `trigger` + `disposition` + `trigger_thread` → 扇出到订阅 Ticket → 若未被“人的消息直达 Ticket”例外命中，则在 primary Thread 入队等 Eval（`src/app/passes.ts:34-39`、`007-architecture.md:68`）。
- 拍子：`Passes.start()` 每 **2000 ms** 一次（`src/app/passes.ts:28`），每次 `effects.kick()` + `engine.evaluateDue()`（`passes.ts:63-68`）。命令（工具/HTTP/Source receive）会 `request()` 触发即时一拍，但**同一时刻只跑一拍**（`pump` 串行化，`passes.ts:56-62`）。
- 外部副作用全部**先落库后执行**：`Effects.enqueue(kind,key,payload)` 在事务内入队，提交后才跑（`007-architecture.md:164-181`）。6 种：`assessment / launch / delivery / relay / notice / reply`，各有并发上限与退避（见 §5.6）。

### 1.3 订阅直通 Thread

这是整个系统“省注意力”的核心机制，也是**最容易实现错**的地方：

- `Ticket` 接受时订阅它所有触发 Thread；之后该 Thread 上**任何人/任何 bot** 的消息都作为**上下文 Input** 直接送达 Ticket，**不过门禁、不需要 @、不检查白名单、不产生 Eval**（`002-authorization.md:18-22`、`prompts/subscriptions.md`）。
- 人的消息到达 Ticket 自己的 Thread 时，**归属权在 Executor**：Executor 决定“在范围内就做并 ack；超出范围就 `orchestrator_trigger_handback` 退回”，Router 期间只能执行 **stop**，accept/attach/ignore/requeue 全部拒绝（`002-authorization.md:26`、`dispatch.md`）。归属判据是 `followupOwners`（`src/core/model.ts:75-88`），只有 `handbacks` 与 `acked` 能解除。
- Ended Ticket **保留订阅**（含已合并/关闭的 PR）；人的消息直接**按同一 Mandate 复活**，不新建 Eval/Decision；bot 和 CI 不唤醒（`001-domain.md:37`、`002-authorization.md:127`）。
- 两类“非授权订阅”要分清：
  - **context-only**（Executor 为读上下文而 follow）：消息照送，但**不给 follow-up 强度、不复活 ended Ticket**（`003-execution.md:114`、`src/core/model.ts:165-169`）。
  - **attachment**（Router `attach`）：把 Ticket 订阅到**整条 Thread**；Executor 发现无关可用 `orchestrator_thread_unrelated` 只丢自己那一条订阅并退回消息（`002-authorization.md:82`、`src/app/tools/executor.ts:42`）。
- 退订：人可以 `orchestrator_thread_unsubscribe` 丢掉该 Thread 上**所有** Ticket 订阅；Executor 只能丢自己 Ticket 的（`001-domain.md:37`）。

### 1.4 上下文缓存化：Inline & Spill / 链式召回

原型没有“向量记忆”，它用**三层**实现同一目标：

1. **Inline（小内容内联）**：所有消息/卡片都按“能被模型直接用的最小形态”内联。
   - Assignment 文本内联上限 `ASSIGNMENT_CHARS = 1500`，Trigger 文本 `TRIGGER_CHARS = 600`（`src/executor/dsh.ts:113`）。
   - 超限即 `capped()` → `{ text: 前 N 字符 + "…", chars: 总长, read: 'trigger/<id>' | 'ticket/<id>/assignment' }`（`src/executor/dsh.ts:115-116`）。
   - 同批次其它 Trigger 用 `batchLine`：160 字符预览 + `read`（`dsh.ts:127-128`）。
   - Worker report 内联 600 字符；Candidate 文本 4000 字符；Thread window 每条 400（Trigger 两侧两条 1200）、其余 50 字符 stub（`007-architecture.md:540-548`）。
2. **Spill（大内容落成资源指针，模型按需召回）**：`orchestrator_read` + `RESOURCES`（`src/app/resources.ts`）把 `trigger/<id>`、`thread/<key>`、`ticket/<id>/transcript`、`feishu/<id>/…`、`github/…` 做成可分页资源；文本页默认 4000 / 上限 8000 UTF-16 code units，列表 20 / 上限 50（`007-architecture.md:577`）。
3. **链式召回（顺着 id 走）**：页面上**只出现可读的 id**（Trigger id、Thread key、Ticket id、assignment id、input id），拿到 id 就能读下一页；不可读的内部 hash（eval id、policy version）故意不上页面（`007-architecture.md:575`）。

缓存层：

- `TextCache`：进程内按大小 LRU，重启即失（`src/app/cache.ts`；`007-architecture.md:482`）。`Runtime` 用了两个：`sourceLinks`（200 KB，Feishu 链接解析）和 `pages`（4 MB，资源分页）。
- Assessment 读缓存：每次 Eval 一份 `ReadCache{snapshots,images,messages,cursors}`，**Eval 结束即释放**；重复读同一 resource+path+cursor+message_id 命中缓存（`src/app/assessment.ts:41-45,228-268`）。
- **没有**跨重启语义缓存、**没有** embedding 召回、**没有** token 预算控制器——上下文规模靠上述硬上限 + DSH compaction（preset 里 `thresholdChars: 8192`，`cordis.patch.yml:90-95`）。要加“读缓存 token 命中率”类指标，见 §9。

### 1.5 持久在线：存算分离 + Watchdog

- **存**：唯一 SQLite `<stateDir>/orchestrator.sqlite`，只由 `Store` 打开；进程启动前先 `lockSync(stateDir, {stale:30_000})`，防止双开/migrate 竞争（`src/app/runtime.ts:91-94`、`007-architecture.md:151`）。表：`trigger / disposition / trigger_thread / thread / ticket / decision / effect / outbox / kv`（`src/app/store.ts:71-87`）。
- **算**：DSH Session 是**可重建的计算单元**。启动时 `executor.resume()`：运行中的 Assignment 记 `assignmentInterrupted` 并带 recovery note 重跑；pending 的重新入队；`waitsForPerson` 的不动（`src/executor/dsh.ts:524-537`）。Session 若被外部删除，投递前会 `ensure()` 重建（`dsh.ts:314-316`）。
- **幂等**：每个下游动作都有稳定 key（`Effects` 的 `kind/key` 唯一行、`Outbox` 的 message id、`Session` 的 `MessageId('dsh-superagent:<requestId>')`，`src/app/delivery.ts:16,66-85`），所以重启重放不会重复发消息/重复开单。
- **Watchdog（原型只有半个）**：
  - 节拍器：`Passes` 每 2 s；`Effects` 失败指数退避（各类 2 s→60 s 或 5 s→300 s，`007-architecture.md:172-181`）。
  - 失败升级：同一 kind 连续失败 3 次 → `HealthBoard` 该条目 error（`FAILURES_BEFORE_ERROR=3`，`src/app/effects.ts:7`）；`runtime` 一拍失败即 error。
  - 会话语义超时：turn 结束后后台工作只给 **30 min**（`BACKGROUND_LIMIT_MS`，`dsh.ts:32`），到点杀 job、上报 `waiting`；shutdown 每 worker 等 **10 s**（`SHUTDOWN_STOP_MS`，`dsh.ts:34`）。
  - 外部巡检：`scripts/dsh-superagent status` 的退出码 0/1/2/3（`006-deployment.md:113-124`），配一个“小时级 schedule 任务”做恢复与上报（`006-deployment.md:133-141`）。
  - **没有**：无进展判据（assignment 停滞检测）、无效循环判据、方向漂移判据、自动 kill/重规划。§6 给出可落地设计。

---

## 2. 完整领域模型

### 2.1 实体与字段（以 `src/core/model.ts` 为准）

| 实体 | 字段（TS 名） | 规则/备注 |
|---|---|---|
| **Source**（配置态，非 `model.ts`） | `id, kind, enabled, config`（`src/sources/kind.ts:115`）；`kind` 定义 `scope/channel/threadContext/policy/environment/health` | 持有**读位置**（KV）与自己的 bot 身份；重启不得重放事件；只负责翻译，不做授权 |
| **Trigger**（不可变） | `id, source, threads: ThreadRef[], actor: {source,id}, human: boolean, addressed?: 'mention'\|'direct', at, text, channel?: {source,thread,address}, url?, meta` | `text/meta` 是不可信外部数据；`threads[0]` 是主场 Thread（Eval 在这里排队） |
| **TriggerDisposition** | `filtered?: Reason, evalId?, decisionId?, fanout: string[], context?: string[], requeued?: true, handbacks?: {ticketId,reason,at}[], acked?: string[], at` | 审计 + 归属判据（谁能决定这条人的消息） |
| **Thread** | `key, ref, createdAt, lastAt?, subscriptions: string[], context?: string[], correlated: string[], pending: string[], evaluating?: Evaluation, expired?: number, meta` | **一个 Thread 同时最多一个 Eval**；`pending` 是批处理缓冲；`correlated` 只加上下文不路由 |
| **Evaluation** | `id, threadKey, triggerIds, primary?, strength, actor, basis, policyVersion, startedAt, delivered?, deadline, pausedAt?` | 无状态；**deadline 从 candidate 到达 Main Session 起算**；人写消息合并进下一批 |
| **Decision** | `id, evalId, threadKey, triggerIds, policyVersion, at, kind: 'ignore'\|'accept'\|'reopen'\|'stop'\|'unavailable', reason: Reason[], strength, ticketId?, mandate?, audit?, dismissed?` | 一次决定覆盖整批（`triggerIds`）；accept 是**唯一**创建 Ticket 的入口 |
| **Mandate**（不可变） | `strength: 'explicit'\|'inferred', policyVersion, basis: MandateBasis, actor, scope` | 只有三种操作改它：accept 创建、人的 stop 撤回、revalidate 失败吊销；Ticket 结束**不**结束 Mandate |
| **MandateBasis** | `source?, scope?, row?, sender?, rules?: string[]` × `via: 'addressed'\|'followup'\|'admission'\|'listed'\|'bot'`（后三者可带 `observation?: {mode}`，admission 带 `cell`，addressed 带 `addressed`） | 复活前按它逐项 revalidate（见 §3.4） |
| **Ticket** | `id, title, decisionId, mandate, channels: ChannelRef[], ended?: {at,by:'executor'\|'human',outcome:'completed'\|'merged'\|'closed'\|'dropped'\|'stopped',reason?}, attention?: {id,question,triggerId?}, assignments: Assignment[], inputs: TicketInput[], undelivered: string[], follows?: {thread,own,closed?:{at,outcome}}[], answers?: string[], createdAt, updatedAt, origin: {triggerId, triggerIds}, execution?: {name,directory,assignment}, delivery?: {error,at}` | **自己定义状态，不跟随 Session**；`open`=无 `ended` |
| **Assignment** | `id, state: 'pending'\|'running'\|'ended', createdAt, startedAt?, endedAt?, endedReason?, report?: {state, summary, at}, deliveredAt?, idleAt?` | 与 Ticket **独立**结束；一个 Ticket 历史上可多个 Assignment（retry/restart/resume） |
| **Report**（内嵌） | `state: 'progress'\|'waiting'\|'ready'\|'blocked'\|'failed'\|'dropped'`, `summary`, `at` | `ready`→等 review；`blocked/failed`→等人；`dropped`→直接结单；`waiting`→idle |
| **TicketInput**（联合） | `trigger{triggerId,note?,human?,context?,readAt,deliveredTo,deliveredAt}` / `policy-changed{from,to,effect?}` / `reopen{decisionId}` / `resumed{triggerId}` / `text{text}` / `note{text}` | `readAt` 是“进入 step 历史”的标记，决定结单时未读消息是否退回 Eval |
| **Attention** | `id, question, triggerId?` | **唯一**允许打扰人的结构化字段；不允许从 report 自由文本推断 |
| **Policy**（运行时对象） | `version, paused, evalTimeoutMs, gate(trigger,thread,tickets), revalidate(mandate), admitsInferred(rules)` | 见 `src/policy.ts:167-241`；`version = key('mandate-v3', JSON{rules,mode,sources})`（`policy.ts:111-118`）；规则/模式/来源策略任一变化即换版本 |
| **Notice/Relay**（消息，非表） | `eventNotice / reportRelay / resultRelay / followupRelay / candidateCard` | Relay = **steer 进正在跑/下一 step**（会唤醒）；Notice = **inject 不唤醒**（`src/app/sessions.ts:171-186`、`src/app/delivery.ts:79-81`） |

被**明确拒绝**的概念（`001-domain.md:45-60`，落地时不要加回来）：Principal/Membership、跨 Source 身份映射、Eval 自己定时、Ticket 跟随 Session 状态、由 Executor 宣布“人说停”、Policy 变更取消运行中 Ticket、把全部工具锁死、从自由文本推断“等人”。

### 2.2 状态机

**(a) Ticket 阶段（`src/core/stage.ts:9-21`，自上而下第一命中）**

| 顺序 | stage/action | 条件 | 面板文案 | 谁能解除 |
|---|---|---|---|---|
| 1 | `ended` | 有 `ended` | 已结束 | 人的消息（若未被 stop） |
| 2 | `person/delivery` | `ticket.delivery` 存在 | 输入未送达 | 送达成功 / 新 Assignment / 结单（自动重试 2 s→60 s） |
| 3 | `person/answer` | `ticket.attention` 存在 | 等待回答 | 人的回答 / Executor 清除 |
| 4 | `person/review` | 最新 report `ready` | 等待 review | 人的 review / 合并 |
| 5 | `person/blocked` \| `failed` | 最新 report 为 blocked/failed 且 `waitsForPerson` | 受阻 / 失败 | 人的消息 / 非 blocked 报告 / retry |
| 6 | `working/queued` | 无 Assignment 或 pending | 排队 | 有空 worker slot |
| 7 | `idle` | report `waiting` 或 Assignment ended | 等 Trigger | 订阅 Thread 上的新 Trigger |
| 8 | `working` | 其它 | 执行中 | — |

`canRetry(ticket) = !ended && (waitsForPerson || !!delivery)`（`stage.ts:24-26`）。

**(b) Assignment 状态机**：`pending → running → ended`（`endedReason`: `retried` / `restarted` / `host restarted` / 正常结束）。只有**最终报告**能从 Executor 一侧结束 Ticket（`001-domain.md:36`）。

**(c) Ticket 结束（`003-execution.md:92-106`）**

| 触发 | outcome | 备注 |
|---|---|---|
| `ready` 且不 follow 任何 Thread | `completed` | 无 PR 的纯代码/调查类 |
| `dropped` | `dropped` | 不给人发消息；之后人的消息可复活 |
| follow 的 PR 全部关闭 + 未完成工作已收尾 | `merged` / `closed`（取最后一次 close 的 outcome） | 保留订阅，后续人评论可复活 |
| 人的 stop（面板命令或经 Eval 的 stop） | `stopped` | 永久结束，不再收任何消息；再做事需新 accept |

**(d) Trigger 生命周期**

```
Source 收到事件
  ├─ 不被监听/bot 自己 → disposition.filtered=Reason（落库、不进域）
  └─ receive(trigger)
       ├─ id 已存在 → 'duplicate'（幂等；accept 幂等靠 triggerId）
       └─ stored：
            ├─ 写入每个 thread 的 timeline（trigger_thread）与 correlated
            ├─ 扇出 → 每个订阅中的 Ticket 得 Input（kind:'trigger'）
            │     └─ 若人的消息到达 Ticket 自己的 Thread → 归属 Executor，**不入 Eval**
            └─ 否则在 primary Thread 的 pending 排队
                 └─ evaluateDue：每 Thread 取整批 → Eval（一次一个）→ Decision
                       ├─ accept：建 Ticket + Mandate + Assignment + 订阅 + ack（原子）
                       ├─ ignore：普通讨论 / observe 下的 would_accept
                       ├─ stop：仅 explicit 强度
                       └─ unavailable：超时/失败/版本过期 → 重新排队（两次后第三次落 unavailable）
```

**(e) Trigger 的 `disposition` 终态**：`filtered` / `duplicate`（无 disposition 行）/ 进入 Eval 后有 `evalId+decisionId` / 仅 fanout（直达 Ticket）/ `requeued` / `handbacks`（退回后等“无人拥有”再进 Eval）/ `acked`（Executor 已承接）。

### 2.3 持久化结构（SQLite schema 11）

- 路径：`<stateDir>/orchestrator.sqlite`；`stateDir` 必填且**绝对 POSIX 路径**（`src/deployment.ts:13,15-16`）。
- 行格式：`(id/key PRIMARY KEY, value TEXT json, …)`；一旦写入不再原地改结构，读时 `JSON.parse`。
- 表与索引（`src/app/store.ts:71-87`）：

| 表 | 列 | 写入者 |
|---|---|---|
| `trigger` | `id, value, at`（`at` 为 `Date#toISOString` 文本，可直接字典序比较） | Engine |
| `disposition` | `id, value`（TriggerDisposition） | Engine |
| `trigger_thread` | `thread, id, at, human`（主键 `thread+id`）| Store 随 Trigger 写 |
| `thread` | `key, value` + 生成列 `active`（有 pending 或 evaluating）、`subscribed`（有订阅时=来源） | Engine；Source 只写 `meta` |
| `ticket` | `id, value` + 生成列 `open`（无 ended）、`active`（有未投递 Input 或最新 Assignment pending/running） | Engine |
| `decision` | `id, thread, value` | Engine |
| `effect` | `kind, key, value, seq, generation, attempts, error, due, since`（主键 `kind+key`） | Effects |
| `outbox` | `id, value` + 生成列 `dropped`（dropped.at）、`pending`（ticketId+thread，保序用） | Outbox |
| `kv` | `key, value` | 各自 owner（见下） |

- 生成列（computed + partial index）是“只扫活跃工作”的关键（`store.ts:30-44`）。打开旧库时自动补列并重建索引（`store.ts:103-119`）。
- KV 键必须**只**在 `src/kv.ts` 里拼：`schema`、`settings-revision`/`settings-block-revision:<block>`/`settings-version:<n>`、`prompt-revision`/`prompt-version:<n>`/`prompt-built-in:<base>`、`master-id`、`session-prompts:<session>`（该 Session 用过的所有 prompt revision，`.at(-1)` 为当前）、`store.schema`、`source-labels:<source>`、`github-*`/`feishu-*`（Source 自己的读位置）。**迁移代码是唯一允许出现旧键名的地方**。
- 版本迁移：`SCHEMA_VERSION=11`、`OLDEST_SCHEMA=10`；只允许单向升级；**比当前版本新的库拒绝启动**；10→11 迁移在**一个事务**里重写所有记录，失败则库保持原样并报错（`store.ts:58-101`、`007-architecture.md:486`）。
- 已知缺陷（照抄要评估）：`trigger/disposition/decision/ended ticket/outbox` **无 TTL、无清理**（`007-architecture.md:484`），长期运行需要自建归档。
- `afterCommit`：事务提交后才执行的动作（如 stop worker），回滚则不执行（`store.ts` 提供，`dsh.ts:363` 使用）。

---

## 3. 准入管线（Eval）

Eval = **Gate（确定性）+ Assessment（模型）** 两层；Gate 在代码里，Assessment 在 Main Session 里用工具完成。

### 3.1 Fast Path：`Policy.gate()` 决策树（`src/policy.ts:191-211`）

输入：`trigger, thread, tickets`；输出 `{admissible: false, reason}` 或 `{admissible: true, strength, basis}`。

```
if (!trigger.human) → machineGate()：                 // bot / CI / 无 sender 的系统事件
    actor 非空且不在 Source 的 bots 列表 → not_human
    Source scope 未监听 或 (未 @ 且 scope 不是 observe-all) → not_human
    bot 在列表：mode=off → admission_ignored；否则 inferred（via:'bot'）
    无 sender（如 CI）：看 admission 表 unlistedUnaddressed 单元格；inferred 且 mode≠off → inferred
else：
    allowed = Source 白名单命中(actor)                    // 大小写不敏感，sameName
    row = scope.row（接收范围，如某个群/某类 GitHub 范围）
    if (allowed && addressed) → explicit, via:'addressed'     // 无表判断
    cell = admissionCell(allowed, addressed?)             // 列：listed/unlisted × 是否 @
    receivable = addressed || (scope.listened && scope.observed)   // 未 @ 的消息，只有“收全部消息”的范围才看表
    admission = receivable ? 表中该单元格(默认: listedUnaddressed=inferred, 其它=ignore) : ignore
    if (admission === 'explicit') → explicit, via:'admission'
    if (非“未列名单聊” && (allowed || mode !== 'off') && 该 Thread 已有非 context-only 的 Ticket)
        → allowed?explicit:inferred, via:'followup'        // Thread 跟进，绕过表
    if (admission === 'inferred' && mode !== 'off') → inferred, via:'admission', observation:{mode}
    else → not_a_member / admission_ignored / no_mention
```

**Fast Path 可配置项清单**（落地时这张表就是配置页字段）：

| 配置 | 位置/类型 | 默认 | 说明 |
|---|---|---|---|
| `policy.rules[]` | `RuleSchema`：`id`(/^[A-Za-z0-9_-]{1,80}$/)、`name`(≤100)、`enabled`、`instruction`(≤2000) | 2 条示例：`copy`、`visual` | 只决定**主动工作**的范围；不约束 explicit 请求；ID 唯一 |
| `eval.mode` | `'off'\|'observe'\|'auto'` | `observe` | 见 §3.3 |
| `eval.timeoutSeconds` | int 30–600 | `120` | Eval 超时；从 candidate 到达 Main Session 起算 |
| `eval.model` / `executor.model` | `{provider, model, reasoningEffort?}` 或 null | null（profile 默认） | Router 轻 / Worker 强 |
| `policy.sources[<source>].allowed[]` | `{id, name?}` | `[]` | 以 **Source 自己的身份体系**记；空列表 = 永远不会有工单（面板 `no-allowed` 警告） |
| `policy.sources[<source>].admission{}` | `Record<scope, {listedUnaddressed?, unlistedAddressed?, unlistedUnaddressed?}>` | 见 `src/admission.ts:13` | 三个单元格，取值 explicit/inferred/ignore |
| `policy.sources[<source>].bots[]` | Source kind 校验（`z.array(AllowedSchema)`） | `[]` | 只能产出 inferred 候选，永不能 explicit / stop |
| Source `scope` 配置 | Source kind 自定义（如 Feishu 群 `仅@`/`全部消息`；GitHub receive-all 开关） | 见各 kind | 决定 `listened/observed/row`，是**配置**不是 Policy |

### 3.2 Slow Path：语义判定（Main Session + 工具）

**入口链**：`Effects('assessment')` → `MasterAssessor.request` → `deliver`（把候选卡 steer 进 main Session）→ 模型调 `orchestrator_eval` → `orchestrator_eval_read` → `orchestrator_eval_decide` → `assessmentOutcome()` → `Engine.decide`。

**输入**（`007-architecture.md:540-548`）：
- Trigger 文本 ≤4000 字符 + 图片 id + 同批其它 Trigger；
- 最多 8 个 `related_tickets`（open 优先）+ `tickets_total`；
- `policy_version`；
- **Thread window**：首 5 条 + Trigger 前后各 5 条，`{id, from, at, text}` 常规 400 字符（紧邻两条 1200），截断带 `chars`，图片 `images`；其他已加载消息 50 字符 stub，用 `orchestrator_eval_read` 按 id 展开；
- 提示词中的随手规则：`runtime/admission`（`prompts/admission.md`）+ `runtime/policy`（每次请求由 settings 重新生成，`- <name> (<id>): <instruction>`）。

**输出（`orchestrator_eval_decide` schema，`src/policy.ts:30-33,40-61`）**：

```ts
{
  decision: 'accept' | 'ignore' | 'unavailable',
  rule_assessments: [{ rule_id, matched: boolean, reason: string }],  // 每个 enabled 规则恰好一条
  direction: { implementation_requested: boolean,
               target_basis: 'specified' | 'existing-standard' | 'undetermined',
               requires_design_decision: boolean,
               evidence: string },                                    // 必填，所有 decision 都要
  title, scope, reason,
  intent_evidence?,             // accept 必填
  acknowledgement?,             // accept 的一句子（≤100 词），静默规则下可省
  worktree_name?                // accept，英文短名，独立于 title
}
```

**`assessmentOutcome()` 判定顺序**（照抄这个顺序，别自己发明）：

1. `rule_assessments` 必须**恰好覆盖每个 enabled 规则一次**（多/少/重/禁用/未知 id 都抛错）。
2. 非 accept → 直接返回（带 `audit`）。
3. `directionAllowed` = `implementation_requested && target_basis !== 'undetermined' && !requires_design_decision`；不满足 → `ignore`，reason `directionUnsettled`。
4. 没有任何 `matched` → `ignore`，reason `noRuleMatched`（**主动接受必须至少命中一条规则**）。
5. 缺 `intent_evidence` → 抛错。
6. `strength === 'inferred' && mode !== 'auto'` → 返回 `ignore`，`audit.would_accept = true` + `proposal`，reason `observed`（**observe 模式的核心**）。
7. 否则 `accept`，携带 `rules: matchedIds`、`acknowledgement`、`name`。

**提示词要点**（`prompts/admission.md`，直接决定误报率）：
- 三个独立事实必须分别成立才可匹配规则：讨论针对本项目、表达了“要某个具体改动被实现”的意图、方向已定到“可做小的局部修改”；shrug/偏好/讨论别的产品都不算。
- 短句同意**可以**确认前面的具体提议（不要求同一作者重复祈使句/文件路径/组件名），但裸同意（无可识别提议）不算。
- 视觉类：定位到组件/CSS 文件/估计改动行数**都不**等于“范围小且已授权”；“不一致/丑/难懂”不是目标设计；现有标准必须指向真实参照。
- `unable`（不可用）只用于**工具/权限/模型能力失败**导致证据缺失；可读但不够格 → `ignore`（`unavailable` 会让健康条目报错）。
- 讨论若延续既有 Ticket → `ignore`（避免重复单）；一条源消息最多产一张单；规则冲突/范围模糊 → 静默 ignore。

### 3.3 `observe` / `accept`（`auto`）模式差异

| 模式 | inferred 候选 | 判定 | 记录 | 效果 |
|---|---|---|---|---|
| `off` | 不产生候选（未 @ 的人、bot、非名单人跟进都被拒，`not admitted`） | 不评估 | — | 只有 explicit 请求能开工 |
| `observe`（默认） | 产生并被**评估** | 走完整 Slow Path | Decision 记 `ignore` + `audit.would_accept=true` + `proposal` | **什么都不会被接受**；面板显示 “would accept”，用来审提示词与规则 |
| `auto` | 产生并被评估 | 同上 | 命中规则即 `accept` | 真正主动开工 |

补充规则：explicit 在任何模式都工作；**explicit 的直连 accept 会拒绝**门禁未判为 explicit 的 Trigger（`002-authorization.md:89`）；从 `auto` 降回 `observe/off` **不会**撤销运行中工单，只会在下次 revalidate 或 `policyChanged` 时通知/吊销。

### 3.4 复活前的 revalidate（`src/policy.ts:213-240`）

复活（人的消息唤醒 ended Ticket）**不重新 Eval**，但先按 Mandate 的 `basis` 校验：

1. Source 仍监听原 Thread（不再监听 → 失败）。
2. `via='followup'`：explicit 直接过；inferred 需 `mode='auto'` 且命中规则仍全部 enabled。
3. `via='bot'`：bot 仍在 bots 列表 + auto + 规则 enabled。
4. `via='admission'`：按**今天的**表和 sender 名单重算单元格，strength 不得低于原值（把 sender 移出白名单可能吊销原 Mandate）；unlisted-addressed 单元格且现在已在名单 → 直接过。
5. 其余：sender 仍需在白名单。
6. 失败 → Ticket 保持 ended、不收消息；这些消息若无人拥有则重新进 Eval；**Main Session 不会被告知它“到达了 worker”**。

---

## 4. Router 决策逻辑

### 4.1 批处理（batch）

- **一 Thread 同时只有 1 个 Eval**（`Thread.evaluating`）；Eval 运行期间新到的 Trigger 全进 `thread.pending`，**合并为下一批**（`001-domain.md:43`）。
- `evaluateDue()` 为每个有 pending 的 Thread 起一个 Eval；批内 Trigger 一起决定（Decision 的 `triggerIds`）；`primary` 是“给这批定强度的那个 Trigger”，accept 后成为 `ticket.origin.triggerId`（`model.ts:140-142`）。
- Worker 首条消息里带 `batch: batchLine[]`（除 primary 外的同批 Trigger，160 字符预览 + read），避免 Router 转述丢上下文（`dsh.ts:460-464`）。
- Router 工具一次可提交 **1–20** 条决策（`orchestrator_route`，`src/app/tools/main.ts:129`），每条**独立事务、独立成败**（`main.ts:130-151`）。

### 4.2 去重

原型用的是**幂等键**而不是“相似度去重”，这是落地时最稳的一层：

1. `Trigger.id` 由 Source 用 `key(...)` 从原生 id 派生；重复接收返回 `duplicate`（`008-cookbook.md:130-133`）。
2. **accept 以 triggerId 幂等**：同一 Trigger 重复 accept 只产生一张 Ticket，第二次返回 “Already accepted as <id>”（`main.ts:96-104`）。
3. 同批中已被前一 item 决定的 Trigger，后续 ignore 会被拒（`main.ts:92-93`）。
4. 语义层去重靠提示词：候选卡列出该 Thread 的**全部** Ticket（含 ended），要求“延续既有工单时 ignore，不重复开单”（`prompts/admission.md`）。
5. 无相似度检索、无跨 Thread 去重——**这是已知缺口**，每条消息最多一单靠提示词约束。

### 4.3 冷却与背压

原型没有“同一来源 N 分钟内不再打扰”的显式冷却；等价机制是：

| 机制 | 位置 | 行为 |
|---|---|---|
| Eval 串行 + 排队合并 | `Thread.pending` / `evaluating` | 一次只处理一批，天然限速 |
| Eval 超时 | `eval.timeoutSeconds`（默认 120 s） | 超时重排队；连续 2 次后第 3 次记 `unavailable`；candidate **未送达** Main Session 前不计时（`007-architecture.md:93`） |
| `unavailable` 重试上限 | `Thread.expired` | 3 次后停；面板可 `reevaluate` 或 dismiss |
| 副作用退避 | `Effects` | 每 kind 独立：assessment/delivery/relay/notice 2 s→60 s；launch 5 s→300 s（3 次）；reply 5 s→300 s |
| 人工暂停 | `settings.paused` / `POST executor/pause` | 停 dispatch/Eval/超时/Input 投递/回复；Source 继续记录；运行中的 worker turn 不打断；暂停时长会顺延 Eval deadline |
| 注意力限流 | `IM_WORDS=100`、note ≤30 词、report 摘要 ≤600 字符 | 从生成侧限制打扰体积 |
| 自动评审预算 | 每条 PR 每个自动评审者最多 3 轮（`prompts/admission.md`/`work.md`） | 防止 bot 互刷 |

若要新增“冷却”，最自然的落点是 `Evals`（候选产生前按 `thread.lastAt` 或同源 actor 的最近决策时间做门限），**不要**放到 Source（Source 只管监听）。

### 4.4 分派策略（accept / attach / ignore / stop）

| 决策 | 前置 | 必填 | 效果 |
|---|---|---|---|
| `accept` | 候选由 Router 判定（explicit 可直连；inferred 必走 assessment） | `title`(≤200)、`worktree_name`、`acknowledgement`(≤100 词) | 原子创建：Ticket + Mandate + 首个 Assignment + 订阅全部触发 Thread + 在原消息下回 ack；`note` 可选（≤30 词） |
| `attach` | 消息**明确指向**某 Ticket：引用/链接其 PR、Issue、源消息或 ack，或“刚做的改动”且唯一匹配 | `ticket_id` | 订阅整条 Thread；ended 且非 stopped 的按 Mandate 立刻复活；context-only 不算 |
| `stop` | 只有态：allow 列表的人明确要求停 | `ticket_id`，`reason?` | 通过 `engine.decide({kind:'stop'})`，故只有 explicit 强度能停；面板 stop 是命令，直接生效并记 manual stop |
| `ignore` | 普通讨论；或 observe 下“够格但模式不允许” | `reason`（必填，≤500） | 记录；`ignoredFromCard` 用于“一张卡就能判定不沾规则”的快路径 |

返回形态：每条 `{trigger_id, kind, decision?, reason, ticket?, refused?}`；批量返回 `{results}`，保序（`007-architecture.md:536`）。

### 4.5 模型角色

- **Router 轻**：`eval.model` + 只读工具（`orchestrator_eval*`、`orchestrator_read`）+ 严格 no-wait guard；提示词要求“只转述、不实现”。
- **Worker 强**：`executor.model`；新 Session 创建时通过 `initializeRoleModel()` 注入（`model/selection` + `system-prompt/assemble`/`agent/request` 拦截，`src/app/role-models.ts:15-44`）。**已存在的 Session 保留原模型**（`003-execution.md:143`）。
- 二者都是 `RoleModelSchema = {provider, model, reasoningEffort?}`（`src/policy.ts:70`）；`null` 用 profile 默认；`resolveCallConfig` 校验存活 provider（`role-models.ts:8-12`）。

---

## 5. Worker 执行

### 5.1 会话如何创建（`Sessions.ensure`，`src/app/sessions.ts:138-155`）

```
ctx.sessionController.resolveAgent(id)
  ├─ 存在 → 用它
  └─ 'session/not-found' →
       workspace = await ctx.workspaceRegistry.create(cwd)      // cwd = ticket.execution.directory
       await ctx.sessionController.create({ sessionId, workspaceId: workspace.id,
             agentPreset: role==='worker' ? 'dsh-superagent-worker' : 'dsh-superagent-router' })
       result = await ctx.sessionController.resolveAgent(id)
initializeRoleModel(ctx, agent, roleModel)                      // 见 §4.5
decorate(agent)                                                // systemPrompt.section + skills + tools
ctx.permissionPresets.set(agent.session, 'danger-full-access')
await ctx.sessionController.rename({ sessionId, title })
```

`decorate()`（`sessions.ts:232-269`）做的事，按顺序：

1. 绑定 `retryHealth`（从 `snapshotEvents()` 恢复预算重试状态）。
2. `systemPrompt.section({ name:'dsh-superagent-policy', order:9999, interpolate:false, text: ctx => ... })`；**只有 main Session 传 `complete:true`**（覆盖 DSH 默认提示词）。
3. `agent.ctx.inject(['skills'], scope => ...)` → 用 `scope.skills.register({name:`${SKILL_PREFIX}${name}`, description, content, source:'runtime'})` 注册团队/内置技能。
4. 注册应用工具（`registerTool`，见 §5.4/API 文档）。
5. main Session：`tools.restrict({allow:['skill','bash','read','read_image','job_output','job_list','job_kill']})` + `tools.guard(noWait)`。
6. Worker：`workOnly()` = `tools.restrict({allow: WORK_TOOLS∩实际存在})` + `tools.guard(结单后拒绝：'Ticket ended; new work needs a new authorized ticket')`；子 Agent（subagent）走 `limitSubagent()`，同样受限。
7. `release()` 逆序 dispose 所有注册（`sessions.ts:341-349`）。

**preset 被抢的兜底**：Web UI 打开空白 Session 可能选上默认 preset；`agent-preset/selected` 事件里若发现本 Session 应为 router/worker 却选了别的，重新 `presets.select(agent, ours)`（`sessions.ts:122-132`）。

### 5.2 目录隔离与准备命令

- 目录：`execution.directory = join(executionRoot(settings, stateDir), name)`，`name = <worktree_name>-<ticketId 前 12 位>`；`executionRoot` 默认 `<stateDir>/work`（`dsh.ts:56-57,97-111`；`policy.ts:94`）。
- 首次 Assignment 前，若目录不存在：在**父目录**执行 `prepare` 命令（`sh -c`，10 分钟超时，注入该 Ticket 的执行环境变量），失败即 `PrepareFailed` → Ticket `failed`（**不自动重试**，因为“目录存在即视为已准备”，`dsh.ts:247-262,270-285`）。
- 典型 prepare：`git fetch` + `git worktree add -b agent/$NAME "$DSH_SUPERAGENT_DIR" ...`（`006-deployment.md:151-154`）。Windows 无 `sh`，见 API 文档 §9。
- 环境变量（`003-execution.md:63-76`）：`DSH_SUPERAGENT_DIR/NAME/TICKET`、`DSH_SUPERAGENT_BLOCKED_COMMANDS`、`DSH_SUPERAGENT_GITHUB_REPOSITORY/ACCOUNT/COMMIT_EMAIL/NUMBER/PR_HEAD`、`DSH_SUPERAGENT_FEISHU_BOT/CHAT`；**不含凭据**；prepare 命令与 Worker 提示词拿到同一组值。

### 5.3 订阅与上下文怎么到 Worker

- Ticket 创建 → 订阅触发 Trigger 的所有 Thread；`bindThread` 可把 PR Thread 绑进来（`own:true`）。
- 之后 Thread 上的消息 → `Intake` 生成 `TicketInput{kind:'trigger'}` → `Effects('delivery')` → `DshExecutor.deliverQueued` 逐条 `sessions.prompt(workerSessionId, input.id, text, 'steer')`（`dsh.ts:290-343`）。
- 每条 Input 的消息 id 固定为 `MessageId('dsh-superagent:<inputId>')`，`inputsDelivered` 记“已送达”，Worker 的 `session/event user/message` 记 `inputsRead`（`dsh.ts:495-504`）——这两个时间戳决定结单时“未读消息是否退回 Eval”。
- 上下文边界：Worker 只能读**自己**的 Ticket、它的 Thread、到达它的 Trigger、它工作过的 prompt revision 和来源原始记录；页面不出现它读不到的东西的 id（`007-architecture.md:573`）。

### 5.4 结果如何回投 Router（四条通道）

| 通道 | 触发 | 机制 | 是否唤醒 Router |
|---|---|---|---|
| `ready` / `blocked` / `failed` / `dropped` 报告 | Worker 调 `orchestrator_report` | `engine.report()` → `notices.resultRelay()` → `Effects('relay')` → `Sessions.prompt(masterId, requestId, text, 'steer')` | ✅ 唤醒/steer |
| 结构化提问 | `orchestrator_report human_action` → `ticket.attention` | `reportRelay` **立即**转发问题（`reportRelay` 对 attention 特殊处理，`007-architecture.md:42`） | ✅ |
| 人的 follow-up 到达 Worker 的 Thread | `trigger.received`（人被送达 Ticket） | `followupRelay` → steer 一条 `follow_up` 通知，Router 只能 stop | ✅ 但不夺权 |
| 普通进度 | `orchestrator_report progress` | **只更新 Ticket，不打扰**（不 relay） | ❌ |
| 领域事件 | Ticket 结束/requeue/退订等 | `eventNotice` → `Effects('notice')` → `agent.inject()`（**不唤醒**） | ❌ |

工具形态：`orchestrator_report` 接受 `progress|waiting|ready|blocked|failed|dropped`，可选 `pr_number`（创建/接管 PR 后立刻 progress 绑定 Thread）、`human_action`（一个具体问题）、`question_for_trigger_id`（问题回给哪个人的消息）、`reply_to_trigger_id`（回答某个具体人类问题）。内置文本约束见 `prompts/handoff-worker.md`、`work.md`。

### 5.5 终止 / 中断 / 恢复

| 场景 | 动作 | 代码 |
|---|---|---|
| 面板 stop 或经 Eval 的 stop | `Engine.stopTicket` → 生成新 Assignment 结束 → `DshExecutor.stop()`：`afterCommit` 里 `agent.cancel({kind:'user'},{keepInbox:false})` + `stopBackground` | `dsh.ts:357-370` |
| retry | 结束旧 Assignment、同 Session/目录/分支开新 Assignment，带 `RETRIED` 说明 | `dsh.ts:136,455` |
| 宿主重启 | `resume()`：running → `cancel(keepInbox:true)` + `stopWork('dsh-superagent restarted')` + `assignmentInterrupted`；pending 且不 `waitsForPerson` → 重新 `start` | `dsh.ts:524-537` |
| 暂停处理 | launch/delivery 的 effect `limit:0`；已开的 launch 等恢复；worker turn 不打断 | `dsh.ts:232-235` |
| 关闭 | `shutdown()`：对每个 worker `stopBackground(keepInbox=true)`，结束遗留 job 收集，非 idle 的 `cancel(keepInbox:true)` + `whenIdle()`，总预算 10 s；随后 `sessionPersistence.flush()` | `dsh.ts:391-402`、`runtime.ts:230-253` |
| 结单 | `tools.guard` 在结单后拒绝所有工具调用（提示“新工作需新授权工单”） | `sessions.ts:293-296` |

**并发**：`WorkerSlots`（`dsh.ts:171-199`）在 `await` 之前**同步占位**；`maxWorkers`（默认 3，1–16）；人的消息可多用 **1** 个槽且优先于新 launch；launch 并发执行，prepare 慢只拖自己。

### 5.6 副作用队列语义（Worker 的“持久执行”底座）

| kind | handler | 并发 | 退避 |
|---|---|---|---|
| `assessment` | MasterAssessor 把候选卡 steer 进 Main Session | 4 | 2 s→60 s |
| `launch` | prepare + ensure + 首条 assignment 消息 | 空闲 worker 槽 | 5 s→300 s，3 次；**非网络错误与 prepare 失败直接 failed** |
| `delivery` | 逐条把等待 Input 交给运行中的 Assignment | 4 | 2 s→60 s（等槽 2 s） |
| `relay` | steer 进 Main Session；**保序**，失败阻塞同 kind 后续 | 1 | 2 s→60 s |
| `notice` | inject 通知、不唤醒；保序 | 1 | 2 s→60 s |
| `reply` | 经 Source 的 Channel 发消息；同 Ticket+会话保序 | 1 | 5 s→300 s |

`Later` 异常 = “现在不能跑”，不计数、按初始退避重排（`effects.ts:5`）；`generation` 保证运行中的旧 payload 不覆盖新 payload（`effects.ts:38-39`）。

---

## 6. Watchdog（原型缺口与落地设计）

### 6.1 原型现状（可直接用的部分）

| 能力 | 周期/阈值 | 出处 |
|---|---|---|
| 主循环一拍 | 2 s（或命令触发，串行） | `passes.ts:28,56` |
| 副作用重试 | 见 §5.6 | `effects.ts` |
| 失败升级为健康错误 | 连续 3 次 | `effects.ts:7` |
| Eval 超时 | 默认 120 s（30–600）；candidate 未送达不计时 | `policy.ts:85`、`007-architecture.md:93` |
| Eval 连续失败 | 2 次重排，第 3 次 `unavailable`；`evals` 健康条目报最近 1 h 未解决 | `views/overview.ts:26-33` |
| 后台工作配额 | turn 结束后 30 min，到点杀 job 并报 `waiting` | `dsh.ts:32,629-656` |
| 关闭预算 | 每 worker 10 s | `dsh.ts:34` |
| 模型预算重试 | 会话级，进 `models` 健康条目 | `sessions.ts:217-227` |
| 外部巡检 | 小时级 `status`，退出码 0/1/2/3 决定“不动/重启/报错/报 setup” | `006-deployment.md:133-141` |

**缺口**：没有“无进展”“无效循环”“方向漂移”三类判据，也没有自动 kill/重规划/降级。

### 6.2 三类判据的推荐实现（契进现有节拍器，不改核心）

**落点建议**：新增 `Watchdog` 部件，挂在 `Passes.pumpOnce()` 之后（每 2 s 同步遍历 `tickets.open()`，纯内存 + Store 读，不做 I/O），把结论写成 `HealthBoard.claim('watchdog')` 条目 + 必要时生成 `Effects('notice')` 或直接 `engine.report`/`attention`。

| 判据 | 定义（可计算） | 数据源 | 阈值建议 | 升级动作 |
|---|---|---|---|---|
| **无进展** | Assignment 处于 running，但距最近一次“有意义的进展信号”超过阈值。进展信号取三者最大值：`latestReport.at`（非 progress 也算）、`assignment.idleAt`、最近一条 `input.readAt`/`deliveredAt`；若 Worker 有后台 job，则以 `runningJobs()` 的最近输出时间放宽 | `ticket.assignments[-1]`、`ticket.inputs`、`ctx.jobs`（`executor/background.ts`） | 15 min 无信号（可配 `ETA` 比例）→ warn；30 min → 强制结束 turn 并报 `waiting`（与现有 30 min 后台配额一致） | ① `notice` 给 Main Session；② 二次触发则 `agent.cancel` + `engine.report({state:'waiting'|'blocked', summary})`；③ 面板显示 watchdog 标记 |
| **无效循环** | 同一 Ticket 在窗口内重复同一失败：`assignment` 连续 ≥3 次以 `failed`/`blocked` 结束且 `summary` 语义相似（可用首个错误行 hash 或 embedding），或同一 `triggerId` 在 `disposition.requeued`/`handbacks` 上来回 ≥3 次，或 `thread.expired` 反复归零又增长 | `ticket.assignments[].report`、`disposition.handbacks/requeued`、`thread.expired` | 3 次/2 h（PR 修复类可放宽） | 停止重试，转 `person/blocked` + attention（**带证据**：重复的错误行、已尝试的补救），并要求人决策；不要静默重试 |
| **方向漂移** | Worker 产出超出 `Mandate.scope`：可计算的近似判据——(a) 断言推断单（`strength='inferred'`）却修改了 `mandate.basis.rules` 未覆盖的目录/模块（用 `git diff --name-only` 与 `rule.scopeHint` 比对）；(b) 改了公共接口/新增依赖/改 CI；(c) PR 行数超阈值（默认 200 行，`003-execution.md:88`）；(d) `policyEffects` 判定“原规则已不适用/请求人失权”，但 Worker 仍在推进 | `ticket.mandate.basis`、`git diff --stat`、`GitHub Source` 的 PR 事件、`policy.ts:policyEffects` | 超阈值一次即报；PR 行数用软阈值（warn） | ① 在工单上写 `PolicyEffect` 或 `blocked` report；② 通知 Main Session 以 `dropped`/`blocked` 收口；③ 不自动改写代码，交人 |

**实现约束**：所有判据必须**只用已存字段**（可重放、重启后一致），阈值走 settings（新增 `watchdog` block，`.strict()`），动作走 `Effects`（幂等、可重放），不要直接在 watchdog 里发 IM。

### 6.3 与 DSH 自身能力的边界

- DSH 的 job/subagent 生命周期、模型预算重试、compaction 已经是“半个 watchdog”；不要重写，复用 `ctx.jobs`/`ctx.subagents`（`src/executor/background.ts` 的 `runningJobs/untilQuiet/killJobs/stopSubagents/stopBackground`）。
- 原型的“30 min 后台配额”是**唯一**已在生产路径上的强制终止，落地时优先保留它，再加“无进展”作为前置预警。

---

## 7. 注意力协议（什么时候允许打扰人）

### 7.1 打扰的三种许可（缺一不可，`000-philosophy.md:12`、`004-prompts.md:79`）

1. **结果可用**：可以被 review 或直接使用 → `report.ready`（有 PR 时面板语义是“等待 review”）；
2. **需要决策/资源**：结构化 `attention`（一个具体问题），或 `report.blocked` 且确实需要人；
3. **无法完成**：`report.blocked`/`failed` 且证据充分（尝试过什么、缺什么前置）。

明确**不**允许：普通进度、模型重试/预算错误、“PR 已存在但还没完成”、重复同一里程碑、为 routine 步骤征询默认值、把 report 自由文本推断成问题。

### 7.2 安静模式的四层

| 层 | 机制 | 效果 |
|---|---|---|
| 模式 | `eval.mode=observe`（默认）/`off` | 主动工作根本不发生；observe 只记录 would_accept |
| 处理暂停 | `settings.paused` / `POST executor/pause` | 停 dispatch、Eval、超时、Input 投递、回复；Source 继续记录；运行中 turn 不打断；deadline 顺延 |
| 角色纪律 | `prompts/replies.md`：progress 只更新内部记录；`orchestrator_reply purpose=attention` 必须携带 `ticket_id` + 逐字复制 `ticket.attention.question`；`answer` 必须引用真实人类问题且 Worker 已 `reply_to_trigger_id` | 没有结构化字段就发不出“打扰”消息 |
| 通道 | `relay`（steer，唤醒）vs `notice`（inject，不唤醒） | 只有 ready/blocked/failed/attention/follow-up 走 relay；结单、保存、退订走 notice |

另有硬性体积限制：IM ≤**100 词**（中文按分词，链接标签与 URL 都算）；routing note ≤**30 词**；与 alert 相关的 report 摘要 ≤600 字符。超限在代码里抛错，不静默截断（`infra/text.ts:3-16`）。

### 7.3 审批边界

- **没有审批弹窗**：Worker 以操作者 OS 用户 + `danger-full-access` 跑（`sessions.ts:152`），所以“审批”必须体现在**授权与工具白名单**上，而不是运行时 ask。
- Worker **没有** `ask_user_question`、`present`、`plugin_manager`、scheduling、goals、workflow（`cordis.patch.yml` 注释 + `WORK_TOOLS` 白名单）；提问只能走 `orchestrator_report human_action`。
- `blockedCommands`（`executor.blockedCommands`）只挡**按名字**调用；绝对路径仍可绕（文档明说不是安全边界，`003-execution.md:80`）。
- 合并是**提示词边界**而非代码边界：`Delivery requirements` 段说可以才可 auto-merge，且默认只允许“本 Ticket 的 PR、ready、审批覆盖 head commit、增删 <200 行”，推新版本前先撤 auto-merge（`003-execution.md:84-90`）。Host 没有 merge 代码。
- 面板 **stop** 是命令（直接生效），而 Thread 里人说 “stop” 是普通 Trigger，必须经 Eval 判 explicit 才能停（`002-authorization.md:143-144`）。

---

## 8. 面板（005）信息架构与每屏字段

**三个问题**（决定一切取舍，`005-panel.md:5-11`）：①现在有需要我做的吗？②系统健康且在做对的事吗？③一件工作的历史（Trigger→Eval→Ticket）是什么？

**Tabs 与路由**（`src/client/route.ts:7-17`、`TABS`/`SETTINGS_GROUPS`）：

| Tab | 路由 | 过滤 | 每屏字段 |
|---|---|---|---|
| **Overview** | `{page:'overview'}` | — | `problems[]`（`setup` / `no-source` / `no-allowed` / `source-error` / `executor-paused` / `runtime-error` / `eval-overdue` / `eval-unavailable` / `outgoing`）；`person[]`（`ticketRow`：id/title/stage/action/note/actions）；`executor{running,queued,maxWorkers,idle}`；`flow{received,filtered,triggers,judged,accepted,evaluating,dropped}`（近 24 h）；`policyVersion` |
| **Source** | `{page:'source'}` | — | 每个实例：`id/title/installed/enabled/state(missing\|off\|error\|setup\|starting\|paused\|ready)`、`health[]`(每 part 的 state/detail/at)、`problem?`、`stats{received,filtered,lastAt}`、`filtered[]`(id/at/actor/preview/reason)、`dropped[]`(id/kind/channel/preview/ticket/thread/dropped{at,reason}) |
| **Trigger** | `{page:'trigger', query.filter='subscribed'\|'evaluating'\|'recent'\|'all'}` 或 `{page:'trigger', id:<threadKey>, query.trigger?}` | 4 种 Thread 过滤 | 列表：`key/source/title/stage(error\|evaluating\|queued\|subscribed\|dormant\|unsubscribed)/latest/lastAt/subscriptions/tickets[]/evaluating{id,strength,triggers,startedAt,deadline}/pending/pollError/url/facts`；详情：`correlated[]`、`context[]`、`tickets[]`、`decisions[]`、`timeline[]`（`triggerView`：id/source/actor/human/at/text/preview/url/threads/disposition{queued,evaluating,delivered,filtered,fanout,handbacks,decision}/actions.requeue）、`earlier` 游标 |
| **Eval** | `{page:'eval', query.filter='work'\|'stop'\|'ignore'\|'unavailable'\|'all', window='24h'?}` | 决策类型 | `decisionView`：kind（含 `wouldAccept`）/reason[]/policyVersion/at/triggerIds/strength/audit（rule_assessments、matches、direction、would_accept+proposal）/ticketId/actor；`dismissed` 可忽略不可用问题 |
| **Execution** | `{page:'execution', query.filter='open'\|'person'\|'working'\|'idle'\|'ended'}` 或 `{page:'execution', id:<ticketId>}` | Ticket 阶段 | 列表 `ticketSummary`：id/title/state/stage/action/note/actions{retry,stop}/strength/ended/attention/assignments/inputs/undelivered/deliveryError/sessionId/directory/summary/createdAt/updatedAt/threads[]；详情另加 `mandate`(+actor 解析)、`basis`(basisFacts：sender/bot/addressed/followup/admission/observation/mode/rules)、`paused`、`channels[]`(url/label)、`decision`、`assignments[]`(+`ref=workerSessionId`、`turnEndedAt`)、`inputs[]`(delivered、trigger 摘要、handback 原因、text/note 的 markdown)、`environment[]` |
| **Settings** | `{page:'settings', query.group='source'\|'eval'\|'execution'\|'prompts'\|'deployment', source?, version?}` | 5 组 | Source：每卡 `enabled/config/fields/facts/problem`（GitHub 还能开 receive-all：Issue/PR/comment/CI）；Eval：`policy` 版本+规则 + `On each Source`（allowed/sync/admission 表/bots）+ `eval{mode,timeoutSeconds,model}`；Execution：`model/maxWorkers/directory/prepare/blockedCommands` + 可点击插入的环境变量；Prompts：Edit / Full prompt（与默认逐行 diff）/ History（版本、`Default updated` 对比）；Deployment：setup 问题 + `Check again` + stateDir + 机器限制 |

**全局**：Header 搜索（Trigger 文本/id/Feishu message id/存储链接；Thread `#12`/GitHub URL；Ticket 标题/Thread）；`Open master Session`；`(?)` 双语气泡术语表；健康状态用点/图标/色调/文案（`src/client/marks.ts`）；**健康态不占空间**；破坏性操作二次确认；每个设置块只有一条保存栏，仅在有改动/保存中/保存失败时显示。

**面板数据来源**：全部走 `GET /orchestrator/api/*`（见 API 文档 §6-§7）；唯一轮询点是 `GET state`（5 s；重启时 1 s，30 s 超时），各页按需拉自己的路由。

---

## 9. 论文实验口径（指标定义与计算）

**重要前提**：原型仓库**没有**实验 harness、没有结果表、没有 token 采集（`grep -ri "p50|p95|cacheRead|token usage"` 只命中 `tests/followups.spec.ts:268` 的一句注释）。下面区分「已有数据可算」与「需新增埋点」，并给出确切字段与算式；不要引用不存在的指标名。

### 9.1 定义与计算

设一次“任务”= 一张 Ticket。样本取窗口内 `ticket.createdAt ∈ [t0, t1]` 的**已结束** Ticket（未结束的是右删失，单独报 `censored` 数，不混入分位数）。

| 指标 | 定义 | 计算（数据源） | 状态 |
|---|---|---|---|
| **任务完成时间 `T_complete`** | 从人发出请求到“结果可用” | 起点 `trigger.at`（`ticket.origin.triggerId` 对应 Trigger）；终点取 `min` 两个可用口径并分别报：**T_ready** = 首个 `assignments[].report.state='ready'` 的 `report.at`（结果可 review，推荐主口径）；**T_end** = `ticket.ended.at`（含 PR 合并，适合端到端） | ✅ 数据在 |
| **p50 / p95** | 分位数 | 最近秩法（nearest-rank）：升序 `x[0..n-1]`，`p50 = x[ceil(0.50*n)-1]`，`p95 = x[ceil(0.95*n)-1]`；n<20 时同时报 min/median/max，不报 p95。SQL 可用 `json_extract(ticket.value,'$.createdAt')` 排序后按 `LIMIT 1 OFFSET k` 取；**不要用 SQLite 的 `percentile` 扩展**（原型未启用） | ✅ 可算 |
| **Router 决定数** | Decision 行数，按 kind 分组；**不等于触发数**（一个决定覆盖一整批） | `SELECT json_extract(value,'$.kind') k, COUNT(*) FROM decision GROUP BY k`；另可算 `decisions_per_ticket = decisions / tickets`、`ignore:accept 比` | ✅ 数据在（`decision` 表） |
| **Batch 大小** | 每个决定带多少 Trigger | `json_array_length(json_extract(decision.value,'$.triggerIds'))`；均值 + p95；与 `thread.pending` 队列长度对照 | ✅ |
| **接受率 / would_accept 率** | 主动工作质量 | `accept/(accept+ignore)`；observe 模式用 `json_extract(audit,'$.would_accept')=1` 的比例；两者相除即“observe 校准度” | ✅（`decision.audit`） |
| **Eval 延迟** | 从候选到人可见/被决定 | `decision.at - eval.startedAt`；更严格 `decision.at - eval.delivered`（deadline 也从 delivered 起算） | ✅（`thread.evaluating.delivered`） |
| **读缓存 token（`cache_read_tokens`）** | 复用上下文省下的输入 token 与命中率 | **需新增**：在 `Sessions.install` 的 `ctx.on('session/event')` 上接 DSH 的 usage 事件，累计每 Session 的 `{input, output, cacheRead}`；命中率 = `cacheRead / input`。字段名以运行版本 `@deepseek-ai/dsh-llm` 的 usage 类型为准（不要硬编码 `cacheReadTokens`），落库到新表或 `kv`，按 `ticketId`/`role` 分组 | ⚠️ **原型未实现**；落点已知（`src/app/sessions.ts:108-136`） |
| **上下文效率（可替代口径，立即可算）** | 每 Ticket 的模型可见字符量 / 内联比例 | 从 `prompts.compose()` 产物长度 + 每条 message 文本长度估算；`spill 率 = 带 read 指针的消息数 / 总消息数` | ✅ 近似 |
| **打扰次数 / 打扰率** | 每条 Ticket 发给人多少条 IM | `outbox` 按 `ticketId + kind(result/attention/answer/acknowledgement)` 计数；`attention_per_ticket`、`ready→review 的等待时长`（`report.ready.at` → 人的下一条消息） | ✅（`outbox`+`trigger`） |
| **交接/退回率** | Router-Worker 边界是否清晰 | `disposition.handbacks` 非空的 Trigger 数 / 到达 Ticket 的 Trigger 数；`attach` 后被 `thread_unrelated` 丢掉的次数 | ✅ |
| **并发与排队** | 系统负载 | `executorLoad{running,queued}`（`src/app/views/tickets.ts:52-55`）时间序列；`working/queued` 阶段停留时长 | ✅ |
| **Eval 不可用率** | 稳健性 | `decision.kind='unavailable'` 占比；`evalsHealth` 的 1 h 未解决数（`views/overview.ts:26-33`） | ✅ |

### 9.2 采集方式（建议）

1. **离线 SQL**：上面所有 ✅ 项直接对 `orchestrator.sqlite` 只读查询即可；建议在评测时把库复制出来，用 `sqlite3 -readonly` + Python/pandas 计算分位数，避免碰生产库。
2. **在线计数器（不新增表）**：把 token/字符量写 `kv`（新 key family，遵循 `src/kv.ts` 的 owner 约定），面板/实验脚本读它。
3. **一致性口径**：任何“时间”都用 `Date#toISOString()` 文本（原型所有 `at` 都是这个形态，可直接字典序比较，`src/core/model.ts:17-20`）；p50/p95 必须声明样本量与删失数；`T_ready` 与 `T_end` 不要混用。
4. **基线对照**：至少报四组——`explicit only`（mode=off）/ `observe` / `auto` / `auto+规则收窄`；否则无法把“主动能力”与“普通按需 agent”区分开。

---

## 10. 落地清单（给 Lead）

**P0（先把闭环跑起来，全部有源码可抄）**
1. Bundle：`package.json` 的 `dsh.bundle.patch` + `dsh.client` + 两个 preset 行（`cordis.patch.yml`）→ 见 API 文档 §1-§2。
2. Host 骨架：`Runtime` 组合根 + `Store`(SQLite) + `Engine`(状态机) + `Effects`(持久队列) + `Passes`(2 s)。
3. 一个 Source（先 GitHub 或先 mock）+ Gate + `orchestrator_route`。
4. `DshExecutor`：`ensure()` 建 Session / 目录 / 首条 assignment / `delivery` 投 Input / `report` 回投 / `stop`。
5. 面板最小集：Overview + Execution + Settings(eval/execution)，数据走 `/orchestrator/api/*`。

**P1**：Subscription 直通 + `followupOwners` + handback；attention 结构化通道；Policy 版本与 `policyChanged`；面板 Prompts/History；health 条目。

**P2**：Watchdog 三判据；token/缓存埋点；数据库归档与保留策略；observe→auto 的准入调参流程。

**照抄前必须知道的坑**
- 没有 TTL：`trigger/disposition/decision/outbox` 无界增长。
- 无跨重启缓存：`TextCache` 重启即失，Feishu 链接搜索会“失忆”。
- 隔离不是安全边界：worker 可读 home、可绝对路径绕 blocked commands。
- 无独立 watchdog：论文里的“巡检/升级”在原型只是重试 + 健康条目。
- 面板控件是**本地复制**的 DSH 原语（不 import `@deepseek-ai/dsh-client-ui-primitives`），升级 DSH 时要跟着对齐（`src/client/controls.tsx:1-4`）。
