// 从 DSH 会话文件里把「实际发给模型的那份系统提示」抠出来。
// 用法：node scripts/dsh/dump-system-prompt.mjs <会话目录或 .zstd 文件> [--keys|--out 文件]
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const target = process.argv[2]
if (!target) {
  console.error('用法：node scripts/dsh/dump-system-prompt.mjs <会话目录|session.v4.jsonl.zstd> [--keys] [--out 文件]')
  process.exit(2)
}
const file = fs.statSync(target).isDirectory()
  ? path.join(target, fs.readdirSync(target).find(n => n.endsWith('.zstd')))
  : target
const buf = fs.readFileSync(file)
const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offs = []
let i = 0
while ((i = buf.indexOf(magic, i)) !== -1) { offs.push(i); i += 4 }
const parts = []
for (let k = 0; k < offs.length; k += 1) {
  const s = offs[k]
  const e = k + 1 < offs.length ? offs[k + 1] : buf.length
  try { parts.push(zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8')) } catch {}
}
const events = parts.join('').split('\n').filter(Boolean)
  .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)

const wantKeys = process.argv.includes('--keys')
const outIdx = process.argv.indexOf('--out')
const outFile = outIdx > 0 ? process.argv[outIdx + 1] : ''

// 系统提示在这几个地方出现：request/header 的 header.system / request 里的 messages[0]
let system = ''
const sources = []
for (const ev of events) {
  const d = ev.data ?? ev
  if (ev.type === 'request/header') {
    const h = d.header ?? d
    if (wantKeys) console.log('request/header keys:', Object.keys(h).join(', '))
    for (const k of ['system', 'systemPrompt', 'instructions', 'prompt']) {
      if (typeof h[k] === 'string' && h[k].length > system.length) { system = h[k]; sources.push(`request/header.${k}`) }
    }
  }
  if (ev.type === 'request' || ev.type === 'request/messages') {
    const msgs = d.messages ?? d.request?.messages ?? []
    if (wantKeys) console.log('request keys:', Object.keys(d).join(', '), '| messages', msgs.length)
    const sys = msgs.filter(m => m && m.role === 'system').map(m => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n')
    if (sys.length > system.length) { system = sys; sources.push(`${ev.type}.messages[system]`) }
  }
}

if (!system) {
  console.error('没找到系统提示；可加 --keys 看事件结构。事件类型：', [...new Set(events.map(e => e.type))].join(', '))
  process.exit(1)
}
console.log(`# 来源：${sources.at(-1)}｜长度 ${system.length} 字符`)
if (outFile) { fs.writeFileSync(outFile, system, 'utf8'); console.log(`已写入 ${outFile}`) }
else console.log(system)
