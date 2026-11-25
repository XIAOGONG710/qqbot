import { createHmac, randomBytes } from 'node:crypto'

const qqMediaHosts = new Set(['multimedia.nt.qq.com', 'gchat.qpic.cn', 'c2cpicdw.qpic.cn', 'offpic.sgp.qpic.cn'])
const maxBytes = 5 * 1024 * 1024
const ttl = 5 * 60_000

function safeUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port && qqMediaHosts.has(url.hostname)) return url.href
  } catch { /* Not a supported OneBot media reference. */ }
  return null
}

export function createHistoryMedia({ fetcher = fetch, sniffMime, now = Date.now }) {
  const key = randomBytes(32)
  const records = new Map()
  return {
    register(keyForConversation, segments) {
      if (!Array.isArray(segments)) return []
      const types = { image: 'image', record: 'audio' }
      const media = []
      for (const segment of segments) {
        if (!Object.hasOwn(types, segment?.type)) continue
        const kind = types[segment.type]
        const url = safeUrl(segment.data?.url ?? segment.data?.file)
        if (!url) continue
        const id = createHmac('sha256', key).update(JSON.stringify([keyForConversation, kind, url])).digest('base64url')
        records.delete(id)
        if (records.size >= 512) records.delete(records.keys().next().value)
        records.set(id, { kind, url, expires: now() + ttl })
        if (!media.some(item => item.id === id)) media.push({ id, kind })
        if (media.length >= 8) break
      }
      return media
    },
    async read(id) {
      const record = records.get(id)
      if (!record || record.expires <= now()) { records.delete(id); return null }
      const response = await fetcher(record.url, { redirect: 'error', signal: AbortSignal.timeout(5000) })
      if (!response.ok || !response.body || Number(response.headers.get('content-length')) > maxBytes) {
        await response.body?.cancel()
        return null
      }
      const reader = response.body.getReader()
      const chunks = []
      let size = 0
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > maxBytes) { await reader.cancel(); return null }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const body = Buffer.concat(chunks, size)
      const type = await sniffMime(body)
      return type?.startsWith(record.kind + '/') ? { body, type } : null
    },
  }
}
