#!/usr/bin/env node
/**
 * Live proof that the GitHub Source adapter works against the real api.github.com.
 *
 *   node scripts/verify-github-source.mjs
 *   GH_REPO=owner/name node scripts/verify-github-source.mjs
 *
 * Unauthenticated. Uses a small public repository (8 open issues) so one poll costs ~9 requests.
 * Verifies: events are produced, their shape is right, a second poll produces none (cursor), and a
 * fresh instance on the same stateDir produces none either (restart safety).
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitHubSource } from '../lib/sources/github.mjs'

const REPO = process.env.GH_REPO || 'openai/openai-node'
const stateDir = await mkdtemp(join(tmpdir(), 'sa-gh-live-'))
const events = []
const log = (level, message) => console.log(`  [${level}] ${message}`)

const source = createGitHubSource({ repos: [REPO], token: '', intervalMs: 0, stateDir, onEvent: event => events.push(event), log })
const first = await source.pollOnce()
console.log(`first poll: ${first} events`)
await source.stop()

if (events.length === 0) {
  console.error('FAIL: the live poll produced no events (the repo may have no open issues)')
  process.exit(1)
}
for (const event of events.slice(0, 3)) {
  console.log(`  · ${event.source} ${event.threadId} @${event.author} :: ${String(event.text).slice(0, 60).replace(/\n/g, ' ')}`)
}
const sample = events[0]
const problems = []
if (sample.source !== 'github') problems.push('source')
if (!/^github:[^#]+#\d+$/.test(sample.threadId ?? '')) problems.push('threadId')
if (!sample.externalId) problems.push('externalId')
if (!sample.url) problems.push('url')
if (!sample.author) problems.push('author')
if (problems.length > 0) {
  console.error(`FAIL: bad event shape: ${problems.join(', ')}`)
  process.exit(1)
}

const second = await source.pollOnce()
console.log(`second poll in the same instance: ${second} new events (expected 0)`)
if (second !== 0) { console.error('FAIL: cursor did not deduplicate'); process.exit(1) }
await source.stop()

const restarted = []
const again = createGitHubSource({ repos: [REPO], token: '', intervalMs: 0, stateDir, onEvent: event => restarted.push(event), log })
const afterRestart = await again.pollOnce()
console.log(`fresh instance on the same stateDir: ${afterRestart} new events (expected 0)`)
await again.stop()
if (afterRestart !== 0) { console.error('FAIL: a restarted source replayed events'); process.exit(1) }

await writeFile(join(stateDir, 'events.json'), JSON.stringify(events.slice(0, 20), null, 2), 'utf8')
console.log(`\nOK — live GitHub source: ${events.length} events, dedupe + restart safe (sample in ${stateDir})`)
process.exit(0)
