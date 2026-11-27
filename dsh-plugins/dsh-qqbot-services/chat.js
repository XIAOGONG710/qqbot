import { createHash } from 'node:crypto'
// 本人代发的前缀归 QQ 核心定义（它据此把代发挡在她的聊天账外），插件引用核心那一份
import manualOrigin from '../../packages/bot/src/platform/desktop-manual-origin.json' with { type: 'json' }

const id = value => (typeof value === 'string' || typeof value === 'number') &&
  /^\d{1,16}$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0
  ? String(Number(value)) : null
const list = value => Array.isArray(value) ? value : []
const labels = { image: '图片', record: '语音', video: '视频', face: '表情', forward: '合并转发', file: '文件', reply: '引用' }
const HISTORY_PAGE_SIZE = 60
const HISTORY_PAGE_LIMIT = 8

function textOf(message) {
  if (typeof message === 'string') return message
  return list(message).map(segment => {
    const { type, data } = segment ?? {}
    if (type === 'text') return String(data?.text ?? '')
    if (type === 'at') return '@' + (id(data?.qq) ?? (data?.qq === 'all' ? '全体成员' : '成员'))
    return '[' + (Object.hasOwn(labels, type) ? labels[type] : '消息') + ']'
  }).join('')
}

export function activeKoishiPlugin(config) {
  const plugins = Object.entries(config?.plugins ?? {}).filter(([key]) => /^qqbot(?::[^:]+)?$/.test(key))
  const plugin = plugins.length === 1 ? plugins[0][1] : null
  return plugin && typeof plugin === 'object' && !Array.isArray(plugin) ? plugin : null
}

export function configuredManualOwner(config) {
  const owners = list(activeKoishiPlugin(config)?.contacts).filter(contact => contact?.tier === 'boyfriend')
  return owners.length === 1 ? id(owners[0].qq) : null
}

export function createChat(call, { ownerId, send, historyMedia } = {}) {
  const manualTarget = typeof send === 'function' && id(ownerId)
  async function conversations(kind, expectedAccount) {
    const group = kind === 'group'
    const rows = await call(group ? 'get_group_list' : 'get_friend_list', {}, expectedAccount)
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
  async function find(key, expectedAccount) {
    if (typeof key !== 'string' || !/^(private|group):[1-9]\d{0,15}$/.test(key)) return
    return (await conversations(key.split(':')[0], expectedAccount)).find(session => session.key === key)
  }
  async function resolveSend(payload) {
    if (!manualTarget || payload?.key !== `private:${manualTarget}`) return { status: 403, error: 'send_unavailable' }
    if (typeof payload.text !== 'string' || !payload.text.trim() || payload.text.length > 2000) {
      return { status: 400, error: 'invalid_message' }
    }
    const self = await account()
    if (self.id === manualTarget || self.id !== payload.accountId) return { status: 409, error: 'recipient_or_account_changed' }
    const session = await find(payload.key, self.id)
    if (!session) return { status: 409, error: 'recipient_or_account_changed' }
    return { status: 200, self, session }
  }
  return {
    async list() {
      const self = await account()
      const [friends, groups] = await Promise.all([conversations('private', self.id), conversations('group', self.id)])
      const canSend = manualTarget && self.id !== manualTarget && friends.some(friend => friend.target === manualTarget)
      return { account: self, sessions: [...friends, ...groups], sendKey: canSend ? `private:${manualTarget}` : null,
        ...(canSend ? { sendPrefix: manualOrigin.prefix } : {}) }
    },
    async history(key, count = 30, expectedAccount, after = null) {
      if (typeof expectedAccount !== 'string' || id(expectedAccount) !== expectedAccount) return null
      if (after !== null && (typeof after !== 'string' || !/^[a-f0-9]{64}$/.test(after))) return null
      const session = await find(key, expectedAccount)
      if (!session) return null
      const group = session.kind === 'group'
      const requested = Number(count)
      const limit = [15, 30, 60].includes(requested) ? requested : 30
      const page = async (before, reverseOrder = false) => {
        const result = await call(group ? 'get_group_msg_history' : 'get_friend_msg_history', {
          [group ? 'group_id' : 'user_id']: Number(session.target), count: HISTORY_PAGE_SIZE,
          ...(before ? { message_seq: before, reverse_order: reverseOrder } : {}),
        }, expectedAccount)
        if (!Array.isArray(result?.messages)) throw Error('history_unavailable')
        return uniqueHistory(result.messages.flatMap(message => {
          if (!message || group && message.group_id != null && id(message.group_id) !== session.target) return []
          const senderId = id(message.sender?.user_id ?? message.user_id)
          const messageId = Number.isSafeInteger(message.message_id) ? String(message.message_id) : null
          const at = Number.isSafeInteger(message.time) && message.time > 0 && message.time < 253402300800 ? message.time : null
          const text = textOf(message.message)
          const seq = String(message.real_seq ?? '')
          // 短 ID 可能复用；同一条消息在重复页中的身份需要稳定。
          const identity = messageId !== null && at !== null
            ? createHash('sha256').update(JSON.stringify([expectedAccount, key, messageId, at, senderId, seq, text])).digest('hex') : null
          return [{ id: messageId, at, identity, senderId, seq,
            sender: String(message.sender?.card || message.sender?.nickname || senderId || '未知发送者'),
            text, raw: message.message,
          }]
        }).sort((a, b) => a.at - b.at || a.seq.localeCompare(b.seq, 'en', { numeric: true })))
      }
      let rows = await page()
      const cursor = rows.findLast(row => row.identity)?.identity ?? null
      let anchor = after ? rows.findIndex(row => row.identity === after) : -1
      let reverseOrder = false
      for (let i = 1; after && anchor < 0 && rows.length && i < HISTORY_PAGE_LIMIT; i++) {
        const first = rows[0]
        if (!first.identity || !first.id || first.id === '0') break
        try {
          const older = async () => {
            const batch = await page(first.id, reverseOrder)
            const boundary = batch.findIndex(row => row.identity === first.identity)
            return boundary > 0 ? batch.slice(0, boundary) : []
          }
          let prefix = await older()
          if (!prefix.length && i === 1) {
            reverseOrder = !reverseOrder
            prefix = await older()
          }
          const existing = new Set(rows.map(row => row.identity).filter(Boolean))
          prefix = prefix.filter(row => !existing.has(row.identity))
          if (!prefix.length || !prefix[0].identity) break
          rows = [...prefix, ...rows]
          anchor = rows.findIndex(row => row.identity === after)
        } catch { break }
      }
      const incomplete = Boolean(after && anchor < 0)
      const visible = after ? rows.slice(anchor + 1) : rows.slice(-limit)
      const messages = visible.map(({ raw, ...message }) => ({
        ...message, ...(historyMedia ? { media: historyMedia.register(key, raw) } : {}),
      }))
      return { messages, cursor: incomplete ? after : cursor ?? after, incomplete }
    },
    media: id => historyMedia?.read(id) ?? null,
    async prepare(payload) {
      const result = await resolveSend(payload)
      if (result.status !== 200) return result
      return { status: 200, preview: { account: result.self, recipient: result.session, text: manualOrigin.prefix + payload.text } }
    },
    async send(payload) {
      const result = await resolveSend(payload)
      if (result.status !== 200) return result
      await send({ accountId: result.self.id, userId: result.session.target, text: payload.text })
      return { status: 200 }
    },
  }
}

function uniqueHistory(rows) {
  const seen = new Set()
  return rows.filter(({ identity }) => {
    if (!identity) return true
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
}

function exchange({ token, connect = url => new WebSocket(url), timeout = 5000 }, steps) {
  return new Promise((resolve, reject) => {
    const url = new URL('ws://127.0.0.1:3001/')
    if (token) url.searchParams.set('access_token', token)
    const socket = connect(url)
    let step = 0
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
    const next = value => {
      try { socket.send(JSON.stringify({ ...steps[step](value), echo: `dsh-qq-${step}` })) }
      catch { finish('napcat_unavailable') }
    }
    socket.addEventListener('open', () => next(), { once: true })
    socket.addEventListener('message', event => {
      let response
      try { response = JSON.parse(String(event.data)) } catch { return }
      if (finished || response?.echo !== `dsh-qq-${step}`) return
      if (response.status !== 'ok' || response.retcode !== 0) finish('napcat_action_failed')
      else if (++step === steps.length) finish(null, response.data)
      else next(response.data)
    })
    socket.addEventListener('error', () => finish('napcat_unavailable'), { once: true })
    socket.addEventListener('close', () => finish('napcat_closed'), { once: true })
  })
}

export function createNapCatReader(options) {
  return async (action, params, expectedAccount) => {
    if (!['get_login_info', 'get_friend_list', 'get_group_list', 'get_friend_msg_history', 'get_group_msg_history'].includes(action)) {
      throw Error('read_action_required')
    }
    if (expectedAccount === undefined) return exchange(options, [() => ({ action, params })])
    return exchange(options, [
      () => ({ action: 'get_login_info', params: {} }),
      login => {
        if (id(login?.user_id) !== expectedAccount) throw Error('account_changed')
        return { action, params }
      },
    ])
  }
}

export function createNapCatManualSender({ ownerId, ...options }) {
  const owner = id(ownerId)
  return async ({ accountId, userId, text }) => {
    if (!owner || userId !== owner || id(accountId) !== accountId || accountId === owner
      || typeof text !== 'string' || !text.trim() || text.length > 2000) throw Error('invalid_manual_send')
    const result = await exchange(options, [
      () => ({ action: 'get_login_info', params: {} }),
      login => {
        if (id(login?.user_id) !== accountId) throw Error('account_changed')
        return { action: 'send_private_msg', params: { user_id: Number(owner),
          message: [{ type: 'text', data: { text: manualOrigin.prefix + text } }] } }
      },
    ])
    if (!Number.isSafeInteger(result?.message_id)) throw Error('send_unconfirmed')
  }
}
