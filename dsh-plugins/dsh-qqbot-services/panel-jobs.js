// 面板里重的读算（整份聊天记录跑效果数、所有提示词清单、她的状态那几本账）不在 DSH 主线程上做：
// 每次起一个短命子进程（panel-job-child.js，经 node-run.js 的 nodeCommand，Electron 下也是真 Node），JSON 进 JSON 出。
//   · 子进程的时区设成插件配置的 timeZone（bot 进程也是这么设的，ADR 0331），日界和 bot 写下的日子对得上；
//   · 有超时（到点杀掉）、stdout 有上限、同时最多跑 MAX_RUNNING 个，多的排队；
//   · 失败只回固定的错误码（panel_job_failed / panel_job_timeout / panel_job_output），不带子进程的输出、路径和原始错误；
//     stderr 直接丢掉（里面可能有路径和文件内容）。
// sharedJob：同一个键同时来的请求共用一次计算（in-flight），算完在 ttl 内直接给缓存。

import { spawn as spawnProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { nodeCommand } from './node-run.js'
import { DEFAULT_TIME_ZONE, validTimeZone } from './panel-time.js'

const CHILD = fileURLToPath(new URL('./panel-job-child.js', import.meta.url))
export const JOB_TIMEOUT_MS = 90_000
export const JOB_OUTPUT_MAX = 8_000_000
export const MAX_RUNNING = 2

let running = 0
const waiting = []

function acquire() {
  if (running < MAX_RUNNING) { running++; return Promise.resolve() }
  return new Promise(done => waiting.push(done))
}

function release() {
  const next = waiting.shift()
  if (next) next()
  else running--
}

/**
 * 在子进程里跑一个 job（panel-job-child.js 里的 jobs）。
 * @param {string} job
 * @param {unknown} input 只放可序列化的普通数据（路径、日子、数），不放配置原文
 * @param {object} options
 * @param {string} options.root 仓库根：子进程的工作目录（tsx 从这里解析）
 * @param {string} [options.timeZone] 子进程的 TZ；不认得就用 bot 的默认
 * @param {number} [options.timeout]
 * @param {typeof spawnProcess} [options.spawn] 测试替身
 */
export async function runPanelJob(job, input, { root, timeZone, timeout = JOB_TIMEOUT_MS, spawn = spawnProcess } = {}) {
  await acquire()
  try {
    return await once(job, input, { root, timeZone, timeout, spawn })
  } finally { release() }
}

function once(job, input, { root, timeZone, timeout, spawn }) {
  const node = nodeCommand()
  return new Promise((resolve, reject) => {
    let settled = false
    const fail = code => { if (!settled) { settled = true; reject(Error(code)) } }
    let child
    try {
      child = spawn(node.command, ['--no-warnings', '--import', 'tsx', CHILD], {
        cwd: root, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'],
        env: { ...node.env, NODE_OPTIONS: '', NO_COLOR: '1', TZ: validTimeZone(timeZone) ?? DEFAULT_TIME_ZONE },
      })
    } catch { return fail('panel_job_failed') }
    const timer = setTimeout(() => { fail('panel_job_timeout'); try { child.kill() } catch { /* 已经退了 */ } }, timeout)
    timer.unref?.()
    let size = 0
    const chunks = []
    child.stdout.on('data', chunk => {
      if (settled) return
      size += chunk.length
      if (size > JOB_OUTPUT_MAX) { fail('panel_job_output'); try { child.kill() } catch { /* 已经退了 */ } return }
      chunks.push(chunk)
    })
    child.on('error', () => { clearTimeout(timer); fail('panel_job_failed') })
    child.on('close', code => {
      clearTimeout(timer)
      if (settled) return
      if (code !== 0) return fail('panel_job_failed')
      try {
        const value = JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
        settled = true
        resolve(value)
      } catch { fail('panel_job_failed') }
    })
    // 子进程起不来时写 stdin 会报 EPIPE：不让它变成未处理的错误
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify({ job, input }))
  })
}

/**
 * 同键共用一次计算 + 短缓存。
 * @param {{ ttl: number, now?: () => number, max?: number }} options
 * @returns {(key: string, compute: () => Promise<any>) => Promise<any>}
 */
export function sharedJob({ ttl, now = Date.now, max = 16 }) {
  const done = new Map()
  const inflight = new Map()
  return (key, compute) => {
    const at = now()
    const hit = done.get(key)
    if (hit && at >= hit.at && at - hit.at < ttl) return Promise.resolve(hit.value)
    const pending = inflight.get(key)
    if (pending) return pending
    const promise = Promise.resolve().then(compute).then(value => {
      done.delete(key)
      done.set(key, { at: now(), value })
      while (done.size > max) done.delete(done.keys().next().value)
      return value
    }).finally(() => inflight.delete(key))
    inflight.set(key, promise)
    return promise
  }
}
