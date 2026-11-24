import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { closeSync, fstatSync, mkdirSync, openSync, readSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createController } from './controller.js'

export const name = 'dsh-qqbot-services'
export const inject = ['webServer']
const prefix = '/api/qqbot-services'
const exec = promisify(execFile)
const localAddresses = ['127.0.0.1', '::1', '::ffff:127.0.0.1']
const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/i

export function allowedRequest(req, panelToken) {
  if (!localAddresses.includes(req.socket?.remoteAddress) || !localHost.test(req.headers?.host ?? '')) return false
  if (req.headers.forwarded || req.headers['x-forwarded-for'] || req.headers['x-forwarded-host']) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const host = req.headers.host.toLowerCase()
  const origin = req.headers.origin?.toLowerCase()
  const trustedOrigin = origin === `http://${host}` || origin === `https://${host}`
  if (origin !== undefined && !trustedOrigin) return false
  if (req.method !== 'POST') return true
  // The desktop protocol proxy verifies its renderer origin, then strips Origin.
  return req.headers['x-qqbot-service-panel'] === '1'
    && (trustedOrigin || (origin === undefined && panelToken !== undefined
      && req.headers['x-qqbot-service-token'] === panelToken))
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

export function createHandler(controller, events) {
  const panelToken = randomBytes(32).toString('hex')
  return async (req, res) => {
    const send = (status, value) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (!allowedRequest(req, panelToken)) return send(403, { error: 'forbidden' })
    const path = (req.url ?? '').split('?')[0]
    if (req.method === 'GET' && path === `${prefix}/state`) {
      try { return send(200, { ...await controller.state(), events: events(), panelToken }) }
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
  const unregister = ctx.webServer.register({ kind: 'prefix', path: prefix, handler: createHandler(controller, events) })
  ctx.on('dispose', () => { controller.dispose(); unregister() })
}
