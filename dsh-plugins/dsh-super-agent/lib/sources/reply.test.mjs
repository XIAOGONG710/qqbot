/**
 * Offline checks for the source-reply hop.
 *   node lib/sources/reply.test.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseGitHubTarget, replyToGitHub, replyToInbox, replyToSource, replyBody } from './reply.mjs'

let passed = 0
let failed = 0
const check = (name, fn) => {
  try {
    fn()
    passed += 1
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error?.message ?? error}`)
  }
}

// --- parseGitHubTarget -------------------------------------------------------
check('parses issue and pull URLs', () => {
  assert.deepEqual(parseGitHubTarget('https://github.com/acme/demo/issues/42'), { repo: 'acme/demo', number: 42 })
  assert.deepEqual(parseGitHubTarget('https://github.com/acme/demo/pull/7'), { repo: 'acme/demo', number: 7 })
  assert.equal(parseGitHubTarget('https://gitlab.com/acme/demo/issues/1'), null)
  assert.equal(parseGitHubTarget(''), null)
  assert.equal(parseGitHubTarget(null), null)
})

// --- replyToInbox ------------------------------------------------------------
const dir = await mkdtemp(join(tmpdir(), 'sa-reply-'))
check('writes an inbox receipt with the delivery fields', async () => {
  const result = await replyToInbox({
    dir,
    ticket: { id: 't-01', title: '修 README', threadId: 'inbox:1' },
    result: { status: 'patch', branch: 'sa/t-01', commit: 'abc123', changedFiles: ['README.md'] },
    summary: '改好了',
  })
  assert.equal(result.ok, true)
  const receipt = JSON.parse(await readFile(result.path, 'utf8'))
  assert.equal(receipt.ticketId, 't-01')
  assert.equal(receipt.status, 'patch')
  assert.equal(receipt.branch, 'sa/t-01')
  assert.deepEqual(receipt.changedFiles, ['README.md'])
  assert.match(receipt.repliedAt, /^\d{4}-\d{2}-\d{2}T/)
  assert.ok((await readdir(join(dir, 'outbox'))).some(name => name.endsWith('.json')))
})
check('refuses an unconfigured inbox', async () => {
  assert.equal((await replyToInbox({ dir: '', ticket: { id: 'x' }, result: {} })).ok, false)
})

// --- replyToGitHub -----------------------------------------------------------
check('posts a comment and returns its URL', async () => {
  const calls = []
  const reply = await replyToGitHub({
    repo: 'acme/demo', number: 42, token: 'tok', body: 'done',
    fetchImpl: async (url, init) => {
      calls.push({ url, init })
      return { ok: true, status: 201, json: async () => ({ html_url: 'https://github.com/acme/demo/issues/42#c1' }) }
    },
  })
  assert.equal(reply.ok, true)
  assert.equal(reply.url, 'https://github.com/acme/demo/issues/42#c1')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/repos\/acme\/demo\/issues\/42\/comments$/)
  assert.equal(calls[0].init.method, 'POST')
  assert.match(calls[0].init.headers.authorization, /^Bearer tok$/)
})
check('a failed GitHub call does not throw', async () => {
  const reply = await replyToGitHub({
    repo: 'acme/demo', number: 42, token: 'tok', body: 'x',
    fetchImpl: async () => ({ ok: false, status: 403, text: async () => 'nope' }),
  })
  assert.equal(reply.ok, false)
  assert.equal(reply.status, 403)
})
check('no token means no request', async () => {
  let called = 0
  const reply = await replyToGitHub({ repo: 'acme/demo', number: 1, token: '', body: 'x', fetchImpl: async () => { called += 1 } })
  assert.equal(reply.ok, false)
  assert.equal(called, 0)
})

// --- body + routing ----------------------------------------------------------
check('the reply body carries status, branch and the review hint', () => {
  const body = replyBody({
    ticket: { id: 't-02', title: '修 bug' },
    result: { status: 'patch', branch: 'sa/t-02', changedFiles: ['a.ts'] },
    summary: '已完成',
  })
  assert.match(body, /t-02/)
  assert.match(body, /sa\/t-02/)
  assert.match(body, /需要人验收/)
  assert.match(body, /a\.ts/)
})
check('routes github tickets through the API and inbox tickets to the outbox', async () => {
  const github = await replyToSource({
    ticket: { source: 'github', url: 'https://github.com/acme/demo/issues/9', id: 't-03' },
    result: { status: 'pr', prUrl: 'https://github.com/acme/demo/pull/10' },
    summary: 'ok',
    config: { github: { token: 'tok' } },
    fetchImpl: async () => ({ ok: true, status: 201, json: async () => ({ html_url: 'u' }) }),
  })
  assert.equal(github.ok, true)
  assert.equal(github.channel, 'github')

  const inbox = await replyToSource({
    ticket: { source: 'inbox', id: 't-04', threadId: 'inbox' },
    result: { status: 'patch' },
    summary: 'ok',
    config: { inbox: { dir } },
  })
  assert.equal(inbox.ok, true)
  assert.equal(inbox.channel, 'inbox')

  const none = await replyToSource({ ticket: { source: 'console', id: 't-5' }, result: {}, config: {} })
  assert.equal(none.ok, false)
})
check('a github ticket without a token reports the missing credential', async () => {
  const reply = await replyToSource({
    ticket: { source: 'github', url: 'https://github.com/acme/demo/issues/9', id: 't-06' },
    result: { status: 'patch' },
    config: { github: { token: '' } },
  })
  assert.equal(reply.ok, false)
  assert.equal(reply.channel, 'github')
})

console.log(`\nreply: ${passed}/${passed + failed} checks passed`)
process.exit(failed === 0 ? 0 : 1)
