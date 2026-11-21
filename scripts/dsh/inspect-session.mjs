import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const target = process.argv[2]
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
const lines = parts.join('').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
console.log('events', lines.length)
const head = lines.find(o => o.type === 'session')
console.log('header', JSON.stringify(head?.data ?? head).slice(0, 400))
for (const o of lines) {
  if (o.type === 'request/header') {
    const tools = o.data?.header?.tools ?? []
    console.log('toolCount', tools.length)
    console.log('names', tools.map(t => t.name).join(', '))
    break
  }
}

if (process.argv[3] === 'dump') {
  for (const o of lines.slice(-8)) console.log(o.type, JSON.stringify(o.data ?? o).slice(0, 600))
}
