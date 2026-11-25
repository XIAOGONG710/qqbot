import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHandler } from '../dsh-plugins/dsh-qqbot-services/index.js'
import { homeSceneState } from '../dsh-plugins/dsh-qqbot-services/home-scene/state.js'

test('the 3D marker follows only a current, recognized publication', () => {
  const at = 1000
  const data = {
    places: { study: '书房', outside: '在外面' },
    activities: { reading: '看书', walking: '走走' },
    status: { place: 'study', doing: 'reading', at, privateText: '不得展示' },
  }
  assert.deepEqual(homeSceneState(data, at + 1), { place: 'study', label: '书房 · 看书', marker: 'study' })
  assert.equal(homeSceneState({ ...data, status: null }, at), null)
  assert.equal(homeSceneState(data, at + 3_600_000), null)
  assert.equal(homeSceneState(data, at - 1), null)
  assert.equal(homeSceneState({ ...data, status: { ...data.status, place: 'hallway' } }, at), null)
  assert.deepEqual(homeSceneState({ ...data, status: { place: 'outside', doing: 'walking', at } }, at),
    { place: 'outside', label: '在外面 · 走走', marker: null })
})

test('the local 3D scene and dependencies require the host owner session', async () => {
  const connection = { authorizeIndex: req => req.headers.cookie === 'test-session=owner' }
  let homeReads = 0
  const handler = createHandler({}, () => [], undefined, connection, Date.now, undefined, {
    home: () => { homeReads++; return { status: null } },
  })
  const call = async (route, cookie) => {
    let status, headers, body
    await handler({ method: 'GET', url: '/api/qqbot-services/home/scene/' + route, headers: { host: '127.0.0.1', cookie },
      socket: { remoteAddress: '127.0.0.1' } },
    { writeHead(code, outputHeaders) { status = code; headers = outputHeaders }, end(value) { body = String(value) } })
    return { status, headers, body }
  }
  assert.equal((await call('')).status, 403)
  assert.equal((await call('scene.js', 'guest=untrusted')).status, 403)
  const page = await call('', 'test-session=owner')
  assert.equal(page.status, 200)
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'self'/)
  assert.match(page.body, /type="module" src="scene.js"/)
  const script = await call('scene.js', 'test-session=owner')
  assert.equal(script.status, 200)
  assert.match(script.body, /fetch\(['"]\/api\/qqbot-services\/home['"]/)
  assert.doesNotMatch(script.body, /NOW\.md|JOURNAL|privateChat/i)
  assert.equal((await call('three.module.min.js', 'test-session=owner')).status, 200)
  assert.equal((await call('../private.json', 'test-session=owner')).status, 404)
  assert.equal(homeReads, 0, 'serving scene assets does not read any published status')
})
