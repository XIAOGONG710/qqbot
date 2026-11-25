const id = value => /^\d{1,16}$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? String(Number(value)) : null
const list = value => Array.isArray(value) ? value : []
const labels = { image: '图片', record: '语音', video: '视频', face: '表情', forward: '合并转发', file: '文件', reply: '引用' }

function textOf(message) {
  if (typeof message === 'string') return message
  return list(message).map(segment => {
    const { type, data } = segment ?? {}
    if (type === 'text') return String(data?.text ?? '')
    if (type === 'at') return '@' + (id(data?.qq) ?? (data?.qq === 'all' ? '全体成员' : '成员'))
    return '[' + (Object.hasOwn(labels, type) ? labels[type] : '消息') + ']'
  }).join('')
}

// The injected sender must preserve manual provenance through Koishi backfill.
// Production wires only the read port until such a sender is approved.
export function createChat(call, { ownerId, send } = {}) {
  const manualTarget = typeof send === 'function' && id(ownerId)
  async function conversations(kind) {
    const group = kind === 'group'
    const rows = await call(group ? 'get_group_list' : 'get_friend_list', {})
    return list(rows).flatMap(row => {
      const target = id(group ? row?.group_id : row?.user_id)
      if (!target) return []
      const name = group ? row.group_name : row.remark || row.nickname
      return [{ key: `${kind}:${target}`, kind, target, name: String(name || target) }]
    })
  }
  async function account() {
    const user = await call('get_login_info', {})
    const accountId = id(user?.user_id)
    if (!accountId) throw Error('account_unavailable')
    return { id: accountId, name: String(user.nickname || accountId) }
  }
  async function find(key) {
    if (typeof key !== 'string' || !/^(private|group):[1-9]\d{0,15}$/.test(key)) return
    return (await conversations(key.split(':')[0])).find(session => session.key === key)
  }
  return {
    async list() {
      const [self, friends, groups] = await Promise.all([account(), conversations('private'), conversations('group')])
      return { account: self, sessions: [...friends, ...groups], sendKey: manualTarget ? `private:${manualTarget}` : null }
    },
    async history(key, count = 30) {
      const session = await find(key)
      if (!session) return null
      const group = session.kind === 'group'
      const requested = Number(count)
      const limit = [15, 30, 60].includes(requested) ? requested : 30
      const result = await call(group ? 'get_group_msg_history' : 'get_friend_msg_history', {
        [group ? 'group_id' : 'user_id']: Number(session.target), count: limit,
      })
      return list(result?.messages).filter(message => message && (!group || message.group_id == null ||
        id(message.group_id) === session.target)).slice(-limit).map(message => {
        const senderId = id(message.sender?.user_id ?? message.user_id)
        return {
          id: Number.isSafeInteger(message.message_id) ? String(message.message_id) : null,
          at: Number.isSafeInteger(message.time) && message.time > 0 && message.time < 253402300800 ? message.time : null,
          senderId,
          sender: String(message.sender?.card || message.sender?.nickname || senderId || '未知发送者'),
          text: textOf(message.message),
        }
      }).sort((a, b) => a.at - b.at)
    },
    async send(payload) {
      if (!manualTarget || payload?.key !== `private:${manualTarget}`) return { status: 403, error: 'send_unavailable' }
      if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 2000) {
        return { status: 400, error: 'invalid_message' }
      }
      const [self, session] = await Promise.all([account(), find(payload.key)])
      if (!session || self.id !== payload.accountId) return { status: 409, error: 'recipient_or_account_changed' }
      await send({ accountId: self.id, userId: session.target, text: payload.text })
      return { status: 200 }
    },
  }
}

export function createNapCatReader({ token, connect = url => new WebSocket(url), timeout = 5000 }) {
  return (action, params) => new Promise((resolve, reject) => {
    if (!['get_login_info', 'get_friend_list', 'get_group_list', 'get_friend_msg_history', 'get_group_msg_history'].includes(action)) {
      reject(Error('read_action_required'))
      return
    }
    const url = new URL('ws://127.0.0.1:3001/')
    if (token) url.searchParams.set('access_token', token)
    const socket = connect(url)
    const echo = 'dsh-qq-read'
    let finished = false
    const finish = (error, value) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      if (error) reject(Error(error))
      else resolve(value)
      socket.close()
    }
    const timer = setTimeout(() => finish('napcat_timeout'), timeout)
    socket.addEventListener('open', () => {
      try { socket.send(JSON.stringify({ action, params, echo })) }
      catch { finish('napcat_unavailable') }
    }, { once: true })
    socket.addEventListener('message', event => {
      let response
      try { response = JSON.parse(String(event.data)) } catch { return }
      if (response?.echo !== echo) return
      if (response.status !== 'ok' || response.retcode !== 0) finish('napcat_action_failed')
      else finish(null, response.data)
    })
    socket.addEventListener('error', () => finish('napcat_unavailable'), { once: true })
    socket.addEventListener('close', () => finish('napcat_closed'), { once: true })
  })
}
