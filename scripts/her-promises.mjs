#!/usr/bin/env node
// 到期承诺账（只读）：从她三本记忆里捞出「答应过的事」，推一个该被重新提起的日子。
// 桌面侧只读版：不动记忆、不发消息，只把「到期该被追的账」列出来。
//
// 用法：
//   node scripts/her-promises.mjs                # 已到期的最上面
//   node scripts/her-promises.mjs --all          # 连没到期的、判不出的都列
//   node scripts/her-promises.mjs --json
//   node scripts/her-promises.mjs --bank linmengyao-a5db1eb499a38621
//
// 记忆来源：runtime/her-memory-dsh/*.jsonl（scripts/her-memory-sync.mjs 的只读副本）。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const DIR = path.join(ROOT, 'runtime', 'her-memory-dsh')
const TZ = '+08:00'
const NOW = Date.now()

function flag(name) {
  return process.argv.includes(`--${name}`)
}
function opt(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1]
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`))
  return eq ? eq.slice(name.length + 3) : fallback
}

const showAll = flag('all')
const asJson = flag('json')
const onlyBank = opt('bank', null)

function ownerBanksFromFile() {
  for (const file of [
    process.env.QQBOT_OWNER_BANK_FILE,
    path.join(ROOT, 'runtime', 'bot-shadow', 'memory', 'owner-bank.json'),
    path.join(ROOT, 'runtime', 'bot', 'memory', 'owner-bank.json'),
  ].filter(Boolean)) {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'))
      return [d.ownerBank, d.commonBank, d.legacyBank].filter((b) => typeof b === 'string' && b)
    } catch {}
  }
  return null
}

function bankFiles() {
  const wanted = onlyBank ? [onlyBank] : (ownerBanksFromFile() || [])
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.jsonl')) : []
  return files
    .map((f) => ({ bank: path.basename(f, '.jsonl'), file: path.join(DIR, f) }))
    .filter((x) => (wanted.length ? wanted.includes(x.bank) : true))
}

const dayKey = (ms) => {
  const d = new Date(ms + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`
}
const dayStart = (ms) => Date.parse(`${dayKey(ms)}T00:00:00${TZ}`)
const daysBetween = (a, b) => Math.round((dayStart(b) - dayStart(a)) / 86400000)
const addDays = (ms, n) => ms + n * 86400000
const endOfMonth = (ms) => {
  const d = new Date(ms + 8 * 3600 * 1000)
  const y = d.getUTCFullYear()
  const m = d.getUTCMonth()
  const next = Date.UTC(y, m + 1, 1) - 8 * 3600 * 1000
  return next - 86400000
}
/** 那个时间点之后最近的周六 */
const upcomingWeekend = (ms) => {
  const d = new Date(ms + 8 * 3600 * 1000).getUTCDay() // 0=周日
  const delta = (6 - d + 7) % 7 || 7
  return addDays(dayStart(ms), delta)
}

const CUES = /(答应|说好|说定|一定|保证|拉勾|每天|每晚|每周|明天|后天|下周|周末|月底|记得|不许忘|会数|数着|一千遍|1000遍|欠|回家里|回家|承诺|不许赖|别忘)/
const NOISE = /(发票|整理一下|桌面上的发票|林梦瑶今天帮宝宝干活|这页|笔记|记住了几条|明天就能用|速查卡|构图)/
const PROMISE = /(我(会|一定|保证|答应|说好|说定|不|别)|说好了|说定了|拉勾|答应你|答应我|不许|一定|保证|欠你|会数|每天都|每天我)/

/** 从一句话里推「该被重新提起」的日子 */
function dueOf(sentence, at) {
  const s = sentence
  if (/每天|每晚|天天/.test(s) && /(数|说|回|叫|打卡)/.test(s)) return { kind: '每天', due: dayStart(NOW), recurring: 'daily' }
  if (/每周|每星期/.test(s)) return { kind: '每周', due: dayStart(NOW), recurring: 'weekly' }
  if (/月底/.test(s)) return { kind: '月底', due: endOfMonth(at) }
  if (/下周/.test(s)) return { kind: '下周', due: upcomingWeekend(at) }
  if (/周末/.test(s)) return { kind: '周末', due: upcomingWeekend(at) }
  if (/后天/.test(s)) return { kind: '后天', due: addDays(dayStart(at), 2) }
  if (/明天/.test(s)) return { kind: '明天', due: addDays(dayStart(at), 1) }
  const md = /(\d{1,2})月(\d{1,2})[日号]/.exec(s)
  if (md) {
    const y = new Date(at + 8 * 3600 * 1000).getUTCFullYear()
    return { kind: '指定日', due: Date.parse(`${y}-${String(md[1]).padStart(2, '0')}-${String(md[2]).padStart(2, '0')}T00:00:00${TZ}`) }
  }
  const dOnly = /(\d{1,2})号(之前|前|交|给)?/.exec(s)
  if (dOnly && Number(dOnly[1]) <= 31) {
    const y = new Date(at + 8 * 3600 * 1000).getUTCFullYear()
    const m = String(new Date(at + 8 * 3600 * 1000).getUTCMonth() + 1).padStart(2, '0')
    return { kind: '指定日', due: Date.parse(`${y}-${m}-${String(dOnly[1]).padStart(2, '0')}T00:00:00${TZ}`) }
  }
  return null
}

const HEADER = /^——\s*(\d{4})年(\d{1,2})月(\d{1,2})日/
const SAY = /^([^\s(（][^()（）]{0,12})\s*[(（](\d{1,2}):(\d{2})[)）]\s*:?\s*(.*)$/
const SPLIT = /(?<=[。！？!?；;～~])|\/\//

const found = []
for (const { bank, file } of bankFiles()) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let doc
    try { doc = JSON.parse(line) } catch { continue }
    const baseAt = Date.parse(doc.event_date || doc.created_at || '')
    if (!Number.isFinite(baseAt)) continue
    let dateStr = null
    for (const raw of String(doc.text || '').split('\n')) {
      const l = raw.trim()
      if (!l) continue
      const h = HEADER.exec(l)
      if (h) { dateStr = `${h[1]}-${String(h[2]).padStart(2, '0')}-${String(h[3]).padStart(2, '0')}`; continue }
      const sm = SAY.exec(l)
      const who = sm ? sm[1].trim() : ''
      const body = sm ? sm[4] : l
      const at = sm && dateStr ? Date.parse(`${dateStr}T${String(sm[2]).padStart(2, '0')}:${sm[3]}:00${TZ}`) : baseAt
      if (!Number.isFinite(at)) continue
      if (NOISE.test(body)) continue
      for (const piece of body.split(SPLIT)) {
        const s = piece.trim()
        if (s.length < 5 || s.length > 120) continue
        if (!CUES.test(s) || !PROMISE.test(s)) continue
        const due = dueOf(s, at)
        found.push({ at, who, sentence: s, due, bank, docId: doc.id, tags: doc.tags })
      }
    }
  }
}

/** 去重：同句只留最早那次 */
const seen = new Map()
for (const item of found) {
  const key = item.sentence.replace(/\s+/g, '')
  const prev = seen.get(key)
  if (!prev || item.at < prev.at) seen.set(key, item)
}
const items = [...seen.values()].map((item) => {
  if (!item.due) return { ...item, status: '判不出日子' }
  const d = daysBetween(NOW, item.due.due)
  return {
    ...item,
    status: item.due.recurring === 'daily'
      ? `每天（${item.due.kind}），距今 ${daysBetween(item.at, NOW)} 天`
      : d > 0 ? `还剩 ${d} 天` : d === 0 ? '今天' : `已过 ${-d} 天`,
    sortAt: item.due.due,
    daysLeft: d,
  }
})

const rank = (x) => (x.due ? (x.daysLeft <= 0 ? 0 : 1) : 2)
items.sort((a, b) => {
  const r = rank(a) - rank(b)
  if (r !== 0) return r
  if (a.due && b.due) return (a.sortAt || 0) - (b.sortAt || 0)
  return b.at - a.at
})

const shown = showAll ? items : items.filter((x) => rank(x) <= 1)

if (asJson) {
  console.log(JSON.stringify({ now: new Date(NOW).toISOString(), count: shown.length, items: shown.map((x) => ({ status: x.status, sentence: x.sentence, who: x.who, at: new Date(x.at).toISOString(), bank: x.bank, doc: x.docId, tags: x.tags })) }, null, 2))
  process.exit(0)
}

const line = (x) => `- [${x.status}] ${x.sentence}  ← ${x.who || '(整段)'} ${dayKey(x.at)} · ${x.bank}`
console.log(`# 到期承诺账（只读）· 今天 ${dayKey(NOW)}`)
console.log(`扫到 ${items.length} 条像承诺的话，该被追的 ${items.filter((x) => rank(x) <= 1).length} 条${showAll ? '（--all 全列）' : ''}。\n`)

const expired = shown.filter((x) => rank(x) === 0)
const future = shown.filter((x) => rank(x) === 1)
if (expired.length) {
  console.log('## 已经到期，该提了')
  for (const x of expired) console.log(line(x))
  console.log('')
}
if (future.length) {
  console.log('## 还没到')
  for (const x of future) console.log(line(x))
  console.log('')
}
if (showAll) {
  const unknown = items.filter((x) => rank(x) === 2)
  if (unknown.length) {
    console.log('## 像承诺但推不出日子（要人看一眼）')
    for (const x of unknown.slice(0, 40)) console.log(line(x))
    if (unknown.length > 40) console.log(`- ……还有 ${unknown.length - 40} 条`)
  }
}
