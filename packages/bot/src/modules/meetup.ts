// 他提到见面时她那几天不方便的时段（ADR 0066 决策 2）作为解释器的模块（ADR 0336 第 5 步）：
// 男朋友最近八条里说到见面又带着时间，就把她那几天不方便的时段（有课、赶作业、身体不舒服、已经约了别的）放进 obstacle 槽；
// 只给事实，是否推、怎么说由她定。先只给男朋友档；主动找他时不放；危机回合照样放。
// 跟着「她自己的日子」（配置 herDays）开。约定来源不可确认时（长期记忆服务读不到）只放一句「先确认」，不把未知当成没有约。
// 不存状态、不调模型。认「提到见面」、算哪几天、写法的规则都在 life/promises.ts（mentionsMeetup）、world/obstacles.ts（meetupDays / describeObstacles），
// 这里只是接线；行为和迁移前 contact.ts 里的逐字一样（行为基线 meetup 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { bodyAt } from '../life/body.ts';
import { mentionsMeetup, type PromiseKeeper } from '../life/promises.ts';
import { herDay } from '../life/schedule.ts';
import type { Log } from '../platform/log.ts';
import { describeObstacles, meetupDays } from '../world/obstacles.ts';
import { worldAt, type WorldState } from '../world/world.ts';

export interface MeetupModuleOptions {
    /** 她自己的日子（配置 herDays） */
    herDays?: boolean;
    /** 共享的世界账；没有就按卡现算 */
    worldState?: () => Pick<WorldState, 'at'> | undefined;
    /** 约定（要长期记忆服务）：来源可不可确认、某段时间里已经约了的 */
    promises?: () => Partial<Pick<PromiseKeeper, 'available' | 'appointmentsBetween'>> | undefined;
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export const MEETUP_SOURCE_UNAVAILABLE = '约定来源暂不可确认：不能认定没有别的约或编造空闲时段，涉及约见先确认；不要把内部状态或错误信息说给对方。';

export function meetupModule(options: MeetupModuleOptions): Module {
    return {
        id: 'meetup',
        contribute(turn) {
            const { contact, history, at } = turn;
            const schedule = options.herDays ? turn.card?.schedule : undefined;
            if (contact.tier !== 'boyfriend' || turn.initiate || !schedule || !mentionsMeetup(history)) return [];
            const world = turn.card?.herWorld;
            const promises = options.promises?.();
            const text = promises?.available?.() === false
                ? MEETUP_SOURCE_UNAVAILABLE
                : describeObstacles(meetupDays(history.slice(-8).map(m => m.content).join('\n'), herDay(schedule, at), at), at, {
                    schedule,
                    ...(world ? { worldAt: (when: Date) => options.worldState?.()?.at(world, schedule, when) ?? worldAt(world, schedule, when) } : {}),
                    ...(world?.body ? { bodyAt: (when: Date) => bodyAt(world.body!, schedule, when) } : {}),
                    // 和这个人约的不算「约了别的」：那是他们两个的约，时间块里别处（答应的事、状态行）已经写了
                    ...(promises?.appointmentsBetween ? { appointments: (from: Date, to: Date) => promises.appointmentsBetween!(from, to).filter(a => a.contact.qq !== contact.qq) } : {}),
                });
            if (!text) return [];
            options.log(`[${contact.qq}] 他提到见面：时间块里列了她这几天不方便的时段`);
            return [{ slot: 'obstacle', text }];
        },
    };
}
