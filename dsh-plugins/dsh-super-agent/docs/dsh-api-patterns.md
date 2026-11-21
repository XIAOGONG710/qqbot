# DSH 插件 API 模式手册（从 dsh-superagent 原型抄出的可复用骨架）

来源：dsh-superagent-prototype v0.1.0（MIT）

归档对象：`the official prototype clone (deepseek-ai/dsh-superagent-prototype, MIT)`（git `8c32a9d`）。所有 `文件:行号` 对应该 checkout；代码块是从源码摘出的**骨架**（删了业务分支，保留 import 路径、调用签名与关键注释），可直接作为 Lead 落地时的起手模板。

阅读顺序：§1-§3 是“插件怎么被加载”，§4 是“怎么建并驱动一个 Worker 会话”（最关键），§5-§6 是扩展面，§7-§8 是面板，§9 是 Windows 坑。

---

## 1. 版本与引擎要求

`package.json`（`package.json:53-56`）：

```json
"engines": { "node": "^22.19.0 || >=24.0.0", "dsh": "^0.2.1-alpha.2" },
"packageManager": "pnpm@11.7.0"
```

- `engines.dsh` 是 **DSH 版本闸门**：安装时 DSH 会检查，超出范围会被拒/警告（`006-deployment.md:272`）。原型实测安装的是 `@deepseek-ai/dsh@0.2.1-rc.3`（`006-deployment.md:76`），它满足 `^0.2.1-alpha.2`。
- `type: "module"`，`main: lib/index.js`，`types: lib/index.d.ts`（`package.json:8-10`）。
- 运行时依赖只有两个：`proper-lockfile@4.1.2`（stateDir 目录锁）和 `zod@4.4.3`（所有配置/工具/评估 schema）。UI 用 `react@18.3.1`（devDependency，client bundle 不打包）。
- peerDependencies 就是**允许用的 DSH 服务清单**（`package.json:62-86`），落地时按需裁剪；与本手册相关的核心包：

| 包 | 用来做什么 |
|---|---|
| `@deepseek-ai/cordis@4.0.5-alpha.1` | `Context`/`Service`/`ctx.effect`/`ctx.inject`/事件 |
| `@deepseek-ai/dsh-agent` | `Agent` 类型、`agent.ctx.*`、`agent.inject/steer/followup/cancel/whenIdle` |
| `@deepseek-ai/dsh-api-session-controller` | `ctx.sessionController`：`resolveAgent/create/rename`、`modelCatalog` |
| `@deepseek-ai/dsh-session-persistence` | `ctx.sessionPersistence.flush()/open()` |
| `@deepseek-ai/dsh-workspace` | `ctx.workspaceRegistry.create(cwd)` |
| `@deepseek-ai/dsh-permission-presets` | `ctx.permissionPresets.set(session,'danger-full-access')` |
| `@deepseek-ai/dsh-system-prompt` | `agent.ctx.systemPrompt.section({...})` |
| `@deepseek-ai/dsh-tools` | `agent.ctx.tools.register/restrict/guard` |
| `@deepseek-ai/dsh-skill` / `dsh-skill-filesystem` | 运行时技能注册 |
| `@deepseek-ai/dsh-host-webserver` | `ctx.webServer.register({kind:'prefix',...})` |
| `@deepseek-ai/dsh-llm` | `ctx.llm.resolveCallConfig`、`MessageId`、`freezeMessage`、usage 类型 |
| `@deepseek-ai/dsh-subprocess` | `ctx.subprocess` + `runAsWorker` |
| `@deepseek-ai/schemastery@3.18.5-alpha.1` | **Host 插件 Config**（schemastery，不是 zod） |
| `@deepseek-ai/dsh-client-*` | 仅 client bundle：slots / locale / renderer / layout / sidebar / workspace / settings / plugin-manager |

---

## 2. Bundle 组装

### 2.1 `package.json` 的 `dsh` 段（`package.json:30-46`）

```json
"exports": {
  ".":              { "types": "./lib/index.d.ts", "default": "./lib/index.js" },
  "./client":       "./lib/client.js",
  "./github-watch": "./lib/github-watch.js",
  "./feishu-watch": "./lib/feishu-watch.js",
  "./package.json": "./package.json",
  "./locale/*.json": "./locale/*.json"
},
"files": ["lib", "cordis.patch.yml", "locale/*.json", "README.md", "prompts", "skills"],
"dsh": {
  "bundle":  { "patch": "./cordis.patch.yml" },
  "client":  { "platform": "web",
               "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-settings",
                          "@deepseek-ai/dsh-client-ui-renderer", "@deepseek-ai/dsh-client-ui-layout",
                          "@deepseek-ai/dsh-client-ui-sidebar", "@deepseek-ai/dsh-client-ui-workspace"] },
  "manifestVersion": 1
}
```

要点：
- `dsh.bundle.patch` 指向**bundle 层** patch：`dsh plugin add` 一次，bundle 自带所有插件行与 preset 行。
- `dsh.client.platform: "web"` + `inject` 声明客户端插件依赖的 UI 包（缺一个就会在页面里拿不到对应 `ctx.xxx`）。
- 多入口：`github-watch` / `feishu-watch` 是**独立 Source 插件**入口（`src/sources/github.ts`、`feishu.ts` 顶部同时是 kind 定义与插件 `apply`）。

### 2.2 `cordis.patch.yml`：bundle 层插入了什么

文件头注释说明它“不带配置地插入插件与 agent preset”，`stateDir` 由 **profile 层**提供（`cordis.patch.yml:1-3`）。

```yaml
# cordis.patch.yml:4-12
- insert:
    - id: dsh-superagent
      name: dsh-superagent
    - id: dsh-superagent-github
      name: dsh-superagent/github-watch
    # Optional Feishu Source; requires configuring a bot CLI after enabling.
    - id: dsh-superagent-feishu
      name: dsh-superagent/feishu-watch
      disabled: true
```

两个 **agent preset 行**（这才是“双层 Router/Worker”在 DSH 侧的定义方式）：

```yaml
# cordis.patch.yml:20-120（Worker，节选：结构不变，plugins 内容按需增删）
    - id: dsh-superagent-worker-preset
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: dsh-superagent-worker
        name: dsh-superagent 执行器
        description: dsh-superagent 的执行器 Session 专用，不供手动选择。前台命令超 5 秒转入后台，只含执行工作所需的工具。
        order: 90
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              prefix: You are a coding agent powered by the {{model}} model.
          - id: agent-instructions
            name: '@deepseek-ai/dsh-agent-instructions'
            config: { maxBytes: 65536 }
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          # 前台命令最多 5 s，超时由 shell 工具自动转后台 job
          - id: shell
            name: cordis:group
            group: true
            isolate: { shell: true }
            config:
              - id: bash-sandbox
                name: '@deepseek-ai/dsh-bash-sandbox'
                disabled: !!js process.platform === 'win32'
                config: { timeoutMs: 5000, maxTimeoutMs: 5000 }
              - id: pwsh-sandbox
                name: '@deepseek-ai/dsh-pwsh-sandbox'
                disabled: !!js process.platform !== 'win32'
                config: { timeoutMs: 5000, maxTimeoutMs: 5000 }
              - id: tool-bash
                name: '@deepseek-ai/dsh-tool-bash'
                disabled: !!js process.platform === 'win32'
              - id: tool-pwsh
                name: '@deepseek-ai/dsh-tool-pwsh'
                disabled: !!js process.platform !== 'win32'
          - id: tool-fs
            name: '@deepseek-ai/dsh-tool-fs'
          - id: tool-fs-search
            name: '@deepseek-ai/dsh-tool-fs-search'
          - id: tool-jobs
            name: '@deepseek-ai/dsh-tool-jobs'
            config: { waitTimeoutMs: 5000, maxWaitTimeoutMs: 5000 }   # 等 job 也只等 5 s
          - id: skill-filesystem
            name: '@deepseek-ai/dsh-skill-filesystem'
          - id: tool-skill
            name: '@deepseek-ai/dsh-tool-skill'
          - id: compaction
            name: cordis:group
            group: true
            isolate: { compaction: true, toolResultPruner: true }
            config:
              - { id: compaction-basic, name: '@deepseek-ai/dsh-compaction-basic' }
              - { id: command-compact,  name: '@deepseek-ai/dsh-command-compact' }
              - id: tool-result-pruner
                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
                config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 }
          - id: delegation
            name: cordis:group
            group: true
            isolate: { workflowEngine: true }
            config:
              - { id: tool-subagent-control, name: '@deepseek-ai/dsh-tool-subagent-control' }
              - id: tool-subagent
                name: '@deepseek-ai/dsh-tool-subagent'
                config: { provider: spawn, toolName: subagent, modelSelection: true,
                          modelDiscovery: true, agentPreset: standard }
          - id: tool-todo
            name: '@deepseek-ai/dsh-tool-todo'
            config: { allowParallelInProgress: true }
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            config: { fetch: false, searchTimeoutMs: 60000 }
```

Router preset（`cordis.patch.yml:125-193`）结构相同，但：`order: 91`、**没有 persona**、`tool-fs` 关掉写入/编辑（`config: {write: false, edit: false}`）、没有 delegation/todo/web、shell 与 job 同样 5 s。

`!!js` 是 loaders 的 JS 表达式标记（`!!js process.platform === 'win32'`），是**同一份 patch 跨平台**的关键写法。

**profile 层只补配置**（`examples/profile.cordis.patch.yml`）：

```yaml
- id: webserver
  config: { host: 127.0.0.1, port: 3082 }
- id: dsh-superagent
  config:
    stateDir: <absolute path, for example /home/me/.dsh/state/superagent>
# - id: dsh-superagent-feishu
#   disabled: false
```

**preset 的生命周期**：Session 在创建时锁定 preset（`sessions.ensure` 里传 `agentPreset`），事后只能靠 `agent-preset/selected` 兜底重新选；**正在使用时删掉 preset 行会让 resume 报 `agent-preset/not-found`**（`006-deployment.md:246`）。

### 2.3 构建：两个 bundle（`tsdown.config.ts`）

```ts
// tsdown.config.ts:1-14（原样）
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
// `?raw` imports a file as its text, as Vite and vitest do; tsdown refuses `.css` ids without @tsdown/css, so this loads them.
const raw = { name: 'raw',
  resolveId: (source: string, importer?: string) => source.endsWith('?raw') && importer ? resolve(dirname(importer), source) : undefined,
  load: (id: string) => id.endsWith('?raw') ? { code: `export default ${JSON.stringify(readFileSync(id.slice(0, -4), 'utf8'))}`, moduleType: 'js' as const }
    : undefined }
export default defineConfig([
  { entry: { index: 'src/index.ts', 'github-watch': 'src/sources/github.ts', 'feishu-watch': 'src/sources/feishu.ts' },
    outDir: 'lib', format: 'esm', fixedExtension: false, platform: 'node', target: 'es2024', dts: true, clean: true,
    deps: { neverBundle: [/^@deepseek-ai\//, 'zod', 'proper-lockfile'] } },
  { entry: { client: 'src/client/index.tsx' }, outDir: 'lib', format: 'cjs', platform: 'browser', dts: false, clean: false, plugins: [raw],
    deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom'] },
    outputOptions: { entryFileNames: 'client.js',
      banner: 'window.__ModuleLoader__.load({ id: "dsh-superagent", factory: (require) => {',
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;' } },
])
```

这就是客户端入口的 `window.__ModuleLoader__.load({id, factory})`：**不是源码里手写的**，是 tsdown 的 banner/footer 包出来的；browser 端是 **CJS + 手写 module shim**，所以 client 代码里只能用 `require`/ESM 源码、不能依赖浏览器 ESM。

---

## 3. Host 插件骨架

### 3.1 入口 `src/index.ts`（全文结构，`src/index.ts:1-27`）

```ts
/** Main plugin entry: mounts the Runtime and provides its restart callback for deployment account changes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import { Runtime } from './app/runtime.ts'
import { Config, machineOf, type DeploymentConfig } from './deployment.ts'

export const name = 'dsh-superagent'
export const inject = ['agents', 'sessionController', 'sessionPersistence', 'workspaceRegistry', 'permissionPresets',
  'tools', 'systemPrompt', 'skills', 'webServer', 'llm', 'subprocess']
export { Config }
export async function apply(ctx: Context, config: DeploymentConfig): Promise<void> {
  const machine = machineOf(config)
  // The management panel provides its own settings UI, so disable DSH's auto-generated settings page.
  ctx.inject(['settings'], child => { child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)) })
  // ...（注释：volatile limits 原地生效；账号变更走 restart；DSH settings 服务在 restart 期间停服，需 describe() 重新读）
  const restart = (): void => {
    ctx.fiber.restart().then(() => { ctx.get('settings')?.describe() })
      .catch((error: unknown) => { ctx.logger.error('dsh-superagent restart failed: %s', String(error)) })
  }
  const runtime = new Runtime(ctx, machine, restart)
  ctx.effect(() => async () => { await runtime.stop() })
  await runtime.ready
  ctx.logger.info(runtime.configured() ? '...' : `dsh-superagent is waiting for setup: ${runtime.setupProblem?.detail ?? ''}`)
}
export type { Deployment, DeploymentConfig } from './deployment.ts'
export * from './core/index.ts'
```

可复用点：`export const name / inject / Config / apply(ctx, config)` 是插件契约；`inject` 里**每个**服务都要在 `apply` 里实际用到，缺一个 DSH 会等它出现。

### 3.2 Config schema：Host 用 schemastery，业务用 zod

```ts
// src/deployment.ts:12-23（节选，省略的 min/max 见 src/limits.ts）
const absolute = (description: string) => s.string().pattern(/^\//).description(`${description} Absolute path.`)
export const Config = s.object({
  stateDir: absolute('Directory for the database, locks, worker shims, the agent\'s git configuration and, by default, the ticket directories.').required(),
  promptMaxChars: s.number().min(LIMITS.promptMaxChars.min).max(LIMITS.promptMaxChars.max).step(1).default(100000)
    .description('Largest saved prompt configuration, in characters.').volatile(),
  admissionContextMaxPages: s.number().min(...).max(...).step(1).default(10)
    .description('Pages of thread context one assessment may read.').volatile(),
  admissionContextTimeoutMs: s.number().min(...).max(...).step(1).default(15000)
    .description('Time limit of one context read during an assessment, in milliseconds.').volatile(),
})
export type DeploymentConfig = ReturnType<typeof Config>
```

```ts
// src/deployment.ts:25-43
export interface Machine { stateDir: string; promptMaxChars: Volatile<number>; admissionContextMaxPages: Volatile<number>; admissionContextTimeoutMs: Volatile<number> }
const MOVED: Record<string, string> = { repository: 'on the GitHub Source', /* … */ }
export function machineOf(config: DeploymentConfig): Machine {
  const unknown = Object.keys(config).filter(key => !(key in (Config.dict ?? {})))
  if (unknown.length) throw new Error(`dsh-superagent configuration has keys it does not use: ${unknown.map(key => MOVED[key] ? `${key} (now ${MOVED[key]})` : key).join(', ')}; docs/006-deployment.md lists the keys`)
  const { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs } = config
  return { stateDir, promptMaxChars, admissionContextMaxPages, admissionContextTimeoutMs }
}
```

要点：
- `s.object({...})` 的 type 自动生成（`ReturnType<typeof Config>`），字段用 `.required()/.default()/.step()/.description()`，**`.volatile()` 表示“改值不用重启”**（DSH 的配置热更新语义）。
- `Volatile<T>` 运行期是 `{ get(): T }`，读的时候 `machine.promptMaxChars.get()`（`src/app/http.ts:93-96`）。
- 业务 schema 用 **zod**（`z.object(...).strict()`），唯一例外是 Host 的 `Config`；两侧都在 `src/policy.ts` 有完整样板（`RuleSchema`、`EvalConfigSchema`、`ExecutorConfigSchema`、`SettingsSchema`，`policy.ts:62-105`）。
- 未知键要**显式拒绝**并告诉用户旧键搬去哪了（`MOVED` 表），不要静默忽略。

### 3.3 Service 注册：`Service` 子类 + `declare module`

```ts
// src/app/runtime.ts:51-59, 87-89（原样片段）
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
export class Runtime extends Service implements SourceHost {
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    // ...
```

- `super(ctx, 'orchestrator')` 把实例注册成 `ctx.orchestrator` 服务；`declare module` 补类型，别的插件 `ctx.inject(['orchestrator'], ...)` 或直接 `ctx.orchestrator`。
- 插件边界用**窄接口**注入：Source 插件只看到 `SourceHost{sources, context(kind)}`，kind 只看 `SourceContext`（`src/sources/host.ts:23-65`）。
- 释放全部走 `ctx.effect(() => dispose)`（`index.ts:22`）、`ctx.disposers.push(...)` / `ctx.effect(...)`；`Runtime` 自己收集 `disposers: (()=>void)[]` 并在 `shutdown()` 里 **reverse()** 执行（`runtime.ts:242`）。

---

## 4. 创建并驱动一个 Executor / Worker 会话（完整调用链）

这是全仓库最值得抄的一段。下面按**一次 launch 的真实顺序**展开。

### 4.1 建 Session：`Sessions.ensure()`（`src/app/sessions.ts:138-155`，原样）

```ts
async ensure(id: string, cwd: string, title: string, role: 'orchestrator' | 'worker'): Promise<Agent> {
  const ctx = this.ctx
  let result = await ctx.sessionController.resolveAgent(id as SessionId)
  if ('error' in result && result.error.code === 'session/not-found') {
    const workspace = await ctx.workspaceRegistry.create(cwd)
    // A Session keeps the preset it was created with, one of the bundle's own (cordis.patch.yml).
    await ctx.sessionController.create({ sessionId: id as SessionId, workspaceId: workspace.id,
      agentPreset: role === 'worker' ? WORKER_PRESET : ROUTER_PRESET })
    result = await ctx.sessionController.resolveAgent(id as SessionId)
  }
  if ('error' in result) throw result.error
  const settings = this.host.store.settings()
  await initializeRoleModel(ctx, result.agent, role === 'orchestrator' ? settings.eval.model : settings.executor.model)
  await this.decorate(result.agent)
  ctx.permissionPresets.set(result.agent.session, 'danger-full-access')
  await ctx.sessionController.rename({ sessionId: id as SessionId, title })
  return result.agent
}
```

### 4.2 角色模型：不污染全局默认（`src/app/role-models.ts:15-44`，原样骨架）

```ts
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export async function resolveRoleModel(ctx: Context, model: RoleModel): Promise<ModelSelection> {
  const value = await ctx.llm.resolveCallConfig({ provider: model.provider, model: model.model,
    ...(model.reasoningEffort ? { reasoningEffort: ReasoningEffortId(model.reasoningEffort) } : {}) })
  return { provider: value.provider, model: value.model, ...(value.reasoningEffort ? { reasoningEffort: value.reasoningEffort } : {}) }
}

export async function initializeRoleModel(ctx: Context, agent: Agent, model: RoleModel | null): Promise<void> {
  if (!model) return
  if (agent.session.requestHeader() || agent.session.snapshotEvents().some(event => event.type === 'model/selection')) return
  const selected = await resolveRoleModel(ctx, model)
  // Avoid selectModel because it mutates the global DSH default; inject the selection for the initial request only.
  agent.session.append('model/selection', selected)
  let initial = true
  let assembled: ModelSelection | undefined
  agent.ctx.effect(() => {
    const disposers = [
      agent.ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const selection = initial ? selected : undefined
        const result = await next()
        assembled = selection
        return selection ? { ...result, variables: { ...result.variables, provider: selection.provider, model: selection.model } } : result
      }, { prepend: true }),
      agent.ctx.on('agent/request', async (_payload, next) => {
        const result = await next()
        if (!assembled) return result
        const { reasoningEffort: _inherited, ...rest } = result
        return { ...rest, ...assembled }
      }, { prepend: true }),
      ctx.on('session/event', (session, event) => {
        if (session === agent.session && (event.type === 'request/header' || event.type === 'model/selection')) initial = false
      }),
    ]
    return () => disposers.forEach(dispose => dispose())
  })
  await ctx.sessionPersistence.flush()
}
```

### 4.3 装配：system prompt / skills / tools（`src/app/sessions.ts:232-269`，节选）

```ts
private async decorate(agent: Agent): Promise<void> {
  if (this.bindings.has(agent)) return
  const host = this.host
  const master = agent.id === host.masterId
  const ticket = master ? undefined : this.ticketOf(agent)
  if (!master && !ticket) { this.limitSubagent(agent); return }        // subagent 也要限工具
  const binding: SessionBinding = { disposers: [] }
  this.bindings.set(agent, binding)

  // ① 提示词：整个角色提示词作为一个 section；主 Session complete:true 覆盖 DSH 默认
  binding.disposers.push(agent.ctx.systemPrompt.section({
    name: 'dsh-superagent-policy', order: 9999, interpolate: false,
    text: context => {
      const version = this.promptFor(agent, context.signal !== undefined)
      const composed = host.prompts.compose(version.config, master ? 'orchestrator' : 'worker', current ? host.environment(current) : undefined)
      return `[dsh-superagent prompt revision ${version.revision}]\n${composed}\n${current ? mandateInstructions(current.mandate) : ''}`
    },
    ...(master ? { complete: true } : {}),
  }))

  // ② 技能：每次 prompt 版本变化时重建（scope 可能因 skills 服务重启而重建）
  const skillScope = agent.ctx.inject(['skills'], scope => {
    binding.scope = scope; binding.skills = undefined
    this.bindSkills(binding, host.prompts.current())
  })
  binding.disposers.push(() => { skillScope.dispose().catch(...) })
  await skillScope

  // ③ 工具
  const register = this.registerTool(agent, binding)
  for (const tool of host.tools(agent, ticket)) register(tool.name, tool.description, tool.schema, tool.execute)

  // ④ 权限/限制
  if (master) {
    binding.disposers.push(agent.ctx.tools.restrict({ allow: ['skill', 'bash', 'read', 'read_image', 'job_output', 'job_list', 'job_kill'] }),
      agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent))))
  } else {
    binding.disposers.push(...this.workOnly(agent, ticket!.id))
  }
}
```

配套细节：
- 技能注册（`sessions.ts:314-327`）：`scope.skills.register({ name: `${SKILL_PREFIX}${name}`, description, content, source: 'runtime', ...(bundled ? { resourceBase: {kind:'directory', path: dirname(bundled.path)} } : {}) })`。
- Worker 工具白名单（`sessions.ts:61-62`）+ `workOnly`（`sessions.ts:289-297`）：

```ts
const WORK_TOOLS = ['read', 'write', 'edit', 'read_image', 'glob', 'grep', 'bash', 'pwsh', 'job_output', 'job_list', 'job_kill',
  'web_search', 'web_fetch', 'skill', 'todo_write', 'subagent', 'list_subagent_models', 'send_message', 'list_agents', 'interrupt_agent']

private workOnly(agent: Agent, ticketId: string): (() => void)[] {
  const store = this.host.store
  const parent = scopeParentOf(agent)                       // 读继承工具必须走 parent scope，全局视图看不到 preset 工具
  const allow = WORK_TOOLS.filter(name => agent.ctx.tools.get(name, parent))
  return [agent.ctx.tools.restrict({ allow }), agent.ctx.tools.guard(() => {
    const current = store.tickets.get(ticketId)
    return !current || !liveTicket(current) ? 'Ticket ended; new work needs a new authorized ticket' : undefined
  })]
}
```

### 4.4 发消息：三种投递语义（`src/app/delivery.ts:66-85`）

```ts
type Seen = { ids: Set<string>; loaded?: Promise<void> }
export const messageId = (requestId: string) => MessageId(`dsh-superagent:${requestId}`)

async send(agent: Agent, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string },
  signal: AbortSignal, authorize?: () => void, accepted?: () => void): Promise<void> {
  signal.throwIfAborted()
  const seen = await this.history(agent)                    // 从 live 事件 + 持久化历史恢复已投 id
  signal.throwIfAborted()
  if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
  authorize?.()                                             // 投递前最后一次状态校验（可能 throw 取消投递）
  const id = messageId(requestId)
  const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
  if (!seen.ids.has(id) && !pending) {
    const source = typeof mode === 'object'
      ? { kind: 'dsh-superagent' as const, form: 'notice' as const, summary: mode.inject }
      : { kind: 'dsh-superagent' as const, form: 'relay' as const }
    const message = freezeMessage({ id, role: 'user' as const, content: [{ type: 'text' as const, text }], source })
    if (typeof mode === 'object') { agent.inject(message); seen.ids.add(id) }   // 不唤醒
    else if (mode === 'steer') agent.steer(message)                              // 插到当前/下一 step
    else agent.followup(message)                                                 // 排到下一 turn
  }
  accepted?.()                                              // 投递成功回调（如 assignmentStarted）
  await this.ctx.sessionPersistence.flush()                 // 必须 flush，否则“已投递”不持久
}
```

`Sessions.prompt` 是它的薄封装（`sessions.ts:162-167`），`requestId` 用**业务幂等键**：`assignment:<ticketId>:<assignmentId>`、`<inputId>`、`retry:<assignmentId>:<n>`、`notice:<name>:<hash>`。

### 4.5 一次 Launch：目录 → Session → 首条消息（`src/executor/dsh.ts:424-470`，节选）

```ts
private async launch(ticket: Ticket, assignment: Assignment): Promise<void> {
  const current = () => {
    if (this.host.closing()) throw new Error('dsh-superagent is stopping')
    if (this.host.paused()) throw new Later('Processing is paused')
    const stored = this.host.store.tickets.get(ticket.id)
    return !!stored && liveTicket(stored) && latestAssignment(stored)?.id === assignment.id
  }
  const workspace = ticket.execution?.directory ?? ''
  if (!current()) return
  // 目录不存在 → 跑一次 prepare 命令（sh -c，10 分钟，注入执行环境变量）
  if (!await stat(workspace).then(() => true, () => false)) {
    await this.prepareDirectory(ticket)
    if (!current()) return
  }
  const sessionId = workerSessionId(ticket.id)
  const agent = await this.host.sessions.ensure(sessionId, workspace, ticket.title, 'worker')   // ← 4.1
  if (!current()) return
  await this.stopped(ticket.id)                              // 上一个 Assignment 的后台工作先停完
  // 重启遗留的重复 inbox 消息先移除，保证“新投递是唯一副本”
  for (const id of this.host.store.tickets.get(ticket.id)?.undelivered ?? []) agent.inbox.remove(this.host.sessions.promptedId(id))
  // 首条消息含 assignment + source trigger + batch；后续 Assignment 只发增量
  const text = JSON.stringify({ ticket_id: ticket.id, title: ticket.title, assignment: brief, trigger: card, batch })
  await this.host.sessions.prompt(sessionId, `assignment:${ticket.id}:${assignment.id}`, text, 'queue',
    () => { if (!current()) throw new Error('Launch authorization changed before worker delivery') },
    () => { this.host.engine.assignmentStarted(ticket.id, assignment.id) })
  this.host.engine.assignmentStarted(ticket.id, assignment.id)
}
```

**目录准备**（`dsh.ts:247-262`）：

```ts
private async prepareDirectory(ticket: Ticket): Promise<void> {
  const directory = ticket.execution?.directory ?? ''
  await mkdir(dirname(directory), { recursive: true })
  const command = this.host.store.settings().executor.prepare.trim()
  const env = Object.fromEntries(this.host.environment(ticket).map(variable => [variable.key, variable.value]))
  const signal = AbortSignal.any([this.host.lifetime, AbortSignal.timeout(PREPARE_TIMEOUT_MS)])   // 10 min
  if (command) await runAsWorker(this.host.context.subprocess, ['sh', '-c', command], dirname(directory), signal, env)
    .catch(async (error: unknown) => {
      await rmdir(directory).catch(() => {})                 // 失败命令留下的空目录要删，否则重试会误判“已准备”
      throw new PrepareFailed(`The prepare command failed: ${error instanceof Error ? error.message : String(error)}`)
    })
  await mkdir(directory, { recursive: true })
  await verifyDirectory(directory, this.host.context.subprocess, this.host.lifetime)
}
```

### 4.6 等结果：事件订阅是唯一正确方式

`DshExecutor.install()`（`dsh.ts:477-512`）订阅四类事件；**不要轮询**：

```ts
install(): void {
  const ctx = this.host.context
  // ① turn 结束 → 看后台是否还有 job/subagent，决定 report waiting 还是继续持有 slot
  this.disposers.push(ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'running') { this.settling.get(ticketOfSession(agent.id) ?? '')?.abort(); return }
    if (status !== 'idle' || cancelled.delete(agent) || this.host.closing()) return
    const ticket = this.ticketOf(agent)
    const assignment = ticket && runningAssignment(ticket)
    if (ticket && assignment && liveTicket(ticket)) void this.background(this.workerIdle(ticket, assignment, agent))
  }))
  // ② 人在 Worker Session 里直接打字（不属于任何 Input）
  this.disposers.push(ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    const ticketId = ticketOfSession(agent.id)
    if (ticketId !== undefined && message.source.kind === 'user') this.personal.set(ticketId, now())
  }))
  // ③ Input 被真正读进历史（= inputsRead）
  this.disposers.push(ctx.on('session/event', (session, event) => {
    const ticketId = ticketOfSession(session.id)
    if (event.type !== 'user/message' || ticketId === undefined || event.data.source.kind !== 'dsh-superagent' || this.host.closing()) return
    const message = event.data
    void this.background(Promise.resolve().then(() => {
      const read = this.host.store.tickets.get(ticketId)?.inputs
        .filter(input => input.kind === 'trigger' && !input.readAt && this.host.sessions.promptedId(input.id) === message.id)
        .map(input => input.id) ?? []
      if (read.length) this.host.engine.inputsRead(ticketId, read)
    }))
  }))
  // ④ turn 级错误 → transient 重试 3 次（15/30/60 s），否则 failed
  this.disposers.push(ctx.on('agent/error', ({ agent, error }) => {
    const ticket = this.ticketOf(agent), assignment = ticket && runningAssignment(ticket)
    if (!ticket || !assignment || !liveTicket(ticket) || this.host.closing()) return
    if (this.retries(assignment.id, error)) { this.resumeAfter(ticket.id, assignment.id, error); return }
    void this.background(Promise.resolve().then(() => { this.failed(ticket.id, String(error)) }))
  }))
}
```

- **turn 怎么算结束**：`agent.whenIdle()` + `agent.status === 'idle'`，然后 `untilQuiet(ctx, agent, signal, leftJobs)` 等后台安静（`dsh.ts:601-672`，`src/executor/background.ts`）。turn 结束并不等于 Ticket 完成：只有 `report` 才改变 Ticket 状态。
- **拿结果的两条路**：
  1. **推荐**：Worker 调 `orchestrator_report` 工具 → `engine.report()` → `Effects('relay')` → Router 收到消息（不靠读 Session）。
  2. **兜底**：读 `agent.session.snapshotEvents()`，取最后一条 `assistant/message` 的 text blocks（`dsh.ts:659-662`）——原型的 `workerIdle` 就用它生成 `waiting` 的 summary。
- **等子任务**：`runAsWorker(ctx.subprocess, ['sh','-c',cmd], cwd, signal, env)`（`dsh.ts:254`）；worker 自己的 job/subagent 用 `ctx.jobs` / `ctx.subagents` 封装（`src/executor/background.ts:1-20` 导出 `runningJobs/untilQuiet/killJobs/collectJobs/stopSubagents/stopBackground`）。
- **如何 dispose**：`agent.cancel({ kind: 'user' }, { keepInbox: true|false })`（`dsh.ts:236,365,398`）；插件级 `release(agent)` 逆序执行所有 disposer + `skills.dispose()`（`sessions.ts:341-351`）；进程级 `Runtime.shutdown()` 先 `effects.drain()` 再 `sessions.dispose()`，最后 `sessionPersistence.flush()`（`runtime.ts:230-253`）。
- **并发槽**：`WorkerSlots.reserve(ticketId, by)` 必须在 `await` **之前**同步调用，否则两个 launch 会同时抢最后一个槽（`dsh.ts:192-198`）。

---

## 5. 注册工具

### 5.1 工具定义（`src/app/tools/tool.ts:6-17`，原样）

```ts
import { z } from 'zod'

export interface Tool<S extends z.ZodType = z.ZodType> {
  name: string
  description: string
  schema: S
  execute: (args: z.infer<S>, signal: AbortSignal) => Promise<unknown>
}
export type RegisterTool = <S extends z.ZodType>(name: string, description: string, schema: S, execute: Tool<S>['execute']) => void
export const tool = <S extends z.ZodType>(definition: Tool<S>): Tool => definition as unknown as Tool

/** Acknowledgement 文字有 100 词硬上限（中文按分词）。 */
export const AcknowledgementSchema = z.string().trim().min(1)
  .refine(text => wordCount(text) <= IM_WORDS, `An acknowledgement has at most ${IM_WORDS} words (Chinese uses word segmentation); write one short sentence.`)
```

一个真实工具（`src/app/tools/main.ts:125-151`，节选）：schema 用 `.strict()`，用 `.describe()` 把规则写进参数描述（模型会读），执行体自己处理“逐项失败不打断整批”。

```ts
function routeTool(host: MainToolsHost): Tool {
  return tool({
    name: 'orchestrator_route',
    description: 'Route candidates, one item each by the card\'s trigger_id, in one call: accept an explicit request as a new ticket, ...',
    schema: z.object({ decisions: z.array(RouteItemSchema).min(1).max(20) }).strict(),
    execute: async ({ decisions }) => {
      const results = decisions.map(item => { /* 每项独立 try/catch，返回 {trigger_id, kind, decision?, reason?, ticket?, refused?} */ })
      host.requestPass()
      return { results }
    },
  })
}
```

### 5.2 注册到某个 Agent（`src/app/sessions.ts:206-216`，原样）

```ts
private registerTool(agent: Agent, binding: SessionBinding): RegisterTool {
  return (name, description, schema, execute) => {
    binding.disposers.push(agent.ctx.tools.register({
      name, description, parameters: z.toJSONSchema(schema),
      output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => {
        const text = { type: 'text' as const, text: JSON.stringify(value) }
        const image = value && typeof value === 'object' && 'image' in value ? (value as { image: never }).image : undefined
        return image ? [text, { type: 'image' as const, attachment: image }] : [text]
      } },
      execute: (args, execution) => execute(schema.parse(args), execution.signal),
    }))
  }
}
```

要点：
- `parameters: z.toJSONSchema(schema)` —— **zod 是唯一真源**；不要手写 JSON Schema。
- `output.render` 返回 `[{type:'text'}, {type:'image', attachment}]`；返回对象里有 `image` 字段时会附图片（`orchestrator_eval_read` 读截图靠它）。
- `execute(args, execution)` 的 `execution.signal` 要一路透传（HTTP/子进程/读资源）。
- **注销**：`disposers` 收集，`release()` 逆序执行；Agent dispose 时 `release` 由 `agent/disposed` 事件触发。

### 5.3 权限 / 审批（原型的选择：没有运行时审批）

```ts
ctx.permissionPresets.set(agent.session, 'danger-full-access')             // sessions.ts:152
agent.ctx.tools.restrict({ allow: [...] })                                 // 白名单（sessions.ts:263,293）
agent.ctx.tools.guard(execution => noWait(execution, () => this.routed(agent)))   // 参数级拦截，返回 string 即拒绝
agent.ctx.tools.guard(() => !liveTicket(current) ? 'Ticket ended; ...' : undefined)
```

- `guard` 返回 `string` = 拒绝并把这个理由给模型；返回 `undefined` = 放行。`noWait` 的完整实现见 `sessions.ts:77-86`（拒 `sleep`、`timeoutMs>30_000`、`job_output wait>5_000`）。
- `restrict({allow})` 只能列出**已知**工具；子 Agent 的工具在 `parent scope` 里（`scopeParentOf(agent)`），不要用全局视图判断（`sessions.ts:289-292` 的注释解释了原因）。
- 需要“审批”时，原型的做法是**把审批下沉到授权/配置**：`blockedCommands`（只挡按名字调用，不是安全边界）、`permissionPresets`、以及提示词里的 Delivery requirements。若你确实要 ask 类工具，必须在 preset 里加 `ask_user_question` 并对 `report` 之外的路径做超时，否则长任务会卡死。

---

## 6. 注册 HTTP 路由

### 6.1 Host 侧（`src/app/http.ts:230-247`，原样骨架）

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type { IncomingMessage, ServerResponse } from 'node:http'

export function registerHttp(ctx: Context, runtime: HttpHost): () => void {
  if (ctx.webServer.host !== '127.0.0.1') throw new Error('Orchestrator management requires a loopback Web server')
  const table = routes(runtime)                                  // Record<`${method} ${path}`, handler>，见下
  const disposers = [
    ctx.webServer.register({ kind: 'prefix', path: '/orchestrator', handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith('/orchestrator/api/')) { res.writeHead(404); res.end(); return }
      if (!sameOrigin(req, ctx.webServer.port)) { json(res, 403, { error: 'Same-origin management request required' }); return }
      try {
        await runtime.ready                                      // 启动/重启期间让请求等到 ready
        const route = match(table, req.method ?? 'GET', url.pathname.slice('/orchestrator/api/'.length).split('/'))
        if (!route) throw new RouteError(404, 'Unknown operation')
        const query = Object.fromEntries(url.searchParams)
        json(res, 200, await route.run({ params: route.params as never, query, body: maxBytes => readBody(req, maxBytes) }))
      } catch (error) { json(res, ...failure(error)) }
    } })]
  return () => { for (const dispose of disposers) dispose() }
}
```

配套（同一文件）：
- `sameOrigin`（`http.ts:75-79`）：Host 必须 `127.0.0.1:<port>` 或 `localhost:<port>`，且带 `x-orchestrator-request: 1`，`Origin` 要么缺省、要么同源。
- 响应头（`http.ts:72-74`）：`content-type: application/json; charset=utf-8`、`cache-control: no-store`、`x-content-type-options: nosniff`。
- 体积上限：默认 128 KB；prompt 保存按 `4 * promptMaxChars + 4096`（`http.ts:62-71,154`）。
- 错误映射（`http.ts:81-91`）：

| 异常 | 状态 | body |
|---|---|---|
| `z.ZodError` | 400 | `{error, issues:[{path,message}]}` |
| `SetupError` | 400 | `{error, setup:{place,code,values,detail}}` |
| `RouteError` | 400/404 | `{error}` |
| `UserError(code,values)` | 404（`missing`）/400 | `{error, code, values}` |
| `SettingsConflict` / `PromptConflict` | 409 | `{error}`（stale revision） |
| 其他 | 500 | `{error}` |

- 路由表 + 类型契约：`src/app/api.ts:20-46` 是**只含类型**的 `Api` 接口（`'GET tickets/:id': {params?, query?, body?, response}`），面板可以 import 它而不打包 host 代码（`api.ts:1` 的注释与 `007-architecture.md:346`）。路径参数解析是手写的（`http.ts:218-229`），`:` 前缀即参数。
- 一定要把 host 侧路由的实现和 `Api` 契约**逐项对齐**，有 `tests/http.spec.ts` 风格的单测（同源/loopback/body 上限/各失败状态）。

---

## 7. 面板统计数据从哪来

### 7.1 现成的读查询（`src/app/store-read.ts`）

| 面板需要 | 查询 | 位置 |
|---|---|---|
| 近 24 h 每个 Source 的收/过滤数 | `read.triggerStats(since)` → `{received, filtered, lastAt}`（SQL 用 `json_extract` + `SUM(t.at >= ?)`） | `store-read.ts:12-17` |
| 流量与接受数 | `read.flow(since)` → `{judged, accepted}`（按 decision 的 `triggerIds` 去重计数） | `store-read.ts:22-27` |
| 丢弃的消息 | `read.droppedReplies()` / `read.droppedSince(since)` | `store-read.ts:73-75` |
| 发不出去的回复 | `read.failingReplies()` | `store-read.ts:70-72` |
| 搜索 | `read.search(q)`（id / url / meta.messageId / text LIKE） | `store-read.ts:54-57` |
| Thread 时间线分页 | `read.threadTriggers(key, limit, before?: {at,id})`，游标 `at|id` | `store-read.ts:34-40` |
| 订阅中的 Thread（走 partial index） | `read.subscribedThreads(source?)` | `store-read.ts:76-80` |

视图层再投影成面板 JSON：`overview()`（`src/app/views/overview.ts:38-79`）、`ticketList/ticketDetail/executorLoad`（`views/tickets.ts:35-87`）、`threadList/threadDetail/search/decisionList`（`views/threads.ts:9-94`）、`sourcesStatus`（`views/sources.ts:41-57`）、共享行 `snapshot/triggerView/ticketSummary/threadSummary/decisionView`（`views/records.ts:46-200`）。

### 7.2 健康与负载

- `HealthBoard`：每个部件 `claim(name)` 一条，**重复 claim 被拒**（`src/infra/health.ts`、`007-architecture.md:269`）；`GET state.health` 直接返回全部。
- 负载：`DshExecutor.activeCount()`（正在跑 turn 或后台工作的 open ticket 数，`dsh.ts:404-409`）+ `executorLoad(store, running)`（排队数，`views/tickets.ts:52-55`）。
- 运行中/排队定义：`load.running` = worker Session 在 active turn（会占槽、重启会被打断）；`load.queued` = `working/queued` 阶段。

### 7.3 token / cache 统计（原型没有，落点在这里）

`Sessions.install()` 已经订阅了 `session/event`（`sessions.ts:114-120`），照抄它加计数即可（伪代码，字段名以你运行版本 `@deepseek-ai/dsh-llm` 的 usage 类型为准）：

```ts
ctx.on('session/event', (session, event) => {
  if (event.type !== 'assistant/message') return
  const usage = (event.data as { message?: { usage?: { input?: number; output?: number; cacheRead?: number } } }).message?.usage
  if (!usage) return
  const ticketId = ticketOfSession(session.id)                       // 'worker-xxx' → ticketId
  this.usage.add({ sessionId: session.id, ticketId, role: ticketId ? 'worker' : 'router', ...usage })
})
```

- 落库：新增一张 `usage(sessionId, role, ticketId, input, output, cacheRead, at)`，或写 `kv` 的 `usage:<sessionId>`；不要塞进 ticket JSON（会放大每次读）。
- 口径：`cache_hit_rate = cacheRead / (input + cacheRead)`、`tokens_per_ticket`、`router/worker 分摊`。**先打印一条真实事件确认字段名再落库**，不要凭记忆写死 `cacheReadTokens`。

---

## 8. Client 插件（Web UI 侧栏 + 主面板）

### 8.1 入口与 slots（`src/client/index.tsx:48-58`，原样）

```tsx
import { useCallback, useEffect, useRef } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PluginConfigViewProps } from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

type ClientContext = Context & { sessions: ISessions }
const NS = 'dshSuperagent'
const PANEL_ID = 'dsh-superagent' as MainPanelId
const ENTRY = 'dsh-superagent'

export const inject = ['slots', 'locale', 'sessions', 'uiWorkspace']
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-superagent: dictionaries')
  const t = ctx.locale.bind(NS)
  // 主面板：name='main' + key=面板 id（keyed 页面，每个插件一块）
  ctx.slots.inject('main', () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, inject: () => ({}) },
    (props: { t: T }) => <Mounted ctx={ctx} t={props.t} />))
  // 侧栏条目：sidebar.panellist，id 必须与 main 的 key 一致
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10,
    label: () => t('panel'), locale: NS }, HammerIcon))
  // 同一页面嵌进 DSH Plugin Manager
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: `${ENTRY}#${ENTRY}`, locale: NS },
    (props: PluginConfigViewProps & { t: T }) => <PluginConfig t={props.t} view={props.view} form={props.form} />))
}
```

要点：
- `ctx.slots.inject(slotName, () => ctx.slots.register(...))`：**inject 的返回值是 dispose**，外层 `ctx.effect` 管生命周期。
- `main` 卡是 **keyed**（`key: PANEL_ID`），侧栏用 `id: PANEL_ID`（`order` 控制排序）。
- `locale: NS` 让 slot 自动获得 `props.t`。
- 侧栏图标组件签名是 `SidebarPanelIconOwnerProps`（`{size}`）。

### 8.2 locale / theme token

- 词典 `{ zh, en }` 放 `src/client/locales.ts`（770 行，含术语表 `GLOSSARY`），`ctx.locale.register(NS, {zh,en})` 注册、`ctx.locale.bind(NS)` 取 `t`；键名默认回落到键本身。
- **样式不 import DSH 包**：`src/client/client.css` 用 `--dsw-alias-*` 设计 token（`--dsw-alias-label-primary/secondary/caption`、`--dsw-alias-bg-layer-1/2`、`--dsw-alias-border-l3`、`--dsw-alias-state-error-primary` 等，共 30+ 个），类名统一前缀 `dt-`。
- 控件是**本地复制**的 DSH 原语（`src/client/controls.tsx:1-4` 注释明说：为不耦合 `@deepseek-ai/dsh-client-ui-primitives` 内部 API 而镜像其 markup/键盘行为），升级 DSH 时要人工对齐。
- CSS 通过 `?raw` 引入（`import STYLES from './client.css?raw'`，`src/client/provider.tsx:6`）+ `<style>{STYLES}</style>`，需要 tsdown 的 `raw` 插件（§2.3）。

### 8.3 调 Host 路由（`src/client/api.ts`）

```ts
// 请求头是鉴权的关键（服务端 sameOrigin 校验）
const json = body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
const response = await fetch(`/orchestrator/api/${path}`,
  { method, ...json, headers: { 'x-orchestrator-request': '1', ...json.headers } })
```

- `caller(messages)` 由 `Api` 类型生成强类型调用：`call('GET tickets', { query: { state: 'open' } })`；路径参数自动 `encodeURIComponent`（`client/api.ts:105-117`）。
- 轮询用 `usePoll(load, deps, intervalMs=5000)`（`client/api.ts:67-98`）：串行化、跳过相同响应、页面隐藏时退避 ×6、卸载时清 timer。
- 重启感知：`PanelProvider` 在 `restart` 期间把轮询降到 1 s，直到服务器先挂后答或 30 s 超时（`client/provider.tsx:86-98`）。
- 打开 Session：`openKnownSession(ctx.sessions, id, target => ctx.uiWorkspace.openSession(target), signal)`（`src/navigation.ts:14-23`），失败分 `not-ready`/`not-listed` 两种可本地化错误。

---

## 9. Windows 不兼容点（照抄会直接挂）

原型是**Linux/macOS 假设**的，虽然 preset 已经用 `!!js process.platform` 分流 bash/pwsh，但 Host 侧仍有多处硬编码：

| 位置 | 问题 | 在 Windows 的表现 | 移植做法 |
|---|---|---|---|
| `scripts/dsh-superagent` | 用 `tmux` 启停（`start` 跑 `dsh --profile ...` 于 tmux session）、`ps` 查进程 | 直接不可用 | 换成 Windows 服务/计划任务，或只用 `dsh` + 自建守护 |
| `src/executor/dsh.ts:254` | `runAsWorker(ctx.subprocess, ['sh','-c',command], ...)` | 无 `sh` → prepare 必失败 → 所有 Ticket `failed` | 按平台选 `pwsh -NoProfile -Command`/`cmd /c`，或要求 prepare 写成一个可执行脚本 |
| `src/deployment.ts:73-76` | `workerProbe` 用 `['env', 'PATH=...', ...argv]` | 无 `env.exe`（Git Bash 有但 PATH 不保证） | 直接传 env 给 subprocess，或 `cmd /c set ...` |
| `src/deployment.ts:13` | `stateDir` schema `pattern(/^\//)` 只接受 POSIX 绝对路径 | `C:\...` 校验失败，插件起不来 | 改成跨平台绝对路径校验（`path.isAbsolute`） |
| `src/infra/environment.ts:76-103` 的 shim | `shim()` 用 `#!/bin/sh\n…` + `mode 0o755` 生成 `gh`/`lark-cli`/`blockedCommands` wrapper，放进 `<stateDir>/worker-bin` 并前置到 PATH | Windows 不能执行 `#!/bin/sh` 文件 | 按平台生成 `.cmd`/`.ps1` wrapper 并加入 PATH；`executable()` 按 PATHEXT 解析 |
| `cordis.patch.yml` 注释与 shell 配置 | 已有 `bash-sandbox`/`pwsh-sandbox`、`tool-bash`/`tool-pwsh` 的 `!!js` 分流 | 这部分**已经兼容**，别删 | 保留 `!!js` 行；自己加 shell 相关配置时同样分流 |
| `prepare` 默认示例 | `git fetch … && git worktree add …`（POSIX 语法） | `&&` 可用，但 `$VAR` 在 cmd 下不展开 | 用 pwsh：`$env:DSH_SUPERAGENT_DIR` |
| `src/app/sessions.ts:70` 的 `SLEEP` 正则 | 假设 shell 是 bash（`; & \| ({ ! \``） | 对 pwsh 命令会漏判 | 为 pwsh 增加 `Start-Sleep`/`Sleep` 的判据 |
| `proper-lockfile` / `node:sqlite` | 均跨平台，但 `node:sqlite` 需 Node ≥22.5 且实验特性 | 需确认 DSH 打包的 Node 版本 | 保持 `node:sqlite`，或在 Windows 上验证 WAL/权限（`chmodSync 0o600` 在 Windows 无效果，无害） |
| 面板 | React/DOM，无平台问题 | — | — |

另外两个**跨平台但要注意**的点：

1. **面板控件与 DSH 版本强耦合**：`controls.tsx` 是人工镜像，DSH 升级可能改 class/键盘行为（`src/client/controls.tsx:1-4`）。
2. **`danger-full-access` 没有 Windows 上的等价隔离**：原型本来就不是安全边界（可读 home、可按绝对路径执行），别在 Windows 上误以为 `blockedCommands` 能兜底。

---

## 10. 最小落地顺序（按依赖排）

1. `package.json`（`dsh.bundle.patch` + `dsh.client` + `exports` + `engines`）+ `cordis.patch.yml`（3 个插件行 + 2 个 preset 行）+ `tsdown.config.ts`（两个 bundle，注意 client 的 ModuleLoader banner）。
2. Host 入口 `src/index.ts`：`name/inject/Config/apply`；`Config` 用 schemastery + `machineOf` 拒绝未知键。
3. `Runtime`（Service 子类，`super(ctx,'orchestrator')`，`declare module`）+ `Store`（SQLite，先只建 `ticket/effect` 也够跑通）+ `Effects`（先做 `launch/delivery/relay/notice`）。
4. `Sessions.ensure` + `initializeRoleModel` + `decorate`（先只挂 systemPrompt section + 两个工具，不加 skills）。
5. `DshExecutor.launch/deliver/install/stop`（§4.4-§4.6），先只支持 `report` 一种回投。
6. `registerHttp` + `Api` 契约 + 一个 `GET state`；再按 §7 加 `GET overview`。
7. Client：`inject` + `ctx.slots.inject('main')` + `sidebar.panellist` + `usePoll(GET state)`；样式直接用 `--dsw-alias-*` token。
8. 最后再加：Subscription 直通、Policy 版本、assessment、Watchdog、token 埋点（都可独立加，不影响前 7 步）。

**可直接抄的“最小优质样本”**：`src/app/delivery.ts`（幂等投递）、`src/executor/dsh.ts:171-199`（槽位）、`src/app/effects.ts`（持久队列）、`src/app/http.ts`（247 行内把路由/同源/错误码全做对）、`src/client/index.tsx`（58 行注册三处）。
