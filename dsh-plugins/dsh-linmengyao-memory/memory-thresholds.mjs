// 记忆阈值（硬编码改造第三批，exchange/handoff/2026-11-28-hardcoded-policy-audit.md「记忆、遗忘和技能（I、J）」）：QQ 和 DSH 共用的一张表。
// 原来记忆变淡的天数、两边互读的窗口、保留期、每句多少字、召回超时这些数，散写在 QQ 的 fading.ts / cross-recent.ts / long-term.ts /
// desktop-log.ts / dsh-inbox.ts / notebook-learning.ts 和本目录 index.js 里，两边各抄一份，靠契约测试对齐。
// 现在都在这里：默认值就是原来写死的数（一个都没改）；两边都读的概念（readers 里有 qq 和 dsh）只有这一个数，两边从同一处拿。
//
// 要调：环境变量 QQBOT_MEMORY_THRESHOLDS 指向一个 JSON 文件，只写要改的键，例如 {"clearDays": 10}。QQ 和 DSH 读同一个环境变量、
// 同一个文件、走同一个 loadMemoryThresholds，所以读到的数一定一样。没设环境变量就全用默认值。
// 严格：文件读不了、不是一个 JSON 对象、有不认识的键、值不是整数或超出范围、clearDays 大于 vagueDays，有一样不对就**整个文件不用**，
// 两边一起退回默认值，issue 里写原因（只写键名和原因，不写文件内容）。宁可不调，也不让两边各用一半。
// 安全上限（Hindsight 回应的字节上限、撤回清单留多少个、时钟偏差容忍）不在这里：那些是保护，不是调参。

import { readFileSync } from 'node:fs'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 每一项：value 默认值（原来写死的数）；min / max 允许的范围；readers 谁读（qq / dsh）；where 原来写在哪；note 是什么。
 * readers 同时有 qq 和 dsh 的，就是两边共用的同一个概念。
 */
export const MEMORY_THRESHOLD_SPECS = Object.freeze({
  // ── 两边共用 ──
  clearDays: { value: 7, min: 1, max: 365, readers: ['qq', 'dsh'], where: 'fading.ts CLEAR_DAYS；index.js MEMORY_CLEAR_DAYS', note: '只提过一次的事几天以内记得清楚（提过两次以上、周记和阶段总结翻倍）；QQ 提示词里的聊天原文也只放这么多天以内的' },
  vagueDays: { value: 30, min: 1, max: 3650, readers: ['qq', 'dsh'], where: 'fading.ts VAGUE_DAYS；index.js MEMORY_VAGUE_DAYS', note: '几天以内记个大概；再早的想不起来，他提到相关的人和事才想起' },
  crossWindowMs: { value: 6 * HOUR, min: 10 * MINUTE, max: 7 * DAY, readers: ['qq', 'dsh'], where: 'cross-recent.ts CROSS_WINDOW_MS；index.js CROSS_WINDOW_MS', note: '两边互读最近几轮时只看这么久以内的（更早的靠语义召回）' },
  crossLineChars: { value: 200, min: 20, max: 2000, readers: ['qq', 'dsh'], where: 'cross-recent.ts CROSS_LINE_CHARS；index.js CROSS_LINE_CHARS', note: '互读最近几轮时每句最多放多少字' },
  crossTailBytes: { value: 64 * 1024, min: 4 * 1024, max: 1024 * 1024, readers: ['qq', 'dsh'], where: 'cross-recent.ts TAIL_BYTES；index.js CROSS_TAIL_BYTES', note: '互读时从聊天 / 桌面记录文件尾部最多读多少字节' },
  desktopKeepMs: { value: 14 * DAY, min: DAY, max: 90 * DAY, readers: ['qq', 'dsh'], where: 'desktop-log.ts DESKTOP_LOG_KEEP_MS；index.js DESKTOP_KEEP_MS', note: '桌面回合（desktop-recent.jsonl 和 QQ 的桌面记录）留多久' },
  desktopTextChars: { value: 600, min: 50, max: 4000, readers: ['qq', 'dsh'], where: 'desktop-log.ts DESKTOP_LOG_TEXT_CHARS；index.js recordDesktopTurn 的 600', note: '桌面回合每边（他说的、她说的）最多记多少字；QQ 收进来时超过的整行不认，所以两边必须一样' },
  inboxMaxAgeMs: { value: 30 * DAY, min: DAY, max: 365 * DAY, readers: ['qq', 'dsh'], where: 'dsh-inbox.ts INBOX_MAX_AGE_MS；index.js INBOX_MAX_AGE_MS', note: '桌面写给 QQ 的时间线 / 世界事件收件箱里，多久以前的不收' },
  recallTimeoutMs: { value: 3000, min: 200, max: 30_000, readers: ['qq', 'dsh'], where: 'config.ts DEFAULTS.memory.recallTimeoutMs；index.js recallAll 的 3000', note: '每一轮召回最多等多久，到点就不带记忆照常聊（QQ 的 config.json 里 memory.recallTimeoutMs 写了数时仍以它为准）' },
  feelingCoarseAfterDays: { value: 90, min: 7, max: 3650, readers: ['qq', 'dsh'], where: 'feeling-ledger.ts COARSE_AFTER_DAYS；index.js FEELING_COARSE_AFTER_DAYS', note: '感觉账里多少天以前的降成「粗」（开心、松口气不降）' },
  // ── 只有 QQ 读 ──
  rawMessages: { value: 80, min: 10, max: 1000, readers: ['qq'], where: 'fading.ts RAW_MESSAGES', note: '提示词里的原始聊天最多几条' },
  maxRecalled: { value: 12, min: 1, max: 50, readers: ['qq'], where: 'long-term.ts MAX_RECALLED', note: '他的私人记忆最多放几条' },
  sharedRecalled: { value: 6, min: 1, max: 50, readers: ['qq'], where: 'long-term.ts SHARED_RECALLED', note: '公共记忆最多放几条' },
  personRecalled: { value: 6, min: 1, max: 50, readers: ['qq'], where: 'long-term.ts PERSON_RECALLED', note: '被提起的人的记忆最多放几条' },
  todayOthers: { value: 3, min: 0, max: 20, readers: ['qq'], where: 'long-term.ts TODAY_OTHERS', note: '新一段对话里「今天跟别人聊过的」最多几条' },
  sameThingRecalled: { value: 2, min: 1, max: 20, readers: ['qq'], where: 'long-term.ts SAME_THING_RECALLED', note: '同一个人和事一次最多放几条（他这次说到的不限）' },
  recallTokens: { value: 1000, min: 100, max: 8000, readers: ['qq'], where: 'long-term.ts RECALL_TOKENS', note: '一次召回向 Hindsight 要多少 token' },
  dayRecallTokens: { value: 2000, min: 100, max: 8000, readers: ['qq'], where: 'long-term.ts DAY_RECALL_TOKENS', note: '问到某一天时公共记忆多要多少 token' },
  maxQueryChars: { value: 300, min: 50, max: 300, readers: ['qq'], where: 'long-term.ts MAX_QUERY_CHARS', note: '召回查询最多多少字（Hindsight 超过 500 token 直接 400，所以上限就是 300）' },
  recalledLineChars: { value: 200, min: 40, max: 2000, readers: ['qq'], where: 'long-term.ts formatRecalled 的 200', note: '召回的每条记忆最多放多少字' },
  recallBreakerTimeouts: { value: 2, min: 1, max: 20, readers: ['qq'], where: 'long-term.ts RECALL_BREAKER_TIMEOUTS', note: 'Hindsight 卡住时连续超时几次就熔断' },
  recallBreakerMs: { value: MINUTE, min: 5000, max: HOUR, readers: ['qq'], where: 'long-term.ts RECALL_BREAKER_MS', note: '熔断后多久之内不查' },
  memoryTimeoutMs: { value: 30_000, min: 1000, max: 10 * MINUTE, readers: ['qq'], where: 'config.ts DEFAULTS.memory.timeoutMs', note: '写入、整理这类不在回复路上的记忆请求最多等多久（config.json 写了数时以它为准）' },
  desktopMaxTurns: { value: 3, min: 1, max: 20, readers: ['qq'], where: 'cross-recent.ts DESKTOP_MAX_TURNS', note: 'QQ 提示词里最多放几轮桌面对话' },
  notebookMaxAttempts: { value: 80, min: 1, max: 1000, readers: ['qq'], where: 'notebook-learning.ts MAX_ATTEMPTS', note: '查读书笔记的经验最多留几次尝试' },
  notebookMaxAgeMs: { value: 30 * DAY, min: DAY, max: 365 * DAY, readers: ['qq'], where: 'notebook-learning.ts MAX_AGE', note: '查读书笔记的经验多久以前的不再用' },
  // ── 只有 DSH 读 ──
  desktopPick: { value: 6, min: 1, max: 50, readers: ['dsh'], where: 'index.js DEFAULTS.pick', note: '桌面上一轮最多放几条记忆（profile 里写了 pick 时以它为准）' },
  desktopMaxChars: { value: 1400, min: 100, max: 20_000, readers: ['dsh'], where: 'index.js DEFAULTS.maxChars', note: '桌面上记忆那一块最多多少字（profile 里写了 maxChars 时以它为准）' },
  desktopRecallTokens: { value: 1200, min: 100, max: 8000, readers: ['dsh'], where: 'index.js recallBank 的 max_tokens', note: '桌面上一次召回向 Hindsight 要多少 token' },
  bankListTimeoutMs: { value: 2500, min: 200, max: 30_000, readers: ['dsh'], where: 'index.js allBanks 的 2500', note: '桌面上列 bank 最多等多久（还受 recallTimeoutMs 的总截止管）' },
  qqRecentLines: { value: 10, min: 1, max: 100, readers: ['dsh'], where: 'index.js qqRecentBlock 的 10', note: '桌面上最多放几句他刚在 QQ 上说的' },
})

export const MEMORY_THRESHOLD_KEYS = Object.freeze(Object.keys(MEMORY_THRESHOLD_SPECS))
/** 默认值（就是原来写死的数） */
export const MEMORY_THRESHOLD_DEFAULTS = Object.freeze(Object.fromEntries(MEMORY_THRESHOLD_KEYS.map(key => [key, MEMORY_THRESHOLD_SPECS[key].value])))
/** 两边都读的键 */
export const SHARED_MEMORY_THRESHOLD_KEYS = Object.freeze(MEMORY_THRESHOLD_KEYS.filter(key => MEMORY_THRESHOLD_SPECS[key].readers.length === 2))

/**
 * 用一份覆盖值（JSON 解析出来的对象）算出整张表：有一样不对就整个不用，返回默认值和原因。
 * 返回 { values, issue? }；values 是冻结的整张表。
 */
export function resolveMemoryThresholds(overrides) {
  const fallback = issue => ({ values: MEMORY_THRESHOLD_DEFAULTS, issue })
  if (overrides === undefined) return { values: MEMORY_THRESHOLD_DEFAULTS }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return fallback('不是一个 JSON 对象')
  const values = { ...MEMORY_THRESHOLD_DEFAULTS }
  for (const [key, value] of Object.entries(overrides)) {
    const spec = Object.hasOwn(MEMORY_THRESHOLD_SPECS, key) ? MEMORY_THRESHOLD_SPECS[key] : undefined
    if (!spec) return fallback(`不认识的键 ${JSON.stringify(key).slice(0, 60)}`)
    if (!Number.isSafeInteger(value)) return fallback(`${key} 不是整数`)
    if (value < spec.min || value > spec.max) return fallback(`${key} 超出范围 ${spec.min}–${spec.max}`)
    values[key] = value
  }
  if (values.clearDays > values.vagueDays) return fallback('clearDays 大于 vagueDays')
  return { values: Object.freeze(values) }
}

/**
 * 从 QQBOT_MEMORY_THRESHOLDS 指的文件读（file 由调用方从环境变量取，两边各自 process.env.QQBOT_MEMORY_THRESHOLDS）。
 * 没给文件就是默认值；读不了 / 读不懂就默认值加原因。不抛错。read 只给测试换。
 */
export function loadMemoryThresholds(file, read = readFileSync) {
  if (file === undefined || file === '') return resolveMemoryThresholds(undefined)
  let text
  try { text = String(read(file, 'utf8')) } catch { return { values: MEMORY_THRESHOLD_DEFAULTS, issue: '文件读不了' } }
  let value
  try { value = JSON.parse(text) } catch { return { values: MEMORY_THRESHOLD_DEFAULTS, issue: '不是合法的 JSON' } }
  return resolveMemoryThresholds(value)
}

/** 日志那一行：用了默认值还是调过的（调了哪几个键、改成多少），文件不对时写原因；不写路径 */
export function memoryThresholdsLogLine(result) {
  if (result.issue) return `记忆阈值：QQBOT_MEMORY_THRESHOLDS 的文件没用上（${result.issue}），全部用默认值`
  const changed = MEMORY_THRESHOLD_KEYS.filter(key => result.values[key] !== MEMORY_THRESHOLD_DEFAULTS[key])
  return changed.length ? `记忆阈值：调过 ${changed.map(key => `${key}=${result.values[key]}`).join('，')}，其余默认` : '记忆阈值：全部默认'
}
