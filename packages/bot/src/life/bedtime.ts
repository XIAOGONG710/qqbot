// 她说「睡了」就是去睡了（ADR 0042）：聊天里她对谁说了自己这就去睡（「睡了，晚安」「我先睡了」），从说完那一刻起她在睡，睡到那一晚该起的时候。
// 对谁都一样（各个联系人看到的是同一个她）：别人这时找她，等她醒了才看到（男朋友连着发照样能吵醒，ADR 0007 决策 6）；状态行写在睡觉；
// 没人聊天时的日子（ADR 0040）也从那一刻起睡，正在做的那件停在那一刻。
// 线上 10-09 00:32 她跟男朋友说「睡了，晚安」，01:40 同学发「睡觉呢」，她 28 秒就回「这么晚还没睡」——作息是 02:00 睡，按规则她还醒着。
// - 只认她自己说的、整句就是「我（先 / 去）睡了」这一类的话；问句（「睡了吗」）、说他（「你快睡吧」）、说过去（「昨晚三点才睡」「睡了一下午」）、只说「晚安」都不算。
// - 只在那一晚入睡时刻（02:00）前 EARLY_BED_MINUTES（22:30 起）到起床之间算，和裁判的早睡一样（ADR 0038 调整 5）；白天说「睡了」是午睡，不改作息。
// - 能从聊天记录推出来，不另存（ADR 0039）：重启以后照样知道她已经睡了；过去已经落账的不改。

import { localDate } from '../local-date.ts';
import { EARLY_BED_MINUTES } from './actions.ts';
import type { StoredMessage } from '../memory/history.ts';
import { stateAt, type Schedule } from './schedule.ts';

/** 一句里的一小段（带着后面的标点：问号要看得见） */
const CLAUSE = /[^，,。！!？?~～\n…\s]+[，,。！!？?~～\n…\s]*/g;
/**
 * 整段就是「我去睡了」：前面可以带「那 / 好 / 嗯 / 不聊了 / 困了」，后面可以带「晚安」。
 * 「早就睡了」「三点才睡」「睡了一觉」「睡吧」「你睡了」都对不上整段
 */
const BED = /^(?:那|好|嗯|行|唔|晚安)?(?:不聊了|困了|困死了|好困|撑不住了)?(?:那)?(?:我)?(?:也)?(?:先|就|要|准备|该|得|这就|马上|真)?(?:滚)?(?:去)?睡(?:觉)?(?:了|啦|咯|喽|去了|了啊|了哈)(?:睡了|睡啦)?(?:晚安(?:啦|咯|喽)?)?$/;

/** 这一句是不是她说自己这就去睡（表情占位符「[困]」先去掉） */
export function isBedtimeLine(text: string): boolean {
    for (const match of text.replace(/\[[^\]\n]{1,10}\]/g, ' ').matchAll(CLAUSE)) {
        const clause = match[0];
        if (/[？?]/.test(clause)) continue;
        if (BED.test(clause.replace(/[，,。！!~～\n…\s]+$/, ''))) return true;
    }
    return false;
}

/** 那一晚：入睡时刻（02:00）、从几点起说「睡了」算数（早 EARLY_BED_MINUTES）、几点起 */
export function nightOf(schedule: Schedule, at: Date): { from: Date; bed: Date; until: Date } | undefined {
    const [hour, minute] = schedule.sleep.split(':').map(Number);
    const today = localDate(at.getFullYear(), at.getMonth(), at.getDate(), hour, minute);
    // 入睡时刻之前是这一晚；过了入睡时刻、还没起是刚过去的这一晚；起了以后是今晚
    const bed = at < today || stateAt(schedule, at).activity.kind === 'sleep'
        ? today
        : localDate(at.getFullYear(), at.getMonth(), at.getDate() + 1, hour, minute);
    const from = new Date(bed.getTime() - EARLY_BED_MINUTES * 60_000);
    if (at < from) return undefined;
    const night = stateAt(schedule, bed).activity;
    return night.kind === 'sleep' ? { from, bed, until: night.until } : undefined;
}

/**
 * 她说自己去睡了的时刻（since 之后的，不论对谁说的）：那一次回复最后一条的时刻（「困了」「睡了，晚安」两条，按第二条算），
 * 只留落在某一晚「22:30 到起床」之间的。从早到晚
 */
export function saidBedtimes(histories: Iterable<readonly StoredMessage[]>, schedule: Schedule, since: number): number[] {
    const times: number[] = [];
    for (const history of histories) {
        for (let i = history.length - 1; i >= 0; i--) {
            const message = history[i]!;
            const time = Date.parse(message.time);
            if (time < since) break;
            if (message.role !== 'assistant' || !isBedtimeLine(message.content)) continue;
            // 同一次回复接着发的几条（隔不到两分钟、中间没有对方的话）：按最后一条算
            let last = time;
            for (let j = i + 1; j < history.length && history[j]!.role === 'assistant' && Date.parse(history[j]!.time) - last <= 120_000; j++) last = Date.parse(history[j]!.time);
            const night = nightOf(schedule, new Date(time));
            if (night && time < night.until.getTime()) times.push(last);
        }
    }
    return [...new Set(times)].sort((a, b) => a - b);
}

/** at 这一刻她是不是已经说过睡了：这一晚里说的、不晚于 at 的最早那一次起，睡到起床 */
export function asleepSince(schedule: Schedule, bedtimes: readonly number[], at: Date): { since: Date; until: Date } | undefined {
    const night = nightOf(schedule, at);
    if (!night || at >= night.until) return undefined;
    const said = bedtimes.find(time => time >= night.from.getTime() && time <= at.getTime());
    return said === undefined ? undefined : { since: new Date(said), until: night.until };
}

/** at 这一刻她是不是说过睡了、还在睡：这些人的聊天记录里（对谁说的都算）前一天以来她说的「睡了」 */
export function saidAsleepAt(schedule: Schedule, histories: Iterable<readonly StoredMessage[]>, at: Date): { since: Date; until: Date } | undefined {
    return asleepSince(schedule, saidBedtimes(histories, schedule, at.getTime() - 86_400_000), at);
}
