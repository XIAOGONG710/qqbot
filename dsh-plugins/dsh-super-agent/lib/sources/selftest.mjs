/**
 * Self-test for the Super Agent event sources: `node lib/sources/selftest.mjs`.
 *
 * Covers the three acceptance areas from the contract (§4): inbox idempotency and
 * file renames, GitHub polling cursors over an injected `fetchImpl`, and webhook
 * signature verification plus payload normalization. Everything runs in a fresh
 * `os.tmpdir()` directory that is removed afterwards; exit code 0 = all green.
 */
import { createHmac } from 'node:crypto'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createGitHubSource } from './github.mjs'
import { createInboxSource } from './local-inbox.mjs'
import { parseCIWebhook, parseGitHubWebhook, verifySignature } from './webhook.mjs'

const REPO = 'acme/widget'

// ------------------------------------------------------------------ harness

const results = []

function assert(condition, message) {
  if (!condition) throw new Error(message || '断言失败')
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

async function test(name, fn) {
  try {
    await fn()
    results.push({ name, ok: true })
    console.log(`ok   ${name}`)
  } catch (error) {
    results.push({ name, ok: false, error })
    console.log(`FAIL ${name}\n     ${String(error?.message ?? error)}`)
  }
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

async function waitFor(predicate, { timeoutMs = 4000, intervalMs = 15, label = '条件' } = {}) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return
    await sleep(intervalMs)
  }
  throw new Error(`等待超时：${label}`)
}

const exists = async path => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

// --------------------------------------------------------------- inbox tests

async function inboxSuite(root) {
  await test('inbox: start() 立即扫描，缺省 source=inbox / human=true，文件改名为 .done.json', async () => {
    const dir = join(root, 'inbox-a')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'one.json'), JSON.stringify({ text: '登录接口 500，复现见附件', author: 'alice' }), 'utf8')
    const events = []
    const source = createInboxSource({ dir, intervalMs: 30, onEvent: event => { events.push(event) }, log: () => {} })
    try {
      source.start()
      await waitFor(() => events.length === 1, { label: '首个事件投递' })
      const event = events[0]
      assertEqual(event.source, 'inbox', 'source 缺省值')
      assertEqual(event.human, true, 'human 缺省值')
      assertEqual(event.author, 'alice', 'author')
      assertEqual(event.text, '登录接口 500，复现见附件', 'text')
      assertEqual(event.externalId, 'inbox:one.json', 'externalId 回退为文件名')
      assertEqual(event.meta.name, 'one.json', 'meta.name')
      assert(event.meta.file.endsWith('one.json'), 'meta.file 指向原文件')
      await waitFor(() => exists(join(dir, 'one.done.json')), { label: '.done.json 改名' })
      assert(!(await exists(join(dir, 'one.json'))), '原文件应已改名')
    } finally {
      await source.stop()
    }
  })

  await test('inbox: 目录不存在时自动 mkdir -p', async () => {
    const dir = join(root, 'inbox-missing', 'nested')
    assert(!(await exists(dir)), '前置条件：目录不存在')
    const source = createInboxSource({ dir, intervalMs: 30, onEvent: () => {}, log: () => {} })
    try {
      source.start()
      await waitFor(() => exists(dir), { label: '目录自动创建', timeoutMs: 2000 })
    } finally {
      await source.stop()
    }
  })

  await test('inbox: 同一 externalId 只投一次（两个文件也只投一条）', async () => {
    const dir = join(root, 'inbox-dup')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.json'), JSON.stringify({ text: '第一条重复事件', externalId: 'dup-1' }), 'utf8')
    await writeFile(join(dir, 'b.json'), JSON.stringify({ text: '第二条重复事件', externalId: 'dup-1' }), 'utf8')
    const events = []
    const source = createInboxSource({ dir, intervalMs: 30, onEvent: event => { events.push(event) }, log: () => {} })
    try {
      source.start()
      await waitFor(() => exists(join(dir, 'a.done.json')) && exists(join(dir, 'b.done.json')), { label: '两个文件都完成' })
      assertEqual(events.length, 1, '重复 externalId 事件数')
      assertEqual(events[0].externalId, 'dup-1', '保留首条事件')
      assertEqual(events[0].text, '第一条重复事件', '保留首条正文')
    } finally {
      await source.stop()
    }
  })

  await test('inbox: 坏 JSON 与缺少 text 都改成 .failed.json，不投递', async () => {
    const dir = join(root, 'inbox-bad')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'broken.json'), '{ this is not json', 'utf8')
    await writeFile(join(dir, 'notext.json'), JSON.stringify({ source: 'chat', author: 'bob' }), 'utf8')
    const events = []
    const source = createInboxSource({ dir, intervalMs: 30, onEvent: event => { events.push(event) }, log: () => {} })
    try {
      source.start()
      await waitFor(() => exists(join(dir, 'broken.failed.json')), { label: 'broken.failed.json' })
      await waitFor(() => exists(join(dir, 'notext.failed.json')), { label: 'notext.failed.json' })
      assertEqual(events.length, 0, '失败文件不应投递')
    } finally {
      await source.stop()
    }
  })

  await test('inbox: stop() 清 timer 后不再投递，重新 start() 恢复', async () => {
    const dir = join(root, 'inbox-stop')
    await mkdir(dir, { recursive: true })
    const events = []
    const source = createInboxSource({ dir, intervalMs: 30, onEvent: event => { events.push(event) }, log: () => {} })
    try {
      source.start()
      await waitFor(() => exists(dir), { label: '首轮扫描完成', timeoutMs: 2000 })
      await source.stop()
      await writeFile(join(dir, 'late.json'), JSON.stringify({ text: '停止后出现的事件' }), 'utf8')
      await sleep(150)
      assertEqual(events.length, 0, 'stop 后不应投递')
      assert(await exists(join(dir, 'late.json')), '停止期间文件不应被改名')

      const restarted = createInboxSource({ dir, intervalMs: 30, onEvent: event => { events.push(event) }, log: () => {} })
      try {
        restarted.start()
        await waitFor(() => events.length === 1, { label: '重启后投递' })
        assertEqual(events[0].text, '停止后出现的事件', '重启后正文')
      } finally {
        await restarted.stop()
      }
    } finally {
      await source.stop()
    }
  })
}

// -------------------------------------------------------------- github tests

function jsonResponse(status, data, headers = {}) {
  const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]))
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) },
    json: async () => data,
  }
}

function githubFixture() {
  return {
    issues: {
      [REPO]: [
        {
          number: 7,
          title: '登录接口 500',
          body: '复现：POST /login 返回 500',
          state: 'open',
          user: { login: 'alice', type: 'User' },
          updated_at: '2026-01-01T00:00:00Z',
          html_url: `https://github.com/${REPO}/issues/7`,
        },
        {
          number: 8,
          title: 'refactor auth',
          body: 'PR 正文不应该被当成 issue',
          state: 'open',
          pull_request: { url: `https://api.github.com/repos/${REPO}/pulls/8` },
          user: { login: 'dave', type: 'User' },
          updated_at: '2026-01-01T03:00:00Z',
          html_url: `https://github.com/${REPO}/pull/8`,
        },
        {
          number: 9,
          title: '导出超时',
          body: '导出 2G 数据时超时',
          state: 'open',
          user: { login: 'ops-bot', type: 'Bot' },
          updated_at: '2026-01-02T00:00:00Z',
          html_url: `https://github.com/${REPO}/issues/9`,
        },
      ],
    },
    comments: {
      [`${REPO}#7`]: [
        {
          id: 101,
          body: '我也复现了，发生在 SSO 用户',
          user: { login: 'bob', type: 'User' },
          updated_at: '2026-01-01T01:00:00Z',
          html_url: `https://github.com/${REPO}/issues/7#issuecomment-101`,
        },
        {
          id: 102,
          body: 'CI 已跑过一次',
          user: { login: 'ci-bot', type: 'Bot' },
          updated_at: '2026-01-01T02:00:00Z',
          html_url: `https://github.com/${REPO}/issues/7#issuecomment-102`,
        },
      ],
      [`${REPO}#9`]: [
        {
          id: 201,
          body: '导出到 2G 就炸',
          user: { login: 'carol', type: 'User' },
          updated_at: '2026-01-02T01:00:00Z',
          html_url: `https://github.com/${REPO}/issues/9#issuecomment-201`,
        },
      ],
      [`${REPO}#8`]: [],
    },
  }
}

function createFakeFetch(fixture, controls = {}) {
  const calls = []
  const fetchImpl = async input => {
    const url = new URL(String(input))
    calls.push({ url: String(input), path: url.pathname, since: url.searchParams.get('since') })
    if (controls.rateLimitFirst > 0) {
      controls.rateLimitFirst -= 1
      const reset = Math.floor(Date.now() / 1000) + 60
      return jsonResponse(429, { message: 'API rate limit exceeded' }, { 'retry-after': '60', 'x-ratelimit-reset': String(reset) })
    }
    if (controls.networkError) throw new Error('fetch failed: ECONNRESET')
    const issueList = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues$/)
    if (issueList) return jsonResponse(200, fixture.issues[issueList[1]] ?? [])
    const commentList = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/comments$/)
    if (commentList) {
      const key = `${commentList[1]}#${commentList[2]}`
      let list = fixture.comments[key] ?? []
      const since = url.searchParams.get('since')
      if (since) list = list.filter(comment => String(comment.updated_at) > since)
      return jsonResponse(200, list)
    }
    return jsonResponse(404, { message: 'not found' })
  }
  return { fetchImpl, calls }
}

function makeGitHubSource({ root, stateName, fixture, controls, extra = {}, log }) {
  const { fetchImpl, calls } = createFakeFetch(fixture, controls)
  const events = []
  const source = createGitHubSource({
    repos: [REPO],
    intervalMs: 10_000,
    fetchImpl,
    stateDir: join(root, stateName),
    onEvent: event => { events.push(event) },
    log: log ?? (() => {}),
    ...extra,
  })
  return { source, events, calls }
}

async function githubSuite(root) {
  await test('github: 首轮 5 条（2 issue + 3 评论，PR 过滤），二次 0 条，同 stateDir 重启 0 条', async () => {
    const stateName = 'gh-state-main'
    const first = makeGitHubSource({ root, stateName, fixture: githubFixture() })
    try {
      assertEqual(await first.source.pollOnce(), 5, '首轮投递数')
      assertEqual(first.events.length, 5, '首轮事件数')

      const issueEvent = first.events.find(event => event.externalId === `issue:${REPO}#7:2026-01-01T00:00:00Z`)
      assert(issueEvent, '应有 issue 7 正文事件')
      assertEqual(issueEvent.source, 'github', 'source')
      assertEqual(issueEvent.threadId, `github:${REPO}#7`, 'threadId')
      assertEqual(issueEvent.author, 'alice', 'author')
      assertEqual(issueEvent.repo, REPO, 'repo')
      assertEqual(issueEvent.url, `https://github.com/${REPO}/issues/7`, 'url')
      assert(issueEvent.text.includes('登录接口 500') && issueEvent.text.includes('POST /login'), 'issue 正文')

      const botIssue = first.events.find(event => event.externalId === `issue:${REPO}#9:2026-01-02T00:00:00Z`)
      assert(botIssue, 'bot 作者也应产出 issue 事件')
      assertEqual(botIssue.human, false, 'bot issue human=false')

      const botComment = first.events.find(event => event.externalId === `comment:${REPO}@102`)
      assert(botComment, 'bot 评论也应投递（仅标记 human=false）')
      assertEqual(botComment.human, false, 'bot 评论 human=false')
      assertEqual(botComment.threadId, `github:${REPO}#7`, 'bot 评论 threadId')

      const humanComment = first.events.find(event => event.externalId === `comment:${REPO}@101`)
      assert(humanComment, '人工评论事件')
      assertEqual(humanComment.author, 'bob', '评论 author')
      assertEqual(humanComment.human, true, '人工评论 human=true')
      assertEqual(humanComment.url, `https://github.com/${REPO}/issues/7#issuecomment-101`, '评论 url')

      assert(!first.events.some(event => event.threadId === `github:${REPO}#8`), 'PR 不应产生事件')
      assert(!first.calls.some(call => call.path.endsWith('/issues/8/comments')), '不应拉 PR 评论')

      const afterFirst = first.calls.length
      assertEqual(await first.source.pollOnce(), 0, '二次轮询投递数')
      assertEqual(first.events.length, 5, '二次轮询不应新增事件')
      const secondRound = first.calls.slice(afterFirst).filter(call => call.path.endsWith('/comments'))
      assert(secondRound.length > 0, '二次轮询仍应查询评论')
      assert(secondRound.every(call => typeof call.since === 'string' && call.since !== ''), '二次轮询应带 since 游标')
      assertEqual(secondRound[0].since, '2026-01-02T01:00:00Z', 'since 取最新评论 updated_at')
    } finally {
      await first.source.stop()
    }

    // Restart: a brand-new instance reading the same cursor file must replay nothing.
    const restarted = makeGitHubSource({ root, stateName, fixture: githubFixture() })
    try {
      assertEqual(await restarted.source.pollOnce(), 0, '重启后投递数')
      assertEqual(restarted.events.length, 0, '重启后不应有事件')
    } finally {
      await restarted.source.stop()
    }
  })

  await test('github: allowAuthors 精确匹配且不区分大小写', async () => {
    const scoped = makeGitHubSource({
      root,
      stateName: 'gh-state-allow',
      fixture: githubFixture(),
      extra: { allowAuthors: ['ALICE'] },
    })
    try {
      assertEqual(await scoped.source.pollOnce(), 1, '只放行 alice 的 issue 正文')
      assertEqual(scoped.events.length, 1, '事件数')
      assertEqual(scoped.events[0].author, 'alice', '放行作者')
      assertEqual(scoped.events[0].externalId, `issue:${REPO}#7:2026-01-01T00:00:00Z`, '放行事件 id')
      assert(!scoped.events.some(event => event.author === 'bob'), 'bob 应被过滤')
      assert(!scoped.events.some(event => event.author === 'carol'), 'carol 应被过滤')
    } finally {
      await scoped.source.stop()
    }
  })

  await test('github: 429 退避不抛异常且本轮 0 投，退避期不再发请求', async () => {
    const controls = { rateLimitFirst: 1 }
    const limited = makeGitHubSource({ root, stateName: 'gh-state-429', fixture: githubFixture(), controls })
    try {
      let count
      try {
        count = await limited.source.pollOnce()
      } catch (error) {
        throw new Error(`429 不应抛出：${String(error?.message ?? error)}`)
      }
      assertEqual(count, 0, '429 本轮投递数')
      assertEqual(limited.calls.length, 1, '429 后应停止本轮')
      assertEqual(limited.events.length, 0, '429 不应有事件')
      assertEqual(await limited.source.pollOnce(), 0, '退避期间轮询结果')
      assertEqual(limited.calls.length, 1, '退避期间不应再发请求')
    } finally {
      await limited.source.stop()
    }
  })

  await test('github: 网络错误只记 warn 不抛，stop() 正常返回', async () => {
    const logs = []
    const broken = makeGitHubSource({
      root,
      stateName: 'gh-state-net',
      fixture: githubFixture(),
      controls: { networkError: true },
      log: (level, message) => { logs.push(`${level}:${message}`) },
    })
    try {
      let count
      try {
        count = await broken.source.pollOnce()
      } catch (error) {
        throw new Error(`网络错误不应抛出：${String(error?.message ?? error)}`)
      }
      assertEqual(count, 0, '网络错误投递数')
      assert(logs.some(entry => entry.startsWith('warn:')), '应记录 warn 日志')
      assertEqual(broken.events.length, 0, '网络错误不应有事件')
    } finally {
      await broken.source.stop()
    }
  })
}

// ------------------------------------------------------------- webhook tests

function sign(secret, body, algo = 'sha256') {
  return `${algo}=${createHmac(algo, secret).update(body).digest('hex')}`
}

const githubIssuePayload = () => ({
  action: 'opened',
  issue: {
    number: 7,
    title: '登录接口 500',
    body: '复现：POST /login 返回 500',
    state: 'open',
    updated_at: '2026-01-01T00:00:00Z',
    html_url: `https://github.com/${REPO}/issues/7`,
    user: { login: 'alice', type: 'User' },
  },
  repository: { full_name: REPO },
})

const githubCommentPayload = (user = { login: 'bob', type: 'User' }) => ({
  action: 'created',
  issue: { number: 7, title: '登录接口 500' },
  comment: {
    id: 101,
    body: '我也复现了',
    html_url: `https://github.com/${REPO}/issues/7#issuecomment-101`,
    user,
  },
  repository: { full_name: REPO },
})

async function webhookSuite() {
  await test('webhook: verifySignature 正例（sha256/sha1/Buffer）与负例', () => {
    const secret = 's3cret'
    const body = JSON.stringify({ hello: 'world' })
    assertEqual(verifySignature({ secret, body, header: sign(secret, body) }), true, 'sha256 正例')
    assertEqual(verifySignature({ secret, body, header: sign(secret, body, 'sha1'), algo: 'sha1' }), true, 'sha1 正例')
    assertEqual(verifySignature({ secret, body: Buffer.from(body, 'utf8'), header: sign(secret, body) }), true, 'Buffer 正文')
    assertEqual(verifySignature({ secret, body: `${body} `, header: sign(secret, body) }), false, '正文被改')
    assertEqual(verifySignature({ secret: 'wrong', body, header: sign(secret, body) }), false, '密钥错误')
    assertEqual(verifySignature({ secret, body, header: `sha256=${sign(secret, body).slice(-2)}` }), false, '长度不符')
    assertEqual(verifySignature({ secret, body, header: sign(secret, body, 'sha1') }), false, '算法不符')
    assertEqual(verifySignature({ secret, body, header: '' }), false, '空 header')
    assertEqual(verifySignature({ secret: '', body, header: sign('', body) }), false, '空 secret')
    assertEqual(verifySignature({ secret, body, header: 'sha256=zzzz' }), false, '非 hex')
  })

  await test('webhook: GitHub issues 解析（opened/edited 通过，其余与 PR 返回 null）', () => {
    const opened = parseGitHubWebhook({ headers: { 'x-github-event': 'issues' }, payload: githubIssuePayload() })
    assert(opened, 'opened 应产出事件')
    assertEqual(opened.source, 'github', 'source')
    assertEqual(opened.threadId, `github:${REPO}#7`, 'threadId')
    assertEqual(opened.externalId, `issue:${REPO}#7:2026-01-01T00:00:00Z`, 'externalId')
    assertEqual(opened.url, `https://github.com/${REPO}/issues/7`, 'url')
    assertEqual(opened.author, 'alice', 'author')
    assertEqual(opened.human, true, 'human')
    assertEqual(opened.repo, REPO, 'repo')

    const edited = parseGitHubWebhook({ headers: { 'X-GitHub-Event': 'issues' }, payload: { ...githubIssuePayload(), action: 'edited' } })
    assert(edited, 'edited 应产出事件')

    const closed = parseGitHubWebhook({ headers: { 'x-github-event': 'issues' }, payload: { ...githubIssuePayload(), action: 'closed' } })
    assertEqual(closed, null, 'closed 返回 null')

    const prPayload = githubIssuePayload()
    prPayload.issue.pull_request = { url: 'https://api.github.com/repos/acme/widget/pulls/7' }
    assertEqual(parseGitHubWebhook({ headers: { 'x-github-event': 'issues' }, payload: prPayload }), null, 'PR 返回 null')

    // body 是 JSON 字符串时也应能解析
    const fromBody = parseGitHubWebhook({ headers: { 'x-github-event': 'issues' }, body: JSON.stringify(githubIssuePayload()) })
    assert(fromBody, 'body 字符串应能解析')
  })

  await test('webhook: GitHub issue_comment 解析，bot 评论忽略', () => {
    const human = parseGitHubWebhook({ headers: { 'x-github-event': 'issue_comment' }, payload: githubCommentPayload() })
    assert(human, '人工评论应产出事件')
    assertEqual(human.threadId, `github:${REPO}#7`, 'threadId')
    assertEqual(human.externalId, `comment:${REPO}@101`, 'externalId')
    assertEqual(human.author, 'bob', 'author')
    assertEqual(human.text, '我也复现了', 'text')
    assertEqual(human.human, true, 'human')
    assertEqual(human.url, `https://github.com/${REPO}/issues/7#issuecomment-101`, 'url')

    const bot = parseGitHubWebhook({
      headers: { 'x-github-event': 'issue_comment' },
      payload: githubCommentPayload({ login: 'ci-bot', type: 'Bot' }),
    })
    assertEqual(bot, null, 'bot 评论返回 null')

    const botSuffix = parseGitHubWebhook({
      headers: { 'x-github-event': 'issue_comment' },
      payload: githubCommentPayload({ login: 'deploy[bot]', type: 'User' }),
    })
    assertEqual(botSuffix, null, '[bot] 登录名返回 null')

    const edited = parseGitHubWebhook({ headers: { 'x-github-event': 'issue_comment' }, payload: { ...githubCommentPayload(), action: 'edited' } })
    assertEqual(edited, null, 'edited 返回 null')

    const unknown = parseGitHubWebhook({ headers: { 'x-github-event': 'push' }, payload: { action: 'created' } })
    assertEqual(unknown, null, '未知事件返回 null')
  })

  await test('webhook: CI failed 组装文本，成功态忽略', () => {
    const logText = `HEAD-MARKER${'x'.repeat(1500)}TAIL-MARKER`
    const runUrl = 'https://ci.example.com/runs/42'
    const payload = {
      status: 'failed',
      repo: REPO,
      runUrl,
      workflow: 'build',
      sha: 'abcdef1234567890',
      log: logText,
    }
    const event = parseCIWebhook({ headers: { 'content-type': 'application/json' }, payload })
    assert(event, 'failed 应产出事件')
    assertEqual(event.source, 'ci', 'source')
    assertEqual(event.threadId, `ci:${REPO}:build`, 'threadId')
    assertEqual(event.externalId, `ci:${runUrl}`, 'externalId')
    assertEqual(event.url, runUrl, 'url')
    assertEqual(event.human, false, 'human=false')
    assert(event.text.includes('build'), 'text 含 workflow')
    assert(event.text.includes(runUrl), 'text 含 runUrl')
    assert(event.text.includes('TAIL-MARKER'), 'text 含日志尾部')
    assert(!event.text.includes('HEAD-MARKER'), 'text 只保留日志尾部 800 字')
    assert(event.text.length <= 4000, 'text 不超过 4000 字')

    const failure = parseCIWebhook({ payload: { ...payload, status: 'failure' } })
    assert(failure, 'failure 也应产出事件')

    assertEqual(parseCIWebhook({ payload: { ...payload, status: 'success' } }), null, 'success 返回 null')
    assertEqual(parseCIWebhook({ payload: { ...payload, status: 'running' } }), null, 'running 返回 null')
    assertEqual(parseCIWebhook({ payload: null, body: 'not json' }), null, '无法解析返回 null')

    const fromBody = parseCIWebhook({ headers: {}, body: JSON.stringify({ status: 'failed', repo: REPO, sha: 'abc123' }) })
    assert(fromBody, 'body 字符串应能解析')
    assertEqual(fromBody.externalId, 'ci:abc123', '无 runUrl 时用 sha')
  })
}

// -------------------------------------------------------------------- main

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sa-sources-'))
  try {
    await inboxSuite(root)
    await githubSuite(root)
    await webhookSuite()
  } finally {
    await rm(root, { recursive: true, force: true })
  }

  const failed = results.filter(result => !result.ok)
  console.log('')
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  for (const result of failed) console.log(`FAIL ${result.name}: ${String(result.error?.message ?? result.error)}`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

await main()
