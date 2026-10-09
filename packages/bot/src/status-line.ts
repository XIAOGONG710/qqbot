// 状态行（时间块里「你现在」那一行）此刻在做什么，按规则推（ADR 0007、0030、0031、0034、0042）。
// contact.ts 拼提示词和模拟器的状态行影子比对使用同一个函数，避免对外状态和生活事件账各算一套。

import type { BodyNow } from './body.ts';
import { dayPlan, planNow, revisedSlot, type PlanSlot, type Plans } from './day-plan.ts';
import { herDay, stateAt, type ExtraFreeActivity, type Schedule, type State } from './schedule.ts';
import { occupationAt, type WorldNow } from './world.ts';

export interface StatusOptions {
    /** 看书的空闲活动（ADR 0015，readingActivities）。 */
    extraFree?: readonly ExtraFreeActivity[];
    /** 这一刻的世界（这一档的卡、带聊天里说过的事）。 */
    world?: WorldNow;
    /** 她说过「睡了」（ADR 0042）：睡到 until。 */
    asleep?: { since: Date; until: Date };
    /** 约好的见面（ADR 0047）：赴约或快出门时那一句，空闲时覆盖世界里的事和打算。 */
    appointment?: string;
    /** 一天的打算（ADR 0034）；不传就没有「本来打算……」。 */
    plans?: { plans: Plans | undefined; body?: BodyNow };
}

export interface HerStatus {
    state: State;
    saidAsleep?: { since: Date; until: Date };
    /** 世界里有时长的事替换了空闲活动。 */
    busy?: string;
    /** 一天的打算改了。 */
    revised?: string;
    /** 空闲又没有世界里的事时实际在做的那件。 */
    doing?: string;
    slots: PlanSlot[];
}

export function herStatus(schedule: Schedule, at: Date, options: StatusOptions = {}): HerStatus {
    let state = stateAt(schedule, at, options.extraFree ?? []);
    const saidAsleep = state.activity.kind !== 'sleep' ? options.asleep : undefined;
    if (saidAsleep) state = { ...state, activity: { kind: 'sleep', until: saidAsleep.until } };

    // 约好的见面排在世界里的事前面（ADR 0047）：约了晚饭就不是「在食堂吃晚饭」；上课、睡觉不覆盖
    const busy = state.activity.kind === 'free'
        ? options.appointment ?? (options.world ? occupationAt(options.world, at) : undefined)
        : undefined;
    if (busy) state = { ...state, activity: { kind: 'free', text: busy } };

    const slots = options.plans && options.world && state.activity.kind !== 'sleep'
        ? dayPlan(schedule, options.plans.plans, herDay(schedule, at), {
            rain: options.world.weather?.rain,
            body: options.plans.body,
            homework: options.world.homework,
        }, options.extraFree ?? [])
        : [];
    const slot = state.activity.kind === 'free' && !busy && options.plans ? revisedSlot(schedule, slots, at) : undefined;
    const revised = slot ? planNow(schedule, slots, at) : undefined;
    const doing = state.activity.kind === 'free' && !busy ? slot?.done ?? state.activity.text : undefined;
    if (revised) state = { ...state, activity: { kind: 'free', text: revised } };

    return {
        state,
        slots,
        ...(saidAsleep ? { saidAsleep } : {}),
        ...(busy ? { busy } : {}),
        ...(revised ? { revised } : {}),
        ...(doing !== undefined ? { doing } : {}),
    };
}
