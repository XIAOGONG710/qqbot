// DSH 面板「她心里的」（ADR 0350，默认关）：只照她定过的规矩出投影。
// 合成灵魂目录：临时根下只挂 packages（目录链接），FEELINGS.json 和感觉账都是这里写的假数据，不读 runtime/、characters/。
// 每条来由里都埋一个记号，断言输出里一次都不出现。
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, test } from 'node:test'
import { createHerInner, herDayKey, herInnerEnabled } from '../dsh-plugins/dsh-qqbot-services/her-inner.js'

const MARK = 'ZQX-CAUSE-MARK'
const HOUR = 3_600_000
const DAY = 24 * HOUR
// 本机时区的 2026-11-26 15:00（她的今天）
const NOW = new Date(2026, 10, 26, 15, 0).getTime()

let root
let link
const soul = 'soul'

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-her-inner-'))
  const repo = resolve(fileURLToPath(new URL('..', import.meta.url)))
  link = join(root, 'packages')
  symlinkSync(join(repo, 'packages'), link, 'junction')
  mkdirSync(join(root, soul))
})

after(() => {
  unlinkSync(link)
  rmSync(root, { recursive: true, force: true })
})

const writeFeelings = (at, felt) => writeFileSync(join(root, soul, 'FEELINGS.json'), JSON.stringify({
  kind: 'qq-feelings', generatedAt: new Date(at).toISOString(), line: `那一行 ${MARK}`,
  felt: felt.map(item => ({ source: 'chat', aboutHim: false, ...item, cause: `${item.cause} ${MARK}` })),
}))

const writeLedger = rows => writeFileSync(join(root, soul, 'feeling-ledger.jsonl'), rows.map(row => JSON.stringify({
  source: 'chat', aboutHim: false, withhold: '', ...row, cause: `${row.cause} ${MARK}`,
})).join('\n') + '\n')

const inner = () => createHerInner({ soulDir: soul, root, now: () => NOW })

function assertClean(value) {
  const text = JSON.stringify(value)
  assert.ok(!text.includes(MARK), `来由漏出来了：${text}`)
  assert.ok(!/痛经|妈/.test(text), `疼 / 她妈那块漏出来了：${text}`)
  assert.ok(!/"(cause|source|aboutHim|withhold)"/.test(text), `多给了字段：${text}`)
}

test('只有 herInnerPanel 严格等于 true 才算开', () => {
  assert.equal(herInnerEnabled({ herInnerPanel: true }), true)
  for (const config of [undefined, null, {}, { herInnerPanel: false }, { herInnerPanel: 'true' }, { herInnerPanel: 1 }, { herInnerPanel: {} }]) {
    assert.equal(herInnerEnabled(config), false, JSON.stringify(config))
  }
})

test('她的一天凌晨 2 点换天', () => {
  assert.equal(herDayKey(new Date(2026, 10, 27, 1, 59).getTime()), '2026-11-26')
  assert.equal(herDayKey(new Date(2026, 10, 27, 2, 0).getTime()), '2026-11-27')
})

test('today：疼和她妈那块只说换过的话，因为他的难过封顶「有点」，没有来由', async () => {
  writeFeelings(NOW - HOUR, [
    { kind: 'tired', level: 'strong', cause: '痛经疼得厉害' },
    { kind: 'worry', level: 'strong', cause: '她妈又打电话来' },
    { kind: 'sad', level: 'strong', cause: '他说话太冲', aboutHim: true },
    { kind: 'joy', level: 'strong', cause: '相机到手' },
    { kind: 'annoyed', level: 'faint', cause: '小事' },
  ])
  const today = await inner().today()
  assertClean(today)
  assert.equal(today.day, '2026-11-26')
  assert.equal(today.stale, false)
  assert.deepEqual(today.feelings, [
    { label: null, said: '身上不太舒服' },
    { label: null, said: '心里一直悬着' },
    { label: '难过', said: '有点难过' },
    { label: '开心', said: '很开心' },
  ])
})

test('today：不是她今天算的就是空的；超过 3 小时标旧', async () => {
  writeFeelings(new Date(2026, 10, 26, 1, 30).getTime(), [{ kind: 'joy', level: 'clear', cause: '昨天的事' }])
  const yesterday = await inner().today()
  assert.deepEqual(yesterday.feelings, [])
  assert.equal(yesterday.at, null)
  writeFeelings(NOW - 5 * HOUR, [{ kind: 'annoyed', level: 'clear', cause: '作业' }])
  const old = await inner().today()
  assert.equal(old.stale, true)
  assert.deepEqual(old.feelings, [{ label: '烦', said: '有点烦' }])
  assertClean(old)
})

test('today：没有文件、文件坏了都回空', async () => {
  rmSync(join(root, soul, 'FEELINGS.json'), { force: true })
  assert.deepEqual((await inner().today()).feelings, [])
  writeFileSync(join(root, soul, 'FEELINGS.json'), `{"kind":"qq-feelings","felt":[{"cause":"${MARK}"`)
  const broken = await inner().today()
  assert.deepEqual(broken.feelings, [])
  assertClean(broken)
})

test('ledger：按她的一天分组、新的在前，换过说法的和老的只剩大概，没有来由', async () => {
  const at = (month, day, hour, minute = 0) => new Date(2026, month - 1, day, hour, minute).getTime()
  writeLedger([
    // 11-26 当天
    { at: at(11, 26, 9), kind: 'joy', level: 'strong', cause: '相机到手' },
    { at: at(11, 26, 10), kind: 'tired', level: 'strong', cause: '痛经', withhold: 'pain' },
    { at: at(11, 26, 11), kind: 'worry', level: 'strong', cause: '她妈住院', withhold: 'mother' },
    // 11-26 凌晨 1 点：还算 11-25
    { at: at(11, 26, 1), kind: 'sad', level: 'strong', cause: '他没回消息', aboutHim: true },
    { at: at(11, 25, 20), kind: 'annoyed', level: 'strong', cause: '他又迟到', aboutHim: true },
    { at: at(11, 25, 21), kind: 'annoyed', level: 'strong', cause: '室友吵' },
    // 同一天同一句只留一条
    { at: at(11, 25, 22), kind: 'annoyed', level: 'strong', cause: '室友又吵' },
    // 100 天以前：粗；开心不降粗
    { at: NOW - 100 * DAY, kind: 'sad', level: 'strong', cause: '考砸了' },
    { at: NOW - 100 * DAY + HOUR, kind: 'joy', level: 'clear', cause: '放假' },
    // 以后的不算
    { at: NOW + HOUR, kind: 'joy', level: 'clear', cause: '还没发生' },
  ])
  const recent = await inner().ledger()
  assertClean(recent)
  assert.deepEqual(recent.days, [
    { day: '2026-11-26', rows: [
      { time: '09:00', label: '开心', said: '很开心', coarse: false },
      { time: null, label: null, said: '只记得个大概：身上不太舒服', coarse: true },
      { time: null, label: null, said: '只记得个大概：心里一直悬着', coarse: true },
    ] },
    { day: '2026-11-25', rows: [
      { time: '20:00', label: '烦', said: '有点烦', coarse: false },
      { time: '21:00', label: '烦', said: '很烦', coarse: false },
      { time: '01:00', label: '难过', said: '有点难过', coarse: false },
    ] },
  ])

  const wide = await inner().ledger({ days: 120 })
  assertClean(wide)
  const old = wide.days.at(-1)
  assert.equal(old.day, herDayKey(NOW - 100 * DAY))
  assert.deepEqual(old.rows.map(row => [row.label, row.said, row.time === null]), [
    ['难过', '只记得个大概', true],
    ['开心', '有点开心', false],
  ])

  const one = await inner().ledger({ days: 1 })
  assert.deepEqual(one.days.map(day => day.day), ['2026-11-26'])
})

test('ledger：没有账就是空的', async () => {
  rmSync(join(root, soul, 'feeling-ledger.jsonl'), { force: true })
  assert.deepEqual(await inner().ledger(), { days: [] })
})

test('只读：FEELINGS.json 坏了不改名隔离、不动文件，当作没有', async () => {
  const { mkdtempSync, writeFileSync, readdirSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { createHerInner } = await import('../dsh-plugins/dsh-qqbot-services/her-inner.js')
  const soul = mkdtempSync(join(tmpdir(), 'her-inner-corrupt-'))
  try {
    writeFileSync(join(soul, 'FEELINGS.json'), '{"kind":')
    const inner = createHerInner({ soulDir: soul, now: () => Date.now() })
    const today = await inner.today()
    assert.deepEqual(today.feelings, [])
    assert.deepEqual(readdirSync(soul), ['FEELINGS.json'], '没有被改名成 .corrupt-…')
  } finally { rmSync(soul, { recursive: true, force: true }) }
})
