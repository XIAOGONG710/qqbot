// 离线验收基线：用临时 host 和假的 NapCat、Hindsight、Koishi 下游跑一遍
// 总览、聊天、会客室、她的家、运维页、角色资料，记录每页触发的模拟调用数。
// 不触碰真实服务，不发送 QQ 消息，不读写线上配置；角色资料用合成角色的一份临时副本。
// 用法：node scripts/dsh-offline-acceptance.mjs
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createChat } from '../dsh-plugins/dsh-qqbot-services/chat.js'
import { createCompanionRoom } from '../dsh-plugins/dsh-qqbot-services/companion-room.js'
import { createController } from '../dsh-plugins/dsh-qqbot-services/controller.js'
import { createCharacterBridge } from '../dsh-plugins/dsh-qqbot-services/character-bridge.js'
import { createPublicMemory } from '../dsh-plugins/dsh-qqbot-services/public-memory.js'
import { createHandler, summarizeConnectionConfig } from '../dsh-plugins/dsh-qqbot-services/index.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const fixture = join(root, 'packages/bot/test/fixtures/synthetic-character')
const characterDir = mkdtempSync(join(tmpdir(), 'qqbot-acceptance-'))
cpSync(join(fixture, 'source'), join(characterDir, 'source'), { recursive: true })
cpSync(join(fixture, 'st'), join(characterDir, 'st'), { recursive: true })

const counts = {
  probe: 0, launch: 0, state: 0, events: 0,
  napcatRead: 0, qqSend: 0, details: 0, home: 0, roomReply: 0, character: 0, memory: 0,
}
const deltas = []

const health = { napcat: true, hindsight: true, koishi: true, koishiListening: true, maintenance: false, watchdog: true }
const controller = createController({
  probe: async () => { counts.probe++; return { ...health } },
  launch: async () => { counts.launch++ },
  sleep: async () => {},
})

// 公共记忆也走临时目录：owner-bank 是合成的公共库名，Hindsight 用假 fetcher，不碰真库。
const memoryRoot = join(characterDir, 'memory-runtime')
mkdirSync(join(memoryRoot, 'memory'), { recursive: true })
writeFileSync(join(memoryRoot, 'memory', 'owner-bank.json'), JSON.stringify({
  ownerBank: 'synthetic-owner', commonBank: 'synthetic-owner-common', legacyBank: 'synthetic-owner',
  writtenAt: '2026-11-25T00:00:00.000Z',
}))
const memoryRows = [
  { id: 'mem-1', text: '合成记忆：她和他一起去过海边。', type: 'experience',
    occurred_start: '2026-10-02T08:00:00.000Z', mentioned_at: '2026-11-01T00:00:00.000Z',
    document_id: 'doc-synthetic-1', tags: ['qq-private'], entities: ['她', '他'], metadata: {} },
  { id: 'mem-2', text: '合成记忆：已经收回的那条。', type: 'world',
    occurred_start: null, mentioned_at: null, document_id: null, tags: ['qq-private', 'recalled'],
    entities: ['她'], metadata: {} },
]
const memoryCalls = []
const memoryFetcher = async url => {
  memoryCalls.push(String(url))
  return { ok: true, json: async () => memoryRows }
}

const koishiConfig = { plugins: { 'qqbot:offline': {
  dataDir: memoryRoot,
  contacts: [{ qq: 200, name: '测试联系人', tier: 'boyfriend' }],
  groupChat: 'read', proactive: 'off', oneLife: 'off', token: 'offscreen-token',
} } }

const napcat = async (action, params) => {
  counts.napcatRead++
  if (action === 'get_login_info') return { user_id: 100, nickname: '测试账号' }
  if (action === 'get_friend_list') return [{ user_id: 200, nickname: '好友' }]
  if (action === 'get_group_list') return [{ group_id: 300, group_name: '群' }]
  if (action === 'get_friend_msg_history') return { messages: [
    { message_id: 7, time: 1795600000, sender: { user_id: 200, nickname: '好友' }, message: '合成私聊' },
  ] }
  if (action === 'get_group_msg_history') return { messages: [
    { message_id: 8, group_id: 300, time: 1795600001, sender: { user_id: 200, card: '群名片' }, message: [{ type: 'text', data: { text: '合成群聊' } }] },
  ] }
  throw Error('unexpected_read:' + action)
}

const chat = createChat(napcat, {
  ownerId: '200',
  send: async () => { counts.qqSend++ },
})

const detailsData = {
  access: () => summarizeConnectionConfig(koishiConfig),
  backups: () => [{ name: '2026-11-25', complete: true }],
  books: () => [{ title: '合成书', author: '合成作者', progress: 0.5 }],
  library: () => ({ categories: { fact: 3 } }),
  memory: () => ({ registered: true, categories: { fact: 3 }, documents: 2 }),
  versions: () => ({ local: 'f9fdb0e6', remote: 'f9fdb0e6' }),
  logs: () => ({ operations: [], recall: [] }),
}
const details = async kind => { counts.details++; return detailsData[kind]() }

const room = createCompanionRoom({ reply: undefined, sniffMime: async () => 'image/png' })
const bridge = createCharacterBridge({
  root,
  sourceDir: join(characterDir, 'source'),
  stDir: join(characterDir, 'st'),
  prefix: 'synthetic',
})
const publicMemory = createPublicMemory({
  root,
  readConfig: () => koishiConfig,
  hindsightUrl: 'http://127.0.0.1:8899',
  fetcher: memoryFetcher,
  now: () => new Date('2026-11-25T12:00:00.000Z'),
})
const companion = {
  room,
  home: async () => { counts.home++; return { places: ['客厅'], activities: ['读书'], status: { state: 'unpublished' } } },
  sticker: async () => null,
  character: {
    load: () => { counts.character++; return bridge.load() },
    preview: body => { counts.character++; return bridge.preview(body) },
    save: body => { counts.character++; return bridge.save(body) },
  },
  memory: {
    search: (...args) => { counts.memory++; return publicMemory.search(...args) },
    graph: (...args) => { counts.memory++; return publicMemory.graph(...args) },
  },
}
const connection = { authorizeIndex: req => req.headers.cookie === 'test-session=owner' }
const handler = createHandler(controller, () => { counts.events++; return [] }, chat, connection, () => 1_800_000_000_000, details, companion)

async function call(method, route, { body, cookie = 'test-session=owner', panel = true, remote = '127.0.0.1' } = {}) {
  let status, payload
  const before = { ...counts }
  const headers = { host: '127.0.0.1:3000', cookie }
  if (panel) headers['x-qqbot-service-panel'] = '1'
  if (body !== undefined) headers['content-type'] = 'application/json'
  const req = {
    method, url: '/api/qqbot-services/' + route, socket: { remoteAddress: remote }, headers,
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(JSON.stringify(body)) },
  }
  await handler(req, {
    writeHead(code) { status = code },
    end(value) { try { payload = JSON.parse(String(value)) } catch { payload = String(value) } },
  })
  const used = Object.fromEntries(Object.entries(counts).filter(([key, value]) => value !== before[key]).map(([key, value]) => [key, value - before[key]]))
  deltas.push({ route: `${method} ${route}`, status, used })
  return { status, payload }
}

// 总览：一次 probe、一次事件读取。
let response = await call('GET', 'state')
assert.equal(response.status, 200)
assert.equal(response.payload.diagnostic.split('\n')[0], '林梦瑶 · DSH 服务诊断')

// 聊天：只读一个会话，名单只取需要的两类。
response = await call('POST', 'chat/list')
assert.equal(response.status, 200)
assert.deepEqual(response.payload.sessions.map(session => session.key), ['private:200', 'group:300'])
response = await call('POST', 'chat/history?key=private%3A200')
assert.equal(response.status, 200)
assert.equal(response.payload.messages[0].text, '合成私聊')

// 本人代发：预览之后放弃，不消耗确认单，发送接口调用数必须为 0。
const message = { key: 'private:200', accountId: '100', text: '仅离线验收' }
response = await call('POST', 'chat/prepare', { body: message })
assert.equal(response.status, 200)
assert.equal(response.payload.preview.text, '【本人手动代发】仅离线验收')
response = await call('POST', 'chat/send', { body: message })
assert.equal(response.status, 403, '没有确认单的发送必须被拒绝')
assert.equal(counts.qqSend, 0, '取消或未经确认的发送不得触达发送接口')
// 过期的确认单同样不得发送。
response = await call('POST', 'chat/prepare', { body: message })
const stale = { ...message, confirmation: response.payload.confirmation }
await call('POST', 'chat/send', { body: { ...stale, text: '替换正文' } })
assert.equal(counts.qqSend, 0)

// 会客室：只有房主能邀请和读消息，邀请码不外泄到消息体。
response = await call('POST', 'room/owner/invite')
assert.equal(response.status, 200)
assert.match(response.payload.url, /#invite=[A-Za-z0-9_-]{32}$/)
response = await call('POST', 'room/owner/messages')
assert.equal(response.status, 200)
assert.deepEqual(response.payload.messages, [])
assert.equal((await call('POST', 'room/guest/messages')).status, 403)

// 她的家：只读公开状态投影。
response = await call('GET', 'home')
assert.equal(response.status, 200)
assert.equal(response.payload.status.state, 'unpublished')

// 运维页：访问配置、备份、日志、版本、读书与记忆都走只读投影。
for (const kind of ['access', 'backups', 'logs', 'versions', 'books', 'library', 'memory']) {
  response = await call('GET', 'details/' + kind)
  assert.equal(response.status, 200, kind + ' 应可读')
}

// 角色资料：读一次拿快照；预览不写盘；非法资料只回位置和类别；合法资料保存后第二次不再写。
response = await call('GET', 'character')
assert.equal(response.status, 200)
assert.match(response.payload.token, /^[0-9a-f]{64}$/)
const persona = response.payload.parts.persona
const scenesBefore = readFileSync(join(characterDir, 'source/scenes.yml'), 'utf8')
response = await call('POST', 'character/preview', { body: { part: 'scenes', value: response.payload.parts.scenes, token: response.payload.token } })
assert.equal(response.status, 200)
assert.equal(response.payload.ok, true, '原样预览应当通过')
assert.equal(readFileSync(join(characterDir, 'source/scenes.yml'), 'utf8'), scenesBefore, '预览不得写盘')
response = await call('POST', 'character/save', { body: { part: 'persona', value: { ...persona, name: '   ' }, token: response.payload.token } })
assert.equal(response.status, 200)
assert.equal(response.payload.ok, false, '非法资料不得保存')
assert.ok(response.payload.problems.every(problem => problem.field && problem.kind && problem.hint), '只给位置、类别和改法')
assert.ok(!JSON.stringify(response.payload.problems).includes('persona.yml.relation'), '不回显资料内容')
// 原样保存一次（把合成资料写成统一表头），再保存一次应当什么都不写；拿旧快照保存要报冲突。
const fresh = await call('GET', 'character')
const firstSave = await call('POST', 'character/save', { body: { part: 'scenes', value: fresh.payload.parts.scenes, token: fresh.payload.token } })
assert.equal(firstSave.status, 200)
assert.equal(firstSave.payload.ok, true)
const secondSave = await call('POST', 'character/save', { body: { part: 'scenes', value: fresh.payload.parts.scenes, token: firstSave.payload.token } })
assert.deepEqual(secondSave.payload.written, [], '内容没变就不再写盘')
const staleSave = await call('POST', 'character/save', { body: { part: 'scenes', value: fresh.payload.parts.scenes, token: fresh.payload.token } })
assert.equal(staleSave.payload.conflict, true, '旧快照不得覆盖新内容')
assert.equal(counts.qqSend, 0, '角色资料编辑不得触达发送接口')

// 公共记忆：只查公布的公共库，只回摘要与来源，收回的不出正文。
response = await call('GET', 'memory/search?q=' + encodeURIComponent('海边') + '&page=1&limit=8')
assert.equal(response.status, 200)
assert.equal(response.payload.linked, true, '公布了公共库就该连得上')
assert.equal(memoryCalls.length, 1, '一个查询只打一次 Hindsight')
assert.match(memoryCalls[0], /synthetic-owner-common\/memories\/recall$/)
assert.ok(!memoryCalls[0].includes('synthetic-owner/'), '不查他的私有库')
assert.equal(response.payload.items[0].text, '合成记忆：她和他一起去过海边。')
assert.deepEqual(response.payload.items[0].source, { document: 'doc-synthetic-1' })
assert.equal(response.payload.items[1].withdrawn, true, '收回的要标出来')
assert.equal(response.payload.items[1].text, null, '收回的不给正文')
assert.ok(!JSON.stringify(response.payload).includes('tags'), '原始字段不外传')
response = await call('GET', 'memory/graph?q=' + encodeURIComponent('海边'))
assert.equal(response.status, 200)
assert.equal(response.payload.linked, true)
assert.ok(response.payload.nodes.some(node => node.name === '她'))
assert.equal(counts.qqSend, 0, '记忆面板不得触达发送接口')

// 非本机来源与非主人会话直接拒绝，且不触达任何下游。
response = await call('GET', 'home', { remote: '192.168.1.50' })
assert.equal(response.status, 403, '非回环来源必须拒绝')
response = await call('GET', 'home', { cookie: 'test-session=other-browser' })
assert.equal(response.status, 403, '非主人浏览器会话必须拒绝')
assert.equal(counts.home, 1, '被拒绝的请求不得触达她的家接口')
response = await call('GET', 'character', { remote: '192.168.1.50' })
assert.equal(response.status, 403, '非回环来源不得读角色资料')
const memoryBefore = counts.memory
response = await call('GET', 'memory/search?q=' + encodeURIComponent('海边'), { remote: '192.168.1.50' })
assert.equal(response.status, 403, '非回环来源不得查公共记忆')
assert.equal(counts.memory, memoryBefore, '被拒绝的请求不得触达公共库')

const width = Math.max(...deltas.map(row => row.route.length))
const pad = value => String(value).padEnd(width)
const lines = [
  '| 页面请求 | 状态 | 本次触达的模拟调用 |',
  '| ' + '-'.repeat(width) + ' | --- | --- |',
  ...deltas.map(row => `| ${pad(row.route)} | ${row.status} | ${Object.entries(row.used).map(([key, value]) => `${key}×${value}`).join('、') || '无'} |`),
]
console.log(lines.join('\n'))
console.log('')
console.log(`模拟调用合计：probe=${counts.probe} events=${counts.events} napcatRead=${counts.napcatRead} qqSend=${counts.qqSend} details=${counts.details} home=${counts.home} launch=${counts.launch} character=${counts.character} memory=${counts.memory}`)
console.log(`取消/未经确认的 QQ 发送调用数：${counts.qqSend}（要求 0）`)
rmSync(characterDir, { recursive: true, force: true })
