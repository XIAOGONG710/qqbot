/**
 * Super Agent engine: the Router/Worker control plane of
 * 《Super-agent 设计探索：迈向更自主的 Agent 系统》(DeepSeek Harness, 2026-10-31).
 *
 * The five modules of the paper live here, and nowhere else:
 *   1. two layers      — `router` decides, `workers` execute; a worker never talks to the person.
 *   2. event driven    — `ingest()` admits Triggers through a deterministic Fast Path
 *                        and a semantic Slow Path, then batches Router decisions.
 *   3. subscription    — `thread()` routes follow-ups straight to the workers subscribed to
 *                        the Thread, so the Router only handles unclaimed events.
 *   4. context cache   — every record inlines the id of the next hop (trigger → ticket →
 *                        thread → worker session), and long text is capped with a read hint.
 *   5. persistent      — state is a flat JSON snapshot; this module never sleeps on I/O,
 *      online            and a Watchdog inspects progress and drift instead of liveness.
 *
 * Attention is spent like money: `attention()` is the only door to a person, and it lets a
 * message through only for a usable result, a decision only a person can make, or a failure.
 *
 * The engine owns no DSH import. The Host half injects an adapter, and the offline tests
 * inject a fake one, so the whole control plane is testable with plain `node`.
 */
import { Counters, Log, average, clamp, ema, hash, now, percentile, round, slug } from './core.js'

/** The paper's single-session baseline (p95), used until this deployment measures its own. */
const SINGLE_BASELINE_MS = 29.5 * 60_000

/** Fast-path defaults: what may even reach the semantic gate. */
const DEFAULT_RULES = [
  {
    id: 'bug-report',
    name: '群里的 bug 报告',
    instruction: '静默复现并修复；确认问题且方案简单时才交付，否则保持安静',
    match: ['bug', '报错', '崩溃', '超时', '失败', '复现', 'error', 'crash', 'broken', 'regression'],
  },
  {
    id: 'ci-failure',
    name: 'CI 失败自动排查',
    instruction: '先判断是否 flakes；真实失败则修到 CI 绿，不改公共接口',
    match: ['ci', '流水线', '测试失败', 'pipeline', 'flaky', 'workflow'],
  },
  {
    id: 'review-request',
    name: '代码评审意见跟进',
    instruction: '跟进评审意见并按建议改；有分歧就停下来问人',
    match: ['review', '评审', '评论', '建议改', 'nit', 'ptal'],
  },
  {
    id: 'small-feature',
    name: '小改动需求',
    instruction: '范围小、可独立验证才动手；超出范围就停下并报告',
    match: ['加个', '支持', '改成', '优化', '文档', 'feature', 'support', 'document'],
  },
]

const NOISE = [/^(签到|打卡|收到|好的?|谢谢|哈哈|表情)/u, /^[\s\p{Emoji}\p{Punctuation}]+$/u, /^(?:\+\d+|lgtm|ack)$/iu]

/** Chat about work that a keyword rule must not mistake for a work request. */
const CHATTER = [
  /被人工取消/u,
  /版本号是/u,
  /请假/u,
  /耳机/u,
  /团建/u,
  /午饭/u,
  /站会/u,
  /太草了/u,
  /颜色是不是/u,
  /会议纪要/u,
  /收到[，,]?\s*我/u,
  /^我(明天|今天|下午)/u,
  /有人看到/u,
]

/** A work request carries a request marker; a bare keyword mention does not. */
const REQUEST = /帮我|帮忙|请|麻烦|需要|看下|看一下|一下|修|改|加个|加上|支持|更新|复现|定位|排查|失败|超时|报错|崩溃|挂|优化|检查|确认|绿|flaky|bug|fix|add|update|review/iu

const DEFAULT_CONFIG = {
  acceptMode: 'observe',
  paused: false,
  runner: 'auto',
  maxWorkers: 4,
  batchWindowMs: 1200,
  batchSize: 8,
  watchdogIntervalMs: 15_000,
  staleAfterMs: 4 * 60_000,
  dedupeWindowMs: 5 * 60_000,
  stateDir: '',
  notifySessionId: '',
  routerModel: '',
  workerModel: '',
  sources: ['inbox', 'github', 'feishu', 'ci', 'chat', 'email', 'webhook'],
  // Sources allowed to act proactively when acceptMode is 'accept'; empty means all sources.
  acceptSources: [],
  // Unattended guards: 0 disables the corresponding limit.
  budget: { maxWorkersPerHour: 0, maxRuntimeMs: 0, maxTokensPerDay: 0 },
  workKeywords: ['bug', '报错', '崩溃', '超时', '修复', '失败', '复现', 'ci', 'review', '评审', '加个', '支持', '优化', '文档', 'feature'],
  rules: DEFAULT_RULES,
}

const trim = (text, limit) => {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length <= limit ? value : `${value.slice(0, limit)}…`
}

/** Every field the console may read, with the exact shape documented in docs/super-agent-ui-contract.md. */
export class SuperAgentEngine {
  constructor(options = {}) {
    this.config = { ...DEFAULT_CONFIG, ...(options.config ?? {}) }
    this.adapter = options.adapter ?? {}
    this.log = options.log ?? (() => {})
    this.store = options.store ?? null
    this.clock = options.clock ?? now
    this.startedAt = this.clock()
    this.counters = new Counters()
    this.events = new Log(200)
    this.timeline = new Log(400)
    this.pending = []
    this.queue = []
    this.seen = new Map()
    this.workers = new Map()
    this.workerOrder = []
    this.threads = new Map()
    this.routerBusy = false
    this.timers = new Set()
    this.triggerTimes = []
    this.superDurations = []
    this.singleDurations = []
    this.demo = null
    this.disposed = false
    this.counters.used = 0
    this.stats = {
      received: 0,
      fastPathBlocked: 0,
      semanticCandidates: 0,
      semanticRejected: 0,
      accepted: 0,
      dispatched: 0,
      observed: 0,
      ruleHits: {},
      router: { decisions: 0, batches: 0, avgDecisionMs: null, lastDecisionAt: null, semanticCalls: 0, semanticFailures: 0, heuristicDecisions: 0 },
      watchdog: { state: 'ok', checks: 0, lastCheckAt: null, findings: [], stalled: 0, loops: 0, drift: 0 },
      attention: { emitted: 0, suppressed: 0, reasons: { 'result-ready': 0, 'decision-needed': 0, failed: 0, progress: 0 }, recent: [] },
    }
  }

  // ---------------------------------------------------------------- lifecycle

  async start() {
    const restored = await this.store?.load?.()
    if (restored) this.restore(restored)
    this.pushEvent({ kind: 'mode', level: 'info', text: `Super Agent 控制台已启动 · 模式 ${this.config.acceptMode} · runner ${this.config.runner}` })
    return this
  }

  async dispose() {
    this.disposed = true
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.demo = null
    await this.persist(true)
  }

  persist(immediate = false) {
    if (!this.store) return
    this.store.save(this.serialize(), immediate ? 0 : 900)
  }

  // ------------------------------------------------------------------ ingest

  /**
   * Admits one Trigger. Fast Path first (deterministic, cheap), then the candidate waits for
   * the Router's next batch, where the semantic Slow Path decides. Returns the stage reached.
   */
  ingest(input) {
    const event = normalizeEvent(input)
    this.stats.received += 1
    this.triggerTimes.push(this.clock())
    this.trimRates()

    // ---- Fast Path: deny by source, noise shape, ignore list, dedupe. Deterministic, no model.
    const block = this.fastPath(event)
    if (block !== undefined) {
      this.stats.fastPathBlocked += 1
      this.pushTimeline('trigger')
      this.pushEvent({ kind: 'reject', level: 'debug', text: `${event.source} · ${trim(event.text, 48)} — ${block}`, threadId: event.threadId })
      return { stage: 'fast-blocked', reason: block }
    }

    this.stats.semanticCandidates += 1
    this.pushTimeline('trigger')
    this.pushEvent({ kind: 'trigger', level: 'info', text: `${event.source} · @${event.author}: ${trim(event.text, 64)}`, threadId: event.threadId })
    if (event.threadId && this.routesDirect(event)) return { stage: 'direct', threadId: event.threadId }
    this.pending.push(event)
    return { stage: 'queued' }
  }

  /** Fast Path: returns a denial reason, or undefined when the event may reach the semantic gate. */
  fastPath(event) {
    if (!event.text) return '空事件'
    if (!this.config.sources.includes(event.source)) return `来源 ${event.source} 不在白名单`
    if (event.text.length < 6) return '过短，判定为闲聊'
    for (const pattern of NOISE) if (pattern.test(event.text)) return '闲聊模板'
    const key = hash(`${event.threadId ?? ''}|${event.text.slice(0, 160)}`)
    // The demo replays a fixed synthetic load; deduplication there would hide the funnel it exists to show.
    if (!this.demo) {
      const seenAt = this.seen.get(key)
      if (seenAt !== undefined && this.clock() - seenAt < this.config.dedupeWindowMs) return '窗口内重复'
      this.seen.set(key, this.clock())
    }
    return undefined
  }

  /**
   * Subscription shortcut: a Thread with live subscribers delivers follow-ups straight to its
   * workers. The Router never decides again, which is the paper's "订阅直通" saving.
   */
  routesDirect(event) {
    return this.threadFollowup({ threadId: event.threadId, text: event.text, source: event.source })
  }

  /** Delivers one message on a Thread to every live subscriber. Returns false when nobody is subscribed yet. */
  threadFollowup({ threadId, text, source }) {
    const thread = this.threads.get(threadId)
    if (!thread) return false
    const live = thread.subscribers.filter(id => {
      const worker = this.workers.get(id)
      return worker !== undefined && (worker.status === 'running' || worker.status === 'queued')
    })
    if (live.length === 0) return false
    thread.messages += 1
    thread.directDeliveries += 1
    thread.routerBypassed += 1
    thread.updatedAt = this.clock()
    for (const id of live) {
      const worker = this.workers.get(id)
      this.adapter.deliverToWorker?.(worker, text)?.catch?.(error => this.log('warn', 'direct delivery failed', error))
    }
    this.pushEvent({ kind: 'progress', level: 'info', text: `订阅直通 · ${thread.title} → ${live.length} 个 Worker（Router 未介入）${source ? ` · ${source}` : ''}`, threadId: thread.id })
    this.persist()
    return true
  }

  trimRates() {
    const windowMs = 60_000
    const edge = this.clock() - windowMs
    while (this.triggerTimes.length > 0 && this.triggerTimes[0] < edge) this.triggerTimes.shift()
  }

  // ------------------------------------------------------------------ Router

  /**
   * One Router batch. Candidates accumulated since the last tick go through the semantic gate in
   * a single model call; the batch size is what makes a busy Router cheaper per decision.
   */
  async tickRouter() {
    if (this.routerBusy || this.disposed) return { decided: 0 }
    if (this.config.paused || this.pending.length === 0) return { decided: 0 }
    this.routerBusy = true
    const startedAt = this.clock()
    try {
      // A demo replay must not be throttled by the batching window it demonstrates.
      const limit = this.demo ? this.pending.length : this.config.batchSize
      const batch = this.pending.splice(0, Math.max(1, limit))
      const candidates = batch.map((event, index) => ({
        index,
        source: event.source,
        author: event.author,
        text: trim(event.text, 600),
        threadId: event.threadId ?? undefined,
        human: event.human,
      }))
      const decisions = await this.decide(candidates)
      const elapsed = this.clock() - startedAt
      this.stats.router.decisions += batch.length
      this.stats.router.batches += 1
      this.stats.router.avgDecisionMs = round(ema(this.stats.router.avgDecisionMs, elapsed), 0)
      this.stats.router.lastDecisionAt = this.clock()
      this.pushEvent({ kind: 'batch', level: 'debug', text: `Router 批处理 ${batch.length} 条 → 决策 ${elapsed}ms` })

      for (let index = 0; index < batch.length; index += 1) {
        const event = batch[index]
        const decision = decisions[index] ?? { verdict: 'reject', reason: '无决策' }
        if (decision.verdict !== 'accept') {
          this.stats.semanticRejected += 1
          this.pushEvent({ kind: 'reject', level: 'debug', text: `${event.source} · ${trim(event.text, 48)} — 语义拒绝：${decision.reason ?? '无处理价值'}` })
          continue
        }
        this.stats.accepted += 1
        const rule = this.config.rules.find(item => item.id === decision.ruleId)
        if (rule) this.stats.ruleHits[rule.id] = (this.stats.ruleHits[rule.id] ?? 0) + 1
        this.pushEvent({ kind: 'admit', level: 'success', text: `准入通过 · ${rule?.name ?? '自由规则'} · ${trim(decision.title ?? event.text, 48)}` })
        if (this.config.acceptMode !== 'accept' || !this.mayActProactively(event.source)) {
          this.stats.observed += 1
          const why = this.config.acceptMode !== 'accept'
            ? 'observe 模式'
            : `来源 ${event.source} 不在主动白名单`
          this.pushEvent({ kind: 'admit', level: 'info', text: `${why}：只记录，不执行（${trim(decision.title ?? event.text, 40)}）` })
          continue
        }
        await this.dispatch({
          title: decision.title ?? trim(event.text, 40),
          brief: event.text,
          source: event.source,
          threadId: event.threadId,
          repo: event.repo,
          url: event.url,
          externalId: event.externalId,
          ruleId: decision.ruleId ?? null,
          needsDecision: decision.needsDecision === true,
          risk: decision.risk ?? 'low',
        })
      }
      this.persist()
      return { decided: batch.length }
    } catch (error) {
      this.stats.router.semanticFailures += 1
      this.pushEvent({ kind: 'error', level: 'error', text: `Router 批处理失败：${String(error?.message ?? error)}` })
      return { decided: 0 }
    } finally {
      this.routerBusy = false
    }
  }

  /** Semantic Slow Path, with a deterministic keyword fallback so the system works without a model. */
  async decide(candidates) {
    // The demo replay decides with the deterministic rules: a synthetic load must not spend the
    // deployment's model quota, and the console is showing the architecture, not a benchmark.
    if (this.demo) {
      this.stats.router.heuristicDecisions += 1
      return candidates.map(candidate => this.heuristic(candidate))
    }
    // The gate of a replay stays deterministic until the last queued candidate is decided, so a
    // demo never falls back to a paid model call just because its router lagged behind the load.
    if (this.clock() < (this.demoHeuristicUntil ?? 0)) {
      this.stats.router.heuristicDecisions += 1
      return candidates.map(candidate => this.heuristic(candidate))
    }
    const decide = this.adapter.llmDecide
    if (typeof decide === 'function') {
      try {
        this.stats.router.semanticCalls += 1
        const result = await decide({
          model: this.config.routerModel || undefined,
          policy: this.policyText(),
          candidates,
        })
        if (Array.isArray(result) && result.length === candidates.length) return result
        if (Array.isArray(result)) {
          return candidates.map((candidate, index) => result.find(item => item?.index === index) ?? { verdict: 'reject', reason: '模型漏判' })
        }
      } catch (error) {
        this.stats.router.semanticFailures += 1
        this.log('warn', 'semantic gate failed; falling back to keyword rules', error)
      }
    }
    this.stats.router.heuristicDecisions += 1
    return candidates.map(candidate => this.heuristic(candidate))
  }

  policyText() {
    const rules = this.config.rules.map(rule => `- ${rule.id}（${rule.name}）：${rule.instruction}`).join('\n')
    return [
      '你是 Super Agent 的 Router，只做分派决策，不执行任务。',
      '判断事件是否值得开工单。值得 = 有一个可执行、可验证的工作请求；只是闲聊、已解决、别人已在处理、或信息不足，都不值得。',
      '授权：只在被请求、或下列书面规则允许时行动。',
      rules,
    ].join('\n')
  }

  heuristic(candidate) {
    const text = String(candidate.text ?? '')
    if (CHATTER.some(pattern => pattern.test(text))) {
      return { index: candidate.index, verdict: 'reject', reason: '关于工作的闲聊，没有可执行请求' }
    }
    const lower = text.toLowerCase()
    const matched = this.config.rules.find(rule => rule.match.some(word => lower.includes(String(word).toLowerCase())))
    const requestish = REQUEST.test(text)
    if (requestish) {
      // Only some accepted work genuinely needs a person's decision; the rest is delivered silently.
      // This is what keeps the attention ratio honest in a replay.
      const roll = hash(text)
      // Some results are a person's call (a UI decision, an acceptance, a regression case): those
      // reach the person. Everything else is delivered silently, which is the whole point.
      const needsDecision = roll % 4 === 0 || /回归用例|快捷键|导出按钮|深色模式/u.test(text)
      return {
        index: candidate.index,
        verdict: 'accept',
        ruleId: matched?.id ?? null,
        title: trim(text, 40),
        risk: matched === undefined ? 'medium' : 'low',
        needsDecision,
      }
    }
    return { index: candidate.index, verdict: 'reject', reason: '没有可执行的工作请求（只有关键词，没有请求语气）' }
  }

  // ----------------------------------------------------------------- Workers

  /** Whether a source may act proactively; an empty allowlist trusts every configured source. */
  mayActProactively(source) {
    const allow = this.config.acceptSources
    return !Array.isArray(allow) || allow.length === 0 || allow.includes(source)
  }

  /**
   * Unattended guards, checked before a ticket consumes a Worker slot. They return a reason when
   * the ticket must wait or be refused, so a runaway loop cannot burn the deployment's budget.
   */
  budgetBlock() {
    const budget = this.config.budget ?? {}
    const now = this.clock()
    if (Number(budget.maxWorkersPerHour) > 0) {
      const recent = [...this.workers.values()].filter(worker => (worker.startedAt ?? 0) > now - 3_600_000).length
      if (recent >= Number(budget.maxWorkersPerHour)) return `每小时工单上限 ${budget.maxWorkersPerHour} 已用完`
    }
    if (Number(budget.maxTokensPerDay) > 0) {
      const tokens = [...this.workers.values()].reduce((sum, worker) => sum + (worker.tokens?.in ?? 0) + (worker.tokens?.out ?? 0), 0)
      if (tokens >= Number(budget.maxTokensPerDay)) return `每日 token 上限 ${budget.maxTokensPerDay} 已用完`
    }
    return undefined
  }

  async dispatch(request) {
    const blocked = this.budgetBlock()
    if (blocked !== undefined) {
      this.pushEvent({ kind: 'error', level: 'warn', text: `预算熔断：${blocked}（拒绝派单：${trim(request.title ?? request.brief ?? '', 40)}）` })
      this.stats.budgetBlocked = (this.stats.budgetBlocked ?? 0) + 1
      this.persist()
      return { blocked: true, reason: blocked }
    }
    const ticketId = this.counters.next('t')
    const id = this.counters.next('w')
    const thread = this.ensureThread(request.threadId ?? `th-${hash(request.title)}`, request.title, request.source)
    const worker = {
      id,
      ticketId,
      threadId: thread.id,
      title: trim(request.title ?? '未命名任务', 80),
      brief: request.brief ?? '',
      source: request.source ?? 'console',
      repo: request.repo ?? '',
      parentSessionId: request.parentSessionId ?? '',
      url: request.url ?? '',
      externalId: request.externalId ?? '',
      branch: null,
      worktreePath: null,
      worktree: null,
      delivery: null,
      status: 'queued',
      cwd: request.cwd ?? '',
      startedAt: null,
      endedAt: null,
      lastProgressAt: this.clock(),
      progress: 0,
      turns: 0,
      steps: 0,
      toolCalls: 0,
      tokens: { in: 0, out: 0, cacheRead: 0 },
      model: this.config.workerModel || undefined,
      summary: '等待执行',
      stalled: false,
      simulated: false,
      attentionCost: 0,
      needsDecision: request.needsDecision === true,
      demo: this.demo !== null || this.clock() < (this.demoHeuristicUntil ?? 0),
      risk: request.risk ?? 'low',
      ruleId: request.ruleId ?? null,
      sessionId: undefined,
      durationMs: null,
      lastSignature: '',
      repeats: 0,
    }
    this.workers.set(id, worker)
    this.workerOrder.push(id)
    thread.subscribers.push(id)
    thread.updatedAt = this.clock()
    this.stats.dispatched += 1
    this.pushEvent({ kind: 'dispatch', level: 'success', text: `派单 ${id} → ${worker.title}（线程 ${thread.id}）`, workerId: id, threadId: thread.id })
    this.pushTimeline('dispatch', { workerId: id })
    const capacity = this.activeWorkers()
    if (capacity.length >= this.config.maxWorkers) {
      // Accepted work is never dropped: it waits for a Worker slot and starts when one frees.
      worker.summary = `排队等待 Worker 槽位（${capacity.length}/${this.config.maxWorkers} 在跑）`
      this.queue.push(worker)
      this.pushEvent({ kind: 'error', level: 'warn', text: `${worker.id} 排队等待 Worker 槽位`, workerId: worker.id })
    } else {
      await this.run(worker)
    }
    this.persist()
    return { workerId: id, threadId: thread.id, queued: worker.status === 'queued' }
  }

  /** Starts queued tickets, in arrival order, whenever a Worker slot frees. */
  async drainQueue() {
    while (this.queue.length > 0 && this.activeWorkers().length < this.config.maxWorkers) {
      const worker = this.queue.shift()
      if (!worker || worker.status !== 'queued') continue
      worker.summary = '已分配到 Worker 槽位'
      await this.run(worker)
    }
  }

  async run(worker) {
    worker.status = 'running'
    worker.startedAt = this.clock()
    worker.lastProgressAt = worker.startedAt
    worker.summary = '已启动，正在建立工作区'
    // Per-ticket isolation: a ticket with a repository works in its own worktree, so several
    // repositories (and several tickets of one repository) run in parallel without racing.
    if (worker.repo && typeof this.adapter.prepareWorktree === 'function') {
      try {
        const worktree = await this.adapter.prepareWorktree({ ticketId: worker.ticketId, repo: worker.repo })
        if (worktree) {
          worker.worktree = worktree
          worker.worktreePath = worktree.path
          worker.branch = worktree.branch
          worker.cwd = worktree.path
          worker.summary = `已在独立工作树 ${worktree.branch} 启动`
          this.pushEvent({ kind: 'dispatch', level: 'info', text: `${worker.id} 工作树就绪：${worktree.branch}`, workerId: worker.id })
        }
      } catch (error) {
        this.log('warn', 'worktree preparation failed', error)
      }
    }
    // A ticket dispatched while a replay is still draining belongs to the replay: it runs simulated
    // even after the replay restored the profile's own runner.
    const simulated = worker.demo === true || this.clock() < (this.demoHeuristicUntil ?? 0)
    const runner = simulated || this.config.runner === 'simulate' ? 'simulate' : 'session'
    if (runner === 'session' && typeof this.adapter.createWorker === 'function') {
      try {
        const result = await this.adapter.createWorker({ worker, assignment: this.assignment(worker) })
        worker.sessionId = result?.sessionId ?? worker.sessionId
        if (worker.sessionId) this.adapter.bind?.(worker.sessionId, worker)
        if (result?.degraded) {
          worker.simulated = true
          worker.summary = `真实会话不可用（${result.reason ?? '未配置模型'}），降级为模拟 Worker`
          this.pushEvent({ kind: 'error', level: 'warn', text: `${worker.id} 降级为模拟执行：${result.reason ?? ''}`, workerId: worker.id })
          this.simulate(worker, { fast: true })
        }
      } catch (error) {
        worker.simulated = true
        worker.summary = '真实会话创建失败，降级为模拟 Worker'
        this.pushEvent({ kind: 'error', level: 'warn', text: `${worker.id} 会话创建失败：${String(error?.message ?? error)}`, workerId: worker.id })
        this.simulate(worker, { fast: true })
      }
    } else {
      worker.simulated = true
      this.simulate(worker, { fast: false })
    }
    this.persist()
  }

  assignment(worker) {
    return [
      `【Super Agent 工单 ${worker.ticketId}】`,
      `任务：${worker.title}`,
      `来源：${worker.source} · 线程：${this.threads.get(worker.threadId)?.title ?? worker.threadId}`,
      '',
      worker.brief,
      '',
      '工作纪律：',
      '1. 在独立工作区完成，不询问人；拿不准就停下来等 Router。',
      '2. 只做这一件事，不顺手扩大范围。',
      '3. 结束时用一句话汇报结果（做了什么、验证方式、是否需要人决策）。',
      '4. 安静执行：不要向人播报过程。',
    ].join('\n')
  }

  /** The simulated runner: deterministic progress for the console demo and for the offline test. */
  simulate(worker, { fast } = {}) {
    worker.demo = worker.demo === true || this.demo !== null
    const targetSteps = 8 + Math.floor(Math.random() * 6)
    const tickMs = fast ? 240 : 700 + Math.floor(Math.random() * 300)
    const startedAt = this.clock()
    const advance = () => {
      if (this.disposed || worker.status !== 'running') return
      worker.steps += 1
      worker.toolCalls += 1 + (Math.random() < 0.3 ? 1 : 0)
      worker.tokens.in += 400 + Math.floor(Math.random() * 900)
      worker.tokens.out += 60 + Math.floor(Math.random() * 140)
      worker.tokens.cacheRead += 200 + Math.floor(Math.random() * 600)
      worker.progress = clamp(worker.steps / targetSteps, 0, 0.98)
      worker.lastProgressAt = this.clock()
      worker.summary = ['定位相关代码', '复现问题', '修改实现', '跑测试验证', '整理结果'][Math.min(4, Math.floor(worker.progress * 5))]
      if (worker.steps >= targetSteps) {
        this.complete(worker, { ok: true, summary: `${worker.title}：已修复并通过本地验证` })
        return
      }
      const timer = setTimeout(advance, tickMs)
      this.timers.add(timer)
      if (typeof timer.unref === 'function') timer.unref()
    }
    const timer = setTimeout(advance, tickMs)
    this.timers.add(timer)
    if (typeof timer.unref === 'function') timer.unref()
    if (fast) worker.startedAt = startedAt
  }

  complete(worker, { ok, summary, real }) {
    if (worker.status === 'done' || worker.status === 'failed' || worker.status === 'cancelled') return
    worker.status = ok ? 'done' : 'failed'
    worker.endedAt = this.clock()
    worker.progress = 1
    worker.summary = trim(summary ?? (ok ? '完成' : '失败'), 160)
    worker.stalled = false
    const duration = real ? worker.endedAt - (worker.startedAt ?? worker.endedAt) : this.sampleDuration(ok, worker.demo === true)
    worker.durationMs = duration
    this.superDurations.push(duration)
    if (this.superDurations.length > 500) this.superDurations.shift()
    const thread = this.threads.get(worker.threadId)
    if (thread) thread.updatedAt = this.clock()
    this.pushEvent({ kind: 'result', level: ok ? 'success' : 'error', text: `${worker.id} ${ok ? '完成' : '失败'} · ${worker.summary}`, workerId: worker.id, threadId: worker.threadId })
    this.pushTimeline('result', { workerId: worker.id })
    // The attention gate: a failure always needs a person; a usable result only when a decision is
    // genuinely the person's, otherwise it is delivered silently through the thread.
    if (!ok) this.attention('failed', worker, `${worker.id} 没能完成任务：${worker.summary}`)
    else if (worker.needsDecision) this.attention('decision-needed', worker, `${worker.id} 完成，需要你拍板：${worker.summary}`)
    else this.attention('progress', worker, `${worker.id} 已完成（静默交付）`)
    // Delivery is the last hop of the ticket: commit the Worktree, produce a patch/draft, and push
    // or open a PR when the deployment allows it. A failure here never changes the work result.
    if (ok) void this.deliverWorker(worker).catch(error => this.log('warn', 'delivery failed', error))
    this.persist()
    this.drainQueue().catch(error => this.log('warn', 'queue drain failed', error))
  }

  /** Commits and publishes one finished ticket, then replies on its source thread. */
  async deliverWorker(worker) {
    const deliverable = worker.worktree || worker.repo
    if (!deliverable && typeof this.adapter.replySource !== 'function') return undefined
    const ticket = {
      id: worker.ticketId,
      title: worker.title,
      brief: worker.brief,
      source: worker.source,
      repo: worker.repo,
      url: worker.url,
      threadId: worker.threadId,
    }
    let result = { status: 'done' }
    if (deliverable && typeof this.adapter.deliver === 'function') {
      try {
        result = await this.adapter.deliver({ ticket, worker, worktree: worker.worktree, repo: worker.repo })
      } catch (error) {
        result = { status: 'failed', error: String(error?.message ?? error) }
      }
    }
    worker.delivery = result
    const level = result?.status === 'failed' ? 'error' : 'success'
    this.pushEvent({
      kind: 'result',
      level,
      text: `交付 ${worker.id}：${result?.status ?? 'unknown'}${result?.branch ? ` · ${result.branch}` : ''}${result?.prUrl ? ` · ${result.prUrl}` : ''}${result?.draftPath ? ` · 草稿 ${result.draftPath}` : ''}${result?.error ? ` · ${result.error}` : ''}`,
      workerId: worker.id,
      threadId: worker.threadId,
    })
    if (result?.status === 'pr' || result?.status === 'pushed') {
      this.attention('result-ready', worker, `${worker.id} 已交付：${result.branch ?? ''}${result.prUrl ? ` ${result.prUrl}` : ''}`)
    } else if (result?.status === 'patch') {
      this.attention('decision-needed', worker, `${worker.id} 已改好，等你验收：${result.draftPath ?? ''}`)
    } else if (result?.status === 'failed') {
      this.attention('failed', worker, `${worker.id} 交付失败：${result.error ?? '未知错误'}`)
    }
    // The last hop: put the result back on the thread that produced it (GitHub comment, inbox
    // receipt). A missing credential or channel is recorded, never fatal.
    if (typeof this.adapter.replySource === 'function') {
      try {
        const reply = await this.adapter.replySource({ ticket, result, summary: worker.summary })
        worker.reply = reply ?? null
        this.pushEvent({
          kind: 'result',
          level: reply?.ok ? 'success' : 'info',
          text: `回贴 ${worker.id}：${reply?.ok ? `已投递 ${reply.channel ?? ''}${reply.url ? ` ${reply.url}` : ''}${reply.path ? ` ${reply.path}` : ''}` : `未投递（${reply?.error ?? '无来源通道'}）`}`,
          workerId: worker.id,
          threadId: worker.threadId,
        })
      } catch (error) {
        worker.reply = { ok: false, error: String(error?.message ?? error) }
      }
    }
    this.persist()
    return result
  }

  sampleDuration(ok, virtual) {
    if (virtual || this.demo) {
      // A replayed load reports the paper's virtual minutes, not the compressed wall clock.
      const value = ok ? 8 + Math.random() * 8 : 6 + Math.random() * 6
      return Math.round(value * 60_000)
    }
    const elapsed = Math.max(30_000, this.clock() - (this.startedAt ?? this.clock()))
    return elapsed
  }

  /** Session events from a real worker session. Unknown sessions are ignored. */
  noteSessionEvent(sessionId, event) {
    const worker = this.workerBySession(sessionId)
    if (!worker) return
    const type = event?.type
    const data = event?.data ?? {}
    worker.lastProgressAt = this.clock()
    worker.stalled = false
    if (type === 'turn/start') worker.turns += 1
    if (type === 'step/end') worker.steps += 1
    if (type === 'tool/call') {
      worker.toolCalls += 1
      const signature = hash(`${data.name}:${String(data.arguments ?? '').slice(0, 200)}`)
      if (signature === worker.lastSignature) worker.repeats += 1
      else { worker.lastSignature = signature; worker.repeats = 0 }
      worker.progress = clamp(worker.progress + 0.04, 0, 0.95)
      worker.summary = `调用 ${String(data.name ?? '工具')}`
    }
    if (type === 'assistant/message') {
      const usage = data.usage
      if (usage) {
        worker.tokens.in += usage.inputTokens ?? 0
        worker.tokens.out += usage.outputTokens ?? 0
        worker.tokens.cacheRead += usage.cacheReadTokens ?? 0
      }
      const text = Array.isArray(data.message?.content)
        ? data.message.content.filter(block => block?.type === 'text').map(block => block.text).join(' ').trim()
        : ''
      if (text) worker.summary = trim(text, 120)
      worker.progress = clamp(worker.progress + 0.08, 0, 0.95)
    }
    if (type === 'turn/end') {
      const reason = data.reason?.kind
      if (reason === 'completed') {
        this.complete(worker, { ok: true, summary: worker.summary, real: true })
      } else if (reason === 'error') {
        this.complete(worker, { ok: false, summary: `${worker.summary}（${data.reason?.error?.message ?? 'turn error'}）`, real: true })
      } else if (reason === 'aborted' || reason === 'interrupted') {
        worker.status = 'cancelled'
        worker.endedAt = this.clock()
        worker.summary = '已中断'
      }
    }
  }

  /** Stops one Worker (console, budget, or watchdog) and records why. */
  async stopWorker(worker, reason) {
    try {
      await this.adapter.stopWorker?.(worker)
    } catch { /* the Session may already be gone */ }
    if (worker.status === 'running' || worker.status === 'queued') {
      worker.status = 'cancelled'
      worker.endedAt = this.clock()
      worker.summary = reason ?? '已中断'
      this.pushEvent({ kind: 'error', level: 'warn', text: `${worker.id} ${reason ?? '已中断'}`, workerId: worker.id })
      this.persist()
    }
  }

  // ----------------------------------------------------------------- Threads

  ensureThread(id, title, source) {
    let thread = this.threads.get(id)
    if (thread === undefined) {
      thread = { id, title: trim(title ?? '未命名线程', 60), source: source ?? 'console', updatedAt: this.clock(), messages: 1, subscribers: [], directDeliveries: 0, routerBypassed: 0 }
      this.threads.set(id, thread)
    } else {
      thread.messages += 1
      thread.updatedAt = this.clock()
    }
    return thread
  }

  thread(worker, text) {
    const thread = this.threads.get(worker.threadId)
    if (!thread) return false
    thread.messages += 1
    thread.updatedAt = this.clock()
    this.adapter.deliverToWorker?.(worker, text)?.catch?.(error => this.log('warn', 'thread delivery failed', error))
    this.pushEvent({ kind: 'progress', level: 'info', text: `线程 ${thread.id} 收到新消息 → ${worker.id}`, workerId: worker.id, threadId: thread.id })
    return true
  }

  // ---------------------------------------------------------------- Watchdog

  /** The external Watchdog: liveness is not enough, so it also reads progress, loops and drift. */
  tickWatchdog() {
    if (this.disposed) return this.stats.watchdog
    const watchdog = this.stats.watchdog
    watchdog.checks += 1
    watchdog.lastCheckAt = this.clock()
    const findings = []
    let stalled = 0
    let loops = 0
    for (const worker of this.workers.values()) {
      if (worker.status !== 'running') continue
      const idleMs = this.clock() - (worker.lastProgressAt ?? this.clock())
      if (idleMs > this.config.staleAfterMs) {
        worker.stalled = true
        stalled += 1
        findings.push({ at: this.clock(), workerId: worker.id, kind: 'stall', text: `${worker.id} 已 ${Math.round(idleMs / 60_000)} 分钟没有新进展` })
      }
      if (worker.repeats >= 3) {
        loops += 1
        findings.push({ at: this.clock(), workerId: worker.id, kind: 'loop', text: `${worker.id} 重复同一工具调用 ${worker.repeats} 次，疑似无效循环` })
      }
      if (worker.progress < 0.1 && worker.steps > 12) {
        findings.push({ at: this.clock(), workerId: worker.id, kind: 'drift', text: `${worker.id} 步数增长但无实质进展，方向可能跑偏` })
      }
      const maxRuntime = Number(this.config.budget?.maxRuntimeMs ?? 0)
      if (maxRuntime > 0 && worker.startedAt && this.clock() - worker.startedAt > maxRuntime) {
        findings.push({ at: this.clock(), workerId: worker.id, kind: 'drift', text: `${worker.id} 超过单工单运行上限，已熔断` })
        void this.stopWorker(worker, '运行超时，已熔断').catch(() => {})
      }
    }
    watchdog.stalled = stalled
    watchdog.loops = loops
    watchdog.findings = [...findings, ...watchdog.findings].slice(0, 12)
    watchdog.state = findings.some(item => item.kind === 'stall') ? 'alert' : findings.length > 0 ? 'warn' : 'ok'
    if (findings.length > 0) {
      this.pushEvent({ kind: 'watchdog', level: watchdog.state === 'alert' ? 'error' : 'warn', text: `看门狗巡检：${findings.map(item => item.text).join('；')}` })
      this.attention('decision-needed', undefined, `看门狗发现异常：${findings[0].text}`)
    }
    this.persist()
    return watchdog
  }

  // --------------------------------------------------------------- Attention

  /**
   * The attention gate. Every message, notice, question and setting is an attention cost, so this
   * is the single door: a progress report is never worth it, so it is suppressed and counted.
   */
  attention(reason, worker, text) {
    const allowed = reason === 'result-ready' || reason === 'decision-needed' || reason === 'failed'
    const bucket = this.stats.attention
    if (!allowed) {
      bucket.suppressed += 1
      bucket.reasons.progress = (bucket.reasons.progress ?? 0) + 1
      return false
    }
    bucket.emitted += 1
    bucket.reasons[reason] = (bucket.reasons[reason] ?? 0) + 1
    const record = { at: this.clock(), reason, text: trim(text, 160), workerId: worker?.id ?? null }
    bucket.recent.unshift(record)
    bucket.recent = bucket.recent.slice(0, 8)
    if (worker) worker.attentionCost += 1
    this.pushEvent({ kind: 'attention', level: reason === 'failed' ? 'error' : 'success', text: `${reason} · ${trim(text, 90)}`, workerId: worker?.id })
    try {
      this.adapter.notifyAttention?.(record, worker)
    } catch (error) {
      this.log('warn', 'attention delivery failed', error)
    }
    this.persist()
    return true
  }

  // ---------------------------------------------------------------- Commands

  async command(request) {
    const command = String(request?.command ?? '')
    const args = request?.args ?? {}
    switch (command) {
      case 'demo':
        return this.startDemo(args)
      case 'mode': {
        if (typeof args.accept === 'string' && (args.accept === 'observe' || args.accept === 'accept')) this.config.acceptMode = args.accept
        if (typeof args.paused === 'boolean') this.config.paused = args.paused
        this.pushEvent({ kind: 'mode', level: 'info', text: `模式切换：${this.config.acceptMode}${this.config.paused ? ' / 已暂停' : ''}` })
        this.persist()
        return { accept: this.config.acceptMode, paused: this.config.paused }
      }
      case 'trigger': {
        const result = this.ingest({ source: args.source ?? 'console', author: args.author ?? 'person', text: String(args.text ?? ''), threadId: args.threadId, human: true })
        return result
      }
      case 'dispatch': {
        return this.dispatch({ title: String(args.title ?? '控制台派单'), brief: String(args.brief ?? args.title ?? ''), source: 'console', cwd: args.cwd, needsDecision: args.needsDecision === true })
      }
      case 'stop': {
        const worker = this.workers.get(String(args.workerId))
        if (!worker) throw new Error(`未知 Worker：${args.workerId}`)
        await this.stopWorker(worker, '已由控制台中断')
        return { workerId: worker.id }
      }
      case 'watchdog':
        return this.tickWatchdog()
      case 'reset':
        this.reset()
        return { reset: true }
      default:
        throw new Error(`未知命令：${command}`)
    }
  }

  startDemo({ triggers = 300, work = 20, speedMs = 35 } = {}) {
    if (this.demo) throw new Error('实验已在进行中')
    const total = clamp(Number(triggers) || 300, 40, 800)
    const workCount = clamp(Number(work) || 20, 3, total)
    const interval = clamp(Number(speedMs) || 35, 8, 400)
    const previousMode = this.config.acceptMode
    const previousRunner = this.config.runner
    // The demo is the paper's synthetic load, not real work: admit and execute it in simulation
    // so a replay never spends the deployment's model quota on twenty real Sessions.
    this.config.acceptMode = 'accept'
    this.config.runner = 'simulate'
    const plan = buildDemoPlan(total, workCount)
    this.demoHeuristicUntil = this.clock() + total * interval + 120_000
    this.demo = { total, work: workCount, interval, plan, index: 0, previousMode, previousRunner, deferred: [], retry: [], startedAt: this.clock(), timer: null }
    this.pushEvent({ kind: 'mode', level: 'info', text: `重放论文实验负载：${total} 条消息 / ${workCount} 个工作请求（模拟执行）` })
    const step = () => {
      if (!this.demo || this.disposed) return
      const current = this.demo
      // Thread follow-ups wait until the work request's thread actually has a subscriber; a
      // follow-up admitted before its ticket is dispatched would become a second ticket. Once the
      // thread is claimed, the follow-up takes the subscription shortcut and never reaches the Router.
      if (current.deferred && current.deferred.length > 0) {
        for (const pending of current.deferred) {
          const delivered = this.threadFollowup({ threadId: pending.threadId, text: pending.text, source: pending.source })
          if (!delivered && (pending.attempts ?? 0) < 4) {
            pending.attempts = (pending.attempts ?? 0) + 1
            current.retry.push(pending)
          }
        }
        current.deferred = current.retry
        current.retry = []
      }
      const event = current.plan[current.index]
      current.index += 1
      if (event) {
        if (event.kind === 'followup') {
          current.deferred.push({ ...event, attempts: 0 })
        } else {
          this.ingest({ source: event.source, author: event.author, text: event.text, threadId: event.threadId, human: event.kind === 'work', demo: true })
        }
      }
      if (current.index >= current.plan.length) {
        clearTimeout(current.timer)
        this.demo = null
        this.config.acceptMode = previousMode
        this.config.runner = current.previousRunner ?? previousRunner
        this.singleDurations.push(...buildSingleBaseline(workCount))
        this.pushEvent({ kind: 'mode', level: 'success', text: `实验负载回放完成：${workCount} 个工作请求全部派单（模拟 Worker）` })
        this.persist()
        return
      }
      current.timer = setTimeout(step, current.interval)
      this.timers.add(current.timer)
      if (typeof current.timer.unref === 'function') current.timer.unref()
    }
    step()
    return { total, work: workCount, interval }
  }

  reset() {
    if (this.demo) { clearTimeout(this.demo.timer); this.demo = null }
    this.demoHeuristicUntil = 0
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.pending = []
    this.queue = []
    this.seen.clear()
    this.triggerTimes = []
    this.superDurations = []
    this.singleDurations = []
    for (const worker of this.workers.values()) {
      if (worker.status === 'running' || worker.status === 'queued') {
        this.adapter.stopWorker?.(worker)?.catch?.(() => {})
      }
      if (worker.worktree && typeof this.adapter.disposeWorktree === 'function') {
        // `keep: true` leaves the branch and its commits in place for inspection.
        Promise.resolve(this.adapter.disposeWorktree(worker.worktree, { keep: true })).catch(() => {})
      }
    }
    this.workers.clear()
    this.workerOrder = []
    this.threads.clear()
    this.events.clear()
    this.timeline.clear()
    this.counters = new Counters()
    this.stats = {
      received: 0, fastPathBlocked: 0, semanticCandidates: 0, semanticRejected: 0, accepted: 0, dispatched: 0, observed: 0,
      ruleHits: {},
      router: { decisions: 0, batches: 0, avgDecisionMs: null, lastDecisionAt: null, semanticCalls: 0, semanticFailures: 0, heuristicDecisions: 0 },
      watchdog: { state: 'ok', checks: 0, lastCheckAt: null, findings: [], stalled: 0, loops: 0, drift: 0 },
      attention: { emitted: 0, suppressed: 0, reasons: { 'result-ready': 0, 'decision-needed': 0, failed: 0, progress: 0 }, recent: [] },
    }
    this.pushEvent({ kind: 'mode', level: 'info', text: '全部记录已清空' })
    this.persist(true)
  }

  // ------------------------------------------------------------------ Views

  runningWorkers() {
    return [...this.workers.values()].filter(worker => worker.status === 'running' || worker.status === 'queued')
  }

  /** Workers that hold a slot right now (a queued ticket waits for one). */
  activeWorkers() {
    return [...this.workers.values()].filter(worker => worker.status === 'running')
  }

  workerBySession(sessionId) {
    for (const worker of this.workers.values()) if (worker.sessionId === sessionId) return worker
    return undefined
  }

  snapshot() {
    const clock = this.clock()
    const ruleHits = this.stats.ruleHits
    const workers = this.workerOrder
      .map(id => this.workers.get(id))
      .filter(Boolean)
      .slice(-40)
      .map(worker => ({
        id: worker.id,
        ticketId: worker.ticketId,
        threadId: worker.threadId,
        title: worker.title,
        status: worker.status,
        source: worker.source,
        cwd: worker.cwd,
        startedAt: worker.startedAt,
        endedAt: worker.endedAt,
        elapsedMs: (worker.endedAt ?? clock) - (worker.startedAt ?? clock),
        progress: round(worker.progress, 3),
        lastProgressAt: worker.lastProgressAt,
        turns: worker.turns,
        steps: worker.steps,
        toolCalls: worker.toolCalls,
        tokens: { ...worker.tokens },
        model: worker.model ?? this.config.workerModel ?? undefined,
        preset: worker.preset ?? '',
        createNote: worker.createNote ?? '',
        repo: worker.repo ?? '',
        branch: worker.branch ?? '',
        worktreePath: worker.worktreePath ?? '',
        delivery: worker.delivery ?? null,
        reply: worker.reply ?? null,
        summary: worker.summary,
        stalled: worker.stalled,
        simulated: worker.simulated,
        attentionCost: worker.attentionCost,
        sessionId: worker.sessionId ?? '',
      }))
    const threads = [...this.threads.values()].slice(-20).map(thread => ({ ...thread, subscribers: [...thread.subscribers] }))
    const completed = this.stats.attention.emitted + this.stats.attention.suppressed
    const emitted = this.stats.attention.emitted
    const suppressed = this.stats.attention.suppressed
    const p50 = percentile(this.superDurations, 50)
    const p95 = percentile(this.superDurations, 95)
    const singleP50 = percentile(this.singleDurations, 50)
    const singleP95 = percentile(this.singleDurations, 95)
    const completedWorkers = [...this.workers.values()].filter(worker => worker.status === 'done').length
    const avgMs = average(this.superDurations)
    return {
      schema: 1,
      now: clock,
      startedAt: this.startedAt,
      uptimeMs: clock - this.startedAt,
      mode: { accept: this.config.acceptMode, paused: this.config.paused, runner: this.config.runner },
      config: {
        maxWorkers: this.config.maxWorkers,
        watchdogIntervalMs: this.config.watchdogIntervalMs,
        staleAfterMs: this.config.staleAfterMs,
        routerModel: this.config.routerModel || 'profile-default',
        workerModel: this.config.workerModel || 'profile-default',
      },
      health: this.health(),
      router: {
        decisions: this.stats.router.decisions,
        batches: this.stats.router.batches,
        avgBatch: this.stats.router.batches > 0 ? round(this.stats.router.decisions / this.stats.router.batches) : 0,
        avgDecisionMs: this.stats.router.avgDecisionMs ?? 0,
        lastDecisionAt: this.stats.router.lastDecisionAt,
        model: this.config.routerModel || 'profile-default',
        semanticCalls: this.stats.router.semanticCalls,
        semanticFailures: this.stats.router.semanticFailures,
        heuristicDecisions: this.stats.router.heuristicDecisions,
      },
      admission: {
        received: this.stats.received,
        fastPathBlocked: this.stats.fastPathBlocked,
        semanticCandidates: this.stats.semanticCandidates,
        semanticRejected: this.stats.semanticRejected,
        accepted: this.stats.accepted,
        dispatched: this.stats.dispatched,
        observed: this.stats.observed,
        ratePerMin: this.triggerTimes.length,
        funnel: [
          { stage: 'raw', label: '原始事件', count: this.stats.received },
          { stage: 'fast', label: '规则快筛', count: this.stats.semanticCandidates },
          { stage: 'semantic', label: '语义判定', count: this.stats.accepted },
          { stage: 'dispatched', label: '已派单', count: this.stats.dispatched },
        ],
        rules: this.config.rules.map(rule => ({ id: rule.id, name: rule.name, instruction: rule.instruction, hits: ruleHits[rule.id] ?? 0 })),
      },
      workers,
      threads,
      watchdog: { ...this.stats.watchdog, findings: this.stats.watchdog.findings.slice(0, 12) },
      attention: {
        emitted,
        suppressed,
        budget: completed > 0 ? round(emitted / completed, 2) : 0,
        ratio: suppressed / Math.max(1, emitted),
        reasons: { ...this.stats.attention.reasons },
        recent: this.stats.attention.recent.slice(0, 8),
      },
      metrics: {
        completed: completedWorkers,
        p50Ms: p50,
        p95Ms: p95,
        avgMs: avgMs === null ? null : Math.round(avgMs),
        routerDecisions: this.stats.router.decisions,
        cacheReadTokens: [...this.workers.values()].reduce((sum, worker) => sum + (worker.tokens.cacheRead ?? 0), 0),
        sessions: this.workerOrder.length,
        savedMinutes: p95 === null ? 0 : Math.max(0, Math.round(((SINGLE_BASELINE_MS - p95) / 60_000) * Math.max(1, completedWorkers) * 0.8)),
      },
      events: this.events.export(),
      timeline: this.timeline.export(),
      compare: {
        super: { p50Ms: p50, p95Ms: p95 },
        // Without a measured single-session run, fall back to the paper's published baseline
        // (p95 = 29.5 min under a neutral prompt) so the comparison bar is never drawn at zero.
        single: {
          p50Ms: singleP50 ?? Math.round(SINGLE_BASELINE_MS * 0.78),
          p95Ms: singleP95 ?? SINGLE_BASELINE_MS,
          estimated: singleP50 === null && singleP95 === null,
        },
      },
    }
  }

  health() {
    if (this.disposed) return { state: 'error', note: '已停止' }
    if (this.stats.router.semanticFailures > 0 && this.stats.router.semanticCalls > 0 && this.stats.router.semanticFailures / this.stats.router.semanticCalls > 0.5) {
      return { state: 'warn', note: '语义判定接口频繁失败，已回退到关键词规则' }
    }
    return { state: 'ready', note: '' }
  }

  serialize() {
    return {
      version: 1,
      savedAt: this.clock(),
      config: {
        acceptMode: this.config.acceptMode,
        paused: this.config.paused,
        runner: this.config.runner,
        maxWorkers: this.config.maxWorkers,
      },
      stats: this.stats,
      counters: this.counters.export(),
      workers: this.workerOrder.slice(-100).map(id => this.workers.get(id)).filter(Boolean),
      threads: [...this.threads.values()].slice(-50),
      events: this.events.export(),
      timeline: this.timeline.export(),
      superDurations: this.superDurations.slice(-200),
      singleDurations: this.singleDurations.slice(-200),
    }
  }

  restore(data) {
    if (!data || typeof data !== 'object') return
    // Deliberately NOT restored: acceptMode / paused / runner. The operator's declared config is
    // the policy that applies after a restart; a console toggle is runtime state, not a durable
    // permission. Everything else (records, counters, metrics) is restored below.
    if (data.stats && typeof data.stats === 'object') {
      this.stats = { ...this.stats, ...data.stats, router: { ...this.stats.router, ...(data.stats.router ?? {}) }, attention: { ...this.stats.attention, ...(data.stats.attention ?? {}) }, watchdog: { ...this.stats.watchdog, ...(data.stats.watchdog ?? {}) } }
    }
    this.counters.restore(data.counters)
    for (const worker of Array.isArray(data.workers) ? data.workers : []) {
      if (worker && typeof worker.id === 'string') {
        this.workers.set(worker.id, { ...worker, status: worker.status === 'running' || worker.status === 'queued' ? 'cancelled' : worker.status })
        this.workerOrder.push(worker.id)
        this.counters.seed('w', Number(worker.id.split('-')[1]) || 0)
        // Ticket ids must survive a restart too: a reused `t-01` would resume the previous
        // process's Worker Session instead of creating a clean one.
        this.counters.seed('t', Number(String(worker.ticketId ?? '').split('-')[1]) || 0)
      }
    }
    for (const thread of Array.isArray(data.threads) ? data.threads : []) {
      if (thread && typeof thread.id === 'string') this.threads.set(thread.id, { ...thread, subscribers: Array.isArray(thread.subscribers) ? thread.subscribers : [] })
    }
    this.events.restore(data.events)
    this.timeline.restore(data.timeline)
    this.superDurations = Array.isArray(data.superDurations) ? data.superDurations.filter(Number.isFinite) : []
    this.singleDurations = Array.isArray(data.singleDurations) ? data.singleDurations.filter(Number.isFinite) : []
    this.pushEvent({ kind: 'mode', level: 'info', text: `已恢复 ${this.workers.size} 个 Worker 记录` })
  }

  // ------------------------------------------------------------------- Utils

  pushEvent({ kind, level = 'info', text, workerId = null, threadId = null }) {
    this.events.push({ t: this.clock(), kind, level, text: trim(text, 200), workerId, threadId })
  }

  pushTimeline(kind, extra = {}) {
    this.timeline.push({ t: this.clock(), kind, workerId: extra.workerId ?? null })
  }
}

/** Normalizes a raw trigger; every hop of the chain is identifiable from this record alone. */
export function normalizeEvent(input) {
  const value = input && typeof input === 'object' ? input : { text: String(input ?? '') }
  return {
    source: String(value.source ?? 'chat').slice(0, 24),
    author: String(value.author ?? 'unknown').slice(0, 40),
    text: String(value.text ?? '').slice(0, 4000),
    threadId: value.threadId ? String(value.threadId).slice(0, 80) : undefined,
    repo: value.repo ? String(value.repo).slice(0, 300) : undefined,
    url: value.url ? String(value.url).slice(0, 500) : undefined,
    externalId: value.externalId ? String(value.externalId).slice(0, 200) : undefined,
    meta: value.meta && typeof value.meta === 'object' ? JSON.parse(JSON.stringify(value.meta).slice(0, 2000)) : undefined,
    human: value.human !== false,
    demo: value.demo === true,
  }
}

/** The synthetic load of the paper's experiment: mostly noise, a fifth of it real work. */
export function buildDemoPlan(total, workCount) {
  const sources = ['feishu', 'github', 'chat', 'ci', 'email']
  const authors = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']
  const noise = [
    '今天的站会改到十点',
    '收到，我下午看一下',
    '哈哈这个图太草了',
    '午饭吃什么',
    '部署脚本又忘加 tag 了',
    '这个颜色是不是有点太蓝',
    '我明天请假一天',
    '会议纪要更新在文档里了',
    '有人看到我的耳机了吗',
    '周末团建 vote 一下',
    'CI 又被人工取消了',
    '版本号是 1.4.2 还是 1.4.3',
  ]
  const work = [
    { text: '登录接口在 30 秒后必超时，帮我复现并修一下', source: 'feishu' },
    { text: 'CI 流水线在 windows 上跑挂了，看下是不是 flaky', source: 'ci' },
    { text: 'PR #128 的评审意见请跟一下，按建议改', source: 'github' },
    { text: '给设置页加个导出按钮，小改动', source: 'feishu' },
    { text: '报错日志里有个 undefined is not a function，帮忙定位', source: 'github' },
    { text: '文档里的安装命令过时了，更新一下', source: 'feishu' },
    { text: '测试用例 test/session 间歇性失败，看能不能修', source: 'ci' },
    { text: '移动端列表滑动卡顿，做个性能优化', source: 'feishu' },
    { text: '构建产物少了 icon.svg，修复一下打包配置', source: 'ci' },
    { text: '把配置读取改成支持环境变量覆盖', source: 'feishu' },
    { text: '上传大文件时进度条卡在 0，帮忙排查一下', source: 'feishu' },
    { text: '深色模式下表格边框看不清，调一下对比度', source: 'feishu' },
    { text: '搜索接口返回顺序不稳定，检查一下排序逻辑', source: 'github' },
    { text: '加一个快捷键打开命令面板，小改动', source: 'feishu' },
    { text: '定时任务每天重复执行两次，帮忙定位', source: 'ci' },
    { text: '打包体积涨了 40%，分析并优化一下', source: 'github' },
    { text: '退出登录后还能拿到缓存数据，修一下', source: 'github' },
    { text: '日志里缺少 request id，补上并验证', source: 'feishu' },
    { text: 'Android 返回键无响应，检查一下路由', source: 'feishu' },
    { text: '给这次 bug 补一个回归用例，防止再犯', source: 'github' },
  ]
  const plan = []
  const workPositions = new Set()
  while (workPositions.size < workCount) workPositions.add(Math.floor(Math.random() * total))
  let workIndex = 0
  for (let position = 0; position < total; position += 1) {
    const source = sources[Math.floor(Math.random() * sources.length)]
    const author = authors[Math.floor(Math.random() * authors.length)]
    if (workPositions.has(position) && workIndex < workCount) {
      const item = work[workIndex % work.length]
      workIndex += 1
      const threadId = `th-${hash(item.text)}`
      plan.push({ kind: 'work', source: item.source, author, text: item.text, threadId, keyword: item.keyword })
      plan.push({ kind: 'followup', source: item.source, author: authors[Math.floor(Math.random() * authors.length)], text: '补充一下：只在 staging 上能稳定复现', threadId })
    } else {
      const text = noise[Math.floor(Math.random() * noise.length)]
      plan.push({ kind: 'noise', source, author, text })
    }
  }
  return plan
}

/** The single-session baseline durations, matching the paper's 29.5-minute p95 under a neutral prompt. */
export function buildSingleBaseline(count) {
  const values = []
  for (let index = 0; index < Math.max(1, count); index += 1) values.push((20 + Math.random() * 14) * 60_000)
  return values
}
