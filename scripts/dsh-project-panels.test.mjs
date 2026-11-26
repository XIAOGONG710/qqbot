// DSH 面板「项目工具」投影（dsh-plugins/dsh-qqbot-services/project-panels.js）：开关总览、效果数、提示词构成、上线前检查。
// 仓库根指到临时目录：代码目录（node_modules、packages、scripts）用目录链接挂进来，koishi 配置是合成的对象，
// 聊天记录和指纹清单是合成的、放在临时数据目录；runtime、characters 这些真实数据一个都不挂。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { createProjectPanels } from '../dsh-plugins/dsh-qqbot-services/project-panels.js'

const OWNER = 98765
const SECRET_KEY = 'sk-synthetic-secret-0000'
const SECRET_HOST = 'secret-host.invalid'
const HIS_WORDS = '合成暗号雾港灯塔'
const HER_WORDS = '只属于测试的原话'
const SHA = 'ab'.repeat(32)

let root
let links = []
/** 她那边（插件没写 timeZone：bot 的默认 Asia/Shanghai，UTC+8）的 11 月某日某时；不随跑测试那台机器的时区变 */
const local = (day, hour, minute = 0, second = 0) => new Date(Date.UTC(2026, 10, day, hour - 8, minute, second)).toISOString()
const NOW = new Date(local(20, 12))

function config(extra = {}) {
  return {
    plugins: {
      'adapter-onebot': { token: SECRET_KEY },
      qqbot: {
        contacts: [{ qq: OWNER, name: '阿明', tier: 'boyfriend' }],
        llm: { apiKey: SECRET_KEY, baseUrl: `https://${SECRET_HOST}/v1`, model: 'synthetic-model' },
        dsh: { enabled: true, baseUrl: `http://${SECRET_HOST}:5000` },
        dataDir: 'data',
        // fewerRules 开着：speechCheck 被它强行关掉
        fewerRules: true,
        speechCheck: true,
        // 只写了旧键、能用新键表达：realWorld 由它们推出来，预检算「要迁」
        realWeather: true, realAirQuality: true, realDaylight: true, realCalendar: true,
        // 新键 bilibili 和旧键 bilibiliDm 对不上：表达不了
        bilibili: 'on', bilibiliDm: 'dryRun',
        deliberation: 'routed',
        ...extra,
      },
    },
  }
}

const panels = (cfg = config(), options = {}) => createProjectPanels({ root, readConfig: () => cfg, now: () => NOW, ...options })

function leakCheck(value) {
  const text = JSON.stringify(value)
  for (const needle of [SECRET_KEY, SECRET_HOST, String(OWNER), HIS_WORDS, HER_WORDS, SHA, '阿明', 'synthetic-model', root]) {
    assert.ok(!text.includes(needle), `输出里不该有 ${needle}`)
  }
  assert.ok(!/"contacts":\[|apiKey|"llm"|"tier"/.test(text), '没有联系人名单、模型配置')
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-project-panels-'))
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
  links = ['node_modules', 'packages', 'scripts'].map(name => join(root, name))
  for (const link of links) symlinkSync(join(repo, link.slice(root.length + 1)), link, 'junction')
  const data = join(root, 'data')
  mkdirSync(join(data, 'chats'), { recursive: true })
  mkdirSync(join(data, 'logs'), { recursive: true })
  const rows = [
    { time: local(18, 10), role: 'user', content: `${HIS_WORDS}，你在干嘛`, messageId: 1 },
    { time: local(18, 10, 0, 30), role: 'assistant', content: `${HER_WORDS}\n刚下课`, messageId: 2 },
    { time: local(18, 20), role: 'user', content: '晚上吃什么', messageId: 3 },
    { time: local(18, 20, 0, 40), role: 'assistant', content: '麻辣烫吧', messageId: 4 },
    // 窗口外的一条：不算
    { time: local(10, 9), role: 'user', content: '很早以前的一句', messageId: 5 },
  ]
  writeFileSync(join(data, 'chats', `${OWNER}.jsonl`), rows.map(row => JSON.stringify(row)).join('\n') + '\n')
  // 旧格式的撤回状态（数组）：bot 的 ChatHistory.load 不带 readOnly 时会把它迁成 v2 写回去——面板不许替线上写
  writeFileSync(join(data, 'chats', `${OWNER}.recalled.json`), '[3]')
  writeFileSync(join(data, 'logs', 'weekly-metrics.jsonl'), JSON.stringify({
    version: 1, at: '2026-11-13T01:00:00.000Z', from: '2026-11-05T16:00:00.000Z', to: '2026-11-12T16:00:00.000Z', scope: 'all', contacts: 1, days: [],
    week: { hisMessages: 5, turns: 5, latency: { count: 0, p50: null, p90: null } },
  }) + '\n')
  const piece = (slot, module, list, chars, omitted) => ({ slot, module, list, chars, sha256: SHA, ...(omitted ? { omitted: true } : {}) })
  const manifest = (kind, chars, pieces, extra = {}) => ({
    v: 2, qq: OWNER, at: local(18, 10), kind, pieces, chars,
    messages: { count: 2, sha256: SHA, list: [{ role: 'system', chars, sha256: SHA }] }, ...extra,
  })
  writeFileSync(join(data, 'logs', 'prompt-manifest-2026-11-17.jsonl'), [
    manifest('reply', 1200, [piece('world', 'her-days', 'main', 300), piece('time', 'time-block', 'now', 40), piece('feeling', 'emotion', 'now', 60, true)]),
    manifest('initiate', 800, [piece('time', 'time-block', 'now', 30)]),
  ].map(row => JSON.stringify(row)).join('\n') + '\n{写到一半\n')
  writeFileSync(join(data, 'logs', 'prompt-manifest-2026-11-18.jsonl'), [
    manifest('review', 1300, [], { stage: 'exit' }),
    manifest('group', 900, [], { qq: 55555, reason: '中文不是标识符' }),
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  writeFileSync(join(data, 'logs', 'other.jsonl'), '{}\n')
})

after(() => {
  for (const link of links) { try { unlinkSync(link) } catch { /* 没建成 */ } }
  try { rmSync(root, { recursive: true, force: true }) } catch { /* 占用中 */ }
})

test('开关总览：线上值、合并键、表达不了的警告、被少规矩强行关掉的；不漏联系人和密钥', async () => {
  const view = await panels().switches()
  leakCheck(view)
  assert.equal(view.available, true)
  const row = key => view.features.find(item => item.key === key)
  // fewerRules 开着：speechCheck 写着 true 也算关，标出是谁关的
  assert.equal(view.fewerRules.on, true)
  assert.deepEqual(view.fewerRules.forced.find(item => item.key === 'speechCheck'), { key: 'speechCheck', value: false, feature: true })
  assert.equal(row('speechCheck').value, true)
  assert.equal(row('speechCheck').on, false)
  assert.equal(row('speechCheck').forcedOff, 'fewerRules')
  assert.equal(row('fewerRules').on, true)
  assert.equal(row('deliberation').forcedOff, undefined)
  // 合并键：realWorld 由旧键推出来、新键没写
  const realWorld = row('realWorld')
  assert.equal(realWorld.value, true)
  assert.equal(realWorld.written, false)
  assert.equal(realWorld.on, true)
  assert.deepEqual(realWorld.merged.legacyWritten, ['realWeather', 'realAirQuality', 'realDaylight', 'realCalendar'])
  assert.ok(realWorld.merged.absorbs.every(item => item.written && item.value === true && typeof item.label === 'string'))
  // 没写旧键的合并键：legacyWritten 是空的，旧键的值由新键派生
  const ledgers = row('ledgers')
  assert.deepEqual(ledgers.merged.legacyWritten, [])
  assert.deepEqual(ledgers.merged.absorbs.map(item => item.key), ['identityLedger', 'memoryAudit', 'memoryReconcile'])
  assert.ok(ledgers.merged.absorbs.every(item => item.written === false))
  // 几档的开关带档位
  assert.equal(row('deliberation').value, 'routed')
  assert.equal(row('deliberation').kind, 'mode')
  // dsh 是对象：只回 enabled，不回地址
  assert.deepEqual(row('dsh').value, { enabled: true })
  // 表达不了：bilibili=on 配 bilibiliDm=dryRun
  assert.equal(view.unrepresentable.length, 1)
  assert.match(view.unrepresentable[0], /^bilibili：.*bilibiliDm=dryRun/)
  assert.equal(row('bilibili').merged.legacyWritten.includes('bilibiliDm'), true)
  assert.equal(view.counts.total, view.features.length)
  assert.equal(view.counts.legacyWritten, 2)
  assert.ok(view.groups.includes('说话'))
  assert.ok(view.features.every(item => ['boolean', 'string', 'number'].includes(typeof item.value) || item.value === null || typeof item.value?.enabled === 'boolean'))
  // 少规矩关着：不强行关
  const plain = await panels(config({ fewerRules: false })).switches()
  assert.equal(plain.features.find(item => item.key === 'speechCheck').on, true)
  assert.equal(plain.features.find(item => item.key === 'speechCheck').forcedOff, undefined)
  assert.deepEqual(plain.fewerRules, { on: false, forced: [] })
})

test('上线前检查：只做开关合并预检', async () => {
  const view = await panels().golive()
  leakCheck(view)
  assert.equal(view.available, true)
  assert.equal(view.switches.unrepresentable.length, 1)
  assert.ok(view.switches.migrating.some(line => line.startsWith('realWorld（realWeather')))
  assert.ok(!view.switches.migrating.some(line => line.startsWith('bilibili')))
  assert.deepEqual(Object.keys(view).sort(), ['available', 'restarts', 'switches'])
  assert.equal(view.restarts, null, '合成数据目录里没有 restarts.log')
})

test('上线前检查：重启记录给最近几次和「距上次行为变化满没满 48 小时」，原因过一遍脱敏', async () => {
  const { writeFileSync, rmSync } = await import('node:fs')
  const file = join(root, 'data', 'restarts.log')
  const at = hours => new Date(NOW.getTime() - hours * 3_600_000).toISOString()
  writeFileSync(file, [
    { at: at(30), to: 'abc1234', kind: 'safety', reason: '修热重载', by: 'claude' },
    { at: at(10), to: 'def5678', kind: 'behavior', reason: '开 desktopDay，token=sk-abcdefghijklmnopqrstuvwx', by: 'dsh' },
    { not: 'a restart' },
  ].map(row => JSON.stringify(row)).join('\n') + '\n')
  try {
    const { restarts } = await panels().golive()
    assert.equal(restarts.count, 2, '坏行跳过')
    assert.deepEqual(restarts.recent.map(row => row.to), ['def5678', 'abc1234'], '新的在前')
    assert.equal(restarts.behavior.ok, false, '上次行为变化才过 10 小时')
    assert.equal(restarts.behavior.hoursSince, 10)
    assert.equal(restarts.behavior.gapHours, 48)
    assert.doesNotMatch(JSON.stringify(restarts), /sk-abcdefghijklmnopqrstuvwx/, '令牌被抹掉')
  } finally { rmSync(file, { force: true }) }
})

test('每周效果数：窗口到昨天、只有数，和日志里的上一次比；不写日志', async () => {
  const view = await panels().metrics({ days: 7 })
  leakCheck(view)
  assert.equal(view.available, true)
  assert.equal(view.window.days, 7)
  // 窗口按 bot 的时区（这里是默认的 Asia/Shanghai）：上海 11-13 00:00 ～ 11-20 00:00
  assert.equal(view.window.from, '2026-11-12T16:00:00.000Z')
  assert.equal(view.window.to, '2026-11-19T16:00:00.000Z')
  assert.equal(view.contacts, 1)
  assert.equal(view.week.hisMessages, 2)
  assert.equal(view.week.turns, 2)
  assert.equal(view.week.replyTurns, 2)
  assert.equal(view.week.latency.count, 2)
  assert.equal(view.days.length, 7)
  assert.equal(view.days.find(day => day.day === '2026-11-18').turns, 2)
  assert.deepEqual(view.previous.deltas.turns, { before: 5, after: 2, delta: -3 })
  assert.equal(view.previous.at, '2026-11-13T01:00:00.000Z')
  // 只有数：除了日期、窗口、时区这几个字段，任何地方都没有字符串
  const strings = []
  const walk = (value, path) => {
    if (typeof value === 'string') strings.push(path)
    else if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) walk(item, `${path}.${key}`)
  }
  walk({ week: view.week, days: view.days.map(({ day: _day, ...rest }) => rest), previous: view.previous.deltas }, '')
  assert.deepEqual(strings, [])
  assert.deepEqual(view.zone, { used: 'Asia/Shanghai', configured: null })
  assert.equal(readFileSync(join(root, 'data', 'chats', `${OWNER}.recalled.json`), 'utf8'), '[3]', '旧格式撤回状态原样不动（只读读法）')
  assert.ok(!readdirSync(join(root, 'data', 'chats')).some(name => name.includes('.tmp') || name.includes('.corrupt-')))
  assert.equal(readFileSync(join(root, 'data', 'logs', 'weekly-metrics.jsonl'), 'utf8').trim().split(/\n/).length, 1, '面板不追加日志')
  await assert.rejects(panels().metrics({ days: 0 }), RangeError)
  assert.deepEqual(await panels(config({ dataDir: 'nowhere' })).metrics(), { available: false, reason: 'no_chats' })
})

test('提示词构成：读指纹清单的数，槽名过滤成标识符，不带 QQ 号、哈希', async () => {
  const view = await panels().promptInventory()
  leakCheck(view)
  assert.equal(view.available, true)
  assert.equal(view.files, 2)
  assert.equal(view.firstDay, '2026-11-17')
  assert.equal(view.lastDay, '2026-11-18')
  const inv = view.inventory
  assert.deepEqual(inv.rounds, { total: 2, reply: 1, initiate: 1, think: 0, group: 1, review: 1, candidate: 0, fallback: 0 })
  assert.deepEqual(inv.chars, { avg: 1000, max: 1200, min: 800 })
  assert.equal(inv.slots[0].slot, 'world')
  const time = inv.slots.find(slot => slot.slot === 'time')
  assert.deepEqual({ rounds: time.rounds, chars: time.chars, module: time.module }, { rounds: 2, chars: 70, module: 'time-block' })
  assert.equal(inv.slots.find(slot => slot.slot === 'feeling').omitted, 1)
  assert.deepEqual(inv.extra.reviewStages, { exit: 1 })
  assert.deepEqual(inv.extra.groupReasons, { '?': 1 })
  assert.ok(!('llmPurposes' in inv))
  assert.ok(!JSON.stringify(view).includes('55555'))
  assert.deepEqual(await panels(config({ dataDir: 'nowhere' })).promptInventory(), { available: false, reason: 'no_manifests' })
})

test('读不到 qqbot 插件块：四个都回 available: false', async () => {
  for (const cfg of [{ plugins: {} }, null]) {
    const view = createProjectPanels({ root, readConfig: () => { if (!cfg) throw Error(SECRET_KEY); return cfg } })
    for (const name of ['switches', 'metrics', 'promptInventory', 'golive']) assert.deepEqual(await view[name](), { available: false })
  }
})

test('效果数、提示词构成：同时来的请求共用一次子进程，10 分钟内给缓存；失败不缓存，下次重算', async () => {
  let clock = NOW.getTime()
  const calls = []
  let release
  let gate = new Promise(done => { release = done })
  const run = async (job, input, options) => {
    calls.push({ job, input, options })
    await gate
    if (job === 'inventory') return { days: ['2026-11-17'], inventory: { rounds: { total: 1 }, chars: {}, piecesPerRound: {}, byKind: [], slots: [], modules: [], extra: {} } }
    return { result: { from: '2026-11-12T16:00:00.000Z', to: '2026-11-19T16:00:00.000Z', contacts: 1, days: [], week: { turns: 4 } }, previous: null }
  }
  const view = panels(config(), { run, now: () => new Date(clock) })
  const both = Promise.all([view.metrics({ days: 7 }), view.metrics({ days: 7 }), view.promptInventory(), view.promptInventory()])
  release()
  const [a, b, c, d] = await both
  assert.equal(a, b, '同一次计算')
  assert.equal(c, d)
  assert.deepEqual(calls.map(call => call.job).sort(), ['inventory', 'metrics'])
  // 子进程的时区是 bot 的时区；输入里只有路径、日子和天数，没有配置原文
  const metricsCall = calls.find(call => call.job === 'metrics')
  assert.equal(metricsCall.options.timeZone, 'Asia/Shanghai')
  assert.deepEqual(Object.keys(metricsCall.input).sort(), ['count', 'directory', 'root', 'until'])
  assert.equal(metricsCall.input.until, '2026-11-19')
  leakCheck(calls.map(call => ({ ...call.input, directory: undefined, root: undefined, logs: undefined })))

  clock += 9 * 60_000
  await view.metrics({ days: 7 })
  assert.equal(calls.length, 2, '10 分钟内用缓存')
  await view.metrics({ days: 14 })
  assert.equal(calls.length, 3, '天数不同另算')
  clock += 2 * 60_000
  await view.metrics({ days: 7 })
  assert.equal(calls.length, 4, '过了 10 分钟重算')

  // 子进程失败：错误码是固定的，不缓存
  let failing = true
  const flaky = panels(config(), { run: async () => { if (failing) throw Error('panel_job_failed'); return { result: { days: [], week: {} }, previous: null } } })
  await assert.rejects(flaky.metrics(), /^Error: panel_job_failed$/)
  failing = false
  assert.equal((await flaky.metrics()).available, true)
})

test('效果数：插件配置了时区就按它算「昨天」和子进程的 TZ', async () => {
  const calls = []
  const run = async (job, input, options) => { calls.push({ input, options }); return { result: { days: [], week: {} }, previous: null } }
  // 檀香山（UTC-10）：上海 11-20 12:00 在那边还是 11-19 18:00，所以「到昨天」是 11-18
  const view = await panels(config({ timeZone: 'Pacific/Honolulu' }), { run }).metrics()
  assert.deepEqual(view.zone, { used: 'Pacific/Honolulu', configured: 'Pacific/Honolulu' })
  assert.equal(calls[0].input.until, '2026-11-18')
  assert.equal(calls[0].options.timeZone, 'Pacific/Honolulu')
  // 写错的时区：用默认，配置项显示为 null
  const fallback = await panels(config({ timeZone: 'Not/AZone' }), { run }).metrics()
  assert.deepEqual(fallback.zone, { used: 'Asia/Shanghai', configured: null })
})

test('子进程回来的东西再过一遍白名单：字符串、文件名、联系人一律不出去', async () => {
  const run = async job => job === 'metrics'
    ? { result: { from: 'SECRET', to: '2026-11-19T16:00:00.000Z', contacts: '阿明', scope: String(OWNER),
      days: [{ day: '../etc', turns: 'SECRET', text: HIS_WORDS }], week: { turns: 1, sample: HER_WORDS, latency: { p50: 'x' } } },
      previous: { at: 'nope', deltas: { turns: { before: 1, after: 'SECRET', delta: null } } } }
    : { days: ['2026-11-17', '../secret'], inventory: { rounds: { total: 1, note: HIS_WORDS }, chars: {}, piecesPerRound: {},
      byKind: [{ kind: HIS_WORDS, rounds: '1' }], slots: [{ slot: 'a b', module: HER_WORDS, list: 'main', rounds: 1, chars: 2, omitted: 0, kinds: { reply: 1, x: 'y' } }],
      modules: [], extra: { reviewStages: { [HER_WORDS]: 1 }, candidateCalls: 'x', groupReasons: { ok: 'bad' } } } }
  const view = panels(config(), { run })
  const metrics = await view.metrics()
  const inventory = await view.promptInventory()
  leakCheck([metrics, inventory])
  assert.doesNotMatch(JSON.stringify([metrics, inventory]), /SECRET|etc|secret|阿明/)
  assert.equal(metrics.window.from, null)
  assert.equal(metrics.contacts, null)
  assert.equal(metrics.days[0].day, '?')
  assert.deepEqual(metrics.week, { turns: 1, latency: {} })
  assert.deepEqual(inventory.firstDay, '2026-11-17')
  assert.equal(inventory.files, 1)
})

test('效果数带他的反馈：窗口里「假」「像」各几条，上下文不读出来', async () => {
  const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
  const dir = join(root, 'data', 'feedback')
  mkdirSync(dir, { recursive: true })
  const row = (at, label) => JSON.stringify({ at, label, turn: { text: 'SECRET_FEEDBACK_TURN' }, context: [{ content: 'SECRET_FEEDBACK_CONTEXT' }] })
  writeFileSync(join(dir, '2026-11.jsonl'), [
    row('2026-11-14T04:00:00.000Z', 'fake'),
    row('2026-11-15T04:00:00.000Z', 'real'),
    row('2026-11-16T04:00:00.000Z', 'real'),
    row('2026-11-10T04:00:00.000Z', 'fake'), // 窗口前
    row('2026-11-20T04:00:00.000Z', 'fake'), // 窗口后（窗口到昨天）
    '{坏行',
  ].join('\n') + '\n')
  try {
    const view = await panels().metrics({ days: 7 })
    assert.deepEqual(view.feedback, { fake: 1, real: 2 })
    assert.doesNotMatch(JSON.stringify(view), /SECRET_FEEDBACK/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('提示词构成的名字按白名单放：不认识的槽、像主机名的模块、不在 MANIFEST_KINDS 的轮次一律是 ?', async () => {
  const { writeFileSync, rmSync } = await import('node:fs')
  const file = join(root, 'data', 'logs', 'prompt-manifest-2026-11-19.jsonl')
  const odd = { v: 2, qq: OWNER, at: '2026-11-19T02:00:00.000Z', kind: 'reply', chars: 100,
    pieces: [{ slot: 'evil.example.com', module: 'Some.Host', list: 'elsewhere', chars: 10, sha256: SHA }, { slot: 'time', module: 'time-block', list: 'now', chars: 5, sha256: SHA }],
    messages: { count: 1, sha256: SHA, list: [] } }
  writeFileSync(file, JSON.stringify(odd) + '\n')
  try {
    const view = await panels().promptInventory()
    const text = JSON.stringify(view)
    assert.doesNotMatch(text, /evil\.example\.com|Some\.Host|elsewhere/)
    assert.ok(view.inventory.slots.some(row => row.slot === '?' && row.module === '?' && row.list === '?'), '不认识的都成了 ?')
    assert.ok(view.inventory.slots.some(row => row.slot === 'time' && row.module === 'time-block' && row.list === 'now'), '认识的照常')
  } finally { rmSync(file, { force: true }) }
})
