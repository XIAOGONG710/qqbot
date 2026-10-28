// 林梦瑶的 DSH 记忆桥（v0.2，带诊断日志）
// 每轮从 Hindsight 拉最近记忆，按关键词相关度挑几条注入；提供 memory_save 写回。
// ponytail: 召回用 /memories/list + 本地二字词重叠，够用；要语义召回再换 recall 接口。
import fs from 'node:fs'

export const name = 'dsh-linmengyao-memory'

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8888',
  chatBanks: ['linmengyao', 'linmengyao-common'],
  workBank: 'linmengyao-dsh',
  presets: ['linmengyao'],
  limit: 30,
  pick: 5,
  maxChars: 1200,
  logFile: 'C:/Users/22601/.dsh/linmengyao-memory.log',
}

function log(cfg, line) {
  try { fs.appendFileSync(cfg.logFile, `${new Date().toISOString()} ${line}\n`) } catch {}
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

async function fetchMemories(cfg, bank) {
  const url = `${cfg.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/list?limit=${cfg.limit}`
  const res = await fetch(url, { signal: AbortSignal.timeout(2500) })
  if (!res.ok) throw new Error(`list ${res.status}`)
  const data = await res.json()
  return Array.isArray(data.items) ? data.items : []
}

function pickRelevant(items, query, cfg) {
  const q = grams(query)
  const scored = []
  for (const item of items) {
    const text = String(item.text || '').trim()
    if (!text) continue
    let score = 0
    for (const g of grams(text)) if (q.has(g)) score++
    scored.push({ text, score })
  }
  scored.sort((a, b) => b.score - a.score)
  const top = scored.filter((x) => x.score > 0).slice(0, cfg.pick)
  const chosen = top.length ? top : scored.slice(0, 2)
  let text = chosen.map((x) => `- ${x.text}`).join('\n')
  if (text.length > cfg.maxChars) text = text.slice(0, cfg.maxChars) + '…'
  return text
}

async function retain(cfg, content, bank) {
  const body = {
    items: [{
      content,
      context: 'DSH 工作',
      document_id: `dsh-${bank}-${Date.now()}`,
      timestamp: new Date().toISOString(),
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

    const cache = { text: '', preset }

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
          if (query) {
            const banks = [...cfg.chatBanks, cfg.workBank]
            const results = await Promise.allSettled(banks.map((b) => fetchMemories(cfg, b)))
            const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
            cache.text = all.length ? pickRelevant(all, query, cfg) : ''
            log(cfg, `recall q=${query.slice(0, 40)} items=${all.length} picked=${cache.text.length}chars`)
          }
        } catch (e) { log(cfg, `recall error ${e}`) }
        return next()
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
            await retain(cfg, String(args?.content || '').slice(0, 4000), cfg.workBank)
            return { saved: true }
          },
        }))
      }

      return () => { for (const d of disposers) try { d() } catch {} }
    })

    return off
  })
}
