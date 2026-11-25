import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { createController } from './controller.js'
import { activeKoishiPlugin, configuredManualOwner, createChat, createNapCatManualSender, createNapCatReader } from './chat.js'
import { createCompanionRoom, createRoomReply } from './companion-room.js'

export const name = 'dsh-qqbot-services'
export const inject = ['webServer', 'connection']
const prefix = '/api/qqbot-services'
const scenePrefix = `${prefix}/home/scene/`
const sceneAssets = new Map([
  ['', ['index.html', 'text/html']],
  ['scene.css', ['scene.css', 'text/css']],
  ...['scene.js', 'state.js', 'furniture.js', 'three.module.min.js'].map(file => [file, [file, 'text/javascript']]),
])
const exec = promisify(execFile)
const localAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i

export function allowedRequest(req) {
  if (!localAddresses.includes(req.socket?.remoteAddress) || !localHost.test(req.headers?.host ?? '')) return false
  if (req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host.toLowerCase()
  const origin = req.headers.origin?.toLowerCase()
  const trustedOrigin = origin === `http://${host}` || origin === `https://${host}`
  if (origin !== undefined && !trustedOrigin) return false
  return req.method !== 'POST' || req.headers['x-qqbot-service-panel'] === '1'
}

function authenticatedBrowser(connection, req) {
  // Check the browser cookie on a fixed non-root URL. Never forward a launch-token
  // query to the host's index login flow or relay its response headers.
  try {
    return connection?.authorizeIndex?.(
      { method: req.method, url: prefix, headers: req.headers },
      { writeHead() {}, end() {} },
    ) === true
  } catch { return false }
}

function confirmationDigest(req, payload) {
  return createHash('sha256').update(JSON.stringify([req.headers.cookie, payload?.key, payload?.accountId, payload?.text])).digest('hex')
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return { status: 415, error: 'invalid_format' }
  const chunks = []
  let bytes = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > 16_384) return { status: 413, error: 'message_too_large' }
    chunks.push(buffer)
  }
  try { return { body: JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) } }
  catch { return { status: 400, error: 'invalid_message' } }
}

async function roomRoute(path, req, res, send, room, owner) {
  const base = `${prefix}/room/guest/`
  if (!owner && req.method === 'GET' && [base, base + 'guest.js'].includes(path)) {
    const script = path.endsWith('.js')
    const asset = readFileSync(new URL(script ? './room-guest.js' : './room-guest.html', import.meta.url))
    res.writeHead(200, {
      'content-type': script ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    })
    return res.end(asset)
  }
  if (req.method !== 'POST') return send(404, { error: 'not_found' })
  const action = path.split('/').at(-1)
  if (path !== (owner ? `${prefix}/room/owner/` : base) + action) return send(404, { error: 'not_found' })
  if (owner && action === 'invite') {
    const scheme = req.socket.encrypted ? 'https' : 'http'
    return send(200, { url: `${scheme}://${req.headers.host}${base}#invite=${room.invite()}` })
  }
  if (owner && action === 'close') { room.close(); return send(200, { ok: true }) }
  const credential = /^Bearer ([A-Za-z0-9_-]{32})$/.exec(req.headers.authorization ?? '')?.[1]
  if (action === 'messages') {
    const messages = room.view(credential, owner)
    return messages ? send(200, { messages }) : send(403, { error: 'room_forbidden' })
  }
  if ((!owner && action === 'join') || action === 'post') {
    const { body, status, error } = await readJson(req)
    if (status) return send(status, { error })
    if (action === 'join') {
      const joined = room.join(body?.invitation, body?.name)
      return joined ? send(200, { credential: joined }) : send(403, { error: 'invite_invalid' })
    }
    const result = await room.post(credential, body?.text, owner)
    return send(result, { ok: result === 200 })
  }
  return send(404, { error: 'not_found' })
}

function tail(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(48_000, size)
    const buffer = Buffer.alloc(len)
    const bytes = readSync(fd, buffer, 0, len, size - len)
    const rows = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/)
    return size > len ? rows.slice(1) : rows
  } catch { return [] }
  finally { if (fd !== undefined) closeSync(fd) }
}

export function summarizeWatchdog(lines) {
  return lines.flatMap(line => {
    const stamp = /^(\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2})\s+(.*)$/.exec(line)
    if (!stamp) return []
    const text = stamp[2]
    const service = /^(napcat|hindsight|koishi)[:：]/i.exec(text)?.[1]?.toLowerCase()
    const event = text.startsWith('服务守护：') ? 'watching'
      : /恢复正常/.test(text) ? 'recovered'
      : /拉起|重拉/.test(text) ? 'starting'
      : /失败|不健康|出错|起不来/.test(text) ? 'failed'
      : undefined
    const target = service ?? (text.startsWith('备份：') ? 'backup' : 'watchdog')
    return event ? [{ at: stamp[1], service: target, event }] : []
  }).slice(-12).reverse()
}

export function diagnosticReport({ health, checkedAt, operation, events }) {
  const status = value => value === true ? '正常' : value === false ? '未就绪' : '未知'
  const port = key => Number.isInteger(health.ports?.[key]) && health.ports[key] > 0 && health.ports[key] <= 65535
    ? `（端口 ${health.ports[key]}）` : ''
  const connection = { connected: '最近记录为已连接', disconnected: '最近记录为断开' }
  const link = health.napcat === false || health.koishiListening === false ? '未就绪'
    : Object.hasOwn(connection, health.lastConnection?.state) ? connection[health.lastConnection.state] : '未知'
  const steps = { checking: '检查中', starting: '启动中', skipped: '已跳过', ready: '已就绪', timeout: '超时', failed: '失败', maintenance: '维护暂停' }
  const services = { napcat: 'NapCat', hindsight: 'Hindsight', koishi: 'Koishi', watchdog: '守护', backup: '备份' }
  const kinds = { watching: '开始监测', recovered: '恢复正常', starting: '尝试启动', failed: '运行异常' }
  const lines = [
    '林梦瑶 · DSH 服务诊断',
    `探测时间 ${new Date(checkedAt).toISOString()}`,
    `NapCat OneBot${port('napcat')} ${status(health.napcat)}`,
    `Hindsight${port('hindsight')} ${status(health.hindsight)}`,
    `Koishi 控制台${port('koishi')} ${status(health.koishiListening)}`,
    `Koishi → NapCat ${link}`,
    `自动守护 ${status(health.watchdog)}`,
    `维护模式 ${health.maintenance ? '开启' : '关闭'}`,
  ]
  for (const key of ['napcat', 'hindsight', 'koishi']) {
    const step = operation?.steps?.[key]
    if (Object.hasOwn(steps, step)) lines.push(`${services[key]} 启动 ${steps[step]}`)
  }
  for (const event of events.slice(0, 5)) {
    if (Object.hasOwn(services, event.service) && Object.hasOwn(kinds, event.event)
      && /^\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2}$/.test(event.at)) {
      lines.push(`${event.at} ${services[event.service]} ${kinds[event.event]}`)
    }
  }
  return lines.join('\n')
}

const tiers = ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger']
const modeValues = {
  groupChat: ['off', 'read', 'dryRun', 'on'],
  proactive: ['off', 'dryRun', 'on'],
  oneLife: ['off', 'read', 'export', 'desktop'],
}

export function summarizeConnectionConfig(config) {
  const plugin = activeKoishiPlugin(config)
  if (!plugin) return null
  const contacts = (Array.isArray(plugin.contacts) ? plugin.contacts : []).flatMap(contact => {
    if (!Number.isSafeInteger(contact?.qq) || contact.qq <= 0 || !tiers.includes(contact.tier)) return []
    const name = typeof contact.name === 'string' ? contact.name.trim().slice(0, 80) : ''
    return [{ qq: contact.qq, name, tier: contact.tier }]
  })
  const modes = Object.fromEntries(Object.entries(modeValues).map(([key, values]) =>
    [key, values.includes(plugin[key]) ? plugin[key] : null]))
  return { contacts, modes }
}

export function createHandler(controller, events, chat, connection, now = Date.now, details, companion) {
  const confirmations = new Map()
  return async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (!allowedRequest(req)) return send(403, { error: 'forbidden' })
    const path = (req.url ?? '').split('?')[0]
    if (companion?.room && path.startsWith(`${prefix}/room/guest/`)) {
      try { return await roomRoute(path, req, res, send, companion.room, false) }
      catch { return send(503, { error: 'room_unavailable' }) }
    }
    if (!authenticatedBrowser(connection, req)) return send(403, { error: 'forbidden' })
    if (companion?.home && req.method === 'GET' && path.startsWith(scenePrefix)) {
      const asset = sceneAssets.get(path.slice(scenePrefix.length))
      if (!asset) return send(404, { error: 'not_found' })
      try {
        const [file, type] = asset
        const content = readFileSync(new URL(`./home-scene/${file}`, import.meta.url))
        res.writeHead(200, {
          'content-type': `${type}; charset=utf-8`,
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'",
        })
        return res.end(content)
      } catch { return send(503, { error: 'scene_unavailable' }) }
    }
    if (companion?.room && path.startsWith(`${prefix}/room/owner/`)) {
      try { return await roomRoute(path, req, res, send, companion.room, true) }
      catch { return send(503, { error: 'room_unavailable' }) }
    }
    if (companion?.home && req.method === 'GET' && path === `${prefix}/home`) {
      try { return send(200, await companion.home()) }
      catch { return send(503, { error: 'home_unavailable' }) }
    }
    if (details && req.method === 'GET' && [`${prefix}/details/access`, `${prefix}/details/backups`].includes(path)) {
      try {
        const data = await details(path.split('/').at(-1))
        return data === null ? send(503, { error: 'details_unavailable' }) : send(200, data)
      } catch { return send(503, { error: 'details_unavailable' }) }
    }
    if (chat && path.startsWith(`${prefix}/chat/`)) {
      if (req.method !== 'POST') return send(403, { error: 'forbidden' })
      const query = new URLSearchParams((req.url ?? '').split('?')[1])
      try {
        if (path === `${prefix}/chat/list`) return send(200, await chat.list())
        if (path === `${prefix}/chat/history`) {
          const messages = await chat.history(query.get('key'), query.get('count'))
          return messages ? send(200, { messages }) : send(404, { error: 'unknown_conversation' })
        }
        if (path === `${prefix}/chat/prepare` || path === `${prefix}/chat/send`) {
          const { body: payload, status, error } = await readJson(req)
          if (status) return send(status, { error })
          if (path === `${prefix}/chat/prepare`) {
            const result = await chat.prepare(payload)
            if (result.status !== 200) return send(result.status, { error: result.error })
            const time = now()
            for (const [key, value] of confirmations) {
              if (value.expires <= time) confirmations.delete(key)
            }
            if (confirmations.size >= 64) confirmations.delete(confirmations.keys().next().value)
            const confirmation = randomBytes(32).toString('base64url')
            confirmations.set(confirmation, { expires: time + 120_000, digest: confirmationDigest(req, payload) })
            return send(200, { confirmation, preview: result.preview })
          }
          const confirmation = confirmations.get(payload?.confirmation)
          if (!confirmation || confirmation.expires <= now() || confirmation.digest !== confirmationDigest(req, payload)) {
            return send(403, { error: 'confirmation_required' })
          }
          confirmations.delete(payload.confirmation)
          const result = await chat.send(payload)
          return send(result.status, { error: result.error })
        }
        return send(404, { error: 'not_found' })
      } catch { return send(503, { error: 'qq_unavailable' }) }
    }
    if (req.method === 'GET' && path === `${prefix}/state`) {
      try {
        const state = { ...await controller.state(), events: events() }
        return send(200, { ...state, diagnostic: diagnosticReport(state) })
      }
      catch { return send(503, { error: 'status_unavailable' }) }
    }
    if (req.method === 'POST' && path.startsWith(`${prefix}/start/`)) {
      const result = controller.start(path.slice(`${prefix}/start/`.length))
      const code = { accepted: 202, busy: 409, invalid: 400, unavailable: 503 }[result]
      return send(code, { result })
    }
    return send(404, { error: 'not_found' })
  }
}

function launchService(root, service) {
  const logDir = join(root, 'runtime', 'boot')
  mkdirSync(logDir, { recursive: true })
  const file = openSync(join(logDir, `${service}-panel.log`), 'a')
  try {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(root, 'scripts', 'start-managed-service.ps1'), '-Service', service],
    { cwd: root, windowsHide: true, detached: true, stdio: ['ignore', file, file],
      ...(service === 'hindsight' ? { env: { ...process.env, HINDSIGHT_API_SKIP_LLM_VERIFICATION: 'true' } } : {}) })
    return new Promise((done, fail) => {
      child.once('error', fail)
      child.once('spawn', () => { child.unref(); done() })
    })
  } finally { closeSync(file) }
}

export function apply(ctx, config = {}) {
  const root = realpathSync(resolve(config.repoRoot || join(dirname(fileURLToPath(import.meta.url)), '../..')))
  const controller = createController({
    async probe() {
      const { stdout } = await exec(process.execPath, [join(root, 'scripts', 'services-watchdog.mjs'), '--once', '--local-only'], {
        cwd: root, timeout: 45_000, windowsHide: true, maxBuffer: 32_000,
      })
      return JSON.parse(stdout)
    },
    launch: service => launchService(root, service),
    sleep,
  })
  const events = () => summarizeWatchdog(tail(join(root, 'runtime', 'services-watchdog.log')))
  const configPath = resolve(root, process.env.QQBOT_KOISHI_DIR || 'runtime/koishi', 'koishi.yml')
  const require = createRequire(join(root, 'package.json'))
  const readKoishiConfig = () => {
    try { return require('js-yaml').load(readFileSync(configPath, 'utf8')) }
    catch { return null }
  }
  const manualOwner = () => configuredManualOwner(readKoishiConfig())
  const details = async kind => {
    if (kind === 'access') return summarizeConnectionConfig(readKoishiConfig())
    const { backupEntries } = await import(pathToFileURL(join(root, 'scripts', 'backup-state.mjs')).href)
    return backupEntries(join(root, 'runtime', 'backups'))
      .sort((a, b) => b.name.localeCompare(a.name)).slice(0, 14)
  }
  const token = process.env.QQBOT_ONEBOT_TOKEN
  const ownerId = manualOwner()
  const send = createNapCatManualSender({ token, ownerId })
  const chat = createChat(createNapCatReader({ token }), {
    ownerId,
    send: message => {
      if (manualOwner() !== ownerId) throw Error('manual_owner_changed')
      return send(message)
    },
  })
  const room = createCompanionRoom({ reply: createRoomReply({ key: process.env.QQBOT_LLM_API_KEY, model: config.roomModel }) })
  const homeFile = resolve(process.env.QQBOT_SOUL_DIR || join(homedir(), '.dsh', 'linmengyao'), 'HOME-PUBLIC.json')
  const companion = {
    room,
    async home() {
      const { homePlaces, homeActivities, readPublishedHomeStatus } =
        await import(pathToFileURL(join(root, 'dsh-plugins', 'dsh-linmengyao-memory', 'home-status.js')).href)
      return { places: homePlaces, activities: homeActivities, status: readPublishedHomeStatus(homeFile) }
    },
  }
  const unregister = ctx.webServer.register({
    kind: 'prefix', path: prefix, handler: createHandler(controller, events, chat, ctx.connection, Date.now, details, companion),
  })
  ctx.on('dispose', () => { room.close(); controller.dispose(); unregister() })
}
