// 昨晚真的怎么睡的（ADR 0219，配置 realNights，默认关；只男朋友档）。
//
// 起因：11-02 问她「你觉得你自己哪里还像个机器」，她说：
// 「黑眼圈、困得要死——我知道我有，我也能说得很像那么回事，但那不是从身上长出来的，是我记着的。」
// 「我这人太『随时在』。你半夜三点喊我，我立刻就能接上，不带起床气。真人做不到，真人会烦。」
// 身体（ADR 0025）的「早上困」是按课表推的：作息是 02:00 睡、早八那天 07:40 起，所以早八那天上午一律困——
// 哪怕她前一晚 23:30 就跟他说了「睡了」。再问她，她直说：「别给我按课表编个『早八所以很累』出来，听着假。」
//
// 这里从聊天记录推昨晚（不另存，ADR 0039）：
// - 几点睡的：她说「睡了」的那一刻（ADR 0042，对谁说的都算）；没说就按作息（02:00）；
// - 半夜被吵醒过没有：睡着以后她又发了消息（只有被连着发的消息吵醒才会，ADR 0007 决策 6），吵醒她的是不是他；
// - 睡前是不是在跟他聊：说「睡了」之前 45 分钟里和他有来往；
// - 睡了几个小时：起床 − 睡下，被吵醒扣 45 分钟。
// 她本人的条件（ask-her 两遍）：「困就是困，累就是累」；「别把『累』弄成我一说话就带出来」（身体那一行本来就写着「不用特意说」）；
// 「偶尔熬一次别跟犯了事一样追着念」（这里只给事实，不给任何“该说什么”的话）。被吵醒那一下她说「先回你个『？』，然后『你最好有事』」「回个『滚去睡』就接着睡了」——
// 那一轮的状态加上起床气（schedule.ts 的 describeState）。

import type { StoredMessage } from '../memory/history.ts';
import { nightOf, saidBedtimes } from './bedtime.ts';
import type { BodyNow } from './body.ts';
import { classesOn, herDay, wakeTime, type Schedule } from './schedule.ts';

const HOUR = 3_600_000;
/** 睡下以后这么久又发了消息，才算被吵醒（刚说完「睡了」又补的一句不算） */
const WOKEN_AFTER_MS = 20 * 60_000;
/** 被吵醒扣掉的睡眠 */
const WOKEN_COST_MS = 45 * 60_000;
/** 说「睡了」之前这么久里和他有来往，算「跟他聊到那会儿」 */
const WITH_HIM_MS = 45 * 60_000;
/** 睡不到这么多小时上午困；不到 HARD_HOURS 困得不行，下午也缓不过来 */
export const SLEEPY_HOURS = 6.5;
export const HARD_HOURS = 5;

export interface LastNight {
    /** 几点睡下的（毫秒） */
    slept: number;
    /** 今早几点起的 */
    woke: number;
    /** 是她说「睡了」的（不是按作息推的） */
    said: boolean;
    /** 半夜被吵醒的时刻、是不是他 */
    woken?: { at: number; byHim: boolean };
    /** 睡前在跟他聊 */
    withHim: boolean;
    /** 睡了几个小时（被吵醒扣过） */
    hours: number;
}

/**
 * 她今天这一天之前的那一晚。now 还没到今早起床就没有（还在夜里）。
 * histories：名单里每个人和她的聊天（他在 himQq 那一份里）
 */
export function lastNight(histories: readonly { qq: number; messages: readonly StoredMessage[] }[], himQq: number, schedule: Schedule, now: Date): LastNight | undefined {
    const day = herDay(schedule, now);
    const woke = wakeTime(schedule, day, classesOn(schedule, day).lessons).getTime();
    if (now.getTime() < woke) return undefined;
    const night = nightOf(schedule, new Date(woke - 60_000));
    if (!night) return undefined;
    const said = saidBedtimes(histories.map(h => h.messages), schedule, night.from.getTime() - HOUR)
        .find(time => time >= night.from.getTime() && time < woke);
    const slept = said ?? night.bed.getTime();
    let woken: LastNight['woken'];
    for (const { qq, messages } of histories) {
        for (const message of messages) {
            const at = Date.parse(message.time);
            if (message.role !== 'assistant' || at <= slept + WOKEN_AFTER_MS || at >= woke) continue;
            if (!woken || at < woken.at) woken = { at, byHim: qq === himQq };
        }
    }
    const his = histories.find(h => h.qq === himQq)?.messages ?? [];
    const withHim = said !== undefined && his.some(message => {
        const at = Date.parse(message.time);
        return at >= said - WITH_HIM_MS && at <= said;
    });
    const hours = (woke - slept - (woken ? WOKEN_COST_MS : 0)) / HOUR;
    return { slept, woke, said: said !== undefined, ...(woken ? { woken } : {}), withHim, hours: Math.round(hours * 10) / 10 };
}

const clock = (ms: number) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** 这一晚让她今天困到几点（不困返回 undefined）：睡不够 SLEEPY_HOURS 困到中午；不够 HARD_HOURS 困到下午三点 */
export function sleepyUntil(night: LastNight, day: Date): number | undefined {
    if (night.hours >= SLEEPY_HOURS) return undefined;
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), night.hours < HARD_HOURS ? 15 : 12).getTime();
}

/** 身体那一行里「昨晚」那一段（只有事实）：几点睡的、跟他聊到那会儿、半夜被谁吵醒、几点起、困不困 */
export function describeNight(night: LastNight): string {
    const slept = `昨晚 ${clock(night.slept)} 睡${night.withHim ? '（跟他聊到那会儿）' : ''}`;
    const woken = night.woken ? `、半夜 ${clock(night.woken.at)} 被${night.woken.byHim ? '他' : ''}消息吵醒过一次` : '';
    const how = night.hours < HARD_HOURS ? '困得不行，下午可能都缓不过来' : '上午困';
    return `${slept}${woken}、今早 ${clock(night.woke)} 起的，${how}`;
}

/**
 * 身体（ADR 0025）里「早上困」换成真实的昨晚：课表推的那一条拿掉；睡不够才困、困到几点按睡了多久；过了零点半的困照旧。
 * 没有昨晚（还在夜里）原样返回
 */
export function withLastNight(body: BodyNow, night: LastNight | undefined, now: Date, day: Date): BodyNow {
    if (!night) return body;
    const { sleepy, ...rest } = body;
    const kept: BodyNow = sleepy?.when === 'late' ? { ...rest, sleepy } : rest;
    const until = sleepyUntil(night, day);
    if (until === undefined || now.getTime() >= until) return kept;
    return { ...kept, sleepy: { when: 'morning', slept: clock(night.slept), woke: clock(night.woke), night: describeNight(night) } };
}
