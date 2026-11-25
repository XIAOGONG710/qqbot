import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCompanionRoom, createRoomReply } from '../dsh-plugins/dsh-qqbot-services/companion-room.js'
import { publishedHomeStatus } from '../dsh-plugins/dsh-linmengyao-memory/home-status.js'
import { createHandler } from '../dsh-plugins/dsh-qqbot-services/index.js'

test('guests redeem one-use invites; replies only run on room messages and can decline', async () => {
  let now = 1000
  const calls = []
  const room = createCompanionRoom({ now: () => now, reply: async turn => {
    calls.push(turn)
    return turn.called ? '我在，怎么啦' : ''
  } })
  assert.equal(room.view(undefined), null)
  const invite = room.invite()
  const guest = room.join(invite, '来宾甲')
  assert.ok(guest)
  assert.equal(room.join(invite, '来宾乙'), null)
  assert.equal(calls.length, 0)
  await room.post(guest, '我今天只想在房间聊这件私事')
  assert.equal(room.view(guest).length, 1)
  now += 2000
  await room.post(guest, '@林梦瑶 在吗')
  assert.equal(room.view(guest).at(-1).role, 'assistant')
  assert.deepEqual(calls.map(turn => turn.called), [false, true])
  assert.deepEqual(Object.keys(calls[0]).sort(), ['called', 'messages'])
  assert.doesNotMatch(JSON.stringify(room.view(guest)), new RegExp(guest))
  const lateGuest = room.join(room.invite(), '后到来宾')
  assert.deepEqual(room.view(lateGuest), [])
  const expiring = room.invite()
  now += 15 * 60_000
  assert.equal(room.join(expiring, '迟来的来宾'), null)
  room.close()
  assert.equal(room.view(guest), null)
})

test('the room model receives room-only data and has no tools', async () => {
  let request
  const reply = createRoomReply({ key: 'synthetic', fetcher: async (_url, init) => {
    request = JSON.parse(init.body)
    return { ok: true, json: async () => ({ choices: [{ message: { content: '{"reply":null}' } }] }) }
  } })
  assert.equal(await reply({ called: false, messages: [{ role: 'guest', name: '来宾', text: '模拟私事' }] }), '')
  assert.equal(request.tools, undefined)
  assert.match(request.messages[0].content, /住在房间里的对话|房间内/)
  assert.match(request.messages[1].content, /模拟私事/)
})

test('the house projection accepts only published, unexpired structured daily state', () => {
  const now = 1000
  const raw = { version: 1, audience: 'owner', place: 'study', doing: 'reading', at: now, privateText: '绝不能出现' }
  assert.deepEqual(publishedHomeStatus(raw, now), { place: 'study', doing: 'reading', at: now })
  assert.equal(publishedHomeStatus({ ...raw, audience: 'room' }, now), null)
  assert.equal(publishedHomeStatus({ ...raw, doing: '私人日记原文' }, now), null)
  assert.equal(publishedHomeStatus(raw, now + 3_600_001), null)
})

test('guest HTTP credentials cannot enter the owner room, home, or QQ routes', async () => {
  const room = createCompanionRoom()
  const owner = { cookie: 'session=synthetic' }
  const auth = { authorizeIndex: req => req.headers.cookie === owner.cookie }
  const handler = createHandler({}, () => [], undefined, auth, Date.now, undefined, {
    room, home: () => ({ status: { place: 'study', doing: 'reading' } }),
  })
  const call = async (route, { headers, body, method = 'POST', remoteAddress = '127.0.0.1' } = {}) => {
    let status, data
    await handler({
      method, url: '/api/qqbot-services/' + route, socket: { remoteAddress },
      headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', 'x-qqbot-service-panel': '1', ...headers },
      async *[Symbol.asyncIterator]() { yield JSON.stringify(body ?? {}) },
    }, { writeHead(code) { status = code }, end(value) { data = JSON.parse(value) } })
    return { status, data }
  }
  assert.equal((await call('room/owner/invite')).status, 403)
  const invitation = new URLSearchParams(new URL((await call('room/owner/invite', { headers: owner })).data.url).hash.slice(1)).get('invite')
  const joined = await call('room/guest/join', { body: { invitation, name: '来宾甲' } })
  assert.equal(joined.status, 200)
  const headers = { authorization: `Bearer ${joined.data.credential}` }
  assert.equal((await call('room/guest/post', { headers, body: { text: '模拟群聊' } })).status, 200)
  assert.equal((await call('room/guest/messages', { headers })).data.messages[0].text, '模拟群聊')
  assert.equal((await call('room/guest/messages', { headers, remoteAddress: '192.168.1.18' })).status, 403)
  assert.equal((await call('room/owner/invite', { headers })).status, 403)
  assert.equal((await call('home', { headers, method: 'GET' })).status, 403)
  assert.equal((await call('chat/list', { headers })).status, 403)
  assert.equal((await call('home', { headers: owner, method: 'GET' })).data.status.place, 'study')
  await call('room/owner/close', { headers: owner })
  assert.equal((await call('room/guest/messages', { headers })).status, 403)
})

test('closing a room discards an in-flight reply before a new guest joins', async () => {
  let release
  const reply = new Promise(resolve => { release = resolve })
  const room = createCompanionRoom({ reply: () => reply })
  const oldGuest = room.join(room.invite(), '来宾甲')
  const posting = room.post(oldGuest, '@林梦瑶 旧房间的内容')
  room.close()
  const newGuest = room.join(room.invite(), '来宾乙')
  release('旧房间回复')
  await posting
  assert.deepEqual(room.view(newGuest), [])
  assert.equal(room.view(oldGuest), null)
})

test('a newly invited guest does not receive content from the previous audience through model replies', async () => {
  let release
  const slow = new Promise(resolve => { release = resolve })
  const contexts = []
  let now = 1000
  const room = createCompanionRoom({ now: () => now, reply: ({ messages }) => {
    contexts.push(messages)
    return contexts.length === 1 ? slow : '现在这句可以接'
  } })
  const oldGuest = room.join(room.invite(), '来宾甲')
  const posting = room.post(oldGuest, '@林梦瑶 入场前的私事')
  const newGuest = room.join(room.invite(), '来宾乙')
  release('重复入场前的私事')
  await posting
  assert.deepEqual(room.view(newGuest), [])
  now += 2000
  await room.post(newGuest, '@林梦瑶 新话题')
  assert.deepEqual(contexts[1].map(item => item.text), ['@林梦瑶 新话题'])
  assert.doesNotMatch(JSON.stringify(room.view(newGuest)), /入场前/)
})
