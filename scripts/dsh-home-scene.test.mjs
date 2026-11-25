import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHandler } from '../dsh-plugins/dsh-qqbot-services/index.js'
import { homeSceneState } from '../dsh-plugins/dsh-qqbot-services/home-scene/state.js'
import { createHouseAvatar, poseForActivity } from '../dsh-plugins/dsh-qqbot-services/home-scene/avatar.js'
import {
  homeActivities, homePlaces, publishHomeStatus, publishedHomeStatus, readPublishedHomeStatus,
} from '../dsh-plugins/dsh-linmengyao-memory/home-status.js'

test('published activities select an original in-place pose, without inventing movement across rooms', () => {
  const avatar = createHouseAvatar()
  assert.equal(poseForActivity('reading'), 'book')
  assert.equal(poseForActivity('hidden-private-activity'), null)
  avatar.frame(poseForActivity('walking'), 2)
  assert.deepEqual(avatar.root.position.toArray(), [0, 0, 0])
  assert.ok(avatar.root.children[0].position.y > 0)
})

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

function space() {
  const dir = mkdtempSync(join(tmpdir(), 'home-status-'))
  return { file: join(dir, 'HOME-PUBLIC.json'), done: () => rmSync(dir, { recursive: true, force: true }) }
}

test('publishing writes only the public fields and can be withdrawn', () => {
  const { file, done } = space()
  try {
    publishHomeStatus(file, { place: 'study', doing: 'reading' }, 1_000)
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual(Object.keys(raw).sort(), ['at', 'audience', 'doing', 'place', 'version'])
    assert.deepEqual(publishedHomeStatus(raw, 1_000), { place: 'study', doing: 'reading', at: 1_000 })
    assert.deepEqual(readPublishedHomeStatus(file), null, 'an old timestamp is not public any more')

    publishHomeStatus(file, { hide: true }, 2_000)
    assert.equal(readFileSync(file, 'utf8'), 'null')
    assert.equal(readPublishedHomeStatus(file), null)
  } finally { done() }
})

test('publishing refuses unknown places, activities and audiences', () => {
  const { file, done } = space()
  try {
    assert.throws(() => publishHomeStatus(file, { place: 'attic', doing: 'reading' }, 1_000))
    assert.throws(() => publishHomeStatus(file, { place: 'study', doing: 'singing' }, 1_000))
    assert.equal(publishedHomeStatus({ version: 1, audience: 'room', place: 'study', doing: 'reading', at: 1_000 }, 1_000), null)
  } finally { done() }
})

test('a broken or missing status file reads as nothing instead of throwing', () => {
  const { file, done } = space()
  try {
    writeFileSync(file, '{ 半个 JSON')
    assert.equal(readPublishedHomeStatus(file), null)
    rmSync(file)
    assert.equal(readPublishedHomeStatus(file), null)
  } finally { done() }
})

test('a fast clock walks her through published rooms and then out of sight', () => {
  const { file, done } = space()
  const view = now => homeSceneState({
    places: homePlaces,
    activities: homeActivities,
    status: publishedHomeStatus(JSON.parse(readFileSync(file, 'utf8')), now),
  }, now)
  try {
    let now = 10_000
    publishHomeStatus(file, { place: 'living', doing: 'tidying' }, now)
    assert.equal(view(now).marker, 'living')
    now += 10 * 60_000
    publishHomeStatus(file, { place: 'kitchen', doing: 'cooking' }, now)
    assert.equal(view(now).marker, 'kitchen')
    now += 10 * 60_000
    publishHomeStatus(file, { place: 'garden', doing: 'resting' }, now)
    assert.equal(view(now).marker, 'garden')
    now += 20 * 60_000
    publishHomeStatus(file, { place: 'outside', doing: 'walking' }, now)
    assert.equal(view(now).marker, null)
    assert.match(view(now).label, /在外面/)
    now += 60 * 60_000
    assert.equal(view(now), null)
    publishHomeStatus(file, { place: 'living', doing: 'reading' }, now)
    publishHomeStatus(file, { hide: true }, now + 1_000)
    assert.equal(view(now + 1_000), null)
  } finally { done() }
})
