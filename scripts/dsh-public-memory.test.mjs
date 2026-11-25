// 公共记忆面板回归：假 Hindsight + 临时 owner-bank，不碰真库和真数据。
// 覆盖：只查公布的公共库、只回脱敏投影、已收回的不出正文、来源不明要标出来、
// 事实与推断分开、分页与限量、公共库故障不把原始错误带给页面。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createPublicMemory } from '../dsh-plugins/dsh-qqbot-services/public-memory.js'

const owner = 20001
/** 真仓库根：owner-bank.ts 要从这里加载，数据目录仍用临时目录 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 假 Hindsight：记录每次请求，按需返回合成的公共库数据（真实接口回的是 { results: [...] }） */
function fakeHindsight(rows) {
  const state = { fail: false, calls: [] }
  const fetcher = async (url, init) => {
    state.calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null })
    if (state.fail) return { ok: false, status: 500, json: async () => ({ detail: 'private text should not leak' }) }
    return { ok: true, json: async () => ({ results: rows }) }
  }
  return { fetcher, calls: state.calls, state }
}

function setup({ commonBank = 'linmengyao-abc-common', dataDir } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qqbot-pubmem-'))
  const data = dataDir ?? join(root, 'runtime', 'bot')
  mkdirSync(join(data, 'memory'), { recursive: true })
  if (commonBank) {
    writeFileSync(join(data, 'memory', 'owner-bank.json'), JSON.stringify({
      ownerBank: 'linmengyao-abc', commonBank, legacyBank: 'linmengyao', writtenAt: '2026-11-25T00:00:00.000Z',
    }))
  }
  const config = { plugins: { 'qqbot:local2': { dataDir: data, contacts: [{ qq: owner, name: '主人', tier: 'boyfriend' }] } } }
  return { root, data, config }
}

const memoryRow = (overrides = {}) => ({
  id: 'mem-1', text: '她和他一起去过海边，风很大。', type: 'experience',
  occurred_start: '2026-10-02T08:00:00.000Z', occurred_end: null, mentioned_at: '2026-11-01T00:00:00.000Z',
  document_id: 'doc-abc123', tags: ['qq-private'], metadata: {}, entities: ['她', '他'], ...overrides,
})

function build(ctx, rows, options = {}) {
  const fake = fakeHindsight(rows)
  const editor = createPublicMemory({
    root: repoRoot, readConfig: () => ctx.config, fetcher: fake.fetcher,
    hindsightUrl: 'http://127.0.0.1:8899', now: () => new Date('2026-11-25T12:00:00.000Z'), ...options,
  })
  return { memory: editor, calls: fake.calls, state: fake.state }
}

test('只问公共库，不带私有库名', async () => {
  const ctx = setup()
  try {
    const { memory, calls } = build(ctx, [memoryRow()])
    const result = await memory.search('海边', 1, 8)
    assert.equal(result.linked, true)
    assert.equal(calls.length, 1, '一次查询只打一次 Hindsight')
    assert.match(calls[0].url, /linmengyao-abc-common\/memories\/recall$/)
    assert.ok(!calls[0].url.includes('linmengyao-abc/'), '不查他的私有库')
    assert.equal(calls[0].body.tags_match, 'all_strict')
    assert.equal(calls[0].body.include.entities.max_tokens, 200)
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('返回的是投影：有正文、类别、来源，没有原始字段', async () => {
  const ctx = setup()
  try {
    const { memory } = build(ctx, [memoryRow()])
    const { items } = await memory.search('海边', 1, 8)
    assert.equal(items.length, 1)
    const [item] = items
    assert.equal(item.text, '她和他一起去过海边，风很大。')
    assert.equal(item.certainty, 'stated', 'experience 算直接写下来的')
    assert.equal(item.when.dated, true)
    assert.deepEqual(item.source, { document: 'doc-abc123' })
    assert.deepEqual(item.entities, ['她', '他'])
    assert.ok(!('context' in item) && !('metadata' in item) && !('tags' in item), '原始字段不外传')
    assert.ok(!('timestamp' in item), '时间只给类别，不给原始字段名')
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('已收回的只留位置，不给正文', async () => {
  const ctx = setup()
  try {
    const { memory } = build(ctx, [memoryRow({ tags: ['qq-private', 'recalled'] })])
    const [item] = (await memory.search('海边', 1, 8)).items
    assert.equal(item.withdrawn, true)
    assert.equal(item.text, null)
    assert.equal(item.certainty, 'unknown')
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('来源不明、推断、日期不明各标各的', async () => {
  const ctx = setup()
  try {
    const { memory } = build(ctx, [
      memoryRow({ id: 'a', document_id: null, type: 'observation', occurred_start: null, occurred_end: null }),
      memoryRow({ id: 'b', type: 'world', occurred_start: null, occurred_end: null }),
      memoryRow({ id: 'c', type: 'opinion' }),
    ])
    const { items } = await memory.search('海边', 1, 8)
    assert.equal(items[0].source, null, '没有文档就说来源不明')
    assert.equal(items[0].certainty, 'inferred', '观察是整合出来的')
    assert.equal(items[0].when.dated, false)
    assert.equal(items[1].certainty, 'stated')
    assert.equal(items[2].certainty, 'inferred')
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('分页：同一查询只召回一次，翻页复用结果', async () => {
  const ctx = setup()
  try {
    const rows = Array.from({ length: 70 }, (_, index) => memoryRow({ id: `mem-${index}`, text: `第 ${index} 条` }))
    const { memory, calls } = build(ctx, rows)
    const first = await memory.search('海边', 1, 4)
    const second = await memory.search('海边', 2, 4)
    assert.equal(calls.length, 1, '翻页不重复打 Hindsight')
    assert.equal(first.items.length, 4)
    assert.equal(second.items[0].text, '第 4 条')
    assert.equal(second.cached, true)
    assert.equal(first.total, 60, '最多留 60 条，面板不用翻完整个库')
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('超量请求被夹住：limit、page 越界按默认来', async () => {
  const ctx = setup()
  try {
    const { memory } = build(ctx, [memoryRow()])
    const result = await memory.search('海边', 99, 99)
    assert.equal(result.page, 1)
    assert.equal(result.limit, 8)
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('公共库故障：抛错给路由，错误正文不进结果', async () => {
  const ctx = setup()
  try {
    const { memory, state } = build(ctx, [])
    state.fail = true
    try {
      await memory.search('海边', 1, 8)
      assert.fail('应当抛错')
    } catch (error) {
      assert.equal(error.message, 'memory_unavailable')
      assert.ok(!error.message.includes('private text'))
    }
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('公共库回了个不认识的形状：照样当不可用，不把对象塞进结果里', async () => {
  const ctx = setup()
  try {
    const memory = createPublicMemory({
      root: repoRoot, readConfig: () => ctx.config, hindsightUrl: 'http://127.0.0.1:8899',
      now: () => new Date('2026-11-25T12:00:00.000Z'),
      fetcher: async () => ({ ok: true, json: async () => ({ memories: [memoryRow()] }) }),
    })
    try {
      await memory.search('海边', 1, 8)
      assert.fail('应当抛错')
    } catch (error) { assert.equal(error.message, 'memory_unavailable') }
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('没公布公共库、或库名不像公共库时什么都不问', async () => {
  for (const commonBank of [null, 'linmengyao-abc', 'someone-else-private', 'x'.repeat(90)]) {
    const ctx = setup({ commonBank })
    try {
      const { memory, calls } = build(ctx, [memoryRow()])
      const result = await memory.search('海边', 1, 8)
      assert.equal(result.linked, false, `库名 ${commonBank} 不该被查询`)
      assert.equal(calls.length, 0)
    } finally { rmSync(ctx.root, { recursive: true, force: true }) }
  }
})

test('关系图：节点是同条记忆里的实体，边带记忆 id 可追溯', async () => {
  const ctx = setup()
  try {
    const { memory } = build(ctx, [
      memoryRow({ id: 'a', entities: ['她', '他', '海边'] }),
      memoryRow({ id: 'b', entities: ['她', '海边'] }),
      memoryRow({ id: 'c', entities: ['她', '猫'] }),
    ])
    const graph = await memory.graph('海边')
    assert.equal(graph.linked, true)
    assert.equal(graph.memories, 3)
    const names = graph.nodes.map(node => node.name)
    assert.deepEqual(names, ['她', '海边', '他', '猫'])
    const edge = graph.edges.find(item => item.from === '她' && item.to === '海边')
    assert.deepEqual(edge.memories, ['a', 'b'], '共现的记忆 id 都在')
    assert.equal(graph.nodes[0].memories, 3)
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('关系图在公共库不可用时说明没连上，不给空数据冒充', async () => {
  const ctx = setup({ commonBank: null })
  try {
    const { memory } = build(ctx, [])
    assert.deepEqual(await memory.graph('海边'), { linked: false, nodes: [], edges: [], memories: 0 })
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('指向非回环地址时什么都不查', async () => {
  const ctx = setup()
  try {
    const { memory, calls } = build(ctx, [memoryRow()], { hindsightUrl: 'http://10.0.0.9:8899' })
    const result = await memory.search('海边', 1, 8)
    assert.equal(result.linked, false)
    assert.equal(calls.length, 0)
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})

test('每页 8 条时 60 条能翻到第 8 页，每一页都是自己的内容（审查第 13 条）', async () => {
  const ctx = setup()
  try {
    const rows = Array.from({ length: 70 }, (_, index) => memoryRow({ id: `mem-${index}`, text: `第 ${index} 条` }))
    const { memory } = build(ctx, rows)
    const first = await memory.search('海边', 1, 8)
    const pages = Math.ceil(first.total / first.limit)
    assert.equal(pages, 8, '面板算出来的页数')
    for (let page = 2; page <= pages; page++) {
      const result = await memory.search('海边', page, 8)
      assert.equal(result.page, page, `第 ${page} 页不该被打回第 1 页`)
      assert.equal(result.items[0].text, `第 ${(page - 1) * 8} 条`)
    }
    assert.equal((await memory.search('海边', 8, 8)).items.length, 4, '最后一页只剩 4 条')
    assert.equal((await memory.search('海边', 9, 8)).page, 1, '超出的页数仍按第 1 页回')
  } finally { rmSync(ctx.root, { recursive: true, force: true }) }
})
