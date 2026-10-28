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
            cache.text = text
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
      }

      return () => { for (const d of disposers) try { d() } catch {} }
    })

    return off
  })
}
