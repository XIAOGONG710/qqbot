// 她一天的打算会改（ADR 0034）：作息里按「日期 + 时段」挑的空闲活动，是她早上起来对这一段的大致打算；到时候按那天的事实结算——
// 下雨、感冒、身上不舒服就不出门（world.yml plans.outings 换成 indoors），肚子疼得厉害就躺着（rest），
// 作业明天要交、晚上打算的又不是写作业就先赶作业（写完回到原来的打算）。结算结果是「照打算做了」或「本来打算 X，因为 Y，改成 Z」。
// - 规则驱动、按日期可重放，不调模型、不存状态；不写进生活事件账（ADR 0029）：能从日期和世界推出来，不另立事实源。
// - 进提示词的只有事实：状态行、「你今天的打算」、问到那天时（ADR 0032）、日记（ADR 0026）。

import type { BodyNow } from './body.ts';
import { herDay, stateAt, type ExtraFreeActivity, type Schedule } from './schedule.ts';

export type FreeWindow = 'morning' | 'afternoon' | 'evening';

/** 卡上的 world.plans */
export interface Plans {
    outings: { text: string; indoors: string }[];
    study: string[];
    rest: string;
}

/** 结算要看的事实：那天下没下雨、身上怎么样（按那天 15:00 算）、三天内要交的作业（world.ts 的 WorldNow.homework） */
export interface PlanFacts {
    rain?: boolean;
    body?: BodyNow;
    homework?: readonly { course: string; due: Date; doneAt: Date }[];
}

/** 一个时段：打算的、实际的（没改就和打算的一样）、为什么改；until：作业压着改的，写完就回到原来的打算 */
export interface PlanSlot {
    window: FreeWindow;
    planned: string;
    done: string;
    because?: string;
    until?: Date;
}

const WINDOW_NAMES: Record<FreeWindow, string> = { morning: '上午', afternoon: '下午', evening: '晚上' };
/** 找时段里有没有空的时候：每隔这么久看一眼状态 */
const SAMPLE_MS = 20 * 60_000;

/** 她这一天有空的几段各打算干什么、结算成什么；整段都在上课、睡觉的时段没有 */
export function dayPlan(schedule: Schedule, plans: Plans | undefined, day: Date, facts: PlanFacts, extra: readonly ExtraFreeActivity[] = []): PlanSlot[] {
    const slots: PlanSlot[] = [];
    for (const [window, from, to] of windowsOf(schedule, day)) {
        let planned: string | undefined;
        for (let t = from.getTime(); t < to.getTime() && planned === undefined; t += SAMPLE_MS) {
            const activity = stateAt(schedule, new Date(t), extra).activity;
            if (activity.kind === 'free' && activity.text) planned = activity.text;
        }
        if (planned === undefined) continue;
        slots.push({ window, planned, ...settle(plans, window, planned, day, from, facts) });
    }
    return slots;
}

/** 此刻那一段（她醒着、有空时）：改了的话「本来打算 X，Y，Z」；作业写完以后回到原来的打算 */
export function planNow(schedule: Schedule, slots: readonly PlanSlot[], now: Date): string | undefined {
    const day = herDay(schedule, now);
    const window = windowsOf(schedule, day).find(([, from, to]) => from <= now && now < to)?.[0];
    const slot = slots.find(s => s.window === window);
    if (!slot || slot.done === slot.planned) return undefined;
    if (slot.until && now >= slot.until) return undefined;
    return `本来打算${slot.planned}，${slot.because}，${slot.done}`;
}

/** 一段的说法：改了的「下午本来打算去图书馆占座，下雨了，在宿舍写作业」，没改的「晚上在追一部剧」 */
export function describeSlot(slot: PlanSlot): string {
    const name = WINDOW_NAMES[slot.window];
    return slot.done === slot.planned ? `${name}${slot.planned}` : `${name}本来打算${slot.planned}，${slot.because}，${slot.done}`;
}

/**
 * 时间块里的一行：她今天的打算（醒着的时候才有）。过去了的时段只写改了的——照打算做完的天天差不多，排成一列她就照着报（调整 4）；
 * 现在和之后的照写（打算本来就是往前看的）
 */
export function describePlans(schedule: Schedule, slots: readonly PlanSlot[], now: Date): string | undefined {
    const day = herDay(schedule, now);
    const ended = new Set(windowsOf(schedule, day).filter(([, , to]) => to <= now).map(([window]) => window));
    const shown = slots.filter(slot => !ended.has(slot.window) || slot.done !== slot.planned);
    if (!shown.length) return undefined;
    // 和人聊天时说过实际干了别的（下午去看了电影），以说过的为准：说出口的才是她过的（ADR 0027 的原则）
    return `[你今天的打算（早上起来想的；改了的写了怎么改的，他问起照这个说，不用特意提；跟谁说过实际干了别的，以说过的为准）：${shown.map(describeSlot).join('；')}]`;
}

/** 照打算做，还是改：肚子疼得厉害 > 不出门（下雨、感冒、不舒服）> 作业明天要交（晚上） */
function settle(plans: Plans | undefined, window: FreeWindow, planned: string, day: Date, from: Date, facts: PlanFacts): Omit<PlanSlot, 'window' | 'planned'> {
    if (!plans) return { done: planned };
    const period = facts.body?.period;
    const unwellWord = period?.detail ? '肚子疼' : '身上不太舒服';
    if (period?.cramps === 'bad' && planned !== plans.rest) return { done: plans.rest, because: period.detail ? '肚子疼得厉害' : '身上不太舒服' };
    const outing = plans.outings.find(o => o.text === planned);
    if (outing && facts.rain) return { done: outing.indoors, because: '下雨了' };
    if (outing && facts.body?.cold) return { done: outing.indoors, because: '感冒了，不想出门' };
    if (outing && period?.cramps) return { done: outing.indoors, because: unwellWord };
    if (window === 'evening' && !plans.study.includes(planned)) {
        const tomorrow = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        const due = (facts.homework ?? []).filter(h => sameDay(h.due, tomorrow) && h.doneAt > from).sort((a, b) => b.doneAt.getTime() - a.doneAt.getTime());
        if (due.length) {
            const courses = [...new Set(due.map(h => h.course).filter(Boolean))];
            return { done: '先赶作业', because: `${courses.length ? `${courses.join('、')}的` : ''}作业明天要交`, until: due[0]!.doneAt };
        }
    }
    return { done: planned };
}

/** 那天的三个时段：上午从起床（或睡醒那刻往后都行，stateAt 自己会判断睡觉）到 afternoonFrom，下午到 eveningFrom，晚上到第二天睡觉 */
function windowsOf(schedule: Schedule, day: Date): [FreeWindow, Date, Date][] {
    const at = (time: string, offset = 0) => {
        const [h, m] = time.split(':').map(Number);
        return new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, h, m);
    };
    return [
        ['morning', at('05:00'), at(schedule.free.afternoonFrom)],
        ['afternoon', at(schedule.free.afternoonFrom), at(schedule.free.eveningFrom)],
        ['evening', at(schedule.free.eveningFrom), at(schedule.sleep, 1)],
    ];
}

function sameDay(a: Date, b: Date): boolean {
    return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
