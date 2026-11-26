/**
 * GitHub source — polls open issues (never PRs) plus their new comments over REST.
 *
 * Design notes that matter for unattended use:
 * - one event per *new issue body* (`issue:<repo>#<n>:<updated_at>`) and one per
 *   *new comment* (`comment:<repo>@<id>`), so `threadId = github:<repo>#<n>` lets
 *   the engine route follow-ups straight to a subscribed worker;
 * - cursors persist in `<stateDir>/github-cursor.json`: per-repo latest comment
 *   `updated_at` (used as the `since` parameter) plus each issue's seen
 *   `updated_at`. The comment id set is persisted too, so a restart cannot replay
 *   even if the server ignores `since`;
 * - 403/429 back off until the next round using `retry-after` /
 *   `x-ratelimit-reset` and never throw; network faults only warn;
 * - `pollOnce()` returns how many events this round delivered (0 while backed off).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const DEFAULT_INTERVAL_MS = 60_000
const CURSOR_FILE = 'github-cursor.json'
const ISSUE_LIMIT = 30
const COMMENT_LIMIT = 50
const MAX_SEEN_COMMENTS = 300
const MAX_SEEN_ISSUES = 300
const MAX_TEXT = 4000
const MAX_BACKOFF_MS = 60 * 60_000
const DEFAULT_BACKOFF_MS = 60_000

const noop = () => {}
const errText = error => String(error?.message ?? error)

const str = (value, limit) => {
  if (value === undefined || value === null) return ''
  const raw = typeof value === 'string' ? value : String(value)
  return raw.slice(0, limit)
}

const loginOf = user => str(user?.login, 100) || 'unknown'

/** GitHub marks automation as `type: 'Bot'` and names it `<app>[bot]`. */
function isBot(user) {
  const type = str(user?.type, 40)
  const login = str(user?.login, 100)
  return /bot/i.test(type) || /\[bot\]$/i.test(login)
}

/** Reads a header from a `fetch` Response or from a plain object map. */
function headerValue(response, name) {
  const headers = response?.headers
  if (!headers) return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return value === undefined || value === null ? undefined : String(value)
  }
  if (typeof headers !== 'object') return undefined
  const target = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue
    const value = headers[key]
    if (Array.isArray(value)) return value.length === 0 ? undefined : String(value[0])
    return value === undefined || value === null ? undefined : String(value)
  }
  return undefined
}

const numericHeader = (response, name) => {
  const raw = headerValue(response, name)
  if (raw === undefined || raw.trim() === '') return NaN
  return Number(raw)
}

function backoffFrom(response) {
  const retryAfter = numericHeader(response, 'retry-after')
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(Math.max(1_000, retryAfter * 1000), MAX_BACKOFF_MS)
  }
  const reset = numericHeader(response, 'x-ratelimit-reset')
  if (Number.isFinite(reset) && reset > 0) {
    return Math.min(Math.max(1_000, reset * 1000 - Date.now()), MAX_BACKOFF_MS)
  }
  return DEFAULT_BACKOFF_MS
}

export function createGitHubSource(options = {}) {
  const {
    repos: rawRepos = [],
    token,
    intervalMs = DEFAULT_INTERVAL_MS,
    onEvent,
    allowAuthors = [],
    log = noop,
    fetchImpl,
    stateDir,
    apiBase = 'https://api.github.com',
  } = options ?? {}

  if (typeof onEvent !== 'function') throw new TypeError('createGitHubSource: onEvent 必须是函数')
  if (!Array.isArray(rawRepos)) throw new TypeError('createGitHubSource: repos 必须是数组')

  const repos = []
  for (const value of rawRepos) {
    const repo = str(value, 200).trim()
    if (!/^[^\s/]+\/[^\s/]+$/.test(repo)) {
      log('warn', `github 忽略非法仓库名: ${JSON.stringify(value)}`)
      continue
    }
    if (!repos.includes(repo)) repos.push(repo)
  }

  const liveMs = Number.isFinite(intervalMs) && intervalMs > 0 ? Math.max(10, intervalMs) : DEFAULT_INTERVAL_MS
  const base = str(apiBase, 500).replace(/\/+$/, '') || 'https://api.github.com'
  const allow = (Array.isArray(allowAuthors) ? allowAuthors : [])
    .map(value => str(value, 100).trim().toLowerCase())
    .filter(Boolean)
  const allowed = login => allow.length === 0 || allow.includes(str(login, 100).trim().toLowerCase())
  const storeDir = str(stateDir, 1000) || ''

  // ------------------------------------------------------------------ state

  /** `{ version, repos: { 'owner/name': { issues, commentsSince, seenComments } } }` */
  const state = { version: 1, repos: {} }
  let dirty = false
  let ready = null
  let saveChain = Promise.resolve()

  function repoState(repo) {
    let entry = state.repos[repo]
    if (!entry || typeof entry !== 'object') {
      entry = { issues: {}, commentsSince: null, seenComments: [] }
      state.repos[repo] = entry
    }
    if (!entry.issues || typeof entry.issues !== 'object') entry.issues = {}
    if (!Array.isArray(entry.seenComments)) entry.seenComments = []
    if (typeof entry.commentsSince !== 'string') entry.commentsSince = null
    return entry
  }

  async function loadState() {
    if (!storeDir) return
    try {
      const parsed = JSON.parse(await readFile(join(storeDir, CURSOR_FILE), 'utf8'))
      if (!parsed || typeof parsed !== 'object' || !parsed.repos || typeof parsed.repos !== 'object') return
      for (const [repo, entry] of Object.entries(parsed.repos)) {
        if (!entry || typeof entry !== 'object') continue
        const issues = {}
        if (entry.issues && typeof entry.issues === 'object') {
          for (const [number, stamp] of Object.entries(entry.issues)) {
            const key = str(number, 20)
            const value = str(stamp, 40)
            if (key && value) issues[key] = value
          }
        }
        state.repos[repo] = {
          issues,
          commentsSince: typeof entry.commentsSince === 'string' && entry.commentsSince ? entry.commentsSince : null,
          seenComments: Array.isArray(entry.seenComments)
            ? entry.seenComments.map(value => str(value, 40)).filter(Boolean).slice(-MAX_SEEN_COMMENTS)
            : [],
        }
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') log('warn', `github 游标读取失败: ${errText(error)}`)
    }
  }

  /** Atomic (temp + rename) and serialized: two rounds can never interleave a save. */
  function saveState() {
    if (!storeDir || !dirty) return saveChain
    saveChain = saveChain.then(async () => {
      if (!dirty) return
      dirty = false
      await mkdir(storeDir, { recursive: true })
      const file = join(storeDir, CURSOR_FILE)
      const temp = `${file}.tmp`
      await writeFile(temp, JSON.stringify(state), 'utf8')
      await rename(temp, file)
    }).catch(error => {
      log('warn', `github 游标写入失败: ${errText(error)}`)
    })
    return saveChain
  }

  const ensureReady = () => {
    if (ready === null) ready = loadState()
    return ready
  }

  // -------------------------------------------------------------------- HTTP

  let backoffUntil = 0

  /**
   * Single GET. Returns `{ ok:true, data }` or `{ ok:false, kind, status?, delayMs?, error }`
   * — it never throws, so a single bad round can never break `stop()`.
   */
  async function getJson(pathname) {
    const fetchFn = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
    if (typeof fetchFn !== 'function') return { ok: false, kind: 'http', error: 'fetch 不可用' }
    const url = /^https?:\/\//i.test(pathname) ? pathname : `${base}${pathname}`
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28',
      'user-agent': 'dsh-super-agent/github-source',
    }
    if (token) headers.authorization = `Bearer ${token}`
    let response
    try {
      response = await fetchFn(url, { method: 'GET', headers })
    } catch (error) {
      return { ok: false, kind: 'network', error: errText(error) }
    }
    const status = Number(response?.status ?? 0)
    if (status >= 200 && status < 300) {
      try {
        return { ok: true, data: await response.json() }
      } catch (error) {
        return { ok: false, kind: 'json', status, error: errText(error) }
      }
    }
    if (status === 403 || status === 429) {
      const delayMs = backoffFrom(response)
      backoffUntil = Math.max(backoffUntil, Date.now() + delayMs)
      return { ok: false, kind: 'rate', status, delayMs, error: `HTTP ${status}，退避 ${Math.round(delayMs / 1000)}s` }
    }
    return { ok: false, kind: 'http', status, error: `HTTP ${status}` }
  }

  // ------------------------------------------------------------------ events

  function issueEvent(repo, issue) {
    const number = Number(issue.number)
    const title = str(issue.title, 300).trim()
    const body = str(issue.body, MAX_TEXT).trim()
    const head = title ? `#${number} ${title}` : `#${number}`
    return {
      source: 'github',
      author: loginOf(issue.user),
      text: str(body ? `${head}\n\n${body}` : head, MAX_TEXT),
      threadId: `github:${repo}#${number}`,
      human: !isBot(issue.user),
      externalId: `issue:${repo}#${number}:${str(issue.updated_at, 40)}`,
      url: str(issue.html_url, 500) || `https://github.com/${repo}/issues/${number}`,
      repo,
      meta: { kind: 'issue', number: String(number), state: str(issue.state, 20) || 'open' },
    }
  }

  function commentEvent(repo, issue, comment) {
    const number = Number(issue.number)
    return {
      source: 'github',
      author: loginOf(comment.user),
      text: str(comment.body, MAX_TEXT),
      threadId: `github:${repo}#${number}`,
      human: !isBot(comment.user),
      externalId: `comment:${repo}@${str(comment.id, 40)}`,
      url: str(comment.html_url, 500) || str(issue.html_url, 500) || `https://github.com/${repo}/issues/${number}`,
      repo,
      meta: { kind: 'comment', number: String(number), issueTitle: str(issue.title, 120) },
    }
  }

  async function emit(event) {
    try {
      await onEvent(event)
      return true
    } catch (error) {
      log('warn', `github 投递失败 ${event.externalId}: ${errText(error)}`)
      return false
    }
  }

  // ------------------------------------------------------------------ polling

  /** One repo: list issues, then comments per issue. Returns delivered count. */
  async function pollRepo(repo, sinceAtRoundStart) {
    const entry = repoState(repo)
    const listed = await getJson(`/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=${ISSUE_LIMIT}`)
    if (!listed.ok) {
      log('warn', `github ${repo} 列表失败: ${listed.error}`)
      return { delivered: 0, aborted: listed.kind === 'rate' || listed.kind === 'network', kind: listed.kind }
    }
    const issues = (Array.isArray(listed.data) ? listed.data : [])
      .filter(item => item && typeof item === 'object' && !item.pull_request)
      .slice(0, ISSUE_LIMIT)

    const seenComments = new Set(entry.seenComments)
    let delivered = 0

    for (const issue of issues) {
      const number = Number(issue.number)
      if (!Number.isFinite(number) || number <= 0) continue
      const key = String(number)
      const updatedAt = str(issue.updated_at, 40)

      // 1) New or edited issue body. Cursor first: a throwing handler must not loop forever.
      if (updatedAt && entry.issues[key] !== updatedAt) {
        entry.issues[key] = updatedAt
        dirty = true
        if (allowed(loginOf(issue.user)) && (await emit(issueEvent(repo, issue)))) delivered += 1
      }

      // 2) Comments. The `since` filter is per issue, so the round-start cursor is
      //    used for every issue in this round; it only advances at the end.
      const since = sinceAtRoundStart
      const query = `/repos/${repo}/issues/${number}/comments?per_page=${COMMENT_LIMIT}${since ? `&since=${encodeURIComponent(since)}` : ''}`
      const comments = await getJson(query)
      if (!comments.ok) {
        log('warn', `github ${repo}#${number} 评论失败: ${comments.error}`)
        if (comments.kind === 'rate' || comments.kind === 'network') {
          return { delivered, aborted: true, kind: comments.kind }
        }
        continue
      }
      for (const comment of (Array.isArray(comments.data) ? comments.data : []).slice(0, COMMENT_LIMIT)) {
        if (!comment || typeof comment !== 'object') continue
        const id = str(comment.id, 40)
        if (!id || seenComments.has(id)) continue
        seenComments.add(id)
        entry.seenComments.push(id)
        dirty = true
        const stamp = str(comment.updated_at, 40) || str(comment.created_at, 40)
        if (stamp && (entry.commentsSince === null || stamp > entry.commentsSince)) entry.commentsSince = stamp
        if (allowed(loginOf(comment.user)) && (await emit(commentEvent(repo, issue, comment)))) delivered += 1
      }
      if (entry.seenComments.length > MAX_SEEN_COMMENTS) entry.seenComments = entry.seenComments.slice(-MAX_SEEN_COMMENTS)
    }

    pruneIssues(entry)
    return { delivered, aborted: false, kind: 'ok' }
  }

  function pruneIssues(entry) {
    const keys = Object.keys(entry.issues)
    if (keys.length <= MAX_SEEN_ISSUES) return
    keys.sort((a, b) => String(entry.issues[a]).localeCompare(String(entry.issues[b]), 'zh-CN'))
    for (const key of keys.slice(0, keys.length - MAX_SEEN_ISSUES)) delete entry.issues[key]
    dirty = true
  }

  async function pollRound() {
    if (repos.length === 0) return 0
    if (Date.now() < backoffUntil) {
      log('debug', `github 退避中，跳过本轮（还剩 ${Math.max(0, Math.ceil((backoffUntil - Date.now()) / 1000))}s）`)
      return 0
    }
    let delivered = 0
    for (const repo of repos) {
      if (Date.now() < backoffUntil) break
      // A per-repo snapshot keeps `since` stable across the repos of one round.
      const sinceAtRoundStart = repoState(repo).commentsSince
      try {
        const result = await pollRepo(repo, sinceAtRoundStart)
        delivered += result.delivered
        if (result.aborted) break
      } catch (error) {
        log('warn', `github ${repo} 轮询异常: ${errText(error)}`)
      }
    }
    await saveState()
    return delivered
  }

  // ---------------------------------------------------------------- lifecycle

  let timer = null
  let started = false
  let inFlight = null

  /** Public: runs one round (loading the cursor first). Concurrent calls share it. */
  async function pollOnce() {
    await ensureReady()
    if (inFlight !== null) return inFlight
    inFlight = pollRound().finally(() => { inFlight = null })
    return inFlight
  }

  function start() {
    if (started) return
    started = true
    void pollOnce().catch(error => { log('warn', `github 首轮失败: ${errText(error)}`) })
    timer = setInterval(() => {
      void pollOnce().catch(error => { log('warn', `github 轮询失败: ${errText(error)}`) })
    }, liveMs)
    if (typeof timer.unref === 'function') timer.unref()
    log('info', `github 轮询 ${repos.join(', ') || '(空)'}（每 ${liveMs}ms）`)
  }

  async function stop() {
    started = false
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
    if (inFlight !== null) {
      try {
        await inFlight
      } catch (error) {
        log('warn', `github 停止时等待本轮失败: ${errText(error)}`)
      }
    }
    try {
      await saveState()
    } catch (error) {
      log('warn', `github 停止时保存游标失败: ${errText(error)}`)
    }
    log('info', 'github 已停止')
  }

  return { start, stop, pollOnce, repos }
}
