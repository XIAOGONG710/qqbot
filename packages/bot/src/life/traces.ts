// 他说过的话、做过的事留下的痕迹（10-31 用户：让说过的话、做过的行为会留下痕迹）。
//
// 不是复制聊天记录（那在 chats/ 和 Hindsight 里都有），是**提炼成一句她记得的事**：
//   · 他说的亲密话：「他说喜欢我」「他说想我」
//   · 他的承诺：「他答应周末带我出去玩」
//   · 他做过的事：「他今天去公司加班」「他买了新键盘」
// 由规则检出、按天去重、最多留 60 条、60 天过期。聊天时最近的几条进提示词，她可以提起来
//（「你昨天不是说……」），也可以不提——提不提她自己定。
//
// 只记他自己的事和他说的话；不记她的、不记别人的、不记三件套（吃了吗/在吗/睡了没）。

import { join } from 'node:path'
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts'

export const TRACES_FILE = 'traces.json'
export const TRACES_KEPT = 60
export const TRACES_WINDOW_MS = 60 * 86_400_000
/** 进提示词的：最近这么久之内的、最多几条 */
export const TRACES_LINE_WINDOW_MS = 3 * 86_400_000
export const TRACES_LINE_MAX = 4

export type TraceKind = 'affection' | 'promise' | 'doing'

export interface Trace {
    id: string
    at: string
    kind: TraceKind
    /** 一句：他做过 / 说过什么（第三人称，她记得的样子） */
    text: string
}

interface TracesState { traces: Trace[] }

const clip = (text: string) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, 80)

/** 他这句是什么痕迹；不是就 undefined。只认「关于他自己」的说法 */
export function traceOf(text: string): { kind: TraceKind; text: string } | undefined {
    const said = String(text || '').trim()
    if (!said || said.length < 2) return undefined
    // 三件套不算
    if (/^(在吗|吃了吗|睡了没|在干嘛|哈+|嗯+|哦+|好+|行+)[？?！!。.～~]*$/.test(said)) return undefined
    // 亲密：他说喜欢 / 爱 / 想她
    if (/(?:我)?(?:真的)?(?:好|超级|特别|很)?(?:喜欢|爱|想)(?:你|宝宝)/.test(said) && !/不喜欢|不爱|不想你/.test(said)) {
        const which = /爱/.test(said) ? '说爱我' : /喜欢/.test(said) ? '说喜欢我' : '说想我'
        return { kind: 'affection', text: `他${which}` }
    }
    // 承诺：他答应的事
    const promise = /(?:答应|说好|一定|保证|下次|明天|周末|回头)(?:[^。！？!?\n]{1,40})/.exec(said)
    if (promise && /(?:陪你|带你|给你|找你|过去|过来|一起|买|请|送|来)/.test(said)) {
        return { kind: 'promise', text: `他${clip(promise[0].replace(/^我/, ''))}` }
    }
    // 他做过的事：他自己的（去/买/吃/做/加班/上课）
    const doing = /我(?:今天|刚才|刚刚|昨天|晚上|早上|下午)?(?:去|买|吃|做了|写完|到了|上班|加班|上课|下课|回家|出差|面试|考试)(?:[^。！？!?\n]{1,30})/.exec(said)
    if (doing) return { kind: 'doing', text: `他${clip(doing[0].replace(/^我(?:今天|刚才|刚刚|昨天|晚上|早上|下午)?/, ''))}` }
    return undefined
}

export function readTraces(dataDir: string, log?: (message: string) => void): TracesState {
    const saved = readJsonOr<TracesState>(join(dataDir, TRACES_FILE), { traces: [] }, log)
    return saved && Array.isArray(saved.traces) ? saved : { traces: [] }
}

/** 记一条；同一句同一天只留一次（他一天说三遍「喜欢你」就是一条痕迹，不是三条） */
export function recordTrace(dataDir: string, trace: { kind: TraceKind; text: string }, now = Date.now()): boolean {
    const text = clip(trace.text)
    if (!text) return false
    const state = readTraces(dataDir)
    const day = new Date(now).toISOString().slice(0, 10)
    if (state.traces.some(item => item.text === text && item.at.slice(0, 10) === day)) return false
    state.traces.push({ id: `tr-${now}`, at: new Date(now).toISOString(), kind: trace.kind, text })
    writeJsonAtomic(join(dataDir, TRACES_FILE), { traces: state.traces.slice(-TRACES_KEPT) })
    return true
}

/** 聊天时递给她的一行：最近几天他说过、做过、答应过的事（她可以提起来，也可以不提） */
export function tracesLine(dataDir: string, now = Date.now()): string | undefined {
    const recent = readTraces(dataDir).traces
        .filter(item => now - Date.parse(item.at) < TRACES_LINE_WINDOW_MS)
        .slice(-TRACES_LINE_MAX)
    if (!recent.length) return undefined
    const when = (iso: string) => {
        const at = new Date(iso)
        const today = new Date(now).toDateString() === at.toDateString()
        return today ? '今天' : `${at.getMonth() + 1}月${at.getDate()}日`
    }
    return `[你记得他最近这些事（是他说过 / 做过的，不是编的；聊到相关的再提，别硬塞）：${recent.map(item => `${when(item.at)} ${item.text}`).join('；')}]`
}
