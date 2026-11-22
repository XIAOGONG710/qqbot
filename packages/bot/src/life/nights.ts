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
//
// 桌面上的回合（ADR 0347 第 3 层，开关 desktopConflict；方案 docs/plans/2026-11-22-same-her-layer3-writeback.md §2.6「睡觉」）：
// 给了 desktop 就把他在电脑上和她的回合并进他那一份——半夜被叫上电脑和 QQ 上被吵醒一样算，第二天困到几点照旧推；
// byDuration 时陪得比 45 分钟久的按实际时长扣。用户 11-22：电脑上被叫起来也有一样的起床气（her-now 的 desktopCalled）。
// 她上面那三条条件照旧：这里只多一句事实（几点被叫上电脑、陪到几点），不写该怎么说。

import type { StoredMessage } from '../memory/history.ts';
import { nightOf, saidBedtimes } from './bedtime.ts';
import type { BodyNow } from './body.ts';
import { sessionsFromTurns, TURN_LEAD_MS, type PresenceTurn } from './desktop-presence.ts';
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
    /**
     * 半夜被吵醒的时刻、是不是他；desktop：吵醒她的是他在电脑上叫她（只在给了桌面回合时有）——陪到几点，stayedUp 是作息上该睡了还在电脑上陪着（不是睡下以后被叫起来）
     */
    woken?: { at: number; byHim: boolean; desktop?: { until: number; stayedUp?: true } };
    /** 睡前在跟他聊 */
    withHim: boolean;
    /** 睡了几个小时（被吵醒扣过） */
    hours: number;
}

/** 桌面上的一轮（memory/desktop-log.ts 的 desktopTurns 给的就是这个形状的超集；毫秒） */
export interface NightDesktopTurn extends PresenceTurn {
    at: number;
    userAt?: number;
    user: string;
    assistant: string;
}

/**
 * 桌面上的回合（ADR 0347 第 3 层，开关 desktopConflict，方案 §2.6「睡觉」那一行）：
 * 半夜被他叫上电脑和 QQ 上被他吵醒一样算——她在电脑上的回答当作她发给他的消息（说「睡了」、被吵醒、睡前跟他聊到那会儿都算上）。
 */
export interface NightDesktop {
    turns: readonly NightDesktopTurn[];
    /** 被叫上电脑陪得比 WOKEN_COST_MS 久时，按在电脑上的实际时长扣睡眠（不再固定 45 分钟） */
    byDuration?: boolean;
}

/**
 * 她今天这一天之前的那一晚。now 还没到今早起床就没有（还在夜里）。
 * histories：名单里每个人和她的聊天（他在 himQq 那一份里）；desktop：他在电脑上和她的回合（不给就只看 QQ，和原来逐字一样）
 */
export function lastNight(histories: readonly { qq: number; messages: readonly StoredMessage[] }[], himQq: number, schedule: Schedule, now: Date, desktop?: NightDesktop): LastNight | undefined {
    const day = herDay(schedule, now);
    const woke = wakeTime(schedule, day, classesOn(schedule, day).lessons).getTime();
    if (now.getTime() < woke) return undefined;
    const night = nightOf(schedule, new Date(woke - 60_000));
    if (!night) return undefined;
    // 桌面上的回合并进他那一份（按时间排好；saidBedtimes 从后往前读、要求有序）：只取这一晚前后的，免得每轮都排整份聊天记录
    const fromDesktop = new Set<StoredMessage>();
    const windowFrom = night.from.getTime() - HOUR - WITH_HIM_MS;
    for (const turn of desktop?.turns ?? []) {
        if (!Number.isFinite(turn.at) || turn.at < windowFrom || turn.at >= woke) continue;
        const user: StoredMessage = { time: new Date(turnStart(turn)).toISOString(), role: 'user', content: turn.user };
        const assistant: StoredMessage = { time: new Date(turn.at).toISOString(), role: 'assistant', content: turn.assistant };
        fromDesktop.add(user).add(assistant);
    }
    const merged = fromDesktop.size
        ? [
            ...histories.map(h => (h.qq === himQq ? { qq: h.qq, messages: withDesktop(h.messages, fromDesktop) } : h)),
            ...(histories.some(h => h.qq === himQq) ? [] : [{ qq: himQq, messages: withDesktop([], fromDesktop) }]),
        ]
        : histories;
    const said = saidBedtimes(merged.map(h => h.messages), schedule, night.from.getTime() - HOUR)
        .find(time => time >= night.from.getTime() && time < woke);
    const slept = said ?? night.bed.getTime();
    let woken: LastNight['woken'];
    let wokenOnDesktop = false;
    for (const { qq, messages } of merged) {
        for (const message of messages) {
            const at = Date.parse(message.time);
            if (message.role !== 'assistant' || at <= slept + WOKEN_AFTER_MS || at >= woke) continue;
            if (!woken || at < woken.at) {
                woken = { at, byHim: qq === himQq };
                wokenOnDesktop = fromDesktop.has(message);
            }
        }
    }
    const his = merged.find(h => h.qq === himQq)?.messages ?? [];
    const withHim = said !== undefined && his.some(message => {
        const at = Date.parse(message.time);
        return at >= said - WITH_HIM_MS && at <= said;
    });
    // 被叫上电脑的那几段（睡下以后、起床之前的部分）：哪一段吵醒了她、陪到几点；长的按实际时长扣
    const awake = woken && fromDesktop.size ? desktopAwake(desktop!.turns, windowFrom, slept, woke) : [];
    const waking = wokenOnDesktop ? awake.find(span => span.end >= woken!.at && span.start <= woken!.at) : undefined;
    if (woken && waking) woken = { ...woken, desktop: { until: waking.end, ...(waking.before ? { stayedUp: true as const } : {}) } };
    const onDesktop = awake.reduce((sum, span) => sum + (span.end - span.start), 0);
    const cost = !woken ? 0 : desktop?.byDuration ? Math.max(WOKEN_COST_MS, onDesktop) : WOKEN_COST_MS;
    const hours = (woke - slept - cost) / HOUR;
    return { slept, woke, said: said !== undefined, ...(woken ? { woken } : {}), withHim, hours: Math.round(hours * 10) / 10 };
}

/** 他这一份聊天记录插进桌面上的回合，按时间排（同一时刻 QQ 的在前） */
function withDesktop(messages: readonly StoredMessage[], desktop: ReadonlySet<StoredMessage>): StoredMessage[] {
    return [...messages, ...desktop].map((message, index) => ({ message, index, at: Date.parse(message.time) }))
        .sort((a, b) => a.at - b.at || a.index - b.index).map(item => item.message);
}

/**
 * 睡下以后在电脑上陪他的那几段（只算真把她叫起来的：睡下 WOKEN_AFTER_MS 以后她还回过话），截到睡下和起床之间。
 * before：这一段在睡下之前就开始了（作息上该睡了还在电脑上陪他）
 */
function desktopAwake(turns: readonly NightDesktopTurn[], from: number, slept: number, woke: number): { start: number; end: number; before: boolean }[] {
    return sessionsFromTurns(turns.filter(turn => Number.isFinite(turn.at) && turn.at >= from && turn.at < woke))
        .filter(session => session.turns.some(turn => turn.at > slept + WOKEN_AFTER_MS))
        .map(session => ({ start: Math.max(session.start, slept), end: Math.min(session.end, woke), before: session.start < slept }))
        .filter(span => span.end > span.start);
}

const turnStart = (turn: PresenceTurn) =>
    turn.userAt !== undefined && Number.isFinite(turn.userAt) ? Math.min(turn.userAt, turn.at) : turn.at - TURN_LEAD_MS;

const clock = (ms: number) => { const d = new Date(ms); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

/** 这一晚让她今天困到几点（不困返回 undefined）：睡不够 SLEEPY_HOURS 困到中午；不够 HARD_HOURS 困到下午三点 */
export function sleepyUntil(night: LastNight, day: Date): number | undefined {
    if (night.hours >= SLEEPY_HOURS) return undefined;
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), night.hours < HARD_HOURS ? 15 : 12).getTime();
}

/** 身体那一行里「昨晚」那一段（只有事实）：几点睡的、跟他聊到那会儿、半夜被谁吵醒、几点起、困不困 */
export function describeNight(night: LastNight): string {
    const slept = `昨晚 ${clock(night.slept)} 睡${night.withHim ? '（跟他聊到那会儿）' : ''}`;
    const woken = night.woken?.desktop
        ? (night.woken.desktop.stayedUp ? `、在电脑上陪他到 ${clock(night.woken.desktop.until)}` : `、半夜 ${clock(night.woken.at)} 被他叫上电脑、陪到 ${clock(night.woken.desktop.until)}`)
        : night.woken ? `、半夜 ${clock(night.woken.at)} 被${night.woken.byHim ? '他' : ''}消息吵醒过一次` : '';
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
