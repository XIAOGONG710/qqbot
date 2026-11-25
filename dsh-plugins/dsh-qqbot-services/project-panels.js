// 项目工具的只读投影（docs/plans/2026-11-26-dsh-panel-our-own.md 模块 1，A 层「运维数」）：
// 开关总览、每周效果数、提示词构成、上线前检查，给 DSH 主人面板用。纯数据模块：不起服务、不跑 git、不连网、不写文件。
// 只回名字和数：不回聊天原文、联系人、QQ 号、模型配置、密钥、路径和原始错误。路由接线在 index.js（认证之后），这里只出数据。
//
// API —— createProjectPanels({ root, readConfig, dataDir?, now? })
//   root        仓库根（packages/bot/src 的 .ts 从这里动态 import）
//   readConfig  () => 解析过的 koishi.yml；qqbot 插件那一块用 chat.js 的 activeKoishiPlugin 找
//   dataDir     可选，数据目录；不给就用插件块的 dataDir（相对 root，默认 runtime/bot），同 local-panels.js
//   now         可选，() => Date；效果数的窗口按它算「到昨天为止」
// 返回的四个方法都是 async，读不到 qqbot 插件块时回 { available: false }：
//   switches()  → { available, counts: { total, on, merged, legacyWritten }, groups: string[],
//                   features: [{ key, label, group, adr, kind: 'bool'|'mode', value, written, on,
//                                configured?, missing?, forcedOff?: 'fewerRules',
//                                merged?: { legacyWritten: string[], absorbs: [{ key, label, adr, written, value }] } }],
//                   unrepresentable: string[], invalid: boolean,
//                   fewerRules: { on, forced: [{ key, value, feature }] } }
//                 value 只会是 true / false / 档位名（字母）/ null；dsh 那种对象只取 enabled。
//   metrics({ days = 7 })
//               → { available, reason?, window: { from, to, days }, contacts, zone: { process, configured, matches },
//                   week: Metrics, days: [{ day, ...Metrics }], previous: { at, deltas } | null }
//                 Metrics 是 ops/weekly-metrics.ts 的那组数（只留数字和 null，latency 是嵌套的数）；不写 weekly-metrics.jsonl。
//                 reason：'no_chats'（数据目录里没有 chats/）。同一窗口 10 分钟内重复取用缓存（检测器跑整份记录，慢）。
//   promptInventory()
//               → { available, reason?, files, firstDay, lastDay, inventory: Inventory }（ops/prompt-inventory.ts，没有 llmPurposes 的数）
//                 reason：'no_manifests'。槽名、模块名、种类按标识符过滤，别的字一律换成 '?'。
//   golive()    → { available, switches: { migrating: string[], unrepresentable: string[] } }
//                 只做开关合并预检（ops/golive-check.ts 的 switchMergeCheck）；监听地址、git 那几项要跑命令，不在面板里做。

import { lstatSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activeKoishiPlugin } from './chat.js'

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

const localDay = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`

export function createProjectPanels({ root, readConfig, dataDir, now = () => new Date() }) {
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

  const metricsCache = new Map()

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
      const at = now()
      const until = localDay(new Date(at.getFullYear(), at.getMonth(), at.getDate() - 1))
      const key = `${directory}|${until}|${count}`
      const cached = metricsCache.get(key)
      if (cached && at.getTime() - cached.at < METRICS_TTL_MS && at.getTime() >= cached.at) return cached.value
      const w = await load('packages/bot/src/ops/weekly-metrics.ts')
      const window = w.windowOf(until, count)
      const { chats: history, proactiveIds } = w.loadMetricsData(directory)
      const result = w.computeWeeklyMetrics({ chats: history, proactiveIds, ...window, scope: 'all' })
      const previous = w.previousRun(w.metricsLogPath(directory), 'all')
      const processZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const configured = typeof block.timeZone === 'string' && /^[A-Za-z_/+-]{1,40}$/.test(block.timeZone) ? block.timeZone : null
      const value = {
        available: true,
        window: { from: result.from, to: result.to, days: count },
        contacts: result.contacts,
        // 她的日界按插件配置的时区；面板不改 DSH 进程的 TZ，两边不一致时这里标出来
        zone: { process: processZone, configured, matches: configured === null || configured === processZone },
        week: numbersOnly(result.week),
        days: result.days.map(day => ({ day: /^\d{4}-\d{2}-\d{2}$/.test(day.day) ? day.day : '?', ...numbersOnly({ ...day, day: undefined }) })),
        previous: previous ? {
          at: Number.isFinite(Date.parse(previous.at)) ? new Date(previous.at).toISOString() : null,
          deltas: numbersOnly(w.compareMetrics(previous.week, result.week)),
        } : null,
      }
      metricsCache.clear()
      metricsCache.set(key, { at: at.getTime(), value })
      return value
    },

    async promptInventory() {
      const block = plugin()
      if (!block) return { available: false }
      const logs = join(dataDirectory(block), 'logs')
      const folder = lstatSync(logs, { throwIfNoEntry: false })
      if (!folder?.isDirectory() || folder.isSymbolicLink()) return { available: false, reason: 'no_manifests' }
      const [{ inventory, readManifests }, { MANIFEST_FILE }] = await Promise.all([
        load('packages/bot/src/ops/prompt-inventory.ts'), load('packages/bot/src/platform/prompt-manifest.ts'),
      ])
      const days = readdirSync(logs).map(name => MANIFEST_FILE.exec(name)?.[1]).filter(Boolean).sort()
      if (!days.length) return { available: false, reason: 'no_manifests' }
      const inv = inventory(readManifests(logs))
      const tally = map => Object.fromEntries(Object.entries(map).map(([name, n]) => [ident(name), n]))
      return {
        available: true, files: days.length, firstDay: days[0], lastDay: days.at(-1),
        inventory: {
          rounds: numbersOnly(inv.rounds), chars: numbersOnly(inv.chars), piecesPerRound: numbersOnly(inv.piecesPerRound),
          byKind: inv.byKind.map(row => ({ kind: ident(row.kind), rounds: row.rounds, avgChars: row.avgChars, avgNow: row.avgNow, maxNow: row.maxNow })),
          slots: inv.slots.map(row => ({ slot: ident(row.slot), module: ident(row.module), list: ident(row.list),
            rounds: row.rounds, chars: row.chars, omitted: row.omitted, kinds: numbersOnly(row.kinds) })),
          modules: inv.modules.map(row => ({ module: ident(row.module), rounds: row.rounds, chars: row.chars })),
          extra: { reviewStages: tally(inv.extra.reviewStages), candidateCalls: inv.extra.candidateCalls, groupReasons: tally(inv.extra.groupReasons) },
        },
      }
    },

    async golive() {
      const block = plugin()
      if (!block) return { available: false }
      const [{ SWITCH_DEFAULTS }, { switchMergeCheck }] = await Promise.all([
        load('packages/bot/src/platform/config.ts'), load('packages/bot/src/ops/golive-check.ts'),
      ])
      const { migrating, unrepresentable } = switchMergeCheck(switchInput(block, SWITCH_DEFAULTS))
      return { available: true, switches: { migrating, unrepresentable } }
    },
  }
}
