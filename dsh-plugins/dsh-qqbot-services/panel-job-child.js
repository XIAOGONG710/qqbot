// panel-jobs.js 起的短命子进程：stdin 一份 { job, input }，stdout 一份 JSON，别的什么都不写。
// 失败只用退出码表示（不往 stdout / stderr 写错误原文：里面可能有路径和文件内容）。
// 只读：聊天记录用 ChatHistory 的 readOnly 读法（不迁移旧撤回状态、不写 .recalled.json）；不写日志、不改名隔离坏文件。
// 链接（symlink / junction）和超过上限的文件一律跳过，不跟出去读。

import { lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** 单个文件的上限：超了当读不了 */
const CHAT_MAX = 256_000_000
const MANIFEST_MAX = 64_000_000
const STATE_MAX = 32_000_000

const load = (root, file) => import(pathToFileURL(join(root, file)).href)

function ordinary(path, size) {
  try {
    const info = lstatSync(path)
    return info.isFile() && !info.isSymbolicLink() && info.size <= size
  } catch { return false }
}

function realDirectory(path) {
  try {
    const info = lstatSync(path)
    return info.isDirectory() && !info.isSymbolicLink()
  } catch { return false }
}

/**
 * weekly-metrics.ts loadMetricsData 的只读版：同样的文件名规矩和主动消息 id，
 * 但 history.load 带 readOnly（原版会在旧格式撤回状态上写 .recalled.json——那是 QQ 进程的活，面板不替它写）。
 */
function readOnlyMetricsData(directory, ChatHistory) {
  const chatDir = join(directory, 'chats')
  if (!realDirectory(chatDir)) throw Error('no_chats')
  const history = new ChatHistory(directory)
  const chats = new Map()
  for (const name of readdirSync(chatDir)) {
    const match = /^(\d+)\.jsonl$/.exec(name)
    if (!match || !ordinary(join(chatDir, name), CHAT_MAX)) continue
    try { chats.set(Number(match[1]), history.load(Number(match[1]), { readOnly: true })) } catch { /* 这个人的记录读不了：不算 */ }
  }
  const proactiveIds = new Map()
  const proactiveDir = join(directory, 'proactive')
  if (realDirectory(proactiveDir)) {
    for (const name of readdirSync(proactiveDir)) {
      const match = /^(\d+)(?:-[a-z]+)?\.json$/.exec(name)
      if (!match || !chats.has(Number(match[1])) || !ordinary(join(proactiveDir, name), STATE_MAX)) continue
      try {
        const state = JSON.parse(readFileSync(join(proactiveDir, name), 'utf8'))
        const ids = proactiveIds.get(Number(match[1])) ?? new Set()
        for (const record of Array.isArray(state?.records) ? state.records : []) {
          if (record?.result !== 'sent' || !Array.isArray(record.messageIds)) continue
          for (const id of record.messageIds) if (Number.isSafeInteger(id)) ids.add(id)
        }
        proactiveIds.set(Number(match[1]), ids)
      } catch { /* 坏文件当没有：主动轮退回按间隔判断 */ }
    }
  }
  return { chats, proactiveIds }
}

const jobs = {
  /** 效果数：{ root, directory, until, count } → { result, previous: { at, deltas } | null } */
  async metrics({ root, directory, until, count }) {
    const [w, { ChatHistory }] = await Promise.all([
      load(root, 'packages/bot/src/ops/weekly-metrics.ts'), load(root, 'packages/bot/src/memory/history.ts'),
    ])
    const { chats, proactiveIds } = readOnlyMetricsData(directory, ChatHistory)
    const result = w.computeWeeklyMetrics({ chats, proactiveIds, ...w.windowOf(until, count), scope: 'all' })
    const logPath = w.metricsLogPath(directory)
    const previous = ordinary(logPath, STATE_MAX) ? w.previousRun(logPath, 'all') : undefined
    return { result, previous: previous ? { at: previous.at, deltas: w.compareMetrics(previous.week, result.week) } : null }
  },

  /** 提示词构成：{ root, logs } → { days: string[], inventory } （没有清单时 days 为空、没有 inventory） */
  async inventory({ root, logs }) {
    const [{ inventory }, { MANIFEST_FILE }] = await Promise.all([
      load(root, 'packages/bot/src/ops/prompt-inventory.ts'), load(root, 'packages/bot/src/platform/prompt-manifest.ts'),
    ])
    if (!realDirectory(logs)) return { days: [] }
    const files = readdirSync(logs).filter(name => MANIFEST_FILE.test(name) && ordinary(join(logs, name), MANIFEST_MAX)).sort()
    const days = files.map(name => MANIFEST_FILE.exec(name)?.[1]).filter(Boolean)
    if (!days.length) return { days: [] }
    // prompt-inventory.ts readManifests 的读法，只是跳过链接和太大的文件
    const rows = []
    for (const name of files) {
      for (const line of readFileSync(join(logs, name), 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const row = JSON.parse(line)
          if (Array.isArray(row?.pieces) && typeof row.kind === 'string') rows.push(row)
        } catch { /* 写到一半的行 */ }
      }
    }
    return { days, inventory: inventory(rows) }
  },

  /**
   * 她的状态：{ root, config, soulDir, hindsightUrl, now, sections, date? } → { [section]: { value } | { failed: true } }
   * config 是 her-state.js herStateConfig 收窄过的那份（只有数据目录、时区、他是谁）。
   */
  async her({ root, config, soulDir, hindsightUrl, now, sections, date }) {
    const { createHerState } = await import('./her-state.js')
    const state = createHerState({ root, readConfig: () => config, soulDir, hindsightUrl, now: () => new Date(now) })
    const methods = {
      memory: () => state.memoryHealth(), emotion: () => state.emotionHealth(), life: () => state.lifeHealth(),
      qq: () => state.qqHealth(), day: () => state.herDay(date === undefined ? {} : { date }),
    }
    const out = {}
    await Promise.all(sections.filter(name => Object.hasOwn(methods, name)).map(async name => {
      try { out[name] = { value: await methods[name]() ?? null } } catch { out[name] = { failed: true } }
    }))
    return out
  },
}

async function main() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const { job, input } = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!Object.hasOwn(jobs, job)) throw Error('unknown_job')
  const value = await jobs[job](input)
  await new Promise((done, fail) => process.stdout.write(JSON.stringify(value), error => error ? fail(error) : done()))
}

main().catch(() => { process.exitCode = 1 })
