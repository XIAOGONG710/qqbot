// 「她心里的」（DSH 面板 C 层，ADR 0350，默认关）：今天的心境、感觉账按天的大概。
//
// 这是把她心里的东西给他看，所以只照她自己定过的规矩出投影（docs/plans/2026-11-26-dsh-panel-our-own.md 模块 3）：
//   · 措辞全用 packages/bot/src/emotion/feeling-ledger.ts 的 ledgerSaid / withholdOf（和召回时附的那句是同一套）：
//     疼、她妈那块只说「身上不太舒服」「心里一直悬着」，不带程度；因为他的难过 / 烦 / 担心最多到「有点」。
//   · 一条都不带来由（cause）：她说过自己那些破事不想被追着问；疼和她妈那块更是「知道有过那么回事就行」。
//     来源（source）、是不是因为他（aboutHim）也不往外给，只用来换说法。
//   · 粗的（90 天以前、或换过说法的两类）只剩「只记得个大概」，不带时刻。
//   · 只读 FEELINGS.json 和 feeling-ledger.jsonl；PRIVATE.dat、拒绝过的、她猜的、自我认识、说话习惯、追求一概不碰。
//
// 开关：插件配置 `herInnerPanel` 严格等于 true 才算开（herInnerEnabled）；默认关。等 DSH 开机 ask-her、她的原话进 ADR 0350、
// 用户点头再开。接线（index.js 路由、client.js 标签页）不在本文件：关着时路由应整块不存在（404 inner_disabled）。
//
// API
//   herInnerEnabled(config) → boolean            只有 config.herInnerPanel === true
//   createHerInner({ soulDir, root?, now? })      soulDir 可相对 root；root 默认仓库根；now() 回毫秒，默认 Date.now
//     .today()  → Promise<{ day, at, stale, feelings: [{ label, said }] }>
//         day：她的今天（凌晨 2 点换天，本机时区，YYYY-MM-DD）；at：FEELINGS.json 算出来的时刻（毫秒），不是今天的就是 null、feelings 为空；
//         stale：超过 FEELINGS_STALE_MS（3 小时）没刷新；label：种类名（开心 / 难过…），换过说法的两类是 null；
//         said：「有点烦」「很开心」「身上不太舒服」这样的一句。同一句只出一次。
//     .ledger({ days = 14 }) → Promise<{ days: [{ day, rows: [{ time, label, said, coarse }] }] }>
//         最近 days 个她的一天（含今天，1–400），新的在前；每天里按时间先后，同一天同一句只留最早那条。
//         粗的：time 为 null；没换过说法的 said 是「只记得个大概」，换过说法的是「只记得个大概：身上不太舒服」这样。
//   两个读法读不到 / 文件坏了都回空（不抛）。

import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)))
/** 她的一天从凌晨 2 点算起：熬夜过了零点还算前一天 */
const DAY_TURN_MS = 2 * 3_600_000
const pad = value => String(value).padStart(2, '0')

/** 她的一天：本机时区，凌晨 2 点前算前一天 */
export function herDayKey(at) {
  const date = new Date(at - DAY_TURN_MS)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

const clock = at => { const date = new Date(at); return `${pad(date.getHours())}:${pad(date.getMinutes())}` }

export function herInnerEnabled(config) {
  return config?.herInnerPanel === true
}

export function createHerInner({ soulDir, root = repoRoot, now = () => Date.now() }) {
  const directory = resolve(root, soulDir)
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
      const day = herDayKey(at)
      const empty = { day, at: null, stale: false, feelings: [] }
      const { readSavedFeelings, withholdOf, ledgerSaid, FEELING_NAME, FEELINGS_STALE_MS } = await modules()
      let saved
      // 只读：坏文件不隔离改名（那是 bot 自己读时的做法），读不了就当没有
      try { saved = readSavedFeelings(directory, { invalid: 'throw' }) } catch { return empty }
      if (!saved || herDayKey(saved.at) !== day || saved.at > at) return empty
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
      const { readLedger, ledgerSaid, withheldCause, FEELING_NAME } = await modules()
      let entries
      try { entries = readLedger(directory, at) } catch { return { days: [] } }
      // 最近 span 个她的一天：从今天往回数（按日历日，避开夏令时那种 24 小时不准的情况）
      const keep = new Set()
      const today = new Date(at - DAY_TURN_MS)
      for (let back = 0; back < span; back++) {
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12)
        keep.add(`${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`)
      }
      const byDay = new Map()
      for (const entry of [...entries].filter(entry => entry.at <= at).sort((a, b) => a.at - b.at)) {
        const day = herDayKey(entry.at)
        if (!keep.has(day)) continue
        const withheld = withheldCause(entry.withhold)
        const label = withheld ? null : FEELING_NAME[entry.kind]
        const said = entry.coarse
          ? (withheld ? `只记得个大概：${withheld}` : '只记得个大概')
          : ledgerSaid(entry)
        const rows = byDay.get(day) ?? []
        if (rows.some(row => row.label === label && row.said === said)) continue
        rows.push({ time: entry.coarse ? null : clock(entry.at), label, said, coarse: Boolean(entry.coarse) })
        byDay.set(day, rows)
      }
      return { days: [...byDay].sort(([a], [b]) => b.localeCompare(a)).map(([day, rows]) => ({ day, rows })) }
    },
  }
}
