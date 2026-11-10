// 她此刻作为解释器的模块（ADR 0336 第 5 步）：每一轮先看清她此刻是什么样，再判断怎么接。
// - perceive：按这一轮用的卡（分档位）算她那边（ADR 0021）、她的身体（ADR 0025，男朋友档开了 realNights 时带上昨晚真的怎么睡的，ADR 0219）、状态行（作息 → 说过「睡了」就在睡 ADR 0042 →
//   约好的见面 ADR 0047 → 空闲时世界里有时长的事 ADR 0030 → 一天的打算 ADR 0034 → 项目选择 ADR 0056；空闲时可以排她自己定的计划 herPlan），写进 turn.facts
//   （world、body、status、state、schedule）。意图、被打断、心情、在读的书、照片、她的追求、长短、形状都读它们。
// - contribute：往「此刻」块放五行——你现在（state）、你那边（world）、你的身体（body）、你今天的打算（plans）、他刚回学校（partnerBack）。
// 读世界（worldState.at）会先把到期的行动结算落账：perceive 跑在原来读世界的位置（召回记忆之后），时刻不变。
// 留在旧逻辑、读 facts 的：心情、在读的书、拍照练习、问到过去某天、见面不方便的时段、她那边还没说过的事。
// 规则都在各自的文件里（world/world.ts、life/body.ts、language/status-line.ts、life/day-plan.ts、life/schedule.ts），这里只是接线；
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 her-now 等场景核对）。「上面那几行是底子不是话题」（groundNote）还在旧逻辑，读 facts。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { herStatus } from '../language/status-line.ts';
import { saidAsleepAt } from '../life/bedtime.ts';
import { bodyAt, describeBody } from '../life/body.ts';
import { lastNight, withLastNight } from '../life/nights.ts';
import { describePlans } from '../life/day-plan.ts';
import { readingActivities } from '../life/her-days.ts';
import { describeAppointment, type Appointment } from '../life/promises.ts';
import { describeState, herDay, partnerBackLine, type ExtraFreeActivity, type Schedule } from '../life/schedule.ts';
import type { StoredMessage } from '../memory/history.ts';
import { UNLISTED_TIER, type Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import { describeWorld, worldAt, type WorldState } from '../world/world.ts';

export interface HerNowOptions {
    /** 作息（配置 schedule）：状态行跟着它 */
    schedule?: boolean;
    /** 她自己的日子（配置 herDays）：她那边、身体、一天的打算跟着它 */
    herDays?: boolean;
    /** 项目选择（ADR 0056，配置 projectChoice，要有生活队列） */
    projectChoice?: boolean;
    /** 昨晚真的怎么睡的（ADR 0219，配置 realNights）：只给男朋友档，身体那一行带上，状态行带起床气 */
    realNights?: boolean;
    /** 她自己定的计划（配置 innerLife）：空闲时可以排进状态行 */
    herPlan?: (at: Date) => ExtraFreeActivity[];
    /** 共享的世界账（带生活事件账）；没有就按卡现算 */
    worldState?: () => (Pick<WorldState, 'at'> & Partial<Pick<WorldState, 'events'>>) | undefined;
    /** 此刻约好的见面（ADR 0047，要长期记忆服务） */
    appointmentsAt?: (at: Date) => readonly Appointment[] | undefined;
    /** 名单：说过「睡了」看所有人的聊天记录；她那边“钱是谁给的”写称呼 */
    contacts?: () => readonly Contact[];
    /** 某个人的聊天记录（说过「睡了」用） */
    history: (qq: number) => readonly StoredMessage[];
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

/** 这一轮的作息（开了作息才有）和她自己的日子（开了 herDays 才有）；两者是同一张卡上的作息 */
function schedules(turn: Turn, options: HerNowOptions): { schedule?: Schedule; herSchedule?: Schedule } {
    const card = turn.card;
    return {
        ...(card && options.schedule ? { schedule: card.schedule } : {}),
        ...(card && options.herDays ? { herSchedule: card.schedule } : {}),
    };
}

export function herNowModule(options: HerNowOptions): Module {
    const log = (turn: Turn, message: string) => options.log(`[${turn.contact.qq}] ${message}`);
    return {
        id: 'her-now',
        perceive(turn) {
            const card = turn.card;
            if (!card) return;
            const { schedule, herSchedule } = schedules(turn, options);
            const { contact, at: time } = turn;
            const worldState = options.worldState?.();
            // 她那边（ADR 0021）：跟着「她自己的日子」开，卡上有世界才有
            const around = herSchedule && card.herWorld
                ? worldState?.at(card.herWorld, herSchedule, time) ?? worldAt(card.herWorld, herSchedule, time)
                : undefined;
            const everyone = [contact.qq, ...(options.contacts?.() ?? []).map(other => other.qq).filter(qq => qq !== contact.qq)];
            // 她的身体（ADR 0025）：同样跟着「她自己的日子」，卡上有才有
            // 昨晚真的怎么睡的（ADR 0219，realNights）：早上困不困、为什么困，从她说「睡了」、半夜被吵醒、睡前跟他聊到几点推
            const night = options.realNights && contact.tier === 'boyfriend' && herSchedule
                ? lastNight(everyone.map(qq => ({ qq, messages: options.history(qq) })), contact.qq, herSchedule, time) : undefined;
            const body = herSchedule && card.herWorld?.body ? withLastNight(bodyAt(card.herWorld.body, herSchedule, time), night, time, herDay(herSchedule, time)) : undefined;
            // 她说过「睡了」（ADR 0042）：对名单里谁说的都算，各个联系人看到的是同一个她
            const asleep = schedule ? saidAsleepAt(schedule, everyone.map(qq => options.history(qq)), time) : undefined;
            // 约好的见面（ADR 0047）：和这个人约的优先；和别人约的只说在外面、约了人
            const meetings = contact.tier !== UNLISTED_TIER ? options.appointmentsAt?.(time) ?? [] : [];
            const meeting = meetings.find(m => m.contact.qq === contact.qq) ?? meetings[0];
            const appointment = meeting ? describeAppointment(meeting, contact, time) : undefined;
            const status = schedule ? herStatus(schedule, time, {
                extraFree: [...(herSchedule ? readingActivities(card.books) : []), ...(options.herPlan?.(time) ?? [])],
                ...(around ? { world: around } : {}), ...(asleep ? { asleep } : {}), ...(appointment ? { appointment } : {}),
                ...(herSchedule ? { plans: { plans: card.herWorld?.plans, ...(body ? { body } : {}) } } : {}),
                ...(options.projectChoice && worldState?.events
                    ? { projectChoice: { events: worldState.events(), books: card.books } }
                    : {}),
            }) : undefined;
            if (status?.saidAsleep) log(turn, `她 ${status.saidAsleep.since.toTimeString().slice(0, 5)} 说过睡了：状态行按在睡觉`);
            if (status?.busy) log(turn, `此刻在做：${status.busy}`);
            if (status?.revised) log(turn, `改了打算：${status.revised}`);
            const herNow = schedule ?? herSchedule;
            Object.assign(turn.facts, {
                ...(around ? { world: around } : {}), ...(body ? { body } : {}), ...(status ? { status, state: status.state } : {}),
                ...(herNow ? { schedule: herNow } : {}),
            });
        },
        contribute(turn) {
            const { schedule, herSchedule } = schedules(turn, options);
            const { world: around, body, status, state } = turn.facts;
            const { contact, at: time } = turn;
            // 别人给的钱（买相机，ADR 0053 调整）：正在聊的人给的写他的称呼，男朋友给的跟别人说是「男朋友」
            const giver = (qq: number) => {
                if (qq === contact.qq) return contact.name;
                const other = (options.contacts?.() ?? []).find(c => c.qq === qq);
                return other ? (other.tier === 'boyfriend' ? '男朋友' : other.name) : undefined;
            };
            const when = (slot: Piece['slot'], text: string | undefined): Piece[] => (text ? [{ slot, text }] : []);
            return [
                ...(state && schedule ? [{ slot: 'state' as const, text: describeState(state, schedule, { userName: contact.name, woken: turn.woken, partnerApart: true, ...(options.realNights && contact.tier === 'boyfriend' ? { grumpy: true } : {}) }) }] : []),
                ...when('world', around ? describeWorld(around, time, giver) : undefined),
                ...when('body', body ? describeBody(body) : undefined),
                ...when('plans', herSchedule ? describePlans(herSchedule, status?.slots ?? [], time) : undefined),
                // 放完假他已经回学校了（ADR 0007 调整）：放在事实的最后、离他最新的话最近，免得她信聊天记录里假期中的「我在老家」
                ...when('partnerBack', state ? partnerBackLine(state, contact.name) : undefined),
            ];
        },
    };
}
