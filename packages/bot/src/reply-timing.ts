// 回复时机（ADR 0007 决策 4–7）：没回的消息她什么时候看到、每条打字多久、收尾之后的附和不回。
// 都是纯函数，按聊天记录和时间算；随机的部分按消息 id 定下来，同一串消息重算多少次都一样（调度在 responder.ts，等待期间来新消息会重算）。

import type { StoredMessage } from './history.ts';
import { stateAt, type Schedule } from './schedule.ts';

/** 她这么久之内发过消息算正聊着，不加冷场延迟 */
export const HOT_MS = 10 * 60_000;
/** 冷场时过多久看到 */
export const COLD_DELAY_MS: Range = [15_000, 60_000];
/** 起床后过多久看到夜里的消息 */
export const AFTER_WAKE_MS: Range = [0, 30 * 60_000];
/** 上课时还没到看手机的时候先下课了：下课后过多久看到 */
export const AFTER_CLASS_MS: Range = [30_000, 120_000];
/** 男朋友档睡着时被吵醒：15 分钟内到了第 3 条，或者隔了 2 分钟以上又来一条（都在 15 分钟内） */
export const WAKE_UP_WINDOW_MS = 15 * 60_000;
export const WAKE_UP_COUNT = 3;
export const WAKE_UP_GAP_MS = 2 * 60_000;
/** 夜里的消息起床后照样回（bot 重启后的补回不受 3 小时的限制），超过这么久就不回了 */
export const NIGHT_CATCH_UP_MS = 12 * 3_600_000;

type Range = readonly [min: number, max: number];

export interface Seen {
    /** 毫秒时间戳：到这时才看到；不晚于现在就是已经看到了 */
    at: number;
    /** 日志里说明为什么是这个时候 */
    reason: string;
    /** 睡着时被消息吵醒（这次生成的状态写迷迷糊糊） */
    woken?: boolean;
    /** 这次最多回几条（上课时） */
    maxBubbles?: number;
}

export interface TimingOptions {
    schedule: Schedule;
    /** 睡着时连着发能把她吵醒，一晚最多一次（男朋友档，决策 6） */
    wakeable: boolean;
}

/** 判断附和、收尾只要角色和内容（聊天记录、提示词里的消息都行） */
type Said = { role: 'user' | 'assistant'; content: string };

/** 她上次回复之后对方发的消息（没回的） */
export function unansweredMessages<T extends Said>(history: T[]): T[] {
    return history.slice(history.findLastIndex(m => m.role === 'assistant') + 1).filter(m => m.role === 'user');
}

/**
 * 这次要回的那一串：没回的消息去掉开头那几句收尾后的附和——那几句已经按「不回」处理过（决策 7），
 * 对方隔了很久才说下一句时，这一串从那句算起（什么时候看到、冷场延迟、时间块都按它）。只有附和时为空。
 */
export function pendingMessages<T extends Said>(history: T[]): T[] {
    const unanswered = unansweredMessages(history);
    if (!closedByHer(history)) return unanswered;
    const firstNew = unanswered.findIndex(m => !isAck(m.content));
    return firstNew < 0 ? [] : unanswered.slice(firstNew);
}

/** 没回的这一串她什么时候看到；没有没回的消息返回 undefined */
export function whenSeen(history: StoredMessage[], now: number, options: TimingOptions): Seen | undefined {
    const pending = pendingMessages(history);
    if (pending.length === 0) return undefined;
    const { schedule } = options;
    const first = Date.parse(pending[0]!.time);
    const seed = String(pending[0]!.messageId ?? pending[0]!.time);
    const state = stateAt(schedule, new Date(now));
    const { activity } = state;

    if (activity.kind === 'sleep') {
        const sleepStart = atTime(new Date(now), schedule.sleep);
        if (options.wakeable && !history.some(m => m.role === 'assistant' && Date.parse(m.time) >= sleepStart)) {
            const nightly = pending.map(m => Date.parse(m.time)).filter(t => t >= sleepStart);
            const woke = wakeUpTime(nightly);
            if (woke !== undefined) return { at: woke, reason: '睡着了，被连着来的消息吵醒', woken: true, maxBubbles: 1 };
        }
        return { at: activity.until.getTime() + pick(seed, 'wake', AFTER_WAKE_MS), reason: '在睡觉，起床后看到' };
    }

    if (activity.kind === 'class') {
        const { lesson } = activity;
        const kind = schedule.kinds[lesson.kind];
        if (kind.seeAfterMin) {
            const [min, max] = kind.seeAfterMin;
            const base = Math.max(first, lesson.start.getTime());
            const during = base + pick(seed, 'class', [min * 60_000, max * 60_000]);
            const after = lesson.end.getTime() + pick(seed, 'after-class', AFTER_CLASS_MS);
            return {
                at: Math.min(during, after),
                reason: `在上${kind.label ?? '课'}`,
                ...(kind.maxBubbles ? { maxBubbles: kind.maxBubbles } : {}),
            };
        }
    }

    // 空闲、课间、水课、体育：正聊着马上看到，冷场过一会儿
    const lastReply = history.findLast(m => m.role === 'assistant');
    if (lastReply && first - Date.parse(lastReply.time) <= HOT_MS) return { at: first, reason: '正聊着' };
    return { at: first + pick(seed, 'cold', COLD_DELAY_MS), reason: '冷场，过一会儿才看到' };
}

/** 睡着以后的消息时间（从早到晚）：第几条把她吵醒，返回那一条的时间 */
export function wakeUpTime(times: number[]): number | undefined {
    for (const [k, t] of times.entries()) {
        const recent = times.slice(0, k + 1).filter(x => t - x < WAKE_UP_WINDOW_MS);
        if (recent.length >= WAKE_UP_COUNT) return t;
        if (recent.some(x => t - x >= WAKE_UP_GAP_MS)) return t;
    }
    return undefined;
}

/** 一条的打字时间：0.8 秒 + 每字 0.1 秒，限制在 1–4 秒，±20% 抖动（按内容定，同一句每次一样） */
export function typingMs(text: string): number {
    const base = Math.min(4000, Math.max(1000, 800 + 100 * [...text].length));
    return Math.round(base * (0.8 + 0.4 * unit(text)));
}

// 收尾：她上一次说的话里有这些（晚安、去忙吧……）
const CLOSING = /晚安|睡吧|早点睡|去睡|先睡|去吧|去忙|先忙|忙吧|拜拜|回头聊|明天聊|明天见/;
// 附和：去掉表情占位符、标点、emoji 之后只剩这些
const ACK = /^(?:嗯+|恩+|好+|好的|好滴|好哒|哦+|噢+|喔+|ok+|行|收到|晚安+|安安|拜拜?|88|明天见)+$/i;

/** 她已经收尾，之后对方发的全是附和（决策 7）：不回 */
export function isAckAfterClosing(history: Said[]): boolean {
    return closedByHer(history) && unansweredMessages(history).length > 0 && pendingMessages(history).length === 0;
}

/** 她最后一次回复是收尾的话 */
function closedByHer(history: Said[]): boolean {
    const lastReply = history.findLastIndex(m => m.role === 'assistant');
    if (lastReply < 0) return false;
    // 她最后一次回复可能拆成了几条
    let start = lastReply;
    while (start > 0 && history[start - 1]!.role === 'assistant') start--;
    return CLOSING.test(history.slice(start, lastReply + 1).map(m => m.content).join('\n'));
}

export function isAck(text: string): boolean {
    const stripped = text.replace(/\[[^\]]*\]/g, '').replace(/[\p{P}\p{S}\p{Extended_Pictographic}\s～~]/gu, '');
    // 只有表情也算附和
    if (!stripped) return text.trim().length > 0;
    return ACK.test(stripped);
}

/** 第一条没回的消息是她睡着时发来的，现在还在 NIGHT_CATCH_UP_MS 之内：起床后照样回（bot 重启后的补回用） */
export function arrivedWhileAsleep(history: StoredMessage[], now: number, schedule: Schedule): boolean {
    const first = pendingMessages(history)[0];
    if (!first) return false;
    const time = Date.parse(first.time);
    return now - time <= NIGHT_CATCH_UP_MS && stateAt(schedule, new Date(time)).activity.kind === 'sleep';
}

/** 当天的 HH:MM */
function atTime(day: Date, time: string): number {
    const [h, m] = time.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
}

/** 按种子在范围里取一个值（主动消息的时刻也用它，ADR 0011） */
export function pick(seed: string, purpose: string, [min, max]: Range): number {
    return Math.round(min + (max - min) * unit(`${seed} ${purpose}`));
}

/** 字符串 → [0, 1)（FNV-1a） */
function unit(text: string): number {
    let h = 0x811c9dc5;
    for (const ch of text) {
        h ^= ch.codePointAt(0)!;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h / 2 ** 32;
}
