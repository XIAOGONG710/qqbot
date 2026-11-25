import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createHandler } from '../dsh-plugins/dsh-qqbot-services/index.js'
import * as THREE from '../dsh-plugins/dsh-qqbot-services/home-scene/three.module.min.js'
import {
  cameraFrustum, cameraPosition, chooseRenderer, clampElevation, clampZoom, defaultView, homeSceneState, homeStatusLifetime as sceneLifetime,
  homeView, rooms, sceneCenter, sceneChrome, viewportSize,
} from '../dsh-plugins/dsh-qqbot-services/home-scene/state.js'
import { createHouseAvatar, poseForActivity } from '../dsh-plugins/dsh-qqbot-services/home-scene/avatar.js'
import {
  homeActivities, homePlaces, homeStatusLifetime, publishHomeStatus, publishedHomeStatus, readPublishedHomeStatus,
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

test('a missing file is "not published", but a broken or unreadable one is a read failure, not silence', () => {
  const { file, done } = space()
  try {
    assert.equal(readPublishedHomeStatus(file), null, 'never published')
    writeFileSync(file, '{ 半个 JSON')
    assert.throws(() => readPublishedHomeStatus(file), SyntaxError)
    rmSync(file)
    mkdirSync(file)
    assert.throws(() => readPublishedHomeStatus(file), /EISDIR|EPERM|EACCES/)
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

// ---- 加速时钟验收：发布 → 换到另一个已公开房间 → 收回 → 再发布 → 过期 → 在外面 → 读取失败 ----

const owner = { host: '127.0.0.1', cookie: 'test-session=owner' }
const lifetime = 3_600_000

// 和 dsh-qqbot-services/index.js 的 home() 同一条路：读白名单文案和 readPublishedHomeStatus(文件)
function homeServer(file) {
  const connection = { authorizeIndex: req => req.headers.cookie === owner.cookie }
  const handler = createHandler({}, () => [], undefined, connection, Date.now, undefined, {
    home: () => ({ places: homePlaces, activities: homeActivities, status: readPublishedHomeStatus(file) }),
  })
  return async (url = '/api/qqbot-services/home') => {
    let status, body
    await handler({ method: 'GET', url, headers: owner, socket: { remoteAddress: '127.0.0.1' } },
      { writeHead(code) { status = code }, end(value) { body = String(value) } })
    return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(body), text: body }
  }
}

// 页面这一刻会显示什么：200 就按响应判断，别的都算读不到（scene.js 的 refresh 也是这样分的）
async function pageView(fetchHome, now) {
  const response = await fetchHome()
  return response.ok ? homeView(await response.json(), now) : homeView(null, now, true)
}

test('accelerated clock: publish, move to another published room, withdraw, republish, expire, go out, fail to read', async () => {
  const { file, done } = space()
  const fetchHome = homeServer(file)
  let now = Date.UTC(2026, 10, 26, 1, 0, 0)
  const clock = { now: () => now }
  const realNow = Date.now
  Date.now = clock.now // 发布和读取都用默认时钟，和线上一样
  const at = async () => pageView(fetchHome, now)
  const step = async (ms, every = 5_000) => {
    const seen = new Set()
    for (let left = ms; left > 0; left -= every) {
      now += Math.min(every, left)
      const view = await at()
      seen.add(`${view.marker}/${view.pose}`)
    }
    return seen
  }
  try {
    // 0. 从没发布过
    assert.deepEqual(await at(), { text: '她现在没有公开状态。', marker: null, position: null, pose: null, expiresIn: null })

    // 1. 在书房看书
    publishHomeStatus(file, { place: 'study', doing: 'reading' })
    assert.deepEqual(await at(), {
      text: '书房 · 看书', marker: 'study', position: { x: rooms.study.x, z: rooms.study.z }, pose: 'book', expiresIn: lifetime,
    })
    // 半小时里每 5 秒看一次：她没再发布，就一直在原地，不自己换房间、不换动作
    assert.deepEqual([...await step(30 * 60_000)], ['study/book'])
    assert.equal((await at()).expiresIn, 30 * 60_000)

    // 2. 换到另一个已公开的房间
    publishHomeStatus(file, { place: 'kitchen', doing: 'cooking' })
    assert.deepEqual(await at(), {
      text: '厨房 · 做饭', marker: 'kitchen', position: { x: rooms.kitchen.x, z: rooms.kitchen.z }, pose: 'work', expiresIn: lifetime,
    })

    // 3. 收回
    now += 60_000
    publishHomeStatus(file, { hide: true })
    assert.equal(readFileSync(file, 'utf8'), 'null')
    assert.deepEqual(await at(), { text: '她现在没有公开状态。', marker: null, position: null, pose: null, expiresIn: null })
    assert.deepEqual([...await step(10 * 60_000)], ['null/null'], 'withdrawn stays withdrawn')

    // 4. 再发布：一小时从这次重新算
    publishHomeStatus(file, { place: 'living', doing: 'resting' })
    const published = now
    assert.equal((await at()).pose, 'sit')
    assert.deepEqual([...await step(lifetime - 5_000)], ['living/sit'])
    now = published + lifetime - 1
    assert.equal((await at()).marker, 'living', 'one millisecond before the hour it is still public')

    // 5. 正好一小时：过期，标记撤下
    now = published + lifetime
    assert.deepEqual(await at(), { text: '她现在没有公开状态。', marker: null, position: null, pose: null, expiresIn: null })
    // 过期后再收回也只是没有公开
    publishHomeStatus(file, { hide: true })
    assert.equal((await at()).text, '她现在没有公开状态。')

    // 6. 在外面：显示文字，不画到任何房间，也不摆动作
    publishHomeStatus(file, { place: 'outside', doing: 'walking' })
    assert.deepEqual(await at(), { text: '在外面 · 走走', marker: null, position: null, pose: null, expiresIn: lifetime })
    assert.deepEqual([...await step(20 * 60_000)], ['null/null'])

    // 7. 读取失败：坏文件、读不了的文件都回 503，页面说「暂时读不到」，不说「没有公开」，也不留旧位置
    writeFileSync(file, '{"version":1,"audience":"owner","place":"stu')
    assert.equal((await fetchHome()).status, 503)
    assert.deepEqual(await at(), { text: '暂时读不到公开状态。', marker: null, position: null, pose: null, expiresIn: null })
    rmSync(file)
    mkdirSync(file)
    assert.equal((await fetchHome()).status, 503)
    assert.equal((await at()).text, '暂时读不到公开状态。')
    rmSync(file, { recursive: true })
    assert.equal((await at()).text, '她现在没有公开状态。', 'a missing file is simply nothing published')

    // 8. 恢复后照常显示
    publishHomeStatus(file, { place: 'balcony', doing: 'zoningOut' })
    assert.deepEqual(await at(), {
      text: '阳台 · 发会儿呆', marker: 'balcony', position: { x: rooms.balcony.x, z: rooms.balcony.z }, pose: 'idle', expiresIn: lifetime,
    })
  } finally {
    Date.now = realNow
    done()
  }
})

test('expiry boundary and clock skew: both layers agree, and a future timestamp stays hidden until its time', () => {
  const at = 5_000_000
  const raw = { version: 1, audience: 'owner', place: 'garden', doing: 'walking', at }
  const page = now => homeSceneState({ places: homePlaces, activities: homeActivities, status: publishedHomeStatus(raw, now) }, now)
  const direct = now => homeSceneState({ places: homePlaces, activities: homeActivities, status: raw }, now)
  for (const [now, visible] of [[at - 1, false], [at, true], [at + lifetime - 1, true], [at + lifetime, false], [at + lifetime + 1, false]]) {
    assert.equal(publishedHomeStatus(raw, now) !== null, visible, `server at ${now - at}`)
    assert.equal(page(now) !== null, visible, `page at ${now - at}`)
    assert.equal(direct(now) !== null, visible, `page without server filter at ${now - at}`)
  }
  // 时钟被往回拨：已发布的状态先藏起来（宁可不显示），追上之后照常显示，但仍在原定时间过期，不会多公开
  assert.equal(homeView({ places: homePlaces, activities: homeActivities, status: raw }, at - 120_000).marker, null)
  assert.equal(homeView({ places: homePlaces, activities: homeActivities, status: raw }, at).expiresIn, lifetime)
  assert.equal(homeView({ places: homePlaces, activities: homeActivities, status: raw }, at + lifetime).marker, null)
  // 两边的公开时长是同一个数
  assert.equal(homeStatusLifetime, lifetime)
  assert.equal(sceneLifetime, homeStatusLifetime)
})

test('malformed statuses and unknown rooms are never drawn, and the published vocabulary has rooms and poses', () => {
  const ok = { version: 1, audience: 'owner', place: 'study', doing: 'reading', at: 1_000 }
  for (const bad of [null, [], 'study', 42, { ...ok, version: 2 }, { ...ok, at: '1000' }, { ...ok, at: 1.5 }, { ...ok, at: Number.MAX_SAFE_INTEGER + 2 },
    { ...ok, place: '__proto__' }, { ...ok, place: 'constructor' }, { ...ok, doing: 'toString' }, { ...ok, place: ['study'] }]) {
    assert.equal(publishedHomeStatus(bad, 1_000), null, JSON.stringify(bad))
  }
  const labels = { places: { ...homePlaces, attic: '阁楼' }, activities: homeActivities }
  // 接口认识、场景里没有几何的房间：不猜画在哪，整条不画
  assert.equal(homeSceneState({ ...labels, status: { place: 'attic', doing: 'reading', at: 1_000 } }, 1_000), null)
  assert.equal(homeSceneState({ ...labels, status: { place: 'hasOwnProperty', doing: 'reading', at: 1_000 } }, 1_000), null)
  assert.equal(homeSceneState({ places: 'study', activities: homeActivities, status: ok }, 1_000), null)
  // 响应不是对象：算读不到，不算没有公开
  for (const data of [null, [], 'oops', 7]) assert.equal(homeView(data, 1_000).text, '暂时读不到公开状态。')
  // 能发布的每个地点在场景里都有房间（或是「在外面」），每个活动都有原地动作：以后加词表时这里先报错
  for (const place of Object.keys(homePlaces)) assert.ok(place === 'outside' || Object.hasOwn(rooms, place), place)
  for (const doing of Object.keys(homeActivities)) assert.ok(poseForActivity(doing), doing)
})

test('every module the scene page loads is on the served whitelist', async () => {
  const fetchHome = homeServer(join(tmpdir(), 'unused-home.json'))
  const seen = new Set()
  const queue = ['scene.js']
  while (queue.length) {
    const name = queue.shift()
    if (seen.has(name)) continue
    seen.add(name)
    const response = await fetchHome('/api/qqbot-services/home/scene/' + name)
    assert.equal(response.status, 200, name)
    for (const [, dep] of response.text.matchAll(/from\s+['"]\.\/([\w.-]+)['"]/g)) queue.push(dep)
  }
  assert.ok(seen.has('state.js') && seen.has('avatar.js') && seen.has('three.module.min.js'))
})

// ---- WebGL 不可用：three 拿不到上下文会抛错，页面只留文字和回退说明 ----

const fakeCanvas = () => ({ style: {}, getContext: () => null, setAttribute() {}, addEventListener() {}, removeEventListener() {} })

test('WebGL unavailable: the renderer choice falls back instead of throwing', () => {
  const quiet = console.error
  console.error = () => {}
  try {
    assert.equal(chooseRenderer(() => new THREE.WebGLRenderer({ canvas: fakeCanvas() })), null)
  } finally { console.error = quiet }
  const fake = { domElement: {} }
  assert.equal(chooseRenderer(() => fake), fake)
  assert.equal(chooseRenderer(() => undefined), null)
  assert.deepEqual(sceneChrome(false), { fallbackHidden: false, navHidden: true })
  assert.deepEqual(sceneChrome(true), { fallbackHidden: true, navHidden: false })
})

test('WebGL unavailable: the real scene.js keeps polling and shows each state on an accelerated clock', async t => {
  const { file, done } = space()
  const fetchHome = homeServer(file)
  const elements = { scene: {}, status: { textContent: '' }, fallback: { hidden: true } }
  const nav = { hidden: false }
  const listeners = {}
  let fetches = 0
  const saved = Object.fromEntries(['document', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'addEventListener']
    .map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
  Object.assign(globalThis, {
    document: { getElementById: id => elements[id], querySelector: selector => (selector === 'nav' ? nav : null), createElementNS: () => fakeCanvas() },
    fetch: async url => { fetches++; assert.equal(url, '/api/qqbot-services/home'); return fetchHome(url) },
    requestAnimationFrame: () => { throw Error('no animation without a renderer') },
    cancelAnimationFrame: () => {},
    addEventListener: (name, fn) => { listeners[name] = fn },
  })
  const quiet = console.error
  console.error = () => {}
  const start = Date.UTC(2026, 10, 26, 2, 0, 0)
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: start })
  const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)) }
  const advance = async ms => { for (let left = ms; left > 0; left -= 5_000) { t.mock.timers.tick(Math.min(5_000, left)); await settle() } }
  const status = () => elements.status.textContent
  try {
    await import(new URL('../dsh-plugins/dsh-qqbot-services/home-scene/scene.js?webgl=off', import.meta.url).href)
    await settle()
    console.error = quiet
    assert.equal(elements.fallback.hidden, false, 'the fallback note is shown')
    assert.equal(nav.hidden, true, 'view buttons are hidden without a 3D view')
    assert.equal(status(), '她现在没有公开状态。')
    assert.equal(fetches, 1)

    publishHomeStatus(file, { place: 'study', doing: 'reading' }, start + 2_000)
    await advance(5_000)
    assert.equal(status(), '书房 · 看书')
    publishHomeStatus(file, { place: 'garden', doing: 'walking' }, start + 7_000)
    await advance(5_000)
    assert.equal(status(), '花园 · 走走')
    publishHomeStatus(file, { hide: true })
    await advance(5_000)
    assert.equal(status(), '她现在没有公开状态。')

    // 再发布后不再更新文件：一小时到点由页面自己撤下，正好落在两次轮询之间
    const published = Date.now() + 2_500
    publishHomeStatus(file, { place: 'kitchen', doing: 'cooking' }, published)
    await advance(5_000)
    assert.equal(status(), '厨房 · 做饭')
    await advance(published + lifetime - 1_000 - Date.now())
    assert.equal(status(), '厨房 · 做饭')
    const polled = fetches
    t.mock.timers.tick(1_000)
    await settle()
    assert.equal(Date.now(), published + lifetime)
    assert.equal(fetches, polled, 'no poll in between: the page withdrew it on its own timer')
    assert.equal(status(), '她现在没有公开状态。')

    publishHomeStatus(file, { place: 'outside', doing: 'walking' })
    await advance(5_000)
    assert.equal(status(), '在外面 · 走走')

    writeFileSync(file, '{ 坏')
    await advance(5_000)
    assert.equal(status(), '暂时读不到公开状态。')
    publishHomeStatus(file, { place: 'living', doing: 'tidying' })
    await advance(5_000)
    assert.equal(status(), '客厅 · 收拾东西', 'recovers on the next poll')

    listeners.pagehide()
    const closed = fetches
    await advance(60_000)
    assert.equal(fetches, closed, 'polling stops when the page goes away')
  } finally {
    console.error = quiet
    for (const [name, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor)
      else delete globalThis[name]
    }
    done()
  }
})

// ---- 窄窗口：默认视角下整座房子都在画面里 ----

test('narrow and odd window sizes keep the whole house in view', () => {
  assert.deepEqual(viewportSize(0, 0, 3), { width: 1, height: 1, pixelRatio: 2 })
  assert.deepEqual(viewportSize(320.6, 640, Number.NaN), { width: 320, height: 640, pixelRatio: 1 })
  assert.equal(clampZoom(10), 1.8)
  assert.equal(clampZoom(0.1), 0.72)
  assert.equal(clampElevation(-1), 0.32)
  assert.equal(clampElevation(9), 1.3)

  // 房子外接盒：地基 15.4×10.8，最高的是花园树冠（约 1.4）
  const corners = []
  for (const x of [-5.8, 9.6]) for (const y of [-0.43, 1.6]) for (const z of [-5.85, 4.95]) corners.push(new THREE.Vector3(x, y, z))
  const extent = (width, height, { angle, elevation, zoom } = defaultView) => {
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100)
    Object.assign(camera, cameraFrustum(width, height, zoom))
    camera.updateProjectionMatrix()
    const { x, y, z } = cameraPosition(angle, elevation)
    camera.position.set(x, y, z)
    camera.lookAt(sceneCenter.x, sceneCenter.y, sceneCenter.z)
    camera.updateMatrixWorld()
    return corners.reduce((max, corner) => {
      const p = corner.clone().project(camera)
      return Math.max(max, Math.abs(p.x), Math.abs(p.y))
    }, 0)
  }
  for (const [width, height] of [[280, 900], [320, 568], [360, 800], [390, 844], [768, 1024], [800, 600], [1280, 720], [1920, 1080], [1, 1]]) {
    assert.ok(extent(width, height) <= 1, `${width}×${height}`)
  }
  // 窄窗口里转到任何角度也不出画
  for (let i = 0; i < 8; i++) assert.ok(extent(320, 640, { ...defaultView, angle: defaultView.angle + i * Math.PI / 4 }) <= 1, `turn ${i}`)
  // 最大俯角时最小缩放也能把整座房子收回画面
  assert.ok(extent(1200, 400, { angle: defaultView.angle, elevation: 1.3, zoom: 0.72 }) <= 1)
})
