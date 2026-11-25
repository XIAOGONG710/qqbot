// Read the service state from inside the plugin instead of shelling out.
// Spawning the watchdog needed a working child process, and when that failed
// every tab went blank because they all render through the same state. These
// probes finish in well under a second and cannot fail the whole panel.
import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export const LOCAL_PORTS = Object.freeze({ napcat: 3001, hindsight: 8899, koishi: 5140 })
export const MAINTENANCE_DIR = join(tmpdir(), 'qqbot-maintenance')
export const HINDSIGHT_URL = 'http://127.0.0.1:8899'

export function tcpOpen(port, { host = '127.0.0.1', timeout = 800 } = {}) {
  return new Promise(resolve => {
    const socket = connect({ host, port })
    const settle = value => {
      socket.removeAllListeners()
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeout)
    socket.once('connect', () => settle(true))
    socket.once('timeout', () => settle(false))
    socket.once('error', () => settle(false))
  })
}

async function reachable(url, fetcher, timeout) {
  try {
    const response = await fetcher(`${url}/health`, { signal: AbortSignal.timeout(timeout) })
    return response.ok === true
  } catch { return false }
}

function lastLogTime(file) {
  try {
    const text = readFileSync(file, 'utf8')
    const line = text.slice(text.trimEnd().lastIndexOf('\n') + 1).trim()
    const at = Date.parse(line.slice(0, 19))
    return Number.isFinite(at) ? at : null
  } catch { return null }
}

export function watchdogRunning(file, now = Date.now()) {
  const at = lastLogTime(file)
  return at !== null && now - at < 120_000
}

export async function localStatus({
  root = process.cwd(),
  hindsightUrl = process.env.QQBOT_HINDSIGHT_URL ?? HINDSIGHT_URL,
  ports = LOCAL_PORTS,
  maintenanceDir = MAINTENANCE_DIR,
  watchdogLog = join(root, 'runtime', 'services-watchdog.log'),
  timeout = 800,
  fetcher = fetch,
  now = Date.now,
} = {}) {
  const [napcat, hindsight, koishiListening] = await Promise.all([
    tcpOpen(ports.napcat, { timeout }),
    reachable(hindsightUrl, fetcher, timeout),
    tcpOpen(ports.koishi, { timeout }),
  ])
  return {
    napcat,
    hindsight,
    koishi: koishiListening,
    net: false,
    koishiProcesses: 0,
    koishiListening,
    lastConnection: null,
    maintenance: existsSync(maintenanceDir),
    ports: { ...ports },
    watchdog: watchdogRunning(watchdogLog, now()),
    launchers: {},
    locallyChecked: true,
  }
}
