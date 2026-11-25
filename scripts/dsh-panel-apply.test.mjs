// 面板插件的 apply() 冒烟：用假的 ctx 真跑一遍 apply，再打 /state 和 /details/logs。
// 11-26 审查（docs/reports/2026-11-26-dsh-qqbot-services-review.md 第 1 条）：index.js 只「export … from './logs-view.js'」
// 转导出了 summarizeWatchdog / summarizeRecallLog，本模块里拿不到，apply 里一调就 ReferenceError，/state 一直 503，
// 面板各页都空白；原有测试没有一个调过 apply，所以没发现。仓库根指到临时目录：不读真实的 koishi.yml、日志和数据。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { apply } from '../dsh-plugins/dsh-qqbot-services/index.js'

test('apply() 起得来，/state 和 /details/logs 回 200（不是 503）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-apply-'))
  mkdirSync(join(root, 'runtime', 'log'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"synthetic"}')
  // apply 一起来就要 js-yaml（配置编辑器）：临时根下挂一个指向仓库 node_modules 的目录链接；清理时先拆链接，免得递归删到真的依赖
  // 代码目录（node_modules、packages、scripts）用目录链接挂进来；runtime、characters 这些真实数据一个都不挂
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const links = ['node_modules', 'packages', 'scripts'].map(name => join(root, name))
  for (const link of links) symlinkSync(join(repo, link.slice(root.length + 1)), link, 'junction')
  let handler
  const disposers = []
  const ctx = {
    webServer: { register: route => { handler = route.handler; return () => {} } },
    connection: { requestRejection: () => undefined },
    on: (name, fn) => { if (name === 'dispose') disposers.push(fn) },
  }
  try {
    apply(ctx, { repoRoot: root, characterDir: 'synthetic-character' })
    assert.equal(typeof handler, 'function', '注册了路由')
    const call = async path => {
      let status, payload
      await handler({ method: 'GET', url: '/api/qqbot-services/' + path, socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1' } },
        { writeHead(code) { status = code }, end(value) { payload = value } })
      return { status, payload: JSON.parse(payload) }
    }
    const state = await call('state')
    assert.equal(state.status, 200, JSON.stringify(state.payload))
    assert.ok(Array.isArray(state.payload.events))
    const logs = await call('details/logs')
    assert.equal(logs.status, 200, JSON.stringify(logs.payload))
    assert.ok(Array.isArray(logs.payload.operations) && Array.isArray(logs.payload.recall))
    // 我们自己的工具（模块 1）：没有 koishi.yml 时说「不可用」而不是报错
    const switches = await call('project/switches')
    assert.equal(switches.status, 200)
    assert.equal(switches.payload.available, false)
    assert.equal((await call('project/metrics?days=0')).status, 400, '天数不合法')
    // 她的状态（模块 2）：没有 koishi.yml、没有数据目录时说「不可用」
    for (const kind of ['memory', 'emotion', 'life', 'day']) assert.equal((await call('her/' + kind)).status, 200, kind)
    assert.equal((await call('her/nope')).status, 404)
    // 她心里的（ADR 0350）：默认关
    assert.deepEqual(await call('inner/today'), { status: 404, payload: { error: 'inner_disabled' } })
    assert.equal(state.payload.panels.herInner, false)
  } finally {
    for (const dispose of disposers) dispose()
    for (const link of links) unlinkSync(link)
    // apply 起的探测子进程把工作目录放在这里，Windows 上可能还占着：临时目录删不掉就留给系统清（链接已经拆了）
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 占用中 */ }
  }
})

test('herInnerPanel: true 时才有「她心里的」，读的是 QQBOT_SOUL_DIR（这里指到合成的临时目录）', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-panel-inner-'))
  const soul = mkdtempSync(join(tmpdir(), 'dsh-panel-soul-'))
  mkdirSync(join(root, 'runtime', 'log'), { recursive: true })
  writeFileSync(join(root, 'package.json'), '{"name":"synthetic"}')
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
  const links = ['node_modules', 'packages', 'scripts'].map(name => join(root, name))
  for (const link of links) symlinkSync(join(repo, link.slice(root.length + 1)), link, 'junction')
  const before = process.env.QQBOT_SOUL_DIR
  process.env.QQBOT_SOUL_DIR = soul
  let handler
  const disposers = []
  try {
    apply({ webServer: { register: route => { handler = route.handler; return () => {} } }, connection: { requestRejection: () => undefined },
      on: (name, fn) => { if (name === 'dispose') disposers.push(fn) } }, { repoRoot: root, characterDir: 'synthetic-character', herInnerPanel: true })
    let status, payload
    await handler({ method: 'GET', url: '/api/qqbot-services/inner/today', socket: { remoteAddress: '127.0.0.1' }, headers: { host: '127.0.0.1' } },
      { writeHead(code) { status = code }, end(value) { payload = JSON.parse(value) } })
    assert.equal(status, 200)
    assert.deepEqual(payload.feelings, [], '合成目录里没有 FEELINGS.json：空')
  } finally {
    if (before === undefined) delete process.env.QQBOT_SOUL_DIR; else process.env.QQBOT_SOUL_DIR = before
    for (const dispose of disposers) dispose()
    for (const link of links) unlinkSync(link)
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 占用中 */ }
    rmSync(soul, { recursive: true, force: true })
  }
})
