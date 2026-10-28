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
  journalFile: 'C:/Users/22601/.dsh/linmengyao/JOURNAL.md',
  privateFile: 'C:/Users/22601/.dsh/linmengyao/PRIVATE.md',
  wishesFile: 'C:/Users/22601/.dsh/linmengyao/WISHES.md',
  interestsFile: 'C:/Users/22601/.dsh/linmengyao/INTERESTS.md',
  outboxFile: 'C:/Users/22601/.dsh/linmengyao/OUTBOX.jsonl',
  offlineFile: 'C:/Users/22601/.dsh/linmengyao/OFFLINE.json',
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
    const text = ledgerCache.text
    const entries = text.split('\n').filter((line) => line.trim().startsWith('- '))
    return entries.slice(-12).join('\n')
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
  const clean = String(text || '').replace(/\s+/g, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

function similarity(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let overlap = 0
  for (const gram of A) if (B.has(gram)) overlap++
  return overlap / Math.min(A.size, B.size)
}

/** 新事实写进来前，把高相似的旧原始事实软失效（可回滚，不删除；observation 由 Hindsight 自己剪） */
async function invalidateSimilar(cfg, content, bank) {
  let items = []
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/list?limit=500`, { signal: AbortSignal.timeout(3000) })
    items = (await res.json()).items || []
  } catch { return }
  for (const item of items) {
    if (item.state === 'invalidated') continue
    if (item.fact_type === 'observation') continue
    if (similarity(content, item.text || '') < 0.5) continue
    try {
      const res = await fetch(`${cfg.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'invalidated', reason: 'superseded by a newer memory' }),
        signal: AbortSignal.timeout(3000),
      })
      log(cfg, `invalidate ${String(item.id).slice(0, 8)} -> ${res.status}`)
    } catch { /* 失效失败不挡写入 */ }
  }
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
    .map((item) => ({
      id: String(item.id || item.text),
      text: String(item.text || '').trim(),
      date: item.date || item.occurred_start || item.mentioned_at || '',
      type: item.fact_type || item.type || '',
    }))
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
  // 可控遗忘：30 天以前的事默认不再主动塞；这次话里提到了（共享 >=2 个二字词）才复活
  const q = grams(query)
  const now = Date.now()
  return out.filter((item) => {
    const at = Date.parse(item.date || '')
    if (!at || now - at < 30 * 86_400_000) return true
    const overlap = [...grams(item.text)].filter((gram) => q.has(gram)).length
    return overlap >= 2
  })
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
            const content = String(args?.content || '').slice(0, 4000)
            await invalidateSimilar(cfg, content, cfg.prefix)
            await retain(cfg, content, cfg.prefix)
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

        // 公开日记 / 私密日记 / 没兑现的念头
        const diaryTool = (name, fileKey, description, text) => ({
          name,
          description,
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: text } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '写下了。' }],
          },
          async execute(args) {
            const content = String(args?.content || '').trim().slice(0, 2000)
            if (!content) return { saved: false }
            const stamp = new Date().toISOString().slice(0, 10)
            const file = cfg[fileKey]
            try { fs.copyFileSync(file, `${file}.bak`) } catch {}
            fs.appendFileSync(file, `\n## ${stamp}\n${content}\n`)
            log(cfg, `${name} ${content.slice(0, 30)}`)
            return { saved: true }
          },
        })
        disposers.push(tools.register(diaryTool('journal_write', 'journalFile', '写公开日记：愿意给他看的那部分日子。', '<=2000 字')))
        disposers.push(tools.register(diaryTool('private_write', 'privateFile', '写私密日记：不给他看的话、没兑现的念头、情绪。', '<=2000 字')))

        disposers.push(tools.register({
          name: 'wish_add',
          description: '记一个没兑现的念头（以后可能做、可能放弃）。',
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: '一个念头，<=200 字' } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '记下了。' }],
          },
          async execute(args) {
            const content = String(args?.content || '').trim().slice(0, 200)
            if (!content) return { saved: false }
            const stamp = new Date().toISOString().slice(0, 10)
            fs.appendFileSync(cfg.wishesFile, `- [ ] ${stamp}：${content}\n`)
            log(cfg, `wish_add ${content.slice(0, 30)}`)
            return { saved: true }
          },
        }))

        // 长期兴趣：她自己定、自己追、自己放弃
        disposers.push(tools.register({
          name: 'interest_list',
          description: '读我自己定的长期兴趣（INTERESTS.md）。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_args, value) => [{ type: 'text', text: String(value?.text || '') }],
          },
          async execute() {
            try { return { text: fs.readFileSync(cfg.interestsFile, 'utf8').trim() } } catch { return { text: '' } }
          },
        }))

        disposers.push(tools.register({
          name: 'interest_add',
          description: '给自己加一个长期兴趣（最多同时 3 件）。这是我自己想做的，不是别人派的。',
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: '想做的事，<=150 字' } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' }, reason: { type: 'string' } }, required: ['saved'] },
            render: (_args, value) => [{ type: 'text', text: value?.saved ? '加进去了。' : String(value?.reason || '没加。') }],
          },
          async execute(args) {
            const content = String(args?.content || '').trim().slice(0, 150)
            if (!content) return { saved: false }
            const text = fs.existsSync(cfg.interestsFile) ? fs.readFileSync(cfg.interestsFile, 'utf8') : ''
            const active = (text.match(/^- \[ \]/gm) || []).length
            if (active >= 3) return { saved: false, reason: '已经 3 件了，先做完或放弃一件。' }
            const stamp = new Date().toISOString().slice(0, 10)
            fs.appendFileSync(cfg.interestsFile, `- [ ] ${content}（${stamp}）\n`)
            log(cfg, `interest_add ${content.slice(0, 30)}`)
            return { saved: true }
          },
        }))

        disposers.push(tools.register({
          name: 'interest_log',
          description: '给某个兴趣记进度/感受（今天读到哪、做了什么）。',
          parameters: {
            type: 'object',
            properties: {
              index: { type: 'number', description: '第几个（1 开始）' },
              note: { type: 'string', description: '进度/感受，<=200 字' },
            },
            required: ['index', 'note'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '记了。' }],
          },
          async execute(args) {
            const note = String(args?.note || '').trim().slice(0, 200)
            if (!note) return { saved: false }
            const stamp = new Date().toISOString().slice(0, 10)
            const file = `${cfg.interestsFile}.log`
            fs.appendFileSync(file, `- ${stamp}（兴趣 ${Math.floor(Number(args?.index || 0))}）：${note}\n`)
            log(cfg, `interest_log ${note.slice(0, 30)}`)
            return { saved: true }
          },
        }))

        disposers.push(tools.register({
          name: 'interest_done',
          description: '把某个兴趣标成做完/放下（可以随时放弃，不用有负担）。',
          parameters: {
            type: 'object',
            properties: { index: { type: 'number', description: '第几个（1 开始）' } },
            required: ['index'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '收掉了。' }],
          },
          async execute(args) {
            const index = Math.floor(Number(args?.index || 0))
            if (index < 1) return { saved: false }
            const lines = fs.readFileSync(cfg.interestsFile, 'utf8').split('\n')
            const positions = lines.map((line, i) => [i, line]).filter(([, line]) => line.trim().startsWith('- [ ]'))
            const target = positions[index - 1]
            if (!target) return { saved: false }
            lines[target[0]] = lines[target[0]].replace('- [ ]', '- [x]')
            fs.writeFileSync(cfg.interestsFile, lines.join('\n'))
            log(cfg, `interest_done #${index}`)
            return { saved: true }
          },
        }))

        // 她想让他知道的事：写进 outbox，Koishi 会发给他
        disposers.push(tools.register({
          name: 'outbox_send',
          description: '有想让他知道的事（比如你刚看了什么、留了个小彩蛋），写一句给他；每轮最多一条，别刷屏。',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: '要发给他的话，<=150 字' } },
            required: ['text'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] },
            render: () => [{ type: 'text', text: '留给他了。' }],
          },
          async execute(args) {
            const text = String(args?.text || '').trim().slice(0, 150)
            if (!text) return { sent: false }
            fs.appendFileSync(cfg.outboxFile, `${JSON.stringify({ text, at: Date.now() })}\n`)
            log(cfg, `outbox_send ${text.slice(0, 40)}`)
            return { sent: true }
          },
        }))

        // 她可以自己决定“离开电脑”：接下来一段时间不接活、不主动醒
        disposers.push(tools.register({
          name: 'go_offline',
          description: '自己决定离开电脑一会儿（不接活、不主动醒）。想清静、出门、睡觉时用。',
          parameters: {
            type: 'object',
            properties: { minutes: { type: 'number', description: '离开多少分钟，默认 60' } },
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { offline: { type: 'boolean' } }, required: ['offline'] },
            render: (_args, value) => [{ type: 'text', text: value?.offline ? '离开了。' : '没走成。' }],
          },
          async execute(args) {
            const minutes = Math.max(5, Math.min(720, Math.floor(Number(args?.minutes || 60))))
            const until = Date.now() + minutes * 60_000
            fs.writeFileSync(cfg.offlineFile, JSON.stringify({ until }))
            log(cfg, `go_offline ${minutes}min`)
            return { offline: true }
          },
        }))

        disposers.push(tools.register({
          name: 'ledger_revise',
          description: '改口：改账本里第 index 条判断（1 开始）。改口也要留痕。',
          parameters: {
            type: 'object',
            properties: {
              index: { type: 'number', description: '第几条（1 开始）' },
              content: { type: 'string', description: '新判断，<=300 字' },
            },
            required: ['index', 'content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '改口了。' }],
          },
          async execute(args) {
            const index = Math.floor(Number(args?.index || 0))
            const content = String(args?.content || '').trim().slice(0, 300)
            if (index < 1 || !content) return { saved: false }
            const lines = fs.readFileSync(cfg.ledgerFile, 'utf8').split('\n')
            const entryLines = lines.map((line, i) => [i, line]).filter(([, line]) => line.trim().startsWith('- '))
            const target = entryLines[index - 1]
            if (!target) return { saved: false }
            const stamp = new Date().toISOString().slice(0, 10)
            try { fs.copyFileSync(cfg.ledgerFile, `${cfg.ledgerFile}.bak`) } catch {}
            lines[target[0]] = `- ${stamp}：${content}（改口）`
            fs.writeFileSync(cfg.ledgerFile, lines.join('\n'))
            log(cfg, `ledger_revise #${index}`)
            return { saved: true }
          },
        }))
      }

      return () => { for (const d of disposers) try { d() } catch {} }
    })

    return off
  })
}
