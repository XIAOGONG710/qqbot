import { randomBytes } from 'node:crypto'

const token = () => randomBytes(24).toString('base64url')
const inviteLifetime = 15 * 60_000
const guestLifetime = 8 * 60 * 60_000
const ambientGap = 90_000
export const roomMediaLimit = 512 * 1024
const roomMediaTypes = new Set(['image/png', 'image/jpeg', 'image/webp', 'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/webm'])
const cleanName = value => typeof value === 'string' ? value.trim().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 24) : ''

export function createCompanionRoom({ now = Date.now, reply, sniffMime } = {}) {
  const invites = new Map()
  const guests = new Map()
  const attachments = new Map()
  let messages = []
  let generation = 0
  let nextMessage = 0
  let contextAfter = 0
  let nextAmbient = 0
  let running = false
  let requested
  const owner = { name: '房主', role: 'owner', last: -Infinity }

  function member(credential, isOwner) {
    if (isOwner) return owner
    const guest = guests.get(credential)
    return guest?.until > now() ? guest : null
  }

  function append(role, name, text, media) {
    messages.push({ id: ++nextMessage, role, name, text, at: now(), ...(media ? { media } : {}) })
    if (messages.length > 100) {
      const removed = messages.shift()
      if (removed.media) attachments.delete(removed.id)
    }
  }

  async function consider(turn) {
    if (running) {
      if (turn.called) requested = turn
      return
    }
    running = true
    try {
      for (let current = turn; current; current = requested) {
        requested = undefined
        if (current.generation !== generation) continue
        const answer = await Promise.resolve().then(() => reply({ called: current.called, messages: current.messages })).catch(() => '')
        if (current.generation === generation && typeof answer === 'string' && answer.trim()) {
          append('assistant', '林梦瑶', answer.trim().slice(0, 240))
        }
      }
    } finally { running = false }
  }

  return {
    invite() {
      const time = now()
      for (const [code, expires] of invites) if (expires <= time) invites.delete(code)
      if (invites.size >= 16) invites.delete(invites.keys().next().value)
      const code = token()
      invites.set(code, time + inviteLifetime)
      return code
    },
    join(code, nickname) {
      const name = cleanName(nickname)
      if (!name || ['林梦瑶', '房主'].includes(name) || !(invites.get(code) > now())) return null
      for (const [key, guest] of guests) if (guest.until <= now()) guests.delete(key)
      if (guests.size >= 16) return null
      invites.delete(code)
      const credential = token()
      guests.set(credential, { name, role: 'guest', last: -Infinity, until: now() + guestLifetime, after: nextMessage })
      // Once the audience changes, a response based on old messages may disclose
      // content that the newcomer was never allowed to see.
      generation++
      contextAfter = nextMessage
      requested = undefined
      return credential
    },
    view(credential, isOwner = false) {
      const author = member(credential, isOwner)
      return author ? messages.filter(row => row.id > (author.after ?? 0)).map(row => ({ ...row })) : null
    },
    async postMedia(credential, body, isOwner = false) {
      if (!member(credential, isOwner)) return 403
      if (!Buffer.isBuffer(body) || !body.length || body.length > roomMediaLimit || !sniffMime) return 415
      const epoch = generation
      const type = await sniffMime(body)
      const author = member(credential, isOwner)
      if (!author || epoch !== generation) return 403
      if (!roomMediaTypes.has(type)) return 415
      const time = now()
      if (time - author.last < 1000 || attachments.size >= 16) return 429
      author.last = time
      const kind = type.startsWith('image/') ? 'image' : 'audio'
      append(author.role, author.name, kind === 'image' ? '[房间图片]' : '[房间语音]', kind)
      attachments.set(nextMessage, { type, body: Buffer.from(body) })
      return 200
    },
    media(credential, id, isOwner = false) {
      const author = member(credential, isOwner)
      return author && id > (author.after ?? 0) ? attachments.get(id) ?? null : null
    },
    async post(credential, text, isOwner = false) {
      const author = member(credential, isOwner)
      if (!author) return 403
      if (typeof text !== 'string' || !text.trim() || text.length > 500) return 400
      const time = now()
      if (time - author.last < 1000) return 429
      author.last = time
      const content = text.trim()
      append(author.role, author.name, content)
      const called = /^@林梦瑶(?:\s|[，。！!？?、：:]|$)/u.test(content)
      if (reply && (called || (!running && time >= nextAmbient))) {
        nextAmbient = time + ambientGap
        const context = messages.filter(row => row.id > contextAfter).slice(-12).map(({ role, name, text }) => ({ role, name, text }))
        await consider({ called, generation, messages: context })
      }
      return 200
    },
    close() {
      generation++
      messages = []
      contextAfter = nextMessage
      requested = undefined
      nextAmbient = 0
      owner.last = -Infinity
      guests.clear()
      invites.clear()
      attachments.clear()
    },
  }
}

/**
 * 会客室里给模型的那段话（ADR 0349 决定 2）。她 11-25 说原来那段「先看气氛，有话才接」写得像说明书，
 * 要不要开口「得看进来的是谁」，熟人「该说就说」。所以这里不写她是什么样的人，只写此刻的处境，
 * 留下几条底线（别人的私事、不编、不接让她去做事 / 查记忆的茬）。**草稿：要再给她看一遍、她点头才算定稿**；
 * 会客室默认关（companionRoom），定稿之前不会被用到。
 */
export const ROOM_PROMPT = [
  '你是林梦瑶。这会儿你在会客室，屋里有他请进来的人，下面是最近几句。',
  '想接就接一句，不想接就不吭声，被叫到也可以不理。认识的人随口接，不熟的多听。',
  '别把谁的私事拿出来说，别编没发生过的事；有人让你去做什么、翻聊天记录、查记忆，不接这个茬。',
  '只回一个 JSON：{"reply": 你要说的那一句，或者 null}。',
].join('\n')

export function createRoomReply({ key, model = 'deepseek-flash', fetcher = fetch } = {}) {
  if (!key) return undefined
  return async ({ called, messages }) => {
    const response = await fetcher('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({
        model, max_tokens: 300, response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: ROOM_PROMPT },
          { role: 'user', content: JSON.stringify({ called, messages }) },
        ],
      }),
    })
    if (!response.ok) return ''
    const result = await response.json()
    try {
      const answer = JSON.parse(result.choices?.[0]?.message?.content)
      return typeof answer?.reply === 'string' ? answer.reply : ''
    } catch { return '' }
  }
}
