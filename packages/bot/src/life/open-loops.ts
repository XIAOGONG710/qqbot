// 挂着的事（ADR 0023）：她心里挂着、还没了结的事，跨天记的是事实，不是情绪（作者 10-06 裁决「跨天存账，情绪当天重算」）。
// - 三类，和她答应的事（promises.ts）在同一次抽取里出来（每段聊天结束一次模型调用），存在同一个状态文件里：
//   waiting 他那边之后会发生、她想知道结果的事（面试、考试、出行、看病）；
//   unanswered 她问了他一个真问题、他没回答（岔开了）；
//   unsettled 两个人说好的事最后没成、一件事没说完就断了——写发生了什么，不写谁什么感觉。
// - 用：waiting、unanswered 到了时候给意图行一条「这一轮你想」，只表达期待（想知道、再问一次），不表达介意（作者裁决二·3）；
//   unsettled 放在时间块里心情后面一行「心里还记着、没了结的事」，只存事实；当前那一点余波每轮从事实重算，不存情绪，明确修补时先软下来。
// - 写进去的必须是别人能听懂「发生了什么」的事实：抽出来带情绪词的（难过、委屈、介意……）直接丢掉，ADR 0018「不做带情绪的记忆」的边界不破。
// - 忘：有日子的 waiting 过了那天 WAITING_DAYS 天、没日子的过了说的那天 NEXT_TIME_DAYS 天；unanswered、unsettled 过了说的那天
//   UNANSWERED_DAYS、UNSETTLED_DAYS 天（之后它们还在长期记忆里，只是不再挂在当天这一层）。

import { splitEpisodes } from '.././memory/episodes.ts';

export type LoopKind = 'waiting' | 'unanswered' | 'unsettled';

export interface OpenLoop {
    id: string;
    kind: LoopKind;
    /** 一句话的事实：「阿明周四下午字节面试」「他周末回不回家」「10月6日说好一起看电影，他加班没去成」 */
    what: string;
    /** waiting：那件事哪天（YYYY-MM-DD，本地）；没说哪天的没有 */
    date?: string;
    /** 哪天说的（YYYY-MM-DD，她的一天） */
    said: string;
    /** 从哪个聊天片段抽出来的 */
    episode: string;
}

/** 有日子的 waiting：那天之后几天还会想起来问 */
export const WAITING_DAYS = 3;
/** 没日子的 waiting：说的那天之后几天 */
export const NEXT_TIME_DAYS = 7;
/** 她问了他没答：之后几天里会再问一次 */
export const UNANSWERED_DAYS = 3;
/** 没了结的事：之后几天里还挂在心上 */
export const UNSETTLED_DAYS = 3;
/** 一段聊天里她回了几次还没提，这段聊天里就不再放（同 promises.ts） */
export const SHOWN_REPLIES = 3;
/** 那件事当天，几点以后算「该有结果了」（下午的面试，晚上可以问） */
export const SAME_DAY_HOUR = 18;

/** 记的是事实，不是情绪：带这些词的不记（ADR 0018 用户定的「不做带情绪的记忆」） */
export const FEELING = /难过|伤心|生气|委屈|介意|失望|不开心|不高兴|难受|心酸|心寒|烦躁|气死|讨厌|吃醋|酸溜溜|郁闷|失落|不爽|憋屈|寒心|冷落/;

/** 这一条写的是不是情绪（是就不记） */
export function isFeeling(what: string): boolean {
    return FEELING.test(what);
}

const DAY_MS = 86_400_000;

function parseDay(date: string): Date {
    const [y, m, d] = date.split('-').map(Number);
    return new Date(y!, m! - 1, d);
}

const daysFrom = (date: string, day: Date) => Math.round((day.getTime() - parseDay(date).getTime()) / DAY_MS);

/** 忘了吗（today 是她的一天） */
export function loopForgotten(loop: OpenLoop, today: Date): boolean {
    switch (loop.kind) {
        case 'waiting': return loop.date ? daysFrom(loop.date, today) > WAITING_DAYS : daysFrom(loop.said, today) > NEXT_TIME_DAYS;
        case 'unanswered': return daysFrom(loop.said, today) > UNANSWERED_DAYS;
        case 'unsettled': return daysFrom(loop.said, today) > UNSETTLED_DAYS;
    }
}

type TimedMessage = { role: 'user' | 'assistant'; time?: string };

/** 这一段聊天（最后一个片段）的 id，和她在这一段里回了几次（连发算一次） */
function currentEpisode(chat: readonly TimedMessage[]): { id?: string; replies: number } {
    const current = splitEpisodes(chat.flatMap(m => (m.time ? [{ role: m.role, content: '', time: m.time }] : []))).at(-1);
    const replies = current ? current.messages.filter((m, i) => m.role === 'assistant' && current.messages[i - 1]?.role !== 'assistant').length : 0;
    return { id: current?.id, replies };
}

export interface DueLoops {
    waiting: OpenLoop[];
    unanswered: OpenLoop[];
    unsettled: OpenLoop[];
}

/**
 * 这一轮挂在心上的：都只在抽出它的那段聊天之后（那一段里原话就在眼前）；这一段她已经回了 SHOWN_REPLIES 次的都不放了。
 * 有日子的 waiting 在那天 SAME_DAY_HOUR 点以后到之后 WAITING_DAYS 天；其余的在没忘之前。
 */
export function dueLoops(loops: readonly OpenLoop[], today: Date, now: Date, chat: readonly TimedMessage[]): DueLoops {
    const due: DueLoops = { waiting: [], unanswered: [], unsettled: [] };
    const current = currentEpisode(chat);
    if (current.replies >= SHOWN_REPLIES) return due;
    for (const loop of loops) {
        if (loop.episode === current.id || loopForgotten(loop, today)) continue;
        if (loop.kind === 'waiting' && loop.date) {
            const d = daysFrom(loop.date, today);
            if (d < 0 || (d === 0 && now.getHours() < SAME_DAY_HOUR)) continue;
        }
        due[loop.kind].push(loop);
    }
    return due;
}

/**
 * 时间块里心情后面的一行：跨天留下的仍只有事实；当下那一点余波每次从事实重算，不落盘。
 * repairing 表示他刚刚在道歉/安慰，修补动作应当先于旧余波，不能让她机械地继续冷着。
 */
export function describeUnsettled(loops: readonly OpenLoop[], repairing = false): string | undefined {
    if (loops.length === 0) return undefined;
    const effect = repairing
        ? '他刚刚正在修补，所以别机械地继续绷着；先接住当下的好意'
        : '这件事让此刻的语气留一点余波，不必装作完全没发生';
    return `[你心里还记着、没了结的事（跨天只记客观事实，不保存情绪，也不是要你说的话）：${loops.map(l => l.what).join('；')}。${effect}；不用特意提，也不翻旧账]`;
}
