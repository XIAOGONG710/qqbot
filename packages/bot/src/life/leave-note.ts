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
import type { StoredMessage } from '../memory/history.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import { busySpans } from '../world/life-selector.ts';

/** 离开时看不了消息、值得说一声的时段（名字要能直接接在「我去……」后面） */
const ANNOUNCEABLE = /^(洗澡|上课|开会|和家里视频|取快递)/;

/** 聊天算「正在进行」：最近一条（任何一方）在这么久之内 */
export const LIVE_CHAT_MS = 30 * 60_000;
/** 一天最多说这么多次 */
export const ANNOUNCE_MAX_PER_DAY = 3;
/** 她说「别要求得太死，有时候真顾不上打字」：安安静静走开不说的比例（按这一次洗澡的时间定，不随机漂） */
export const QUIET_LEAVE_SHARE = 0.25;

const quietLeave = (start: number): boolean => {
    let hash = 0x811c9dc5;
    for (const char of String(start)) { hash ^= char.charCodeAt(0); hash = Math.imul(hash, 0x01000193) >>> 0; }
    return (hash % 100) < QUIET_LEAVE_SHARE * 100;
};

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
    if (quietLeave(span.start)) return false;
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

/** 走开前说一声这件事要读写的东西（App 给；聊天记录是全量的那一份，不分档） */
export interface LeaveAnnouncerDeps {
    /** 男朋友档的那一位 */
    owner: { qq: number; name: string } | undefined;
    /** 她那边的世界（世界账）在某一刻的样子；没有世界账不给（那就从不说） */
    worldAt?: (at: Date) => WorldNow | undefined;
    /** 他最近说过想伤害自己的话：普通主动消息暂停 */
    paused: (qq: number, now: number) => boolean;
    history: (qq: number) => StoredMessage[];
    append: (qq: number, message: StoredMessage) => void;
    send: (qq: number, text: string) => Promise<unknown>;
    /** 后台模型调用（聊天的配置、温度 0.9） */
    generate: (messages: OpenAIMessage[]) => Promise<string>;
    log: (message: string) => void;
    stopped: () => boolean;
}

/**
 * 她去洗澡 / 上课之前说一声（2026-10-30 用户：聊着聊着就去洗澡了，都不说一声）：原来是 app.ts 里的 checkLeave 加一个每 3 分钟的计时器，
 * ADR 0336 第 6 步逐字搬到这里（闭包里取的换成 deps），定时由 modules/leave-note.ts 声明。说过哪几段、今天说了几次只在内存里（重启清空，靠查聊天记录兜底）
 */
export function leaveAnnouncer(deps: LeaveAnnouncerDeps): { check(): Promise<void> } {
    const { owner } = deps;
    const announcedLeaves: number[] = [];
    let leaveDay = '';
    let leaveCount = 0;
    async function checkLeave(): Promise<void> {
        if (deps.stopped() || !deps.worldAt || !owner) return;
        if (deps.paused(owner.qq, Date.now())) return;
        const at = new Date();
        const span = awayNow(deps.worldAt(at), at);
        const history = deps.history(owner.qq);
        const lastAt = Date.parse(history.at(-1)?.time ?? '');
        const day = at.toISOString().slice(0, 10);
        if (day !== leaveDay) { leaveDay = day; leaveCount = 0; }
        if (!shouldAnnounce({ span, lastMessageAt: Number.isFinite(lastAt) ? lastAt : undefined, at: at.getTime(), announcedStarts: announcedLeaves, saidToday: leaveCount })) return;
        // 10-30：announcedLeaves 只在内存里，插件一重载就清空——同一次洗澡又说一遍
        //（23:14 / 23:20 / 23:29 三次，每次都在一次「已就绪」之后）。
        // 改成查聊天记录：这一段开始之后她说过这件事，就不再发。
        if (history.some(m => m.role === 'assistant' && Date.parse(m.time) >= span!.start && m.content.includes(span!.text))) {
            announcedLeaves.push(span!.start);
            return;
        }
        announcedLeaves.push(span!.start);
        leaveCount += 1;
        let line = '';
        try {
            const prompt = announcePrompt(span!, owner.name);
            const generated = await deps.generate([{ role: 'system', content: prompt.system }, { role: 'user', content: prompt.user }]);
            const rawLine = String(generated ?? '');
            line = rawLine.split(/\r?\n/).map(part => part.trim()).filter(Boolean)[0] ?? '';
        } catch (error) {
            deps.log(`走开说一声：没想出来（${error instanceof Error ? error.message : String(error)}），用兜底那句`);
        }
        if (!line || [...line].length > 24) line = announceFallback(span!);
        try {
            await deps.send(owner.qq, line);
            deps.append(owner.qq, { role: 'assistant', content: line, time: at.toISOString(), messageId: 0 } as never);
            deps.log(`她说了一声要去${span!.text}（${[...line].length} 字）`);
        } catch (error) {
            deps.log(`走开说一声：没发出去（${error instanceof Error ? error.message : String(error)}）`);
        }
    }
    return { check: checkLeave };
}
