/**
 * Inbound webhook helpers: signature verification plus normalization into the
 * engine's TriggerEvent shape. Pure functions, no I/O, no timers — the HTTP
 * route that calls them stays in `index.js`.
 *
 * `verifySignature` must receive the *raw* body (the exact bytes GitHub sent).
 * Re-serializing parsed JSON changes the bytes and therefore the digest.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_TEXT = 4000
const ALGOS = new Set(['sha256', 'sha1'])
const CI_FAILURE_STATES = new Set(['failed', 'failure'])

const str = (value, limit) => {
  if (value === undefined || value === null) return ''
  const raw = typeof value === 'string' ? value : String(value)
  return raw.slice(0, limit)
}

const firstString = (...values) => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return ''
}

const toBuffer = body => {
  if (Buffer.isBuffer(body)) return body
  if (body instanceof Uint8Array) return Buffer.from(body)
  return Buffer.from(str(body, Number.MAX_SAFE_INTEGER) || String(body ?? ''), 'utf8')
}

/** Case-insensitive header lookup for Node's `req.headers` or undici's `Headers`. */
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return undefined
  if (typeof headers.get === 'function') {
    const value = headers.get(name)
    return value === undefined || value === null ? undefined : String(value)
  }
  const target = name.toLowerCase()
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== target) continue
    const value = headers[key]
    if (Array.isArray(value)) return value.length === 0 ? undefined : String(value[0])
    return value === undefined || value === null ? undefined : String(value)
  }
  return undefined
}

/** One object from an already-parsed `payload`, a JSON string, or the raw body. */
function resolvePayload({ body, payload }) {
  if (payload && typeof payload === 'object') return payload
  if (typeof payload === 'string' && payload.trim() !== '') {
    try {
      return JSON.parse(payload)
    } catch {
      return null
    }
  }
  if (typeof body === 'string' && body.trim() !== '') {
    try {
      return JSON.parse(body)
    } catch {
      return null
    }
  }
  if (Buffer.isBuffer(body) && body.length > 0) {
    try {
      return JSON.parse(body.toString('utf8'))
    } catch {
      return null
    }
  }
  return null
}

/** `owner/name` from the several shapes GitHub and generic CI payloads use. */
function repoOf(data) {
  const repository = data?.repository
  const fromParts = repository && repository.owner?.login && repository.name
    ? `${repository.owner.login}/${repository.name}`
    : ''
  return firstString(
    data?.repo?.full_name,
    fromParts,
    data?.repository?.full_name,
    data?.repository?.name,
    typeof data?.repo === 'string' ? data.repo : '',
    data?.project?.path_with_namespace,
  )
}

function isBot(user) {
  const type = str(user?.type, 40)
  const login = str(user?.login, 100)
  return /bot/i.test(type) || /\[bot\]$/i.test(login)
}

/**
 * GitHub-style HMAC check: `header` is `<algo>=<hex>` (a bare hex digest is also
 * accepted). Comparison is constant-time and a length mismatch short-circuits to
 * `false` — `timingSafeEqual` throws on unequal lengths, so never call it directly.
 */
export function verifySignature({ secret, body, header, algo = 'sha256' } = {}) {
  if (typeof secret !== 'string' || secret === '') return false
  if (typeof header !== 'string' || header.trim() === '') return false
  if (body === undefined || body === null) return false
  const algorithm = str(algo, 20).trim().toLowerCase()
  if (!ALGOS.has(algorithm)) return false

  const raw = header.trim()
  let provided = raw
  const separator = raw.indexOf('=')
  if (separator !== -1) {
    if (raw.slice(0, separator).trim().toLowerCase() !== algorithm) return false
    provided = raw.slice(separator + 1).trim()
  }
  if (provided === '' || !/^[0-9a-f]+$/i.test(provided)) return false

  const expected = createHmac(algorithm, secret).update(toBuffer(body)).digest('hex')
  const got = Buffer.from(provided.toLowerCase(), 'hex')
  const want = Buffer.from(expected, 'hex')
  if (got.length !== want.length) return false
  return timingSafeEqual(got, want)
}

/**
 * GitHub webhook → TriggerEvent.
 * - `issues` with action `opened`/`edited` (a PR payload also arrives as `issues`;
 *   the poller filters PRs, and this helper rejects them the same way);
 * - `issue_comment` with action `created`, bots ignored.
 * Anything else returns `null`.
 */
export function parseGitHubWebhook({ headers, body, payload } = {}) {
  const data = resolvePayload({ body, payload })
  if (!data || typeof data !== 'object') return null

  const event = str(headerValue(headers, 'x-github-event'), 40).trim() || str(data.event, 40).trim()
  const action = str(data.action, 40).trim()

  if (event === 'issues') {
    if (action !== 'opened' && action !== 'edited') return null
    const issue = data.issue
    if (!issue || typeof issue !== 'object' || issue.pull_request) return null
    const repo = repoOf(data)
    const number = Number(issue.number)
    if (!repo || !Number.isFinite(number) || number <= 0) return null
    const title = str(issue.title, 300).trim()
    const bodyText = str(issue.body, MAX_TEXT).trim()
    const head = title ? `#${number} ${title}` : `#${number}`
    return {
      source: 'github',
      author: str(issue.user?.login, 100) || 'github',
      text: str(bodyText ? `${head}\n\n${bodyText}` : head, MAX_TEXT),
      threadId: `github:${repo}#${number}`,
      human: !isBot(issue.user),
      externalId: `issue:${repo}#${number}:${str(issue.updated_at, 40)}`,
      url: str(issue.html_url, 500) || `https://github.com/${repo}/issues/${number}`,
      repo,
      meta: { kind: 'issue', action, number: String(number) },
    }
  }

  if (event === 'issue_comment') {
    if (action !== 'created') return null
    const comment = data.comment
    const issue = data.issue
    if (!comment || typeof comment !== 'object' || !issue || typeof issue !== 'object') return null
    // Automation must never wake a worker: bot comments are dropped here, not merely flagged.
    if (isBot(comment.user)) return null
    const repo = repoOf(data)
    const number = Number(issue.number)
    const id = str(comment.id, 40)
    if (!repo || !Number.isFinite(number) || number <= 0 || !id) return null
    return {
      source: 'github',
      author: str(comment.user?.login, 100) || 'github',
      text: str(comment.body, MAX_TEXT),
      threadId: `github:${repo}#${number}`,
      human: true,
      externalId: `comment:${repo}@${id}`,
      url: str(comment.html_url, 500) || str(issue.html_url, 500) || `https://github.com/${repo}/issues/${number}`,
      repo,
      meta: { kind: 'comment', action, number: String(number), issueTitle: str(issue.title, 120) },
    }
  }

  return null
}

/**
 * Generic CI webhook → TriggerEvent. Only failure states produce an event; the
 * text carries the workflow, the run URL and the last 800 characters of the log,
 * because that tail is where a build error actually appears.
 */
export function parseCIWebhook({ headers, body, payload } = {}) {
  const data = resolvePayload({ body, payload })
  if (!data || typeof data !== 'object') return null

  const status = str(data.status ?? data.state ?? data.conclusion, 40).trim().toLowerCase()
  if (!CI_FAILURE_STATES.has(status)) return null

  const repo = repoOf(data)
  const runUrl = firstString(data.runUrl, data.runURL, data.html_url, data.url)
  const workflow = firstString(data.workflow, data.workflow_name, data.job, data.name)
  const sha = firstString(data.sha, data.head_sha, data.commit)
  const logText = firstString(data.log, data.logs, data.output)
  const tail = logText.length > 800 ? logText.slice(-800) : logText

  const lines = [`CI ${status}${repo ? ` · ${repo}` : ''}${workflow ? ` · ${workflow}` : ''}`]
  if (runUrl) lines.push(`run: ${runUrl}`)
  if (sha) lines.push(`sha: ${sha.slice(0, 12)}`)
  if (tail) lines.push(`日志尾部:\n${tail}`)

  const key = runUrl || sha || String(Date.now())
  const event = {
    source: 'ci',
    author: firstString(data.author, data.sender?.login) || 'ci',
    text: str(lines.join('\n'), MAX_TEXT),
    threadId: `ci:${repo}:${workflow || runUrl || 'run'}`,
    human: false,
    externalId: `ci:${key}`,
    meta: { status, workflow, sha },
  }
  if (runUrl) event.url = str(runUrl, 500)
  if (repo) event.repo = str(repo, 200)
  return event
}
