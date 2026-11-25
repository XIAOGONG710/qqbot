// DSH 面板「项目工具」投影（dsh-plugins/dsh-qqbot-services/project-panels.js）：开关总览、效果数、提示词构成、上线前检查。
// 仓库根指到临时目录：代码目录（node_modules、packages、scripts）用目录链接挂进来，koishi 配置是合成的对象，
// 聊天记录和指纹清单是合成的、放在临时数据目录；runtime、characters 这些真实数据一个都不挂。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
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
const local = (day, hour, minute = 0, second = 0) => new Date(2026, 10, day, hour, minute, second).toISOString()

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

const panels = (cfg = config()) => createProjectPanels({ root, readConfig: () => cfg, now: () => new Date(2026, 10, 20, 12) })

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
  assert.deepEqual(Object.keys(view).sort(), ['available', 'switches'])
})

test('每周效果数：窗口到昨天、只有数，和日志里的上一次比；不写日志', async () => {
  const view = await panels().metrics({ days: 7 })
  leakCheck(view)
  assert.equal(view.available, true)
  assert.equal(view.window.days, 7)
  assert.equal(view.window.from, new Date(2026, 10, 13).toISOString())
  assert.equal(view.window.to, new Date(2026, 10, 20).toISOString())
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
  assert.equal(typeof view.zone.matches, 'boolean')
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
