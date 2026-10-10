// 规则自主选择器 v1（ADR 0040）：没人聊天时她也一件件地过日子。
// 在每个时间边界（上一件事结束、到了饭点、下课……）看她此刻该做什么，变成类型化行动交给裁判（ADR 0037）排进队列（ADR 0038），过完才落进事件账。
// 判断和状态行（contact.ts）用同一套规则：作息和课表（schedule.ts）、饭点和洗澡（ADR 0031）、世界里有时长的事（ADR 0030）、一天的打算（ADR 0034）。
// 过完的日子落进事件账就不再变（相机基金 2300 → 2750 那次：按规则从开学推到现在，改了规则就把过去也改了）。
// 不调模型、不掷随机数：同一份事件账和同一个时刻推出来的一样，重启不重复（行动 id 由开始时刻和种类定）。
// 聊天里说过的事改写还没过的（ADR 0042）：她说「睡了」、说喂过猫、取了快递、写完作业、和家里视频过了，排着的那件停在那一刻，之后按新的世界接着排；
// 已经落账的不改。

import { homeworkSprints, type ActionAppointment, type ActionContext, type ActionIntent, type TypedActionKind } from './actions.ts';
import type { ActionQueue, QueuedAction } from './action-queue.ts';
import { asleepSince } from './bedtime.ts';
import type { BodyNow } from './body.ts';
import { dayPlan, type Plans } from './day-plan.ts';
import type { ReadingBook } from './her-days.ts';
import { bookProgressAt, readingActivities } from './her-days.ts';
import type { LifeEvent } from './life-events.ts';
import { needsAt, type NeedsSnapshot } from './needs.ts';
import { MEET_LEAD_MINUTES, type Appointment } from './promises.ts';
import { projectActivity } from './projects.ts';
import { formatDate, herDay, stateAt, type ExtraFreeActivity, type Schedule } from './schedule.ts';
import { OCCUPATION_MINUTES, type WorldNow } from './world.ts';

export interface LifeSources {
    schedule: Schedule;
    plans?: Plans;
    books: readonly ReadingBook[];
    /** 那一刻的世界：带上聊天里说过做了的事（WorldState.at）；卡上没有世界时返回 undefined */
    worldAt: (at: Date) => WorldNow | undefined;
    /** 已经落账的事（事件账） */
    events: () => readonly LifeEvent[];
    /** 那一刻她身上怎么样（ADR 0025）：一天的打算按它改（肚子疼躺着、感冒不出门），和 contact.ts 一样 */
    bodyAt?: (at: Date) => BodyNow | undefined;
    /** 她在聊天里说「睡了」的时刻（ADR 0042，bedtime.ts 的 saidBedtimes，对谁说的都算）：从那一刻起在睡，到那一晚该起的时候 */
    bedtimes?: () => readonly number[];
    /** 约定存储里的见面；时间范围包含出门前 15 分钟到见完。 */
    appointmentsBetween?: (from: Date, to: Date) => readonly Appointment[];
    /**
     * 连续需要的版本化起点（ADR 0045）。没有锚点时完全沿用旧选择器；有锚点时只调整空闲行动，
     * 上课、饭点、明确约定和截止时间仍按原来的硬规则优先。
     */
    needsAnchor?: NeedsSnapshot;
}

/** 这一刻：要排的行动，或者跳到哪（赶去上课、洗澡、喂猫这类不记成行动的，和短得排不下的空当） */
export type Choice = { intent: ActionIntent; why: string } | { skipTo: Date; why: string };

/** 行动 id：开始时刻 + 种类，同一刻同一件事重放、重启都是同一个 id */
export const lifeActionId = (at: Date, kind: TypedActionKind) => `life:${at.toISOString()}:${kind}`;

/** 约好的事里说了吃的 */
const FOOD = /吃|饭|餐|火锅|烧烤|麻辣烫|烤肉|夜宵|撸串/;
/** 没说吃的、但盖住了一顿饭的大半（重叠这么多分钟以上）也算一起吃了；只擦到饭点边的不算（审查 P1-2：「下午一点图书馆集合」） */
const MEAL_OVERLAP_MINUTES = 30;

/** 这次见面算不算在外面一起吃了一顿 */
function mealDate(sources: Pick<LifeSources, 'worldAt'>, appointment: Appointment): boolean {
    if (FOOD.test(appointment.promise.what)) return true;
    const meals = sources.worldAt(appointment.start)?.routine?.meals ?? [];
    return meals.some(meal => Math.min(meal.end.getTime(), appointment.end.getTime()) - Math.max(meal.start.getTime(), appointment.start.getTime())
        >= MEAL_OVERLAP_MINUTES * 60_000);
}

/** 一次约定对应一个稳定行动；联系人自己的 promise id 只在该联系人内唯一，所以把 QQ 一起放进幂等键。 */
function appointmentActions(sources: LifeSources, from: Date, to: Date): ActionAppointment[] {
    const saidBedtimes = sources.bedtimes?.() ?? [];
    return (sources.appointmentsBetween?.(from, to) ?? []).flatMap(appointment => {
        const lead = new Date(appointment.start.getTime() - MEET_LEAD_MINUTES * 60_000);
        const meal = mealDate(sources, appointment);
        const segments: { start: Date; end: Date }[] = [];
        let segmentStart: Date | undefined;
        for (let time = lead.getTime(); time < appointment.end.getTime(); time += 60_000) {
            const at = new Date(time);
            const free = !asleepSince(sources.schedule, saidBedtimes, at) && stateAt(sources.schedule, at).activity.kind === 'free';
            if (free && !segmentStart) segmentStart = at;
            if (!free && segmentStart) {
                segments.push({ start: segmentStart, end: at });
                segmentStart = undefined;
            }
        }
        if (segmentStart) segments.push({ start: segmentStart, end: appointment.end });
        return segments.filter(segment => segment.start < to && segment.end > from).map(segment => ({
            id: `${lifeActionId(segment.start, 'meet')}:${appointment.contact.qq}:${appointment.promise.id}`,
            ...segment,
            subject: appointment.promise.what,
            target: `contact:${appointment.contact.qq}`,
            // 只有真正走到约定结束的最后一段才算把这顿饭吃完；被课或睡觉截断的前段不结算饱腹。
            meal: meal && segment.end.getTime() === appointment.end.getTime(),
        }));
    }).sort((a, b) => a.start.getTime() - b.start.getTime() || a.id.localeCompare(b.id));
}

/** 那一天快结束时的确定性世界；和 dayBusy 共用，才能看见稍后会发生、需要预留时间的事。 */
function dayWorld(sources: Pick<LifeSources, 'schedule' | 'worldAt'>, at: Date): WorldNow | undefined {
    return sources.worldAt(new Date(windowEnd(sources.schedule, herDayEvening(sources.schedule, at)).getTime() - 60_000));
}

/** 世界里不记成行动、但占着时间的事（洗澡、喂猫、取快递往回走、和家里视频）：灵活的行动撞上就停，排的时候跳过 */
export function busySpans(now: WorldNow | undefined): { start: Date; end: Date; text: string }[] {
    if (!now) return [];
    const spans: { start: Date; end: Date; text: string }[] = [];
    const span = (start: Date, minutes: number, text: string) => spans.push({ start, end: new Date(start.getTime() + minutes * 60_000), text });
    if (now.routine?.shower) spans.push({ ...now.routine.shower, text: '洗澡' });
    if (now.cat && 'fed' in now.cat.today) span(now.cat.today.fed, OCCUPATION_MINUTES.feed, `下楼喂${now.cat.name}`);
    for (const parcel of now.parcels.filter(p => p.status === 'picked_today')) span(parcel.when, OCCUPATION_MINUTES.parcel, `取快递（${parcel.item}）`);
    if (now.familyCall?.done) span(now.familyCall.at, OCCUPATION_MINUTES.call, '和家里视频');
    // 去买相机那一趟（用户 10-10「这周末去买」）：只在那一天
    const camera = now.cameraFund?.camera;
    if (camera && formatDate(camera.start) === now.day) spans.push({ start: camera.start, end: camera.end, text: `去${camera.where}买相机` });
    return spans.sort((a, b) => a.start.getTime() - b.start.getTime());
}

/**
 * 那一天世界里不记成行动的事：按她这一天快结束时（第二天入睡前一分钟）的世界取——喂猫、取快递在发生之前，那一刻的世界里还只有「打算几点去」，
 * 排一长段追剧时要知道 20:10 得下楼
 */
export function dayBusy(sources: Pick<LifeSources, 'schedule' | 'worldAt'>, at: Date): { start: Date; end: Date; text: string }[] {
    return busySpans(dayWorld(sources, at));
}

const MEAL_SOCIAL = new Set(['lunch_with_friend', 'spicy_noodles']);
const CLASS_SOCIAL = new Set(['notes_for_friend']);

/** 世界里已有的 NPC 事实进入类型化行动：一起吃饭 / 帮拍板书附在那件硬行动上，微信来往单独占一小段时间。 */
function npcFacts(sources: Pick<LifeSources, 'schedule' | 'worldAt'>, at: Date) {
    return (dayWorld(sources, at)?.events ?? []).filter(event => event.person);
}

function targetForMeal(sources: Pick<LifeSources, 'schedule' | 'worldAt'>, at: Date): string | undefined {
    return npcFacts(sources, at).find(event => MEAL_SOCIAL.has(event.id))?.person?.id;
}

function targetForClass(sources: Pick<LifeSources, 'schedule' | 'worldAt'>, at: Date, end: Date): string | undefined {
    return npcFacts(sources, at).find(event => CLASS_SOCIAL.has(event.id) && event.at >= at && event.at < end)?.person?.id;
}

function directNpcFacts(sources: Pick<LifeSources, 'schedule' | 'worldAt'>, at: Date) {
    return npcFacts(sources, at).filter(event => !MEAL_SOCIAL.has(event.id) && !CLASS_SOCIAL.has(event.id));
}

/** 她这一天晚上那一段里的某一刻（windowEnd 取到的就是第二天入睡） */
function herDayEvening(schedule: Schedule, at: Date): Date {
    const day = herDay(schedule, at);
    const [h, m] = schedule.free.eveningFrom.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
}

/** 那一天要赶的作业：写完之前那一段在赶（ADR 0030 的 OCCUPATION_MINUTES.homework） */
function homeworkSprint(now: WorldNow | undefined, at: Date): { start: Date; end: Date; course: string } | undefined {
    return homeworkSprints(now).find(h => at >= h.start && at < h.end);
}

/** 空闲时段做的事归哪一类：在读的书 → 读书；作业 → 学习；躺着 → 休息；别的（追剧、打游戏、修片子……）→ 休闲 */
export function freeKind(text: string, sources: Pick<LifeSources, 'plans' | 'books'>, reading: readonly ExtraFreeActivity[]):
    { kind: TypedActionKind; subject: string; target?: string } {
    const book = sources.books.find(b => b.activity && reading.some(r => r.text === text) && b.activity.text === text);
    if (book) return { kind: 'read_book', subject: book.id };
    if (sources.plans?.study.includes(text) || /作业|复习|学习|预习/.test(text)) return { kind: 'study', subject: text };
    if (sources.plans?.rest === text || /^(?:躺|休息|睡)/.test(text)) return { kind: 'rest', subject: text };
    const project = projectActivity(text);
    if (project) return { kind: 'work_on_project', subject: project.step, target: project.id };
    return { kind: 'leisure', subject: text };
}

/** 那一天三个时段的边界（和 day-plan.ts 的 windowsOf 一样）：灵活的事最多做到这一段结束 */
function windowEnd(schedule: Schedule, at: Date): Date {
    const day = herDay(schedule, at);
    const time = (hhmm: string, offset = 0) => {
        const [h, m] = hhmm.split(':').map(Number);
        return new Date(day.getFullYear(), day.getMonth(), day.getDate() + offset, h, m);
    };
    return [time(schedule.free.afternoonFrom), time(schedule.free.eveningFrom), time(schedule.sleep, 1)].find(end => end > at)!;
}

const minutesBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 60_000);
/** 灵活的事最短排多久（短于这个的空当不记，算在路上、发呆） */
const MIN_FREE_MINUTES = 10;
/** 出门前赶着吃一顿最少要这么多分钟，不够就不吃了 */
const MIN_MEAL_MINUTES = 15;

/** 这一刻她该做什么（ADR 0040）：先看作息（睡觉、上课、赶去上课），再看饭点和世界里的事，最后看一天的打算 */
export function chooseAt(at: Date, sources: LifeSources): Choice {
    // 聊天里说了「睡了」（ADR 0042）：从那一刻起在睡，不等作息上的 02:00
    if (asleepSince(sources.schedule, sources.bedtimes?.() ?? [], at)) {
        return { intent: { id: lifeActionId(at, 'sleep'), kind: 'sleep', startedAt: at }, why: '说了睡了' };
    }
    const reading = readingActivities(sources.books);
    const state = stateAt(sources.schedule, at, reading);
    if (state.activity.kind === 'sleep') return { intent: { id: lifeActionId(at, 'sleep'), kind: 'sleep', startedAt: at }, why: '睡觉' };
    if (state.activity.kind === 'class') {
        const lesson = state.activity.lesson;
        const target = targetForClass(sources, lesson.start, lesson.end);
        return lesson.start.getTime() === at.getTime()
            ? { intent: { id: lifeActionId(at, 'attend_class'), kind: 'attend_class', startedAt: at, ...(target ? { target } : {}) }, why: `上${lesson.name ?? '课'}` }
            : { skipTo: lesson.end, why: '课上到一半' };
    }
    if (state.activity.kind === 'between') return { skipTo: state.activity.next.start, why: '赶去上课 / 课间' };

    // 明确约定只覆盖空闲生活，不覆盖睡觉和上课；出门前 15 分钟起就占用她的时间。
    const appointment = appointmentActions(sources, at, new Date(at.getTime() + 1))[0];
    if (appointment) {
        return appointment.start.getTime() === at.getTime()
            ? {
                intent: {
                    id: appointment.id, kind: 'meet', startedAt: appointment.start, subject: appointment.subject,
                    target: appointment.target, meal: appointment.meal,
                },
                why: appointment.meal ? `出去吃饭：${appointment.subject}` : `赴约：${appointment.subject}`,
            }
            : { skipTo: appointment.end, why: `正在赴约：${appointment.subject}` };
    }

    const world = sources.worldAt(at);
    const meal = world?.routine?.meals.find(m => at >= m.start && at < m.end);
    // 饭点里要出门赴约：约的是吃饭，这顿就等着出去吃；约的不是吃饭，出门前把饭吃完，不到 MIN_MEAL_MINUTES 来不及就不吃了
    const leaving = meal ? appointmentActions(sources, at, meal.end).find(item => item.start > at) : undefined;
    if (meal && leaving) {
        if (leaving.meal) return { skipTo: leaving.start, why: `等着出去吃（${leaving.subject}）` };
        if (meal.start.getTime() !== at.getTime() || minutesBetween(at, leaving.start) < MIN_MEAL_MINUTES) return { skipTo: leaving.start, why: '要出门了，来不及吃饭' };
        const target = meal.kind === 'lunch' ? targetForMeal(sources, at) : undefined;
        return {
            intent: { id: lifeActionId(at, 'eat'), kind: 'eat', startedAt: at, durationMinutes: minutesBetween(at, leaving.start), ...(target ? { target } : {}) },
            why: `出门前先把${meal.kind === 'lunch' ? '午饭' : '晚饭'}吃了`,
        };
    }
    // 见完面回来饭点已经开始了（没在外面吃）：这顿还没吃、还剩 MIN_MEAL_MINUTES 以上就接着吃
    const back = meal && meal.start < at && appointmentActions(sources, new Date(at.getTime() - 60_000), at).some(item => item.end.getTime() === at.getTime() && !item.meal);
    if (meal && back && minutesBetween(at, meal.end) >= MIN_MEAL_MINUTES) {
        return { intent: { id: lifeActionId(at, 'eat'), kind: 'eat', startedAt: at }, why: `见完回来吃${meal.kind === 'lunch' ? '午饭' : '晚饭'}` };
    }
    if (meal) {
        const target = meal.kind === 'lunch' ? targetForMeal(sources, at) : undefined;
        return meal.start.getTime() === at.getTime()
            ? { intent: { id: lifeActionId(at, 'eat'), kind: 'eat', startedAt: at, ...(target ? { target } : {}) }, why: meal.kind === 'lunch' ? '和朋友吃午饭' : '晚饭' }
            : { skipTo: meal.end, why: '饭吃到一半' };
    }
    const blocks = dayBusy(sources, at);
    const busy = blocks.find(s => at >= s.start && at < s.end);
    if (busy) return { skipTo: busy.end, why: busy.text };

    const social = directNpcFacts(sources, at).find(event => event.at.getTime() === at.getTime());
    if (social?.person) {
        const subject = `在微信上跟${social.person.name}聊了会儿`;
        return {
            intent: { id: lifeActionId(at, 'interact_npc'), kind: 'interact_npc', startedAt: at, subject, target: social.person.id, durationMinutes: 15 },
            why: subject,
        };
    }

    const sprint = homeworkSprint(world, at);
    const plannedAction = sprint
        ? { kind: 'study' as const, subject: sprint.course ? `${sprint.course}的作业` : '作业' }
        : planned(at, sources, world, reading, state.activity.text);
    // 第一次上线时队列里可能还有锚点之前开始的旧行动；复核旧行动仍按旧规则，不能向锚点之前反推需要。
    const needs = sources.needsAnchor && at.getTime() >= Date.parse(sources.needsAnchor.at)
        ? needsAt(sources.needsAnchor, sources.events(), at)
        : undefined;
    const motivated = sprint ? { action: plannedAction, why: '赶作业' }
        : motivate(plannedAction, needs, sources.plans?.rest);
    const { kind, subject, target } = motivated.action;
    // 打算做到哪（自然地停）：这一段结束、下一顿饭、下一件世界里的事（吃饭去、下楼喂猫），赶作业的写完为止。
    // 下一节课、赶作业那一段是硬事件（ADR 0042）：不在这里截，交给裁判在那一刻打断（interrupted_by_class / _deadline），
    // 事件账里看得出「打游戏打到一半去上课了」；原来这里先截到下一节课，事件账里一次打断都没有，赶作业那一段也没截（10-26 刷手机 19:19–22:49 盖住了 20:00–21:30 在赶的作业）
    const nextMeal = world?.routine?.meals.find(m => m.start > at)?.start;
    const nextBusy = blocks.find(s => s.start > at)?.start;
    const nextSocial = directNpcFacts(sources, at).map(event => event.at).find(start => start > at);
    const nextAppointment = appointmentActions(sources, at, windowEnd(sources.schedule, at)).find(item => item.start > at)?.start;
    const soft = earliest([windowEnd(sources.schedule, at), nextMeal, nextBusy, nextSocial, nextAppointment, sprint?.end]);
    const nextSprint = DEADLINE_KINDS.has(kind) ? homeworkSprints(world).map(h => h.start).filter(start => start > at) : [];
    const hard = earliest([soft, state.nextClass?.start, ...nextSprint]);
    // 到硬事件之前短得做不成这一类（学习至少 25 分钟、休闲 10 分钟）的空当不记（算在路上、发呆），不交给裁判判 no_time
    const floor = Math.max(MIN_FREE_MINUTES, LIMITS[kind]?.[0] ?? 0);
    if (minutesBetween(at, hard) < floor) return { skipTo: hard > at ? hard : new Date(at.getTime() + 60_000), why: '空当太短' };
    return {
        intent: { id: lifeActionId(at, kind), kind, startedAt: at, subject, ...(target ? { target } : {}), durationMinutes: clampMinutes(kind, minutesBetween(at, soft)) },
        why: motivated.why ?? subject,
    };
}

/**
 * 宽阈值只改变可以改天再做的空闲行动。低精力先休息；压力很高时暂缓高负荷项目。
 * 饭点在 chooseAt 更前面已经无条件优先，因此很饿也不会被休息或项目盖住。
 */
export function motivate(
    action: { kind: TypedActionKind; subject: string; target?: string },
    needs: NeedsSnapshot | undefined,
    restSubject = '躺会儿',
): { action: { kind: TypedActionKind; subject: string; target?: string }; why?: string } {
    if (!needs) return { action };
    if (needs.energy <= 25 && action.kind !== 'rest') {
        return { action: { kind: 'rest', subject: restSubject }, why: `精力低（${needs.energy}）` };
    }
    if (needs.stress >= 75 && action.kind === 'work_on_project') {
        return { action: { kind: 'rest', subject: restSubject }, why: `压力高（${needs.stress}），项目先缓一缓` };
    }
    return { action };
}

/** 赶作业抢得走的（和 actions.ts 一样）：休闲、躺着、看闲书 */
const DEADLINE_KINDS = new Set<TypedActionKind>(['leisure', 'rest', 'read_book', 'work_on_project']);
const earliest = (dates: readonly (Date | undefined)[]) => dates.filter((d): d is Date => Boolean(d)).reduce((a, b) => (b < a ? b : a));

/** 一天的打算这一段实际做的（改了的用改了的；作业压着改的写完就回到原来的打算） */
function planned(at: Date, sources: LifeSources, world: WorldNow | undefined, reading: readonly ExtraFreeActivity[], text: string) {
    const day = herDay(sources.schedule, at);
    const body = sources.bodyAt?.(at);
    const slots = dayPlan(sources.schedule, sources.plans, day, { rain: world?.weather?.rain, ...(world?.weather?.rainHours ? { rainHours: world.weather.rainHours } : {}), ...(body ? { body } : {}), homework: world?.homework }, reading);
    const slot = slots.find(s => s.planned === text);
    const done = slot && slot.done !== slot.planned && !(slot.until && at >= slot.until) ? slot.done : text;
    return freeAction(done, at, sources, reading);
}

/** 把状态行上的空闲活动映射成生活事件类型；状态行影子审计和执行器共用。 */
export function freeAction(text: string, at: Date, sources: Pick<LifeSources, 'schedule' | 'plans' | 'books'>, reading: readonly ExtraFreeActivity[]):
    { kind: TypedActionKind; subject: string; target?: string } {
    if (text === '先赶作业') return { kind: 'study', subject: '作业' };
    const free = freeKind(text, sources, reading);
    // 在读的书停了（读到最新一卷）或读完了，状态行还写在看（readingActivities 不看进度）：记成休闲（翻翻、重温），
    // 不交给裁判判 unavailable——原来 10-16 晚上《药屋》停在第 10 卷，整晚排不上，事件账空了一晚（ADR 0042）
    const book = free.kind === 'read_book' ? sources.books.find(b => b.id === free.subject) : undefined;
    if (book) {
        const progress = bookProgressAt(sources.schedule, book, at);
        if (progress.stopped || progress.finished) return { kind: 'leisure', subject: text };
    }
    return free;
}

const LIMITS: Partial<Record<TypedActionKind, [number, number]>> = {
    study: [25, 120], rest: [15, 120], read_book: [15, 90], leisure: [10, 240], work_on_project: [15, 240], interact_npc: [5, 60],
};
/** 请求的时长卡在这一类的上下限里（短于下限的交给裁判判 no_time 之前就跳过了） */
function clampMinutes(kind: TypedActionKind, minutes: number): number {
    const [min, max] = LIMITS[kind] ?? [1, minutes];
    return Math.max(min, Math.min(max, minutes));
}

export interface LifeExecutor {
    /** 从上一件事结束的地方一件件排到 now（开始时刻不晚于 now 的都排；最后一件可能还没做完，在队列里） */
    fill(now: Date): number;
}

/**
 * 执行器：游标是事件账和队列里她自己的行动最晚结束的那一刻（没有就是 since），不另存，重启后照样接上。
 * 裁判不收的（和聊天里说过做了的事撞了、短到排不下）记日志，往后挪一点再看
 */
export function lifeExecutor(sources: LifeSources, queue: ActionQueue, options: { since: Date; log?: (message: string) => void }): LifeExecutor {
    const log = options.log ?? (() => undefined);
    const ends = () => [
        ...sources.events().filter(e => e.id.startsWith('life:')).map(e => Date.parse(e.endedAt)),
        ...queue.pending().filter(item => item.id.startsWith('life:')).map(item => Date.parse(item.event.at)),
    ];
    return {
        fill(now) {
            // 聊天记录这一轮只读一次（她说「睡了」的时刻），选择器一步步排的时候都用这一份
            const said = sources.bedtimes?.();
            const fixed: LifeSources = said ? { ...sources, bedtimes: () => said } : sources;
            // 先看排着的：聊天里说过的事改了世界的，停在那一刻或去掉（ADR 0042）
            for (const item of queue.pending()) revise(item, fixed, queue, now);
            let cursor = new Date(Math.max(options.since.getTime(), ...ends()));
            let scheduled = 0;
            for (let guard = 0; cursor < now && guard < 2000; guard++) {
                const choice = chooseAt(cursor, fixed);
                if ('skipTo' in choice) {
                    cursor = choice.skipTo > cursor ? choice.skipTo : new Date(cursor.getTime() + 60_000);
                    continue;
                }
                const world = sources.worldAt(cursor);
                const appointments = appointmentActions(fixed, cursor, new Date(cursor.getTime() + 24 * 60 * 60_000));
                const context: ActionContext = {
                    schedule: sources.schedule, books: sources.books, events: sources.events(), appointments,
                    busy: [...dayBusy(sources, cursor), ...appointments.map(item => ({ start: item.start, end: item.end }))],
                    ...(world ? { world } : {}),
                };
                const verdict = queue.schedule(choice.intent, context);
                if (verdict.ok) {
                    scheduled++;
                    // 刚排的这件也看一眼：已经知道她中途说了「睡了」、下楼喂了猫（重启后补排时），停在那一刻——和排着时才知道的结果一样
                    const item = queue.pending().find(other => other.id === verdict.event.id);
                    if (item) revise(item, fixed, queue, now);
                    const end = new Date(queue.pending().find(other => other.id === verdict.event.id)?.event.at ?? verdict.event.at);
                    cursor = end > cursor ? end : new Date(cursor.getTime() + 60_000);
                } else {
                    log(`她的生活：${choice.why}（${choice.intent.kind}）排不上：${verdict.reason}，往后挪 5 分钟`);
                    cursor = new Date(cursor.getTime() + 5 * 60_000);
                }
            }
            return scheduled;
        },
    };
}

/**
 * 排着的见面按现在的约定再看一遍（G1，审查 P1-1）：ADR 0047 起聊着就会改时间、取消。行动 id 里带着出门时刻和约定 id，
 * 改了时间 id 就变了。约定还在、时段没变——不动；约定取消了或改了时间——还没出门的去掉（从来没发生，之后按新的约定排），
 * 已经出门的停在这一刻（她出去了一趟，这段算数）；改成提前结束的，停在新的结束时刻
 */
function reviseMeet(item: QueuedAction, sources: LifeSources, queue: ActionQueue, now: Date): void {
    if (item.event.result === 'failed') return;
    const start = new Date(item.event.startedAt ?? item.event.at);
    const end = new Date(item.event.at);
    const still = appointmentActions(sources, start, end).find(other => other.id === item.id);
    if (still && still.end.getTime() >= end.getTime()) return;
    if (still) {
        queue.shorten(item.id, still.end, '约好的见面改成早点结束');
        return;
    }
    if (now.getTime() <= start.getTime()) queue.drop(item.id, '约好的见面改了时间或取消了，还没出门');
    else if (now.getTime() < end.getTime()) queue.shorten(item.id, now, '约好的见面中途取消了');
}

/** 灵活的行动：聊天里说过的事能让它提前停；睡觉、吃饭、上课不动 */
const REVISABLE = new Set<TypedActionKind>(['leisure', 'rest', 'read_book', 'study', 'work_on_project']);

/** 排着的这件在那一刻还在接着做吗：同一类；休闲、看闲书、躺着还要是同一件（学习换一份作业也是在学） */
function continues(item: QueuedAction, choice: Choice, sources: Pick<LifeSources, 'plans'>): boolean {
    if (!('intent' in choice) || choice.intent.kind !== item.kind) return false;
    if (item.kind !== 'study') return choice.intent.subject === item.event.subject;
    // 学习换一份作业也是在学；但从图书馆换到宿舍（出门的打算下雨改了，G2）就不是同一件了
    const out = (subject: string | undefined) => Boolean(subject && sources.plans?.outings.some(o => o.text === subject));
    return out(choice.intent.subject) === out(item.event.subject);
}

/**
 * 真实天气（ADR 0048）开始下雨的整点，start 和 end 之间：那一刻的世界里这个钟头在下、上个钟头没下。
 * 每个时刻的世界只知道到那一刻为止下过的钟头，所以开始下雨以前的那段不会被倒着改（G2）；生成的天气没有钟头，不算
 */
function rainOnsets(sources: Pick<LifeSources, 'worldAt'>, start: Date, end: Date): number[] {
    const onsets: number[] = [];
    const first = new Date(start);
    first.setMinutes(0, 0, 0);
    for (let t = first.getTime() + 3_600_000; t < end.getTime(); t += 3_600_000) {
        const at = new Date(t);
        const weather = sources.worldAt(at)?.weather;
        if (!weather?.real || !weather.rainHours) continue;
        const hour = at.getHours();
        if (weather.rainHours.includes(hour) && !weather.rainHours.includes(hour - 1)) onsets.push(t);
    }
    return onsets;
}

/**
 * 世界变了的时刻（start, end 之间）：她说「睡了」、聊天里说过做了的事（事件账里 conversation 来的）、世界里有时长的事开始。
 * 只有这些时刻选择器的答案可能变；没变的话一个都不会停
 */
function changePoints(sources: LifeSources, start: Date, end: Date): Date[] {
    const inside = (t: number) => t > start.getTime() && t < end.getTime();
    const times = [
        ...(sources.bedtimes?.() ?? []),
        ...sources.events().filter(event => event.source === 'conversation').map(event => Date.parse(event.endedAt)),
        ...dayBusy(sources, start).map(span => span.start.getTime()),
        ...appointmentActions(sources, start, end).map(item => item.start.getTime()),
        ...rainOnsets(sources, start, end),
    ].filter(inside);
    return [...new Set(times)].sort((a, b) => a - b).map(t => new Date(t));
}

/**
 * 排着的一件按现在的世界再看一遍（ADR 0042）：开始那一刻就不该是它（说了睡了以后排的休闲）——去掉，从来没发生；
 * 做到一半世界变了（说了睡了、下楼喂猫了、作业写完了）——停在那一刻，算做了的那段，之后按新的世界排。已经落账的不在队列里，不动
 */
function revise(item: QueuedAction, sources: LifeSources, queue: ActionQueue, now: Date): void {
    if (item.kind === 'meet') return reviseMeet(item, sources, queue, now);
    if (!item.id.startsWith('life:') || !REVISABLE.has(item.kind) || item.event.result === 'failed') return;
    const start = new Date(item.event.startedAt ?? item.event.at);
    const first = chooseAt(start, sources);
    if (!continues(item, first, sources)) {
        queue.drop(item.id, `那一刻她在${'intent' in first ? `做别的（${first.why}）` : first.why}，聊天里说过的事改了这一段`);
        return;
    }
    for (const at of changePoints(sources, start, new Date(item.event.at))) {
        const choice = chooseAt(at, sources);
        if (continues(item, choice, sources)) continue;
        queue.shorten(item.id, at, choice.why);
        return;
    }
}
