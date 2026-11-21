/**
 * Offline test for the per-ticket worktree isolation.
 *   node test/worktree.test.mjs
 *
 * It builds a throwaway git repository, prepares two tickets, proves the checkouts do not see
 * each other's edits, and checks cleanup plus the "not a repository" fallback.
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { WorktreeManager } from '../lib/worktree.js'

const exec = promisify(execFile)
const git = async (cwd, ...args) => (await exec('git', ['-C', cwd, ...args], { windowsHide: true })).stdout

const root = await mkdtemp(join(tmpdir(), 'sa-wt-'))
const repo = join(root, 'repo')
await exec('git', ['init', '-q', '-b', 'main', repo], { windowsHide: true })
await git(repo, 'config', 'user.email', 'test@example.com')
await git(repo, 'config', 'user.name', 'Test')
await writeFile(join(repo, 'README.md'), '# demo\n', 'utf8')
await git(repo, 'add', '-A')
await git(repo, 'commit', '-q', '-m', 'init')

const manager = new WorktreeManager({ rootDir: join(root, 'worktrees') })

// 1. two tickets on one repository get independent checkouts, branches and base commits
const first = await manager.prepare({ repoDir: repo, ticketId: 't-01' })
const second = await manager.prepare({ repoDir: repo, ticketId: 't-02' })
assert.ok(first && second, 'both worktrees prepared')
assert.notEqual(first.path, second.path)
assert.equal(first.branch, 'sa/t-01')
assert.equal(second.branch, 'sa/t-02')
assert.equal(first.reused, false)
assert.ok(existsSync(join(first.path, 'README.md')))

// 2. an edit in one checkout is invisible in the other and does not dirty the main tree
await writeFile(join(first.path, 'README.md'), '# demo\nchanged by ticket one\n', 'utf8')
await writeFile(join(first.path, 'new-file.txt'), 'only ticket one\n', 'utf8')
const dirtyFirst = await manager.status(first)
const dirtySecond = await manager.status(second)
assert.equal(dirtyFirst.dirty, true)
assert.ok(dirtyFirst.changedFiles.includes('README.md'))
assert.equal(dirtySecond.dirty, false)
assert.equal(await readFile(join(repo, 'README.md'), 'utf8'), '# demo\n', 'the main tree stays untouched')
assert.equal(await git(repo, 'status', '--porcelain'), '', 'the main index stays clean')

// 3. preparing the same ticket again reuses its checkout
const again = await manager.prepare({ repoDir: repo, ticketId: 't-01' })
assert.equal(again.reused, true)
assert.equal(again.path, first.path)

// 4. listing survives and returns both tickets
assert.equal((await manager.list()).length, 2)

// 5. dispose removes the checkout; the branch survives when asked to keep it
await manager.dispose(first, { keep: true })
assert.equal(existsSync(first.path), false)
assert.equal((await manager.list()).length, 1)

// 6. a non-git directory is refused instead of throwing
const plain = join(root, 'plain')
await mkdir(plain, { recursive: true })
await writeFile(join(plain, 'x.txt'), 'x', 'utf8')
let plainResult = null
try { plainResult = await manager.prepare({ repoDir: plain, ticketId: 't-99' }) } catch (error) { plainResult = { threw: String(error) } }
assert.equal(plainResult, null, 'a non-repository directory yields null')

await manager.dispose(second, { keep: false })
console.log('worktree: 6/6 checks passed')
process.exit(0)
