// 心境参数（硬编码改造第五批，exchange/handoff/2026-11-28-hardcoded-policy-audit.md「心境与恢复（D）」）：一般情绪的衰减和灵敏度放在这一张表。
// 原来这些数散写在 QQ 的 emotion/feelings.ts（各种感受的半衰期、起始分量、三档门槛、上限）、emotion/recovery.ts（修复后的半衰期、多久以内的道歉算这一次）、
// emotion/affect.ts（余温几轮）、emotion/grievance.ts（隔几天算小别扭、别扭几轮、多久算被晾着）、emotion/feeling-export.ts（心境多久算过期），
// 和本目录 index.js 的 feelingsStaleMs（同一个过期时间，两边各抄一份）。
// 现在都在这里：默认值就是原来写死的数（一个都没改）；两边都读的概念（readers 里有 qq 和 dsh）只有这一个数。
//
// 要调：环境变量 QQBOT_FEELING_PARAMS 指向一个 JSON 文件，只写要改的键，例如 {"sadHalfLifeH": 6}。QQ 和 DSH 读同一个环境变量、
// 同一个文件、走同一个 loadFeelingParams。没设环境变量就全用默认值。
// 严格：文件读不了、不是一个 JSON 对象、有不认识的键、值不是数（该是整数的不是整数）、超出范围、三档门槛不是从小到大、
// 起始分量不是从小到大、被晾着的下限不小于上限，有一样不对就**整个文件不用**，两边一起退回默认值，issue 里写原因（只写键名和原因，不写文件内容）。
// 不在这里的：危机规则和固定兜底（crisis.ts、exit-check.ts）、私聊原因不进群（feelings.ts 的 audienceOf / feltForAudience）、
// 感觉账里她不想原样带上的两类（feeling-ledger.ts）、哪些话算道歉 / 安慰的正则——那些是规则，不是调参。

import { readFileSync } from 'node:fs'

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/**
 * 每一项：value 默认值（原来写死的数）；min / max 允许的范围；integer 是否必须是整数；readers 谁读（qq / dsh）；where 原来写在哪；note 是什么。
 * readers 同时有 qq 和 dsh 的，就是两边共用的同一个概念。
 */
export const FEELING_PARAM_SPECS = Object.freeze({
  // ── 两边共用 ──
  feelingsStaleMs: { value: 3 * HOUR, min: 10 * MINUTE, max: DAY, integer: true, readers: ['qq', 'dsh'], where: 'feeling-export.ts FEELINGS_STALE_MS；index.js DEFAULTS.feelingsStaleMs', note: 'QQ 算好的心境（FEELINGS.json）多久没刷新就不用：桌面插件、DSH 面板、群里重启后读落盘那份都按它（DSH profile 写了 feelingsStaleMs 时桌面插件以它为准）' },
  // ── 只有 QQ 读：衰减 ──
  joyHalfLifeH: { value: 5, min: 0.25, max: 72, integer: false, readers: ['qq'], where: 'feelings.ts HALF_LIFE_H.joy', note: '开心的默认半衰期（小时）；某件事自己写了半衰期时以那件事为准' },
  reliefHalfLifeH: { value: 3, min: 0.25, max: 72, integer: false, readers: ['qq'], where: 'feelings.ts HALF_LIFE_H.relief', note: '松了口气的默认半衰期（小时）' },
  worryHalfLifeH: { value: 8, min: 0.25, max: 72, integer: false, readers: ['qq'], where: 'feelings.ts HALF_LIFE_H.worry', note: '担心的默认半衰期（小时）' },
  sadHalfLifeH: { value: 8, min: 0.25, max: 72, integer: false, readers: ['qq'], where: 'feelings.ts HALF_LIFE_H.sad', note: '难过的默认半衰期（小时）' },
  annoyedHalfLifeH: { value: 4, min: 0.25, max: 72, integer: false, readers: ['qq'], where: 'feelings.ts HALF_LIFE_H.annoyed', note: '烦的默认半衰期（小时）' },
  tiredHalfLifeH: { value: 5, min: 0.25, max: 72, integer: false, readers: ['qq'], where: 'feelings.ts HALF_LIFE_H.tired', note: '累的默认半衰期（小时）' },
  halfLivesKept: { value: 4, min: 1, max: 20, integer: true, readers: ['qq'], where: 'feelings.ts HALF_LIVES_KEPT', note: '过了这么多个半衰期就当散了' },
  historyWindowMs: { value: 30 * HOUR, min: HOUR, max: 7 * DAY, integer: true, readers: ['qq'], where: 'feelings.ts HISTORY_WINDOW_MS', note: '他做的事引起的感受，聊天记录往回看多久' },
  silentAfterMs: { value: 4 * HOUR, min: 10 * MINUTE, max: DAY, integer: true, readers: ['qq'], where: 'feelings.ts historyAppraisals 的 4 * HOUR', note: '她发的话他一直没回，过了这么久才算「一直没回」' },
  // ── 只有 QQ 读：灵敏度 ──
  smallAmplitude: { value: 0.8, min: 0.05, max: 10, integer: false, readers: ['qq'], where: 'feelings.ts AMPLITUDE[1]', note: '小事刚发生时的分量（默认不到「明显」，单独一件不会表现出来）' },
  mediumAmplitude: { value: 1.5, min: 0.05, max: 10, integer: false, readers: ['qq'], where: 'feelings.ts AMPLITUDE[2]', note: '一般的事刚发生时的分量' },
  bigAmplitude: { value: 2.6, min: 0.05, max: 10, integer: false, readers: ['qq'], where: 'feelings.ts AMPLITUDE[3]', note: '大事刚发生时的分量' },
  faintAt: { value: 0.6, min: 0.05, max: 10, integer: false, readers: ['qq'], where: 'feelings.ts FAINT', note: '分量到这里才算「刚能察觉」，再低就不算' },
  clearAt: { value: 1.2, min: 0.05, max: 10, integer: false, readers: ['qq'], where: 'feelings.ts CLEAR', note: '分量到这里算「明显」，才写进提示词、记进感觉账' },
  strongAt: { value: 2.2, min: 0.05, max: 10, integer: false, readers: ['qq'], where: 'feelings.ts STRONG', note: '分量到这里算「很重」' },
  kindCap: { value: 3.4, min: 0.05, max: 20, integer: false, readers: ['qq'], where: 'feelings.ts KIND_CAP', note: '同一种感受加起来最多这么重（连着很多件事也不会无限大）' },
  warmAffectReplies: { value: 3, min: 1, max: 20, integer: true, readers: ['qq'], where: 'affect.ts AFFECT_REPLIES', note: '他明确道歉 / 安慰 / 说想念以后，余温留几轮' },
  // ── 只有 QQ 读：恢复 ──
  recoveryHalfLifeH: { value: 1, min: 0.1, max: 72, integer: false, readers: ['qq'], where: 'recovery.ts RECOVERY_HALF_LIFE_H', note: '他道歉或解释接住了以后，那件事的负面分量按这个半衰期（小时）落回去（比本来的慢就按本来的；QQBOT_FEELING_RECOVERY 开着才用）' },
  recoveryWindowMs: { value: 12 * HOUR, min: 10 * MINUTE, max: 3 * DAY, integer: true, readers: ['qq'], where: 'recovery.ts privateConversationRecovery 的 12 * 3_600_000', note: '被晾着之后多久以内的道歉算在这一次上' },
  // ── 只有 QQ 读：小别扭 ──
  grievanceGapMs: { value: 72 * HOUR, min: 6 * HOUR, max: 30 * DAY, integer: true, readers: ['qq'], where: 'grievance.ts GRIEVANCE_GAP_MS', note: '他两条消息之间隔这么久（中间她发的没人回）才算「隔了很多天」' },
  grievanceRounds: { value: 2, min: 1, max: 10, integer: true, readers: ['qq'], where: 'grievance.ts GRIEVANCE_ROUNDS', note: '他回来以后她最多别扭几轮' },
  grievanceWindowMs: { value: 3 * HOUR, min: 10 * MINUTE, max: DAY, integer: true, readers: ['qq'], where: 'grievance.ts GRIEVANCE_WINDOW_MS', note: '他回来后多久之内还算同一次别扭' },
  burstGapMs: { value: 20 * MINUTE, min: MINUTE, max: 6 * HOUR, integer: true, readers: ['qq'], where: 'grievance.ts BURST_GAP_MS', note: '她连着发的话，相隔这么久就算两串' },
  ignoredGapMs: { value: 45 * MINUTE, min: MINUTE, max: 12 * HOUR, integer: true, readers: ['qq'], where: 'grievance.ts IGNORED_GAP_MS', note: '她倾诉了几条，他隔了这么久才回才算「被晾着」' },
  ignoredMaxMs: { value: 6 * HOUR, min: 10 * MINUTE, max: 2 * DAY, integer: true, readers: ['qq'], where: 'grievance.ts IGNORED_MAX_MS', note: '隔得比这还久就不是「刚才被晾着」了' },
})

export const FEELING_PARAM_KEYS = Object.freeze(Object.keys(FEELING_PARAM_SPECS))
/** 默认值（就是原来写死的数） */
export const FEELING_PARAM_DEFAULTS = Object.freeze(Object.fromEntries(FEELING_PARAM_KEYS.map(key => [key, FEELING_PARAM_SPECS[key].value])))
/** 两边都读的键 */
export const SHARED_FEELING_PARAM_KEYS = Object.freeze(FEELING_PARAM_KEYS.filter(key => FEELING_PARAM_SPECS[key].readers.length === 2))

/** 几样之间的先后：有一样不成立就整个不用 */
function crossCheck(values) {
  if (!(values.faintAt < values.clearAt && values.clearAt < values.strongAt)) return '三档门槛 faintAt < clearAt < strongAt 不成立'
  if (values.strongAt > values.kindCap) return 'strongAt 大于 kindCap'
  if (!(values.smallAmplitude <= values.mediumAmplitude && values.mediumAmplitude <= values.bigAmplitude)) return '起始分量 small ≤ medium ≤ big 不成立'
  if (!(values.ignoredGapMs < values.ignoredMaxMs)) return 'ignoredGapMs 不小于 ignoredMaxMs'
  return undefined
}

/**
 * 用一份覆盖值（JSON 解析出来的对象）算出整张表：有一样不对就整个不用，返回默认值和原因。
 * 返回 { values, issue? }；values 是冻结的整张表。
 */
export function resolveFeelingParams(overrides) {
  const fallback = issue => ({ values: FEELING_PARAM_DEFAULTS, issue })
  if (overrides === undefined) return { values: FEELING_PARAM_DEFAULTS }
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return fallback('不是一个 JSON 对象')
  const values = { ...FEELING_PARAM_DEFAULTS }
  for (const [key, value] of Object.entries(overrides)) {
    const spec = Object.hasOwn(FEELING_PARAM_SPECS, key) ? FEELING_PARAM_SPECS[key] : undefined
    if (!spec) return fallback(`不认识的键 ${JSON.stringify(key).slice(0, 60)}`)
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback(`${key} 不是数`)
    if (spec.integer && !Number.isSafeInteger(value)) return fallback(`${key} 不是整数`)
    if (value < spec.min || value > spec.max) return fallback(`${key} 超出范围 ${spec.min}–${spec.max}`)
    values[key] = value
  }
  const crossed = crossCheck(values)
  if (crossed) return fallback(crossed)
  return { values: Object.freeze(values) }
}

/**
 * 从 QQBOT_FEELING_PARAMS 指的文件读（file 由调用方从环境变量取，两边各自 process.env.QQBOT_FEELING_PARAMS）。
 * 没给文件就是默认值；读不了 / 读不懂就默认值加原因。不抛错。read 只给测试换。
 */
export function loadFeelingParams(file, read = readFileSync) {
  if (file === undefined || file === '') return resolveFeelingParams(undefined)
  let text
  try { text = String(read(file, 'utf8')) } catch { return { values: FEELING_PARAM_DEFAULTS, issue: '文件读不了' } }
  let value
  try { value = JSON.parse(text) } catch { return { values: FEELING_PARAM_DEFAULTS, issue: '不是合法的 JSON' } }
  return resolveFeelingParams(value)
}

/** 日志那一行：调了哪几个键、改成多少，文件不对时写原因；全部默认时是空字符串（不记）。不写路径 */
export function feelingParamsLogLine(result) {
  if (result.issue) return `心境参数：QQBOT_FEELING_PARAMS 的文件没用上（${result.issue}），全部用默认值`
  const changed = FEELING_PARAM_KEYS.filter(key => result.values[key] !== FEELING_PARAM_DEFAULTS[key])
  return changed.length ? `心境参数：调过 ${changed.map(key => `${key}=${result.values[key]}`).join('，')}，其余默认` : ''
}
