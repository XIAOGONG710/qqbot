// 面板「她的状态」数据模块（dsh-plugins/dsh-qqbot-services/her-state.js，计划 2026-11-26 模块 2）：
// A 层只出数和新鲜度、B 层「她的一天」只出世界账里她做过的事的公开说法。
// 全部用合成数据：仓库根指到临时目录（代码目录用目录链接挂进来，runtime / characters 一个都不挂），灵魂目录也是临时的；
// 每份文件里都埋了 SECRET 记号，最后把所有输出串起来查，一个都不许出现。
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createHerState, herDayOf } from '../dsh-plugins/dsh-qqbot-services/her-state.js'
import { entryHash, GENESIS_PREV } from '../packages/bot/src/memory/ledger.ts'
import { dayKey } from '../packages/bot/src/language/speech-notes.ts'
import { FEELING_KINDS } from '../packages/bot/src/emotion/feelings.ts'
import { ingestDesktopRecent } from '../packages/bot/src/memory/desktop-log.ts'

const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
const OWNER = 123
const OWN_BANK = 'synth-0123456789abcdef'
const COMMON_BANK = 'synth-common'
/** 她那边的 01:40（Asia/Shanghai）：还算 11-25 那一天 */
const NIGHT = new Date('2026-11-25T17:40:00Z')
/** 她那边的 03:00：已经是 11-26 */
const MORNING = new Date('2026-11-25T19:00:00Z')

const json = (path, value) => writeFileSync(path, JSON.stringify(value))
const minutesBefore = (at, minutes) => new Date(at.getTime() - minutes * 60_000)

function lifeEvent(id, kind, day, startedAt, extra = {}) {
  const start = new Date(startedAt)
  return { id, actor: 'linmengyao', kind, day, startedAt: start.toISOString(), endedAt: new Date(start.getTime() + 30 * 60_000).toISOString(),
    source: 'simulation', result: 'succeeded', ...extra }
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-her-state-'))
  // 代码目录用目录链接挂进来；清理时先拆链接，免得递归删到真的代码
  const links = ['node_modules', 'packages'].map(name => join(root, name))
  for (const link of links) symlinkSync(join(repo, link.slice(root.length + 1)), link, 'junction')
  const data = join(root, 'runtime', 'bot')
  const soul = join(root, 'soul')
  for (const dir of [join(data, 'memory'), join(data, 'world'), join(data, 'identity'), soul]) mkdirSync(dir, { recursive: true })

  // ── 记忆 ──
  json(join(data, 'memory', 'owner-bank.json'), { ownerBank: OWN_BANK, commonBank: COMMON_BANK, legacyBank: 'synth', writtenAt: '2026-11-20T00:00:00.000Z' })
  const item = { content: 'SECRET_PENDING_CONTENT', timestamp: '2026-11-25T12:00:00.000Z', context: 'SECRET_CONTEXT', document_id: 'ep-2', tags: [], metadata: { episode: 'ep-2', messages: '1' } }
  json(join(data, 'memory', `${OWNER}-boyfriend.json`), {
    bankId: OWN_BANK, retained: { 'ep-1': 4 }, common: { 'ep-1': 4 },
    retainedAt: { 'ep-1': Date.parse('2026-11-25T10:00:00Z') }, commonAt: { 'ep-1': Date.parse('2026-11-25T11:00:00Z') },
    requeued: { 'own:ep-1': 2, 'common:ep-1': 1 },
    pendingOwn: { 'ep-2': { operationId: '12345678-1234-4123-8123-123456789abc', bankId: OWN_BANK, digest: 'a'.repeat(64), count: 1, item,
      requestHash: createHash('sha256').update(JSON.stringify(item)).digest('hex') } },
  })
  const rows = []
  for (const [at, document] of [['2026-11-24T10:00:00.000Z', 'SECRET_DOC_A'], ['2026-11-25T09:00:00.000Z', 'SECRET_DOC_B']]) {
    const entry = { seq: rows.length, at, kind: 'retain', data: { bank: COMMON_BANK, document, chars: 12 }, prev: rows.at(-1)?.hash ?? GENESIS_PREV }
    rows.push({ ...entry, hash: entryHash(entry) })
  }
  writeFileSync(join(data, 'identity', 'memory.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(data, 'identity', 'memory.jsonl.head'), rows.at(-1).hash)

  // ── 情绪 ──
  json(join(soul, 'FEELINGS.json'), { kind: 'qq-feelings', generatedAt: minutesBefore(NIGHT, 240).toISOString(),
    felt: [{ kind: 'worry', level: 'strong', cause: 'SECRET_FEELING_CAUSE', source: 'life', aboutHim: false }], line: 'SECRET_FEELING_LINE' })
  writeFileSync(join(soul, 'feeling-ledger.jsonl'), [
    { at: Date.parse('2026-11-20T08:00:00Z'), kind: 'worry', level: 'strong', cause: '妈妈那边 SECRET_MOTHER', source: 'life', aboutHim: false, withhold: 'mother' },
    { at: Date.parse('2026-11-25T12:30:00Z'), kind: 'joy', level: 'clear', cause: 'SECRET_JOY', source: 'chat', aboutHim: true, withhold: '' },
    { at: Date.parse('2026-11-22T08:00:00Z'), kind: 'tired', level: 'clear', cause: '痛经 SECRET_PAIN', source: 'body', aboutHim: false, withhold: 'pain' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n{坏行 SECRET_BROKEN\n')
  json(join(data, 'feeling-review.json'), {
    items: [{ id: 'r-1', at: Date.parse('2026-11-25T12:00:00Z'), kind: 'annoyed', strength: 2, cause: 'SECRET_REVIEW_CAUSE', aboutHim: true, evidence: ['m1'], addedAt: Date.parse('2026-11-25T13:00:00Z') }],
    retired: [{ at: 1, text: 'SECRET_RETIRED', why: 'SECRET_WHY' }], rejected: [],
    lastReflectionAt: Date.parse('2026-11-25T13:00:00Z'), lastAttemptAt: Date.parse('2026-11-25T13:00:00Z'), attempts: { day: dayKey(NIGHT.getTime()), n: 3 },
  })

  // ── 她自己的账 ──
  json(join(data, 'world', 'events.json'), { version: 1, events: [
    lifeEvent('class', 'attend_class', '2026-11-25', '2026-11-25T00:00:00Z', { subject: 'course-5', reason: 'SECRET_REASON' }),
    lifeEvent('lunch', 'eat', '2026-11-25', '2026-11-25T04:00:00Z', { subject: 'lunch' }),
    lifeEvent('date-him', 'meet', '2026-11-25', '2026-11-25T10:00:00Z', { subject: '和他去东门吃麻辣烫', meal: true, contact: OWNER, episode: 'SECRET_EPISODE' }),
    lifeEvent('date-other', 'meet', '2026-11-25', '2026-11-25T12:00:00Z', { subject: 'SECRET_OTHER_MEET 和他看电影', contact: 456 }),
    lifeEvent('money', 'receive_money', '2026-11-25', '2026-11-25T13:00:00Z', { subject: 'SECRET_MONEY', amount: 200, contact: OWNER }),
    lifeEvent('failed', 'leisure', '2026-11-25', '2026-11-25T13:30:00Z', { subject: 'SECRET_FAILED', result: 'failed' }),
    lifeEvent('unknown', 'private_note', '2026-11-25', '2026-11-25T14:00:00Z', { subject: 'SECRET_UNKNOWN' }),
    lifeEvent('study', 'study', '2026-11-25', '2026-11-25T14:30:00Z', { subject: 'course-7', result: 'interrupted', reason: 'interrupted_by_class SECRET_INTERRUPT' }),
    // 01:30 已经是 11-26 的日历日，但还在她 11-25 那一天里
    lifeEvent('cat', 'feed_cat', '2026-11-25', '2026-11-25T17:30:00Z', { seen: false }),
    lifeEvent('book', 'read_book', '2026-11-24', '2026-11-24T13:00:00Z', { subject: 'fog-harbor' }),
    // 02:30：她的 11-26
    lifeEvent('chat', 'interact_npc', '2026-11-26', '2026-11-25T18:30:00Z', { subject: '和室友聊了会天' }),
  ] })
  writeFileSync(join(data, 'timeline.jsonl'), [
    { at: '2026-11-25T08:00:00.000Z', channel: 'bilibili', kind: 'comment', summary: 'SECRET_TIMELINE_A' },
    { at: '2026-11-25T15:00:00.000Z', channel: 'web', kind: 'search', summary: 'SECRET_TIMELINE_B' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(soul, 'JOURNAL.md'), '# 日记\n\n## 2026-11-23 周一\nSECRET_JOURNAL\n')
  json(join(data, 'memory', 'diary.json'), { version: 1, written: { '2026-11-24': 3 }, texts: { '2026-11-24': 'SECRET_AUTO_DIARY' } })
  json(join(soul, 'SELF.json'), { kind: 'qq-self', version: 1, generatedAt: minutesBefore(NIGHT, 3).toISOString(), at: minutesBefore(NIGHT, 3).toISOString(),
    validUntil: new Date(NIGHT.getTime() + 7 * 60_000).toISOString(), day: '2026-11-25', asleep: false,
    lines: [{ slot: 'doing', text: 'SECRET_SELF_LINE' }], pending: [{ id: 'inner:1', kind: 'inner', goes: 'tell', text: 'SECRET_PENDING_THOUGHT', since: '2026-11-25T10:00:00.000Z' }] })
  writeFileSync(join(soul, 'NOW.md'), `<!-- generated-at: ${minutesBefore(NIGHT, 45).toISOString()} -->\n\nSECRET_NOW_BODY\n`)

  // ── 私人空间（ADR 0200）：模块不该打开这些 ──
  writeFileSync(join(soul, 'PRIVATE.dat'), 'SECRET_PRIVATE_DAT')
  json(join(soul, 'INSIGHTS.json'), { insights: ['SECRET_INSIGHT'] })
  json(join(data, 'pursuits.json'), { pursuits: [{ text: 'SECRET_PURSUIT' }] })
  json(join(data, 'her-guesses.json'), { guesses: ['SECRET_GUESS'] })

  const cleanup = () => {
    for (const link of links) unlinkSync(link)
    rmSync(root, { recursive: true, force: true })
  }
  return { root, data, soul, cleanup }
}

function hindsight(overrides = {}) {
  const calls = []
  const fetcher = async (url, options) => {
    calls.push({ path: url.pathname, redirect: options?.redirect, signal: Boolean(options?.signal) })
    if (url.pathname === '/health') return new Response('{"status":"ok"}')
    const stats = { [COMMON_BANK]: [5, 3], [OWN_BANK]: [7, 4], ...overrides }
    const match = /^\/v1\/default\/banks\/([^/]+)\/stats$/.exec(url.pathname)
    const hit = match && stats[decodeURIComponent(match[1])]
    if (hit) return new Response(JSON.stringify({ bank_id: decodeURIComponent(match[1]), total_nodes: hit[0], total_documents: hit[1],
      nodes_by_fact_type: { world: 1 }, secret: 'SECRET_BANK_FIELD' }))
    return new Response(JSON.stringify({ results: [{ text: 'SECRET_BANK_CONTENT' }] }))
  }
  return { calls, fetcher }
}

const make = (env, options = {}) => createHerState({
  root: env.root, soulDir: env.soul, hindsightUrl: 'http://127.0.0.1:8899',
  readConfig: () => ({ plugins: { qqbot: { contacts: [{ qq: OWNER, tier: 'boyfriend' }, { qq: 456, tier: 'classmate' }], timeZone: 'Asia/Shanghai' } } }),
  now: () => NIGHT, ...options,
})

/** 输出里不许有任何埋下的记号、感受种类、换过的说法 */
function assertNothingLeaks(value) {
  const text = JSON.stringify(value)
  assert.doesNotMatch(text, /SECRET/)
  for (const kind of FEELING_KINDS) assert.ok(!text.includes(`"${kind}"`), `感受种类 ${kind} 漏出来了`)
  assert.doesNotMatch(text, /身上不太舒服|心里一直悬着|妈|痛经/)
  assert.doesNotMatch(text, /synth|dsh-her-state-|runtime|soul/i, '库名、路径不出去')
}

test('A 层记忆：只有登记、可达、两个 bank 的条数、片段和账本的数；只打本机 stats 和 health', async () => {
  const env = setup()
  try {
    const { calls, fetcher } = hindsight()
    const memory = await make(env, { fetcher }).memoryHealth()
    assert.deepEqual(memory, {
      linked: true, registeredAt: '2026-11-20T00:00:00.000Z', hindsight: { reachable: true },
      common: { facts: 5, documents: 3 }, own: { facts: 7, documents: 4 },
      episodes: { pending: 1, requeued: 3, lastWrittenAt: '2026-11-25T11:00:00.000Z' },
      audit: { entries: 2, lastAt: '2026-11-25T09:00:00.000Z', verified: true },
      reconcile: { recorded: false },
    })
    assert.deepEqual(calls.map(call => call.path).sort(), ['/health', `/v1/default/banks/${OWN_BANK}/stats`, `/v1/default/banks/${COMMON_BANK}/stats`].sort())
    assert.ok(calls.every(call => call.redirect === 'error' && call.signal))
    assertNothingLeaks(memory)

    // 他的 bank 前缀和公共库对不上：不去查它；非本机地址：一个请求都不发
    json(join(env.data, 'memory', 'owner-bank.json'), { ownerBank: 'other-0123456789abcdef', commonBank: COMMON_BANK, legacyBank: 'synth' })
    const other = hindsight({ 'other-0123456789abcdef': [99, 99] })
    const narrowed = await make(env, { fetcher: other.fetcher }).memoryHealth()
    assert.equal(narrowed.own, null)
    assert.equal(narrowed.episodes, null)
    assert.ok(other.calls.every(call => !call.path.includes('other-')))
    const remote = hindsight()
    const offsite = await make(env, { fetcher: remote.fetcher, hindsightUrl: 'http://user:pw@127.0.0.1:8899' }).memoryHealth()
    assert.equal(offsite.hindsight.reachable, null)
    assert.equal((await make(env, { fetcher: remote.fetcher, hindsightUrl: 'http://example.invalid:8899' }).memoryHealth()).common, null)
    assert.equal(remote.calls.length, 0)

    // Hindsight 不在：可达是 false，条数是 null，不抛错
    const down = await make(env, { fetcher: async () => { throw Error('ECONNREFUSED SECRET_ERROR') } }).memoryHealth()
    assert.equal(down.hindsight.reachable, false)
    assertNothingLeaks(down)
  } finally { env.cleanup() }
})

test('A 层情绪：导出多久前、感觉账几条和最近一条的时刻、今天回想了几次——不出种类、来由、换过的说法', async () => {
  const env = setup()
  try {
    const emotion = await make(env, { fetcher: hindsight().fetcher }).emotionHealth()
    assert.deepEqual(emotion, {
      feelingsExport: { at: minutesBefore(NIGHT, 240).toISOString(), ageMinutes: 240, stale: true },
      ledger: { rows: 3, lastAt: '2026-11-25T12:30:00.000Z' },
      review: { runsToday: 3, lastAt: '2026-11-25T13:00:00.000Z' },
    })
    assertNothingLeaks(emotion)
    // 刚导出过：不算旧；第二天回想次数归零
    const fresh = await make(env, { now: () => minutesBefore(NIGHT, 230) }).emotionHealth()
    assert.deepEqual(fresh.feelingsExport, { at: minutesBefore(NIGHT, 240).toISOString(), ageMinutes: 10, stale: false })
    const nextDay = await make(env, { now: () => new Date(NIGHT.getTime() + 86_400_000) }).emotionHealth()
    assert.equal(nextDay.review.runsToday, 0)
  } finally { env.cleanup() }
})

test('A 层她自己的账：世界账、时间线、日记、SELF / NOW 的新鲜度，没有正文', async () => {
  const env = setup()
  try {
    const life = await make(env).lifeHealth()
    assert.deepEqual(life, {
      world: { events: 11, latestDay: '2026-11-26' },
      timeline: { entries: 2, lastAt: '2026-11-25T15:00:00.000Z' },
      diary: { lastDay: '2026-11-24' },
      selfExport: { at: minutesBefore(NIGHT, 3).toISOString(), ageMinutes: 3, stale: false },
      nowExport: { at: minutesBefore(NIGHT, 45).toISOString(), ageMinutes: 45, stale: true },
      desktop: null,
    })
    assertNothingLeaks(life)
    // SELF 过了它自己写的 validUntil 就算旧
    const later = await make(env, { now: () => new Date(NIGHT.getTime() + 8 * 60_000) }).lifeHealth()
    assert.deepEqual(later.selfExport, { at: minutesBefore(NIGHT, 3).toISOString(), ageMinutes: 11, stale: true })
  } finally { env.cleanup() }
})

test('B 层她的一天：按她的一天（02:00 起）分组，用状态行的说法，丢掉失败、私事、别人的约', async () => {
  const env = setup()
  try {
    assert.equal(herDayOf(NIGHT), '2026-11-25')
    assert.equal(herDayOf(MORNING), '2026-11-26')
    const night = await make(env).herDay()
    assert.equal(night.date, '2026-11-25')
    assert.equal(night.today, '2026-11-25')
    assert.deepEqual(night.events, [
      { time: '08:00', kind: 'attend_class', summary: '在上课' },
      { time: '12:00', kind: 'eat', summary: '在吃午饭' },
      { time: '18:00', kind: 'meet', summary: '在外面吃饭（和他去东门吃麻辣烫）' },
      { time: '20:00', kind: 'meet', summary: '在外面，约了人' },
      { time: '22:30', kind: 'study', summary: '在学习' },
      { time: '01:30', kind: 'feed_cat', summary: '下楼喂了猫，没见着它' },
    ])
    // 她的 11-26 还没开始：02:30 那件不算进来，也不出现在 days 里
    assert.deepEqual(night.days, [{ date: '2026-11-25', count: 6 }, { date: '2026-11-24', count: 1 }])
    assertNothingLeaks(night)
    for (const event of night.events) assert.deepEqual(Object.keys(event).sort(), ['kind', 'summary', 'time'])

    const morning = await make(env, { now: () => MORNING }).herDay()
    assert.equal(morning.date, '2026-11-26')
    assert.deepEqual(morning.events, [{ time: '02:30', kind: 'interact_npc', summary: '和室友聊了会天' }])
    assert.deepEqual((await make(env, { now: () => MORNING }).herDay({ date: '2026-11-24' })).events,
      [{ time: '21:00', kind: 'read_book', summary: '在看书' }])
    assert.equal(await make(env).herDay({ date: '../2026-11-24' }), null)
    // 没有 owner：谁的约都只说「约了人」
    const anonymous = createHerState({ root: env.root, soulDir: env.soul, readConfig: () => ({ plugins: { qqbot: {} } }), now: () => NIGHT })
    assert.ok((await anonymous.herDay()).events.filter(event => event.kind === 'meet').every(event => event.summary === '在外面，约了人'))
  } finally { env.cleanup() }
})

test('坏文件：当读不了（null），原文件不挪不改；没有插件块就整块 null', async () => {
  const env = setup()
  try {
    const broken = {
      [join(env.soul, 'FEELINGS.json')]: '{SECRET_BROKEN',
      [join(env.data, 'feeling-review.json')]: '[SECRET_BROKEN',
      [join(env.data, 'memory', 'owner-bank.json')]: '{"ownerBank":',
      [join(env.data, 'world', 'events.json')]: '{"version":1,"events":[{"id":"SECRET_BAD"}]}',
      [join(env.data, 'self-diary.json')]: '{SECRET_BROKEN',
    }
    for (const [path, text] of Object.entries(broken)) writeFileSync(path, text)
    const state = make(env, { fetcher: hindsight().fetcher })
    const memory = await state.memoryHealth()
    assert.equal(memory.linked, false)
    assert.equal(memory.common, null)
    const emotion = await state.emotionHealth()
    assert.equal(emotion.feelingsExport, null)
    assert.equal(emotion.review, null)
    const life = await state.lifeHealth()
    assert.equal(life.world, null)
    assert.deepEqual(await state.herDay(), { date: '2026-11-25', today: '2026-11-25', events: [], days: [] })
    assertNothingLeaks([memory, emotion, life])
    for (const [path, text] of Object.entries(broken)) assert.equal(readFileSync(path, 'utf8'), text)
    for (const dir of [env.soul, env.data, join(env.data, 'memory')]) assert.ok(!readdirSync(dir).some(name => name.includes('.corrupt-')))

    const none = createHerState({ root: env.root, soulDir: env.soul, readConfig: () => ({}) })
    assert.equal(await none.memoryHealth(), null)
    assert.equal(await none.emotionHealth(), null)
    assert.equal(await none.lifeHealth(), null)
    assert.equal(await none.herDay(), null)
    assert.ok(existsSync(join(env.soul, 'PRIVATE.dat')))
  } finally { env.cleanup() }
})

test('A 层一个生活：桌面回合只给条数和最近一次的时刻，原话不出', async () => {
  const env = setup()
  try {
    const recent = join(env.data, 'memory', 'desktop-recent.jsonl')
    const turns = [
      { at: minutesBefore(NIGHT, 90).getTime(), user: 'SECRET_DESKTOP_HE_1', assistant: 'SECRET_DESKTOP_SHE_1' },
      { at: minutesBefore(NIGHT, 20).getTime(), user: 'SECRET_DESKTOP_HE_2', assistant: 'SECRET_DESKTOP_SHE_2' },
    ]
    writeFileSync(recent, turns.map(turn => JSON.stringify(turn)).join('\n') + '\n')
    ingestDesktopRecent({ recentFile: recent, logFile: join(env.data, 'memory', 'desktop-log.jsonl'), now: NIGHT.getTime(), log: () => {} })
    const life = await make(env).lifeHealth()
    assert.deepEqual(life.desktop, { turns: 2, lastAt: minutesBefore(NIGHT, 20).toISOString() })
    assertNothingLeaks(life)
  } finally { env.cleanup() }
})

test('QQ 那边：心跳只给时刻和提交号；主动消息按她的一天（02:00 换天）数今天发了几条，不读正文、不给 QQ 号', async () => {
  const env = setup()
  try {
    const at = minutes => minutesBefore(NIGHT, minutes).toISOString()
    writeFileSync(join(env.data, 'heartbeat.json'), JSON.stringify({ at: at(5), pid: 4242, ref: 'abc1234', startedAt: at(600), connectedAt: at(590), lastMessageAt: at(30), note: 'SECRET_HEARTBEAT' }))
    mkdirSync(join(env.data, 'proactive'), { recursive: true })
    writeFileSync(join(env.data, 'proactive', `${OWNER}-boyfriend.json`), JSON.stringify({ records: [
      { id: 'a', at: '2026-11-25T03:00:00.000Z', result: 'sent', text: 'SECRET_PROACTIVE_A' }, // 她那边 11:00，今天
      { id: 'b', at: '2026-11-25T10:00:00.000Z', result: 'skipped', text: 'SECRET_PROACTIVE_B' }, // 18:00，今天，没发
      { id: 'c', at: '2026-11-25T17:00:00.000Z', result: 'sent', text: 'SECRET_PROACTIVE_C' }, // 11-26 01:00，02:00 之前还算 11-25
      { id: 'd', at: '2026-11-24T05:00:00.000Z', result: 'sent', text: 'SECRET_PROACTIVE_D' }, // 前一天
      { id: 'e', at: '2026-11-25T18:30:00.000Z', result: 'sent', text: 'SECRET_PROACTIVE_E' }, // 还没到
    ] }))
    const qq = await make(env).qqHealth()
    assert.deepEqual(qq.heartbeat, { at: at(5), ageMinutes: 5, stale: false, ref: 'abc1234', startedAt: at(600), connectedAt: at(590), lastMessageAt: at(30) })
    assert.deepEqual(qq.proactive, { sentToday: 2, triedToday: 3, lastSentAt: '2026-11-25T17:00:00.000Z' })
    assertNothingLeaks(qq)
    assert.doesNotMatch(JSON.stringify(qq), new RegExp(`(^|\\D)${OWNER}(\\D|$)`), '不给 QQ 号（完整的数字，不算 abc1234 里那段）')
    const stale = await make(env, { now: () => new Date(NIGHT.getTime() + 20 * 60_000) }).qqHealth()
    assert.equal(stale.heartbeat.stale, true, '心跳 25 分钟没更新')
  } finally { env.cleanup() }
})
