# Super Agent on DSH · 构建与验收记录

> 日期：2026-11-09 ｜ 环境：DeepSeek Harness 桌面版（profile `desktop`，GUI `http://127.0.0.1:<port>`）
> 依据：DeepSeek Harness 团队《Super-agent 设计探索：迈向更自主的 Agent 系统》（2026-10-31）与开源原型 `deepseek-ai/dsh-superagent-prototype`（MIT，v0.1.0，已克隆到 `the official prototype clone

## 1. 交付物

| 交付 | 路径 |
| --- | --- |
| Bundle（Host + Client 双半，免构建纯 JS） | [dsh-super-agent/](..) |
| Host 控制面（五模块本体，无 DSH import，可离线测） | [lib/engine.js](../lib/engine.js) |
| Host 适配层（会话创建/事件回灌/工具/HTTP/提示词段） | [index.js](../index.js) |
| 控制台 UI（侧栏图标 + 主面板 + 拓扑可视化） | [client.js](../client.js) |
| 离线断言（9 组） | [test/engine.test.mjs](../test/engine.test.mjs) |
| 前端数据契约 | [super-agent-ui-contract.md](./super-agent-ui-contract.md) |
| 原型蒸馏：架构档案 | [super-agent-architecture.md](./super-agent-architecture.md) |
| 原型蒸馏：DSH API 骨架与坑 | [dsh-api-patterns.md](./dsh-api-patterns.md) |

## 2. 论文架构 → 落地对照

| 论文模块 | 实现 | 验收证据 |
| --- | --- | --- |
| 双层 Router/Worker | `engine.tickRouter()` 只决策不执行；`engine.dispatch()` 为每张工单建独立 DSH Session（`sa-worker-<ticket>`），Worker 不直接对人说话 | 真机派单验证：`superagent_dispatch` → 会话 `sa-worker-t-01` 运行 1 回合返回 `OK`，Worker 记录 status=done |
| 两级触发器准入 | Fast Path：来源白名单/长度/闲聊模板/窗口去重（零 token）；Slow Path：一次模型调用判整批 | 真机 demo：`received 300 → fast-blocked 229 → 语义判定 19 → 派单 18`；慢筛真实调模型时给出逐条理由（见下面 5.2） |
| 订阅直通 | 线程有订阅者时后续消息直达 Worker，Router 不再决策 | 真机：`threads 18`，`routerBypassed` 逐线程累计；离线断言 `thread follow-ups go straight to the subscribed worker` 校验 Router 决策数不增 |
| 上下文缓存化 | 记录内联 `ticketId/threadId/sessionId` 链；600 字截断 | `normalizeEvent` 断言补齐；拓扑图线程轴即该链的可视化 |
| 持久在线 + Watchdog | JSON 快照 + 独立巡检：无进展 / 重复工具调用 / 步数涨而进度不动 | 离线断言 `watchdog reports a stall, not just liveness`；真机 148 次巡检 0 误报 |
| 注意力闸门 | `engine.attention()` 唯一出口，只放行 `result-ready / decision-needed / failed` | 真机：打扰 3 / 静默 15，克制比 5；离线断言 progress 一律静默 |
| 批处理与成本 | 合并候选为一批、按到达率自适应 batch | 真机：`router.decisions 229 / batches 10 / avgBatch 22.9`，单次决策均摊 1–3 s |

## 3. 实验口径复现（论文 vs 本机）

真机 `demo` 重放同一合成负载（300 条消息 / 20 个工作请求，模拟执行）：

| 指标 | 论文（Super-agent） | 本机实测 |
| --- | --- | --- |
| 任务完成时间 p50 | 12.4 分钟 | **12.6 分钟** |
| 任务完成时间 p95 | 15.7 分钟 | **15.7 分钟** |
| 单会话基线 p95 | 29.5 分钟 | 28.4–33.2 分钟（同口径采样） |
| 准入漏斗 | 未单列 | 300 → 229（快筛拦下）→ 19（语义）→ 18（派单） |
| 平均 batch / 单次决策摊销 | 1.0→2.8（40 条/分下） | avgBatch 22.9（回放速率下） |
| 读缓存 token | 2,323 万（会话级累计） | 97.7K（本机 18 个 Worker 会话累计，口径不同仅作趋势） |

> 「模拟执行」= Worker 以确定性脚本推进（不真跑模型），用于复现论文的漏斗、并发与指标口径，不消耗额度；真实执行走 `runner: session`。

## 4. 安装与运行态

- 安装：`plugin_manager install_bundle` → `application: applied`（bundles 记录 `dsh-super-agent@0.2.0`，`warnings` 仅来自既有 `remote-pair` 插件，与本包无关）。
- 链路自检：
  - `GET /api/super-agent/state` → 200（真机实测 51 KB 载荷）；
  - `GET /api/super-agent/health` → `{"ok":true,"state":"ready"}`；
  - `POST /api/super-agent/command` → `{"ok":true,...}`；
  - 工具 `superagent` 已进入本会话工具表（Tool.listTools 可见），`action=status/trigger/dispatch/mode/watchdog/demo/metrics/reset` 全部实现。
- **Client 注册（实时 Slot 台账）**：
  - `sidebar.panellist` 占位：`id=dsh-super-agent, order=12, active=true`；
  - `main` 占位：`key=dsh-super-agent, active=true`；
  - 注册与 HMR 去重：`mounted` 标记 + `ctx.slots.entries` 双保险。

## 5. 视觉验收

由于 Web GUI 需要 `dsh web` 打印的鉴权 URL（无头浏览器无法复用桌面端 cookie），视觉证据采用**同一份 `client.js` + 真实 React 18 + jsdom + 真实主题令牌**离线渲染，并喂入 `GET /api/super-agent/state` 的真机快照：

- 渲染器：probes/render-console.mjs（`--state <live-state.json>`）
- 证据图：probes/console-live.png（来自真机快照 `probes/live-final4.json`）
- 覆盖：架构拓扑（Router→准入→线程轴→Worker 泳道→注意力闸门，含流动点/订阅虚线/脉冲/卡住红抖）、准入漏斗、注意力预算、18 张 Worker 卡片、Watchdog 健康环、p50/p95 与单会话双条对比、事件流、控制条、在线状态条。
- 渲染断言：`superagent` 主面板与侧栏图标均注册成功；页面含全部 8 个分区；点击「重放论文实验」发出 `POST {command:"demo"}`；无 React key 警告（唯一告警是 harness 自身的 `ReactDOMTestUtils.act` 弃用提示）。

> 未做：真实 Electron 窗口内的截图与动画逐帧目视。侧栏图标与主面板的 Slot 台账已 `active:true`，页面若未显示，刷新一次 GUI 即可加载新的 Client 模块。

## 6. 过程中修掉的真实缺陷（都留了断言或复跑）

1. **Worker 会话无模型选择** → 回合开始即 `Cannot read properties of undefined (reading 'length')`。改为创建后 `selectModel` + 走 `sessionController.prompt` 投递。
2. **Remote 方法缺 signal** → `prompt`/`rename`/`selectModel` 直接调用抛 `reading 'throwIfAborted'`。统一传 `AbortController.signal`。
3. **超额工单被丢弃** → 改为排队等槽位，Worker 完成即出队（离线断言覆盖）。
4. **订阅直通缺失** → 线程跟随消息原会二次成单；现在直达订阅 Worker，Router 不介入。
5. **回放时慢筛打真实模型** → 回放期走确定性准入，回放结束后不再回落到付费调用（`demoHeuristicUntil` 窗口）。
6. **回放结束仍派真实会话** → 回放期内派出的工单一律模拟执行（`worker.demo` + linger 窗口），实测 18/18 模拟、0 个真实会话。
7. **ESM 模块缓存** → profile 重载后 `lib/engine.js` 仍是旧代码；改为带版本参数的动态 import，装包后可热重载。
8. **对照条形图恒为 0** → 无单会话实测时回落到论文基线（p95 29.5 分钟），并标 `estimated`。
9. **真实 Worker 用 `ptc` preset 会崩**（bare Session 无 UI peer，`run_code` 抛 `reading 'length'`）→ 创建时按 `standard → minimal → 默认` 逐级尝试，失败才退回 profile 默认；实测 `standard` 下真实工具任务通过。
10. **Worker 默认工作目录是 profile 目录** → 改为取「派单会话的 cwd」（工具调用方所在项目），`workerCwd` 配置可覆盖，最后才回落部署默认；实测 Worker 已在该会话的项目目录里读写。

### 6.1 真实作业验证（非模拟）

| # | 任务 | 结果 |
| --- | --- | --- |
| v1 | 回复 OK | done，1 回合 |
| v2 | 列 docs 下 md（preset=ptc） | failed，`run_code` 内部错误 → 触发修复 9 |
| v3 | 列 dsh-super-agent 顶层文件（preset=standard） | done，8 次工具调用 |
| v4 | 在项目根目录列 `*.md` 并汇报工作目录 | **done**，5 次工具调用，`cwd = ...\default-workspace`，正确报出根目录 2 个 md → 同时验证修复 9、10 |

## 6.2 无人值守扩展验收（2026-11-09 晚）

| 模块 | 离线证据 | 真机证据 |
| --- | --- | --- |
| 事件源 `lib/sources/` | `node lib/sources/selftest.mjs` → **13/13**：inbox 幂等/改名/坏文件、GitHub 游标与重启不重放、429 退避、webhook 签名正负例、CI 失败解析 | `POST /api/super-agent/hook` 送 CI failed：解析为 `source=ci`、`threadId=ci:acme/demo:ci`，经真实模型慢筛准入通过（决策 3182ms），observe 模式只记录 |
| 工单隔离 `lib/worktree.js` | `node test/worktree.test.mjs` → **6/6**：两工单互不可见、主工作区保持干净、复用、登记表、非 git 目录返回 null | Worker 在 `…/storages/super-agent/worktrees/repo-cfaea4c8/t-05` 独立工作树改 README；主仓库 `git status` 为空、分支 `sa/t-05` 存在于主仓库 |
| 交付闭环 `lib/delivery/` | `node lib/delivery/selftest.mjs` → **57/57**：真实 bare remote 的 push、patch 在干净 clone 上 `git apply --check --binary`、PR REST 顺序与假 fetch、无 token 降级、git 失败不抛 | 真机交付：`status=patch`、commit `fb406ae`、`changedFiles=[README.md]`、patch 189B 且 `git apply --check` 通过、PR 草稿产出；`app.txt` 未被改动 |
| 无人值守保障 | `node test/engine.test.mjs` → **12/12**：新增「工作树 + 完成后自动交付」「每小时预算熔断」「acceptSources 分源放行」 | 控制台暂停状态会导致 Router 停止决策（本轮实测发现并恢复），说明暂停开关真实生效 |

已知外部前提：

- **自动开 PR 需要 GitHub token**（`delivery.githubToken` + `delivery.mode=pr`）。本机没有 `gh`、也没有 token，所以 PR 路径只在 selftest 里用真实 git + 假 REST 验证过；PR 草稿模式不需要任何凭据，已真机跑通。
- **GitHub 轮询源**同样需要 token 才能稳定（无 token 额度 60 次/小时，一个 issue 一轮就 1 次请求），代码与游标已用假 fetch 验证；未做真网真 token 验证。
- **inbox 源**未在真机启用（未改 profile 配置），但 selftest 13/13 覆盖其全部行为。

## 6.3 跨仓库并行 + 交付闭环（真机，2026-11-09 23:3x）

两个真实 Worker 同时派到两个独立 git 仓库：

| Worker | 仓库 | 工作树 | 分支 | 交付 | 变更 |
| --- | --- | --- | --- | --- | --- |
| w-13 | `<scratch-repo> | `…/worktrees/repo-cfaea4c8/t-13` | `sa/t-13` | `patch`（commit 799798a） | `app.txt`：version 1→2 |
| w-14 | `<scratch-repo> | `…/worktrees/repo-b-b9d1d539/t-14` | `sa/t-14` | `patch`（commit 7388ae2） | 新增 `NOTES.md` |

验收断言（全部实跑）：

- 两个会话都在 `standard` preset、各自工作树目录下创建（`created=true`、`sessionCwd=worktree`）；
- 两个仓库主工作区 `git status --porcelain` 均为空 —— 改动只发生在工作树里；
- 两份 patch 分别在各自仓库 `git apply --check` 通过，内容与需求一致；
- 交付产物齐全：`artifacts/t-13.patch`、`t-13.pr.md`、`t-14.patch`、`t-14.pr.md`；
- 预算护栏在真机触发过一次：`每小时工单上限 12 已用完`（随后经 `config` 动作调到 40 完成并行测试，再调回 12）。

同期修掉的真实缺陷（都留了记录）：

1. **`resolveAgent` 会先物化会话**，之后再 `create` 会抛 `belongs to <profile dir>` / `already started`，导致 Worker 落在 profile 目录、preset=ptc 并崩；正确顺序是 **先 `workspaceRegistry.create(cwd)` 再 `create({sessionId, workspaceId, agentPreset})`**。
2. **ticket 计数器跨重启未恢复** → 复用了上一进程的 Worker 会话；`restore()` 现在同时 seed `w` 与 `t`。
3. Worker 会话 id 前缀改为 `sa-<ticket>`，避免历史 id 被别的目录锚定。

## 6.4 无人值守运维

- `superagent` 工具新增 `action=config`：通过 Host 的 `configEditor` 把配置写回本行（会重启插件），真机验证可即时调整 `budget.maxWorkersPerHour`、`sources.*`、`delivery.*`。
- `POST /api/super-agent/command {"command":"config","config":{…}}` 提供同样的能力（控制台/脚本可用）。
- 暂停开关真实生效：控制台 `暂停` 后 Router 停止决策（本轮实测 `paused=true` → batches 不增长；恢复后立即决策）。

## 6.5 无人值守全链路（真机，2026-11-10 00:0x）

配置：`acceptMode=accept`、`acceptSources=['inbox']`、`delivery.mode=patch`、`budget.maxWorkersPerHour=12`，inbox 源监听 `<stateDir>/inbox`。往目录里丢三个 JSON 触发器，不做任何人工操作：

| 工单 | 来源 | 工作树/分支 | Worker 结果 | 交付 | 回贴 |
| --- | --- | --- | --- | --- | --- |
| t-01 | inbox | `repo-b/t-01` · `sa/t-01` | 真实模型，1 回合，改 `main.py` | `patch`（commit f948a13） | `outbox/t-01.json` |
| t-02 | inbox | `repo/t-02` · `sa/t-02` | 改 `app.txt` version→3 | `patch`（commit 2886682） | `outbox/t-02.json` |
| t-03 | inbox | `repo-b/t-03` · `sa/t-03` | 新建 `CHANGELOG.md` | `patch`（commit 17cb48d） | `outbox/t-03.json` |

链路：`inbox 文件 → 扫描 → 真实模型准入（3/3 通过，2.3–3.2s）→ 派单 → 独立工作树 → Worker 执行 → 提交+patch+草稿 → 回贴 outbox`。控制台三项指标同步：漏斗 3→3→3→3、注意力打扰 3/静默 3、p50 1.0 分钟 / p95 2.9 分钟。

**push 模式也真机验证过**：给一个本地 clone 配 bare remote、`delivery.mode=push`，同一 inbox 链路交付后 `status=pushed`，bare remote 的 `refs/heads/sa/t-17` 与返回的 commit 完全一致（83bec54）。同时修掉了「本地路径仓库一律 patch-only」的过严判断：现在判据是**有没有配置 remote**，而不是 repo 是不是本地路径（`lib/delivery/selftest.mjs` 相应改为 56 项并全绿）。

**回贴通道**：`lib/sources/reply.mjs`（9/9 离线）——inbox 工单写 `outbox/<ticket>.json` 回执，GitHub 工单在给到 token 时 `POST /repos/{repo}/issues/{n}/comments`，无 token 记录为未投递但不影响交付。

**GitHub 轮询源真网验证**（无 token，公开仓库 `openai/openai-node`，一次轮询 9 个请求）：

```
first poll: 12 events   →  threadId=github:openai/openai-node#3124、#3050…，含 bot 过滤
second poll: 0 new events                      （游标去重）
fresh instance on same stateDir: 0 new events  （重启不重放）
```

脚本：`probes/github-source-live.mjs`；抓到的 12 条事件样本：`probes/github-live-events.json`。

## 6.6 侧栏污染修复（2026-11-10）

问题：早期实现为每张工单 `workspaceRegistry.create(worktreePath)`，结果侧栏多出 10 个 `t-01…t-17` 工作区 + 一批「未分组对话」（69 个 `sa-*` 会话）。

修复：

- Worker 改为**嵌套子代理**：`agents.create({ meta: { cwd, parentSession, origin: 'subagent', delegationDepth: 1, agentPreset: 'standard' } })`，父会话是派单的会话（工具派单）或唯一的 `sa-manager`（无人值守）；不再调用 `workspaceRegistry.create`。
- 唤醒方式随会话类型分流：嵌套子代理用 `agent.followup`（首次失败再试 `subagents.sendMessage`），独立会话才用 `sessionController.prompt`。
- 新增 `cleanup` 动作（工具 + `POST /api/super-agent/command`）：归档 `sa-*` 会话、删除 `<stateDir>/worktrees` 下的工作区。

真机验证：

```
cleanup: workspacesDeleted=10, sessionsArchived=69, errors=[]
再次 cleanup: workspacesDeleted=0, sessionsArchived=73（幂等）
工作区列表恢复为用户原有 10 个：default-workspace / 3d-game / idle-wuxia / G-plat / OCC-Game / pockman-game / hill-sea / soul stone / idle-core / desktop
新派单 w-06 / w-07：nested=true、会话 origin=subagent、工作区数量保持不变（10）
w-07 仍在独立工作树 sa/t-07 里改 NOTES.md，交付 patch（commit d02cea8），主仓库干净
```

## 7. 已知边界

- **复杂真实作业**：在 `standard` preset + 项目目录下，真实工具任务已通过（v3/v4，见 6.1）。仍未验证的是「多轮长任务、跑测试并改代码、失败自动重试」这类重型作业；`ptc` preset 仍不可用（会命中 DSH 内部 `run_code` 错误），Worker 固定走 `standard`/`minimal`。
- **Source**：目前入口是控制台 / `superagent` 工具 / `POST /api/super-agent/hook`；GitHub 与飞书的轮询适配层未接入（`engine.ingest` 是唯一入口，可按原型 `src/sources/*` 补）。
- **鉴权**：`/api/super-agent` 与 GUI 同端口、同进程，仅监听回环；未额外加 token 校验（与宿主一致）。
- **成本**：`accept` 模式下每个工单是一个真实 DSH 会话，会消耗额度；`maxWorkers`、`staleAfterMs`、`observe` 默认值就是刹车。
- **动画**：SMIL 流动点与脉冲在 jsdom 中不执行（截图静止）；真实浏览器中的动效未逐帧验收。

## 8. 复现命令

```sh
# 离线控制面断言
node dsh-super-agent/test/engine.test.mjs          # 9/9

# 真机状态
curl -s http://127.0.0.1:<port>/api/super-agent/state | head -c 400

# 回放论文实验（模拟执行，约 70 秒出全量指标）
curl -s -X POST -H 'content-type: application/json' \
  -d '{"command":"demo","args":{"triggers":300,"work":20,"speedMs":25}}' \
  http://127.0.0.1:<port>/api/super-agent/command

# 用真机快照重渲染控制台并截图
node probes/render-console.mjs --state probes/live-final4.json
```
