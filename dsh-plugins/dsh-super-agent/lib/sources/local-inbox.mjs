/**
 * Local inbox source — the offline, always-available trigger channel.
 *
 * A trigger file is one JSON object with at least `text`. Optional fields:
 * `source/author/threadId/human/externalId/url/repo/meta`. A delivered file is
 * renamed to `<name>.done.json`, an unparsable one to `<name>.failed.json`, so a
 * restart never replays a file it already handled and a human can see what broke.
 *
 * Idempotency has two layers: an in-memory `externalId` set (dedupes two files
 * that describe the same event) and the `.done.json` rename (persists that fact
 * across restarts). Everything is dependency-free and every timer can be stopped.
 */
import { mkdir, readdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_INTERVAL_MS = 2000
/** One scan never touches more than this many files, so a huge inbox cannot stall the loop. */
const MAX_FILES_PER_SCAN = 200
/** The dedupe set is bounded; the `.done.json` rename remains the durable record. */
const MAX_SEEN_IDS = 4000
const MAX_TEXT = 4000
const SUFFIX_JSON = '.json'
const SUFFIX_DONE = '.done.json'
const SUFFIX_FAILED = '.failed.json'

const noop = () => {}

const errText = error => String(error?.message ?? error)

const str = (value, limit) => {
  if (value === undefined || value === null) return ''
  const raw = typeof value === 'string' ? value : String(value)
  return raw.slice(0, limit)
}

/** `meta` is a flat string map: nested values are dropped instead of stringified into noise. */
function toMeta(value, extra) {
  const meta = { ...extra }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return meta
  let count = 0
  for (const [key, raw] of Object.entries(value)) {
    if (count >= 20) break
    if (raw === undefined || raw === null || typeof raw === 'object') continue
    meta[str(key, 40)] = str(raw, 200)
    count += 1
  }
  return meta
}

/** Only `<name>.json` files are candidates; done/failed files and dotfiles are history. */
function isCandidate(name) {
  const lower = name.toLowerCase()
  if (!lower.endsWith(SUFFIX_JSON)) return false
  if (lower.endsWith(SUFFIX_DONE) || lower.endsWith(SUFFIX_FAILED)) return false
  return !name.startsWith('.')
}

/** Builds one normalized TriggerEvent; every field is bounded and typed. */
function toEvent(raw, { externalId, file, name }) {
  const event = {
    source: str(raw.source, 24) || 'inbox',
    author: str(raw.author, 40) || 'inbox',
    text: str(raw.text, MAX_TEXT),
    human: raw.human !== false,
    externalId,
  }
  if (raw.threadId) event.threadId = str(raw.threadId, 80)
  if (raw.url) event.url = str(raw.url, 500)
  if (raw.repo) event.repo = str(raw.repo, 200)
  event.meta = toMeta(raw.meta, { file, name })
  return event
}

export function createInboxSource(options = {}) {
  const { dir, intervalMs = DEFAULT_INTERVAL_MS, onEvent, log = noop } = options ?? {}
  if (typeof dir !== 'string' || dir.trim() === '') throw new TypeError('createInboxSource: dir 必须是非空字符串')
  if (typeof onEvent !== 'function') throw new TypeError('createInboxSource: onEvent 必须是函数')
  const liveMs = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.max(10, intervalMs) : DEFAULT_INTERVAL_MS

  /** externalId -> true, insertion ordered so the oldest id can be evicted. */
  const seen = new Map()
  let timer = null
  let started = false
  /** Serializes scans: two ticks can never deliver the same file in flight. */
  let queue = Promise.resolve(0)
  let queued = false

  function remember(externalId) {
    if (seen.has(externalId)) return
    seen.set(externalId, true)
    if (seen.size <= MAX_SEEN_IDS) return
    const oldest = seen.keys().next()
    if (!oldest.done) seen.delete(oldest.value)
  }

  /**
   * Renames a processed file. A locked or colliding target retries with a numeric
   * infix instead of throwing: losing the evidence trail must not stop the source.
   */
  async function mark(file, name, kind) {
    const stem = name.slice(0, name.length - SUFFIX_JSON.length)
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const suffix = attempt === 0 ? '' : `.${attempt}`
      const target = join(dir, `${stem}${suffix}.${kind}.json`)
      try {
        await rename(file, target)
        return target
      } catch (error) {
        const code = String(error?.code ?? '')
        if (code === 'ENOENT') return null
        if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EEXIST' && code !== 'EBUSY') {
          log('warn', `inbox 重命名失败 ${name}: ${errText(error)}`)
          return null
        }
      }
    }
    log('warn', `inbox 无法重命名 ${name}（目标被占用）`)
    return null
  }

  /** One scan. Returns how many events were delivered. Never throws. */
  async function scanOnce() {
    let names
    try {
      await mkdir(dir, { recursive: true })
      names = await readdir(dir)
    } catch (error) {
      log('warn', `inbox 目录不可用 ${dir}: ${errText(error)}`)
      return 0
    }

    const candidates = names.filter(isCandidate).sort()
    if (candidates.length > MAX_FILES_PER_SCAN) {
      log('warn', `inbox 本轮只处理 ${MAX_FILES_PER_SCAN}/${candidates.length} 个文件，其余留到下一轮`)
    }

    let delivered = 0
    for (const name of candidates.slice(0, MAX_FILES_PER_SCAN)) {
      const file = join(dir, name)
      let raw
      try {
        raw = JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        log('warn', `inbox 解析失败 ${name}: ${errText(error)}`)
        await mark(file, name, 'failed')
        continue
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || str(raw.text, MAX_TEXT).trim() === '') {
        log('warn', `inbox 缺少 text，按失败处理: ${name}`)
        await mark(file, name, 'failed')
        continue
      }

      const externalId = str(raw.externalId, 200).trim() || `inbox:${name}`
      if (seen.has(externalId)) {
        // Filename layer: mark it done so a restart does not reconsider this file either.
        log('debug', `inbox 跳过重复事件 ${externalId}`)
        await mark(file, name, 'done')
        continue
      }

      try {
        await onEvent(toEvent(raw, { externalId, file, name }))
        remember(externalId)
        delivered += 1
      } catch (error) {
        log('warn', `inbox 投递失败 ${name}: ${errText(error)}`)
        await mark(file, name, 'failed')
        continue
      }
      await mark(file, name, 'done')
    }
    return delivered
  }

  /**
   * Appends a scan to the queue; callers may await it (used by `stop()`).
   * At most one scan is ever queued: a slow directory cannot grow the chain.
   */
  function schedule() {
    if (queued) return queue
    queued = true
    queue = queue.then(() => {
      if (!started) return 0
      return scanOnce()
    }).catch(error => {
      log('warn', `inbox 扫描异常: ${errText(error)}`)
      return 0
    }).finally(() => {
      queued = false
    })
    return queue
  }

  function start() {
    if (started) return
    started = true
    schedule()
    timer = setInterval(() => { schedule() }, liveMs)
    if (typeof timer.unref === 'function') timer.unref()
    log('info', `inbox 监听 ${dir}（每 ${liveMs}ms）`)
  }

  async function stop() {
    started = false
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    try {
      await queue
    } catch (error) {
      log('warn', `inbox 停止时等待扫描失败: ${errText(error)}`)
    }
    log('info', 'inbox 已停止')
  }

  // `scanOnce` is exposed for tests and for an explicit "drain now" command; the
  // documented surface remains `start()` / `stop()`.
  return { start, stop, scanOnce, dir }
}
