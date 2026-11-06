// 她一天的打算会改（ADR 0034）：作息里按「日期 + 时段」挑的空闲活动，是她早上起来对这一段的大致打算；到时候按那天的事实结算——
// 下雨、感冒、身上不舒服就不出门（world.yml plans.outings 换成 indoors），肚子疼得厉害就躺着（rest），
// 作业明天要交、晚上打算的又不是写作业就先赶作业（写完回到原来的打算）。结算结果是「照打算做了」或「本来打算 X，因为 Y，改成 Z」。
// - 规则驱动、按日期可重放，不调模型、不存状态；不写进生活事件账（ADR 0029）：能从日期和世界推出来，不另立事实源。
// - 进提示词的只有事实：状态行、「你今天的打算」、问到那天时（ADR 0032）、日记（ADR 0026）。

import { localDate } from '../local-date.ts';
import type { BodyNow } from './body.ts';
import { herDay, stateAt, type ExtraFreeActivity, type Schedule } from './schedule.ts';
import type { DayAirQuality } from '../world/air-quality.ts';
import type { Daylight } from '../world/daylight.ts';

export type FreeWindow = 'morning' | 'afternoon' | 'evening';

/** 卡上的 world.plans */
export interface Plans {
    outings: { text: string; indoors: string }[];
    study: string[];
    rest: string;
}

/** 结算要看的事实：天气、空气、日照、身上怎么样（按那天 15:00 算）、三天内要交的作业（world.ts 的 WorldNow.homework） */
export interface PlanFacts {
    rain?: boolean;
    /** 真实天气下过雨的钟头（ADR 0048）：有就按那个时段里下没下，不按一整天 */
    rainHours?: readonly number[];
    /** 真实空气质量（ADR 0233）：只有重度以上污染才把室外打算换成室内；没取到就不猜。 */
    airQuality?: Pick<DayAirQuality, 'aqi' | 'category'>;
    /** 真实日照（ADR 0233）：保留给行动策略，普通晚间计划不因天黑被擅自取消。 */
    daylight?: Pick<Daylight, 'phase'>;
    body?: BodyNow;
    homework?: readonly { course: string; due: Date; doneAt: Date }[];
    /** 世界里定好了几点去做的事（world.ts 的 worldErrands，买相机那一趟）：那一段就写这件事，不写作息里的空闲活动（10-11 模拟：打算写「下午在图书馆赶作业」，她照着说了） */
    errands?: readonly { start: Date; text: string }[];
    /** 约好的事（闺蜜的约，ADR 0061，world.ts 的 planDates）：不替换那一段的打算，写在后面（「晚上研究新相机的设置；20:30 和闺蜜微信视频」） */
    dates?: readonly { start: Date; text: string }[];
}

/** 一个时段：打算的、实际的（没改就和打算的一样）、为什么改；until：作业压着改的，写完就回到原来的打算 */
export interface PlanSlot {
    window: FreeWindow;
    planned: string;
    done: string;
    because?: string;
    until?: Date;
    /** 这一段里约好的事（闺蜜的约），接在打算后面说 */
    extra?: string;
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
        const datesText = (facts.dates ?? []).filter(d => d.start >= from && d.start < to).map(d => `${clock(d.start)} ${d.text}`).join('；');
        const errand = facts.errands?.find(e => e.start >= from && e.start < to);
        if (errand) {
            const text = `${clock(errand.start)} ${errand.text}`;
            slots.push({ window, planned: text, done: text, ...(datesText ? { extra: datesText } : {}) });
            continue;
        }
        if (planned === undefined) continue;
        slots.push({ window, planned, ...settle(plans, window, planned, day, from, to, facts), ...(datesText ? { extra: datesText } : {}) });
    }
    return slots;
}

/** 此刻那一段（她醒着、有空时）：改了的话「本来打算 X，Y，Z」；作业写完以后回到原来的打算 */
export function planNow(schedule: Schedule, slots: readonly PlanSlot[], now: Date): string | undefined {
    const slot = revisedSlot(schedule, slots, now);
    return slot ? `本来打算${slot.planned}，${slot.because}，${slot.done}` : undefined;
}

/** 此刻那一段改了的打算（没改、作业写完回到原来的打算了就没有） */
export function revisedSlot(schedule: Schedule, slots: readonly PlanSlot[], now: Date): PlanSlot | undefined {
    const day = herDay(schedule, now);
    const window = windowsOf(schedule, day).find(([, from, to]) => from <= now && now < to)?.[0];
    const slot = slots.find(s => s.window === window);
    if (!slot || slot.done === slot.planned) return undefined;
    if (slot.until && now >= slot.until) return undefined;
    return slot;
}

/** 一段的说法：改了的「下午本来打算去图书馆占座，下雨了，在宿舍写作业」，没改的「晚上在追一部剧」 */
export function describeSlot(slot: PlanSlot): string {
    const name = WINDOW_NAMES[slot.window];
    // 定了钟点的事（「14:00 去…」）前面空一格
    const gap = /^[0-9]/.test(slot.planned) ? ' ' : '';
    const plan = slot.done === slot.planned ? `${name}${gap}${slot.planned}` : `${name}本来打算${slot.planned}，${slot.because}，${slot.done}`;
    return slot.extra ? `${plan}；${slot.extra}` : plan;
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
function settle(plans: Plans | undefined, window: FreeWindow, planned: string, day: Date, from: Date, to: Date, facts: PlanFacts): Omit<PlanSlot, 'window' | 'planned'> {
    if (!plans) return { done: planned };
    const period = facts.body?.period;
    const unwellWord = period?.detail ? '肚子疼' : '身上不太舒服';
    if (period?.cramps === 'bad' && planned !== plans.rest) return { done: plans.rest, because: period.detail ? '肚子疼得厉害' : '身上不太舒服' };
    const outing = plans.outings.find(o => o.text === planned);
    // 真实天气（ADR 0048）：那个时段里（从开始前一个钟头起）下过才改；下午才下的雨不改上午的打算，还没到的时段不知道
    // 钟头从那天零点算：晚上那段到第二天凌晨 2 点，按 to.getHours() 算会只剩一两个钟头（审查第 3 条）
    const dayStart = localDate(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const fromHour = Math.floor((from.getTime() - dayStart) / 3_600_000);
    const endHour = Math.min(24, Math.ceil((to.getTime() - dayStart) / 3_600_000));
    const rained = facts.rainHours ? facts.rainHours.some(h => h >= fromHour - 1 && h < Math.max(endHour, fromHour + 1)) : facts.rain;
    if (outing && rained) return { done: outing.indoors, because: '下雨了' };
    // 现实空气质量只在重度以上污染时影响出门；优/良/轻度污染不替她做过度谨慎的决定，取不到也保持原计划。
    if (outing && facts.airQuality?.aqi !== undefined && facts.airQuality.aqi >= 201) return { done: outing.indoors, because: '空气质量差，不想出门' };
    if (outing && facts.body?.cold) return { done: outing.indoors, because: '感冒了，不想出门' };
    if (outing && period?.cramps) return { done: outing.indoors, because: unwellWord };
    if (window === 'evening' && !plans.study.includes(planned)) {
        const tomorrow = localDate(day.getFullYear(), day.getMonth(), day.getDate() + 1);
        const due = (facts.homework ?? []).filter(h => sameDay(h.due, tomorrow) && h.doneAt > from).sort((a, b) => b.doneAt.getTime() - a.doneAt.getTime());
        if (due.length) {
            const courses = [...new Set(due.map(h => h.course).filter(Boolean))];
            return { done: '先赶作业', because: `${courses.length ? `${courses.join('、')}的` : ''}作业明天要交`, until: due[0]!.doneAt };
        }
    }
    return { done: planned };
}

function clock(at: Date): string {
    return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** 那天的三个时段：上午从起床（或睡醒那刻往后都行，stateAt 自己会判断睡觉）到 afternoonFrom，下午到 eveningFrom，晚上到第二天睡觉 */
function windowsOf(schedule: Schedule, day: Date): [FreeWindow, Date, Date][] {
    const at = (time: string, offset = 0) => {
        const [h, m] = time.split(':').map(Number);
        return localDate(day.getFullYear(), day.getMonth(), day.getDate() + offset, h, m);
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
