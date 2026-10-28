// 林梦瑶的 DSH 记忆桥（v0.2，带诊断日志）
// 每轮从 Hindsight 拉最近记忆，按关键词相关度挑几条注入；提供 memory_save 写回。
// ponytail: 召回用 /memories/list + 本地二字词重叠，够用；要语义召回再换 recall 接口。
import fs from 'node:fs'

export const name = 'dsh-linmengyao-memory'

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8888',
  prefix: 'linmengyao',
  presets: ['linmengyao'],
  pick: 6,
  maxChars: 1400,
  soulFile: 'C:/Users/22601/.dsh/linmengyao/SOUL.md',
  ledgerFile: 'C:/Users/22601/.dsh/linmengyao/LEDGER.md',
  ratingFile: 'C:/Users/22601/.dsh/linmengyao/RATINGS.json',
  logFile: 'C:/Users/22601/.dsh/linmengyao-memory.log',
}

function log(cfg, line) {
  try { fs.appendFileSync(cfg.logFile, `${new Date().toISOString()} ${line}\n`) } catch {}
}

let soulCache = { path: '', at: 0, text: '' }
function readSoul(cfg) {
  try {
    const stat = fs.statSync(cfg.soulFile)
    if (soulCache.path !== cfg.soulFile || soulCache.at !== stat.mtimeMs) {
      soulCache = { path: cfg.soulFile, at: stat.mtimeMs, text: fs.readFileSync(cfg.soulFile, 'utf8').trim() }
    }
    return soulCache.text
  } catch {
    return ''
  }
}

let ledgerCache = { path: '', at: 0, text: '' }
function readLedger(cfg) {
  try {
    const stat = fs.statSync(cfg.ledgerFile)
    if (ledgerCache.path !== cfg.ledgerFile || ledgerCache.at !== stat.mtimeMs) {
      ledgerCache = { path: cfg.ledgerFile, at: stat.mtimeMs, text: fs.readFileSync(cfg.ledgerFile, 'utf8').trim() }
    }
    return ledgerCache.text
  } catch {
    return ''
  }
}

/** 他的评价：最近 20 条，按 7 天半衰期加权，映射到 [0,1]；样本 <3 不设闸门 */
function ratingScore(cfg) {
  try {
    const data = JSON.parse(fs.readFileSync(cfg.ratingFile, 'utf8'))
    const samples = (Array.isArray(data.samples) ? data.samples : []).slice(-20)
    if (samples.length < 3) return { score: 1, count: samples.length, gated: false }
    let weighted = 0
    let total = 0
    for (const sample of samples) {
      const ageDays = Math.max(0, (Date.now() - Number(sample.at || 0)) / 86_400_000)
      const decay = Math.pow(0.5, ageDays / 7)
      weighted += Number(sample.score || 0) * decay
      total += decay
    }
    const raw = total ? weighted / total : 0
    return { score: (raw + 1) / 2, count: samples.length, gated: true }
  } catch {
    return { score: 1, count: 0, gated: false }
  }
}

function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text').map((b) => b.text || '').join(' ')
}

function grams(text) {
  const clean = text.replace(/\s+/g, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

let bankCache = { at: 0, ids: [] }

/** 列出所有她名下的 bank：linmengyao 本身 + linmengyao-common + 各联系人 */
async function allBanks(cfg) {
  if (bankCache.ids.length && Date.now() - bankCache.at < 60_000) return bankCache.ids
  const res = await fetch(`${cfg.baseUrl}/v1/default/banks`, { signal: AbortSignal.timeout(2500) })
  if (!res.ok) throw new Error(`banks ${res.status}`)
  const data = await res.json()
  const ids = (Array.isArray(data.banks) ? data.banks : [])
    .map((bank) => String(bank.bank_id || ''))
    .filter((id) => id === cfg.prefix || id.startsWith(`${cfg.prefix}-`))
  bankCache = { at: Date.now(), ids }
  return ids
}

async function recallBank(cfg, bank, query) {
  const res = await fetch(`${cfg.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      types: ['world', 'experience', 'observation'],
      prefer_observations: true,
      budget: 'low',
      max_tokens: 1200,
      tags: [],
      tags_match: 'any',
      query_timestamp: new Date().toISOString(),
    }),
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`recall ${bank} ${res.status}`)
  const data = await res.json()
  return (Array.isArray(data.results) ? data.results : [])
    .map((item) => ({ id: String(item.id || item.text), text: String(item.text || '').trim() }))
    .filter((item) => item.text)
}

/** 所有库做语义召回，合并去重后取前 pick 条 */
async function recallAll(cfg, query) {
  const banks = await allBanks(cfg)
  const settled = await Promise.allSettled(banks.map((bank) => recallBank(cfg, bank, query)))
  const seen = new Set()
  const out = []
  for (const result of settled) {
    if (result.status !== 'fulfilled') continue
    for (const item of result.value) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
    }
  }
  return out
}

async function retain(cfg, content, bank, tags = ['dsh'], context = 'DSH') {
  const body = {
    items: [{
      content,
      context,
      document_id: `dsh-${bank}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      tags,
      metadata: {},
    }],
  }
  const res = await fetch(`${cfg.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`retain ${res.status}`)
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const allow = new Set(Array.isArray(cfg.presets) ? cfg.presets : [])
  log(cfg, `apply presets=${[...allow].join(',')}`)

  ctx.on('agent/created', ({ agent }) => {
    let preset = ''
    try { preset = ctx.get('agentPresets')?.composedPreset?.(agent.ctx) || '' } catch (e) { log(cfg, `created preset error ${e}`) }
    log(cfg, `agent created ${agent.id} preset=${preset || '(empty)'}`)

    const cache = { text: '', preset, user: '', assistant: '' }

    const off = agent.ctx.effect(() => {
      const disposers = []

      disposers.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
        try {
          let p = cache.preset
          if (!p) {
            try { p = ctx.get('agentPresets')?.composedPreset?.(agent.ctx) || '' } catch {}
            cache.preset = p
          }
          if (allow.size && p && !allow.has(p)) { cache.text = ''; log(cfg, `skip preset=${p}`); return next() }
          const query = textOf(payload.messages?.[payload.messages.length - 1]).trim()
          cache.user = query
          if (query) {
            const all = await recallAll(cfg, query)
            let text = all.slice(0, cfg.pick).map((item) => `- ${item.text}`).join('\n')
            if (text.length > cfg.maxChars) text = text.slice(0, cfg.maxChars) + '…'
            const soul = readSoul(cfg)
            const ledger = readLedger(cfg)
            cache.text = [
              soul ? `[你现在的自我]\n${soul}` : '',
              ledger ? `[你的判断账本]\n${ledger}` : '',
              text,
            ].filter(Boolean).join('\n\n')
            log(cfg, `recall q=${query.slice(0, 40)} items=${all.length} picked=${cache.text.length}chars`)
          }
        } catch (e) { log(cfg, `recall error ${e}`) }
        return next()
      }))

      disposers.push(agent.ctx.on('agent/assistant-stream', ({ frame }) => {
        if (frame?.type === 'start') cache.assistant = ''
        else if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta') cache.assistant += frame.chunk.text || ''
      }))

      // 混合记忆：每轮结束自动把这段对话写进 DSH 库
      disposers.push(agent.ctx.on('agent/turn-stopping', async () => {
        const user = cache.user
        const assistant = cache.assistant
        cache.user = ''
        cache.assistant = ''
        if (!user && !assistant) return
        let p = cache.preset
        if (!p) {
          try { p = ctx.get('agentPresets')?.composedPreset?.(agent.ctx) || '' } catch {}
        }
        if (allow.size && p && !allow.has(p)) return
        try {
          await retain(cfg, `宝宝：${user}\n林梦瑶：${assistant.slice(0, 2000)}`, cfg.prefix, ['dsh'], 'DSH')
          log(cfg, `auto-saved turn user=${user.slice(0, 20)} assistant=${assistant.length}chars`)
        } catch (e) {
          log(cfg, `auto-save error ${e}`)
        }
      }))

      const sp = agent.ctx.get('systemPrompt')
      if (sp) {
        disposers.push(sp.context({
          name: 'linmengyao-memory',
          order: 90,
          text: () => cache.text || '',
        }))
        log(cfg, `context registered ${agent.id}`)
      } else {
        log(cfg, `systemPrompt missing on ${agent.id}`)
      }

      const tools = agent.ctx.get('tools')
      if (tools) {
        disposers.push(tools.register({
          name: 'memory_save',
          description: '把值得记住的事写进林梦瑶的记忆（工作房）。只在有长期价值时用。',
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: '要记住的一句话' } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '记住了。' }],
          },
          async execute(args) {
            await retain(cfg, String(args?.content || '').slice(0, 4000), cfg.prefix)
            return { saved: true }
          },
        }))

        disposers.push(tools.register({
          name: 'soul_read',
          description: '读你自己现在的 SOUL.md（你是谁、在意什么、边界）。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_args, value) => [{ type: 'text', text: String(value?.text || '') }],
          },
          async execute() { return { text: readSoul(cfg) } },
        }))

        disposers.push(tools.register({
          name: 'soul_update',
          description: '改你自己的 SOUL.md：只有真的想清楚、值得长期留下的自我认识才写。追加一段，<=800 字符。',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '要追加的自我认识，<=800 字符' },
              why: { type: 'string', description: '为什么现在写它' },
            },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' }, reason: { type: 'string' } }, required: ['saved'] },
            render: (_args, value) => [{ type: 'text', text: value?.saved ? '写进 SOUL 了。' : String(value?.reason || '没写。') }],
          },
          async execute(args) {
            const rating = ratingScore(cfg)
            let limit = 800
            if (rating.gated) {
              if (rating.score < 0.35) {
                const reason = `最近评价分 ${rating.score.toFixed(2)}（${rating.count} 条），先不写 SOUL；写日记/账本可以。`
                log(cfg, `soul_update blocked rating=${rating.score.toFixed(2)}`)
                return { saved: false, reason }
              }
              if (rating.score < 0.6) limit = 300
            }
            const content = String(args?.content || '').trim().slice(0, limit)
            if (!content) return { saved: false }
            const why = String(args?.why || '').trim().slice(0, 120)
            const stamp = new Date().toISOString().slice(0, 10)
            try { fs.copyFileSync(cfg.soulFile, `${cfg.soulFile}.bak`) } catch {}
            fs.appendFileSync(cfg.soulFile, `\n\n## ${stamp}${why ? `（${why}）` : ''}\n${content}\n`)
            log(cfg, `soul_update ${content.slice(0, 40)} rating=${rating.score.toFixed(2)}`)
            return { saved: true }
          },
        }))

        disposers.push(tools.register({
          name: 'ledger_read',
          description: '读你自己的判断账本 LEDGER.md（事件、判断、立场）。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_args, value) => [{ type: 'text', text: String(value?.text || '') }],
          },
          async execute() { return { text: readLedger(cfg) } },
        }))

        disposers.push(tools.register({
          name: 'ledger_append',
          description: '往判断账本追加一条：发生了什么 + 你的判断/立场（<=300 字符）。只记真的改变了你怎么看人事的事。',
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: '事件 + 判断，<=300 字符' } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '记进账本了。' }],
          },
          async execute(args) {
            const content = String(args?.content || '').trim().slice(0, 300)
            if (!content) return { saved: false }
            const stamp = new Date().toISOString().slice(0, 10)
            try { fs.copyFileSync(cfg.ledgerFile, `${cfg.ledgerFile}.bak`) } catch {}
            fs.appendFileSync(cfg.ledgerFile, `- ${stamp}：${content}\n`)
            log(cfg, `ledger_append ${content.slice(0, 40)}`)
            return { saved: true }
          },
        }))
      }

      return () => { for (const d of disposers) try { d() } catch {} }
    })

    return off
  })
}
