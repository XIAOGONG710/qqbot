// 她的状态（DSH 面板第 2 块，docs/plans/2026-11-26-dsh-panel-our-own.md 模块 2，A 层 + B 层）：纯数据模块，不注册路由、不写任何文件。
//
// 边界（计划「边界」一节，她定过的，不因为是面板就破）：
//   · A 层只有数和新鲜度：记忆只碰公共库和他本人的 bank 的**计数**（Hindsight 的 stats 接口），不列记忆原文、不枚举别的 bank、不出库名；
//     情绪只给 FEELINGS.json 多久前导出、感觉账总条数和最近一条的时间——不给种类、不给来由、不给换过的说法（ADR 0347 第 5 层）；
//   · B 层「她的一天」只来自世界账（<数据目录>/world/events.json）里她真做过的事，用 QQ 状态行同一套说法（life/actions.ts typedOccupation、
//     world.ts recapDay、life/promises.ts describeAppointment），去掉原因、联系人、片段号这些字段；
//   · 不读 ADR 0200 的私人空间：PRIVATE.dat、拒绝过的、她猜的事、自我认识（INSIGHTS）、说话习惯笔记、追求的原文，这个模块一个都不打开；
//   · 只读：TS 那边有些读法遇到坏文件会把它挪到 .corrupt-*（json-file.ts 的 quarantine），面板不能替线上进程做这个决定——
//     会隔离的读法之前先自己解析一遍，解析不了就当「读不了」（null），原文件不动；
//   · 返回的只有白名单字段，不带路径、库名、原始错误。
//
// API（工厂 createHerState，见下方 JSDoc）：
//   memoryHealth()  → {
//     linked: boolean,                     // owner-bank.json 登记过（他的 bank + 公共库，QQ 启动时写的）
//     registeredAt: string | null,         // 登记写入的时刻（ISO）
//     hindsight: { reachable: boolean | null },   // null = 地址不是本机 http、没去连
//     common: { facts, documents } | null, // 公共库条数（stats 的 total_nodes / total_documents）
//     own: { facts, documents } | null,    // 他本人的 bank 条数
//     episodes: { pending, requeued, lastWrittenAt } | null,  // 他的进度文件：异步派发还没确认的片段数、对账重排过的次数、最近一次提交片段的时刻
//     audit: { entries, lastAt, verified } | null,           // 记忆账本（identity/memory.jsonl，memoryAudit 开着才有）
//     reconcile: { recorded: false },      // 对账时刻只在 QQ 进程内存里（long-term.ts #reconciled），不落盘，面板给不出；重排次数在 episodes.requeued
//   }
//   emotionHealth() → {
//     feelingsExport: Freshness | null,    // FEELINGS.json 的导出时刻；stale = 超过 FEELINGS_STALE_MS（3 小时）
//     ledger: { rows, lastAt },            // 感觉账总条数与最近一条的时刻（不分种类）
//     review: { runsToday, lastAt } | null // 心境回想：今天试了几次（feeling-review.json 的 attempts）、上一次想成的时刻
//   }
//   lifeHealth()    → {
//     world: { events, latestDay } | null, // 世界账条数、最近一条落在她的哪一天
//     timeline: { entries, lastAt } | null,// 跨渠道时间线（timeline.jsonl，timeline 开着才有）
//     diary: { lastDay } | null,           // 日记最近写到哪天（JOURNAL.md、自动日记 memory/diary.json、她自己写的）
//     selfExport: Freshness | null,        // SELF.json；stale = 过了它自己写的 validUntil
//     nowExport: Freshness | null,         // NOW.md；stale = 超过 NOW_STALE_MS（30 分钟）
//   }
//   herDay({ date? }) → { date, today, events: [{ time, kind, summary }], days: [{ date, count }] } | null
//     date 缺省是她的今天（她的一天从 02:00 开始，schedule.ts herDay）；格式不对回 null。
//     事件按世界账自己记的 day 分组（写的时候按她的作息算好的），time 是开始的钟点（插件配置 timeZone，默认 Asia/Shanghai）；
//     days 是最近 14 个有事的日子和条数，给面板翻页。
//   Freshness = { at: ISO, ageMinutes: number, stale: boolean }
//
// 读不到配置里的 qqbot 插件块（也没注入 dataDir）时，四个方法都回 null。
//
// 面板里用的是 createOffThreadHerState（同样的方法名）：几本账可能有几十 MB，整份同步读会卡住 DSH 主线程，
// 所以放到子进程（panel-jobs.js）里跑 createHerState；同时打开标签页的 5 个请求共用一次子进程，5 秒内的重复请求给缓存。

import { lstatSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { activeKoishiPlugin, configuredManualOwner } from './chat.js'
import { HER_DAY_START_HOUR, herDayOf, validTimeZone, zoned } from './panel-time.js'
import { runPanelJob, sharedJob } from './panel-jobs.js'

export { HER_DAY_START_HOUR, herDayOf }

const LOOPBACK = ['127.0.0.1', 'localhost', '[::1]']
const COMMON_BANK = /^([a-zA-Z0-9_-]{1,80})-common$/
const DAY = /^\d{4}-\d{2}-\d{2}$/
/** 一天最多给多少件；days 往回列多少个有事的日子 */
const DAY_EVENTS_MAX = 80
const DAYS_LISTED = 14
const SUMMARY_MAX = 60
/** 文件大小上限：超了当读不了，不把大文件读进面板进程 */
const SMALL = 2_000_000
const LARGE = 32_000_000

/** 世界账里不给面板的种类（life/development.ts PRIVATE_EVENT 同一条）：钱、冲突、危机、医疗、私事 */
const PRIVATE_EVENT = /crisis|medical|money|receive_money|conflict|private/i
/** 状态行认得的类型化行动（life/actions.ts TypedActionKind）：说法交给 typedOccupation */
const TYPED = new Set(['sleep', 'eat', 'meet', 'attend_class', 'study', 'rest', 'read_book', 'leisure', 'work_on_project', 'interact_npc'])
/** 世界动作（world.ts WorldActionKind，去掉 receive_money）：recapDay 的说法，不带猫名、快递名、课名 */
const WORLD_ACTION = {
  feed_cat: event => event.seen === false ? '下楼喂了猫，没见着它' : '下楼喂了猫',
  pick_parcel: () => '去驿站取了快递',
  finish_homework: () => '写完了作业',
  family_call: () => '和家里视频了',
}
/** subject 存的是编号（course-5、lunch）时不当人话：只认带中文的（life/dream-jobs.ts 同一条） */
const HAN = /\p{Script=Han}/u

const clean = (value, max) => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max) : ''
const iso = ms => Number.isFinite(ms) ? new Date(ms).toISOString() : null

/** 普通文件（不是链接、不是目录）且不太大；不存在回 false */
function ordinary(path, size) {
  try {
    const info = lstatSync(path)
    return info.isFile() && !info.isSymbolicLink() && info.size <= size
  } catch { return false }
}

function exists(path) {
  try { lstatSync(path); return true } catch { return false }
}

/** 只读地解析一份 JSON：不存在 → undefined；读不了 / 坏了 → null（不挪、不改） */
function peekJson(path, size = SMALL) {
  let info
  try { info = lstatSync(path) } catch { return undefined }
  if (!info.isFile() || info.isSymbolicLink() || info.size > size) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}

function freshness(atMs, nowMs, stale) {
  if (!Number.isFinite(atMs)) return null
  return { at: new Date(atMs).toISOString(), ageMinutes: Math.max(0, Math.floor((nowMs - atMs) / 60_000)), stale }
}

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null

const finiteNumber = value => typeof value === 'number' && Number.isFinite(value) ? value : 0

/**
 * 给子进程用的最小配置（panel-jobs.js）：只留数据目录、时区和「他是谁」，联系人名单、模型、密钥都不往外带。
 * 没有 qqbot 插件块回 null。
 */
export function herStateConfig(config) {
  const plugin = activeKoishiPlugin(config)
  if (!plugin) return null
  const owner = configuredManualOwner(config)
  return { plugins: { qqbot: {
    ...(typeof plugin.dataDir === 'string' ? { dataDir: plugin.dataDir } : {}),
    ...(validTimeZone(plugin.timeZone) ? { timeZone: validTimeZone(plugin.timeZone) } : {}),
    contacts: owner ? [{ qq: Number(owner), tier: 'boyfriend' }] : [],
  } } }
}

/**
 * @param {object} options
 * @param {string} options.root 仓库根
 * @param {() => any} options.readConfig 读 Koishi 配置（找 qqbot 插件块：dataDir、timeZone、联系人）
 * @param {string} [options.dataDir] 直接给数据目录（测试用）；不给就按插件块的 dataDir（默认 runtime/bot）
 * @param {string} [options.soulDir] 灵魂目录；不给就 QQBOT_SOUL_DIR 或 ~/.dsh/linmengyao
 * @param {string} [options.hindsightUrl] 不给就 http://127.0.0.1:8899；只认本机 http、不带账号密码
 * @param {typeof fetch} [options.fetcher]
 * @param {() => Date} [options.now]
 * @param {number} [options.timeoutMs] 每个 Hindsight 请求的超时
 */
export function createHerState({ root, readConfig, dataDir, soulDir, hindsightUrl, fetcher = fetch, now = () => new Date(), timeoutMs = 3000 }) {
  const load = file => import(pathToFileURL(join(root, file)).href)
  const soul = () => resolve(soulDir || process.env.QQBOT_SOUL_DIR || join(homedir(), '.dsh', 'linmengyao'))

  /** 这一次调用要用的东西；没有插件块又没注入数据目录 → null */
  function context() {
    const config = readConfig()
    const plugin = activeKoishiPlugin(config)
    if (!plugin && !dataDir) return null
    const owner = plugin ? configuredManualOwner(config) : null
    // 日子按 bot 的时区算（ADR 0331），不按面板进程的：两边不一样时日界会差几个小时
    const timeZone = validTimeZone(plugin?.timeZone) ?? 'Asia/Shanghai'
    return { data: resolve(root, dataDir || plugin?.dataDir || 'runtime/bot'), soul: soul(), owner, timeZone, at: now() }
  }

  function base() {
    try {
      const url = new URL(hindsightUrl || 'http://127.0.0.1:8899')
      return url.protocol === 'http:' && LOOPBACK.includes(url.hostname) && !url.username && !url.password ? url : null
    } catch { return null }
  }

  const request = async (path, url) => fetcher(new URL(path, url), { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })

  /** 一个 bank 的条数；名字不是这次登记的那两个之一就根本不会走到这里 */
  async function stats(bank, url) {
    const response = await request(`/v1/default/banks/${encodeURIComponent(bank)}/stats`, url)
    if (!response.ok) throw Error('stats_unavailable')
    const result = await response.json()
    const facts = count(result?.total_nodes)
    const documents = count(result?.total_documents)
    if (result?.bank_id !== bank || facts === null || documents === null) throw Error('stats_unavailable')
    return { facts, documents }
  }

  /** 登记的两个 bank：公共库必须是 <前缀>-common，他的必须是同一前缀 + 16 位哈希（long-term.ts bankId） */
  function banks(published) {
    const common = COMMON_BANK.exec(published?.commonBank ?? '')
    if (!common) return null
    const own = typeof published.ownerBank === 'string' && new RegExp(`^${common[1]}-[0-9a-f]{16}$`).test(published.ownerBank)
      ? published.ownerBank : null
    return { common: published.commonBank, own }
  }

  async function episodes(memoryDir, owner, ownBank) {
    if (!owner || !ownBank) return null
    // 男朋友档的进度文件（long-term.ts #key：<QQ>-<档位>.json）；读法是 'throw'，坏了不会被挪走
    const path = join(memoryDir, `${owner}-boyfriend.json`)
    if (!ordinary(path, LARGE)) return null
    try {
      const { readContactMemoryState } = await load('packages/bot/src/memory/long-term.ts')
      const state = readContactMemoryState(path)
      if (!state || state.bankId !== ownBank) return null
      const pending = Object.keys(state.pendingOwn ?? {}).length + Object.keys(state.pendingCommon ?? {}).length
      const requeued = Object.values(state.requeued ?? {}).reduce((sum, n) => sum + n, 0)
      const times = [...Object.values(state.retainedAt ?? {}), ...Object.values(state.commonAt ?? {})].filter(Number.isFinite)
      return { pending, requeued, lastWrittenAt: times.length ? iso(Math.max(...times)) : null }
    } catch { return null }
  }

  async function audit(data) {
    const path = join(data, 'identity', 'memory.jsonl')
    if (!ordinary(path, LARGE)) return null
    try {
      const { Ledger } = await load('packages/bot/src/memory/ledger.ts')
      const ledger = new Ledger(path)
      const entries = ledger.read()
      const last = entries.findLast(entry => entry.kind !== 'unreadable')
      return { entries: entries.length, lastAt: last ? iso(Date.parse(last.at)) : null, verified: ledger.verify().ok }
    } catch { return null }
  }

  return {
    async memoryHealth() {
      const ctx = context()
      if (!ctx) return null
      const memoryDir = join(ctx.data, 'memory')
      let published
      // owner-bank.json：bot 的 readOwnerBank 遇到坏文件会隔离它（改名），面板不替线上做这个决定——只自己解析一次，
      // 照 readOwnerBank 的规矩认字段；解析和取值之间不再读第二次，不留「先看是好的、再读时坏了被挪走」的空当
      const bank = ctx.owner ? peekJson(join(memoryDir, 'owner-bank.json')) : undefined
      if (bank && typeof bank === 'object' && typeof bank.ownerBank === 'string' && typeof bank.commonBank === 'string' && typeof bank.legacyBank === 'string') {
        published = { ownerBank: bank.ownerBank, commonBank: bank.commonBank, writtenAt: typeof bank.writtenAt === 'string' ? bank.writtenAt : undefined }
      }
      const named = published ? banks(published) : null
      const url = base()
      let reachable = null
      let common = null
      let own = null
      if (url) {
        const [health, commonStats, ownStats] = await Promise.allSettled([
          request('/health', url).then(response => response.ok),
          named ? stats(named.common, url) : Promise.reject(Error('unlinked')),
          named?.own ? stats(named.own, url) : Promise.reject(Error('unlinked')),
        ])
        common = commonStats.status === 'fulfilled' ? commonStats.value : null
        own = ownStats.status === 'fulfilled' ? ownStats.value : null
        reachable = (health.status === 'fulfilled' && health.value) || Boolean(common || own)
      }
      return {
        linked: Boolean(named),
        registeredAt: named && published.writtenAt ? iso(Date.parse(published.writtenAt)) : null,
        hindsight: { reachable },
        common,
        own,
        episodes: named ? await episodes(memoryDir, ctx.owner, named.own) : null,
        audit: await audit(ctx.data),
        reconcile: { recorded: false },
      }
    },

    async emotionHealth() {
      const ctx = context()
      if (!ctx) return null
      const nowMs = ctx.at.getTime()
      const [{ readSavedFeelings, FEELINGS_STALE_MS, feelingsExportPath }, { readLedger, ledgerPath }] = await Promise.all([
        load('packages/bot/src/emotion/feeling-export.ts'), load('packages/bot/src/emotion/feeling-ledger.ts'),
      ])
      let feelingsExport = null
      // readSavedFeelings 默认读坏文件会隔离：先确认它是能解析的普通小文件，再用 'throw' 读法（坏了只抛、不挪）。只取时刻，感受本身一条不出去
      if (peekJson(feelingsExportPath(ctx.soul))) {
        try {
          const saved = readSavedFeelings(ctx.soul, { invalid: 'throw' })
          if (saved) feelingsExport = freshness(saved.at, nowMs, nowMs - saved.at > FEELINGS_STALE_MS)
        } catch { feelingsExport = null }
      }
      // 没有账本 = 还没记过（0 条）；有但读不了（不是普通文件、太大）= null
      let ledger = exists(ledgerPath(ctx.soul)) ? null : { rows: 0, lastAt: null }
      if (ordinary(ledgerPath(ctx.soul), LARGE)) {
        try {
          const rows = readLedger(ctx.soul, nowMs)
          const latest = rows.reduce((max, row) => Math.max(max, row.at), -Infinity)
          ledger = { rows: rows.length, lastAt: rows.length ? iso(latest) : null }
        } catch { ledger = null }
      }
      let review = null
      const { reviewPath } = await load('packages/bot/src/emotion/feeling-review.ts')
      // loadReviewState 读坏文件会隔离：这里只自己解析一次，取 attempts 和 lastReflectionAt 两样（同 loadReviewState 的认法）。
      // attempts.day 是 bot 按它的时区（配置的 timeZone）写的日历日，所以「今天」也按那个时区算，不按面板进程的
      const raw = peekJson(reviewPath(ctx.data))
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
        const attempts = raw.attempts && typeof raw.attempts === 'object' && typeof raw.attempts.day === 'string' ? raw.attempts : { day: '', n: 0 }
        const last = finiteNumber(raw.lastReflectionAt)
        review = {
          runsToday: attempts.day === zoned(ctx.at, ctx.timeZone).day ? count(attempts.n) ?? 0 : 0,
          lastAt: last > 0 ? iso(last) : null,
        }
      }
      return { feelingsExport, ledger, review }
    },

    async lifeHealth() {
      const ctx = context()
      if (!ctx) return null
      const nowMs = ctx.at.getTime()
      const world = await worldEvents(ctx.data)
      const latestDay = world?.reduce((max, event) => event.day > max ? event.day : max, '') || null

      let timeline = null
      const timelinePath = join(ctx.data, 'timeline.jsonl')
      if (ordinary(timelinePath, LARGE)) {
        try {
          const { Timeline } = await load('packages/bot/src/memory/timeline.ts')
          const entries = new Timeline(timelinePath).read()
          const last = entries.reduce((max, entry) => Math.max(max, Date.parse(entry.at)), -Infinity)
          timeline = { entries: entries.length, lastAt: entries.length ? iso(last) : null }
        } catch { timeline = null }
      }

      const diary = await diaryLastDay(ctx)

      let selfExport = null
      const [{ isSelfExport, selfExportPath }, { nowGeneratedAt, NOW_STALE_MS }] = await Promise.all([
        load('packages/bot/src/life/self-export.ts'), load('packages/bot/src/life/now-export.ts'),
      ])
      const self = peekJson(selfExportPath(ctx.soul))
      if (self && isSelfExport(self)) selfExport = freshness(Date.parse(self.generatedAt), nowMs, nowMs >= Date.parse(self.validUntil))
      let nowExport = null
      const nowPath = join(ctx.soul, 'NOW.md')
      if (ordinary(nowPath, SMALL)) {
        try {
          const at = nowGeneratedAt(readFileSync(nowPath, 'utf8'))
          if (at !== undefined) nowExport = freshness(at, nowMs, nowMs - at > NOW_STALE_MS)
        } catch { nowExport = null }
      }
      // 一个生活（ADR 0347 第 3 层）：她在电脑上和他聊过的回合，QQ 收进了 desktop-log.jsonl——只给近 14 天的回合数和最近一次的时刻，不给原话
      let desktop = null
      if (ordinary(join(ctx.data, 'memory', 'desktop-log.jsonl'), LARGE)) {
        try {
          const { desktopTurns } = await load('packages/bot/src/memory/desktop-log.ts')
          const turns = desktopTurns(ctx.data, nowMs)
          const last = turns.reduce((max, turn) => Math.max(max, turn.at), -Infinity)
          desktop = { turns: turns.length, lastAt: turns.length ? iso(last) : null }
        } catch { desktop = null }
      }
      return { world: world ? { events: world.length, latestDay } : null, timeline, diary, selfExport, nowExport, desktop }
    },

    /**
     * QQ 那边还在不在转（platform/heartbeat.ts 的 heartbeat.json，只有时刻、进程号、提交号）和今天主动找了他几次
     * （proactive/<他的QQ>-boyfriend.json 的 records，只数 at 和 result，不读正文，也不给 QQ 号）。
     */
    async qqHealth() {
      const ctx = context()
      if (!ctx) return null
      const nowMs = ctx.at.getTime()
      let heartbeat = null
      const beat = peekJson(join(ctx.data, 'heartbeat.json'))
      if (beat && typeof beat.at === 'string' && Number.isFinite(Date.parse(beat.at))) {
        const { HEARTBEAT_STALE_MS } = await load('packages/bot/src/platform/heartbeat.ts')
        const at = Date.parse(beat.at)
        const time = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? iso(Date.parse(value)) : null
        heartbeat = {
          ...freshness(at, nowMs, nowMs - at > HEARTBEAT_STALE_MS),
          ref: typeof beat.ref === 'string' && /^[0-9a-f]{7,40}$|^unknown$/.test(beat.ref) ? beat.ref : null,
          startedAt: time(beat.startedAt), connectedAt: time(beat.connectedAt), lastMessageAt: time(beat.lastMessageAt),
        }
      }
      let proactive = null
      const file = ctx.owner ? peekJson(join(ctx.data, 'proactive', `${ctx.owner}-boyfriend.json`), LARGE) : null
      if (file && Array.isArray(file.records)) {
        const today = herDayOf(ctx.at, ctx.timeZone)
        let sentToday = 0, triedToday = 0, lastSentAt = -Infinity
        for (const record of file.records) {
          const at = typeof record?.at === 'string' ? Date.parse(record.at) : NaN
          if (!Number.isFinite(at) || at > nowMs) continue
          const sent = record.result === 'sent'
          if (sent) lastSentAt = Math.max(lastSentAt, at)
          if (herDayOf(new Date(at), ctx.timeZone) !== today) continue
          triedToday++
          if (sent) sentToday++
        }
        proactive = { sentToday, triedToday, lastSentAt: Number.isFinite(lastSentAt) ? iso(lastSentAt) : null }
      }
      return { heartbeat, proactive }
    },

    async herDay({ date } = {}) {
      const ctx = context()
      if (!ctx) return null
      const today = herDayOf(ctx.at, ctx.timeZone)
      const day = date ?? today
      if (typeof day !== 'string' || !DAY.test(day)) return null
      const events = await worldEvents(ctx.data)
      if (!events) return { date: day, today, events: [], days: [] }
      const { typedOccupation } = await load('packages/bot/src/life/actions.ts')
      const owner = ctx.owner ? Number(ctx.owner) : null
      const lived = events.filter(event => event.result !== 'failed' && event.day <= today && !PRIVATE_EVENT.test(event.kind))
      const items = lived.filter(event => event.day === day)
        .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt))
        .flatMap(event => {
          const summary = clean(summarize(event, owner, typedOccupation), SUMMARY_MAX)
          return summary ? [{ time: zoned(new Date(event.startedAt), ctx.timeZone).time, kind: event.kind, summary }] : []
        })
        .slice(0, DAY_EVENTS_MAX)
      const counts = new Map()
      for (const event of lived) if (summarize(event, owner, typedOccupation)) counts.set(event.day, (counts.get(event.day) ?? 0) + 1)
      const days = [...counts].sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0)).slice(0, DAYS_LISTED).map(([d, n]) => ({ date: d, count: n }))
      return { date: day, today, events: items, days }
    },
  }

  /** 世界账（生活事件）：读法是 'throw'，坏了不挪；读不了 → null */
  async function worldEvents(data) {
    const path = join(data, 'world', 'events.json')
    let info
    try { info = lstatSync(path) } catch { return [] }
    if (!info.isFile() || info.isSymbolicLink() || info.size > LARGE) return null
    try {
      const { readLifeEvents } = await load('packages/bot/src/world/life-events.ts')
      return readLifeEvents(path, () => undefined)
    } catch { return null }
  }

  /** 日记最近写到哪天：JOURNAL.md 的标题日期、自动日记的进度、她自己写的那几篇；只要日期 */
  async function diaryLastDay(ctx) {
    const days = []
    const [{ parseJournal, selfDiaryPath }, { readDiaryState }] = await Promise.all([
      load('packages/bot/src/life/diary-insights.ts'), load('packages/bot/src/life/diary.ts'),
    ])
    const journal = join(ctx.soul, 'JOURNAL.md')
    if (ordinary(journal, LARGE)) {
      try { days.push(...parseJournal(readFileSync(journal, 'utf8')).map(entry => entry.date)) } catch { /* 读不了就不算这一份 */ }
    }
    const auto = join(ctx.data, 'memory', 'diary.json')
    if (ordinary(auto, LARGE)) {
      try {
        const state = readDiaryState(auto)
        if (state) days.push(...Object.keys(state.written), ...Object.keys(state.texts))
      } catch { /* 坏了不挪（'throw' 读法），只是不算 */ }
    }
    // loadSelfDiary 读坏文件会隔离：只自己解析一次，同它的认法（有字的那几篇），日子按 bot 的时区算
    const self = peekJson(selfDiaryPath(ctx.data), LARGE)
    if (self && typeof self === 'object' && Array.isArray(self.entries)) {
      for (const item of self.entries) {
        if (!item || typeof item !== 'object' || typeof item.text !== 'string' || !item.text.trim()) continue
        const at = finiteNumber(item.at)
        if (at > 0) days.push(zoned(new Date(at), ctx.timeZone).day)
      }
    }
    const valid = days.filter(day => DAY.test(day))
    return valid.length ? { lastDay: valid.reduce((max, day) => day > max ? day : max) } : null
  }
}

/**
 * 一件事给他看的那一句；不给看的回 undefined。
 * 类型化行动用状态行的 typedOccupation（「在上课」「在吃午饭」）；编号式的 subject 不当人话；
 * 赴约只有约的是他本人才写约了什么，别人约的照 describeAppointment 只说「在外面，约了人」。
 */
function summarize(event, owner, typedOccupation) {
  if (PRIVATE_EVENT.test(event.kind)) return undefined
  if (Object.hasOwn(WORLD_ACTION, event.kind)) return WORLD_ACTION[event.kind](event)
  if (!TYPED.has(event.kind)) return undefined
  if (event.kind === 'meet' && !(owner && event.contact === owner)) return '在外面，约了人'
  // 上课、学习的 subject 可能是编号（course-5）：只认带中文的；休闲、项目、和人打交道的 subject 本来就是状态行那几个字
  const coded = event.kind === 'attend_class' || event.kind === 'study'
  const humanSubject = typeof event.subject === 'string' && (!coded || HAN.test(event.subject)) ? event.subject : undefined
  // 只带 typedOccupation 用得到的字段；时间窗换成「开始那一刻正在做」，失败 / 中断都不影响说法
  const start = Date.parse(event.startedAt)
  const probe = {
    kind: event.kind, result: 'succeeded', startedAt: event.startedAt, endedAt: new Date(start + 60_000).toISOString(),
    ...(event.kind === 'eat' || event.kind === 'read_book' ? { subject: event.subject } : humanSubject ? { subject: humanSubject } : {}),
    ...(event.meal === true ? { meal: true } : {}),
  }
  return typedOccupation(probe, new Date(start), []) || undefined
}

const SECTIONS = ['memory', 'emotion', 'life', 'qq', 'day']
const HER_TTL_MS = 5_000

/**
 * createHerState 的子进程版：方法名、返回值一样；没有 qqbot 插件块时直接回 null，不起子进程。
 * @param {object} options
 * @param {string} options.root
 * @param {() => any} options.readConfig
 * @param {string} [options.soulDir]
 * @param {string} [options.hindsightUrl]
 * @param {() => Date} [options.now]
 * @param {typeof runPanelJob} [options.run] 测试替身
 */
export function createOffThreadHerState({ root, readConfig, soulDir, hindsightUrl, now = () => new Date(), run = runPanelJob }) {
  const jobs = sharedJob({ ttl: HER_TTL_MS, now: () => now().getTime(), max: 8 })
  const soul = () => resolve(soulDir || process.env.QQBOT_SOUL_DIR || join(homedir(), '.dsh', 'linmengyao'))

  function settings() {
    let config = null
    try { config = herStateConfig(readConfig()) } catch { config = null }
    return config
  }

  /** 一次子进程算几块；某一块失败只让那一块 503 */
  async function sections(names, date) {
    const config = settings()
    if (!config) return null
    const timeZone = config.plugins.qqbot.timeZone ?? 'Asia/Shanghai'
    const at = now()
    const key = `${names.join(',')}|${date ?? ''}|${JSON.stringify(config)}|${soul()}`
    return jobs(key, () => run('her', { root, config, soulDir: soul(), hindsightUrl, now: at.getTime(), sections: names, ...(date === undefined ? {} : { date }) },
      { root, timeZone }))
  }

  const pick = async (name, promise) => {
    const all = await promise
    if (all === null) return null
    const item = all?.[name]
    if (!item || item.failed || !('value' in item)) throw Error('her_section_failed')
    return item.value
  }

  return {
    memoryHealth: () => pick('memory', sections(SECTIONS)),
    emotionHealth: () => pick('emotion', sections(SECTIONS)),
    lifeHealth: () => pick('life', sections(SECTIONS)),
    qqHealth: () => pick('qq', sections(SECTIONS)),
    async herDay({ date } = {}) {
      if (date === undefined) return pick('day', sections(SECTIONS))
      // 日期不对不起子进程（和 createHerState.herDay 一样回 null）
      if (typeof date !== 'string' || !DAY.test(date)) return null
      return pick('day', sections(['day'], date))
    },
  }
}
