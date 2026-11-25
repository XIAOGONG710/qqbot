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
  } finally {
    for (const dispose of disposers) dispose()
    for (const link of links) unlinkSync(link)
    // apply 起的探测子进程把工作目录放在这里，Windows 上可能还占着：临时目录删不掉就留给系统清（链接已经拆了）
    try { rmSync(root, { recursive: true, force: true }) } catch { /* 占用中 */ }
  }
})
