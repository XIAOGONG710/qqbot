#!/usr/bin/env node
// 时间差回放：把某一刻之前/之后的原话切成「现场」，让桌面这边分两次读。
// 第一次只给 before（不知道后来怎么了），第二次才给 after。只读，不改任何记忆文件。
//
// 用法：
//   node scripts/her-moment-replay.mjs --at "2026-11-02T02:07"
//   node scripts/her-moment-replay.mjs --at "2026-11-02T02:07" --after-only --span 1440
//   node scripts/her-moment-replay.mjs --at "2026-11-02T02:07" --bank linmengyao --before 180
//
// 参数：
//   --at      那一刻，本地时间（Asia/Shanghai），YYYY-MM-DDTHH:mm
//   --before  before 模式往前取多少分钟，默认 180
//   --span    after 模式往后取多少分钟，默认 1440
//   --bank    bank 名或 jsonl 路径，可重复；默认读 owner-bank.json 里他的 bank
//   --after-only 只打「后来」
//   --json    输出 JSON（events 数组）
//
// 记忆来源：runtime/her-memory-dsh/<bank>.jsonl（scripts/her-memory-sync.mjs 落盘的只读副本）

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = path.join(ROOT, 'runtime', 'her-memory-dsh')
const TZ = '+08:00'

function arg(name, fallback = undefined) {
  const hit = process.argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`))
  if (!hit) return fallback
  if (hit.includes('=')) return hit.slice(hit.indexOf('=') + 1)
  const next = process.argv[process.argv.indexOf(hit) + 1]
  return next && !next.startsWith('--') ? next : true
}

const atRaw = arg('at')
if (!atRaw || atRaw === true) {
  console.error('需要 --at "YYYY-MM-DDTHH:mm"（本地时间）')
  process.exit(2)
}
const at = parseLocal(String(atRaw))
if (Number.isNaN(at)) {
  console.error(`看不懂 --at：${atRaw}`)
  process.exit(2)
}
const beforeMin = Number(arg('before', 180))
const spanMin = Number(arg('span', 1440))
const afterOnly = Boolean(arg('after-only', false))
const asJson = Boolean(arg('json', false))

function parseLocal(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(s.trim())
  if (!m) return NaN
  const [, y, mo, d, h, mi] = m
  return Date.parse(`${y}-${mo}-${d}T${String(h).padStart(2, '0')}:${mi}:00${TZ}`)
}

function fmtLocal(ms) {
  const d = new Date(ms + 8 * 3600 * 1000)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
}

function ownerBankFromFile() {
  const files = [
    process.env.QQBOT_OWNER_BANK_FILE,
    path.join(ROOT, 'runtime', 'bot-shadow', 'memory', 'owner-bank.json'),
    path.join(ROOT, 'runtime', 'bot', 'memory', 'owner-bank.json'),
  ].filter(Boolean)
  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof data.ownerBank === 'string' && data.ownerBank) return data.ownerBank
    } catch {}
  }
  return 'linmengyao'
}

function resolveSources() {
  const raw = []
  const pushAll = (v) => { if (v && v !== true) raw.push(String(v)) }
  for (let i = 0; i < process.argv.length; i++) {
    const a = process.argv[i]
    if (a === '--bank') pushAll(process.argv[i + 1])
    else if (a.startsWith('--bank=')) pushAll(a.slice(7))
  }
  const wanted = raw.length ? raw : [ownerBankFromFile()]
  return wanted.map((item) => {
    if (item.endsWith('.jsonl') || item.includes('/') || item.includes('\\')) {
      return { bank: path.basename(item, '.jsonl'), file: path.resolve(ROOT, item) }
    }
    return { bank: item, file: path.join(OUT_DIR, `${item}.jsonl`) }
  })
}

const HEADER = /^——\s*(\d{4})年(\d{1,2})月(\d{1,2})日/
const SAY = /^([^\s(（][^()（）]{0,12})\s*[(（](\d{1,2}):(\d{2})[)）]\s*:?\s*(.*)$/

/** 把一份 jsonl 拆成逐条事件：{ at, who, text, bank, docId } */
function readEvents({ bank, file }) {
  if (!fs.existsSync(file)) return []
  const events = []
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    let doc
    try { doc = JSON.parse(line) } catch { continue }
    const text = String(doc.text || '')
    let dateStr = null
    let current = null
    for (const raw of text.split('\n')) {
      const l = raw.trim()
      if (!l) continue
      const h = HEADER.exec(l)
      if (h) {
        dateStr = `${h[1]}-${String(h[2]).padStart(2, '0')}-${String(h[3]).padStart(2, '0')}`
        continue
      }
      const s = SAY.exec(l)
      if (s && dateStr) {
        const dt = Date.parse(`${dateStr}T${String(s[2]).padStart(2, '0')}:${s[3]}:00${TZ}`)
        current = { at: dt, who: s[1].trim(), text: s[4].trim(), bank, docId: doc.id, tags: doc.tags }
        events.push(current)
        continue
      }
      if (current) current.text += `\n${l}`
      else if (dateStr) {
        const dt = Date.parse(`${dateStr}T00:00:00${TZ}`)
        current = { at: dt, who: '(整段)', text: l, bank, docId: doc.id, tags: doc.tags }
        events.push(current)
      }
    }
  }
  return events
}

const sources = resolveSources()
const all = sources.flatMap(readEvents).filter((e) => Number.isFinite(e.at))
all.sort((a, b) => a.at - b.at)

const from = afterOnly ? at : at - beforeMin * 60000
const to = afterOnly ? at + spanMin * 60000 : at
const picked = all.filter((e) => (afterOnly ? e.at > at && e.at <= to : e.at >= from && e.at <= to))

if (asJson) {
  console.log(JSON.stringify({ at: fmtLocal(at), mode: afterOnly ? 'after' : 'before', events: picked.map((e) => ({ at: fmtLocal(e.at), who: e.who, text: e.text, doc: e.docId })) }, null, 2))
  process.exit(0)
}

const out = []
if (afterOnly) {
  out.push(`# 后来：${fmtLocal(at)} 之后 ${spanMin} 分钟`)
  out.push('现场那一轮没给这段。这是同一件事后来变成什么样。')
} else {
  out.push(`# 现场：${fmtLocal(at)}（北京时间）`)
  out.push(`只到这一刻为止，之后的事一个字都没放进来。往前 ${beforeMin} 分钟的原话：`)
}
out.push('')
let lastDay = ''
for (const e of picked) {
  const day = fmtLocal(e.at).slice(0, 10)
  if (day !== lastDay) { out.push(`— ${day} —`); lastDay = day }
  out.push(`${e.who} ${fmtLocal(e.at).slice(11)}: ${e.text}`)
}
if (!picked.length) out.push('（这段窗口里没有原话）')
if (!afterOnly) {
  out.push('')
  out.push('停在这里。接下来的话由我自己说，不参考后面发生了什么。')
}
console.log(out.join('\n'))
