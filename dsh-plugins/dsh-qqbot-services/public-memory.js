// 公共记忆面板：只读 Hindsight 里的公共库，给面板一张能追溯来源的列表和关系图。
//
// 边界（计划第 3 批、ADR 0176）：只认 owner-bank.json 里公布的公共库（名字以 -common 结尾），
// 不碰他的私有库、不碰其他联系人的库；只发 GET 和一次 recall，不写任何东西；
// 返回给页面的是投影，不是 Hindsight 的原始响应——原始字段、错误正文、库名都不外传。
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activeKoishiPlugin, configuredManualOwner } from './chat.js'

const BANK = /^[a-zA-Z0-9_-]{1,80}-common$/
const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]']
/** 一页默认几条；最多留 60 条（每页 12 条时 5 页），面板不用翻完整个库 */
export const PAGE_LIMIT = 8
const MAX_LIMIT = 12
const MAX_PAGE = 5
const MAX_ITEMS = MAX_LIMIT * MAX_PAGE
const CACHE_MS = 30_000
const CACHE_SIZE = 8
const TEXT_MAX = 320
const ENTITY_MAX = 6
const EDGE_MAX = 40
/** 收回/撤回的标记：命中就不给正文，只留位置和时间 */
const WITHDRAWN = ['recalled', 'retracted', 'withdrawn', 'forgotten']
const CERTAINTY = { world: 'stated', experience: 'stated', observation: 'inferred', opinion: 'inferred' }

const clean = (value, max) => typeof value === 'string'
  ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const iso = value => typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : null

/**
 * @param {object} options
 * @param {string} options.root 仓库根
 * @param {() => any} options.readConfig 读 Koishi 配置
 * @param {string} [options.hindsightUrl]
 * @param {typeof fetch} [options.fetcher]
 * @param {() => Date} [options.now]
 * @param {number} [options.timeoutMs]
 */
export function createPublicMemory({ root, readConfig, hindsightUrl, fetcher = fetch, now = () => new Date(), timeoutMs = 6000 }) {
  const load = file => import(pathToFileURL(join(root, file)).href)
  const cache = new Map()

  function base() {
    const url = new URL(hindsightUrl || 'http://127.0.0.1:8899')
    if (url.protocol !== 'http:' || !LOOPBACK.includes(url.hostname) || url.username || url.password) return null
    return url
  }

  /** 公共库名：只来自已公布的 owner-bank，且必须是 -common */
  async function commonBank() {
    const plugin = activeKoishiPlugin(readConfig())
    const owner = configuredManualOwner(readConfig())
    if (!plugin || !owner) return null
    const { readOwnerBank } = await load('packages/bot/src/memory/owner-bank.ts')
    const published = readOwnerBank(join(resolve(root, plugin.dataDir || 'runtime/bot'), 'memory'))
    const name = published?.commonBank
    return typeof name === 'string' && BANK.test(name) ? name : null
  }

  async function recall(bank, query, url) {
    const response = await fetcher(new URL(`/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, url), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        query,
        types: ['world', 'experience', 'observation'],
        prefer_observations: true,
        budget: 'low',
        max_tokens: 900,
        query_timestamp: now().toISOString(),
        tags: ['qq-private'],
        tags_match: 'all_strict',
        include: { entities: { max_tokens: 200 }, source_facts: { max_tokens: 400 } },
      }),
      signal: AbortSignal.timeout(Math.min(8000, Math.max(500, timeoutMs))),
      redirect: 'error',
    })
    if (!response.ok) throw Error('memory_unavailable')
    const body = await response.json()
    // 真实 Hindsight 回 { results: [...] }；也认直接给数组的老形状，别的一律当不可用。
    const rows = Array.isArray(body) ? body : Array.isArray(body?.results) ? body.results : null
    if (!rows) throw Error('memory_unavailable')
    return rows
  }

  /** 一条 Hindsight 结果 → 面板能看的东西；命中的词留在库里，只给摘要和来源 */
  function project(row) {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string' || !row.id) return null
    const tags = Array.isArray(row.tags) ? row.tags.filter(tag => typeof tag === 'string') : []
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : {}
    const withdrawn = WITHDRAWN.some(mark => tags.includes(mark) || metadata[mark] === 'true')
    const type = typeof row.type === 'string' && row.type in CERTAINTY ? row.type : null
    const start = iso(row.occurred_start)
    const end = iso(row.occurred_end)
    const mentioned = iso(row.mentioned_at)
    return {
      id: clean(row.id, 64),
      /** 已收回的只给一句话，正文不出去 */
      text: withdrawn ? null : clean(row.text, TEXT_MAX),
      withdrawn,
      /** stated=库里直接写的，inferred=整合/推断出来的，unknown=类型不明 */
      certainty: withdrawn ? 'unknown' : (type ? CERTAINTY[type] : 'unknown'),
      /** dated=知道事情发生在什么时候；undated=只有写过的时间，或者什么都没有 */
      when: { start, end, mentioned, dated: Boolean(start || end) },
      /** 来源：写进库的那份文档；没有就明说不知道从哪来 */
      source: typeof row.document_id === 'string' && row.document_id ? { document: clean(row.document_id, 80) } : null,
      entities: Array.isArray(row.entities) ? row.entities.map(item => clean(item, 24)).filter(Boolean).slice(0, ENTITY_MAX) : [],
    }
  }

  function paged(query) {
    const hit = cache.get(query)
    return hit && now().getTime() - hit.at < CACHE_MS ? hit.items : null
  }

  async function search(rawQuery, rawPage, rawLimit) {
    const query = clean(rawQuery, 120)
    if (!query) return { linked: true, page: 1, limit: PAGE_LIMIT, total: 0, items: [], cached: false }
    const limit = Number.isSafeInteger(rawLimit) && rawLimit >= 1 && rawLimit <= MAX_LIMIT ? rawLimit : PAGE_LIMIT
    // 页数上限跟着每页条数走：面板每页 8 条时 60 条是 8 页，原来只认到第 5 页，第 6–8 页悄悄回第 1 页（审查第 13 条）
    const page = Number.isSafeInteger(rawPage) && rawPage >= 1 && rawPage <= Math.ceil(MAX_ITEMS / limit) ? rawPage : 1
    let rows = paged(query)
    const cached = rows !== null
    if (!rows) {
      const url = base()
      if (!url) return { linked: false, page, limit, total: 0, items: [], cached: false }
      const bank = await commonBank()
      if (!bank) return { linked: false, page, limit, total: 0, items: [], cached: false }
      const raw = await recall(bank, query, url)
      rows = raw.map(project).filter(Boolean).slice(0, MAX_ITEMS)
      cache.delete(query)
      if (cache.size >= CACHE_SIZE) cache.delete(cache.keys().next().value)
      cache.set(query, { at: now().getTime(), items: rows })
    }
    const start = (page - 1) * limit
    return {
      linked: true,
      page,
      limit,
      total: rows.length,
      items: rows.slice(start, start + limit),
      /** 这一页是不是复用上次召回的结果（避免翻页重复打 Hindsight） */
      cached,
    }
  }

  return {
    search,
    /** 关系图的节点和边：节点是公共库里提过的人/事，边是同一条记忆里一起出现的关系 */
    async graph(query) {
      const items = await search(query, 1, MAX_LIMIT)
      if (!items.linked) return { linked: false, nodes: [], edges: [], memories: 0 }
      if (!items.items.length) return { linked: true, nodes: [], edges: [], memories: 0 }
      const nodes = new Map()
      const edges = new Map()
      for (const item of items.items) {
        for (const name of item.entities) {
          const node = nodes.get(name) ?? { name, memories: 0, certainty: 'unknown' }
          node.memories += 1
          if (item.certainty !== 'unknown' && node.certainty === 'unknown') node.certainty = item.certainty
          nodes.set(name, node)
        }
        for (let i = 0; i < item.entities.length; i += 1) {
          for (let j = i + 1; j < item.entities.length; j += 1) {
            const [from, to] = item.entities[i] < item.entities[j] ? [item.entities[i], item.entities[j]] : [item.entities[j], item.entities[i]]
            const key = `${from}\u0000${to}`
            const edge = edges.get(key) ?? { from, to, memories: [] }
            if (!edge.memories.includes(item.id)) edge.memories.push(item.id)
            edges.set(key, edge)
          }
        }
      }
      return {
        linked: true,
        memories: items.items.length,
        nodes: [...nodes.values()].sort((a, b) => b.memories - a.memories).slice(0, 60),
        edges: [...edges.values()].slice(0, EDGE_MAX).map(edge => ({ ...edge, memories: edge.memories.slice(0, 6) })),
      }
    },
  }
}
