/**
 * Host half of the Super Agent bundle.
 *
 * It is the DSH adapter around `lib/engine.js`: it feeds the engine real Trigger sources
 * (the console, a webhook route, and the agent's own tool), executes Workers as real DSH
 * Sessions when a model is available, mirrors their Session events back into the engine,
 * injects the few attention-gated notices into the person's Session without waking it,
 * and serves `/api/super-agent` for the console.
 *
 * Everything the paper asks the Host to provide is here; everything about *policy* lives in
 * the engine. `apply()` registers only DSH resources, so a profile stop removes all of them.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'dsh-super-agent'
export const inject = ['sessionController', 'tools', 'systemPrompt', 'webServer']

/** Services the bundle can live without: real Worker sessions, the semantic gate, permissions. */
const OPTIONAL = ['llm', 'agents', 'agentPresets', 'permissionPresets', 'sessionPersistence', 'workspaceRegistry']

const DEFAULTS = {
  acceptMode: 'observe',
  runner: 'auto',
  maxWorkers: 4,
  routerModel: '',
  workerModel: '',
  workerPreset: 'standard',
  watchdogIntervalMs: 15_000,
  staleAfterMs: 4 * 60_000,
  batchWindowMs: 1_200,
  batchSize: 8,
  stateDir: '',
  workerCwd: '',
  notifySessionId: '',
  acceptSources: [],
  budget: { maxWorkersPerHour: 0, maxRuntimeMs: 0, maxTokensPerDay: 0 },
  worktree: { enabled: true, root: '' },
  delivery: { mode: 'patch', remote: 'origin', prBase: '', githubToken: '', artifactsDir: '' },
  repoMap: {},
  sources: {
    inbox: { enabled: false, dir: '', intervalMs: 2000 },
    github: { enabled: false, repos: [], token: '', intervalMs: 60_000, allowAuthors: [] },
    ci: { secret: '' },
  },
}

export async function apply(ctx, rawConfig = {}) {
  // Re-evaluate the engine modules on every activation. The profile loader caches an ESM module
  // graph for the life of the process, so a statically imported `lib/engine.js` would keep running
  // the code from before an edit even after the bundle reloads; a version query defeats that cache.
  const stamp = String(Date.now())
  const { SuperAgentEngine } = await import(new URL(`./lib/engine.js?v=${stamp}`, import.meta.url).href)
  const { JsonStore } = await import(new URL(`./lib/core.js?v=${stamp}`, import.meta.url).href)
  const config = { ...DEFAULTS, ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}) }
  const log = (level, message, error) => {
    const line = `[super-agent] ${message}${error ? `: ${String(error?.message ?? error)}` : ''}`
    if (level === 'warn') ctx.logger?.warn?.(line)
    else ctx.logger?.info?.(line)
  }
  // The unattended extensions live in their own modules and are optional: a profile that upgrades
  // this bundle keeps working even if one of them cannot be imported.
  const loadOptional = async (relative) => {
    try {
      return await import(new URL(`${relative}?v=${stamp}`, import.meta.url).href)
    } catch (error) {
      log('warn', `optional module ${relative} is unavailable`, error)
      return null
    }
  }
  const worktreeModule = await loadOptional('./lib/worktree.js')
  const inboxModule = await loadOptional('./lib/sources/local-inbox.mjs')
  const githubModule = await loadOptional('./lib/sources/github.mjs')
  const webhookModule = await loadOptional('./lib/sources/webhook.mjs')
  const deliveryModule = await loadOptional('./lib/delivery/index.mjs')
  const replyModule = await loadOptional('./lib/sources/reply.mjs')
  const optional = Object.fromEntries(OPTIONAL.map(key => [key, () => ctx.get(key)]))
  const stateDir = config.stateDir && String(config.stateDir).trim() !== ''
    ? String(config.stateDir)
    : join(process.env.DSH_PROFILE_DIR || join(homedir(), '.dsh'), 'storages', 'super-agent')

  const store = new JsonStore(stateDir)
  let ownerSessionId = config.notifySessionId || ''

  // ---- per-ticket isolation -------------------------------------------------
  // A ticket that names a local repository works in its own git worktree; `repoMap` translates a
  // symbolic repo (`owner/name`) to the machine's clone.
  const worktrees = worktreeModule && config.worktree?.enabled !== false
    ? new worktreeModule.WorktreeManager({
      rootDir: String(config.worktree?.root || join(stateDir, 'worktrees')),
      log: (level, message) => log(level, message),
    })
    : null
  const artifactsDir = String(config.delivery?.artifactsDir || join(stateDir, 'artifacts'))

  function repoPath(repo) {
    if (!repo) return ''
    const mapped = config.repoMap?.[repo]
    if (typeof mapped === 'string' && mapped !== '') return mapped
    if (/^[A-Za-z]:[\\/]/.test(repo) || repo.startsWith('/') || repo.startsWith('.')) return repo
    return ''
  }

  const repoAdapters = {
    prepareWorktree: worktrees
      ? async ({ ticketId, repo }) => {
        const local = repoPath(repo)
        if (!local) return null
        return worktrees.prepare({ repoDir: local, ticketId })
      }
      : undefined,
    disposeWorktree: worktrees
      ? (worktree, options) => worktrees.dispose(worktree, options)
      : undefined,
    deliver: deliveryModule?.deliver
      ? async ({ ticket, worker, worktree, repo }) => deliveryModule.deliver({
        ticket,
        worker,
        worktree,
        repoDir: repoPath(repo) || worker.cwd || '',
        artifactsDir,
        config: {
          mode: String(config.delivery?.mode ?? 'patch'),
          remote: String(config.delivery?.remote ?? 'origin'),
          prBase: String(config.delivery?.prBase ?? ''),
          githubToken: String(config.delivery?.githubToken ?? ''),
          branchPrefix: 'sa/',
          authorName: 'Super Agent',
          authorEmail: 'sa@local',
        },
        log: (level, message) => log(level, message),
      })
      : undefined,
    replySource: replyModule?.replyToSource
      ? ({ ticket, result, summary }) => replyModule.replyToSource({
        ticket,
        result,
        summary,
        config: config.sources ?? {},
      })
      : undefined,
  }

  /** Resolves the provider/model pair this deployment uses for a role. */
  async function modelFor(role) {
    const configured = String((role === 'router' ? config.routerModel : config.workerModel) || '').trim()
    if (configured.includes('/')) {
      const [provider, ...rest] = configured.split('/')
      return { provider, model: rest.join('/') }
    }
    try {
      const catalog = await ctx.sessionController.modelCatalog()
      if (catalog?.default?.provider && catalog?.default?.model) {
        if (configured === '') return { provider: catalog.default.provider, model: catalog.default.model }
        return { provider: catalog.default.provider, model: configured }
      }
    } catch { /* a catalog failure only means "no model", never a crash */ }
    return null
  }

  /**
   * The semantic Slow Path. One model call decides the whole batch, which is what makes a busy
   * Router cheaper per decision. It returns `null` on any failure so the engine falls back to
   * deterministic rules instead of stalling the queue.
   */
  async function llmDecide({ model, policy, candidates }) {
    const llm = ctx.get('llm')
    if (!llm || typeof llm.stream !== 'function') return null
    let route = null
    try {
      route = await modelFor('router')
    } catch { route = null }
    if (!route) return null
    if (model && model.includes('/')) {
      const [provider, ...rest] = model.split('/')
      route = { provider, model: rest.join('/') }
    }
    const system = [
      policy,
      '',
      '输出要求：只输出一个 JSON 数组，不要 Markdown 代码块，不要解释。',
      '数组每一项对应一条候选事件，字段：',
      '{"index": 候选序号, "verdict": "accept" | "reject", "reason": "一句话理由", "title": "工单标题（accept 时）", "ruleId": "命中的规则 id 或 null", "risk": "low" | "medium" | "high", "needsDecision": true | false}',
      'needsDecision 只在结果必须由人拍板（方案选择、验收、对外影响）时为 true。',
      '宁可拒绝也不要制造无价值的工作：闲聊、已解决、需要更多信息后才能开始的，一律 reject。',
    ].join('\n')
    const user = `候选事件（共 ${candidates.length} 条）：\n${JSON.stringify(candidates, null, 2)}`
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 45_000)
    if (typeof timeout.unref === 'function') timeout.unref()
    try {
      const chunks = []
      for await (const chunk of llm.stream({
        provider: route.provider,
        model: route.model,
        system,
        messages: [{ role: 'user', content: [{ type: 'text', text: user }] }],
        maxTokens: 1200,
        temperature: 0,
        signal: controller.signal,
      })) {
        if (chunk?.type === 'text-delta') chunks.push(chunk.text)
        if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') throw new Error(chunk.reason.failure?.message ?? 'model error')
      }
      return parseDecisions(chunks.join(''), candidates.length)
    } finally {
      clearTimeout(timeout)
    }
  }

  /** Tolerant JSON extraction: the model may wrap the array in prose or a fenced block. */
  function parseDecisions(text, expected) {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end <= start) return null
    let parsed
    try {
      parsed = JSON.parse(text.slice(start, end + 1))
    } catch { return null }
    if (!Array.isArray(parsed)) return null
    const decisions = parsed.map((item, index) => ({
      index: Number.isInteger(item?.index) ? item.index : index,
      verdict: item?.verdict === 'accept' ? 'accept' : 'reject',
      reason: typeof item?.reason === 'string' ? item.reason : '',
      title: typeof item?.title === 'string' ? item.title : undefined,
      ruleId: typeof item?.ruleId === 'string' ? item.ruleId : null,
      risk: typeof item?.risk === 'string' ? item.risk : 'low',
      needsDecision: item?.needsDecision === true,
    }))
    if (decisions.length !== expected) return null
    return decisions
  }

  /** Remote-decorated Session methods take the caller cancellation signal as their second argument. */
  const signalFor = () => new AbortController().signal

  /** Builds the one prompt a Worker receives, through the Host's own prompt admission. */
  function promptText(id, text) {
    return { requestId: String(id), content: [{ type: 'text', text }] }
  }

  /** Resolves or creates the Worker Session for a ticket, then wakes it with its assignment. */
  /** One long-lived Session that owns unattended Workers, so the sidebar gains one entry, not one per ticket. */
  let manager = null
  async function managerAgent() {
    if (manager) return manager
    const agents = ctx.get('agents')
    try {
      const resolved = await ctx.sessionController.resolveAgent('sa-manager')
      if (resolved && !('error' in resolved)) { manager = resolved.agent; return manager }
    } catch { /* not created yet */ }
    try {
      await ctx.sessionController.create({ sessionId: 'sa-manager', cwd: safeCwd(), agentPreset: String(config.workerPreset || 'standard') })
    } catch { /* another caller may have created it */ }
    try {
      const resolved = await ctx.sessionController.resolveAgent('sa-manager')
      if (resolved && !('error' in resolved)) { manager = resolved.agent; return manager }
    } catch { /* give up: the worker falls back to its own Session */ }
    return null
  }

  async function createWorker({ worker, assignment }) {
    // A fresh prefix avoids a stale Session id anchored to another directory by an earlier attempt.
    const sessionId = `sa-${worker.ticketId}`
    const cwd = worker.cwd || config.workerCwd || safeCwd()
    worker.cwd = cwd
    let agent = null
    // Preferred: a Worker is a nested subagent of the Session that asked for it (or of the single
    // unattended manager). Subagent Sessions never become a Workspace or a top-level conversation,
    // which is what keeps the sidebar readable after dozens of tickets.
    const agents = ctx.get('agents')
    const presetId = String(config.workerPreset || 'standard')
    let route = null
    try { route = await modelFor('worker') } catch { route = null }
    if (agents && typeof agents.create === 'function') {
      try {
        const parent = worker.parentSessionId ? agents.get?.(worker.parentSessionId) : await managerAgent()
        if (parent) {
          const handle = await agents.create({
            sessionId,
            parentAgent: parent,
            meta: { cwd, parentSession: parent.id, origin: 'subagent', delegationDepth: 1, agentPreset: presetId },
            agentOptions: route ? { provider: route.provider, model: route.model } : undefined,
          })
          agent = handle.agent
          worker.preset = presetId
          worker.nested = true
          worker.parentSessionId = parent.id
          // `agents.create` only records the preset as Session metadata; the preset's plugin rows
          // (fs, pwsh, web, skills) mount through the preset registry. Without this call the Worker
          // starts with host-level tools only and cannot read or edit anything.
          try {
            const presets = ctx.get('agentPresets')
            if (presets && typeof presets.select === 'function') {
              await presets.select(agent, presetId)
              worker.presetMounted = true
            }
          } catch (error) {
            worker.presetError = `select=${String(error?.message ?? error)}`
          }
        }
      } catch (error) {
        worker.nestedError = String(error?.message ?? error)
      }
    }
    if (!agent) {
      // Fallback: a standalone Session anchored to a workspace. This shows up in the sidebar, so it
      // is only used when the Host cannot create a nested subagent.
      let created = false
      const workspaceRegistry = ctx.get('workspaceRegistry')
      let workspaceId = ''
      if (workspaceRegistry && cwd !== '') {
        try {
          const workspace = await workspaceRegistry.create(cwd)
          workspaceId = workspace?.id ?? ''
        } catch (error) {
          worker.presetError = `workspace=${String(error?.message ?? error)}`
        }
      }
      const attempts = workspaceId !== ''
        ? [{ workspaceId, agentPreset: presetId }, { workspaceId }, { cwd, agentPreset: presetId }, { cwd }]
        : [{ cwd, agentPreset: presetId }, { cwd }]
      for (const request of attempts) {
        try {
          await ctx.sessionController.create({ sessionId, ...request })
          created = true
          worker.preset = request.agentPreset ?? 'profile-default'
          break
        } catch (error) {
          worker.presetError = `${worker.presetError ? `${worker.presetError} | ` : ''}${String(error?.message ?? error)}`
        }
      }
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if (!resolved || 'error' in resolved) {
        return { degraded: true, reason: resolved?.error?.code ?? 'session 不可用' }
      }
      agent = resolved.agent
      worker.createNote = `fallback created=${created} cwd=${cwd}`
    }
    worker.sessionId = agent.id
    worker.createNote = `${worker.createNote ? `${worker.createNote} ` : ''}cwd=${cwd} sessionCwd=${agent.session?.header?.cwd ?? ''} preset=${agent.session?.header?.agentPreset ?? ''} nested=${worker.nested === true}`
    // A Session materialized before this call cannot be moved or re-preset; nested creation already
    // picked `standard`, and the fallback recorded whatever the Host accepted.
    worker.sessionId = agent.id
    // A fresh Session has no model selection, and the loop cannot start a request without one.
    try {
      const route = await modelFor('worker')
      if (route) {
        await ctx.sessionController.selectModel({ sessionId, provider: route.provider, model: route.model }, signalFor())
        worker.model = `${route.provider}/${route.model}`
      }
    } catch { /* keep the profile default; the turn will report a model failure */ }
    try {
      ctx.get('permissionPresets')?.set?.(agent.session, 'danger-full-access')
    } catch { /* permissions stay at the profile default */ }
    try {
      await ctx.sessionController.rename({ sessionId, title: `SA · ${worker.title}`.slice(0, 80) }, signalFor())
    } catch { /* a title is cosmetic */ }
    try {
      const admission = promptText(`sa-${worker.ticketId}-assignment`, assignment)
      await deliverWorkerMessage(worker, assignment, admission.requestId)
    } catch (error) {
      return { degraded: true, reason: `无法唤醒会话：${String(error?.message ?? error)}` }
    }
    return { sessionId }
  }

  /**
   * Delivers one message to a Worker. A nested subagent Session is owned by subagent routing, so it
   * takes messages through the subagent service (or `agent.followup`); a standalone Session takes
   * them through the Session controller's prompt admission.
   */
  async function deliverWorkerMessage(worker, text, requestId) {
    if (worker.nested === true) {
      const agents = ctx.get('agents')
      const child = agents?.get?.(worker.sessionId)
      // A one-shot subagent owns its own live Agent: waking it directly is the cheapest path and
      // keeps working even when the subagent service refuses continuation.
      if (child?.followup) {
        try {
          child.followup({ id: requestId ?? `sa-${worker.ticketId}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
          return
        } catch { /* fall through to the subagent service */ }
      }
      const subagents = ctx.get('subagents')
      const parent = worker.parentSessionId ? agents?.get?.(worker.parentSessionId) : undefined
      if (subagents?.sendMessage && parent) {
        try {
          await subagents.sendMessage(parent, worker.sessionId, [{ type: 'text', text }], {})
          return
        } catch { /* fall through to the standalone prompt path */ }
      }
    }
    const admission = promptText(requestId ?? `sa-${worker.ticketId}-msg-${Date.now()}`, text)
    await ctx.sessionController.prompt({ sessionId: worker.sessionId, requestId: admission.requestId, mode: 'queue', content: admission.content }, signalFor())
  }

  /** Direct delivery to one Worker Session (Thread subscription or a person's follow-up). */
  async function deliverToWorker(worker, text) {
    if (!worker?.sessionId) return false
    try {
      await deliverWorkerMessage(worker, text, `sa-${worker.ticketId}-msg-${Date.now()}`)
      return true
    } catch {
      return false
    }
  }

  async function stopWorker(worker) {
    if (!worker?.sessionId) return false
    try {
      await ctx.sessionController.cancel({ sessionId: worker.sessionId })
      return true
    } catch {
      try {
        ctx.sessionController.cancel({ sessionId: worker.sessionId })
        return true
      } catch { return false }
    }
  }

  /** Injects an attention-gated notice into the person's Session without waking it. */
  function notifyAttention(record) {
    const target = ownerSessionId
    if (!target) return
    const agents = ctx.get('agents')
    const live = agents?.get?.(target)
    if (!live || typeof live.inject !== 'function') return
    try {
      // `inject` puts the notice in history without waking the agent: the person reads it, the model is not interrupted.
      live.inject({
        id: `sa-attention-${record.at}`,
        role: 'user',
        content: [{ type: 'text', text: `【Super Agent】${record.reason}：${record.text}` }],
        source: { kind: 'user' },
      })
    } catch { /* best-effort: the console still shows every attention record */ }
  }

  function safeCwd() {
    try {
      const workingDirectory = ctx.get('workingDirectory')
      if (typeof workingDirectory?.defaultDirectory === 'string' && workingDirectory.defaultDirectory !== '') {
        return workingDirectory.defaultDirectory
      }
    } catch { /* fall through */ }
    try {
      const roots = ctx.get('agents')?.roots?.() ?? []
      const session = roots[roots.length - 1]?.session
      return session?.header?.cwd || process.env.DSH_WORKSPACE_DIR || process.cwd()
    } catch {
      return process.env.DSH_WORKSPACE_DIR || process.cwd()
    }
  }

  /** The directory of the Session that issued a tool call, so its Worker runs in the same project. */
  function callerCwd(exec) {
    try {
      return exec?.agent?.session?.header?.cwd || ''
    } catch {
      return ''
    }
  }

  /** The Session id that issued a tool call; a Worker becomes its nested subagent. */
  function callerId(exec) {
    try {
      return exec?.agent?.id ? String(exec.agent.id) : ''
    } catch {
      return ''
    }
  }

  /** Merges a patch into this row's own config through the Host's config editor. */
  async function saveConfig(patch) {
    if (!patch || typeof patch !== 'object') throw new Error('config 需要一个对象')
    const entry = ctx.fiber?.entry
    const editor = ctx.get('configEditor')
    if (!entry || !editor || typeof editor.edit !== 'function') throw new Error('当前 profile 不支持持久化配置')
    await editor.edit(entry, current => {
      const next = { ...(current ?? {}) }
      for (const [key, value] of Object.entries(patch)) {
        next[key] = value && typeof value === 'object' && !Array.isArray(value) && next[key] && typeof next[key] === 'object'
          ? { ...next[key], ...value }
          : value
      }
      return next
    })
    return { saved: true }
  }

  /**
   * Removes the sidebar clutter this bundle can create: worktree Workspaces and Worker Sessions.
   * Workers are nested subagents now, so this only ever touches sessions whose ids start `sa-`,
   * plus Workspaces whose path is inside `<stateDir>/worktrees`.
   */
  async function cleanupSuperAgent() {
    const registry = ctx.get('workspaceRegistry')
    const report = { sessionsArchived: 0, workspacesDeleted: 0, errors: [] }
    if (!registry) { report.errors.push('workspaceRegistry 不可用'); return report }
    try {
      const sessions = await ctx.sessionController.list({}, signalFor())
      for (const item of sessions?.items ?? []) {
        const id = String(item.sessionId ?? '')
        if (!/^sa-(worker-)?[a-z]?\d*$/i.test(id) && !id.startsWith('sa-')) continue
        try {
          await registry.archiveSession(id)
          report.sessionsArchived += 1
        } catch (error) {
          report.errors.push(`${id}: ${String(error?.message ?? error)}`)
        }
      }
    } catch (error) {
      report.errors.push(`list sessions: ${String(error?.message ?? error)}`)
    }
    const root = join(stateDir, 'worktrees')
    try {
      for (const workspace of await registry.list()) {
        const path = String(workspace?.path ?? '')
        if (!path.startsWith(root)) continue
        try {
          await registry.delete(workspace.id)
          report.workspacesDeleted += 1
        } catch (error) {
          report.errors.push(`${path}: ${String(error?.message ?? error)}`)
        }
      }
    } catch (error) {
      report.errors.push(`list workspaces: ${String(error?.message ?? error)}`)
    }
    report.errors = report.errors.slice(0, 10)
    return report
  }

  const engine = new SuperAgentEngine({
    config: {
      acceptMode: config.acceptMode,
      runner: config.runner,
      maxWorkers: config.maxWorkers,
      routerModel: config.routerModel,
      workerModel: config.workerModel,
      watchdogIntervalMs: config.watchdogIntervalMs,
      staleAfterMs: config.staleAfterMs,
      batchWindowMs: config.batchWindowMs,
      batchSize: config.batchSize,
      notifySessionId: config.notifySessionId,
      acceptSources: Array.isArray(config.acceptSources) ? config.acceptSources : [],
      budget: { ...DEFAULTS.budget, ...(config.budget ?? {}) },
    },
    store,
    adapter: { llmDecide, createWorker, deliverToWorker, stopWorker, notifyAttention, ...repoAdapters },
    log: (level, message, error) => {
      const line = `[super-agent] ${message}${error ? `: ${String(error?.message ?? error)}` : ''}`
      if (level === 'warn') ctx.logger?.warn?.(line)
      else ctx.logger?.info?.(line)
    },
  })
  store.onError = error => ctx.logger?.warn?.(`[super-agent] state save failed: ${String(error?.message ?? error)}`)
  await engine.start()
  if (worktrees) {
    try { await worktrees.prune() } catch (error) { log('warn', 'worktree registry prune failed', error) }
  }

  // ---------------------------------------------------------------- DSH wiring

  // 1. The console's data plane.
  const disposeRoute = ctx.webServer.register({
    kind: 'prefix',
    path: '/api/super-agent',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', `http://${req.headers?.host ?? '127.0.0.1'}`)
      const path = url.pathname
      const send = (status, value) => {
        const body = JSON.stringify(value)
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
        res.end(body)
      }
      try {
        if (req.method === 'GET' && (path === '/api/super-agent' || path === '/api/super-agent/state')) {
          return send(200, engine.snapshot())
        }
        if (req.method === 'GET' && path === '/api/super-agent/health') {
          return send(200, { ok: true, ...engine.health() })
        }
        if (req.method === 'POST' && path === '/api/super-agent/command') {
          const body = await readJson(req)
          if (body?.command === 'config') {
            // Persisting config restarts the plugin row, so answer best-effort and let the caller poll state.
            try { await saveConfig(body.config ?? body.args?.config ?? body.args ?? {}) } catch { /* reported below */ }
            return send(200, { ok: true, result: { saved: true, restarting: true } })
          }
          if (body?.command === 'cleanup') {
            return send(200, { ok: true, result: await cleanupSuperAgent() })
          }
          const result = await engine.command(body)
          return send(200, { ok: true, result })
        }
        if (req.method === 'POST' && path === '/api/super-agent/hook') {
          // External Trigger sources (GitHub, CI, IM bridges) post here. A configured secret turns
          // this into an authenticated endpoint; without one it is a loopback-only convenience.
          const raw = await readBody(req)
          const secret = String(config.sources?.ci?.secret ?? '')
          if (secret !== '') {
            const header = String(req.headers['x-hub-signature-256'] ?? req.headers['x-signature'] ?? '')
            const valid = webhookModule?.verifySignature
              ? webhookModule.verifySignature({ secret, body: raw, header })
              : false
            if (!valid) return send(401, { ok: false, error: 'invalid signature' })
          }
          let payload
          try { payload = raw === '' ? {} : JSON.parse(raw) } catch { return send(400, { ok: false, error: 'invalid json' }) }
          const headers = Object.fromEntries(Object.entries(req.headers ?? {}).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(',') : String(value ?? '')]))
          let event = null
          if (webhookModule) {
            const kind = String(headers['x-github-event'] ?? '')
            event = kind !== ''
              ? webhookModule.parseGitHubWebhook({ headers, body: raw, payload })
              : webhookModule.parseCIWebhook({ headers, body: raw, payload })
          }
          if (!event) {
            event = {
              source: String(payload.source ?? 'webhook'),
              author: String(payload.author ?? 'webhook'),
              text: String(payload.text ?? ''),
              threadId: payload.threadId ? String(payload.threadId) : undefined,
              repo: payload.repo ? String(payload.repo) : undefined,
              url: payload.url ? String(payload.url) : undefined,
              externalId: payload.externalId ? String(payload.externalId) : undefined,
              human: payload.human === true,
            }
          }
          const result = engine.ingest(event)
          return send(202, { ok: true, result, source: event.source, threadId: event.threadId ?? null })
        }
        return send(404, { ok: false, error: 'not found' })
      } catch (error) {
        return send(400, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })

  // 2. Two clocks: the Router batch, and the Watchdog's independent patrol.
  const disposeRouterTimer = setInterval(() => {
    engine.tickRouter().catch(error => ctx.logger?.warn?.(`[super-agent] router tick failed: ${String(error?.message ?? error)}`))
  }, Math.max(400, Number(config.batchWindowMs) || 1200))
  const disposeWatchdogTimer = setInterval(() => {
    try { engine.tickWatchdog() } catch (error) { ctx.logger?.warn?.(`[super-agent] watchdog failed: ${String(error?.message ?? error)}`) }
  }, Math.max(3000, Number(config.watchdogIntervalMs) || 15_000))
  if (typeof disposeRouterTimer.unref === 'function') disposeRouterTimer.unref()
  if (typeof disposeWatchdogTimer.unref === 'function') disposeWatchdogTimer.unref()

  // 2b. Real Trigger sources. Each one is optional and owns its timer; stopping the plugin stops it.
  const sourceStops = []
  const inbox = config.sources?.inbox ?? {}
  if (inbox.enabled === true && inboxModule?.createInboxSource) {
    const dir = String(inbox.dir || join(stateDir, 'inbox'))
    try {
      const source = inboxModule.createInboxSource({
        dir,
        intervalMs: Number(inbox.intervalMs) || 2000,
        onEvent: event => engine.ingest(event),
        log,
      })
      source.start()
      sourceStops.push(() => source.stop())
      log('info', `inbox source watching ${dir}`)
    } catch (error) {
      log('warn', 'inbox source failed to start', error)
    }
  }
  const github = config.sources?.github ?? {}
  if (github.enabled === true && githubModule?.createGitHubSource) {
    try {
      const source = githubModule.createGitHubSource({
        repos: Array.isArray(github.repos) ? github.repos : [],
        token: String(github.token || ''),
        intervalMs: Number(github.intervalMs) || 60_000,
        allowAuthors: Array.isArray(github.allowAuthors) ? github.allowAuthors : [],
        stateDir: join(stateDir, 'github'),
        onEvent: event => engine.ingest(event),
        log,
      })
      source.start()
      sourceStops.push(() => source.stop())
      log('info', `github source watching ${(github.repos ?? []).join(', ')}`)
    } catch (error) {
      log('warn', 'github source failed to start', error)
    }
  }

  // 3. Session events are the only source of Worker progress (no polling of agent status).
  const disposeSessionEvents = ctx.on('session/event', (session, event) => {
    try { engine.noteSessionEvent(session.id, event) } catch (error) { ctx.logger?.warn?.(`[super-agent] worker event failed: ${String(error?.message ?? error)}`) }
  })

  // 4. One tool: the control plane the agent itself can drive, with a compact action switch.
  const disposeTool = ctx.tools.register({
    name: 'superagent',
    description: 'Super Agent 控制面：查看 Router/Worker 状态、注入触发器、派单、切换自主模式、立即巡检、重放论文实验。用于用户想了解或驱动 Super Agent 体系时。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'trigger', 'dispatch', 'mode', 'watchdog', 'demo', 'metrics', 'config', 'cleanup', 'reset'],
          description: 'status=总览；trigger=注入一条环境事件走两级准入；dispatch=直接派真实 Worker 会话；mode=切换 observe/accept；watchdog=立即巡检；demo=重放论文实验负载；metrics=只读指标；config=持久化本插件配置；cleanup=清理本插件产生的 Worker 会话与工作区分组；reset=清空记录',
        },
        config: { type: 'object', additionalProperties: true, description: 'config 动作要合并的配置，例如 {"sources":{"inbox":{"enabled":true,"dir":"..."}}}' },
        text: { type: 'string', description: 'trigger 的事件正文，或 dispatch 的任务简述' },
        source: { type: 'string', description: 'trigger 的来源：github / feishu / ci / chat / email' },
        title: { type: 'string', description: 'dispatch 的工单标题' },
        accept: { type: 'string', enum: ['observe', 'accept'], description: 'mode 的目标模式' },
        paused: { type: 'boolean', description: 'mode 是否暂停 Router' },
        repo: { type: 'string', description: 'dispatch 的目标仓库：本地路径，或 patch 里 repoMap 的键（决定在哪个工作树里干活）' },
        workerId: { type: 'string', description: '可选：停止某个 Worker' },
      },
      required: ['action'],
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async (args, exec) => {
      const action = String(args?.action ?? 'status')
      if (action === 'status') {
        const snapshot = engine.snapshot()
        return {
          mode: snapshot.mode,
          admission: snapshot.admission.funnel,
          workers: snapshot.workers.map(worker => ({ id: worker.id, title: worker.title, status: worker.status, progress: worker.progress })),
          threads: snapshot.threads.map(thread => ({ id: thread.id, title: thread.title, subscribers: thread.subscribers })),
          watchdog: snapshot.watchdog.state,
          attention: { emitted: snapshot.attention.emitted, suppressed: snapshot.attention.suppressed },
          metrics: snapshot.metrics,
        }
      }
      if (action === 'trigger') {
        if (!args?.text) throw new Error('trigger 需要 text')
        const result = engine.ingest({ source: args?.source ?? 'console', author: 'agent', text: String(args.text), human: true })
        await engine.tickRouter()
        return result
      }
      if (action === 'dispatch') {
        if (!args?.title && !args?.text) throw new Error('dispatch 需要 title 或 text')
        return engine.dispatch({
          title: String(args.title ?? args.text),
          brief: String(args.text ?? args.title),
          source: args?.source ? String(args.source) : 'agent',
          repo: args?.repo ? String(args.repo) : '',
          parentSessionId: callerId(exec) || undefined,
          cwd: callerCwd(exec) || config.workerCwd || undefined,
        })
      }
      if (action === 'mode') {
        return engine.command({ command: 'mode', args: { accept: args?.accept, paused: args?.paused } })
      }
      if (action === 'config') {
        const patch = args?.config ?? (args?.configJson ? JSON.parse(String(args.configJson)) : undefined)
        if (!patch) throw new Error('config 需要 config 对象，例如 {"budget":{"maxWorkersPerHour":20}}')
        return saveConfig(patch)
      }
      if (action === 'cleanup') return cleanupSuperAgent()
      if (action === 'watchdog') return engine.tickWatchdog()
      if (action === 'demo') return engine.command({ command: 'demo', args: {} })
      if (action === 'reset') return engine.command({ command: 'reset' })
      if (action === 'metrics') {
        const snapshot = engine.snapshot()
        return { metrics: snapshot.metrics, compare: snapshot.compare, router: snapshot.router, attention: snapshot.attention }
      }
      if (args?.workerId) return engine.command({ command: 'stop', args: { workerId: args.workerId } })
      throw new Error(`未知动作：${action}`)
    },
  })

  // 5. A short prompt section: the person's Session knows the console exists and how to drive it.
  const disposePrompt = ctx.systemPrompt.section({
    name: 'super-agent',
    order: 61,
    text: () => [
      '## Super Agent 控制面',
      '本 Harness 运行着一套 Super Agent 体系（Router 分派 / Worker 隔离执行 / 两级触发器准入 / 线程订阅直通 / 看门狗 / 注意力闸门）。',
      '用户询问它的状态、想注入事件、派单或切换自主模式时，调用 `superagent` 工具（action=status|trigger|dispatch|mode|watchdog|demo|metrics）。',
      '可视化控制台在左侧栏 Super Agent 图标里，数据由 /api/super-agent/state 提供。',
      '注意：本体系默认 observe 模式，主动任务只记录不执行；只有明确要求或书面规则允许时才行动，且只在有可用结果、需要人决策或失败时打扰人。',
    ].join('\n'),
  })

  ctx.effect(() => async () => {
    clearInterval(disposeRouterTimer)
    clearInterval(disposeWatchdogTimer)
    for (const stop of sourceStops) {
      try { await stop() } catch { /* a source that already stopped is fine */ }
    }
    disposeRoute()
    disposeSessionEvents?.()
    disposeTool()
    disposePrompt()
    await engine.dispose()
  })

  // The person's Session is whichever one is active when a console command arrives; the tool
  // itself records it, and the HTTP route cannot attribute a peer, so both stay best-effort.
  ctx.on('agent/created', ({ agent }) => {
    if (!ownerSessionId) ownerSessionId = agent.id
  })

  ctx.logger?.info?.(`[super-agent] ready · ${stateDir} · mode ${config.acceptMode} · runner ${config.runner}`)
}

/** Reads a bounded body as UTF-8 text (webhook signatures cover the raw bytes). */
function readBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('payload too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** Reads a bounded JSON request body. */
function readJson(req, limit = 1_000_000) {
  return readBody(req, limit).then(text => {
    if (text.trim() === '') return {}
    return JSON.parse(text)
  })
}
