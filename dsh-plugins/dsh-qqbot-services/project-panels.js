// 项目工具的只读投影（docs/plans/2026-11-26-dsh-panel-our-own.md 模块 1，A 层「运维数」）：
// 开关总览、每周效果数、提示词构成、上线前检查，给 DSH 主人面板用。纯数据模块：不起服务、不跑 git、不连网、不写文件。
// 只回名字和数：不回聊天原文、联系人、QQ 号、模型配置、密钥、路径和原始错误。路由接线在 index.js（认证之后），这里只出数据。
//
// API —— createProjectPanels({ root, readConfig, dataDir?, now?, run? })
//   root        仓库根（packages/bot/src 的 .ts 从这里动态 import）
//   readConfig  () => 解析过的 koishi.yml；qqbot 插件那一块用 chat.js 的 activeKoishiPlugin 找
//   dataDir     可选，数据目录；不给就用插件块的 dataDir（相对 root，默认 runtime/bot），同 local-panels.js
//   now         可选，() => Date；效果数的窗口按它算「到昨天为止」（「昨天」按插件配置的时区，和 bot 一样）
//   run         可选，panel-jobs.js runPanelJob 的替身（测试用）
// 效果数和提示词构成要读整份聊天记录 / 所有清单，放在子进程里算（panel-jobs.js），不卡 DSH 主线程；
// 同时来的同一个请求共用一次计算，算完 10 分钟内给缓存。
// 返回的四个方法都是 async，读不到 qqbot 插件块时回 { available: false }：
//   switches()  → { available, counts: { total, on, merged, legacyWritten }, groups: string[],
//                   features: [{ key, label, group, adr, kind: 'bool'|'mode', value, written, on,
//                                configured?, missing?, forcedOff?: 'fewerRules',
//                                merged?: { legacyWritten: string[], absorbs: [{ key, label, adr, written, value }] } }],
//                   unrepresentable: string[], invalid: boolean,
//                   fewerRules: { on, forced: [{ key, value, feature }] } }
//                 value 只会是 true / false / 档位名（字母）/ null；dsh 那种对象只取 enabled。
//   metrics({ days = 7 })
//               → { available, reason?, window: { from, to, days }, contacts, zone: { used, configured },
//                   week: Metrics, days: [{ day, ...Metrics }], previous: { at, deltas } | null }
//                 Metrics 是 ops/weekly-metrics.ts 的那组数（只留数字和 null，latency 是嵌套的数）；不写 weekly-metrics.jsonl。
//                 reason：'no_chats'（数据目录里没有 chats/）。同一窗口 10 分钟内重复取用缓存（检测器跑整份记录，慢）。
//                 zone.used：日界用的时区（插件配置的 timeZone，没写就是 bot 的默认 Asia/Shanghai）；configured：配置里写的（没写是 null）。
//   promptInventory()
//               → { available, reason?, files, firstDay, lastDay, inventory: Inventory }（ops/prompt-inventory.ts，没有 llmPurposes 的数）
//                 reason：'no_manifests'。槽名、模块名、种类按标识符过滤，别的字一律换成 '?'。
//   golive()    → { available, switches: { migrating: string[], unrepresentable: string[] } }
//                 只做开关合并预检（ops/golive-check.ts 的 switchMergeCheck）；监听地址、git 那几项要跑命令，不在面板里做。

import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activeKoishiPlugin } from './chat.js'
import { runPanelJob, sharedJob } from './panel-jobs.js'
import { DEFAULT_TIME_ZONE, shiftDay, validTimeZone, zoned } from './panel-time.js'

const METRICS_TTL_MS = 10 * 60_000
const IDENT = /^[A-Za-z0-9_.:/-]{1,60}$/
const ident = value => typeof value === 'string' && IDENT.test(value) ? value : '?'
const MODE = /^[A-Za-z]{1,24}$/

/** 一个开关值的安全投影：布尔、档位名、dsh 那种 { enabled } 只取 enabled；别的（数字以外的长字符串、对象）不回 */
function switchValue(value) {
  if (typeof value === 'boolean') return value
  if (typeof value === 'string') return MODE.test(value) ? value : '?'
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.enabled === 'boolean') return { enabled: value.enabled }
  return null
}

const isoOrNull = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null

/** 只留数字、null 和嵌套的数（效果数的「只出数」再兜一层：字符串一律丢掉） */
function numbersOnly(value) {
  if (value === null || (typeof value === 'number' && Number.isFinite(value))) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      const kept = numbersOnly(item)
      if (kept !== undefined) out[key] = kept
    }
    return out
  }
  return undefined
}

const DAY = /^\d{4}-\d{2}-\d{2}$/

export function createProjectPanels({ root, readConfig, dataDir, now = () => new Date(), run = runPanelJob }) {
  const load = file => import(pathToFileURL(join(root, file)).href)
  const plugin = () => {
    try { return activeKoishiPlugin(readConfig()) } catch { return null }
  }
  const dataDirectory = block => dataDir ? resolve(root, dataDir) : resolve(root, block.dataDir || 'runtime/bot')
  const modules = () => Promise.all([
    load('packages/bot/src/platform/features.ts'), load('packages/bot/src/platform/config.ts'),
    load('packages/bot/src/platform/switch-merge.ts'), load('packages/bot/src/language/fewer-rules.ts'),
  ]).then(([features, config, merge, fewer]) => ({ ...features, ...config, ...merge, ...fewer }))

  /** 插件块里认得的开关键（SWITCH_DEFAULTS 里有的），对象只留 enabled：合并、预检只看这些，contacts / llm 这些根本不进来 */
  function switchInput(block, SWITCH_DEFAULTS) {
    const input = {}
    for (const [key, value] of Object.entries(block)) {
      if (!(key in SWITCH_DEFAULTS)) continue
      if (['boolean', 'string', 'number'].includes(typeof value)) input[key] = value
      else if (value && typeof value === 'object' && typeof value.enabled === 'boolean' && typeof SWITCH_DEFAULTS[key] === 'object') input[key] = { enabled: value.enabled }
    }
    return input
  }

  // 10 分钟缓存 + 同键共用一次计算；缓存时刻用 now()（测试可控）
  const nowMs = () => now().getTime()
  const metricsJobs = sharedJob({ ttl: METRICS_TTL_MS, now: nowMs, max: 8 })
  const inventoryJobs = sharedJob({ ttl: METRICS_TTL_MS, now: nowMs, max: 4 })

  return {
    async switches() {
      const block = plugin()
      if (!block) return { available: false }
      const m = await modules()
      const input = switchInput(block, m.SWITCH_DEFAULTS)
      let effective
      let invalid = false
      try { effective = m.mergeSwitchInput(input, m.SWITCH_DEFAULTS) } catch { invalid = true; effective = input }
      effective = { ...m.SWITCH_DEFAULTS, ...effective }
      const fewerOn = effective.fewerRules === true
      const relaxed = m.relaxStyle({})
      const statuses = new Map(m.featureStatuses(fewerOn ? m.relaxStyle(effective) : effective).map(status => [status.key, status]))
      const mergeOf = new Map(m.SWITCH_MERGES.map(merge => [merge.key, merge]))
      const featureKeys = new Set(m.FEATURES.map(def => def.key))
      const features = m.FEATURES.map(def => {
        const status = statuses.get(def.key)
        const merge = mergeOf.get(def.key)
        const row = {
          key: def.key, label: def.label, group: def.group, adr: def.adr ?? null, kind: def.kind ?? 'bool',
          value: switchValue(effective[def.key]), written: input[def.key] !== undefined, on: status?.on === true,
          ...(status?.configured ? { configured: true, missing: status.missing } : {}),
          ...(fewerOn && def.key in relaxed ? { forcedOff: 'fewerRules' } : {}),
        }
        if (merge) {
          const labels = new Map((def.absorbs ?? []).map(item => [item.key, item]))
          row.merged = {
            legacyWritten: m.writtenLegacy(merge, input),
            absorbs: merge.legacy.map(key => ({
              key, label: labels.get(key)?.label ?? key, adr: labels.get(key)?.adr ?? null,
              written: input[key] !== undefined, value: switchValue(effective[key]),
            })),
          }
        }
        return row
      })
      return {
        available: true,
        counts: {
          total: features.length, on: features.filter(row => row.on).length,
          merged: features.filter(row => row.merged).length,
          legacyWritten: features.filter(row => row.merged?.legacyWritten.length).length,
        },
        groups: [...m.FEATURE_GROUPS],
        features,
        unrepresentable: m.unrepresentableSwitches(input, m.SWITCH_DEFAULTS),
        invalid,
        fewerRules: {
          on: fewerOn,
          forced: fewerOn ? Object.entries(relaxed).map(([key, value]) => ({ key, value: switchValue(value), feature: featureKeys.has(key) })) : [],
        },
      }
    },

    async metrics({ days = 7 } = {}) {
      const block = plugin()
      if (!block) return { available: false }
      const count = Number(days)
      if (!Number.isInteger(count) || count < 1 || count > 31) throw new RangeError('days must be an integer 1-31')
      const directory = dataDirectory(block)
      const chats = lstatSync(join(directory, 'chats'), { throwIfNoEntry: false })
      if (!chats?.isDirectory() || chats.isSymbolicLink()) return { available: false, reason: 'no_chats' }
      // 「到昨天为止」的昨天按 bot 的时区算；子进程的 TZ 也设成它，窗口和按天分组的日界都和 bot 一致
      const configured = validTimeZone(block.timeZone)
      const zone = configured ?? DEFAULT_TIME_ZONE
      const until = shiftDay(zoned(now(), zone).day, -1)
      const key = `${directory}|${zone}|${until}|${count}`
      return metricsJobs(key, async () => {
        const { result, feedback, previous } = await run('metrics', { root, directory, until, count }, { root, timeZone: zone, timeout: 120_000 })
        const at = previous && typeof previous.at === 'string' ? Date.parse(previous.at) : NaN
        return {
          available: true,
          window: { from: isoOrNull(result?.from), to: isoOrNull(result?.to), days: count },
          contacts: Number.isSafeInteger(result?.contacts) ? result.contacts : null,
          zone: { used: zone, configured },
          week: numbersOnly(result?.week) ?? {},
          days: (Array.isArray(result?.days) ? result.days : []).map(day => ({ day: DAY.test(day?.day) ? day.day : '?', ...numbersOnly({ ...day, day: undefined }) })),
          // 他的反馈（他回「假」「像」）：只有这个窗口里各几条
          feedback: feedback && Number.isSafeInteger(feedback.fake) && Number.isSafeInteger(feedback.real) ? { fake: feedback.fake, real: feedback.real } : null,
          previous: previous ? { at: Number.isFinite(at) ? new Date(at).toISOString() : null, deltas: numbersOnly(previous.deltas) ?? {} } : null,
        }
      })
    },

    async promptInventory() {
      const block = plugin()
      if (!block) return { available: false }
      const logs = join(dataDirectory(block), 'logs')
      const folder = lstatSync(logs, { throwIfNoEntry: false })
      if (!folder?.isDirectory() || folder.isSymbolicLink()) return { available: false, reason: 'no_manifests' }
      return inventoryJobs(logs, async () => {
        const { days: listed, inventory: inv } = await run('inventory', { root, logs }, { root, timeZone: validTimeZone(block.timeZone) ?? DEFAULT_TIME_ZONE })
        const days = (Array.isArray(listed) ? listed : []).filter(day => DAY.test(day)).sort()
        if (!days.length || !inv) return { available: false, reason: 'no_manifests' }
        // 名字按白名单放：槽只认 slots.ts 三张表里的，表只认 main / history / now，轮次只认 MANIFEST_KINDS；
        // 模块没有集中的清单，只放小写加连字符的 id（modules/*.ts 都是这样）。其余一律 '?'（审查 2026-11-26 记的那一笔）
        const [slotsTs, { MANIFEST_KINDS }] = await Promise.all([
          load('packages/bot/src/interpreter/slots.ts'), load('packages/bot/src/platform/prompt-manifest.ts'),
        ])
        const only = names => value => names.has(value) ? value : '?'
        const slotOf = only(new Set([...slotsTs.AFTER_MAIN_SLOTS, ...slotsTs.AFTER_HISTORY_SLOTS, ...slotsTs.NOW_SLOTS]))
        const listOf = only(new Set(['main', 'history', 'now']))
        const kindOf = only(new Set(MANIFEST_KINDS))
        const moduleOf = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(value) ? value : '?'
        const tally = map => Object.fromEntries(Object.entries(map ?? {}).filter(([, n]) => Number.isFinite(n)).map(([name, n]) => [ident(name), n]))
        const num = value => Number.isFinite(value) ? value : null
        const rows = value => Array.isArray(value) ? value : []
        return {
          available: true, files: days.length, firstDay: days[0], lastDay: days.at(-1),
          inventory: {
            rounds: numbersOnly(inv.rounds) ?? {}, chars: numbersOnly(inv.chars) ?? {}, piecesPerRound: numbersOnly(inv.piecesPerRound) ?? {},
            byKind: rows(inv.byKind).map(row => ({ kind: kindOf(row.kind), rounds: num(row.rounds), avgChars: num(row.avgChars), avgNow: num(row.avgNow), maxNow: num(row.maxNow) })),
            slots: rows(inv.slots).map(row => ({ slot: slotOf(row.slot), module: moduleOf(row.module), list: listOf(row.list),
              rounds: num(row.rounds), chars: num(row.chars), omitted: num(row.omitted), kinds: numbersOnly(row.kinds) ?? {} })),
            modules: rows(inv.modules).map(row => ({ module: moduleOf(row.module), rounds: num(row.rounds), chars: num(row.chars) })),
            extra: { reviewStages: tally(inv.extra?.reviewStages), candidateCalls: num(inv.extra?.candidateCalls), groupReasons: tally(inv.extra?.groupReasons) },
          },
        }
      })
    },

    async golive() {
      const block = plugin()
      if (!block) return { available: false }
      const [{ SWITCH_DEFAULTS }, { switchMergeCheck }] = await Promise.all([
        load('packages/bot/src/platform/config.ts'), load('packages/bot/src/ops/golive-check.ts'),
      ])
      const { migrating, unrepresentable } = switchMergeCheck(switchInput(block, SWITCH_DEFAULTS))
      return { available: true, switches: { migrating, unrepresentable }, restarts: await restarts(block) }
    },
  }

  /**
   * 重启记录（ops/restart-log.ts，<数据目录>/restarts.log）：最近 20 次重启和「距上次行为变化的重启满没满 48 小时」——
   * golive-check 拦的就是这个。原因是 agent 写的运维说明，截短并过一遍日志页的 redact；文件是链接或超过 2MB 就当没有。
   */
  async function restarts(block) {
    const file = join(dataDirectory(block), 'restarts.log')
    try {
      const stat = lstatSync(file)
      if (!stat.isFile() || stat.size > 2_000_000) return null
    } catch { return null }
    const [{ readRestartLog, behaviorGap, BEHAVIOR_GAP_MS }, { redact }] = await Promise.all([
      load('packages/bot/src/ops/restart-log.ts'), import('./logs-view.js'),
    ])
    const entries = readRestartLog(file)
    const gap = behaviorGap(entries, now())
    const row = entry => ({ at: entry.at, to: redact(String(entry.to)).slice(0, 40), kind: entry.kind,
      reason: redact(String(entry.reason)).slice(0, 120), by: redact(String(entry.by)).slice(0, 40) })
    return {
      count: entries.length,
      recent: entries.slice(-20).reverse().map(row),
      behavior: { ok: gap.ok, gapHours: BEHAVIOR_GAP_MS / 3_600_000, hoursSince: gap.sinceMs === undefined ? null : Math.floor(gap.sinceMs / 3_600_000),
        last: gap.last ? row(gap.last) : null },
    }
  }
}
