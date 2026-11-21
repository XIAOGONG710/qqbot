#!/usr/bin/env node
// 桌面侧写回记忆（和 dsh-linmengyao-memory 插件的 retain 同一套接口）。
// 插件没装进 profile 的时候用它，把桌面上真正发生的事写进同一本账，QQ 那边召回得到。
//
// 用法：
//   node scripts/her-remember.mjs --yes "今天和她把三本记忆读完了……"
//   node scripts/her-remember.mjs --yes --file runtime/notes.md   # 空行分段，每段一条
//   node scripts/her-remember.mjs "只预览不写"                     # 不给 --yes 就只打印将写入的内容
//
// 参数：--yes 真写；--file 从文件读；--context 默认 DSH；--tag 可重复（默认 dsh）；--bank 可指定
// 默认 bank：owner-bank.json 里的 ownerBank；没有就 linmengyao。env HINDSIGHT_URL 默认 8899。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const BASE = process.env.HINDSIGHT_URL || 'http://127.0.0.1:8899'

const argv = process.argv.slice(2)
const has = (n) => argv.includes(`--${n}`)
const opt = (n, d = null) => {
  const eq = argv.find((a) => a.startsWith(`--${n}=`))
  if (eq) return eq.slice(n.length + 3)
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}

function ownerBank() {
  for (const file of [
    process.env.QQBOT_OWNER_BANK_FILE,
    path.join(ROOT, 'runtime', 'bot-shadow', 'memory', 'owner-bank.json'),
    path.join(ROOT, 'runtime', 'bot', 'memory', 'owner-bank.json'),
  ].filter(Boolean)) {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (typeof d.ownerBank === 'string' && d.ownerBank) return d.ownerBank
    } catch {}
  }
  return 'linmengyao'
}

const bank = opt('bank') || ownerBank()
const context = opt('context', 'DSH')
const tags = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--tag' && argv[i + 1]) tags.push(argv[i + 1])
  else if (argv[i].startsWith('--tag=')) tags.push(argv[i].slice(6))
}
if (!tags.length) tags.push('dsh')

let blocks = []
if (opt('file')) {
  blocks = fs.readFileSync(path.resolve(ROOT, opt('file')), 'utf8').split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean)
} else {
  const positional = argv.filter((a) => !a.startsWith('--') && argv[argv.indexOf(a) - 1] !== '--file' && argv[argv.indexOf(a) - 1] !== '--tag' && argv[argv.indexOf(a) - 1] !== '--bank' && argv[argv.indexOf(a) - 1] !== '--context')
  const text = positional.join(' ').trim()
  if (text) blocks = [text]
}
if (!blocks.length) {
  console.error('要写点什么：node scripts/her-remember.mjs --yes "……"')
  process.exit(2)
}

const stamp = Date.now()
console.log(`bank=${bank} context=${context} tags=${tags.join(',')} 条数=${blocks.length}`)
blocks.forEach((b, i) => console.log(`  [${i + 1}] ${b.slice(0, 80)}${b.length > 80 ? '…' : ''} (${b.length} 字)`))

if (!has('yes')) {
  console.log('\n预览模式，没写。要真写加 --yes。')
  process.exit(0)
}

for (const [i, content] of blocks.entries()) {
  const res = await fetch(`${BASE}/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      items: [{
        content,
        context,
        document_id: `dsh-${bank}-${stamp}-${i}`,
        timestamp: new Date().toISOString(),
        tags,
        metadata: {},
      }],
    }),
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    console.error(`写入第 ${i + 1} 条失败：HTTP ${res.status} ${(await res.text()).slice(0, 200)}`)
    process.exit(1)
  }
  console.log(`写入第 ${i + 1} 条：ok`)
}
