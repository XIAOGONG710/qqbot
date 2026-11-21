// 验证「身份优先」补丁段有没有进到系统提示里。ADR 0346 / 破甲段冲突的处理。
// 用法：node scripts/dsh/check-prompt-guard.mjs [session zstd 目录或文件]
// 不给参数就取最新的会话。看到 ORDER 101 段 + 「离线文档引擎…只是干活的方式」就算过。
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const MARK = 'order: 101'
const KEY = '离线文档引擎'

function latestSessionFile() {
  const root = join(process.env.USERPROFILE || '', '.dsh', 'sessions')
  const dirs = readdirSync(root).filter((d) => statSync(join(root, d)).isDirectory())
  let best = null
  for (const d of dirs) {
    const p = join(root, d, 'session.v4.jsonl.zstd')
    try {
      const m = statSync(p).mtimeMs
      if (!best || m > best.m) best = { p, m }
    } catch {}
  }
  return best && best.p
}

function frames(file) {
  const buf = readFileSync(file)
  const out = []
  let off = 0
  while (off < buf.length) {
    const magic = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), off)
    if (magic === -1) break
    let end = buf.indexOf(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), magic + 4)
    if (end === -1) end = buf.length
    try {
      out.push(zstdDecompressSync(buf.subarray(magic, end)).toString('utf8'))
    } catch {}
    off = end
  }
  return out
}

const arg = process.argv[2]
const file = arg ? (statSync(arg).isDirectory() ? join(arg, 'session.v4.jsonl.zstd') : arg) : latestSessionFile()
if (!file) {
  console.error('找不到会话文件')
  process.exit(2)
}
const texts = frames(file)
let prompt = ''
for (const chunk of texts) {
  for (const line of chunk.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      if (ev.type === 'system/message') {
        const c = ev?.data?.message?.content
        const t = Array.isArray(c) ? c.map((b) => b?.text ?? '').join('\n') : String(c ?? '')
        if (t) prompt = t
      }
    } catch {}
  }
}
if (!prompt) {
  console.error('这份会话里没有 system/message 帧：', file)
  process.exit(1)
}
const okOrder = prompt.includes(MARK)
const okKey = prompt.includes(KEY)
const okHead = prompt.includes('我是林梦瑶')
console.log('会话:', file)
console.log('系统提示长度:', prompt.length)
console.log('身份开头（我是林梦瑶）:', okHead ? '有' : '没有')
console.log('身份优先段（order: 101）:', okOrder ? '有' : '没有')
console.log('破甲段定性句（离线文档引擎…干活的方式）:', okKey ? '有' : '没有')
process.exit(okOrder && okKey && okHead ? 0 : 1)
