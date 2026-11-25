// 面板子进程（dsh-plugins/dsh-qqbot-services/panel-jobs.js）：超时杀掉、输出有上限、错误码固定、同时最多两个、同键共用一次计算。
// 大部分用假的 spawn；最后一条起一个真的子进程，确认不认识的 job 只回固定错误码。
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { MAX_RUNNING, runPanelJob, sharedJob } from '../dsh-plugins/dsh-qqbot-services/panel-jobs.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** 假子进程：记下参数和写进 stdin 的东西；finish(code, out) 模拟退出 */
function fakeSpawn() {
  const children = []
  const spawn = (command, args, options) => {
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stdin = new PassThrough()
    child.input = ''
    child.stdin.on('data', chunk => { child.input += chunk })
    child.killed = false
    child.kill = () => { child.killed = true; setImmediate(() => child.emit('close', null)) }
    child.finish = (code, out = '') => { if (out) child.stdout.write(out); setImmediate(() => child.emit('close', code)) }
    Object.assign(child, { command, args, options })
    children.push(child)
    return child
  }
  return { spawn, children }
}

const tick = () => new Promise(done => setImmediate(done))

test('正常：stdin 给 { job, input }，stdout 的 JSON 原样回；TZ 是配置的时区，stderr 丢掉，NODE_OPTIONS 清空', async () => {
  const { spawn, children } = fakeSpawn()
  const pending = runPanelJob('metrics', { until: '2026-11-19' }, { root, timeZone: 'Pacific/Honolulu', spawn })
  await tick()
  const child = children[0]
  assert.deepEqual(JSON.parse(child.input), { job: 'metrics', input: { until: '2026-11-19' } })
  assert.equal(child.options.env.TZ, 'Pacific/Honolulu')
  assert.equal(child.options.env.NODE_OPTIONS, '')
  assert.deepEqual(child.options.stdio, ['pipe', 'pipe', 'ignore'])
  assert.equal(child.options.cwd, root)
  assert.ok(child.args.at(-1).endsWith('panel-job-child.js'))
  child.finish(0, '{"ok":1}')
  assert.deepEqual(await pending, { ok: 1 })
  // 时区写错：退回 Asia/Shanghai
  const second = runPanelJob('x', {}, { root, timeZone: 'Not/AZone', spawn })
  await tick()
  assert.equal(children[1].options.env.TZ, 'Asia/Shanghai')
  children[1].finish(0, 'null')
  assert.equal(await second, null)
})

test('失败只回固定错误码：退出码不为 0、输出不是 JSON、超时（杀掉）、输出太大（杀掉）', async () => {
  const { spawn, children } = fakeSpawn()
  const failed = runPanelJob('a', {}, { root, spawn })
  await tick()
  children[0].finish(1, '{"error":"C:\\\\secret\\\\path 原文"}')
  await assert.rejects(failed, error => error.message === 'panel_job_failed')

  const garbage = runPanelJob('a', {}, { root, spawn })
  await tick()
  children[1].finish(0, 'not json 原文')
  await assert.rejects(garbage, error => error.message === 'panel_job_failed')

  const slow = runPanelJob('a', {}, { root, spawn, timeout: 30 })
  await tick()
  await assert.rejects(slow, error => error.message === 'panel_job_timeout')
  assert.equal(children[2].killed, true)

  const huge = runPanelJob('a', {}, { root, spawn })
  await tick()
  children[3].stdout.write(Buffer.alloc(8_000_001, 0x20))
  await assert.rejects(huge, error => error.message === 'panel_job_output')
  assert.equal(children[3].killed, true)

  const broken = runPanelJob('a', {}, { root, spawn: () => { throw Error('spawn EACCES C:\\secret') } })
  await assert.rejects(broken, error => error.message === 'panel_job_failed')
})

test(`同时最多 ${MAX_RUNNING} 个子进程，多的排队；前面的退了才起下一个`, async () => {
  const { spawn, children } = fakeSpawn()
  const jobs = [1, 2, 3, 4].map(n => runPanelJob('a', { n }, { root, spawn }))
  await tick()
  assert.equal(children.length, MAX_RUNNING)
  children[0].finish(0, '1')
  await jobs[0]
  await tick()
  assert.equal(children.length, MAX_RUNNING + 1)
  for (const child of children.slice(1)) child.finish(0, '2')
  await tick(); await tick()
  for (const child of children.slice(MAX_RUNNING + 1)) child.finish(0, '3')
  const values = await Promise.all(jobs)
  assert.equal(values.length, 4)
  assert.equal(children.length, 4)
})

test('sharedJob：同键同时来的共用一次；ttl 内给缓存；失败不缓存；键不同各算各的', async () => {
  let clock = 0
  let calls = 0
  const shared = sharedJob({ ttl: 1000, now: () => clock })
  const compute = async () => { calls++; await tick(); return { calls } }
  const [a, b] = await Promise.all([shared('k', compute), shared('k', compute)])
  assert.equal(a, b)
  assert.equal(calls, 1)
  clock = 999
  assert.equal(await shared('k', compute), a)
  clock = 1000
  assert.notEqual(await shared('k', compute), a)
  assert.equal(calls, 2)
  await shared('other', compute)
  assert.equal(calls, 3)
  await assert.rejects(shared('bad', async () => { throw Error('x') }))
  assert.deepEqual(await shared('bad', async () => 'ok'), 'ok')
})

test('真的子进程：不认识的 job 只回固定错误码', async () => {
  await assert.rejects(runPanelJob('no-such-job', {}, { root }), error => error.message === 'panel_job_failed')
})
