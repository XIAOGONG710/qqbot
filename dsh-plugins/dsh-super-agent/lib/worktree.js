/**
 * Per-ticket git worktrees: the isolation the paper needs for "多个 Worker 并行、上下文隔离".
 *
 * Every ticket gets its own checkout under `<rootDir>/<repoSlug>/<ticketId>` on its own branch
 * (`sa/<ticketId>`), created from the repository's current HEAD. Two tickets on the same
 * repository therefore edit independent trees and never race on the index, the working copy, or
 * a lock file. A WorktreeManager owns a small registry so worktrees survive a Host restart and
 * can be listed, inspected and removed later.
 *
 * No DSH import, no third-party dependency: only `node:child_process`, `node:fs`, `node:path`.
 */
import { execFile } from 'node:child_process'
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'

const DEFAULT_TIMEOUT_MS = 120_000

/** Runs one command and resolves with its outcome; never rejects on a non-zero exit. */
function run(gitPath, args, opts = {}) {
  return new Promise(resolvePromise => {
    execFile(gitPath, args, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      resolvePromise({
        code: error ? (typeof error.code === 'number' ? error.code : 1) : 0,
        stdout: String(stdout ?? ''),
        stderr: String(error && error.code === undefined ? (stderr || error.message) : (stderr ?? '')),
      })
    })
  })
}

const slugify = (text) => String(text).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'repo'

export class WorktreeManager {
  constructor({ rootDir, gitPath = 'git', log } = {}) {
    if (!rootDir) throw new Error('WorktreeManager needs rootDir')
    this.rootDir = resolve(rootDir)
    this.gitPath = gitPath
    this.log = typeof log === 'function' ? log : () => {}
    this.registryPath = join(this.rootDir, 'index.json')
    this.entries = new Map()
    this.loaded = false
  }

  async load() {
    if (this.loaded) return this
    try {
      const raw = JSON.parse(await readFile(this.registryPath, 'utf8'))
      for (const entry of Array.isArray(raw?.entries) ? raw.entries : []) {
        if (entry && typeof entry.ticketId === 'string' && typeof entry.path === 'string') this.entries.set(entry.ticketId, entry)
      }
    } catch { /* first run, or a damaged registry: start empty */ }
    this.loaded = true
    return this
  }

  async save() {
    await mkdir(this.rootDir, { recursive: true })
    const payload = { version: 1, savedAt: Date.now(), entries: [...this.entries.values()] }
    await writeFile(`${this.registryPath}.tmp`, JSON.stringify(payload, null, 2), 'utf8')
    await writeFile(this.registryPath, JSON.stringify(payload, null, 2), 'utf8')
  }

  /** True when `dir` is inside a git work tree; returns the repo root, or undefined. */
  async repoRoot(dir) {
    if (!dir) return undefined
    const result = await run(this.gitPath, ['-C', dir, 'rev-parse', '--show-toplevel'])
    if (result.code !== 0) return undefined
    return result.stdout.trim()
  }

  /**
   * Creates (or reuses) the isolated worktree for one ticket.
   * Returns `null` when `repoDir` is not a git repository, so the caller can fall back to the
   * shared directory instead of failing the ticket.
   */
  async prepare({ repoDir, ticketId, branchPrefix = 'sa/', baseRef = 'HEAD' } = {}) {
    await this.load()
    if (!ticketId) throw new Error('prepare needs ticketId')
    const root = await this.repoRoot(repoDir)
    if (!root) {
      this.log('warn', `worktree: ${repoDir} is not a git work tree`)
      return null
    }
    const key = String(ticketId)
    const existing = this.entries.get(key)
    if (existing && existing.path) {
      const inside = await this.repoRoot(existing.path)
      if (inside) return { ...existing, reused: true }
      this.entries.delete(key)
    }
    const branch = `${branchPrefix}${slugify(ticketId)}`
    const slug = `${slugify(basename(root))}-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`
    const path = join(this.rootDir, slug, slugify(ticketId))
    await mkdir(dirname(path), { recursive: true })

    // A leftover directory that git does not know about would make `worktree add` fail.
    try {
      const stat = await readFile(join(path, '.git'), 'utf8')
      void stat
    } catch {
      await rm(path, { recursive: true, force: true }).catch(() => {})
    }

    let created = await run(this.gitPath, ['-C', root, 'worktree', 'add', '-b', branch, path, baseRef])
    if (created.code !== 0 && /already exists/i.test(created.stderr)) {
      // The branch survived a previous run: attach the worktree to it instead of creating another.
      created = await run(this.gitPath, ['-C', root, 'worktree', 'add', path, branch])
    }
    if (created.code !== 0) {
      this.log('warn', `worktree add failed for ${key}: ${created.stderr.trim().split('\n').slice(-1)[0]}`)
      return null
    }
    const head = await run(this.gitPath, ['-C', path, 'rev-parse', 'HEAD'])
    const entry = {
      ticketId: key,
      repoDir: root,
      path,
      branch,
      baseSha: head.stdout.trim(),
      createdAt: Date.now(),
    }
    this.entries.set(key, entry)
    await this.save()
    this.log('info', `worktree ready for ${key} at ${path} (${branch})`)
    return { ...entry, reused: false }
  }

  async status(worktree) {
    if (!worktree?.path) return { dirty: false, changedFiles: [] }
    const result = await run(this.gitPath, ['-C', worktree.path, 'status', '--porcelain'])
    if (result.code !== 0) return { dirty: false, changedFiles: [] }
    const changedFiles = result.stdout.split('\n').map(line => line.slice(3).trim()).filter(Boolean)
    return { dirty: changedFiles.length > 0, changedFiles }
  }

  /** Removes the checkout (and optionally the branch). Never throws. */
  async dispose(worktree, { keep = true } = {}) {
    const entry = worktree?.ticketId ? this.entries.get(worktree.ticketId) : undefined
    const target = worktree ?? entry
    if (!target?.path) return
    try {
      await run(this.gitPath, ['-C', target.repoDir ?? dirname(target.path), 'worktree', 'remove', '--force', target.path])
    } catch { /* the directory may already be gone */ }
    try {
      await rm(target.path, { recursive: true, force: true })
    } catch { /* ignore */ }
    if (!keep && target.branch) {
      await run(this.gitPath, ['-C', target.repoDir ?? dirname(target.path), 'branch', '-D', target.branch]).catch(() => {})
    }
    if (entry) {
      this.entries.delete(entry.ticketId)
      await this.save().catch(() => {})
    }
  }

  /** Every worktree this manager still tracks whose checkout exists. */
  async list() {
    await this.load()
    return [...this.entries.values()]
  }

  /** Drops registry rows whose checkout no longer exists (restart hygiene). */
  async prune() {
    await this.load()
    let changed = false
    for (const entry of [...this.entries.values()]) {
      const inside = await this.repoRoot(entry.path)
      if (!inside) { this.entries.delete(entry.ticketId); changed = true }
    }
    if (changed) await this.save()
    return [...this.entries.values()]
  }
}
