import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createLocalPanels } from '../dsh-plugins/dsh-qqbot-services/local-panels.js'
import { createHandler } from '../dsh-plugins/dsh-qqbot-services/index.js'
import { summarizeRecallLog } from '../dsh-plugins/dsh-qqbot-services/index.js'
import { createConfigEditor } from '../dsh-plugins/dsh-qqbot-services/config-editor.js'
import { createRequire } from 'node:module'
import { createHistoryMedia } from '../dsh-plugins/dsh-qqbot-services/history-media.js'
import { sniffMime } from '../packages/chat-bridge/src/media.ts'

const root = fileURLToPath(new URL('../', import.meta.url))
const card = 'packages/bot/test/fixtures/synthetic-character/st/synthetic-{tier}.json'
const sha = 'a'.repeat(40)
const yaml = createRequire(import.meta.url)('js-yaml')
const make = plugin => createLocalPanels({
  root, readConfig: () => ({ plugins: { qqbot: { contacts: [{ qq: 123, tier: 'boyfriend' }], characterCard: card, ...plugin } } }),
  now: () => new Date('2026-11-25T12:00:00Z'),
  runGit: async args => args.at(-1) === 'HEAD' ? sha + '\n' : 'not a real SHA',
})

test('the local bookshelf uses the QQ progress engine without exposing private card fields', async () => {
  const local = make()
  const shelf = await local.details('books')
  const book = shelf.books.find(item => item.id === 'fog-harbor')
  assert.equal(book.title, '雾港旧事')
  assert.equal(book.total, 120)
  assert.ok(book.progress.amount > 0)
  assert.deepEqual(Object.keys(book).sort(), ['author', 'id', 'platform', 'progress', 'title', 'total'])
  assert.equal((await make({ herDays: false }).details('books')).books[0].progress, null)
  assert.deepEqual(await local.details('versions'), { local: sha, tracked: null })
  assert.equal(await local.details('restore-check', new URLSearchParams({ day: '../bot' })), null)
})

test('sticker preview uses only local indexed files and rejects unrecognized bytes or paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-panels-'))
  try {
    const stickerDir = join(dir, 'stickers')
    mkdirSync(stickerDir)
    const id = '123456abcdef'
    const file = `${id}.png`
    const png = Buffer.from('89504e470d0a1a0a', 'hex')
    writeFileSync(join(stickerDir, 'index.json'), JSON.stringify({ version: 1, entries: [
      { id, file, description: '测试表情', tags: ['测试'], source: { from: 123, name: '应隐藏' } },
      { id: '012345abcdef', file: '../private.png', description: '非法路径' },
    ] }))
    writeFileSync(join(stickerDir, file), png)
    const local = make({ dataDir: dir })
    assert.deepEqual(await local.details('library'), { stickers: [{ id, title: '测试表情', tags: ['测试'] }], jokes: [] })
    assert.deepEqual(local.sticker(id), { type: 'image/png', body: png })
    assert.equal(local.sticker('../private'), null)
    writeFileSync(join(stickerDir, file), '<svg onload="alert(1)">')
    assert.equal(local.sticker(id), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('viewing the joke index does not migrate legacy recall state or show unverified phrases', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-panel-recall-'))
  try {
    for (const sub of ['chats', 'jokes']) mkdirSync(join(dir, sub))
    const recalled = join(dir, 'chats', '123.recalled.json')
    writeFileSync(recalled, '[42]')
    writeFileSync(join(dir, 'chats', '123.jsonl'), JSON.stringify({
      role: 'user', time: '2026-11-24T12:00:00Z', content: '隐藏的合成原文', messageId: 42,
    }) + '\n')
    writeFileSync(join(dir, 'jokes', '123.json'), JSON.stringify({ version: 1, jokes: [{ phrase: '隐藏的合成原文', origin: '旧来源' }] }))
    assert.deepEqual((await make({ dataDir: dir }).details('library')).jokes, [])
    assert.equal(readFileSync(recalled, 'utf8'), '[42]')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('memory status uses only the configured local public bank statistics', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-panel-memory-'))
  try {
    const mem = join(dir, 'memory')
    mkdirSync(mem)
    const marker = join(mem, 'owner-bank.json')
    writeFileSync(marker, JSON.stringify({ ownerBank: 'private-id', commonBank: 'example-common', legacyBank: 'old-id' }))
    const calls = []
    const local = createLocalPanels({
      root, readConfig: () => ({ plugins: { qqbot: { dataDir: dir, contacts: [{ qq: 100, tier: 'boyfriend' }] } } }),
      hindsightUrl: 'http://127.0.0.1:8899',
      fetcher: async url => {
        calls.push(url.pathname)
        return new Response(JSON.stringify({ bank_id: 'example-common', total_nodes: 5, total_documents: 3, content: '隐藏字段' }))
      },
    })
    assert.deepEqual(await local.details('memory'), { linked: true, common: { facts: 5, documents: 3 } })
    assert.deepEqual(calls, ['/v1/default/banks/example-common/stats'])
    writeFileSync(marker, JSON.stringify({ version: 1, reason: 'memory_disabled' }))
    assert.deepEqual(await local.details('memory'), { linked: false, common: null })
    assert.equal(calls.length, 1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('only the owner can preview stickers or dispatch a date-scoped isolated drill', async () => {
  const drilled = []
  const connection = { authorizeIndex: req => req.headers.cookie === 'session=owner' }
  const handler = createHandler({}, () => [], undefined, connection, Date.now, undefined, {
    sticker: () => ({ type: 'image/png', body: Buffer.from('synthetic') }),
    restoreDrill: day => { drilled.push(day); return 200 },
  })
  async function call(path, method, owner, body = {}) {
    let status, headers, value
    await handler({ method, url: '/api/qqbot-services/' + path, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1', cookie: owner ? 'session=owner' : 'session=guest',
        'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
      async *[Symbol.asyncIterator]() { yield JSON.stringify(body) },
    }, { writeHead(code, output) { status = code; headers = output }, end(output) { value = output } })
    return { status, headers, value }
  }
  assert.equal((await call('sticker/123456abcdef', 'GET', false)).status, 403)
  assert.equal((await call('sticker/123456abcdef', 'GET', true)).headers['content-type'], 'image/png')
  assert.equal((await call('backup/restore-drill', 'POST', false, { day: '2026-11-25' })).status, 403)
  assert.equal((await call('backup/restore-drill', 'POST', true, { day: '../live' })).status, 400)
  assert.equal((await call('backup/restore-drill', 'POST', true, { day: '2026-11-25' })).status, 200)
  assert.deepEqual(drilled, ['2026-11-25'])
})

test('QQ inline media uses opaque expiring references and only fetches supported QQ HTTPS media', async () => {
  const calls = []
  let now = 1000
  const png = Buffer.from('89504e470d0a1a0a', 'hex')
  const wav = Buffer.from('524946460000000057415645', 'hex')
  const media = createHistoryMedia({ now: () => now, sniffMime, fetcher: async (url, options) => {
    calls.push(url)
    assert.equal(options.redirect, 'error')
    return new Response(url.endsWith('/record') ? wav : png)
  } })
  const segments = [
    { type: 'image', data: { url: 'https://multimedia.nt.qq.com/image?secret=not-for-renderer' } },
    { type: 'record', data: { url: 'https://multimedia.nt.qq.com/record' } },
    { type: 'image', data: { url: 'https://multimedia.nt.qq.com.attacker.invalid/image' } },
    { type: 'image', data: { url: 'http://127.0.0.1:5140/secret' } },
  ]
  const refs = media.register('private:123', segments)
  assert.deepEqual(refs.map(item => item.kind), ['image', 'audio'])
  assert.doesNotMatch(JSON.stringify(refs), /qq\.com|secret/)
  assert.deepEqual(media.register('private:123', segments), refs)
  assert.notEqual(media.register('group:123', segments)[0].id, refs[0].id)
  assert.deepEqual(calls, [])
  assert.equal((await media.read(refs[0].id)).type, 'image/png')
  assert.equal((await media.read(refs[1].id)).type, 'audio/wav')
  assert.equal(calls.length, 2)
  now += 300_000
  assert.equal(await media.read(refs[0].id), null)
})

test('config import previews an allowlisted edit and applies once only if the local revision matches', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-config-editor-'))
  try {
    const file = join(dir, 'koishi.yml')
    const original = { plugins: { qqbot: { contacts: [{ qq: 100, name: '原名', tier: 'boyfriend', knowsBot: true }],
      oneDiary: false, databasePassword: 'mock-secret', proactive: 'off' }, other: { untouched: true } } }
    writeFileSync(file, yaml.dump(original))
    const edit = createConfigEditor({ file, yaml })
    const patch = { contacts: [{ qq: 100, name: '测试新名', tier: 'boyfriend' }], modes: { proactive: 'dryRun' } }
    assert.equal(edit.preview({ ...patch, modes: { oneDiary: 'on' } }, 'A').status, 400)
    assert.equal(edit.preview({ ...patch, contacts: [{ qq: 222, name: '其他', tier: 'boyfriend' }] }, 'A').status, 400)
    const planned = edit.preview(patch, 'A')
    assert.equal(planned.status, 200)
    assert.doesNotMatch(JSON.stringify(planned), /mock-secret/)
    assert.equal(edit.apply(planned.ticket, 'B').status, 403)
    assert.equal(edit.apply(planned.ticket, 'A').status, 200)
    assert.equal(edit.apply(planned.ticket, 'A').status, 403)
    const changed = yaml.load(readFileSync(file, 'utf8'))
    assert.equal(changed.plugins.qqbot.contacts[0].knowsBot, true)
    assert.equal(changed.plugins.qqbot.contacts[0].name, '测试新名')
    assert.equal(changed.plugins.qqbot.proactive, 'dryRun')
    assert.equal(changed.plugins.qqbot.oneDiary, false)
    assert.equal(changed.plugins.qqbot.databasePassword, 'mock-secret')
    assert.deepEqual(changed.plugins.other, original.plugins.other)
    const next = edit.preview(patch, 'A')
    writeFileSync(file, yaml.dump(original))
    assert.equal(edit.apply(next.ticket, 'A').status, 409)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('panel diagnostics never return old query text or raw error messages', () => {
  const at = '2026-11-25T00:00:00.000Z'
  const lines = [
    `${at} recall q=synthetic private text items=2`,
    `${at} recall error synthetic private error`,
    `${at} recall items=1 selected=1 memoryChars=20 important=matched failedBanks=0`,
    `${at} recall items=1 selected=1 memoryChars=20 important=matched failedBanks=0 extra-content`,
  ]
  assert.deepEqual(summarizeRecallLog(lines), [{ at, items: 1, selected: 1, chars: 20, important: 'matched', failed: 0 }])
})
