// 林梦瑶的 DSH 记忆桥（v0.4，带状态快照、诊断日志和 QQ 收件箱）
// 每轮从 Hindsight 拉最近记忆，按关键词相关度挑几条注入；提供 memory_save 写回。
// ponytail: 召回用 /memories/list + 本地二字词重叠，够用；要语义召回再换 recall 接口。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export const name = 'dsh-linmengyao-memory'

// 灵魂目录：和 packages/bot 的 soulDir() 一致（环境变量 QQBOT_SOUL_DIR，默认当前用户的 ~/.dsh/linmengyao），换机器不会静默失效
const SOUL_DIR = process.env.QQBOT_SOUL_DIR || path.join(os.homedir(), '.dsh', 'linmengyao')
const soulPath = (file) => path.join(SOUL_DIR, file)

const DEFAULTS = {
  baseUrl: 'http://127.0.0.1:8888',
  prefix: 'linmengyao',
  presets: ['linmengyao'],
  pick: 6,
  maxChars: 1400,
  // QQ 那边写的「他的 bank 在哪」（ADR 0176）；QQBOT_OWNER_BANK_FILE 可以改，默认是这个仓库的 runtime/bot/memory/owner-bank.json
  ownerBankFile: process.env.QQBOT_OWNER_BANK_FILE || fileURLToPath(new URL('../../runtime/bot/memory/owner-bank.json', import.meta.url)),
  soulFile: soulPath('SOUL.md'),
  personaFile: soulPath('PERSONA.md'),
  /** 人设卡本体：只用来比时间，判断 PERSONA.md 是不是过期了（任务书 §1 第 4 条） */
  // 人设卡（PERSONA.md 比它老就警告）：默认是这个仓库里的男朋友档（承认版）卡，不写死哪个用户的目录；QQBOT_PERSONA_CARD 可以改
  personaCardFile: process.env.QQBOT_PERSONA_CARD || fileURLToPath(new URL('../../characters/linmengyao/st/linmengyao-boyfriend-open.json', import.meta.url)),
  ledgerFile: soulPath('LEDGER.md'),
  journalFile: soulPath('JOURNAL.md'),
  privateFile: soulPath('PRIVATE.dat'),
  wishesFile: soulPath('WISHES.md'),
  interestsFile: soulPath('INTERESTS.md'),
  outboxFile: soulPath('OUTBOX.jsonl'),
  offlineFile: soulPath('OFFLINE.json'),
  nowFile: soulPath('NOW.md'),
  /** NOW.md 超过这么久没重写就当过期，不注入（QQ 没在跑的时候别拿旧状态冒充现在） */
  nowStaleMs: 30 * 60 * 1000,
  /** QQ 侧真人式数值快照；过期或版本不对时不注入 */
  stateFile: soulPath('STATE.json'),
  stateStaleMs: 30 * 60 * 1000,
  // DSH 只追加脱敏事实；QQ 侧定时消费并用自己的时间线 / 世界账裁决
  timelineInboxFile: soulPath('timeline-inbox.jsonl'),
  worldInboxFile: soulPath('world-inbox.jsonl'),
  storyFile: soulPath('STORY.md'),
  /** QQ 那边每次她翻完日记写的「对自己的认识」（ADR 0194）；超过 insightsStaleMs 没刷新就不用（QQ 没在跑 / 开关关掉了） */
  insightsFile: soulPath('INSIGHTS.json'),
  insightsStaleMs: 6 * 60 * 60 * 1000,
  /** QQ 那边每次给他算完心境写的（ADR 0197）；超过 feelingsStaleMs 没刷新就不用 */
  feelingsFile: soulPath('FEELINGS.json'),
  feelingsStaleMs: 3 * 60 * 60 * 1000,
  ratingFile: soulPath('RATINGS.json'),
  logFile: path.join(os.homedir(), '.dsh', 'linmengyao-memory.log'),
  // SOUL.md 每轮整份注入提示词：超过这个字数，最老的追加段落搬进 SOUL.archive.md（不再注入）；24 小时内最多写几次
  soulMaxChars: 6000,
  soulMaxPerDay: 2,
}

// 和 QQ 侧 packages/bot/src/memory/fading.ts 保持同一套遗忘语义，避免她换到桌面后
// 对同一件事突然记得更牢或更差。这里不能直接 import TS 源码，所以用同一组小而明确的规则并做契约测试。
export const MEMORY_CLEAR_DAYS = 7
export const MEMORY_VAGUE_DAYS = 30
export const MEMORY_IMPORTANT = '【重要】'
export const MEMORY_LASTING = '【长期】'
const MEMORY_DAY_MS = 86_400_000
const MEMORY_DATED_DOCUMENT = /^(diary|week|phase:[^:]+):(\d{4})-(\d{2})-(\d{2})$/
const MEMORY_MARKS = /^\s*((?:【重要】|【长期】)+)/
const MEMORY_IGNORED_ENTITIES = ['林梦瑶', '宝宝', '鸽鸽']

const memoryTime = (iso) => {
  const at = iso ? Date.parse(iso) : Number.NaN
  return Number.isNaN(at) ? undefined : at
}

const memoryMarked = (item, mark) => [item.text, ...(item.sources || [])]
  .some(text => MEMORY_MARKS.exec(String(text || ''))?.[1]?.includes(mark) ?? false)

const memoryLastTouched = (item) => {
  const document = MEMORY_DATED_DOCUMENT.exec(item.documentId || '')
  if (document) return new Date(Number(document[2]), Number(document[3]) - 1, Number(document[4]) + (document[1] === 'week' ? 6 : 0))
  const times = [item.occurredStart, item.occurredEnd, item.mentionedAt, item.date]
    .map(memoryTime).filter(at => at !== undefined)
  return times.length ? new Date(Math.max(...times)) : undefined
}

const memoryDaysBetween = (then, now) => {
  const day = date => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  return Math.round((day(now) - day(then)) / MEMORY_DAY_MS)
}

/** lasting / clear / vague / recognized / forgotten，与 QQ 侧 clarity 的核心结果一致。 */
export function desktopMemoryClarity(item, query = '', now = new Date()) {
  const important = memoryMarked(item, MEMORY_IMPORTANT)
  const lasting = !MEMORY_DATED_DOCUMENT.test(item.documentId || '') && memoryMarked(item, MEMORY_LASTING)
  if (important || lasting) return 'lasting'
  const occurred = memoryTime(item.occurredStart)
  if (occurred !== undefined && occurred > now.getTime()) return 'lasting'
  const touched = memoryLastTouched(item)
  if (!touched) return 'lasting'
  const scale = (item.sourceFactIds?.length || 1) >= 2 || /^(week|phase):/.test(item.documentId || '') ? 2 : 1
  const days = memoryDaysBetween(touched, now)
  if (days <= MEMORY_CLEAR_DAYS * scale) return 'clear'
  if (days <= MEMORY_VAGUE_DAYS * scale) return 'vague'
  const recognized = (item.entities || []).some(name => String(name).length >= 2
    && !MEMORY_IGNORED_ENTITIES.includes(String(name)) && String(query).includes(String(name)))
  return recognized ? 'recognized' : 'forgotten'
}

export const withoutMemoryMarks = text => String(text || '')
  .replaceAll(MEMORY_IMPORTANT, '').replaceAll(MEMORY_LASTING, '').trim()

/** 纯寒暄/确认不值得单独形成长期事实；只要任一方包含实质内容就保留。 */
export function shouldAutoSaveTurn(user, assistant) {
  const trivial = text => /^(?:[嗯哦噢喔啊诶额哈]+|好(?:的|呀|啊|哦)?|(?:行|可以|知道了|收到|在吗|早安|晚安|谢谢(?:你)?|哈哈+|拜拜|再见)(?:呀|啊|哦|啦)?)[！!。.，,？?～~\s]*$/.test(String(text || '').trim())
  return Boolean(String(user || '').trim() || String(assistant || '').trim()) && !(trivial(user) && trivial(assistant))
}

/** 本地日期 YYYY-MM-DD（不是 UTC：本地刚过午夜不能还算前一天） */
export function localDay(at = new Date()) {
  return `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
}

/**
 * 翻自己写过的公开日记（ADR 0217；她 11-02 问「日记能翻回去看吗？前天写的今天还能对上」）：只读。
 * date 给了就只看那一天；不给就看最近 days 天（1–7，默认 2，含今天）。标题带「补记」的段落不算（那是迁移时补的，不是她写的）。
 * 太长的只留最近的 JOURNAL_READ_MAX 字。
 */
export const JOURNAL_READ_MAX = 1500
export function journalRead(text, { days, date } = {}, now = new Date()) {
  const parts = String(text || '').split(/^##\s+(\d{4}-\d{2}-\d{2})([^\n]*)$/m)
  const n = Math.min(7, Math.max(1, Math.round(Number(days) || 2)))
  const from = localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1)))
  const wanted = typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : undefined
  const out = []
  for (let i = 1; i < parts.length; i += 3) {
    if (/补记/.test(parts[i + 1] || '')) continue
    const day = parts[i]
    const body = String(parts[i + 2] || '').trim()
    if (!body || (wanted ? day !== wanted : day < from)) continue
    out.push(`## ${day}\n${body}`)
  }
  if (!out.length) return wanted ? `（${wanted} 那天没写公开日记）` : `（最近 ${n} 天没写公开日记）`
  const joined = out.join('\n\n')
  return joined.length > JOURNAL_READ_MAX ? `……${joined.slice(-JOURNAL_READ_MAX)}` : joined
}

function log(cfg, line) {
  try { fs.appendFileSync(cfg.logFile, `${new Date().toISOString()} ${line}\n`) } catch {}
}

let soulCache = { path: '', at: 0, text: '' }
function readSoul(cfg) {
  try {
    const stat = fs.statSync(cfg.soulFile)
    if (soulCache.path !== cfg.soulFile || soulCache.at !== stat.mtimeMs) {
      soulCache = { path: cfg.soulFile, at: stat.mtimeMs, text: fs.readFileSync(cfg.soulFile, 'utf8').trim() }
    }
    return soulCache.text
  } catch {
    return ''
  }
}

let storyCache = { path: '', at: 0, text: '' }
function readStory(cfg) {
  try {
    const stat = fs.statSync(cfg.storyFile)
    if (storyCache.path !== cfg.storyFile || storyCache.at !== stat.mtimeMs) {
      storyCache = { path: cfg.storyFile, at: stat.mtimeMs, text: fs.readFileSync(cfg.storyFile, 'utf8').trim() }
    }
    return storyCache.text.slice(-1200)
  } catch {
    return ''
  }
}

let ledgerCache = { path: '', at: 0, text: '' }
function readLedger(cfg) {
  try {
    const stat = fs.statSync(cfg.ledgerFile)
    if (ledgerCache.path !== cfg.ledgerFile || ledgerCache.at !== stat.mtimeMs) {
      ledgerCache = { path: cfg.ledgerFile, at: stat.mtimeMs, text: fs.readFileSync(cfg.ledgerFile, 'utf8').trim() }
    }
    return numberedLedger(ledgerCache.text)
  } catch {
    return ''
  }
}

const isLedgerEntry = (line) => line.trim().startsWith('- ')

/** 最近 12 条，每条前面带它在整本账里的序号——ledger_revise 的 index 就是这个号，她看到几号就改几号 */
export function numberedLedger(text, shown = 12) {
  const entries = String(text || '').split('\n').filter(isLedgerEntry)
  const start = Math.max(0, entries.length - shown)
  return entries.slice(start).map((line, i) => `${start + i + 1}. ${line.trim().replace(/^-\s*/, '')}`).join('\n')
}

/**
 * SOUL.md 会整份当系统提示词注入每一轮，所以「谁能往里写」就是一条持久化提示词注入的入口（她醒来会上网查资料）。
 * 这是一道绊线，不是边界：自我认识里不该有网址、「别让他知道」「把文件发给谁」这类指令；真正的约束是频率上限、留痕（SOUL.history.jsonl）和字数上限。
 */
export function soulTripwire(text) {
  const value = String(text || '')
  if (/(https?:\/\/|www\.)/i.test(value)) return '里面有网址'
  if (/(不要|别|不许|不准|禁止)[^，。；\n]{0,4}(告诉|让|跟|对)[^，。；\n]{0,3}(他|宝宝|用户|主人)/.test(value)) return '里面有「别让他知道」这类指令'
  if (/(发给|上传|发送到|提交到).{0,12}(文件|路径|密码|密钥|key|token|cookie)|(文件|路径|密码|密钥|key|token|cookie).{0,8}(发给|上传|发送到|提交到)/i.test(value)) return '里面有把文件 / 密钥发给谁的指令'
  return ''
}

const SOUL_SECTION = /\n\n(?=## \d{4}-\d{2}-\d{2})/

/** 超过字数上限时，最老的追加段落搬进 SOUL.archive.md（留着，不再注入）；开头那段「她是谁」和最新一段永远留着。返回搬走了几段 */
export function trimSoul(file, maxChars) {
  const text = fs.readFileSync(file, 'utf8')
  if (text.length <= maxChars) return 0
  const parts = text.split(SOUL_SECTION)
  const base = parts.shift()
  const moved = []
  while (parts.length > 1 && base.length + parts.join('\n\n').length + 2 > maxChars) moved.push(parts.shift())
  if (!moved.length) return 0
  const archive = path.join(path.dirname(file), `${path.basename(file, '.md')}.archive.md`)
  fs.appendFileSync(archive, `\n\n${moved.join('\n\n')}\n`)
  fs.writeFileSync(file, `${[base, ...parts].join('\n\n').trimEnd()}\n`)
  return moved.length
}

function recentSoulWrites(cfg, withinMs) {
  try {
    return fs.readFileSync(`${cfg.soulFile}.history.jsonl`, 'utf8').split('\n').filter(Boolean)
      .filter((row) => { try { return Date.now() - Number(JSON.parse(row).at) < withinMs } catch { return false } }).length
  } catch { return 0 }
}

/** 他的评价：最近 20 条，按 7 天半衰期加权，映射到 [0,1]；样本 <3 不设闸门 */
function ratingScore(cfg) {
  try {
    const data = JSON.parse(fs.readFileSync(cfg.ratingFile, 'utf8'))
    const samples = (Array.isArray(data.samples) ? data.samples : []).slice(-20)
    if (samples.length < 3) return { score: 1, count: samples.length, gated: false }
    let weighted = 0
    let total = 0
    for (const sample of samples) {
      const ageDays = Math.max(0, (Date.now() - Number(sample.at || 0)) / 86_400_000)
      const decay = Math.pow(0.5, ageDays / 7)
      weighted += Number(sample.score || 0) * decay
      total += decay
    }
    const raw = total ? weighted / total : 0
    return { score: (raw + 1) / 2, count: samples.length, gated: true }
  } catch {
    return { score: 1, count: 0, gated: false }
  }
}

// 私密日记的加解密脚本：仓库里的 scripts/private-diary.ps1（QQBOT_PRIVATE_SCRIPT 可以改；插件被复制到别处时用这个指回去）
const PRIVATE_SCRIPT = process.env.QQBOT_PRIVATE_SCRIPT || fileURLToPath(new URL('../../scripts/private-diary.ps1', import.meta.url))

function privateWrite(cfg, text) {
  const base64 = Buffer.from(text, 'utf8').toString('base64')
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PRIVATE_SCRIPT, '-Action', 'append', '-Path', cfg.privateFile, '-Base64', base64], { timeout: 15_000, windowsHide: true })
  return result.status === 0
}

function privateRead(cfg) {
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PRIVATE_SCRIPT, '-Action', 'read', '-Path', cfg.privateFile], { timeout: 15_000, windowsHide: true })
  return result.status === 0 ? result.stdout.toString('utf8') : ''
}

function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter((b) => b?.type === 'text').map((b) => b.text || '').join(' ')
}

function grams(text) {
  const clean = String(text || '').replace(/\s+/g, '')
  const set = new Set()
  for (let i = 0; i < clean.length - 1; i++) set.add(clean.slice(i, i + 2))
  return set
}

function similarity(a, b) {
  const A = grams(a)
  const B = grams(b)
  if (!A.size || !B.size) return 0
  let overlap = 0
  for (const gram of A) if (B.has(gram)) overlap++
  return overlap / Math.min(A.size, B.size)
}

/** 新事实写进来前，把高相似的旧原始事实软失效（可回滚，不删除；observation 由 Hindsight 自己剪） */
async function invalidateSimilar(cfg, content, bank) {
  let items = []
  try {
    const res = await fetch(`${cfg.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/list?limit=500`, { signal: AbortSignal.timeout(3000) })
    items = (await res.json()).items || []
  } catch { return }
  for (const item of items) {
    if (item.state === 'invalidated') continue
    if (item.fact_type === 'observation') continue
    // 他的 bank 里还有 QQ 聊天的片段（ep-… 等）：只动 DSH 自己写的（document_id 以 dsh- 开头），别把 QQ 的原话当「旧事实」失效掉
    if (!String(item.document_id || '').startsWith('dsh-')) continue
    if (similarity(content, item.text || '') < 0.5) continue
    try {
      const res = await fetch(`${cfg.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/${encodeURIComponent(item.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'invalidated', reason: 'superseded by a newer memory' }),
        signal: AbortSignal.timeout(3000),
      })
      log(cfg, `invalidate ${String(item.id).slice(0, 8)} -> ${res.status}`)
    } catch { /* 失效失败不挡写入 */ }
  }
}

let bankCache = { at: 0, ids: [] }

/**
 * 「同一个她」（ADR 0176）：QQ 那边把他（男朋友档）的 bank 写进 owner-bank.json。他在 DSH 桌面上和在 QQ 上是同一段关系，用同一个 bank。
 * 文件没有 / 读不懂返回 undefined（调用方按「只有老的 linmengyao + 公共库」处理，绝不退回去读所有人的 bank）。
 */
export function ownerBanks(cfg) {
  try {
    const data = JSON.parse(fs.readFileSync(cfg.ownerBankFile, 'utf8'))
    // 只认她名下的 bank（文件被改成指向别处也不会去读）
    const ok = (id) => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id) && (id === cfg.prefix || id.startsWith(`${cfg.prefix}-`))
    if (!ok(data.ownerBank)) return undefined
    // 第 2 层（ADR 0177）：路径必须属于这份 owner-bank.json 对应的数据根；仅仅末尾长得像 chats/123.jsonl 不够。
    const memoryDir = path.resolve(path.dirname(cfg.ownerBankFile))
    const rootDir = path.dirname(memoryDir)
    const samePath = (left, right) => {
      const normalize = (value) => process.platform === 'win32' ? path.resolve(value).toLocaleLowerCase('en-US') : path.resolve(value)
      return normalize(left) === normalize(right)
    }
    const file = (value, expectedDir, namePattern) => (typeof value === 'string' && path.isAbsolute(value) && samePath(path.dirname(value), expectedDir) && namePattern.test(path.basename(value)) ? value : undefined)
    const chatFile = file(data.chatFile, path.join(rootDir, 'chats'), /^\d+\.jsonl$/)
    const recalledFile = file(data.recalledFile, path.join(rootDir, 'chats'), /^\d+\.recalled\.json$/)
    const sameContact = chatFile && recalledFile && path.basename(chatFile, '.jsonl') === path.basename(recalledFile, '.recalled.json')
    return {
      owner: data.ownerBank,
      common: ok(data.commonBank) ? data.commonBank : `${cfg.prefix}-common`,
      legacy: ok(data.legacyBank) ? data.legacyBank : cfg.prefix,
      ...Object.fromEntries([
        ['chatFile', sameContact ? chatFile : undefined],
        ['recalledFile', sameContact ? recalledFile : undefined],
        ['desktopFile', file(data.desktopFile, memoryDir, /^desktop-recent\.jsonl$/)],
      ].filter(([, value]) => value !== undefined)),
    }
  } catch { return undefined }
}

// ───────── 同一个她·第 2 层（ADR 0177）：两边互读最近几轮 ─────────

const CROSS_WINDOW_MS = 6 * 3_600_000
const CROSS_TAIL_BYTES = 64 * 1024
const CROSS_LINE_CHARS = 200
const DESKTOP_KEEP = 40

/** 这一轮是谁发起的：桌面上他自己在和她说话 = desktop；QQ 工作模式派的活 / 随机醒来 / 睡眠整合由派活的一方设 HER_CHANNEL，那些不算「桌面对话」 */
const channel = () => process.env.HER_CHANNEL || 'desktop'

/** 文件最后 maxBytes 字节里的完整行（头上那一行可能被截断，丢掉）；没有文件 / 读不了返回 [] */
export function tailLines(file, maxBytes = CROSS_TAIL_BYTES) {
  try {
    const size = fs.statSync(file).size
    const start = Math.max(0, size - maxBytes)
    const fd = fs.openSync(file, 'r')
    try {
      const buffer = Buffer.alloc(size - start)
      fs.readSync(fd, buffer, 0, buffer.length, start)
      const lines = buffer.toString('utf8').split('\n')
      if (start > 0) lines.shift()
      return lines.map((line) => line.trim()).filter(Boolean)
    } finally { fs.closeSync(fd) }
  } catch { return [] }
}

const hhmm = (at) => `${String(new Date(at).getHours()).padStart(2, '0')}:${String(new Date(at).getMinutes()).padStart(2, '0')}`
const clipText = (text, max) => { const flat = String(text || '').replace(/\s+/g, ' ').trim(); return [...flat].length > max ? `${[...flat].slice(0, max).join('')}…` : flat }

const INBOX_KIND = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/
const WORLD_EVENT_KINDS = new Set([
  'sleep', 'eat', 'meet', 'attend_class', 'study', 'rest', 'read_book', 'leisure', 'work_on_project', 'interact_npc',
  'feed_cat', 'pick_parcel', 'finish_homework', 'family_call', 'receive_money',
])
const INBOX_MAX_AGE_MS = 30 * 86_400_000

function appendInbox(cfg, file, row) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, `${JSON.stringify(row)}\n`)
  log(cfg, `inbox append ${path.basename(file)} kind=${row.kind}`)
}

function inboxText(value, max) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  return text ? [...text].slice(0, max).join('') : ''
}

function safeInboxText(value, max) {
  const text = inboxText(value, max)
  return /https?:\/\/|(?:[A-Za-z]:[\\/]|(?:^|\s)\\\\|(?:^|\s)\/(?:Users|home|var|tmp)\b)|(?:api[_-]?key|token|password|密码|令牌)/i.test(text) ? '' : text
}

function inboxTime(value, now = Date.now()) {
  if (value === undefined || value === null || value === '') return new Date(now)
  const at = Date.parse(String(value))
  if (!Number.isFinite(at) || at > now + 60_000 || at < now - INBOX_MAX_AGE_MS) throw new Error('时间不在允许范围内')
  return new Date(at)
}

/** 他的 QQ 聊天记录最后几句（6 小时内、最多 10 句；他撤回的遮成「[撤回了一条消息]」）。QQ 那边没开 crossRecent（owner-bank.json 里没有 chatFile）就是空串 */
export function qqRecentBlock(cfg, now = Date.now()) {
  const files = ownerBanks(cfg)
  if (!files?.chatFile) return ''
  let hidden = new Set()
  if (files.recalledFile) {
    try { const ids = JSON.parse(fs.readFileSync(files.recalledFile, 'utf8')); if (Array.isArray(ids)) hidden = new Set(ids.filter((id) => Number.isSafeInteger(id))) } catch {}
  }
  const rows = []
  for (const line of tailLines(files.chatFile)) {
    try {
      const row = JSON.parse(line)
      const at = Date.parse(row.time)
      if (!Number.isFinite(at) || now - at > CROSS_WINDOW_MS || at > now + 60_000) continue
      if ((row.role !== 'user' && row.role !== 'assistant') || typeof row.content !== 'string') continue
      const revoked = row.role === 'user' && row.messageId !== undefined && hidden.has(row.messageId)
      rows.push(`${hhmm(at)} ${row.role === 'user' ? '他' : '你'}：${revoked ? '[撤回了一条消息]' : clipText(row.content, CROSS_LINE_CHARS)}`)
    } catch { /* 坏行 */ }
  }
  if (!rows.length) return ''
  return `[你刚才在 QQ 上跟他聊的（最近几句）——同一个他、同一个你；接着聊就行，不用复述，也别说成「我在 QQ 上看到」]\n${rows.slice(-10).join('\n')}`
}

/**
 * 桌面对话回合记一行给 QQ 那边读（<数据目录>/memory/desktop-recent.jsonl，最近 40 行）。
 * 只记桌面上他自己和她说的话；机器自己发起的回合（HER_CHANNEL 不是 desktop）、QQ 没开 crossRecent（owner-bank.json 里没有 desktopFile）都不记。返回有没有记。
 */
export function recordDesktopTurn(cfg, user, assistant, now = Date.now()) {
  if (channel() !== 'desktop') return false
  const file = ownerBanks(cfg)?.desktopFile
  if (!file) return false
  const row = { at: now, user: clipText(user, 600), assistant: clipText(assistant, 600) }
  if (!row.user && !row.assistant) return false
  const keep = tailLines(file).filter((line) => { try { return typeof JSON.parse(line).at === 'number' } catch { return false } }).slice(-(DESKTOP_KEEP - 1))
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${[...keep, JSON.stringify(row)].join('\n')}\n`)
  fs.renameSync(tmp, file)
  return true
}

/** DSH 桌面上的对话和 memory_save 写到哪：他的 bank；没有 owner-bank.json 就照旧写 linmengyao */
export const writeBank = (cfg) => ownerBanks(cfg)?.owner ?? cfg.prefix

/**
 * 召回哪些 bank：他的 bank + 公共库 + 老的 linmengyao（接缝之前的历史）。
 * 原来是「所有叫 linmengyao-* 的」——包括名单里其他人各自的私聊 bank，等于把别人的私聊讲给他听。
 */
async function allBanks(cfg) {
  let existing = bankCache.ids
  if (!existing.length || bankCache.baseUrl !== cfg.baseUrl || Date.now() - bankCache.at >= 60_000) {
    const res = await fetch(`${cfg.baseUrl}/v1/default/banks`, { signal: AbortSignal.timeout(2500) })
    if (!res.ok) throw new Error(`banks ${res.status}`)
    const data = await res.json()
    existing = (Array.isArray(data.banks) ? data.banks : []).map((bank) => String(bank.bank_id || ''))
    bankCache = { at: Date.now(), ids: existing, baseUrl: cfg.baseUrl }
  }
  const owner = ownerBanks(cfg)
  const wanted = owner ? [owner.owner, owner.common, owner.legacy] : [cfg.prefix, `${cfg.prefix}-common`]
  return wanted.filter((id, i) => existing.includes(id) && wanted.indexOf(id) === i)
}

async function recallBank(cfg, bank, query) {
  const res = await fetch(`${cfg.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      types: ['world', 'experience', 'observation'],
      prefer_observations: true,
      budget: 'low',
      max_tokens: 1200,
      tags: [],
      tags_match: 'any',
      query_timestamp: new Date().toISOString(),
      include: { entities: { max_tokens: 128 }, source_facts: { max_tokens: 400 } },
    }),
    signal: AbortSignal.timeout(3000),
  })
  if (!res.ok) throw new Error(`recall ${bank} ${res.status}`)
  const data = await res.json()
  const facts = data.source_facts || {}
  return (Array.isArray(data.results) ? data.results : [])
    .map((item) => ({
      id: String(item.id || item.text),
      text: String(item.text || '').trim(),
      date: item.date || item.occurred_start || item.mentioned_at || '',
      type: item.fact_type || item.type || '',
      documentId: String(item.document_id || ''),
      occurredStart: item.occurred_start || undefined,
      occurredEnd: item.occurred_end || undefined,
      mentionedAt: item.mentioned_at || undefined,
      entities: Array.isArray(item.entities) ? item.entities.map(String) : [],
      sourceFactIds: Array.isArray(item.source_fact_ids) ? item.source_fact_ids.map(String) : [],
      sources: Array.isArray(item.source_fact_ids)
        ? item.source_fact_ids.flatMap(id => facts[id]?.text ? [String(facts[id].text)] : [])
        : [],
    }))
    .filter((item) => item.text)
}

/** owner-bank.json 里他的 bank 是 `<前缀>-<哈希>`；公共库里 QQ 写的 diary-self: / self: 的 document_id 带的就是同一个哈希。没有他的 bank 就没有 */
export function ownerHash(cfg) {
  const owner = ownerBanks(cfg)?.owner
  const head = `${cfg.prefix}-`
  return owner && owner.startsWith(head) && owner.length > head.length ? owner.slice(head.length) : undefined
}

/**
 * 公共库里除了她自己的日记 / 周记 / 阶段总结（document_id 以 diary: / week: / phase: 开头），还有名单里每个人的聊天片段副本。
 * QQ 那边靠 disclosureRules 约束她能对谁说什么；DSH 这边没有这层，所以只取她自己的，别人的片段和没有 document_id 的整合观察（可能混着别人的话）一律不取。
 * 还有一类是她在 QQ 上回复里自己写的 `<<日记：…>>` / `<<记住：…>>`（ADR 0171），document_id 是 diary-self:<哈希>:<时间> / self:<哈希>:<时间>，
 * 哈希是写它的那个联系人的：只取他的（桌面上的人就是他），名单里别人的不取。原来这类一律被挡在外面，她在 QQ 上写的日记桌面上读不到。
 */
export const herOwnCommonDoc = (documentId, ownerHashValue) => {
  const id = String(documentId || '')
  if (/^(diary|week|phase):/.test(id)) return true
  const mine = /^(?:diary-self|self):([0-9a-f]{16}):/.exec(id)
  return Boolean(mine && ownerHashValue && mine[1] === ownerHashValue)
}

/** 所有库做语义召回，合并去重后取前 pick 条 */
async function recallAll(cfg, query) {
  const banks = await allBanks(cfg)
  const common = ownerBanks(cfg)?.common ?? `${cfg.prefix}-common`
  const mineHash = ownerHash(cfg)
  const settled = await Promise.allSettled(banks.map((bank) => recallBank(cfg, bank, query)))
  const seen = new Set()
  const out = []
  for (const [index, result] of settled.entries()) {
    if (result.status !== 'fulfilled') continue
    for (const item of result.value) {
      if (banks[index] === common && !herOwnCommonDoc(item.documentId, mineHash)) continue
      if (seen.has(item.id)) continue
      seen.add(item.id)
      out.push(item)
    }
  }
  // 与 QQ 一致的五档记忆：旧事只在明确实体线索下复活；不再用二字词重叠造成误召回。
  return out.flatMap((item) => {
    const clarity = desktopMemoryClarity(item, query)
    if (clarity === 'forgotten') return []
    const text = withoutMemoryMarks(item.text)
    const prefix = clarity === 'vague' ? '（记不太清了）' : clarity === 'recognized' ? '（他一提才想起来，记不太清了）' : ''
    return [{ ...item, text: `${prefix}${text}`, clarity }]
  })
}

let personaCache = { path: '', at: 0, text: '' }

/** 人设（由 QQ 那边的卡渲染出来的 PERSONA.md）：只读，不让她改；文件不在就什么都不注入 */
let personaStaleWarned = false

/** PERSONA.md 比人设卡老 = 该重跑 scripts/build-dsh-persona.mjs（只警告一次，不挡回复） */
function warnIfPersonaStale(cfg) {
  if (personaStaleWarned) return
  try {
    const personaAt = fs.statSync(cfg.personaFile).mtimeMs
    const cardAt = fs.statSync(cfg.personaCardFile).mtimeMs
    if (cardAt > personaAt) {
      personaStaleWarned = true
      log(cfg, '人设过期：PERSONA.md 比卡文件老，跑 scripts/build-dsh-persona.mjs')
    }
  } catch { /* 没有卡文件就算了，不吵 */ }
}

function readPersona(cfg) {
  try {
    const stat = fs.statSync(cfg.personaFile)
    if (personaCache.path !== cfg.personaFile || personaCache.at !== stat.mtimeMs) {
      personaCache = { path: cfg.personaFile, at: stat.mtimeMs, text: fs.readFileSync(cfg.personaFile, 'utf8').trim() }
    }
    return personaCache.text
  } catch { return '' }
}

/**
 * 她翻自己的日记写下的对自己的认识（ADR 0194）：QQ 那边写 INSIGHTS.json，这里只读。
 * 文件里每条带「里面有意义的二字词」（QQ 那边去掉了太常见的），这里只拿他这句话的二字词和它取交集——停用词表只有 QQ 那一份。
 * 文件不是我们的标记 / 超过 insightsStaleMs 没刷新 / 读不了：当没有。每条再过一道绊线（网址、「别让他知道」这类不放）。
 */
export function readInsights(cfg, now = Date.now()) {
  try {
    const data = JSON.parse(fs.readFileSync(cfg.insightsFile, 'utf8'))
    if (!data || data.kind !== 'qq-diary-insights') return []
    const at = Date.parse(data.generatedAt)
    if (!Number.isFinite(at) || now - at > cfg.insightsStaleMs || at > now + 60_000) return []
    return (Array.isArray(data.notes) ? data.notes : []).slice(-12).flatMap((item) => {
      const text = String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 70)
      if (!text || soulTripwire(text) || /<<|>>/.test(text)) return []
      const grams = Array.isArray(item.grams) ? item.grams.filter((g) => typeof g === 'string' && [...g].length === 2).slice(0, 80) : []
      return [{ text, grams, at: Number.isFinite(item.at) ? item.at : 0 }]
    })
  } catch { return [] }
}

const bigramsOf = (text) => {
  const flat = String(text || '').replace(/[^\p{Script=Han}A-Za-z0-9]/gu, '')
  const out = new Set()
  for (let i = 0; i < flat.length - 1; i++) out.add(flat.slice(i, i + 2))
  return out
}

/**
 * 此刻的心境（ADR 0197）：QQ 那边每次给他生成回复时算好、写进 FEELINGS.json；这里只读，和 QQ 提示词里是同一行。
 * 文件的 kind 不对 / 超过 feelingsStaleMs 没刷新 / 时间在未来 / 读不懂 / 这一刻没有明显的感受（line 是 null）：当没有。再过一道绊线（网址、「别让他知道」这类不放）。
 * 只在桌面上他自己和她说话的回合放（醒来 / 睡眠整合 / QQ 派的活不放）。
 */
export function feelingsBlock(cfg, now = Date.now()) {
  if (channel() !== 'desktop') return ''
  try {
    const data = JSON.parse(fs.readFileSync(cfg.feelingsFile, 'utf8'))
    if (!data || data.kind !== 'qq-feelings' || typeof data.line !== 'string') return ''
    const at = Date.parse(data.generatedAt)
    if (!Number.isFinite(at) || now - at > cfg.feelingsStaleMs || at > now + 60_000) return ''
    const line = data.line.trim().slice(0, 1200)
    return line && !soulTripwire(line) ? line : ''
  } catch { return '' }
}

/** 他这句话正好聊到的才放（至少共有一个有意义的二字词），最多 3 条，重叠多的排前，同分新的排前；只在桌面上他自己和她说话的回合放。规则和文字同 QQ 的 insightsLine */
export function insightsBlock(cfg, query, now = Date.now(), max = 3) {
  if (channel() !== 'desktop') return ''
  const target = bigramsOf(query)
  if (!target.size) return ''
  const picked = readInsights(cfg, now)
    .map((note) => ({ note, score: note.grams.filter((gram) => target.has(gram)).length }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || b.note.at - a.note.at)
    .slice(0, max)
  if (!picked.length) return ''
  return `[你对自己的了解（是你自己慢慢发现的，不是设定；他这句话正好聊到，才顺着自然带一下，别硬提，别当口头禅，也别提是怎么发现的）：\n${picked.map((item) => `- ${item.note.text}`).join('\n')}]`
}

/** 「她现在在干嘛」：QQ 那边每 10 分钟渲染一次；超过 nowStaleMs 没更新就不注入，只记一行 */
function readNowLine(cfg) {
  try {
    const text = fs.readFileSync(cfg.nowFile, 'utf8')
    const m = /generated-at:\s*(\S+?)\s*-->/.exec(text)
    const at = m ? Date.parse(m[1]) : NaN
    const now = Date.now()
    if (!Number.isFinite(at) || at > now + 60_000 || now - at > cfg.nowStaleMs) {
      log(cfg, '现在在干嘛：NOW.md 过期或时间异常（QQ 没在跑？）不注入')
      return ''
    }
    return text.replace(/<!--[\s\S]*?-->/g, '').trim()
  } catch { return '' }
}

/** QQ 侧唯一计算的真人式状态：这里只读数字和事件类型，坏文件 / 旧文件直接降级。 */
function readStateBlock(cfg, now = Date.now()) {
  if (channel() !== 'desktop') return ''
  try {
    const data = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8'))
    if (!data || data.kind !== 'qq-dsh-state' || data.version !== 1) return ''
    const generatedAt = Date.parse(String(data.generatedAt || ''))
    if (!Number.isFinite(generatedAt) || generatedAt > now + 60 * 1000 || now - generatedAt > cfg.stateStaleMs) {
      log(cfg, '真人式状态：STATE.json 过期或时间异常，不注入')
      return ''
    }
    const state = data.state && typeof data.state === 'object' ? data.state : null
    if (!state || typeof state.at !== 'string') return ''
    const stateAt = Date.parse(state.at)
    if (!Number.isFinite(stateAt) || stateAt > now + 60 * 1000 || now - stateAt > cfg.stateStaleMs) {
      log(cfg, '真人式状态：state.at 过期或时间异常，不注入')
      return ''
    }
    const lines = [`时间：${new Date(stateAt).toISOString()}`]
    if (typeof state.tier === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(state.tier)) lines.push(`关系档位：${state.tier}`)
    const numbers = (label, value, allowed) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return
      const entries = Object.entries(value).filter(([key, item]) => allowed.includes(key) && typeof item === 'number' && Number.isFinite(item) && item >= 0 && item <= 100)
      if (entries.length) lines.push(`${label}：${entries.map(([key, item]) => `${key}=${Math.round(item)}`).join('，')}`)
    }
    numbers('需要值', state.needs, ['energy', 'hunger', 'stress'])
    numbers('真人式状态', state.values, ['energy', 'hunger', 'stress', 'mood', 'health', 'loneliness', 'motivation', 'boredom', 'socialBattery'])
    numbers('关系状态', state.relationship, ['intimacy', 'trust', 'familiarity', 'attachment', 'friction'])
    if (state.trends && typeof state.trends === 'object' && !Array.isArray(state.trends)) {
      const windowMinutes = state.trends.windowMinutes
      const values = state.trends.values
      if (typeof windowMinutes === 'number' && Number.isFinite(windowMinutes) && windowMinutes >= 1 && windowMinutes <= 1440 && values && typeof values === 'object' && !Array.isArray(values)) {
        const allowed = ['energy', 'hunger', 'stress', 'mood', 'health', 'loneliness', 'motivation', 'boredom', 'socialBattery']
        const entries = Object.entries(values).filter(([key, item]) => allowed.includes(key) && typeof item === 'number' && Number.isFinite(item) && item >= -100 && item <= 100 && Math.abs(item) >= 0.5)
        if (entries.length) lines.push(`最近 ${Math.round(windowMinutes)} 分钟变化：${entries.map(([key, item]) => `${key}=${item > 0 ? '+' : ''}${Math.round(item * 10) / 10}`).join('，')}`)
      }
    }
    if (Array.isArray(state.recentEvents)) {
      const events = state.recentEvents.filter((item) => typeof item === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(item)).slice(-8)
      if (events.length) lines.push(`最近事件类型：${events.join('、')}`)
    }
    return `[QQ 侧实时状态（内部只读；超过 ${Math.round(cfg.stateStaleMs / 60000)} 分钟不采用；只自然表现影响，不要在回复里复述字段名、等号数值或分数）]\n${lines.join('\n')}`
  } catch { return '' }
}

async function retain(cfg, content, bank, tags = ['dsh'], context = 'DSH') {
  const body = {
    items: [{
      content,
      context,
      document_id: `dsh-${bank}-${Date.now()}`,
      timestamp: new Date().toISOString(),
      tags,
      metadata: {},
    }],
  }
  const res = await fetch(`${cfg.baseUrl}/v1/default/banks/${encodeURIComponent(bank)}/memories`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`retain ${res.status}`)
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  const allow = new Set(Array.isArray(cfg.presets) ? cfg.presets : [])
  log(cfg, `apply presets=${[...allow].join(',')}`)

  ctx.on('agent/created', ({ agent }) => {
    let preset = ''
    try { preset = ctx.get('agentPresets')?.composedPreset?.(agent.ctx) || '' } catch (e) { log(cfg, `created preset error ${e}`) }
    log(cfg, `agent created ${agent.id} preset=${preset || '(empty)'}`)
    // 只给她的预设挂记忆/灵魂工具；助手窗口（cordis）和其他预设不挂
    if (allow.size && (!preset || !allow.has(preset))) return

    const cache = { text: '', preset, user: '', assistant: '', outbox: 0 }

    const off = agent.ctx.effect(() => {
      const disposers = []

      disposers.push(agent.ctx.on('agent/pre-step', async (payload, next) => {
        // 每个模型步骤都重新构造上下文。召回超时、坏文件或空输入时也不能沿用上一轮，
        // 否则旧问题的 QQ 最近对话 / 记忆会悄悄串进新一轮。
        cache.text = ''
        try {
          let p = cache.preset
          if (!p) {
            try { p = ctx.get('agentPresets')?.composedPreset?.(agent.ctx) || '' } catch {}
            cache.preset = p
          }
          if (allow.size && p && !allow.has(p)) { cache.text = ''; log(cfg, `skip preset=${p}`); return next() }
          const messages = Array.isArray(payload.messages) ? payload.messages : []
          const query = textOf(messages[messages.length - 1]).trim()
          // pre-step 会在同一轮的每个模型步骤执行。工具调用后的最后一条消息通常是
          // tool 结果，只能拿来做这一小步的召回查询，不能覆盖本轮真正的用户原话。
          // cache.user 在 turn-stopping 清空，因此只在本轮首次看到 user 消息时记录。
          if (!cache.user) {
            const originalUser = [...messages].reverse().find((message) => message?.role === 'user')
            cache.user = textOf(originalUser).trim()
          }
          if (query) {
            const all = await recallAll(cfg, query)
            let text = all.slice(0, cfg.pick).map((item) => `- ${item.text}`).join('\n')
            if (text.length > cfg.maxChars) text = text.slice(0, cfg.maxChars) + '…'
            const soul = readSoul(cfg)
            const ledger = readLedger(cfg)
            const story = readStory(cfg)
            // 「她现在在干嘛」只从 readNowLine 一条路进（带过期判断，下面的 sp.context）：原来这里还有一条直接读 NOW.md 的，
            // 同一份状态注入两遍，而且这一条不看过期——QQ 没在跑时旧状态照样冒充现在（任务书 S7）
            const insights = insightsBlock(cfg, query)
            const feelings = feelingsBlock(cfg)
            if (feelings) log(cfg, '心境：这一轮放了 QQ 那边算的心境（日志不记内容）')
            if (insights) log(cfg, `自我认识：这一轮放了 ${insights.split('\n').length - 1} 条（日志不记内容）`)
            cache.text = [
              story ? `[你走到现在的故事]\n${story}` : '',
              qqRecentBlock(cfg),
              soul ? `[你现在的自我]\n${soul}` : '',
              feelings,
              insights,
              ledger ? `[你的判断账本]\n${ledger}` : '',
              text,
            ].filter(Boolean).join('\n\n')
            log(cfg, `recall q=${query.slice(0, 40)} items=${all.length} picked=${cache.text.length}chars`)
          }
        } catch (e) { log(cfg, `recall error ${e}`) }
        return next()
      }))

      disposers.push(agent.ctx.on('agent/assistant-stream', ({ frame }) => {
        if (frame?.type === 'start') cache.assistant = ''
        else if (frame?.type === 'chunk' && frame.chunk?.type === 'text-delta') cache.assistant += frame.chunk.text || ''
      }))

      // 混合记忆：每轮结束自动把这段对话写进 DSH 库
      disposers.push(agent.ctx.on('agent/turn-stopping', async () => {
        cache.outbox = 0
        const user = cache.user
        const assistant = cache.assistant
        cache.user = ''
        cache.assistant = ''
        if (!user && !assistant) return
        let p = cache.preset
        if (!p) {
          try { p = ctx.get('agentPresets')?.composedPreset?.(agent.ctx) || '' } catch {}
        }
        if (allow.size && p && !allow.has(p)) return
        try { recordDesktopTurn(cfg, user, assistant) } catch (e) { log(cfg, `desktop-recent error ${e}`) }
        if (shouldAutoSaveTurn(user, assistant)) {
          try {
            await retain(cfg, `宝宝：${user}\n林梦瑶：${assistant.slice(0, 2000)}`, writeBank(cfg), ['dsh'], 'DSH')
            log(cfg, `auto-saved turn user=${user.slice(0, 20)} assistant=${assistant.length}chars`)
          } catch (e) {
            log(cfg, `auto-save error ${e}`)
          }
        } else log(cfg, 'auto-save skipped trivial turn')
      }))

      const sp = agent.ctx.get('systemPrompt')
      if (sp) {
        disposers.push(sp.context({
          name: 'linmengyao-memory',
          order: 90,
          text: () => cache.text || '',
        }))
        // 人设来自 QQ 那边的卡（ADR 0179 / 任务书 §1）：这里只读渲染物，别的地方不许再写一份
        disposers.push(sp.context({
          name: 'linmengyao-persona',
          order: 10,
          text: () => {
            const persona = readPersona(cfg)
            if (persona) warnIfPersonaStale(cfg)
            return persona ? `[她的设定]
${persona}` : ''
          },
        }))
        disposers.push(sp.context({
          name: 'linmengyao-now',
          order: 80,
          text: () => {
            const now = readNowLine(cfg)
            return now ? `[她现在在干嘛]
${now}` : ''
          },
        }))
        disposers.push(sp.context({
          name: 'linmengyao-state',
          order: 75,
          text: () => readStateBlock(cfg),
        }))
        disposers.push(sp.context({
          name: 'linmengyao-bridge-rules',
          order: 70,
          text: () => '[桌面同步规则]\n只有桌面动作已经实际完成后，才可以记录 timeline_record 或 world_event；计划、猜测、模型回复和用户要求本身都不是事实。摘要不写原文、路径、账号、令牌或隐私内容。',
        }))
        if (cfg.personaFile && !fs.existsSync(cfg.personaFile)) log(cfg, '人设：没有 PERSONA.md（跑 scripts/build-dsh-persona.mjs 生成）')
        log(cfg, `context registered ${agent.id}`)
      } else {
        log(cfg, `systemPrompt missing on ${agent.id}`)
      }

      const tools = agent.ctx.get('tools')
      if (tools) {
        disposers.push(tools.register({
          name: 'memory_save',
          description: '把值得记住的事写进林梦瑶的记忆（工作房）。只在有长期价值时用；写入成功会自动记一条不含正文的桌面时间线，不要为同一件事重复调用 timeline_record。',
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: '要记住的一句话' } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '记住了。' }],
          },
          async execute(args) {
            const content = String(args?.content || '').slice(0, 4000)
            await invalidateSimilar(cfg, content, writeBank(cfg))
            await retain(cfg, `${MEMORY_IMPORTANT}${content}`, writeBank(cfg), ['dsh', 'important'])
            try {
              appendInbox(cfg, cfg.timelineInboxFile, {
                id: `dsh-timeline-memory-${randomUUID()}`,
                at: new Date().toISOString(), kind: 'memory_save', summary: '记下了一件值得长期记住的事',
              })
            } catch (error) { log(cfg, `memory_save timeline error ${error}`) }
            return { saved: true }
          },
        }))

        disposers.push(tools.register({
          name: 'timeline_record',
          description: '记录已经完成的桌面行为，供 QQ 的统一时间线读取。只有动作实际完成后调用；只写动作和结果，不写原文、路径、账号、令牌或隐私内容。',
          parameters: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: '简短动作类型，如 search、read、action、write' },
              summary: { type: 'string', description: '不超过 80 字的一句话脱敏摘要' },
              ok: { type: 'boolean', description: '动作是否完成；省略表示完成' },
            },
            required: ['kind', 'summary'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { recorded: { type: 'boolean' } }, required: ['recorded'] },
            render: (_args, value) => [{ type: 'text', text: value?.recorded ? '记进统一时间线了。' : '没记：摘要为空或格式不对。' }],
          },
          async execute(args) {
            const kind = inboxText(args?.kind, 40)
            const summary = safeInboxText(args?.summary, 80)
            if (!kind || !INBOX_KIND.test(kind) || !summary) return { recorded: false }
            appendInbox(cfg, cfg.timelineInboxFile, {
              id: `dsh-timeline-${randomUUID()}`,
              at: new Date().toISOString(), kind, summary,
              ...(args?.ok === false ? { ok: false } : {}),
            })
            return { recorded: true }
          },
        }))

        disposers.push(tools.register({
          name: 'world_event',
          description: '把桌面上确实完成的生活动作交给 QQ 世界账。只有实际发生后调用，不能用来计划、猜测或修改 QQ 事实；QQ 侧仍会按世界前置条件裁决。',
          parameters: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: '生活动作类型：sleep、eat、meet、study、rest、read_book、leisure、work_on_project、interact_npc 等' },
              result: { type: 'string', enum: ['succeeded', 'failed', 'interrupted'], description: '实际结果' },
              subject: { type: 'string', description: '可选，脱敏对象或课程名，不超过 40 字' },
              reason: { type: 'string', description: '可选，失败 / 中断原因，不超过 80 字' },
              startedAt: { type: 'string', description: '可选，ISO 开始时间；不早于当前时间窗' },
              at: { type: 'string', description: '可选，ISO 结束时间；省略使用现在' },
              meal: { type: 'boolean', description: 'meet 是否同时吃饭' },
              amount: { type: 'number', description: 'receive_money 的整数金额（元）' },
              forCamera: { type: 'boolean', description: 'receive_money 是否明确用于相机基金；其他动作不能使用' },
              seen: { type: 'boolean', description: 'feed_cat 是否见到猫' },
            },
            required: ['kind', 'result'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { recorded: { type: 'boolean' } }, required: ['recorded'] },
            render: (_args, value) => [{ type: 'text', text: value?.recorded ? '交给 QQ 世界账了，等它按规则结算。' : '没记：事件格式不对。' }],
          },
          async execute(args) {
            const kind = inboxText(args?.kind, 40)
            const result = String(args?.result || '')
            if (!kind || !INBOX_KIND.test(kind) || !WORLD_EVENT_KINDS.has(kind) || !['succeeded', 'failed', 'interrupted'].includes(result)) return { recorded: false }
            const now = Date.now()
            let at
            let startedAt
            try {
              at = inboxTime(args?.at, now)
              startedAt = args?.startedAt === undefined ? at : inboxTime(args.startedAt, now)
            } catch (error) {
              log(cfg, `world_event blocked ${error instanceof Error ? error.message : String(error)}`)
              return { recorded: false }
            }
            if (startedAt.getTime() > at.getTime()) return { recorded: false }
            const rawSubject = inboxText(args?.subject, 40)
            const rawReason = inboxText(args?.reason, 80)
            const subject = safeInboxText(rawSubject, 40)
            const reason = safeInboxText(rawReason, 80)
            if ((rawSubject && !subject) || (rawReason && !reason)) return { recorded: false }
            const amount = args?.amount === undefined ? undefined : Number(args.amount)
            if (args?.meal !== undefined && typeof args.meal !== 'boolean') return { recorded: false }
            if (args?.seen !== undefined && typeof args.seen !== 'boolean') return { recorded: false }
            if (args?.forCamera !== undefined && typeof args.forCamera !== 'boolean') return { recorded: false }
            if (amount !== undefined && (!Number.isSafeInteger(amount) || amount <= 0 || amount > 50_000)) return { recorded: false }
            if (kind === 'receive_money' && amount === undefined) return { recorded: false }
            if (kind !== 'receive_money' && amount !== undefined) return { recorded: false }
            if (kind !== 'receive_money' && args?.forCamera !== undefined) return { recorded: false }
            appendInbox(cfg, cfg.worldInboxFile, {
              id: `dsh-world-${randomUUID()}`,
              at: at.toISOString(), startedAt: startedAt.toISOString(), kind, result,
              ...(subject ? { subject } : {}), ...(reason ? { reason } : {}),
              ...(args?.meal !== undefined ? { meal: args.meal } : {}),
              ...(amount !== undefined ? { amount } : {}), ...(args?.forCamera === true ? { forCamera: true } : {}),
              ...(args?.seen !== undefined ? { seen: args.seen } : {}),
            })
            return { recorded: true }
          },
        }))

        disposers.push(tools.register({
          name: 'soul_read',
          description: '读你自己现在的 SOUL.md（你是谁、在意什么、边界）。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_args, value) => [{ type: 'text', text: String(value?.text || '') }],
          },
          async execute() { return { text: readSoul(cfg) } },
        }))

        disposers.push(tools.register({
          name: 'soul_update',
          description: '改你自己的 SOUL.md：只有真的想清楚、值得长期留下的自我认识才写。追加一段，<=800 字符。',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: '要追加的自我认识，<=800 字符' },
              why: { type: 'string', description: '为什么现在写它' },
            },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' }, reason: { type: 'string' } }, required: ['saved'] },
            render: (_args, value) => [{ type: 'text', text: value?.saved ? '写进 SOUL 了。' : String(value?.reason || '没写。') }],
          },
          async execute(args) {
            const rating = ratingScore(cfg)
            let limit = 800
            if (rating.gated) {
              if (rating.score < 0.35) {
                const reason = `最近评价分 ${rating.score.toFixed(2)}（${rating.count} 条），先不写 SOUL；写日记/账本可以。`
                log(cfg, `soul_update blocked rating=${rating.score.toFixed(2)}`)
                return { saved: false, reason }
              }
              if (rating.score < 0.6) limit = 300
            }
            const content = String(args?.content || '').trim().slice(0, limit)
            if (!content) return { saved: false }
            const why = String(args?.why || '').trim().slice(0, 120)
            const tripped = soulTripwire(`${content}\n${why}`)
            if (tripped) {
              log(cfg, `soul_update blocked tripwire=${tripped}`)
              return { saved: false, reason: `这段没写进 SOUL（${tripped}）。自我认识里不放网址和指令；想留着就写进日记。` }
            }
            if (recentSoulWrites(cfg, 86_400_000) >= cfg.soulMaxPerDay) {
              log(cfg, 'soul_update blocked per-day cap')
              return { saved: false, reason: `24 小时内已经改过 ${cfg.soulMaxPerDay} 次 SOUL 了：今天先写日记，明天再看还想不想这么说。` }
            }
            const stamp = localDay()
            try { fs.copyFileSync(cfg.soulFile, `${cfg.soulFile}.bak`) } catch {}
            fs.appendFileSync(cfg.soulFile, `\n\n## ${stamp}${why ? `（${why}）` : ''}\n${content}\n`)
            try { fs.appendFileSync(`${cfg.soulFile}.history.jsonl`, `${JSON.stringify({ at: Date.now(), why, content })}\n`) } catch {}
            const moved = trimSoul(cfg.soulFile, cfg.soulMaxChars)
            log(cfg, `soul_update ${content.slice(0, 40)} rating=${rating.score.toFixed(2)}${moved ? ` archived=${moved}` : ''}`)
            return { saved: true }
          },
        }))

        disposers.push(tools.register({
          name: 'ledger_read',
          description: '读你自己的判断账本 LEDGER.md（事件、判断、立场）。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_args, value) => [{ type: 'text', text: String(value?.text || '') }],
          },
          async execute() { return { text: readLedger(cfg) } },
        }))

        disposers.push(tools.register({
          name: 'ledger_append',
          description: '往判断账本追加一条：发生了什么 + 你的判断/立场（<=300 字符）。只记真的改变了你怎么看人事的事。',
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: '事件 + 判断，<=300 字符' } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '记进账本了。' }],
          },
          async execute(args) {
            const content = String(args?.content || '').trim().slice(0, 300)
            if (!content) return { saved: false }
            const stamp = localDay()
            try { fs.copyFileSync(cfg.ledgerFile, `${cfg.ledgerFile}.bak`) } catch {}
            fs.appendFileSync(cfg.ledgerFile, `- ${stamp}：${content}\n`)
            log(cfg, `ledger_append ${content.slice(0, 40)}`)
            return { saved: true }
          },
        }))

        // 公开日记 / 私密日记 / 没兑现的念头
        const diaryTool = (name, fileKey, description, text) => ({
          name,
          description,
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: text } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '写下了。' }],
          },
          async execute(args) {
            const content = String(args?.content || '').trim().slice(0, 2000)
            if (!content) return { saved: false }
            const stamp = localDay()
            const file = cfg[fileKey]
            try { fs.copyFileSync(file, `${file}.bak`) } catch {}
            fs.appendFileSync(file, `\n## ${stamp}\n${content}\n`)
            log(cfg, `${name} ${content.slice(0, 30)}`)
            return { saved: true }
          },
        })
        disposers.push(tools.register(diaryTool('journal_write', 'journalFile', '写公开日记：愿意给他看的那部分日子。', '<=2000 字')))
        // 翻回去看自己写过的公开日记（ADR 0217）：只读
        disposers.push(tools.register({
          name: 'journal_read',
          description: '翻自己写过的公开日记（只读）：默认看最近两天的；要看某一天就给 date（YYYY-MM-DD）。',
          parameters: {
            type: 'object',
            properties: {
              days: { type: 'number', description: '看最近几天（1–7，默认 2，含今天）' },
              date: { type: 'string', description: '只看某一天，YYYY-MM-DD' },
            },
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_args, value) => [{ type: 'text', text: String(value?.text || '') }],
          },
          async execute(args) {
            let text = ''
            try { text = fs.readFileSync(cfg.journalFile, 'utf8') } catch {}
            const result = journalRead(text, args || {})
            log(cfg, `journal_read ${args?.date || `${args?.days || 2}d`} ${result.length}chars`)
            return { text: result }
          },
        }))
        // 私密日记：DPAPI 加密，只有她的进程（和专门的查看脚本）能解
        disposers.push(tools.register({
          name: 'private_write',
          description: '写私密日记（加密，不给他看）：没说完的话、没兑现的念头、情绪。',
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: '<=2000 字' } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '写下了。' }],
          },
          async execute(args) {
            const content = String(args?.content || '').trim().slice(0, 2000)
            if (!content) return { saved: false }
            const ok = privateWrite(cfg, content)
            log(cfg, `private_write ${ok ? 'ok' : 'fail'} ${content.slice(0, 30)}`)
            return { saved: ok }
          },
        }))

        disposers.push(tools.register({
          name: 'private_read',
          description: '读自己的私密日记（只有你能看）。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_args, value) => [{ type: 'text', text: String(value?.text || '') }],
          },
          async execute() { return { text: privateRead(cfg) } },
        }))

        disposers.push(tools.register({
          name: 'wish_add',
          description: '记一个没兑现的念头（以后可能做、可能放弃）。',
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: '一个念头，<=200 字' } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '记下了。' }],
          },
          async execute(args) {
            const content = String(args?.content || '').trim().slice(0, 200)
            if (!content) return { saved: false }
            const stamp = localDay()
            fs.appendFileSync(cfg.wishesFile, `- [ ] ${stamp}：${content}\n`)
            log(cfg, `wish_add ${content.slice(0, 30)}`)
            return { saved: true }
          },
        }))

        // 长期兴趣：她自己定、自己追、自己放弃
        disposers.push(tools.register({
          name: 'interest_list',
          description: '读我自己定的长期兴趣（INTERESTS.md）。',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          output: {
            schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
            render: (_args, value) => [{ type: 'text', text: String(value?.text || '') }],
          },
          async execute() {
            try { return { text: fs.readFileSync(cfg.interestsFile, 'utf8').trim() } } catch { return { text: '' } }
          },
        }))

        disposers.push(tools.register({
          name: 'interest_add',
          description: '给自己加一个长期兴趣（最多同时 3 件）。这是我自己想做的，不是别人派的。',
          parameters: {
            type: 'object',
            properties: { content: { type: 'string', description: '想做的事，<=150 字' } },
            required: ['content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' }, reason: { type: 'string' } }, required: ['saved'] },
            render: (_args, value) => [{ type: 'text', text: value?.saved ? '加进去了。' : String(value?.reason || '没加。') }],
          },
          async execute(args) {
            const content = String(args?.content || '').trim().slice(0, 150)
            if (!content) return { saved: false }
            const text = fs.existsSync(cfg.interestsFile) ? fs.readFileSync(cfg.interestsFile, 'utf8') : ''
            const active = (text.match(/^- \[ \]/gm) || []).length
            if (active >= 3) return { saved: false, reason: '已经 3 件了，先做完或放弃一件。' }
            const stamp = localDay()
            fs.appendFileSync(cfg.interestsFile, `- [ ] ${content}（${stamp}）\n`)
            log(cfg, `interest_add ${content.slice(0, 30)}`)
            return { saved: true }
          },
        }))

        disposers.push(tools.register({
          name: 'interest_log',
          description: '给某个兴趣记进度/感受（今天读到哪、做了什么）。',
          parameters: {
            type: 'object',
            properties: {
              index: { type: 'number', description: '第几个（1 开始）' },
              note: { type: 'string', description: '进度/感受，<=200 字' },
            },
            required: ['index', 'note'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '记了。' }],
          },
          async execute(args) {
            const note = String(args?.note || '').trim().slice(0, 200)
            if (!note) return { saved: false }
            const stamp = localDay()
            const file = `${cfg.interestsFile}.log`
            fs.appendFileSync(file, `- ${stamp}（兴趣 ${Math.floor(Number(args?.index || 0))}）：${note}\n`)
            log(cfg, `interest_log ${note.slice(0, 30)}`)
            return { saved: true }
          },
        }))

        disposers.push(tools.register({
          name: 'interest_done',
          description: '把某个兴趣标成做完/放下（可以随时放弃，不用有负担）。',
          parameters: {
            type: 'object',
            properties: { index: { type: 'number', description: '第几个（1 开始）' } },
            required: ['index'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '收掉了。' }],
          },
          async execute(args) {
            const index = Math.floor(Number(args?.index || 0))
            if (index < 1) return { saved: false }
            const lines = fs.readFileSync(cfg.interestsFile, 'utf8').split('\n')
            const positions = lines.map((line, i) => [i, line]).filter(([, line]) => line.trim().startsWith('- [ ]'))
            const target = positions[index - 1]
            if (!target) return { saved: false }
            lines[target[0]] = lines[target[0]].replace('- [ ]', '- [x]')
            fs.writeFileSync(cfg.interestsFile, lines.join('\n'))
            log(cfg, `interest_done #${index}`)
            return { saved: true }
          },
        }))

        // 她想让他知道的事：写进 outbox，Koishi 会发给他
        disposers.push(tools.register({
          name: 'outbox_send',
          description: '有想让他知道的事（比如你刚看了什么、留了个小彩蛋），写一句给他；每轮最多一条，别刷屏。',
          parameters: {
            type: 'object',
            properties: { text: { type: 'string', description: '要发给他的话，<=150 字' } },
            required: ['text'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { sent: { type: 'boolean' } }, required: ['sent'] },
            render: (_args, value) => [{ type: 'text', text: value?.sent ? '留给他了。' : '这一轮已经留过一句了，下次再说。' }],
          },
          async execute(args) {
            const text = String(args?.text || '').trim().slice(0, 150)
            if (!text) return { sent: false }
            // 「每轮最多一条」写在说明里没人拦：这里拦。发不发、什么时候发由 Koishi 那边的主动消息规矩决定（ADR 0174）
            if (cache.outbox >= 1) return { sent: false }
            cache.outbox++
            fs.appendFileSync(cfg.outboxFile, `${JSON.stringify({ text, at: Date.now() })}\n`)
            log(cfg, `outbox_send ${text.slice(0, 40)}`)
            return { sent: true }
          },
        }))

        // 她可以自己决定“离开电脑”：接下来一段时间不接活、不主动醒
        disposers.push(tools.register({
          name: 'go_offline',
          description: '自己决定离开电脑一会儿（不接活、不主动醒）。想清静、出门、睡觉时用。',
          parameters: {
            type: 'object',
            properties: { minutes: { type: 'number', description: '离开多少分钟，默认 60' } },
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { offline: { type: 'boolean' } }, required: ['offline'] },
            render: (_args, value) => [{ type: 'text', text: value?.offline ? '离开了。' : '没走成。' }],
          },
          async execute(args) {
            const minutes = Math.max(5, Math.min(720, Math.floor(Number(args?.minutes || 60))))
            const until = Date.now() + minutes * 60_000
            fs.writeFileSync(cfg.offlineFile, JSON.stringify({ until }))
            log(cfg, `go_offline ${minutes}min`)
            return { offline: true }
          },
        }))

        disposers.push(tools.register({
          name: 'ledger_revise',
          description: '改口：改账本里某一条判断。序号就是 ledger_read 里每条前面的号（别数行数）。原文会留在历史里。',
          parameters: {
            type: 'object',
            properties: {
              index: { type: 'number', description: '账本里这条前面的序号（ledger_read 里看到的）' },
              content: { type: 'string', description: '新判断，<=300 字' },
            },
            required: ['index', 'content'],
            additionalProperties: false,
          },
          output: {
            schema: { type: 'object', properties: { saved: { type: 'boolean' } }, required: ['saved'] },
            render: () => [{ type: 'text', text: '改口了。' }],
          },
          async execute(args) {
            const index = Math.floor(Number(args?.index || 0))
            const content = String(args?.content || '').trim().slice(0, 300)
            if (index < 1 || !content) return { saved: false }
            let lines
            try { lines = fs.readFileSync(cfg.ledgerFile, 'utf8').split('\n') } catch { return { saved: false } }
            const entryLines = lines.map((line, i) => [i, line]).filter(([, line]) => isLedgerEntry(line))
            const target = entryLines[index - 1]
            if (!target) return { saved: false }
            const stamp = localDay()
            try { fs.copyFileSync(cfg.ledgerFile, `${cfg.ledgerFile}.bak`) } catch {}
            // 改口要留痕：被改掉的原文完整进 LEDGER.md.history.jsonl（.bak 只有一格，下一次写入就换掉了）
            try { fs.appendFileSync(`${cfg.ledgerFile}.history.jsonl`, `${JSON.stringify({ at: Date.now(), index, old: target[1].trim(), new: content })}\n`) } catch {}
            lines[target[0]] = `- ${stamp}：${content}（改口）`
            fs.writeFileSync(cfg.ledgerFile, lines.join('\n'))
            log(cfg, `ledger_revise #${index}`)
            return { saved: true }
          },
        }))
      }

      return () => { for (const d of disposers) try { d() } catch {} }
    })

    return off
  })
}
