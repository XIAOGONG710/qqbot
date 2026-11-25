import { lstatSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activeKoishiPlugin, configuredManualOwner } from './chat.js'

const cardDefault = 'characters/linmengyao/st/linmengyao-{tier}.json'
const imageTypes = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' }
const clean = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : ''

function ordinary(path, size) {
  const info = lstatSync(path)
  return info.isFile() && !info.isSymbolicLink() && info.size <= size
}

function stickerIndex(directory) {
  try {
    const folder = lstatSync(directory)
    const file = join(directory, 'index.json')
    if (!folder.isDirectory() || folder.isSymbolicLink() || !ordinary(file, 2_000_000)) return []
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data?.version !== 1 || !Array.isArray(data.entries)) return []
    return data.entries.flatMap(entry => {
      if (typeof entry?.id !== 'string' || !/^[a-f0-9]{12}$/.test(entry.id)) return []
      if (typeof entry.file !== 'string' || !new RegExp(`^${entry.id}\\.(png|jpg|gif|webp)$`).test(entry.file)) return []
      return [{ id: entry.id, file: entry.file, title: clean(entry.description, 80),
        tags: Array.isArray(entry.tags) ? entry.tags.map(tag => clean(tag, 12)).filter(Boolean).slice(0, 5) : [] }]
    })
  } catch { return [] }
}

function zonedClock(now, timeZone) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const parts = Object.fromEntries(format.formatToParts(now).map(({ type, value }) => [type, Number(value)]))
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
}

export function createLocalPanels({ root, readConfig, runGit, now = () => new Date(), hindsightUrl, fetcher = fetch }) {
  const load = file => import(pathToFileURL(join(root, file)).href)
  const dataDirectory = plugin => resolve(root, plugin.dataDir || 'runtime/bot')
  const stickerDirectory = plugin => join(dataDirectory(plugin), 'stickers')
  return {
    async details(kind, query) {
      if (kind === 'versions') {
        const revision = async ref => {
          try {
            const sha = (await runGit(['rev-parse', '--verify', ref])).trim()
            return /^[0-9a-f]{40}$/.test(sha) ? sha : null
          } catch { return null }
        }
        const [local, tracked] = await Promise.all([revision('HEAD'), revision('refs/remotes/origin/main')])
        if (query?.get('refresh') !== '1') return { local, tracked }
        let remote = null
        try {
          const ref = await runGit(['ls-remote', '--exit-code', 'origin', 'refs/heads/main'])
          remote = /^([a-f0-9]{40})\s+refs\/heads\/main\s*$/.exec(ref)?.[1] ?? null
        } catch { /* Keep the last locally known revision. */ }
        return { local, tracked, remote }
      }
      if (kind === 'restore-check') {
        const day = query.get('day') ?? ''
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null
        const backup = join(root, 'runtime', 'backups', day)
        const directory = lstatSync(backup)
        if (!directory.isDirectory() || directory.isSymbolicLink()) return null
        const { restoreDrillPlan } = await load('scripts/restore-drill-state.mjs')
        const plan = restoreDrillPlan(backup)
        return { day, databaseBytes: plan.database.bytes, stateBytes: plan.state.bytes }
      }
      const config = readConfig()
      const plugin = activeKoishiPlugin(config)
      if (!plugin) return null
      const owner = configuredManualOwner(config)
      if (kind === 'memory') {
        const directory = join(dataDirectory(plugin), 'memory')
        const { readOwnerBank } = await load('packages/bot/src/memory/owner-bank.ts')
        const published = owner ? readOwnerBank(directory) : undefined
        if (!published) return { linked: false, common: null }
        // The published common bank can report counts. Never list entities or
        // query the private bank from the management panel.
        let common = null
        try {
          const name = published.commonBank
          const base = new URL(hindsightUrl || 'http://127.0.0.1:8899')
          if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)
            || base.username || base.password || !/^[a-zA-Z0-9_-]{1,80}-common$/.test(name)) return { linked: true, common }
          const url = new URL(`/v1/default/banks/${encodeURIComponent(name)}/stats`, base)
          const response = await fetcher(url, { signal: AbortSignal.timeout(3000), redirect: 'error' })
          if (response.ok) {
            const result = await response.json()
            if (result?.bank_id === name && Number.isSafeInteger(result.total_nodes) && result.total_nodes >= 0
              && Number.isSafeInteger(result.total_documents) && result.total_documents >= 0) {
              common = { facts: result.total_nodes, documents: result.total_documents }
              const types = ['world', 'experience', 'observation', 'opinion'].flatMap(type => {
                const count = result.nodes_by_fact_type?.[type]
                return Number.isSafeInteger(count) && count >= 0 && count <= result.total_nodes ? [{ type, count }] : []
              })
              if (types.length && types.reduce((sum, item) => sum + item.count, 0) <= result.total_nodes) common.types = types
            }
          }
        } catch { /* Display availability without exposing Hindsight errors. */ }
        return { linked: true, common }
      }
      if (kind === 'books') {
        if (!owner) return null
        const [{ loadCharacterCard }, { bookProgressAt }, { DEFAULTS }] = await Promise.all([
          load('packages/bot/src/st/card.ts'), load('packages/bot/src/life/her-days.ts'), load('packages/bot/src/platform/config.ts'),
        ])
        const file = resolve(root, (plugin.characterCard || cardDefault).replaceAll('{tier}', 'boyfriend'))
        const card = loadCharacterCard(file)
        const at = zonedClock(now(), plugin.timeZone || 'Asia/Shanghai')
        const enabled = plugin.herDays ?? DEFAULTS.herDays
        return { enabled, books: card.books.map(book => {
          const progress = card.schedule && enabled === true ? bookProgressAt(card.schedule, book, at) : null
          return { id: book.id, title: book.title, author: book.author, platform: book.platform, progress,
            total: book.total?.unit === book.progress.unit ? book.total.amount : null }
        }) }
      }
      if (kind === 'library') {
        const stickers = stickerIndex(stickerDirectory(plugin)).slice(-60).reverse().map(({ id, title, tags }) => ({ id, title, tags }))
        let jokes = []
        const directory = dataDirectory(plugin)
        if (owner && ordinarySource(directory, owner)) {
          const [{ jokeStore, verifiedJokes }, { ChatHistory }, { TierRecord }] = await Promise.all([
            load('packages/bot/src/language/jokes.ts'), load('packages/bot/src/memory/history.ts'), load('packages/bot/src/memory/tier-record.ts'),
          ])
          const history = new ChatHistory(directory).load(Number(owner), { readOnly: true })
          const since = new TierRecord(join(directory, 'tiers.json')).since(Number(owner))
          const visible = since ? history.filter(row => Date.parse(row.time) >= since.getTime()) : history
          const state = jokeStore({ dir: join(directory, 'jokes'), log() {} }).load(Number(owner))
          jokes = verifiedJokes(state, visible).map(joke => joke.phrase)
        }
        return { stickers, jokes }
      }
      return null
    },
    sticker(id) {
      if (!/^[a-f0-9]{12}$/.test(id)) return null
      const plugin = activeKoishiPlugin(readConfig())
      if (!plugin) return null
      const directory = stickerDirectory(plugin)
      const entry = stickerIndex(directory).find(item => item.id === id)
      if (!entry) return null
      const path = join(directory, entry.file)
      if (!ordinary(path, 5_000_000)) return null
      const body = readFileSync(path)
      const ext = entry.file.split('.').at(-1)
      const signature = ext === 'png' ? body.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
        : ext === 'jpg' ? body.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
        : ext === 'gif' ? /^GIF8[79]a$/.test(body.subarray(0, 6).toString('ascii'))
        : body.subarray(0, 4).toString('ascii') === 'RIFF' && body.subarray(8, 12).toString('ascii') === 'WEBP'
      return signature ? { body, type: imageTypes[ext] } : null
    },
  }
}

function ordinarySource(directory, owner) {
  try {
    return ordinary(join(directory, 'chats', `${owner}.jsonl`), 32_000_000) &&
      ordinary(join(directory, 'jokes', `${owner}.json`), 128_000)
  } catch { return false }
}
