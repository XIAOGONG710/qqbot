#!/usr/bin/env node
/**
 * Publish the working tree to GitHub through the REST + Git Data API.
 *
 * Useful when `github.com:443` is unreachable but `api.github.com` is, or when you want one commit
 * per publish without a local git remote. It behaves like `git add -A && git commit && git push`:
 * blobs → tree → commit (parented on the current branch head) → ref update, plus an annotated tag.
 *
 *   GITHUB_TOKEN=ghp_xxx node tools/publish-github.mjs --owner aowind --repo dsh-super-agent
 *   node tools/publish-github.mjs --dry-run
 *
 * The token is read from the environment (or `--token`) and is never written to disk.
 */
import { readFileSync, lstatSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback
}
const has = name => args.includes(`--${name}`)

const API = 'https://api.github.com'
const root = flag('dir', '.')
const owner = flag('owner', 'aowind')
const repo = flag('repo', 'dsh-super-agent')
const tag = flag('tag', '')
const branch = flag('branch', 'main')
const message = flag('message', 'chore: sync working tree')
const description = flag('description', 'Router/Worker two-layer autonomous agent system for DeepSeek Harness: two-stage trigger admission, per-ticket worktrees, delivery closed loop, watchdog, attention gate, and a live console.')
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || flag('token', '')
const dryRun = has('dry-run')
const force = has('force')

const SKIP = new Set(['.git', 'node_modules', 'artifacts', 'worktrees'])

async function walk(dir, base = dir) {
  const out = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await walk(full, base))
    else if (entry.isFile()) out.push({ full, path: relative(base, full).split(sep).join('/'), size: lstatSync(full).size })
  }
  return out
}

async function call(method, path, body) {
  const response = await fetch(`${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-super-agent-publisher',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  let json = null
  try { json = text === '' ? null : JSON.parse(text) } catch { /* non-JSON error body */ }
  return { status: response.status, ok: response.ok, json, text }
}

const files = await walk(root)
const total = files.reduce((sum, file) => sum + file.size, 0)
console.log(`source: ${root} · ${files.length} files · ${(total / 1024).toFixed(0)} KiB · ${owner}/${repo}@${branch}`)

if (dryRun) {
  for (const file of files) console.log(`  ${file.path} (${file.size}B)`)
  console.log('\ndry run: nothing uploaded')
  process.exit(0)
}
if (!token) {
  console.error('missing token: set GITHUB_TOKEN (repo scope) or pass --token')
  process.exit(2)
}

// 1. identity
const me = await call('GET', '/user')
if (!me.ok) {
  console.error(`token rejected: ${me.status} ${me.text.slice(0, 200)}`)
  process.exit(1)
}
console.log(`authenticated as ${me.json.login}`)

// 2. repository exists? create it when missing.
let repoInfo = await call('GET', `/repos/${owner}/${repo}`)
if (repoInfo.status === 404) {
  repoInfo = await call('POST', '/user/repos', {
    name: repo,
    description,
    private: false,
    has_issues: true,
    has_wiki: false,
    has_projects: false,
    auto_init: false,
  })
  if (!repoInfo.ok) {
    console.error(`create repo failed: ${repoInfo.status} ${repoInfo.text.slice(0, 400)}`)
    process.exit(1)
  }
  console.log(`created public repo ${owner}/${repo}`)
} else if (!repoInfo.ok) {
  console.error(`read repo failed: ${repoInfo.status} ${repoInfo.text.slice(0, 300)}`)
  process.exit(1)
}

// 3. an empty repository refuses the Git Data API until it has one commit.
const contentsProbe = await call('GET', `/repos/${owner}/${repo}/contents/`)
if (!contentsProbe.ok || (Array.isArray(contentsProbe.json) && contentsProbe.json.length === 0)) {
  const seed = await call('PUT', `/repos/${owner}/${repo}/contents/.gitkeep`, {
    message: 'chore: initialize repository',
    content: Buffer.from('\n', 'utf8').toString('base64'),
  })
  if (!seed.ok) {
    console.error(`seed commit failed: ${seed.status} ${seed.text.slice(0, 300)}`)
    process.exit(1)
  }
  console.log('seeded the empty repository with an initial commit')
}

// 4. blobs
const treeEntries = []
for (const file of files) {
  const content = readFileSync(file.full).toString('base64')
  const blob = await call('POST', `/repos/${owner}/${repo}/git/blobs`, { content, encoding: 'base64' })
  if (!blob.ok) {
    console.error(`blob ${file.path} failed: ${blob.status} ${blob.text.slice(0, 200)}`)
    process.exit(1)
  }
  treeEntries.push({ path: file.path, mode: '100644', type: 'blob', sha: blob.json.sha })
  process.stdout.write('.')
}
process.stdout.write('\n')
console.log(`uploaded ${treeEntries.length} blobs`)

// 5. tree → commit (with the current branch head as parent) → ref
const tree = await call('POST', `/repos/${owner}/${repo}/git/trees`, { tree: treeEntries })
if (!tree.ok) {
  console.error(`tree failed: ${tree.status} ${tree.text.slice(0, 300)}`)
  process.exit(1)
}
const head = await call('GET', `/repos/${owner}/${repo}/git/ref/heads/${branch}`)
if (head.ok && !force && process.env.ALLOW_REWRITE !== '1') {
  // A normal publish appends a commit; rewrites are opt-in.
}
const parents = head.ok ? [head.json.object.sha] : []
const commit = await call('POST', `/repos/${owner}/${repo}/git/commits`, {
  message,
  tree: tree.json.sha,
  parents,
})
if (!commit.ok) {
  console.error(`commit failed: ${commit.status} ${commit.text.slice(0, 300)}`)
  process.exit(1)
}
const ref = head.ok
  ? await call('PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, { sha: commit.json.sha, force: true })
  : await call('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.json.sha })
if (!ref.ok) {
  console.error(`ref failed: ${ref.status} ${ref.text.slice(0, 300)}`)
  process.exit(1)
}
console.log(`pushed ${branch} @ ${commit.json.sha.slice(0, 12)} (${parents.length ? 'on top of ' + parents[0].slice(0, 12) : 'root commit'})`)

// 6. optional annotated tag
if (tag !== '') {
  const existing = await call('GET', `/repos/${owner}/${repo}/git/ref/tags/${tag}`)
  if (existing.ok && !force) {
    console.log(`tag ${tag} already exists; skipped (pass --force to move it)`)
  } else {
    const tagObject = await call('POST', `/repos/${owner}/${repo}/git/tags`, {
      tag,
      message: `Super Agent ${tag}`,
      object: commit.json.sha,
      type: 'commit',
    })
    if (tagObject.ok) {
      const tagRef = existing.ok
        ? await call('PATCH', `/repos/${owner}/${repo}/git/refs/tags/${tag}`, { sha: tagObject.json.sha, force: true })
        : await call('POST', `/repos/${owner}/${repo}/git/refs`, { ref: `refs/tags/${tag}`, sha: tagObject.json.sha })
      console.log(tagRef.ok ? `tagged ${tag}` : `tag ref failed: ${tagRef.status} ${tagRef.text.slice(0, 200)}`)
    } else {
      console.log(`tag object failed: ${tagObject.status} ${tagObject.text.slice(0, 200)}`)
    }
  }
}

// 7. verify
const final = await call('GET', `/repos/${owner}/${repo}`)
console.log(`\nrepository: ${final.json?.html_url ?? `https://github.com/${owner}/${repo}`}`)
console.log(`default branch: ${final.json?.default_branch ?? branch} · private: ${final.json?.private ?? false}`)
process.exit(0)
