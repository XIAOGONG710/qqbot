// 日志页：只从已知的两个日志文件取结构化摘要，分页、按状态筛选。
//
// 原始行一律不交给页面：自由文本（对话、令牌、URL 参数、异常堆栈）在解析这一层就被丢掉，
// 页面和导出里只剩时间、服务、事件类别和召回的几个计数。这样交接材料里不会夹带聊天原文，
// 导出也不需要再猜哪些字敏感。
import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 只认这两个文件；新来源要显式加在这里 */
export const LOG_SOURCES = {
  operations: { label: '运维事件', file: 'runtime/services-watchdog.log', home: false },
  recall: { label: '召回诊断', file: '.dsh/linmengyao-memory.log', home: true },
}
export const LOG_LIMIT = 20
const MAX_LIMIT = 50
const MAX_PAGE = 50
const EXPORT_MAX = 500
const TAIL_BYTES = 48_000

export const EVENT_LABELS = {
  watching: '开始监测',
  recovered: '恢复正常',
  starting: '尝试启动',
  prepared: '准备启动',
  failed: '运行异常',
  backup: '备份',
  matched: '配对成功',
  'no-match': '没有配对',
  'not-queried': '没查到',
}

function tail(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const len = Math.min(TAIL_BYTES, size)
    const buffer = Buffer.alloc(len)
    const bytes = readSync(fd, buffer, 0, len, size - len)
    const rows = buffer.subarray(0, bytes).toString('utf8').split(/\r?\n/)
    return size > len ? rows.slice(1) : rows
  } catch { return [] }
  finally { if (fd !== undefined) closeSync(fd) }
}

/** 守护日志 → 结构化事件；只认服务名和事件词，其余文字全部丢掉 */
export function summarizeWatchdog(lines, limit = 12) {
  return lines.flatMap(line => {
    const stamp = /^(\d{4}\/\d{1,2}\/\d{1,2} \d{2}:\d{2}:\d{2})\s+(.*)$/.exec(line)
    if (!stamp) return []
    const text = stamp[2]
    const service = /^(napcat|hindsight|koishi)[:：]/i.exec(text)?.[1]?.toLowerCase()
    const event = text.startsWith('服务守护：') ? 'watching'
      : text.startsWith('备份：') ? 'backup'
      : /恢复正常/.test(text) ? 'recovered'
      : /拉起|重拉/.test(text) ? 'starting'
      : /失败|不健康|出错|起不来/.test(text) ? 'failed'
      : undefined
    const target = service ?? (text.startsWith('备份：') ? 'backup' : 'watchdog')
    return event ? [{ at: stamp[1], service: target, event }] : []
  }).slice(-limit).reverse()
}

/** 召回日志 → 只留几个计数，不带走查询词和命中的记忆 */
export function summarizeRecallLog(lines) {
  return lines.flatMap(line => {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) recall items=(\d{1,7}) selected=(\d{1,7}) memoryChars=(\d{1,7}) important=(failed|no-match|not-queried|matched) failedBanks=(\d{1,7})$/.exec(line)
    return match ? [{ at: match[1], items: Number(match[2]), selected: Number(match[3]), chars: Number(match[4]),
      important: match[5], failed: Number(match[6]) }] : []
  }).slice(-60).reverse()
}

/** 兜底：万一将来拼进去自由文本，这些字面量也要被抹掉再出门 */
export function redact(text) {
  return String(text)
    .replace(/((?:token|secret|password|passwd|session|cookie|authorization|api[_-]?key)\s*[=:]\s*)[^\s,;&]+/gi, '$1<隐藏>')
    .replace(/([?&][^=\s&]+=)[^\s&]*/g, '$1<隐藏>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<隐藏>')
}

const clamp = (value, min, max, fallback) => Number.isSafeInteger(value) && value >= min && value <= max ? value : fallback

/**
 * @param {object} options
 * @param {string} options.root 仓库根
 * @param {string} [options.home] 家目录（召回日志在那里）
 * @param {(file: string) => string[]} [options.readTail]
 */
export function createLogsView({ root, home = homedir(), readTail = tail }) {
  const pathOf = source => LOG_SOURCES[source].home
    ? join(home, LOG_SOURCES[source].file)
    : resolve(root, LOG_SOURCES[source].file)

  function rowsOf(source) {
    const lines = readTail(pathOf(source))
    return source === 'recall' ? summarizeRecallLog(lines) : summarizeWatchdog(lines, EXPORT_MAX)
  }

  function list({ source = 'operations', events = [], page = 1, limit = LOG_LIMIT } = {}) {
    if (!Object.hasOwn(LOG_SOURCES, source)) return null
    const wanted = Array.isArray(events) ? events.filter(event => typeof event === 'string') : []
    const all = rowsOf(source)
    const rows = wanted.length ? all.filter(row => wanted.includes(row.event)) : all
    const size = clamp(limit, 1, MAX_LIMIT, LOG_LIMIT)
    const current = clamp(page, 1, MAX_PAGE, 1)
    const start = (current - 1) * size
    return {
      source,
      label: LOG_SOURCES[source].label,
      page: current,
      limit: size,
      total: rows.length,
      items: rows.slice(start, start + size),
    }
  }

  /** 导出：只拼结构化字段，超量按最新若干条截断 */
  function exportText({ source = 'operations', events = [] } = {}) {
    if (!Object.hasOwn(LOG_SOURCES, source)) return null
    const wanted = Array.isArray(events) ? events.filter(event => typeof event === 'string') : []
    const all = rowsOf(source)
    const rows = (wanted.length ? all.filter(row => wanted.includes(row.event)) : all).slice(0, EXPORT_MAX)
    const line = row => source === 'recall'
      ? `${row.at} 召回 items=${row.items} selected=${row.selected} chars=${row.chars} important=${EVENT_LABELS[row.important] ?? row.important} failed=${row.failed}`
      : `${row.at} ${row.service} ${EVENT_LABELS[row.event] ?? row.event}`
    return redact([
      `# 林梦瑶 · ${LOG_SOURCES[source].label}（结构化摘要，共 ${rows.length} 条）`,
      '# 只含时间、服务、事件类别与计数；对话原文、令牌、URL 参数和异常堆栈不在此列。',
      ...rows.map(line),
    ].join('\n'))
  }

  return { list, exportText, pathOf }
}
