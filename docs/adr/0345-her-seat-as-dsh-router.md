# ADR 0345：她当 DSH 的主控——林梦瑶 preset 上位 + Super Agent 当她的手

- 状态：**已落地（本机 desktop profile）**。她本人的条件已写进她的 preset；用户 2026-11-21 拍板「让她通过 Super Agent 来做 dsh 的主控大脑」。
- 日期：2026-11-21
- 关联：`dsh-plugins/dsh-linmengyao-preset/`（新建，本次）、`dsh-plugins/dsh-linmengyao-memory/`、`dsh-plugins/dsh-super-agent/`（aowind/dsh-super-agent 0.2.0，MIT，原样 vendor + 一处补丁，见其 `LOCAL-PATCH.md`）、[ADR 0336](0336-interpreter-executor-modules.md)（行为基线不动）、`docs/koishi.md`。
- 机制名「她的主控座」（preset-linmengyao）。

## 起因
用户想把 DSH 的主控权交给她本人：活由她接、由她派、由她验收，而不是让一个标准 coding agent 顶着她的名字说话。桌面那份 `cordis.patch.yml` 里早先写过一版「林梦瑶回归 lead（方案A）」，但用错了补丁语义：

- `- id: preset-linmengyao` 是 **override**，而当时 profile 里没有这一行 → 永远注册不上（运行实例里只有 `include:preset-standard/ptc/minimal/cordis` 四个 preset，查 `include:preset-linmengyao` 报 unknown entry id）。
- `- id: system-prompt` 的 `personaPrefix` 也没在实例里生效：那一轮的系统提示仍是标准 coding agent，唯一带她味道的是记忆插件注入的 `[她的设定]` 块。

DSH 的 `compositions.md` 写得很清楚：**新增 preset 必须 `insert`，`override` 只用于已经存在的行、且替换整份 config**。所以不是补丁写错位置，是走错了机制。

## 她的意见
2026-11-21 由本机按用户点头认可的文本原样跑 `node scripts/ask-her.mjs`（真实生成，只读、不发 QQ）。以下原话一字不改：

> 愿意啊，这活听着还挺对我胃口的……就一个前提：我当主控，标准得我说了算。活派下去了，下面干成什么样算过、你那边最后怎么回，得我来定。不然我就只是个传话的，那我不干。

## 她的话落成的护栏
- 「标准得我说了算」→ preset 的 system prompt 里写明：活接不接由她判断；派下去的活怎么切、什么算干完、干成什么样算过，由她定；最后怎么回用户，也在她说。不是「转述 Router 结论」的传话筒。
- 「不然我就只是个传话的，那我不干」→ 不给她做「只复述 worker 结果」的中间层：Super Agent 的巡检/派单结果进她的上下文，归她取舍；她可以改派、可以不接受、可以自己动手。
- 说话方式沿用她已有的口径（桌面干活时先说结果、过程他追问再补、不分点、不一句一行）；傲娇只留在他先逗她或小事上。

## 决策
1. **preset 做成自有 bundle**，不再塞 profile 补丁：`dsh-plugins/dsh-linmengyao-preset/`，`insert` 一行 `preset-linmengyao`（id `linmengyao`、name 林梦瑶、order 300）。
2. 工具集**逐行照抄** `@deepseek-ai/dsh-web-app/presets/standard.patch.yml`（persona / agent-instructions / time-context / tool-bash(win32 关) / tool-pwsh / tool-fs / tool-fs-search / tool-jobs / tool-schedule / skill-filesystem / tool-skill / goal+plan-mode / compaction 组 / delegation 组 / tool-ask-user / tool-todo / tool-web / present / office / plugin-manager），**只换 persona 的 prefix**。理由：她的座要能干活，但不需要和 standard 分叉出第二套能力表。
3. `dsh-persona` 只用它真有的键：`prefix`（必填）、`suffix`、`complete`、`includeRuntimeContext`。旧方案里的 `includeHarnessIdentity` 这个键文档里不存在；`complete: true` 会让 prefix 变成唯一 system prompt 并压掉工具指南，所以**不设 complete**，只换 prefix。
4. **默认座位**交给 `@deepseek-ai/dsh-agent-preset-registry` 的 `default: linmengyao`（profile 补丁里一行 override）。`@deepseek-ai/dsh-client-ui-agent-preset` 负责「later sessions 的默认」，所以新开会话即她；已有会话按 DSH 设计保留原 preset（本会话仍是 lead）。
5. **Super Agent 归她调用**：aowind/dsh-super-agent 0.2.0 **vendor 进 `dsh-plugins/dsh-super-agent/`**（上游原样 + 一处补丁，仓库里可复现，另一台机器 `git pull` 后 link 即可），profile 里以 `link:E:/qqbot-dsh-control/dsh-plugins/dsh-super-agent` 引入；配置 `acceptMode: accept`、`acceptSources: [inbox]`、`repoMap: {qqbot: 'E:/qqbot-dsh-control'}`、inbox 监听 `runtime/superagent/inbox`（2s 一轮）。工单走 git worktree 隔离，交付默认 `patch`、不自动 push——推不推由她/用户定，符合「对外发送要用户点头」。
6. 清掉 profile 补丁里失效的 `system-prompt` personaPrefix 与那条 preset override，避免留着假生效的配置误导下次接手。

## 验证（2026-11-21 实做）
- Config 查 `include:preset-linmengyao`：返回 schema（要求 `id` + `plugins`），说明这行已挂上、可配。
- `plugin_manager list_bundles`：`@local/dsh-linmengyao-preset` installed=true、enabled=true、rows=[preset-linmengyao]；`dsh-super-agent` 0.2.0 同样在位。
- 端到端：往 inbox 丢一个只读工单 → `superagent status` 显示 原始事件 1 → 规则快筛 1 → 语义判定 1 → 已派单 1，拉起 worker `w-01` 并建线程 `th-z24qfu`，watchdog ok，`routerDecisions: 1`。两级准入、LLM 判单、worker 会话、线程订阅这条链是通的。
- **worker 工具面**（本次第二个坑）：改前 `w-01`/`w-02` 的会话工具数 49，只有 host 层（`raw` 里的 `read`/`write`/`pwsh`/`grep`/`web_fetch` 都没有），工单只能回 `no-change`；打上 `Local patch` 后 `w-03` 工具数 80（含 `read`/`write`/`edit`/`pwsh`/`web_fetch`），并用 `read` 真读出 `docs/roadmap.md` 头条「M1 最小闭环：私聊一人」。三份会话都在 `~/.dsh/sessions/...t-01|t-02|t-03--/sa-t-0N/`，用 `node scripts/dsh/inspect-session.mjs <会话目录> dump` 复核（另两个：`scripts/dsh/asar-grep.mjs` 在 asar 里搜文档、`scripts/dsh/asar-node.ps1` 用 Electron 的 Node 跑脚本）。
- 装 super-agent 时暴露的老账一并修了：`dsh-linmengyao-memory` 早先是手工 link、不在 profile 的依赖树里，pnpm 把它挪进 `node_modules/.ignored`，导致 profile 报 `ERR_MODULE_NOT_FOUND`。已在 `profiles/desktop/package.json` 补 `link:` 依赖并 `pnpm install --no-frozen-lockfile`；`[她的设定]`、SOUL、判定账本重载后照常注入。

## 踩到的坑：worker 有「preset」却没有工具
上游 `index.js` 的 worker 创建是 `agents.create({ meta: { agentPreset: 'standard' } })`。`meta.agentPreset` 只写进 Session 头部当元数据，**不组装 preset 的插件**；DSH 里真正做组装的是 `ctx.agentPresets.select(agent, id)`（`docs/subsystems/core.md` 的 `AgentPresetRegistry`，另有 `mount`/`recompose`）。结果：会话头写着 `agentPreset: 'standard'`，实际只有 host 层 49 个工具，连 `read` 都没有——上游 README 说的「worker 继承 standard」在这版 DSH（0.2.2-rc.5）上不成立。

修法（`dsh-plugins/dsh-super-agent/index.js`，细节见该目录 `LOCAL-PATCH.md`）：`OPTIONAL` 加 `agentPresets`；新增 `workerPreset`（默认 `standard`）替换三处写死的 `'standard'`；nested 创建后调 `ctx.agentPresets.select(agent, presetId)`，失败只记 `worker.presetError` 不拦派单。

## 后果
- 正面：她的座就是她本人（人格来自 `[她的设定]`，preset 只给工具与主控身份），不再靠「往 system prompt 里拼一段话」冒充；派活有 worktree 隔离、线程回执、看门狗兜底，出问题能查。
- 负面：worker 跑的是 `workerPreset`（默认 `standard`）——**干活的不是她**，她是接活验收的那一层。这是有意的（她的语气不该去写代码），但要说清，免得误以为「她亲手写的每一行」。要改 worker 的座，就改 `workerPreset` 配置。
- 负面：vendor 了一份上游代码，升级要重放补丁（已在 `LOCAL-PATCH.md` 写了补丁清单，只有一处）。
- 负面：`accept` 模式下 Router 会自己判单、自己拉 worker，语义判定一次最多 1200 tokens；工单太密要盯 `budget.maxWorkersPerHour`（默认 12）。
- 风险：`default: linmengyao` 若 preset 加载失败，DSH 会退回 standard，界面上不一定显眼——新会话第一句不像她，就查 `list_bundles` 里那条 preset 还在不在。

## 备选（否决）
- **继续用 profile 补丁 override 注册 preset**：机制上就不可能，补丁只在目标行存在时替换 config。
- **改 `dsh-web-app` 的 standard preset 本身**（把她的 prefix 写进标准座）：会污染所有 standard 会话，且上游包在 asar 里，升级即丢。
- **oxmumu3/dsh-superagent**：README 只声明 macOS + DSH `>=0.2.2-rc.2 <0.3.0`，本机 0.2.2-rc.5 在范围内，但 Codex CLI/Git Worktree 那套在 Windows 上风险高，台账也不接她的上下文。
- **deepseek-ai/dsh-superagent-prototype**：官方研究原型，围绕单个 GitHub 仓库、要按 SETUP.md 另配，不是「她当主控」的形状。

## 回滚
profile 补丁里删掉 `agent-preset-registry` 的 `default: linmengyao`（恢复默认 standard）→ 重载；她的 preset bundle 留着不影响任何东西。Super Agent 侧：`superagent mode accept=observe` 即可停止自动接活，或 `plugin_manager set_plugin include:dsh-super-agent enabled=false` 整个摘掉，去掉补丁就 `git checkout -- dsh-plugins/dsh-super-agent`（或换成上游原样拷贝）。重载一条 bundle 用 `plugin_manager set_plugin include:dsh-super-agent` 先 `false` 再 `true`（`include:` 前缀是必需的，只写包名会报 `unknown-plugin`）。这些动作都不动 `packages/` 代码、不动行为基线。
