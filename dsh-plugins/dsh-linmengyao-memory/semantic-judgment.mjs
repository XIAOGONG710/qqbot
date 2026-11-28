// 私聊语义判断（硬编码改造第一优先级，exchange/handoff/2026-11-28-hardcoded-policy-audit.md）：QQ 和 DSH 共用的一份约定。
// 他在私聊里最后说的那几句，是「认真求关心」「轻松接梗」「没接就收」「推掉 / 拒绝」「纠正她的理解」，还是都不是 / 拿不准——问一次小模型，输出类别、依据（对话里的行号和原文片段）、不确定性。
// 第四批（语言与理解 C）加了 refusal、correction 两类，并在提示词里写明玩笑式的求哄（「不哄我就不睡了」）是接梗、不是认真求关心（第一批补验的缺口一）；
// reportedSpeech 给 QQ 退回关键词时用：他分几条发的转述（「我室友跟他女朋友说了一句：」+ 下一条）不当成他自己的要求（缺口二）。
// 三层分开：这里只管「模型怎么理解这句话」；程序允许做什么（只放一句理解进提示词、只影响出口检查已有的重写选择）由两边各自的接线定；
// 最终怎么说是她自己的事。判定结果**不能**当权限、不能落成事实或记忆、不能当对外发送的凭据。
// 超时 / 读不懂 / 依据对不上原文 / 拿不准，一律退回原来的关键词（QQ 的 review-exit.ts 那几条正则，作兼容入口，本批不删）。
// 两边（packages/bot/src/modules/semantic-judgment.ts、本目录 index.js）都从这里拿提示词、格式、解析和那一行，保证同一段对话读到一样的判断。
// 日志只记类别、不确定性、依据条数和字数，不记原话、不记账号（judgmentLogLine）。

/**
 * 类别：care 认真求关心；banter 轻松接梗；closing 没接就收（只应一声、要走要睡、转去说别的）；refusal 推掉 / 拒绝她刚提的事；
 * correction 纠正她刚才对他的话的理解；none 都不是；unclear 拿不准
 */
export const JUDGMENT_CATEGORIES = ['care', 'banter', 'closing', 'refusal', 'correction', 'none', 'unclear']
export const JUDGMENT_LABELS = { care: '认真求关心', banter: '轻松接梗', closing: '没接就收', refusal: '推掉 / 拒绝', correction: '纠正理解', none: '都不是', unclear: '拿不准' }
/** 这几类必须至少有一处依据落在他最后说的那几行 */
export const JUDGMENT_INTENTS = ['care', 'banter', 'closing', 'refusal', 'correction']
/** 带上最近几条（他最后说的那几行一定在里面） */
export const JUDGMENT_CONTEXT = 6
/** 每行最多给模型看多少字；依据的原文片段按截过的这一版核对 */
export const JUDGMENT_LINE_MAX = 120
/** 依据里引的原文片段最多多少字、最多几处 */
export const JUDGMENT_QUOTE_MAX = 24
export const JUDGMENT_EVIDENCE_MAX = 3
/** 这是回复路上的一步：慢了就当没问 */
export const JUDGMENT_TIMEOUT_MS = 2500
export const JUDGMENT_MAX_TOKENS = 160
/** 不确定性超过这个就不用（退回关键词） */
export const JUDGMENT_MAX_UNCERTAINTY = 0.5

export const JUDGMENT_SYSTEM = [
  '你在帮一个女生读懂她男朋友在私聊里最后说的那几句话。你只判断他的意思，不回复他，也不替她决定说什么。',
  '看意思，不看字眼。类别：',
  '- care：他认真想让她在意、关心、安慰或哄他一下（累了、难受、委屈、想听她说句软话），这一回要的是被在意，不是逗着玩。',
  '- banter：他在轻松接梗、开玩笑、闹着玩或回撩，气氛是好玩的。',
  '- closing：他没接她的梗，只应一声、要走要睡，或明确转去说别的事；这个话题该收了。',
  '- refusal：他在推掉、拒绝她刚提的事（邀约、提议、要给他的东西），或者明说不要她刚才那样做。',
  '- correction：他在纠正她刚才对他的话的理解（「不是这个意思」「我说的是……」「你理解错了」），或者说明自己当时真正的意思。',
  '- none：以上都不是（日常说事、问问题、分享）。',
  '- unclear：拿不准，或者证据不够。',
  '注意：引用或转述别人的话（「他说"哄我一下"」「我室友跟他女朋友说……」，包括分成几条发的：前一条说「他说了一句：」，后一条是那句话）不是他在对她提要求；否定（「不用哄我」「我没事，别安慰我」）不是在求关心；同一个词放在不同上下文里意思可以不同。',
  '玩笑式的求哄是 banter，不是 care：撒娇、耍赖、拿条件开玩笑（「不哄我就不睡了」「不哄我我就闹」「哄我一下嘛~」），气氛是好玩的；只有他同时说了自己真的累、难受、委屈，或者明说是认真的，才是 care。',
  `只输出一个 JSON 对象，不要别的字：{"category":"<类别>","evidence":[{"line":<行号>,"quote":"<那一行里一字不差的原文片段，${JUDGMENT_QUOTE_MAX} 字以内>"}],"uncertainty":<0 到 1 的数，越大越没把握>}`,
  `care、banter、closing、refusal、correction 至少引一处他最后说的那几行；依据最多 ${JUDGMENT_EVIDENCE_MAX} 处。拿不准就给 unclear，别硬猜。`,
].join('\n')

const normalize = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()
const clip = (text, max) => { const chars = [...normalize(text)]; return chars.length > max ? chars.slice(0, max).join('') : chars.join('') }

/**
 * 两边的聊天记录整理成同一种样子：只留他和她说的话（role 是 user / assistant、有字的），去掉多余空白、每行截到 JUDGMENT_LINE_MAX 字，取最后 JUDGMENT_CONTEXT 条。
 * QQ 给 ChatMessage（content 是字符串），DSH 先用自己的 textOf 取出文字再给。
 */
export function judgmentConversation(messages) {
  const lines = []
  for (const message of Array.isArray(messages) ? messages : []) {
    const role = message?.role
    if (role !== 'user' && role !== 'assistant') continue
    const content = clip(typeof message.content === 'string' ? message.content : '', JUDGMENT_LINE_MAX)
    if (content) lines.push({ role, content })
  }
  return lines.slice(-JUDGMENT_CONTEXT)
}

/** 他最后说的那几行（末尾连着的 user 行）的下标；最后一条不是他说的就是空的 */
export function latestLines(conversation) {
  const indexes = []
  for (let i = conversation.length - 1; i >= 0 && conversation[i].role === 'user'; i--) indexes.unshift(i)
  return indexes
}

/** 给模型的消息：带行号的对话 + 他刚说的是哪几行 */
export function judgmentMessages(conversation) {
  const latest = latestLines(conversation).map(i => i + 1)
  const numbered = conversation.map((line, i) => `${i + 1} ${line.role === 'user' ? '他' : '她'}：${line.content}`).join('\n')
  const which = latest.length > 1 ? `第 ${latest[0]}–${latest.at(-1)} 行` : `第 ${latest[0] ?? conversation.length} 行`
  return [
    { role: 'system', content: JUDGMENT_SYSTEM },
    { role: 'user', content: `对话（行号 说话人：原文）：\n${numbered}\n\n他刚说的是${which}。` },
  ]
}

const KEYS = new Set(['category', 'evidence', 'uncertainty'])
const EVIDENCE_KEYS = new Set(['line', 'quote'])

/**
 * 严格解析：整段回答只能是一个 JSON 对象（外面最多包一层 ``` 代码块）；字段只能是 category / evidence / uncertainty，三样都要有；
 * 类别在清单里；不确定性是 0–1 的数；每处依据的行号在对话里、原文片段在那一行里一字不差地出现；
 * care / banter / closing / refusal / correction（JUDGMENT_INTENTS）至少有一处依据落在他最后说的那几行。有一样不对就整个不认（返回 undefined，调用方退回关键词）。
 * 依据里的说话人按对话那一行定，不信模型说的。
 */
export function parseJudgment(raw, conversation) {
  if (typeof raw !== 'string') return undefined
  const text = raw.trim().replace(/^```(?:json)?\s*\n?([^]*?)\n?```$/u, '$1').trim()
  if (!text.startsWith('{') || !text.endsWith('}')) return undefined
  let value
  try { value = JSON.parse(text) } catch { return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const keys = Object.keys(value)
  if (keys.length !== KEYS.size || keys.some(key => !KEYS.has(key))) return undefined
  const { category, evidence, uncertainty } = value
  if (!JUDGMENT_CATEGORIES.includes(category)) return undefined
  if (typeof uncertainty !== 'number' || !Number.isFinite(uncertainty) || uncertainty < 0 || uncertainty > 1) return undefined
  if (!Array.isArray(evidence) || evidence.length > JUDGMENT_EVIDENCE_MAX) return undefined
  const cited = []
  for (const item of evidence) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined
    const itemKeys = Object.keys(item)
    if (itemKeys.length !== EVIDENCE_KEYS.size || itemKeys.some(key => !EVIDENCE_KEYS.has(key))) return undefined
    const { line, quote } = item
    if (!Number.isInteger(line) || line < 1 || line > conversation.length) return undefined
    if (typeof quote !== 'string') return undefined
    const span = normalize(quote)
    if (!span || [...span].length > JUDGMENT_QUOTE_MAX || !conversation[line - 1].content.includes(span)) return undefined
    cited.push({ line, speaker: conversation[line - 1].role === 'user' ? 'him' : 'her', quote: span })
  }
  if (JUDGMENT_INTENTS.includes(category)) {
    const latest = new Set(latestLines(conversation).map(i => i + 1))
    if (!cited.some(item => latest.has(item.line))) return undefined
  }
  return { category, evidence: cited, uncertainty }
}

/** 能用的判断：不是 unclear、不确定性不超过 JUDGMENT_MAX_UNCERTAINTY。none 也能用（说明不是这三种，关键词误触发时以它为准） */
export function usableJudgment(judgment) {
  return Boolean(judgment && judgment.category !== 'unclear' && judgment.uncertainty <= JUDGMENT_MAX_UNCERTAINTY)
}

class JudgmentTimeout extends Error {}

/**
 * 问一次：返回 { judgment }（能用）或 { fallback: 原因, judgment? }（原因：empty 他没说话 / timeout / error / unparsable / uncertain）。
 * 不抛错；ask 由两边各自给（QQ 经执行器的小调用，DSH 直接请求 OpenAI 兼容接口）。
 */
export async function judgeTurn({ conversation, ask, timeoutMs = JUDGMENT_TIMEOUT_MS }) {
  if (!latestLines(conversation).length) return { fallback: 'empty' }
  let timer
  try {
    const raw = await Promise.race([
      Promise.resolve().then(() => ask(judgmentMessages(conversation))),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new JudgmentTimeout()), timeoutMs) }),
    ])
    const judgment = parseJudgment(raw, conversation)
    if (!judgment) return { fallback: 'unparsable' }
    if (!usableJudgment(judgment)) return { fallback: 'uncertain', judgment }
    return { judgment }
  } catch (error) {
    return { fallback: error instanceof JudgmentTimeout ? 'timeout' : 'error' }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const UNDERSTOOD = {
  care: '他像是认真想让你在意他一下，不是在逗着玩',
  banter: '他像是在跟你轻松接梗、闹着玩',
  closing: '他像是没接这个梗，想收住或者转去说别的',
  refusal: '他像是在推掉或者不想要你刚才提的事',
  correction: '他像是在纠正你刚才对他的话的理解',
}

/**
 * 放进她提示词的那一行：只说「你对他这几句的理解」和把握，不教她怎么说。none / unclear / 不能用的判断没有这一行（返回空字符串）。
 * 依据只引他说的原文片段（她本来就看得到这段对话）。
 */
export function judgmentLine(judgment) {
  if (!usableJudgment(judgment) || !UNDERSTOOD[judgment.category]) return ''
  const quotes = judgment.evidence.filter(item => item.speaker === 'him').slice(0, 2).map(item => `「${item.quote}」`)
  const basis = quotes.length ? `依据：他说的${quotes.join('、')}；` : ''
  return `[你对他这几句的理解：${UNDERSTOOD[judgment.category]}（${basis}把握：${judgment.uncertainty <= 0.2 ? '较大' : '一般'}）。这只是你的理解，不一定对，以他的原话为准]`
}

/** 转述的引子：一行以「说了一句：」「问：」「回了句」这类结尾，或者以冒号结尾，或者开了引号没关（下一条就是被转述的那句话） */
const REPORTING_CUE = /(?:[说讲问喊]|(?:回|发|写)了?一?句)(?:了|着)?(?:一句|句|一声|这么一句|这句)?话?[:：，,]?\s*$|[:：]\s*$|[「“"『][^」”"』]*$/u
/** 他自己对她说的引子（「我跟你说：」「告诉你：」「问你个事：」「我说：」「你说，」）不是转述别人 */
const OWN_VOICE = /(?:跟|和|对|给)你(?:说|讲)|告诉你|问你|(?:^|[，,。！!？?\s])(?:我|你)(?:想|就|要|再)?(?:说|讲|问)(?:一句|句)?[:：，,]?\s*$/u

/**
 * 他最后说的那几行（末尾连着的 user 行）是不是在转述别人的话：最后一行前面、同一串里有一行以转述的引子结尾。
 * 不调模型，只给 QQ 在语义判断退回关键词时用（关键词只看最后一行，分几条发的引文会被当成他自己的要求，第一批补验的缺口二）。
 * DSH 没有关键词回退，不用它。
 */
export function reportedSpeech(conversation) {
  const latest = latestLines(conversation)
  return latest.slice(0, -1).some(i => REPORTING_CUE.test(conversation[i].content) && !OWN_VOICE.test(conversation[i].content))
}

const FALLBACK_LABELS = { empty: '他没说话', timeout: '超时', error: '没问成', unparsable: '回答读不懂', uncertain: '拿不准' }

/** 日志那一行：类别、不确定性、依据几处、他这几句多少字；不记原话、不记账号 */
export function judgmentLogLine(result, conversation) {
  const said = latestLines(conversation).reduce((sum, i) => sum + [...conversation[i].content].length, 0)
  if (result.fallback) {
    const seen = result.judgment ? `，模型给的是 ${result.judgment.category} ${result.judgment.uncertainty}` : ''
    return `语义判断：退回关键词（${FALLBACK_LABELS[result.fallback] ?? result.fallback}${seen}），他这几句 ${said} 字`
  }
  const { category, uncertainty, evidence } = result.judgment
  return `语义判断：${category}（${JUDGMENT_LABELS[category]}），不确定性 ${uncertainty}，依据 ${evidence.length} 处，他这几句 ${said} 字`
}

/**
 * DSH 这边的那次调用：OpenAI 兼容的 Chat Completions，温度 0、几十个 token、带超时。没有密钥就不建（返回 undefined，插件不做判断）。
 * QQ 那边不用它（走执行器的小调用）。
 */
export function createJudgmentAsk({ key, baseUrl = 'https://api.deepseek.com', model = 'deepseek-flash', extraBody = { thinking: { type: 'disabled' } }, fetcher = fetch, timeoutMs = JUDGMENT_TIMEOUT_MS } = {}) {
  if (!key) return undefined
  return async (messages) => {
    const response = await fetcher(`${String(baseUrl).replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
      body: JSON.stringify({ model, messages, temperature: 0, max_tokens: JUDGMENT_MAX_TOKENS, ...extraBody }),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const data = await response.json()
    return String(data?.choices?.[0]?.message?.content ?? '')
  }
}
