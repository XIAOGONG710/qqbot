/**
 * Offline test for the Super Agent control plane. No DSH, no install:
 *   node test/engine.test.mjs
 *
 * It drives the engine exactly as the Host half does, with a fake adapter, and asserts the
 * paper's measurable promises: noise is filtered before the model, admitted work becomes an
 * isolated Worker, follow-ups bypass the Router, completions are gated by attention, and the
 * Watchdog reports stalls instead of liveness.
 */
import assert from 'node:assert/strict'
import { SuperAgentEngine, buildDemoPlan, normalizeEvent } from '../lib/engine.js'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const results = []
function test(name, fn) {
  results.push({ name, fn })
}

test('fast path filters noise before the semantic gate', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate' } }).start()
  const blocked = engine.ingest({ source: 'chat', author: 'bob', text: '收到' })
  assert.equal(blocked.stage, 'fast-blocked')
  const offSource = engine.ingest({ source: 'sms', author: 'bob', text: '登录接口 30 秒超时，修一下' })
  assert.equal(offSource.stage, 'fast-blocked')
  const candidate = engine.ingest({ source: 'feishu', author: 'bob', text: '登录接口 30 秒超时，帮我复现并修一下' })
  assert.equal(candidate.stage, 'queued')
  const snapshot = engine.snapshot()
  assert.equal(snapshot.admission.received, 3)
  assert.equal(snapshot.admission.fastPathBlocked, 2)
  assert.equal(snapshot.admission.semanticCandidates, 1)
  await engine.dispose()
})

test('router accepts work, creates an isolated worker and subscribes its thread', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate' } }).start()
  engine.ingest({ source: 'feishu', author: 'alice', text: '登录接口 30 秒后必超时，帮我复现并修一下', threadId: 'th-login' })
  engine.ingest({ source: 'chat', author: 'bob', text: '今天的站会改到十点' })
  await engine.tickRouter()
  const snapshot = engine.snapshot()
  assert.equal(snapshot.admission.accepted, 1)
  assert.equal(snapshot.admission.dispatched, 1)
  assert.equal(snapshot.workers.length, 1)
  const worker = snapshot.workers[0]
  assert.equal(worker.status, 'running')
  assert.equal(worker.threadId, 'th-login')
  assert.equal(snapshot.threads[0].subscribers.length, 1)
  assert.equal(snapshot.router.batches, 1)
  assert.equal(snapshot.router.avgBatch, 2)
  await engine.dispose()
})

test('observe mode records without executing', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'observe', runner: 'simulate' } }).start()
  engine.ingest({ source: 'github', author: 'alice', text: 'CI 流水线在 windows 上跑挂了，看下是不是 flaky' })
  await engine.tickRouter()
  const snapshot = engine.snapshot()
  assert.equal(snapshot.admission.accepted, 1)
  assert.equal(snapshot.admission.dispatched, 0)
  assert.equal(snapshot.admission.observed, 1)
  await engine.dispose()
})

test('thread follow-ups go straight to the subscribed worker', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate' } }).start()
  let delivered = 0
  engine.adapter.deliverToWorker = () => { delivered += 1; return Promise.resolve(true) }
  engine.ingest({ source: 'github', author: 'alice', text: 'PR #128 的评审意见请跟一下，按建议改', threadId: 'th-pr-128' })
  await engine.tickRouter()
  const decisionsBefore = engine.stats.router.decisions
  const followUp = engine.ingest({ source: 'github', author: 'bob', text: '评审里第 3 条换一种改法，别用兼容层', threadId: 'th-pr-128' })
  assert.equal(followUp.stage, 'direct')
  assert.equal(delivered, 1)
  assert.equal(engine.stats.router.decisions, decisionsBefore, 'the Router decided nothing for a subscribed thread')
  assert.equal(engine.snapshot().threads[0].routerBypassed, 1)
  await engine.dispose()
})

test('attention gate suppresses progress and allows only usable outcomes', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate' } }).start()
  const notified = []
  engine.adapter.notifyAttention = record => notified.push(record)
  const worker = { id: 'w-01', ticketId: 't-01', threadId: 'th-1', title: '示例', attentionCost: 0, status: 'running', needsDecision: false }
  engine.workers.set('w-01', worker)
  engine.threads.set('th-1', { id: 'th-1', title: 't', subscribers: ['w-01'], messages: 1, directDeliveries: 0, routerBypassed: 0, updatedAt: Date.now() })
  assert.equal(engine.attention('progress', worker, '正在执行'), false)
  engine.complete(worker, { ok: true, summary: '已完成' })
  assert.equal(engine.stats.attention.emitted, 0, 'a plain result is delivered silently')
  assert.equal(engine.stats.attention.suppressed, 2, 'both the progress report and the quiet completion are suppressed')
  const failed = { id: 'w-02', ticketId: 't-02', threadId: 'th-1', title: '失败的任务', attentionCost: 0, status: 'running' }
  engine.workers.set('w-02', failed)
  engine.complete(failed, { ok: false, summary: '测试失败' })
  assert.equal(engine.stats.attention.emitted, 1)
  assert.equal(notified.length, 1)
  assert.equal(notified[0].reason, 'failed')
  await engine.dispose()
})

test('watchdog reports a stall, not just liveness', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate', staleAfterMs: 1000 } }).start()
  const worker = { id: 'w-01', ticketId: 't-01', threadId: 'th-1', title: '卡住', status: 'running', progress: 0.2, steps: 4, startedAt: Date.now() - 60_000, lastProgressAt: Date.now() - 60_000, tokens: { in: 0, out: 0, cacheRead: 0 }, repeats: 0, attentionCost: 0 }
  engine.workers.set('w-01', worker)
  const watchdog = engine.tickWatchdog()
  assert.equal(watchdog.state, 'alert')
  assert.equal(watchdog.stalled, 1)
  assert.ok(watchdog.findings.some(item => item.kind === 'stall'))
  assert.equal(worker.stalled, true)
  await engine.dispose()
})

test('the demo replay produces the funnel, workers and the paper comparison', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate' } }).start()
  const plan = buildDemoPlan(120, 12)
  for (let index = 0; index < plan.length; index += 1) {
    const event = plan[index]
    engine.ingest({ source: event.source, author: event.author, text: event.text, threadId: event.threadId })
    if (index % 10 === 9) await engine.tickRouter()
  }
  await engine.tickRouter()
  const snapshot = engine.snapshot()
  assert.equal(snapshot.admission.received, plan.length, 'every planned event, including thread follow-ups, is received')
  assert.ok(snapshot.admission.fastPathBlocked > 20, `expected noise to be filtered, got ${snapshot.admission.fastPathBlocked}`)
  assert.ok(snapshot.admission.dispatched >= 10, `expected work requests to dispatch, got ${snapshot.admission.dispatched}`)
  assert.ok(snapshot.workers.length >= 10)
  // Finish the workers and check the metric shape the console reads.
  for (const worker of engine.workers.values()) engine.complete(worker, { ok: true, summary: 'done' })
  const after = engine.snapshot()
  assert.ok(after.metrics.p50Ms > 0)
  assert.ok(after.metrics.p95Ms >= after.metrics.p50Ms)
  assert.ok(after.compare.single.p95Ms > 0)
  assert.ok(after.attention.suppressed > after.attention.emitted, 'most work is delivered silently')
  await engine.dispose()
})

test('a persisted snapshot restores the console state', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate' } }).start()
  engine.ingest({ source: 'feishu', author: 'alice', text: '文档里的安装命令过时了，更新一下' })
  await engine.tickRouter()
  const saved = JSON.parse(JSON.stringify(engine.serialize()))
  const restored = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate' } }).start()
  restored.restore(saved)
  const snapshot = restored.snapshot()
  assert.equal(snapshot.workers.length, 1)
  assert.equal(snapshot.workers[0].status, 'cancelled', 'a worker from a previous process never resumes as running')
  assert.equal(snapshot.admission.received, 1)
  await engine.dispose()
  await restored.dispose()
})

test('normalizeEvent bounds hostile input', () => {
  const event = normalizeEvent({ source: 'x'.repeat(100), author: 'y'.repeat(100), text: 'z'.repeat(9000), threadId: 't'.repeat(200) })
  assert.equal(event.source.length, 24)
  assert.equal(event.author.length, 40)
  assert.equal(event.text.length, 4000)
  assert.equal(event.threadId.length, 80)
  assert.equal(normalizeEvent('hi').source, 'chat')
})

test('a ticket gets its own worktree and is delivered after it finishes', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate' } }).start()
  const prepared = []
  const delivered = []
  engine.adapter.prepareWorktree = async ({ ticketId, repo }) => {
    prepared.push([ticketId, repo])
    return { ticketId, path: '/tmp/wt/' + ticketId, branch: 'sa/' + ticketId, repoDir: repo, baseSha: 'abc' }
  }
  engine.adapter.deliver = async ({ ticket, worker, worktree }) => {
    delivered.push({ ticketId: ticket.id, branch: worktree.branch, status: worker.status })
    return { status: 'patch', branch: worktree.branch, patchPath: '/tmp/' + ticket.id + '.patch', draftPath: '/tmp/' + ticket.id + '.pr.md', changedFiles: ['README.md'] }
  }
  await engine.dispatch({ title: '修 README', brief: '在 README 末尾加一行', source: 'agent', repo: '/repo/demo' })
  const worker = [...engine.workers.values()][0]
  assert.deepEqual(prepared, [[worker.ticketId, '/repo/demo']])
  assert.equal(worker.worktreePath, '/tmp/wt/' + worker.ticketId)
  assert.equal(worker.branch, 'sa/' + worker.ticketId)
  assert.equal(worker.cwd, '/tmp/wt/' + worker.ticketId)
  engine.complete(worker, { ok: true, summary: 'done' })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].branch, 'sa/' + worker.ticketId)
  assert.equal(worker.delivery.status, 'patch')
  const snapshot = engine.snapshot()
  assert.equal(snapshot.workers[0].delivery.status, 'patch')
  assert.equal(snapshot.workers[0].branch, 'sa/' + worker.ticketId)
  await engine.dispose()
})

test('the per-hour budget blocks new tickets instead of overspending', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate', budget: { maxWorkersPerHour: 1 } } }).start()
  const first = await engine.dispatch({ title: '一号', brief: 'a', source: 'agent' })
  assert.ok(first.workerId, 'the first ticket is accepted')
  const worker = engine.workers.get(first.workerId)
  worker.status = 'done'
  const second = await engine.dispatch({ title: '二号', brief: 'b', source: 'agent' })
  assert.equal(second.blocked, true)
  assert.match(second.reason, /上限/)
  const snapshot = engine.snapshot()
  assert.equal(snapshot.workers.length, 1)
  await engine.dispose()
})

test('acceptSources lets a source observe while another acts', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate', acceptSources: ['github'] } }).start()
  engine.ingest({ source: 'ci', author: 'ci', text: 'CI 流水线在 windows 上跑挂了，看下是不是 flaky' })
  engine.ingest({ source: 'github', author: 'alice', text: '登录接口超时，帮我复现并修一下' })
  await engine.tickRouter()
  const snapshot = engine.snapshot()
  assert.equal(snapshot.admission.accepted, 2)
  assert.equal(snapshot.admission.observed, 1)
  assert.equal(snapshot.admission.dispatched, 1)
  await engine.dispose()
})

test('the finished ticket is replied back to its source thread', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate' } }).start()
  const replies = []
  engine.adapter.prepareWorktree = async ({ ticketId }) => ({ ticketId, path: '/tmp/wt/' + ticketId, branch: 'sa/' + ticketId, repoDir: '/repo', baseSha: 'x' })
  engine.adapter.deliver = async ({ ticket }) => ({ status: 'patch', branch: 'sa/' + ticket.id, patchPath: '/a.patch', draftPath: '/a.md', changedFiles: ['a.ts'] })
  engine.adapter.replySource = async ({ ticket, result }) => {
    replies.push([ticket.id, result.status])
    return { ok: true, channel: 'inbox', path: '/receipt.json' }
  }
  await engine.dispatch({ title: '回贴测试', brief: '做点事', source: 'inbox', repo: '/repo/demo', threadId: 'inbox:1' })
  const worker = [...engine.workers.values()][0]
  engine.complete(worker, { ok: true, summary: 'done' })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(replies.length, 1)
  assert.equal(replies[0][1], 'patch')
  assert.equal(worker.reply.ok, true)
  assert.equal(engine.snapshot().workers[0].reply.channel, 'inbox')
  await engine.dispose()
})

test('a non-repository ticket still replies to its source', async () => {
  const engine = await new SuperAgentEngine({ config: { acceptMode: 'accept', runner: 'simulate' } }).start()
  const replies = []
  engine.adapter.replySource = async ({ result }) => { replies.push(result.status); return { ok: true, channel: 'inbox' } }
  await engine.dispatch({ title: '无仓库任务', brief: '只回话', source: 'inbox', threadId: 'inbox:2' })
  const worker = [...engine.workers.values()][0]
  engine.complete(worker, { ok: true, summary: 'done' })
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.deepEqual(replies, ['done'])
  await engine.dispose()
})

let failed = 0
for (const { name, fn } of results) {
  try {
    await fn()
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}
console.log(`\n${results.length - failed}/${results.length} passed`)
process.exit(failed === 0 ? 0 : 1)
