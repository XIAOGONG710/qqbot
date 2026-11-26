import assert from 'node:assert/strict'
import { test } from 'node:test'
import { configuredManualOwner, createChat, createNapCatManualSender, createNapCatReader } from '../dsh-plugins/dsh-qqbot-services/chat.js'
import { createHandler } from '../dsh-plugins/dsh-qqbot-services/index.js'
import { findMissed } from '../packages/bot/src/memory/backfill.ts'

test('lists friends and groups and fetches only the selected conversation', async () => {
  const calls = []
  const chat = createChat(async (action, params) => {
    calls.push([action, params])
    return {
      get_login_info: { user_id: 100, nickname: '测试账号' },
      get_friend_list: [{ user_id: 200, nickname: '好友' }],
      get_group_list: [{ group_id: 300, group_name: '群' }],
      get_group_msg_history: { messages: [
        { message_id: 5, group_id: 999, time: 2, message: '别的群' },
        { message_id: 6, group_id: 300, time: 3, sender: { user_id: 200, card: '群名片' },
          message: [{ type: 'text', data: { text: '你好' } }, { type: 'image', data: { url: 'kept-private' } }] },
      ] },
    }[action]
  })
  assert.deepEqual((await chat.list()).sessions.map(({ key }) => key), ['private:200', 'group:300'])
  assert.equal(await chat.history('group:999', 30, '100'), null)
  const { messages: [message] } = await chat.history('group:300', 30, '100')
  assert.equal(message.text, '你好[图片]')
  assert.equal(message.sender, '群名片')
  assert.equal(JSON.stringify(message).includes('kept-private'), false)
  assert.deepEqual(calls.at(-1), ['get_group_msg_history', { group_id: 300, count: 60 }])
})

test('reconnect restores the missed rows once and rejects a changed QQ account', async () => {
  let online = true, account = 100
  const old = { message_id: 7, time: 20, sender: { user_id: 200 }, message: '断线前' }
  const fresh = { message_id: 8, time: 21, sender: { user_id: 200 }, message: '断线中' }
  let history = [old]
  let pulls = 0
  const chat = createChat(createNapCatReader({ connect() {
    const socket = new EventTarget()
    let verified = false
    socket.close = () => socket.dispatchEvent(new Event('close'))
    socket.send = frame => {
      const { action, echo } = JSON.parse(frame)
      let data
      if (action === 'get_login_info') { verified = true; data = { user_id: account } }
      if (action === 'get_friend_list') data = [{ user_id: 200 }]
      if (action === 'get_friend_msg_history') {
        assert.equal(verified, true, 'history must be scoped on the same connection')
        pulls++
        data = { messages: history }
      }
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ status: 'ok', retcode: 0, echo, data }) }))
    }
    queueMicrotask(() => socket.dispatchEvent(new Event(online ? 'open' : 'close')))
    return socket
  } }))
  const poll = () => chat.history('private:200', 30, '100')
  assert.deepEqual((await poll()).messages.map(row => row.id), ['7'])
  online = false
  await assert.rejects(poll, /napcat_closed/)
  online = true
  history = [old, old, fresh, fresh]
  assert.deepEqual((await poll()).messages.map(row => row.id), ['7', '8'])
  assert.deepEqual((await poll()).messages.map(row => row.id), ['7', '8'])
  account = 101
  await assert.rejects(poll)
  assert.equal(pulls, 3)
})

test('a reconnect walks inclusive NapCat pages back to the last seen message, without overlap', async () => {
  const rows = Array.from({ length: 145 }, (_, i) => ({
    message_id: i + 1, real_seq: String(i + 1), time: 1000 + Math.floor(i / 5), sender: { user_id: 200 }, message: `合成 ${i + 1}`,
  }))
  let available = rows.slice(0, 3), offline = false, stuck = false
  const pages = []
  const chat = createChat(async (action, params, account) => {
    if (offline) throw Error('offline')
    if (action === 'get_friend_list') return [{ user_id: 200 }]
    assert.equal(action, 'get_friend_msg_history')
    assert.equal(account, '100')
    pages.push(params.message_seq ?? null)
    const end = params.message_seq ? available.findIndex(row => String(row.message_id) === params.message_seq) + 1 : available.length
    return { messages: stuck && params.message_seq ? [available[end - 1]] : available.slice(Math.max(0, end - params.count), end) }
  })
  const poll = after => chat.history('private:200', 30, '100', after)
  const initial = await poll()
  assert.deepEqual(initial.messages.map(message => message.id), ['1', '2', '3'])
  offline = true
  await assert.rejects(poll(initial.cursor))
  offline = false
  available = rows
  const recovered = await poll(initial.cursor)
  assert.deepEqual(recovered.messages.map(message => Number(message.id)), rows.slice(3).map(row => row.message_id))
  assert.deepEqual(pages, [null, null, '86', '27'])
  assert.equal(recovered.incomplete, false)
  assert.deepEqual((await poll(recovered.cursor)).messages, [])
  stuck = true
  const partial = await poll(initial.cursor)
  assert.equal(partial.incomplete, true)
  assert.deepEqual(partial.messages.map(message => Number(message.id)), rows.slice(-60).map(row => row.message_id))
  assert.equal(partial.cursor, initial.cursor, '保留缺口前的游标')
})

test('manual sending requires an owner-only transport and explicit matching account', async () => {
  const read = async action => action === 'get_login_info' ? { user_id: 100 } :
    action === 'get_friend_list' ? [{ user_id: 200 }, { user_id: 300 }] : []
  const payload = { key: 'private:200', accountId: '100', text: '合成消息' }
  assert.equal((await createChat(read).send(payload)).status, 403)
  const dispatched = []
  const chat = createChat(read, { ownerId: '200', send: async message => { dispatched.push(message) } })
  assert.equal((await chat.send({ ...payload, accountId: '777' })).status, 409)
  assert.equal((await chat.send({ ...payload, key: 'private:300' })).status, 403)
  assert.equal((await chat.send({ ...payload, key: 'group:200' })).status, 403)
  assert.equal((await chat.send(payload)).status, 200)
  assert.deepEqual(dispatched, [{ accountId: '100', userId: '200', text: '合成消息' }])
})

test('manual recipient comes from a single active Koishi plugin and a unique owner contact', () => {
  const contact = { qq: 200, tier: 'boyfriend' }
  assert.equal(configuredManualOwner({ plugins: { 'qqbot:synthetic': { contacts: [contact] } } }), '200')
  assert.equal(configuredManualOwner({ plugins: { '~qqbot': { contacts: [contact] } } }), null)
  assert.equal(configuredManualOwner({ plugins: { qqbot: { contacts: [contact, { ...contact, qq: 300 }] } } }), null)
  assert.equal(configuredManualOwner({ plugins: { qqbot: { contacts: [contact] }, 'qqbot:other': {} } }), null)
})

test('chat routes use the host session and an exact, single-use confirmation', async () => {
  const sends = []
  let now = 1000
  const chat = createChat(async action => action === 'get_login_info' ? { user_id: 100 } :
    action === 'get_friend_list' ? [{ user_id: 200 }] : [], { ownerId: '200', send: async value => sends.push(value) })
  const connection = { authorizeIndex: req => ['test-session=owner', 'test-session=other-browser'].includes(req.headers.cookie) }
  const handler = createHandler({ state: async () => ({ health: {}, checkedAt: 1 }) }, () => [], chat, connection, () => now)
  const call = async (method, path, headers = {}, body = '') => {
    let status, payload
    await handler({
      method, url: '/api/qqbot-services/' + path, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'x-qqbot-service-panel': '1', ...headers },
      async *[Symbol.asyncIterator]() {
        const bytes = Buffer.from(body)
        const split = bytes.indexOf(Buffer.from('仅')) + 1
        yield bytes.subarray(0, split)
        yield bytes.subarray(split)
      },
    }, { writeHead(code) { status = code }, end(json) { payload = JSON.parse(json) } })
    return { status, payload }
  }
  assert.equal((await call('GET', 'state')).status, 403)
  const headers = { cookie: 'test-session=owner', 'content-type': 'application/json' }
  const { payload: state } = await call('GET', 'state', headers)
  assert.equal(state.account, undefined)
  assert.equal(state.panelToken, undefined)
  assert.equal((await call('GET', 'chat/list', headers)).status, 403)
  assert.equal((await call('POST', 'chat/list')).status, 403)
  assert.equal((await call('POST', 'chat/list', { cookie: 'dsh-auth-forged=true' })).status, 403)
  assert.equal((await call('POST', 'chat/list', headers)).payload.account.id, '100')
  assert.equal((await call('POST', 'chat/history?key=private%3A444&accountId=100', headers)).status, 404)
  const message = { key: 'private:200', accountId: '100', text: '仅测试' }
  const post = (path, value, auth = headers) => call('POST', path, auth, JSON.stringify(value))
  assert.equal((await post('chat/send', message)).status, 403)
  assert.equal((await post('chat/prepare', { ...message, key: 'group:200' })).status, 403)
  assert.equal((await post('chat/prepare', { ...message, key: 'private:300' })).status, 403)
  const { payload: prepared } = await post('chat/prepare', message)
  assert.equal(prepared.preview.text, '【本人手动代发】仅测试')
  const confirmed = { ...message, confirmation: prepared.confirmation }
  assert.equal((await post('chat/send', confirmed, { 'content-type': 'application/json' })).status, 403)
  assert.equal((await post('chat/send', confirmed, { ...headers, cookie: 'test-session=other-browser' })).status, 403)
  assert.equal((await post('chat/send', { ...confirmed, text: '替换正文' })).status, 403)
  assert.deepEqual(sends, [])
  assert.equal((await post('chat/send', confirmed)).status, 200)
  assert.equal((await post('chat/send', confirmed)).status, 403)
  const { payload: later } = await post('chat/prepare', message)
  now += 121_000
  assert.equal((await post('chat/send', { ...message, confirmation: later.confirmation })).status, 403)
  assert.deepEqual(sends, [{ accountId: '100', userId: '200', text: '仅测试' }])
})

test('NapCat transport sends only allowlisted reads and ignores unsolicited events', async () => {
  let connected = 0
  const call = createNapCatReader({ token: 'synthetic-token', connect(url) {
    connected++
    assert.equal(url.hostname, '127.0.0.1')
    assert.equal(url.searchParams.get('access_token'), 'synthetic-token')
    const socket = new EventTarget()
    socket.close = () => socket.dispatchEvent(new Event('close'))
    socket.send = request => {
      const { action, echo } = JSON.parse(request)
      assert.equal(action, 'get_login_info')
      socket.dispatchEvent(new MessageEvent('message', { data: '{"post_type":"message"}' }))
      socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ status: 'ok', retcode: 0, echo, data: { user_id: 100 } }) }))
    }
    queueMicrotask(() => socket.dispatchEvent(new Event('open')))
    return socket
  } })
  await assert.rejects(call('send_private_msg', {}), /read_action_required/)
  assert.equal(connected, 0)
  assert.deepEqual(await call('get_login_info', {}), { user_id: 100 })
})

test('manual QQ delivery checks the confirmed account on its sending socket and survives a lost ack in backfill', async () => {
  const calls = []
  let loggedIn = 777
  let acknowledge = false
  const connect = () => {
    const socket = new EventTarget()
    socket.close = () => socket.dispatchEvent(new Event('close'))
    socket.send = frame => {
      const { action, params, echo } = JSON.parse(frame)
      calls.push({ socket, action, params })
      if (action === 'get_login_info') {
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ status: 'ok', retcode: 0, echo, data: { user_id: loggedIn } }) }))
      } else if (acknowledge) {
        socket.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ status: 'ok', retcode: 0, echo, data: { message_id: 1 } }) }))
      } else socket.close()
    }
    queueMicrotask(() => socket.dispatchEvent(new Event('open')))
    return socket
  }
  const send = createNapCatManualSender({ connect, ownerId: '200' })
  const payload = { accountId: '100', userId: '200', text: '[CQ:at,qq=123] 合成文字' }
  await assert.rejects(send({ ...payload, userId: '300' }))
  assert.equal(calls.length, 0)
  await assert.rejects(send(payload))
  assert.deepEqual(calls.map(x => x.action), ['get_login_info'])
  loggedIn = 100
  await assert.rejects(send(payload))
  assert.equal(calls[1].socket, calls[2].socket)
  assert.equal(calls[2].action, 'send_private_msg')
  assert.equal(calls[2].params.user_id, 200)
  const message = calls[2].params.message
  assert.deepEqual(message, [{ type: 'text', data: { text: '【本人手动代发】[CQ:at,qq=123] 合成文字' } }])
  const time = 1795600000
  const rows = [
    { time, message_id: 1, sender: { user_id: 100 }, message },
    { time, message_id: 2, sender: { user_id: 200 }, message },
    { time, message_id: 3, sender: { user_id: 100 }, message: '她原本的回复' },
  ]
  assert.deepEqual(findMissed([], rows, 100).map(row => [row.messageId, row.role]), [[2, 'user'], [3, 'assistant']])
  acknowledge = true
  await send(payload)
  assert.equal(calls.at(-1).action, 'send_private_msg')
})
