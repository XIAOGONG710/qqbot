// 「她心里的」（DSH 面板 C 层，ADR 0350，默认关）：今天的心境、感觉账按天的大概。
//
// 这是把她心里的东西给他看，所以只照她自己定过的规矩出投影（docs/plans/2026-11-26-dsh-panel-our-own.md 模块 3）：
//   · 措辞全用 packages/bot/src/emotion/feeling-ledger.ts 的 ledgerSaid / withholdOf（和召回时附的那句是同一套）：
//     疼、她妈那块只说「身上不太舒服」「心里一直悬着」，不带程度；因为他的难过 / 烦 / 担心最多到「有点」。
//   · 一条都不带来由（cause）：她说过自己那些破事不想被追着问；疼和她妈那块更是「知道有过那么回事就行」。
//     来源（source）、是不是因为他（aboutHim）也不往外给，只用来换说法。
//   · 粗的（90 天以前、或换过说法的两类）只剩「只记得个大概」，不带时刻、也不带种类（label 为 null）。
//   · 账里没写 withhold 的旧行，按来由再判一次是不是那两类（同 withholdOf），不因为旧行少个字段就把疼、她妈那块原样说出来。
//   · 她的一天按插件配置的时区（bot 进程的时区，ADR 0331）算，不按面板进程的；文件是链接、或太大，都当没有。
//   · 只读 FEELINGS.json 和 feeling-ledger.jsonl；PRIVATE.dat、拒绝过的、她猜的、自我认识、说话习惯、追求一概不碰。
//
// 开关：插件配置 `herInnerPanel` 严格等于 true 才算开（herInnerEnabled）；默认关。等 DSH 开机 ask-her、她的原话进 ADR 0350、
// 用户点头再开。接线（index.js 路由、client.js 标签页）不在本文件：关着时路由应整块不存在（404 inner_disabled）。
//
// API
//   herInnerEnabled(config) → boolean            只有 config.herInnerPanel === true
//   createHerInner({ soulDir, root?, now?, timeZone? })  soulDir 可相对 root；root 默认仓库根；now() 回毫秒，默认 Date.now；
//                                                     timeZone 是时区名或回时区名的函数（每次调用时取），默认 Asia/Shanghai
//     .today()  → Promise<{ day, at, stale, feelings: [{ label, said }] }>
//         day：她的今天（凌晨 2 点换天，配置的时区，YYYY-MM-DD）；at：FEELINGS.json 算出来的时刻（毫秒），不是今天的就是 null、feelings 为空；
//         stale：超过 FEELINGS_STALE_MS（3 小时）没刷新；label：种类名（开心 / 难过…），换过说法的两类是 null；
//         said：「有点烦」「很开心」「身上不太舒服」这样的一句。同一句只出一次。
//     .ledger({ days = 14 }) → Promise<{ days: [{ day, rows: [{ time, label, said, coarse }] }] }>
//         最近 days 个她的一天（含今天，1–400），新的在前；每天里按时间先后，同一天同一句只留最早那条。
//         粗的：time、label 为 null；没换过说法的 said 是「只记得个大概」，换过说法的是「只记得个大概：身上不太舒服」这样。
//   两个读法读不到 / 文件坏了都回空（不抛）。

import { lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { DEFAULT_TIME_ZONE, herDayOf, shiftDay, validTimeZone, zoned } from './panel-time.js'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
/** FEELINGS.json、感觉账的大小上限：超了当没有，不把大文件读进面板进程 */
const FEELINGS_MAX = 2_000_000
const LEDGER_MAX = 16_000_000

/** 她的一天：timeZone 里凌晨 2 点前算前一天 */
export function herDayKey(at, timeZone = DEFAULT_TIME_ZONE) {
  return herDayOf(new Date(at), timeZone)
}

/** 普通文件（不是链接）、不太大 */
function ordinary(path, size) {
  try {
    const info = lstatSync(path)
    return info.isFile() && !info.isSymbolicLink() && info.size <= size
  } catch { return false }
}

export function herInnerEnabled(config) {
  return config?.herInnerPanel === true
}

export function createHerInner({ soulDir, root = repoRoot, now = () => Date.now(), timeZone = DEFAULT_TIME_ZONE }) {
  const directory = resolve(root, soulDir)
  const zone = () => {
    try { return validTimeZone(typeof timeZone === 'function' ? timeZone() : timeZone) ?? DEFAULT_TIME_ZONE } catch { return DEFAULT_TIME_ZONE }
  }
  const load = file => import(pathToFileURL(join(root, file)).href)
  const modules = async () => {
    const [ledger, exported, feelings] = await Promise.all([
      load('packages/bot/src/emotion/feeling-ledger.ts'),
      load('packages/bot/src/emotion/feeling-export.ts'),
      load('packages/bot/src/emotion/feelings.ts'),
    ])
    return { ...ledger, ...exported, FEELING_NAME: feelings.FEELING_NAME }
  }

  return {
    async today() {
      const at = now()
      const timeZone = zone()
      const day = herDayKey(at, timeZone)
      const empty = { day, at: null, stale: false, feelings: [] }
      const { readSavedFeelings, withholdOf, ledgerSaid, FEELING_NAME, FEELINGS_STALE_MS, feelingsExportPath } = await modules()
      if (!ordinary(feelingsExportPath(directory), FEELINGS_MAX)) return empty
      let saved
      // 只读：坏文件不隔离改名（那是 bot 自己读时的做法），读不了就当没有
      try { saved = readSavedFeelings(directory, { invalid: 'throw' }) } catch { return empty }
      if (!saved || herDayKey(saved.at, timeZone) !== day || saved.at > at) return empty
      const seen = new Set()
      const feelings = []
      for (const item of saved.felt) {
        if (item.level !== 'clear' && item.level !== 'strong') continue
        // 来由只在这里用来判断是不是那两类，不往外给
        const withhold = withholdOf(item.kind, item.cause)
        const said = ledgerSaid({ kind: item.kind, level: item.level, aboutHim: item.aboutHim, withhold })
        if (seen.has(said)) continue
        seen.add(said)
        feelings.push({ label: withhold ? null : FEELING_NAME[item.kind], said })
      }
      return { day, at: saved.at, stale: at - saved.at > FEELINGS_STALE_MS, feelings }
    },

    async ledger({ days = 14 } = {}) {
      const span = Math.min(400, Math.max(1, Math.floor(Number(days)) || 14))
      const at = now()
      const timeZone = zone()
      const { readLedger, ledgerSaid, withheldCause, withholdOf, FEELING_NAME, ledgerPath } = await modules()
      if (!ordinary(ledgerPath(directory), LEDGER_MAX)) return { days: [] }
      let entries
      try { entries = readLedger(directory, at) } catch { return { days: [] } }
      // 最近 span 个她的一天：从今天往回数（按日历日，避开夏令时那种 24 小时不准的情况）
      const keep = new Set()
      const today = herDayKey(at, timeZone)
      for (let back = 0; back < span; back++) keep.add(shiftDay(today, -back))
      const byDay = new Map()
      for (const entry of [...entries].filter(entry => entry.at <= at).sort((a, b) => a.at - b.at)) {
        const day = herDayKey(entry.at, timeZone)
        if (!keep.has(day)) continue
        // 旧行可能没写 withhold：按来由再判一次（来由只在这里用，不往外给）
        const withhold = entry.withhold || withholdOf(entry.kind, entry.cause)
        const withheld = withheldCause(withhold)
        // 换过说法的两类、粗的（只记得个大概）都不带种类
        const coarse = Boolean(entry.coarse) || Boolean(withheld)
        const label = withheld || coarse ? null : FEELING_NAME[entry.kind]
        const said = coarse
          ? (withheld ? `只记得个大概：${withheld}` : '只记得个大概')
          : ledgerSaid({ ...entry, withhold })
        const rows = byDay.get(day) ?? []
        if (rows.some(row => row.label === label && row.said === said)) continue
        rows.push({ time: coarse ? null : zoned(new Date(entry.at), timeZone).time, label, said, coarse })
        byDay.set(day, rows)
      }
      return { days: [...byDay].sort(([a], [b]) => b.localeCompare(a)).map(([day, rows]) => ({ day, rows })) }
    },
  }
}
