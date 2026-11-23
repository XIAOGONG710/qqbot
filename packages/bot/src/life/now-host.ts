import { join } from 'node:path';
import type { StoredMessage } from '../memory/history.ts';
import type { AppConfig, Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import type { Character } from '../st/card.ts';
import { ownDaysLine, recentDayHighlights, worldHighlights } from '../world/highlights.ts';
import type { WorldState } from '../world/world.ts';
import { desktopPresence, lastDesktopTurnAt, type DesktopNowSource } from './desktop-now.ts';
import { readingActivities } from './her-days.ts';
import { herPlanActivities } from './her-plans.ts';
import { activityWithChat, nowDoing, renderNow, writeNow } from './now-export.ts';
import { describeState, stateAt } from './schedule.ts';

// 「她现在在干嘛」（NOW.md）和「你这两天自己在做的」（ownDays）在 App 里的那一摊：
// QQ 这边按自己的作息 + 世界 + 心境渲染 NOW.md（任务书 §2，DSH 桌面只读它，超过 30 分钟不注入）；
// ownDays（ADR 0347 第 2 层 D 块）从共享世界账里取昨天已经发生的事。
// 原来在 app.ts 里（exportNow / ownDaysNow），ADR 0336 收尾（docs/plans/2026-11-24-0336-finish.md）原样搬到这里；
// 什么时候写（搭 App 时一次、now-export 模块定时、收下一条私聊后）仍由 App 和模块定。

export interface NowHostDeps {
    config: Pick<AppConfig, 'dataDir' | 'herDays'>;
    /** 灵魂目录（NOW.md 写在这里） */
    soulDir: string;
    /** 她的世界用的那张卡（名单里最亲的、卡上有作息和世界的那一档）；没有作息就不写 */
    worldCard: Character | undefined;
    sharedWorld: Pick<WorldState, 'at'> | undefined;
    worldNow: () => number;
    /** 名单里第一个男朋友档（deviceOwner）：「和你聊天中」看他 */
    owner: Contact | undefined;
    history: (qq: number) => readonly StoredMessage[];
    /** desktopDay 起作用时的桌面来源 */
    desktopSource: DesktopNowSource | undefined;
    /** 一本日记开着、当天日记由 QQ 写（告诉常驻进程睡眠整合别再 journal_write） */
    diaryByQq: boolean;
    log: Log;
}

export interface NowHost {
    /** 渲染一次 NOW.md；写不出去只记一行日志 */
    exportNow(): void;
    /** 「你这两天自己在做的」那一行；没有世界账时 undefined */
    ownDays(): string | undefined;
}

export function nowHost({ config, soulDir, worldCard, sharedWorld, worldNow, owner: deviceOwner, history, desktopSource, diaryByQq, log }: NowHostDeps): NowHost {
    const nowFile = join(soulDir, 'NOW.md');
    const exportNow = (): void => {
        const schedule = worldCard?.schedule;
        if (!schedule) return;
        try {
            const at = worldNow();
            const now = new Date(at);
            // 在读的书 + 她自己决定今天想做的（ADR 0182）：状态行里她就是个在做那件事的人
            const extraFree = config.herDays ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, now, log)] : [];
            const owner = deviceOwner;
            const state = stateAt(schedule, now, extraFree);
            const base = describeState(state, schedule, owner ? { userName: owner.name } : {});
            // 中断层：他刚说过话就写「和你聊天中」，聊完下一次渲染自己回到原来的轨迹
            const lastAt = owner ? Date.parse(history(owner.qq).at(-1)?.time ?? '') : NaN;
            const qqLastAt = Number.isFinite(lastAt) ? lastAt : undefined;
            // desktopDay（ADR 0347 第 3 层）：桌面上最后一轮也算刚说过话、他在电脑前也算聊着，本来在上课 / 该睡了带括号；
            // asleep 只因 QQ 上聊着才改 no（桌面上是被叫起来的，不是醒了）。关着照旧
            const desktopLastAt = desktopSource ? lastDesktopTurnAt(desktopSource.turns(at), at) : undefined;
            const withDesktop = desktopSource ? nowDoing({
                base, kind: state.activity.kind, now: at, desktopWith: desktopPresence(desktopSource, at).with,
                ...(qqLastAt !== undefined ? { qqLastAt } : {}), ...(desktopLastAt !== undefined ? { desktopLastAt } : {}),
            }) : undefined;
            const doing = withDesktop ? withDesktop.doing : activityWithChat(base, qqLastAt, at);
            // 私有生活片段（ADR 0236）：和控制台使用同一确定性投影，只写已经发生的世界事实。
            // 不放聊天原文、未来计划，也不调用模型生成“朋友圈”。
            const recent = worldCard.herWorld && sharedWorld
                ? worldHighlights(sharedWorld.at(worldCard.herWorld, schedule, now), now).map(item => item.text)
                : [];
            // 睡没睡给常驻进程看（ADR 0347 第 1 层：原来它看 her-life 自己编的「睡觉」，和这边的作息对不上）；正和他聊着就算醒着
            const asleep = withDesktop ? withDesktop.asleep : state.activity.kind === 'sleep' && doing === base;
            // 一本日记（oneDiary）：当天日记由 QQ 写，告诉常驻进程睡眠整合别再 journal_write
            writeNow(nowFile, renderNow({ doing, at, asleep, ...(diaryByQq ? { diaryBy: 'qq' as const } : {}), ...(recent.length ? { recent } : {}) }));
        } catch (error) {
            log(`「她现在在干嘛」没写出去（${error instanceof Error ? error.message : String(error)}）`);
        }
    };
    // 「你这两天自己在做的」的真实来源（ADR 0347 第 2 层 D 块，ownDays）：共享世界账里昨天已经发生的事，今天的小事 world 行已经列了不重复
    function ownDaysNow(): string | undefined {
        const schedule = worldCard?.schedule;
        const herWorld = worldCard?.herWorld;
        if (!schedule || !herWorld || !sharedWorld) return undefined;
        const world = sharedWorld;
        return ownDaysLine(recentDayHighlights(at => world.at(herWorld, schedule, at), schedule, new Date(worldNow())));
    }
    return { exportNow, ownDays: ownDaysNow };
}
