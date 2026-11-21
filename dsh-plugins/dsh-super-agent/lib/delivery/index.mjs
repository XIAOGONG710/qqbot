/**
 * Super Agent · delivery closed loop (`deliver`).
 *
 * Takes the change a Worker produced in its own worktree, turns it into a real
 * commit, writes a binary-safe patch plus a PR draft, and — depending on
 * `config.mode` — pushes the branch and opens a pull request through the
 * GitHub REST API.
 *
 * Contract: docs/super-agent-extension-contract.md §0, §3, §4, §5.
 * Only `node:` built-ins and the global `fetch` are used; a failing step
 * returns `{ status: 'failed', error }` instead of throwing, and the worktree
 * (and the commit inside it) is never rolled back or removed here.
 *
 * Every git invocation goes through the injected `opts.git(cwd, args)`, whose
 * default implementation is `node:child_process.execFile` with a 120s timeout.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const GIT_TIMEOUT_MS = 120_000
const DEFAULT_COMMIT_TEMPLATE = 'Super Agent: {title}'
const FALLBACK_IDENTITY = ['-c', 'user.email=sa@local', '-c', 'user.name=Super Agent']
const MODES = new Set(['patch', 'push', 'pr'])
const REPO_SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

/**
 * Default git runner: `execFile` (never a shell, so Windows path quirks and
 * `-c key=value` values cannot be re-split by cmd.exe).
 */
function defaultGit(cwd, args) {
  return new Promise(resolvePromise => {
    execFile(
      'git',
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0
        resolvePromise({
          code: Number.isFinite(code) ? code : 1,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
        })
      },
    )
  })
}

const isObject = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)

/** First lines of git stderr, flattened for a single-line `error` field. */
function brief(text) {
  return String(text ?? '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(0, 3)
    .join(' ')
    .slice(0, 300)
}

/** `git status --porcelain` lines → plain paths, used as a fallback list. */
function statusPaths(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(Boolean)
    .map(line => (line.length > 3 ? line.slice(3).trim() : line))
    .filter(Boolean)
}

/** Applies `{title}` / `{ticketId}` placeholders without regex-replacement pitfalls. */
function renderCommitMessage(template, { title, ticketId }) {
  const source = typeof template === 'string' && template.trim() ? template : DEFAULT_COMMIT_TEMPLATE
  return source.split('{title}').join(title).split('{ticketId}').join(ticketId)
}

/** Ticket ids may contain path separators; keep file names usable on Windows. */
function safeFileBase(id) {
  const cleaned = String(id ?? '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return cleaned || 'ticket'
}

const ensureTrailingNewline = text => (text.endsWith('\n') ? text : `${text}\n`)

/**
 * True when `ticket.repo` names something on this machine rather than a GitHub
 * `owner/name` slug. Local repos and repos without a remote are patch-only.
 */
function isLocalRepoPath(repo) {
  if (typeof repo !== 'string') return false
  const value = repo.trim()
  if (!value) return false
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('\\')) return true
  if (isAbsolute(value)) return true
  if (value.includes('\\')) return true
  if (value.includes('/')) {
    if (!REPO_SLUG.test(value)) return true
    try {
      return existsSync(value)
    } catch {
      return false
    }
  }
  return true
}

function parseRepoSlug(repo) {
  if (typeof repo !== 'string') return ''
  const value = repo.trim().replace(/\.git$/i, '')
  if (!value || isLocalRepoPath(value) || !REPO_SLUG.test(value)) return ''
  return value
}

function githubMessage(result) {
  const json = isObject(result?.json) ? result.json : null
  if (json && typeof json.message === 'string' && json.message.trim()) return json.message
  const text = String(result?.text ?? '').trim()
  return text ? text.slice(0, 300) : 'unknown GitHub API error'
}

/**
 * Markdown PR draft: also the human-facing summary for patch-only delivery.
 * Contains the title, source, ticket id, worker summary, changed files, a
 * verification placeholder and copy-paste `git apply` instructions.
 */
function buildDraft({ ticket, worker, title, branch, commit, baseSha, changedFiles, patchPath, remote, remoteUrl }) {
  const source = String(ticket.source ?? 'manual')
  const url = typeof ticket.url === 'string' ? ticket.url.trim() : ''
  const summary = String(worker.summary ?? '').trim() || '（Worker 未提供摘要）'
  const files = Array.isArray(changedFiles) && changedFiles.length > 0
    ? changedFiles.map(file => `- \`${file}\``).join('\n')
    : '- （未检测到文件变更）'
  const lines = []
  lines.push(`# [Super Agent] ${title}`)
  lines.push('')
  lines.push('## 来源')
  lines.push(`- source: \`${source}\``)
  lines.push(url ? `- url: ${url}` : '- url: （无）')
  lines.push(`- ticketId: \`${String(ticket.id ?? '')}\``)
  lines.push(`- worker: \`${String(worker.id ?? '')}\``)
  lines.push('')
  lines.push('## Worker 摘要')
  lines.push('')
  lines.push(summary)
  lines.push('')
  lines.push('## 变更文件')
  lines.push('')
  lines.push(files)
  lines.push('')
  lines.push('## 分支与提交')
  lines.push(`- branch: \`${branch}\``)
  lines.push(`- commit: \`${String(commit ?? '')}\``)
  lines.push(`- base: \`${String(baseSha || 'HEAD^')}\``)
  lines.push(`- remote: \`${remote}\`${remoteUrl ? ` (${remoteUrl})` : ''}`)
  lines.push('')
  lines.push('## 验证说明')
  lines.push('')
  lines.push('- [ ] 待补充：请填写本次改动的验证方式与结果（单测 / 构建 / 手动检查）。')
  lines.push('')
  lines.push('## 本地应用')
  lines.push('')
  lines.push(`补丁文件：\`${patchPath}\``)
  lines.push('')
  lines.push('```bash')
  lines.push(`git fetch ${remote} ${branch}`)
  lines.push(`git apply --check --binary "${patchPath}"`)
  lines.push(`git apply --binary "${patchPath}"`)
  lines.push('```')
  lines.push('')
  return lines.join('\n')
}

/**
 * Deliver one Ticket from one Worker worktree.
 *
 * @returns {Promise<{
 *   status: 'patch'|'pushed'|'pr'|'no-change'|'failed',
 *   branch?: string, commit?: string, patchPath?: string, draftPath?: string,
 *   prUrl?: string, remoteUrl?: string, changedFiles?: string[],
 *   note?: string, error?: string,
 * }>}
 */
export async function deliver(opts = {}) {
  const options = isObject(opts) ? opts : {}
  const log = typeof options.log === 'function' ? options.log : () => {}
  const ticket = isObject(options.ticket) ? options.ticket : {}
  const worker = isObject(options.worker) ? options.worker : {}
  const config = isObject(options.config) ? options.config : {}
  const worktree = isObject(options.worktree) ? options.worktree : null
  const gitFn = typeof options.git === 'function' ? options.git : defaultGit
  const fetchImpl = typeof options.fetchImpl === 'function'
    ? options.fetchImpl
    : (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null)

  const ticketId = String(ticket.id ?? worker.id ?? 'ticket')
  const title = String(ticket.title ?? ticket.brief ?? ticketId).trim() || ticketId
  const mode = MODES.has(config.mode) ? config.mode : 'patch'
  const remote = typeof config.remote === 'string' && config.remote.trim() ? config.remote.trim() : 'origin'
  const branchPrefix = typeof config.branchPrefix === 'string' ? config.branchPrefix : 'sa/'

  const dir = typeof worktree?.path === 'string' && worktree.path.trim() ? resolve(worktree.path) : ''
  if (!dir) return { status: 'failed', error: 'delivery: worktree.path is required; nothing to deliver' }
  if (!existsSync(dir)) return { status: 'failed', error: `delivery: worktree path does not exist: ${dir}` }

  const branch = typeof worktree?.branch === 'string' && worktree.branch.trim()
    ? worktree.branch.trim()
    : `${branchPrefix}${ticketId}`

  /** One git call through the injected runner; never throws. */
  const run = async args => {
    try {
      const result = await gitFn(dir, ['-C', dir, ...args])
      const raw = result?.code
      const code = typeof raw === 'number' && Number.isFinite(raw) ? raw : (raw === 0 ? 0 : 1)
      return { code, stdout: String(result?.stdout ?? ''), stderr: String(result?.stderr ?? '') }
    } catch (error) {
      return { code: 1, stdout: '', stderr: error instanceof Error ? error.message : String(error) }
    }
  }

  const failure = (message, extra = {}) => {
    log('error', `delivery: ${message}`, { ticket: ticketId })
    return { status: 'failed', error: message, ...extra }
  }

  // 1. Is there anything to deliver?
  const statusRes = await run(['status', '--porcelain'])
  if (statusRes.code !== 0) {
    return failure(`git status failed: ${brief(statusRes.stderr) || 'unknown error'}`, { branch })
  }

  const headRes = await run(['rev-parse', 'HEAD'])
  const preHead = headRes.code === 0 ? headRes.stdout.trim() : ''
  const configuredBase = typeof worktree?.baseSha === 'string' ? worktree.baseSha.trim() : ''
  const baseSha = configuredBase || preHead

  const dirty = statusRes.stdout.trim().length > 0
  let commit = ''

  if (!dirty) {
    if (!preHead || !baseSha || preHead === baseSha) {
      log('info', 'delivery: nothing to deliver', { ticket: ticketId })
      return { status: 'no-change', branch, changedFiles: [] }
    }
    // A Worker may have committed on its own; deliver those commits instead of
    // silently reporting "no change".
    commit = preHead
    log('info', 'delivery: worktree clean but ahead of base; delivering existing commit', {
      ticket: ticketId,
      base: baseSha,
      commit,
    })
  } else {
    // 2. Stage and commit with an explicit identity (never global git config).
    const addRes = await run(['add', '-A'])
    if (addRes.code !== 0) {
      return failure(`git add failed: ${brief(addRes.stderr) || 'unknown error'}`, { branch })
    }

    const message = renderCommitMessage(config.commitMessage, { title, ticketId })
    const identity = []
    if (config.authorName) identity.push('-c', `user.name=${config.authorName}`)
    if (config.authorEmail) identity.push('-c', `user.email=${config.authorEmail}`)

    let commitRes = await run([...identity, 'commit', '-m', message])
    if (commitRes.code !== 0) {
      log('warn', 'delivery: commit failed, retrying with fallback identity', {
        ticket: ticketId,
        error: brief(commitRes.stderr),
      })
      commitRes = await run([...FALLBACK_IDENTITY, 'commit', '-m', message])
    }
    if (commitRes.code !== 0) {
      return failure(`git commit failed: ${brief(commitRes.stderr) || 'unknown error'}`, {
        branch,
        changedFiles: statusPaths(statusRes.stdout),
      })
    }

    const afterRes = await run(['rev-parse', 'HEAD'])
    commit = afterRes.code === 0 ? afterRes.stdout.trim() : ''
    if (!commit) return failure('git rev-parse HEAD failed after commit', { branch })
  }

  // 3. Changed files + binary-safe patch from the branch point.
  const namesRes = baseSha
    ? await run(['diff', '--name-only', `${baseSha}..HEAD`])
    : await run(['show', '--name-only', '--format=', 'HEAD'])
  const changedFiles = namesRes.code === 0
    ? namesRes.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
    : statusPaths(statusRes.stdout)

  const patchRes = baseSha
    ? await run(['diff', '--binary', `${baseSha}..HEAD`])
    : await run(['show', '--binary', '--format=', 'HEAD'])
  if (patchRes.code !== 0) {
    return failure(`git diff failed: ${brief(patchRes.stderr) || 'unknown error'}`, {
      branch,
      commit,
      changedFiles,
    })
  }
  if (!patchRes.stdout.trim()) {
    log('warn', 'delivery: empty diff after commit', { ticket: ticketId, commit })
    return {
      status: 'no-change',
      branch,
      commit,
      changedFiles: [],
      note: 'commit contains no file changes',
    }
  }

  // Artifacts: `artifactsDir` when given, otherwise next to the worktree.
  const artifactsDir = typeof options.artifactsDir === 'string' && options.artifactsDir.trim()
    ? resolve(options.artifactsDir)
    : ''
  const artifactRoot = artifactsDir || dirname(dir)
  const fileBase = safeFileBase(ticketId)
  const patchPath = join(artifactRoot, `${fileBase}.patch`)
  const draftPath = join(artifactRoot, `${fileBase}.pr.md`)

  try {
    await mkdir(artifactRoot, { recursive: true })
    await writeFile(patchPath, ensureTrailingNewline(patchRes.stdout), 'utf8')
  } catch (error) {
    return failure(`writing patch failed: ${error instanceof Error ? error.message : String(error)}`, {
      branch,
      commit,
      changedFiles,
    })
  }

  const remoteRes = await run(['remote', 'get-url', remote])
  const remoteUrl = remoteRes.code === 0 ? remoteRes.stdout.trim() : ''
  const localRepo = isLocalRepoPath(ticket.repo)
  const repoSlug = parseRepoSlug(ticket.repo)
  const prRequired = mode !== 'patch'
  // A local clone can still have a remote: the real question is whether one is configured.
  const canPush = prRequired && Boolean(remoteUrl)

  const draft = buildDraft({
    ticket,
    worker,
    title,
    branch,
    commit,
    baseSha,
    changedFiles,
    patchPath,
    remote,
    remoteUrl,
  })
  try {
    await writeFile(draftPath, draft, 'utf8')
  } catch (error) {
    return failure(`writing PR draft failed: ${error instanceof Error ? error.message : String(error)}`, {
      branch,
      commit,
      patchPath,
      changedFiles,
    })
  }

  const patchOnly = note => ({
    status: 'patch',
    branch,
    commit,
    patchPath,
    draftPath,
    changedFiles,
    remoteUrl: remoteUrl || undefined,
    ...(note ? { note } : {}),
  })

  // 4. `mode='patch'`: the change stops here as a patch + draft.
  if (!prRequired) {
    log('info', 'delivery: patch written', { ticket: ticketId, patchPath, draftPath })
    return patchOnly('')
  }

  // 5. `mode='push'|'pr'`: local ticket repos or a missing remote stay patch-only.
  if (!canPush) {
    const reason = `no git remote "${remote}" in the worktree; patch-only delivery`
    log('info', `delivery: ${reason}`, { ticket: ticketId })
    return patchOnly(reason)
  }

  // 6. Push the branch.
  let pushRes = await run(['push', '-u', remote, branch])
  if (pushRes.code !== 0) {
    const localRef = await run(['rev-parse', '--verify', `refs/heads/${branch}`])
    if (localRef.code !== 0) {
      log('warn', 'delivery: branch is not a local ref, pushing HEAD instead', { ticket: ticketId, branch })
      pushRes = await run(['push', '-u', remote, `HEAD:refs/heads/${branch}`])
    }
  }
  if (pushRes.code !== 0) {
    return {
      status: 'failed',
      branch,
      commit,
      patchPath,
      draftPath,
      changedFiles,
      remoteUrl: remoteUrl || undefined,
      error: `git push failed: ${brief(pushRes.stderr) || 'unknown error'}`,
    }
  }
  log('info', 'delivery: branch pushed', { ticket: ticketId, branch, remote })

  const pushed = {
    status: 'pushed',
    branch,
    commit,
    patchPath,
    draftPath,
    changedFiles,
    remoteUrl: remoteUrl || (repoSlug ? `https://github.com/${repoSlug}` : undefined),
  }

  if (mode === 'push') return pushed

  // 7. `mode='pr'`: push succeeded, now open the pull request (or degrade).
  const degrade = (error, note) => {
    log('warn', `delivery: ${error}`, { ticket: ticketId })
    return { ...pushed, error, ...(note ? { note } : {}) }
  }

  const token = typeof config.githubToken === 'string' ? config.githubToken.trim() : ''
  if (!token) {
    return degrade(
      'mode=pr requires config.githubToken; pull request not created',
      'branch pushed and PR draft written instead',
    )
  }
  if (!fetchImpl) {
    return degrade(
      'fetch is unavailable in this runtime; pull request not created',
      'branch pushed and PR draft written instead',
    )
  }
  if (!repoSlug) {
    return degrade(
      `ticket.repo must be "owner/name" to open a pull request (got "${String(ticket.repo ?? '')}")`,
      'branch pushed and PR draft written instead',
    )
  }

  const apiBase = String(config.githubApiUrl || 'https://api.github.com').replace(/\/+$/, '')
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'content-type': 'application/json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'dsh-super-agent-delivery',
  }
  const call = async (method, path, body) => {
    const response = await fetchImpl(`${apiBase}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = typeof response?.text === 'function' ? await response.text() : ''
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { ok: Boolean(response?.ok), status: Number(response?.status ?? 0), json, text }
  }

  try {
    const repoRes = await call('GET', `/repos/${repoSlug}`)
    if (!repoRes.ok) {
      return degrade(
        `github: GET /repos/${repoSlug} failed (${repoRes.status}): ${githubMessage(repoRes)}`,
        'branch pushed; open the pull request manually',
      )
    }
    const requestedBase = typeof config.prBase === 'string' ? config.prBase.trim() : ''
    const base = requestedBase || String(repoRes.json?.default_branch || 'main')

    // Idempotent ref creation: 422 means the branch already exists (we just
    // pushed it), which is not an error for opening the PR.
    const refRes = await call('POST', `/repos/${repoSlug}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: commit,
    })
    if (!refRes.ok && refRes.status !== 422) {
      return degrade(
        `github: POST /repos/${repoSlug}/git/refs failed (${refRes.status}): ${githubMessage(refRes)}`,
        'branch pushed; open the pull request manually',
      )
    }

    const prRes = await call('POST', `/repos/${repoSlug}/pulls`, {
      title: `[Super Agent] ${title}`,
      head: branch,
      base,
      body: draft,
      maintainer_can_modify: true,
    })
    if (!prRes.ok) {
      return degrade(
        `github: POST /repos/${repoSlug}/pulls failed (${prRes.status}): ${githubMessage(prRes)}`,
        'branch pushed; open the pull request manually',
      )
    }
    const prUrl = typeof prRes.json?.html_url === 'string' ? prRes.json.html_url : ''
    if (!prUrl) {
      return degrade(
        'github: POST /repos/{repo}/pulls returned no html_url',
        'branch pushed; open the pull request manually',
      )
    }
    log('info', 'delivery: pull request opened', { ticket: ticketId, prUrl })
    return { ...pushed, status: 'pr', prUrl }
  } catch (error) {
    return degrade(
      `github: ${error instanceof Error ? error.message : String(error)}`,
      'branch pushed; open the pull request manually',
    )
  }
}

export default deliver
