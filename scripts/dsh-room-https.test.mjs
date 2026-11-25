import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { request as httpsRequest } from 'node:https'
import { createServer as createHttpsServer } from 'node:https'
import { after, before, test } from 'node:test'
import { checkServerIdentity } from 'node:tls'
import { fileURLToPath } from 'node:url'
import { createCompanionRoom, roomMediaLimit } from '../dsh-plugins/dsh-qqbot-services/companion-room.js'
import { createLanGuestHandler } from '../dsh-plugins/dsh-qqbot-services/index.js'

const prefix = '/api/qqbot-services'
const host = '192.168.50.5'
const certFile = fileURLToPath(new URL('./fixtures/room-test/room-test-cert.pem', import.meta.url))
const keyFile = fileURLToPath(new URL('./fixtures/room-test/room-test-key.pem', import.meta.url))
const cert = readFileSync(certFile)
const key = readFileSync(keyFile)

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex')
const ogg = Buffer.from('4f67675300020000000000000000', 'hex')

function sniff(bytes) {
  if (bytes.subarray(0, 8).equals(png.subarray(0, 8))) return 'image/png'
  if (bytes.subarray(0, 4).toString('hex') === '4f676753') return 'audio/ogg'
  return undefined
}

let server
let room
let origin
let port
let clock = 1_000

before(async () => {
  room = createCompanionRoom({ now: () => clock, sniffMime: sniff })
  server = createHttpsServer({ cert, key })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  origin = `https://${host}:${port}`
  // The handler pins its origin, so it is attached only once the port is known.
  server.on('request', createLanGuestHandler(room, origin))
})

after(async () => {
  room?.close()
  if (server) await new Promise(resolve => server.close(resolve))
})

function path(name) {
  return prefix + '/room/guest/' + name
}

function send(name, { method = 'POST', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: '127.0.0.1',
      port,
      method,
      path: path(name),
      ca: cert,
      checkServerIdentity: (_name, peer) => checkServerIdentity(host, peer),
      headers: { host: `${host}:${port}`, origin, ...headers },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    request.on('error', reject)
    request.end(body)
  })
}

function guestHeaders(credential, extra = {}) {
  return { authorization: `Bearer ${credential}`, 'x-qqbot-service-panel': '1', ...extra }
}

test('a second device reaches the room over a trusted HTTPS listener', async () => {
  const page = await send('', { method: 'GET' })
  assert.equal(page.status, 200)
  assert.match(page.headers['content-type'], /^text\/html/)
  assert.match(page.headers['content-security-policy'], /frame-ancestors 'none'/)
  assert.equal(page.headers['x-content-type-options'], 'nosniff')
  assert.equal(page.headers['referrer-policy'], 'no-referrer')

  const script = await send('guest.js', { method: 'GET' })
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'], /^text\/javascript/)

  const joined = await send('join', {
    headers: { 'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
    body: JSON.stringify({ invitation: room.invite(), name: '第二台设备' }),
  })
  assert.equal(joined.status, 200)
  const credential = JSON.parse(joined.body).credential
  assert.match(credential, /^[A-Za-z0-9_-]{32}$/)

  const posted = await send('post', {
    headers: guestHeaders(credential, { 'content-type': 'application/json' }),
    body: JSON.stringify({ text: '从另一台设备进来' }),
  })
  assert.equal(posted.status, 200)
  const messages = await send('messages', { headers: guestHeaders(credential) })
  assert.equal(messages.status, 200)
  assert.equal(JSON.parse(messages.body).messages.at(-1).text, '从另一台设备进来')
})

test('the guest listener rejects forged hosts, proxies and owner routes', async () => {
  assert.equal((await send('join', {
    headers: { host: `192.168.50.5:${port + 1}`, 'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
    body: JSON.stringify({ invitation: room.invite(), name: '伪造主机' }),
  })).status, 403)

  assert.equal((await send('join', {
    headers: { 'x-forwarded-for': '192.168.50.24', 'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
    body: JSON.stringify({ invitation: room.invite(), name: '经过代理' }),
  })).status, 403)

  assert.equal((await send('join', {
    headers: { origin: 'https://other.invalid', 'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
    body: JSON.stringify({ invitation: room.invite(), name: '伪造来源' }),
  })).status, 403)

  const owner = await new Promise((resolve, reject) => {
    const request = httpsRequest({
      host: '127.0.0.1', port, method: 'POST', path: `${prefix}/room/owner/invite`,
      ca: cert,
      checkServerIdentity: (_name, peer) => checkServerIdentity(host, peer),
      headers: { host: `${host}:${port}`, origin, 'x-qqbot-service-panel': '1' },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString() }))
    })
    request.on('error', reject)
    request.end('{}')
  })
  assert.equal(owner.status, 404)
})

test('uploads stay inside the size, MIME and membership limits', async () => {
  clock += 2_000
  const first = room.join(room.invite(), '带图来宾')
  const image = await send('upload', {
    headers: guestHeaders(first, { 'content-type': 'application/octet-stream' }),
    body: png,
  })
  assert.equal(image.status, 200)
  const row = room.view(first).at(-1)
  assert.equal(row.media, 'image')

  const fetched = await send(`media/${row.id}`, { method: 'GET', headers: guestHeaders(first) })
  assert.equal(fetched.status, 200)
  assert.equal(fetched.headers['content-type'], 'image/png')
  assert.deepEqual(fetched.body, png)

  clock += 2_000
  const voice = await send('upload', {
    headers: guestHeaders(first, { 'content-type': 'application/octet-stream' }),
    body: ogg,
  })
  assert.equal(voice.status, 200)
  const audio = room.view(first).at(-1)
  assert.equal(audio.media, 'audio')
  const heard = await send(`media/${audio.id}`, { method: 'GET', headers: guestHeaders(first) })
  assert.equal(heard.headers['content-type'], 'audio/ogg')

  clock += 2_000
  const text = await send('upload', {
    headers: guestHeaders(first, { 'content-type': 'application/octet-stream' }),
    body: Buffer.from('这只是一段文字，不是图片'),
  })
  assert.equal(text.status, 415)

  clock += 2_000
  const huge = await send('upload', {
    headers: guestHeaders(first, { 'content-type': 'application/octet-stream' }),
    body: Buffer.alloc(roomMediaLimit + 1, 7),
  })
  assert.equal(huge.status, 413)

  clock += 2_000
  const wrongType = await send('upload', {
    headers: guestHeaders(first, { 'content-type': 'image/png' }),
    body: png,
  })
  assert.equal(wrongType.status, 415)

  const stranger = room.join(room.invite(), '另一台来宾')
  assert.equal((await send(`media/${row.id}`, { method: 'GET', headers: guestHeaders(stranger) })).status, 404)

  room.close()
  assert.equal((await send(`media/${row.id}`, { method: 'GET', headers: guestHeaders(first) })).status, 404)
})
