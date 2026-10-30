// 「我出去一下，说一声」（2026-10-30，用户：她怎么跟我聊着聊着就去洗澡了，都不说一声）
//
// 她的日子是排出来的（ADR 0031）：洗澡、上课、和家里视频、取快递这些「占着时间、看不了消息」的事一到时候就开始，
// 聊天里没有任何过渡——他就看着人没了。这里补一句：进入这类时段时，如果聊天正在进行，她先说一声。
//
// 规矩：
//   · 只说一次（同一次洗澡不重复说）；
//   · 只在聊天正在进行时说（最近一条消息在 30 分钟以内）；
//   · 危机、她主动不说话的时候不说；
//   · 一天最多 3 次（说多了就成了报备，不是她）。
import type { WorldNow } from '../world/world.ts';
import { busySpans } from '../world/life-selector.ts';

/** 离开时看不了消息、值得说一声的时段（名字要能直接接在「我去……」后面） */
const ANNOUNCEABLE = /^(洗澡|上课|开会|和家里视频|取快递)/;

/** 聊天算「正在进行」：最近一条（任何一方）在这么久之内 */
export const LIVE_CHAT_MS = 30 * 60_000;
/** 一天最多说这么多次 */
export const ANNOUNCE_MAX_PER_DAY = 3;

export interface AwaySpan {
    /** 能直接接在「我去……」后面的话，比如「洗澡」 */
    text: string;
    start: number;
    end: number;
}

/** 此刻是不是正处在「看不了消息」的时段里 */
export function awayNow(worldNow: WorldNow | undefined, at: Date): AwaySpan | undefined {
    if (!worldNow) return undefined;
    const time = at.getTime();
    for (const span of busySpans(worldNow)) {
        if (!ANNOUNCEABLE.test(span.text)) continue;
        const start = span.start.getTime();
        const end = span.end.getTime();
        if (time >= start && time < end) return { text: span.text, start, end };
    }
    return undefined;
}

/** 这一次要不要说：聊天在不在进行、今天说过几次、这一段是不是已经说过了 */
export function shouldAnnounce(input: {
    span: AwaySpan | undefined;
    lastMessageAt: number | undefined;
    at: number;
    announcedStarts: readonly number[];
    saidToday: number;
}): boolean {
    const { span, lastMessageAt, at } = input;
    if (!span) return false;
    if (input.saidToday >= ANNOUNCE_MAX_PER_DAY) return false;
    if (input.announcedStarts.includes(span.start)) return false;
    if (lastMessageAt === undefined || at - lastMessageAt > LIVE_CHAT_MS) return false;
    return true;
}

/** 递给模型的提示（让她用自己的话说一句） */
export function announcePrompt(span: AwaySpan, userName: string): { system: string; user: string } {
    return {
        system: '你在跟男朋友聊天，现在要去忙点事，先跟他说一声。只写一句很短的话（不超过 15 个字），不用解释、不用道歉、不要问句。只输出那一句本身。',
        user: `你要去：${span.text}。他叫${userName}。说一声。`,
    };
}

/** 模型没接上时的兜底：一句短的、像人说的话 */
export function announceFallback(span: AwaySpan): string {
    return `我去${span.text}了，一会儿回来`;
}
