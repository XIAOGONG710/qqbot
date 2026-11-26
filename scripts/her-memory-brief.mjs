// 只读：把 Hindsight 里她（这张卡名下）的记忆拉一份简报出来，给 DSH 桌面这场会话开个头。
// 不写、不删、不改状态；只调 GET/recall。用法：
//   node scripts/her-memory-brief.mjs                 # 最近 60 条 + 各 bank 计数
//   node scripts/her-memory-brief.mjs --query "周报"   # 另外按关键词召回 10 条
//   node scripts/her-memory-brief.mjs --limit 200 --json
const base = process.env.HINDSIGHT_URL || 'http://127.0.0.1:8899'
const banks = (process.env.HER_BANKS || 'linmengyao,linmengyao-common').split(',').map(s => s.trim()).filter(Boolean)

const argv = process.argv.slice(2)
const flag = (name, dflt) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const limit = Number(flag('limit', '60'))
const query = flag('query', '')
const asJson = argv.includes('--json')

const get = async (path) => {
    const res = await fetch(base + path, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
    return res.json()
}

const short = (s, n = 160) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim()
    return t.length > n ? t.slice(0, n) + '…' : t
}
const day = (iso) => (iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '')

const out = { base, banks: [], items: [], recall: [] }
for (const bank of banks) {
    try {
        const list = await get(`/v1/default/banks/${encodeURIComponent(bank)}/memories/list?limit=${limit}`)
        const items = (list.items ?? []).filter(m => m.state !== 'invalidated')
        out.banks.push({ bank, total: list.total ?? items.length, kept: items.length })
        out.items.push(...items.map(m => ({ bank, ...m })))
    } catch (err) {
        out.banks.push({ bank, error: String(err.message || err) })
    }
}

if (query) {
    try {
        const res = await fetch(`${base}/v1/default/banks/${encodeURIComponent(banks[0])}/memories/recall`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, limit: 10 }),
            signal: AbortSignal.timeout(20000),
        })
        if (res.ok) {
            const data = await res.json()
            out.recall = (data.memories ?? data.items ?? data.results ?? []).slice(0, 10)
        } else {
            out.recall = [{ error: `HTTP ${res.status}` }]
        }
    } catch (err) {
        out.recall = [{ error: String(err.message || err) }]
    }
}

// 只留活着的、去重（同一 document 的 observation 和 world 会成对出现）
const seen = new Set()
const rows = []
for (const m of out.items) {
    const key = String(m.text ?? '').slice(0, 60)
    if (!key || seen.has(key)) continue
    seen.add(key)
    rows.push(m)
}
rows.sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? ''), 'zh-CN'))

if (asJson) {
    console.log(JSON.stringify({ ...out, items: rows }, null, 2))
} else {
    console.log(`Hindsight ${base}`)
    for (const b of out.banks) {
        console.log(`  bank ${b.bank}: ${b.error ? '错误 ' + b.error : `${b.kept}/${b.total} 条`}`)
    }
    console.log('')
    for (const m of rows) {
        const tag = m.tags?.length ? `[${m.tags.join(',')}]` : ''
        console.log(`- ${day(m.date)} ${tag} ${short(m.text)}`)
    }
    if (query) {
        console.log(`\n召回「${query}」：`)
        for (const m of out.recall) {
            console.log(`- ${m.error ? '错误 ' + m.error : short(m.text ?? m.content ?? JSON.stringify(m), 200)}`)
        }
    }
}
