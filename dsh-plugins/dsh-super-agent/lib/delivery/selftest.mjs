#!/usr/bin/env node
/**
 * Delivery self-test — `node lib/delivery/selftest.mjs` (exit code 0/1).
 *
 * Builds real repositories under `os.tmpdir()` (working repo + bare remote) and
 * exercises the six contractual delivery paths plus the local-repo push gate:
 *   1. changes + mode='patch'  → status 'patch', real commit, non-empty patch
 *      that `git apply --check` accepts, draft with title and ticketId;
 *   2. no changes              → status 'no-change';
 *   3. mode='push'             → bare remote head matches → status 'pushed';
 *   4. mode='pr' + fake fetch  → status 'pr' and the right prUrl;
 *   5. mode='pr' without token → degraded (patch/pushed) with error/note;
 *   6. git stub returning 1    → status 'failed', no throw;
 *   7. ticket.repo local path  → patch-only, nothing pushed.
 *
 * Temporary directories are removed on the way out (also on failure).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { deliver } from './index.mjs'

const GIT_TIMEOUT_MS = 120_000
const failures = []
let total = 0

const say = line => console.log(line)

function check(name, ok, detail = '') {
  total += 1
  if (ok) {
    say(`  PASS ${name}`)
    return true
  }
  const text = detail ? `${name} — ${detail}` : name
  say(`  FAIL ${text}`)
  failures.push(text)
  return false
}

/** Runs git with CRLF normalisation pinned, so patches are platform-stable. */
function git(cwd, args) {
  return new Promise(resolvePromise => {
    execFile(
      'git',
      ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
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

async function mustGit(cwd, args) {
  const result = await git(cwd, args)
  if (result.code !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(result.stderr || result.stdout).trim()}`)
  }
  return result
}

/**
 * Working repo with one commit on `main`, a bare `origin.git`, and `main`
 * already pushed, so a later `mode='push'` has a real remote to talk to.
 */
async function fixture(base, name) {
  const root = join(base, name)
  const origin = join(root, 'origin.git')
  const repo = join(root, 'repo')
  await mkdir(root, { recursive: true })
  await mustGit(root, ['init', '--bare', '-b', 'main', origin])
  await mustGit(root, ['init', '-b', 'main', repo])
  await mustGit(repo, ['config', 'user.name', 'Delivery Selftest'])
  await mustGit(repo, ['config', 'user.email', 'selftest@example.com'])
  await writeFile(join(repo, 'README.md'), '# demo\n\nbase line\n', 'utf8')
  await mustGit(repo, ['add', '-A'])
  await mustGit(repo, ['commit', '-m', 'base'])
  await mustGit(repo, ['remote', 'add', 'origin', origin])
  await mustGit(repo, ['push', '-u', 'origin', 'main'])
  const baseSha = (await mustGit(repo, ['rev-parse', 'HEAD'])).stdout.trim()
  return { root, origin, repo, baseSha }
}

async function startBranch(fx, branchName) {
  await mustGit(fx.repo, ['checkout', '-b', branchName])
}

const worktreeOf = (fx, branchName) => ({
  path: fx.repo,
  branch: branchName,
  baseSha: fx.baseSha,
  repoDir: fx.repo,
  disposable: true,
})

const ticketOf = (id, title, extra = {}) => ({
  id,
  title,
  brief: `brief for ${id}`,
  source: 'selftest',
  threadId: `selftest:${id}`,
  ...extra,
})

const jsonResponse = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => JSON.stringify(body),
})

async function scenario(name, run) {
  say(`\n● ${name}`)
  try {
    await run()
  } catch (error) {
    check(`${name} threw`, false, error instanceof Error ? error.message : String(error))
  }
}

// 1. changes + mode='patch' → commit, binary-safe patch, draft.
async function scenarioPatch(base) {
  const fx = await fixture(base, 'patch')
  await startBranch(fx, 'sa/t-1')
  await writeFile(join(fx.repo, 'a.txt'), 'hello from worker\n', 'utf8')
  await writeFile(join(fx.repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 255, 254, 10, 13, 0, 66]))
  await writeFile(join(fx.repo, 'README.md'), '# demo\n\nbase line\n\nworker line\n', 'utf8')

  const artifactsDir = join(fx.root, 'artifacts', 'nested')
  const result = await deliver({
    ticket: ticketOf('t-1', '修复登录超时'),
    worker: { id: 'w-1', summary: '调整登录超时处理' },
    worktree: worktreeOf(fx, 'sa/t-1'),
    repoDir: fx.repo,
    config: { mode: 'patch' },
    artifactsDir,
  })

  check('patch: status is patch', result.status === 'patch', String(result.status))
  check('patch: commit reported', typeof result.commit === 'string' && result.commit.length >= 7, String(result.commit))
  const head = (await git(fx.repo, ['rev-parse', 'HEAD'])).stdout.trim()
  check('patch: commit is the real HEAD', result.commit === head, `${result.commit} vs ${head}`)
  check('patch: artifactsDir created', existsSync(artifactsDir), artifactsDir)

  const patchPath = join(artifactsDir, 't-1.patch')
  check('patch: patchPath uses ticket id', result.patchPath === patchPath, String(result.patchPath))
  const patchText = existsSync(patchPath) ? await readFile(patchPath, 'utf8') : ''
  check('patch: patch file non-empty', patchText.length > 0, `${patchText.length} bytes`)
  check('patch: binary diff present (--binary)', patchText.includes('GIT binary patch'))
  check(
    'patch: changedFiles lists the new files',
    Array.isArray(result.changedFiles) && result.changedFiles.includes('a.txt') && result.changedFiles.includes('blob.bin'),
    JSON.stringify(result.changedFiles),
  )

  // Apply against a clean clone of the base commit — that is the reviewer path.
  const verifyDir = join(fx.root, 'verify')
  await mustGit(fx.root, ['clone', '--quiet', fx.origin, verifyDir])
  const apply = await git(verifyDir, ['apply', '--check', '--binary', patchPath])
  check('patch: git apply --check passes on base', apply.code === 0, (apply.stderr || apply.stdout).trim())

  const draftPath = join(artifactsDir, 't-1.pr.md')
  check('patch: draftPath uses ticket id', result.draftPath === draftPath, String(result.draftPath))
  const draftText = existsSync(draftPath) ? await readFile(draftPath, 'utf8') : ''
  check('patch: draft has [Super Agent] title', draftText.includes('[Super Agent] 修复登录超时'))
  check('patch: draft has ticketId', draftText.includes('t-1'))
  check('patch: draft has apply instructions', draftText.includes('git apply'))
  check('patch: draft has verification placeholder', draftText.includes('验证'))
}

// 2. no changes → 'no-change'.
async function scenarioNoChange(base) {
  const fx = await fixture(base, 'nochange')
  const artifactsDir = join(fx.root, 'artifacts')
  const result = await deliver({
    ticket: ticketOf('t-2', '无改动'),
    worker: { id: 'w-2' },
    worktree: worktreeOf(fx, 'main'),
    repoDir: fx.repo,
    config: { mode: 'patch' },
    artifactsDir,
  })
  check('no-change: status is no-change', result.status === 'no-change', String(result.status))
  check('no-change: no patch written', !existsSync(join(artifactsDir, 't-2.patch')))
  const head = (await git(fx.repo, ['rev-parse', 'HEAD'])).stdout.trim()
  check('no-change: no commit created', head === fx.baseSha, `${head} vs ${fx.baseSha}`)
}

// 3. mode='push' → bare remote branch head matches the reported commit.
async function scenarioPush(base) {
  const fx = await fixture(base, 'push')
  await startBranch(fx, 'sa/t-3')
  await writeFile(join(fx.repo, 'b.txt'), 'push me\n', 'utf8')

  const result = await deliver({
    ticket: ticketOf('t-3', '推送验证', { repo: 'acme/demo' }),
    worker: { id: 'w-3', summary: '推送分支' },
    worktree: worktreeOf(fx, 'sa/t-3'),
    repoDir: fx.repo,
    config: { mode: 'push', remote: 'origin' },
  })

  check('push: status is pushed', result.status === 'pushed', `${result.status} ${result.error ?? ''}`)
  const remoteHead = (await git(fx.origin, ['rev-parse', 'refs/heads/sa/t-3'])).stdout.trim()
  check('push: bare remote head matches commit', remoteHead === result.commit, `${remoteHead} vs ${result.commit}`)
  check('push: patch written next to the worktree', existsSync(join(fx.root, 't-3.patch')), String(result.patchPath))
  check('push: draft written next to the worktree', existsSync(join(fx.root, 't-3.pr.md')), String(result.draftPath))
}

// 4. mode='pr' + fake fetch → 'pr' with the API's html_url.
async function scenarioPullRequest(base) {
  const fx = await fixture(base, 'pr')
  await startBranch(fx, 'sa/t-4')
  await writeFile(join(fx.repo, 'c.txt'), 'pr me\n', 'utf8')

  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const target = String(url)
    const method = init.method ?? 'GET'
    calls.push({ url: target, method, body: init.body ? JSON.parse(init.body) : undefined })
    if (method === 'GET' && target.endsWith('/repos/acme/demo')) return jsonResponse(200, { default_branch: 'trunk' })
    if (method === 'POST' && target.endsWith('/repos/acme/demo/git/refs')) {
      return jsonResponse(201, { ref: 'refs/heads/sa/t-4' })
    }
    if (method === 'POST' && target.endsWith('/repos/acme/demo/pulls')) {
      return jsonResponse(201, { html_url: 'https://github.com/acme/demo/pull/7', number: 7 })
    }
    return jsonResponse(404, { message: `unexpected ${method} ${target}` })
  }

  const result = await deliver({
    ticket: ticketOf('t-4', '开 PR 验证', { repo: 'acme/demo', url: 'https://github.com/acme/demo/issues/9' }),
    worker: { id: 'w-4', summary: '实现 PR 交付' },
    worktree: worktreeOf(fx, 'sa/t-4'),
    repoDir: fx.repo,
    config: { mode: 'pr', remote: 'origin', githubToken: 'test-token' },
    fetchImpl,
  })

  check('pr: status is pr', result.status === 'pr', `${result.status} ${result.error ?? ''}`)
  check('pr: prUrl is the API html_url', result.prUrl === 'https://github.com/acme/demo/pull/7', String(result.prUrl))
  check('pr: REST called in order (repo, ref, pulls)', calls.length === 3 && calls[0].method === 'GET' && calls[1].method === 'POST' && calls[2].method === 'POST', calls.map(c => `${c.method} ${c.url}`).join(' | '))
  check('pr: ref body has branch and commit', calls[1]?.body?.ref === 'refs/heads/sa/t-4' && calls[1]?.body?.sha === result.commit, JSON.stringify(calls[1]?.body))
  check('pr: pull base comes from default_branch', calls[2]?.body?.base === 'trunk', JSON.stringify(calls[2]?.body))
  check('pr: pull head is the ticket branch', calls[2]?.body?.head === 'sa/t-4', JSON.stringify(calls[2]?.body))
  check('pr: pull title is prefixed', typeof calls[2]?.body?.title === 'string' && calls[2].body.title.startsWith('[Super Agent] '), String(calls[2]?.body?.title))
  check('pr: branch really pushed', (await git(fx.origin, ['rev-parse', 'refs/heads/sa/t-4'])).stdout.trim() === result.commit)
  check('pr: patch + draft still written', existsSync(result.patchPath ?? '') && existsSync(result.draftPath ?? ''))
}

// 5. mode='pr' without a token → degrade, no throw, fetch never called.
async function scenarioPrWithoutToken(base) {
  const fx = await fixture(base, 'pr-notoken')
  await startBranch(fx, 'sa/t-5')
  await writeFile(join(fx.repo, 'd.txt'), 'no token\n', 'utf8')

  let fetched = false
  const result = await deliver({
    ticket: ticketOf('t-5', '无 token 降级', { repo: 'acme/demo' }),
    worker: { id: 'w-5' },
    worktree: worktreeOf(fx, 'sa/t-5'),
    repoDir: fx.repo,
    config: { mode: 'pr', remote: 'origin' },
    fetchImpl: async () => {
      fetched = true
      throw new Error('fetch must not be called without a token')
    },
  })

  check('no-token: degraded to patch/pushed', result.status === 'patch' || result.status === 'pushed', String(result.status))
  check('no-token: error or note explains why', Boolean(result.error || result.note), String(result.error ?? result.note ?? ''))
  check('no-token: draft written', existsSync(result.draftPath ?? ''), String(result.draftPath))
  check('no-token: fetch not called', fetched === false)
  check('no-token: no prUrl', !result.prUrl)
}

// 6. git stub failing with code 1 → 'failed', no throw.
async function scenarioGitFailure(base) {
  const fx = await fixture(base, 'fail')
  await startBranch(fx, 'sa/t-6')
  await writeFile(join(fx.repo, 'e.txt'), 'git will fail\n', 'utf8')

  let result
  let threw = null
  try {
    result = await deliver({
      ticket: ticketOf('t-6', '失败验证'),
      worker: { id: 'w-6' },
      worktree: worktreeOf(fx, 'sa/t-6'),
      repoDir: fx.repo,
      config: { mode: 'patch' },
      git: async () => ({ code: 1, stdout: '', stderr: 'stub failure' }),
    })
  } catch (error) {
    threw = error
  }

  check('failed: did not throw', threw === null, threw ? String(threw) : '')
  check('failed: status is failed', result?.status === 'failed', String(result?.status))
  check('failed: error mentions stub failure', typeof result?.error === 'string' && result.error.includes('stub failure'), String(result?.error))
  check('failed: worktree kept', existsSync(fx.repo))
}

// 8. Missing identity → one retry with `-c user.email=sa@local -c user.name=Super Agent`
//    (never global config), plus the commitMessage placeholders.
async function scenarioIdentityFallback(base) {
  const fx = await fixture(base, 'identity')
  await startBranch(fx, 'sa/t-8')
  await writeFile(join(fx.repo, 'g.txt'), 'fallback\n', 'utf8')

  const calls = []
  let failedOnce = false
  const stubGit = async (cwd, args) => {
    calls.push(args)
    if (args.includes('commit') && !failedOnce) {
      failedOnce = true
      return { code: 1, stdout: '', stderr: 'Author identity unknown' }
    }
    return git(cwd, args)
  }

  const result = await deliver({
    ticket: ticketOf('t-8', '提交身份回退'),
    worker: { id: 'w-8' },
    worktree: worktreeOf(fx, 'sa/t-8'),
    repoDir: fx.repo,
    config: { mode: 'patch', commitMessage: 'fix: {title} [{ticketId}]' },
    artifactsDir: join(fx.root, 'artifacts'),
    git: stubGit,
  })

  const commitCalls = calls.filter(args => args.includes('commit'))
  check('identity: commit retried exactly once', commitCalls.length === 2, String(commitCalls.length))
  check('identity: retry adds fallback email', commitCalls[1]?.join(' ').includes('user.email=sa@local'), String(commitCalls[1]?.join(' ')))
  check('identity: retry adds fallback name', commitCalls[1]?.join(' ').includes('user.name=Super Agent'), String(commitCalls[1]?.join(' ')))
  const subject = (await git(fx.repo, ['log', '-1', '--pretty=%s'])).stdout.trim()
  check('identity: {title}/{ticketId} rendered', subject === 'fix: 提交身份回退 [t-8]', subject)
  check('identity: delivery succeeded', result.status === 'patch', String(result.status))
  const touchedConfig = calls.some(args => args.includes('config'))
  check('identity: no git config command run', touchedConfig === false)

  // A configured author must arrive as -c flags on the first commit attempt.
  const fx2 = await fixture(base, 'identity-author')
  await startBranch(fx2, 'sa/t-8b')
  await writeFile(join(fx2.repo, 'h.txt'), 'custom author\n', 'utf8')
  const calls2 = []
  const result2 = await deliver({
    ticket: ticketOf('t-8b', '自定义作者'),
    worker: { id: 'w-8' },
    worktree: worktreeOf(fx2, 'sa/t-8b'),
    repoDir: fx2.repo,
    config: { mode: 'patch', authorName: 'Custom Bot', authorEmail: 'bot@example.com' },
    artifactsDir: join(fx2.root, 'artifacts'),
    git: async (cwd, args) => {
      calls2.push(args)
      return git(cwd, args)
    },
  })
  const firstCommit = calls2.find(args => args.includes('commit')) ?? []
  check('identity: configured author passed via -c', firstCommit.join(' ').includes('user.name=Custom Bot') && firstCommit.join(' ').includes('user.email=bot@example.com'), firstCommit.join(' '))
  const author = (await git(fx2.repo, ['log', '-1', '--pretty=%an <%ae>'])).stdout.trim()
  check('identity: commit author is the configured one', author === 'Custom Bot <bot@example.com>', author)
  check('identity: author delivery succeeded', result2.status === 'patch', String(result2.status))
}

// 9. A Worker that already committed on its branch is still delivered.
async function scenarioPrecommittedWorker(base) {
  const fx = await fixture(base, 'precommitted')
  await startBranch(fx, 'sa/t-9')
  await writeFile(join(fx.repo, 'i.txt'), 'worker committed itself\n', 'utf8')
  await mustGit(fx.repo, ['add', '-A'])
  await mustGit(fx.repo, ['commit', '-m', 'worker commit'])
  const clean = (await git(fx.repo, ['status', '--porcelain'])).stdout.trim()
  check('precommit: worktree is clean', clean === '', clean)

  const result = await deliver({
    ticket: ticketOf('t-9', 'Worker 自己提交'),
    worker: { id: 'w-9', summary: 'already committed' },
    worktree: worktreeOf(fx, 'sa/t-9'),
    repoDir: fx.repo,
    config: { mode: 'patch' },
    artifactsDir: join(fx.root, 'artifacts'),
  })

  const head = (await git(fx.repo, ['rev-parse', 'HEAD'])).stdout.trim()
  check('precommit: status is patch', result.status === 'patch', String(result.status))
  check('precommit: reuses the existing commit', result.commit === head, `${result.commit} vs ${head}`)
  const patchText = existsSync(result.patchPath ?? '') ? await readFile(result.patchPath, 'utf8') : ''
  check('precommit: patch is non-empty', patchText.length > 0)
}

// 7. ticket.repo is a local path but the clone HAS a remote → push is allowed.
async function scenarioLocalRepoTicket(base) {
  const fx = await fixture(base, 'localrepo')
  await startBranch(fx, 'sa/t-7')
  await writeFile(join(fx.repo, 'f.txt'), 'local only\n', 'utf8')

  const result = await deliver({
    ticket: ticketOf('t-7', '本地仓库', { repo: fx.repo }),
    worker: { id: 'w-7' },
    worktree: worktreeOf(fx, 'sa/t-7'),
    repoDir: fx.repo,
    config: { mode: 'push', remote: 'origin' },
  })

  check('local-repo-with-remote: status is pushed', result.status === 'pushed', `${result.status} ${result.error ?? ''}`)
  const remoteHas = await git(fx.origin, ['rev-parse', '--verify', 'refs/heads/sa/t-7'])
  check('local-repo-with-remote: branch exists on the remote', remoteHas.code === 0 && remoteHas.stdout.trim() === result.commit, `${remoteHas.stdout.trim()} vs ${result.commit}`)

  // No remote at all is the other half of the patch-only gate.
  const fx2 = await fixture(base, 'noremote')
  await mustGit(fx2.repo, ['remote', 'remove', 'origin'])
  await startBranch(fx2, 'sa/t-7b')
  await writeFile(join(fx2.repo, 'g.txt'), 'no remote\n', 'utf8')
  const result2 = await deliver({
    ticket: ticketOf('t-7b', '无远端', { repo: 'acme/demo' }),
    worker: { id: 'w-7' },
    worktree: worktreeOf(fx2, 'sa/t-7b'),
    repoDir: fx2.repo,
    config: { mode: 'push', remote: 'origin' },
    artifactsDir: join(fx2.root, 'artifacts'),
  })
  check('no-remote: status is patch', result2.status === 'patch', `${result2.status} ${result2.error ?? ''}`)
  check('no-remote: note mentions the remote', /remote/i.test(String(result2.note ?? '')), String(result2.note))
}

async function main() {
  const base = await mkdtemp(join(tmpdir(), 'sa-delivery-selftest-'))
  say(`delivery selftest · temp root: ${base}`)
  try {
    await scenario(`1. mode='patch' → commit + patch + draft`, () => scenarioPatch(base))
    await scenario('2. no changes → no-change', () => scenarioNoChange(base))
    await scenario("3. mode='push' → bare remote head matches", () => scenarioPush(base))
    await scenario("4. mode='pr' + fake fetch → prUrl", () => scenarioPullRequest(base))
    await scenario("5. mode='pr' without token → degrade", () => scenarioPrWithoutToken(base))
    await scenario('6. git stub code 1 → failed, no throw', () => scenarioGitFailure(base))
    await scenario('7. ticket.repo local path → patch only', () => scenarioLocalRepoTicket(base))
    await scenario('8. missing identity → fallback retry + message template', () => scenarioIdentityFallback(base))
    await scenario('9. worker pre-committed → still delivered', () => scenarioPrecommittedWorker(base))
  } finally {
    await rm(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {})
  }

  const passed = total - failures.length
  if (failures.length === 0) {
    say(`\nOK — ${passed}/${total} checks passed`)
    process.exit(0)
  }
  say(`\nFAILED — ${passed}/${total} checks passed`)
  for (const failure of failures) say(`  - ${failure}`)
  process.exit(1)
}

main().catch(error => {
  say(`selftest crashed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  process.exit(1)
})
