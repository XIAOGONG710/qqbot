import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createChat, createNapCatReader } from '../dsh-plugins/dsh-qqbot-services/chat.js'
import { createHandler } from '../dsh-plugins/dsh-qqbot-services/index.js'

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
  assert.equal(await chat.history('group:999'), null)
  const [message] = await chat.history('group:300')
  assert.equal(message.text, '你好[图片]')
  assert.equal(message.sender, '群名片')
  assert.equal(JSON.stringify(message).includes('kept-private'), false)
  assert.deepEqual(calls.at(-1), ['get_group_msg_history', { group_id: 300, count: 30 }])
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

test('chat routes require a panel token and never expose conversations in diagnostics', async () => {
  const chat = createChat(async action => action === 'get_login_info' ? { user_id: 100 } : [])
  const handler = createHandler({ state: async () => ({ health: {}, checkedAt: 1 }) }, () => [], chat)
  const call = async (method, path, headers = {}, body = '') => {
    let status, payload
    await handler({
      method, url: '/api/qqbot-services/' + path, socket: { remoteAddress: '127.0.0.1' },
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'x-qqbot-service-panel': '1', ...headers },
      async *[Symbol.asyncIterator]() { yield body },
    }, { writeHead(code) { status = code }, end(json) { payload = JSON.parse(json) } })
    return { status, payload }
  }
  const { payload: state } = await call('GET', 'state')
  assert.equal(state.account, undefined)
  const headers = { 'x-qqbot-service-token': state.panelToken, 'content-type': 'application/json' }
  assert.equal((await call('GET', 'chat/list', headers)).status, 403)
  assert.equal((await call('POST', 'chat/list')).status, 403)
  assert.equal((await call('POST', 'chat/list', headers)).payload.account.id, '100')
  assert.equal((await call('POST', 'chat/history?key=private%3A444', headers)).status, 404)
  assert.equal((await call('POST', 'chat/send', headers, '{"text":"仅测试"}')).status, 403)
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
