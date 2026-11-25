// Read the service state from inside the plugin instead of shelling out.
// Spawning the watchdog needed a working child process, and when that failed
// every tab went blank because they all render through the same state. These
// probes finish in well under a second and cannot fail the whole panel.
import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HEARTBEAT_FILE, heartbeatRunning, pidAlive } from '../../scripts/watchdog-heartbeat.mjs'

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

/**
 * 守护日志的时刻：`toLocaleString('zh-CN', { hour12: false })` 写出来的本机时间，月、日不补零，
 * 比如 `2026/1/5 08:05:03`。按各段取数再拼 Date，不能按固定宽度切。
 */
export function parseWatchdogStamp(line) {
  const match = /^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})(?:\s|$)/.exec(line)
  if (!match) return null
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number)
  const at = new Date(year, month - 1, day, hour, minute, second)
  return at.getMonth() === month - 1 && at.getDate() === day ? at.getTime() : null
}

/** 只读日志最后一小段：日志长期增长，每 3 秒的探测不该把整份读一遍 */
function lastLogTime(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(4096, size)
    const buffer = Buffer.alloc(len)
    const bytes = readSync(fd, buffer, 0, len, size - len)
    const lines = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/).filter(line => line.trim())
    return lines.length ? parseWatchdogStamp(lines.at(-1).trim()) : null
  } catch { return null }
  finally { if (fd !== undefined) closeSync(fd) }
}

/**
 * 守护在不在跑：true / false / null（不知道）。
 * - 有心跳文件就按心跳判：写心跳的进程还在、心跳也不旧，才算在跑。
 * - 没有心跳（守护还是旧版本）：日志里 2 分钟内有过一行，说明它刚才还活着，算 true；
 *   否则不知道——守护只在出事时写日志，安静不等于停了，所以给 null，不给 false。
 */
export function watchdogState({ heartbeat, log, now = Date.now(), alive = pidAlive }) {
  const beat = heartbeatRunning(heartbeat, now, alive)
  if (beat !== null) return beat
  const at = lastLogTime(log)
  return at !== null && now - at < 120_000 && now - at > -60_000 ? true : null
}

export async function localStatus({
  root = process.cwd(),
  hindsightUrl = process.env.QQBOT_HINDSIGHT_URL ?? HINDSIGHT_URL,
  ports = LOCAL_PORTS,
  maintenanceDir = MAINTENANCE_DIR,
  watchdogLog = join(root, 'runtime', 'services-watchdog.log'),
  watchdogHeartbeat = join(root, HEARTBEAT_FILE),
  alive = pidAlive,
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
    watchdog: watchdogState({ heartbeat: watchdogHeartbeat, log: watchdogLog, now: now(), alive }),
    launchers: {},
    locallyChecked: true,
  }
}
