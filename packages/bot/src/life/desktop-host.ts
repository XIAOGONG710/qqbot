import { dirname, join } from 'node:path';
import { desktopFocusBusy, FOCUS_CHECKPOINT_FILE } from '../../../../dsh-plugins/dsh-linmengyao-memory/focus-checkpoints.mjs';
import type { Files } from '../executor/executor.ts';
import { desktopRecentPath } from '../memory/cross-recent.ts';
import { desktopLogPath, desktopTurns, ingestDesktopRecent } from '../memory/desktop-log.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { Timeline } from '../memory/timeline.ts';
import { desktopMessages } from '../memory/owner-day-view.ts';
import { oneLifeAt, ownerOf, type AppConfig, type Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import type { Character } from '../st/card.ts';
import type { ActionQueue } from '../world/action-queue.ts';
import type { WorldState } from '../world/world.ts';
import { asleepSince } from './bedtime.ts';
import { DESKTOP_LOOKBACK_MS, desktopBusySpans, desktopCalled, desktopWorldEvents, type DesktopCalled, type DesktopSpan } from './desktop-conflict.ts';
import { desktopNowSource, type DesktopNowSource } from './desktop-now.ts';
import { DESKTOP_SESSION_KIND, DESKTOP_SESSION_PREFIX, recordDesktopSessions } from './desktop-timeline.ts';
import { desktopDiaryLine } from './one-diary.ts';
import { formatDate, herDay, stateAt, type Schedule } from './schedule.ts';

// 桌面上的时间算进她的一天（ADR 0347 第 3 层，方案 docs/plans/2026-11-22-same-her-layer3-writeback.md §2.7）在 App 里的那一摊：
// 开没开（desktopDay / desktopReview / desktopConflict / desktopFeelings 的依赖和日志）、30 秒一拍刷新的缓存、「被他叫上电脑」、
// 收件箱那一拍收桌面记录、结束了的会话记进时间线、空闲时间记成世界事件、日记里那一行。
// 原来在 app.ts 里，ADR 0336 收尾（docs/plans/2026-11-24-0336-finish.md）原样搬到这里，先后不变：
// 构造时做的（日志、第一次刷新缓存）在 App 原来的位置建它时做；「打开开关的那一刻」在 App 原来算它的位置调 attachWorld；
// 约定来源接上以后 App 调 worldReady。都关着时什么都不建，和原来逐字一样。

export interface DesktopHostDeps {
    config: Pick<AppConfig, 'dataDir' | 'contacts' | 'timeline' | 'oneLife' | 'desktopReview' | 'feelingReview' | 'herFeelings' | 'desktopConflict' | 'herDays' | 'desktopFeelings'>;
    /** 灵魂目录（DSH 的 desktop-presence.json 在这里） */
    soulDir: string;
    worldNow: () => number;
    /** 他那一档的卡（「被叫上电脑」按他那一档卡上的作息算） */
    cardFor: (tier: string) => { character: Pick<Character, 'schedule'> };
    /** 她说过「睡了」的时刻（App 的 bedtimes：聊天记录 + 这里的桌面缓存） */
    bedtimes: (schedule: Schedule, now: number) => number[];
    files: Pick<Files, 'read' | 'write' | 'mkdir'>;
    log: Log;
}

/** 记世界事件要用的那几样：都在 App 后面才建，attachWorld 时交进来 */
export interface DesktopWorldDeps {
    sharedWorld: Pick<WorldState, 'events' | 'recordEvents'> | undefined;
    timeline: Pick<Timeline, 'read' | 'record'> | undefined;
    lifeQueue: Pick<ActionQueue, 'pending'> | undefined;
    worldCard: Pick<Character, 'schedule'> | undefined;
    bedtimesSince: (schedule: Schedule, since: number) => number[];
}

export interface DesktopHost {
    /** 名单里第一个男朋友档（桌面那一摊只给他） */
    owner: Contact | undefined;
    /** desktopDay 起作用时的桌面来源；没起作用是 undefined */
    source: DesktopNowSource | undefined;
    /** 作息冲突起作用了（desktopConflict） */
    conflictOn: boolean;
    /** 「被他叫上电脑」那一行和昨晚那段给不给 her-now（名单里只有一个男朋友档时） */
    conflictHerNow: boolean;
    /** 桌面上的事也进心境（desktopFeelings） */
    moodOn: boolean;
    /** 生活选择器的忙碌段（缓存的，不读文件） */
    busy(): readonly DesktopSpan[];
    /** 当聊天记录用的桌面回合（她在电脑上说「睡了」也算说过；作息冲突关着时是空的） */
    chat(): readonly StoredMessage[];
    /** 心境用的那一份桌面回合 */
    mood(): readonly StoredMessage[];
    /** 此刻他在电脑前、这一段开始时她本来在上课 / 该睡了 */
    calledAt(at: Date): DesktopCalled | undefined;
    /** 作息冲突的世界事件从哪一刻算（第一次打开开关时记下的那一刻）：在 App 原来算它的位置调一次 */
    attachWorld(world: DesktopWorldDeps): void;
    /** 约定来源接上了：之后收件箱那一拍才记世界事件 */
    worldReady(): void;
    /** DSH 收件箱那一拍里桌面的那一段：收记录、刷新缓存、会话进时间线、空闲时间进世界 */
    syncInbox(now: Date): void;
    /** 日记里「电脑上：…」那一行 */
    diaryLine(date: string, diarySchedule: Schedule): string | undefined;
}

export function desktopHost({ config, soulDir, worldNow, cardFor, bedtimes, files, log }: DesktopHostDeps): DesktopHost {
    // （同 App 里的 deviceOwner，这里先按同一条规则取，生活执行器要用）。desktopDay 要 crossRecent（桌面回合靠它那条路传过来）；
    // 另外四个开关各自再要 desktopDay / feelingReview / herDays / 长期记忆，依赖不齐就当没开
    const desktopOwner = ownerOf(config.contacts);
    const desktopSource = oneLifeAt(config.oneLife, 'desktop') && desktopOwner
        ? desktopNowSource({ dataDir: config.dataDir, soulDir, log }) : undefined;
    if (oneLifeAt(config.oneLife, 'desktop') && !desktopSource) log('桌面上的时间：oneLife 开到 desktop，但名单里没有男朋友档，不起作用');
    else if (desktopSource) log(`桌面上的时间：开（只给 ${desktopOwner!.qq}；他在电脑前主动消息不打扰、留话先留着，NOW.md 知道${config.timeline ? '，会话记进时间线' : ''}）`);
    if (config.desktopReview && !(desktopSource && config.feelingReview && config.herFeelings)) log(`桌面上的对话进回想：desktopReview 开着，但${!desktopSource ? ' oneLife 没开到 desktop' : ' feelingReview / herFeelings 没开'}，不起作用`);
    // 作息冲突（desktopConflict）：要 desktopDay、herDays；被叫上电脑那一行和昨晚那段只在名单里只有一个男朋友档时给（her-now 只按档位认人，不能让别的男朋友档看到他的桌面）
    const desktopConflictOn = Boolean(desktopSource && config.desktopConflict && config.herDays);
    const desktopConflictHerNow = desktopConflictOn && config.contacts.filter(c => c.tier === 'boyfriend').length === 1;
    if (config.desktopConflict && !desktopConflictOn) log(`作息冲突：desktopConflict 开着，但${!desktopSource ? ' oneLife 没开到 desktop' : ' herDays 没开'}，不起作用`);
    else if (desktopConflictOn && !desktopConflictHerNow) log('作息冲突：名单里不止一个男朋友档，「被他叫上电脑」那一行和昨晚那段不给（只记世界事件、占她的时间）');
    // 30 秒一拍（DSH 收件箱那一拍）刷新的桌面缓存：生活选择器的忙碌段、当聊天记录用的桌面回合（她在电脑上说「睡了」也算说过）。用的地方不读文件
    let desktopBusyCache: readonly DesktopSpan[] = [];
    let desktopChatCache: readonly StoredMessage[] = [];
    // 桌面上的事也进心境（desktopFeelings，ADR 0347 第 5 层）单用一份：desktopChatCache 还管「电脑上说睡了也算」，那是 desktopConflict 的事，不能跟着它开
    let desktopMoodCache: readonly StoredMessage[] = [];
    const desktopMoodOn = Boolean(desktopSource && config.desktopFeelings && config.herFeelings);
    const refreshDesktopCaches = (now: number): void => {
        if (!desktopSource || (!desktopConflictOn && !desktopMoodOn)) return;
        const turns = desktopSource.turns(now);
        if (desktopConflictOn) {
            desktopBusyCache = desktopBusySpans({ turns, lease: desktopSource.lease(), now });
            try { desktopBusyCache = desktopFocusBusy(join(soulDir, FOCUS_CHECKPOINT_FILE), desktopBusyCache, now); }
            catch { log('桌面任务检查点无法读取，暂用原桌面在场区间'); }
            desktopChatCache = desktopMessages(turns);
        }
        if (desktopMoodOn) desktopMoodCache = desktopMessages(turns);
    };
    refreshDesktopCaches(worldNow());
    /** 此刻他在电脑前、这一段开始时她本来在上课 / 该睡了（desktopConflict，给 her-now）：按他那一档卡上的作息；说过「睡了」也算该睡了 */
    function desktopCalledAt(at: Date): DesktopCalled | undefined {
        const schedule = desktopOwner ? cardFor(desktopOwner.tier).character.schedule : undefined;
        if (!desktopSource || !schedule) return undefined;
        const now = at.getTime();
        return desktopCalled({
            turns: desktopSource.turns(now), lease: desktopSource.lease(), now,
            stateAt: time => stateAt(schedule, time), asleep: time => Boolean(asleepSince(schedule, bedtimes(schedule, now), time)),
        });
    }

    let world: DesktopWorldDeps | undefined;
    let desktopWorldSince: number | undefined;
    // 读世界会先推进生活（排到现在）：约定来源接上之前（搭 App 时那一次同步）不读，免得把赴约时段排成普通休闲
    let desktopWorldReady = false;
    /** 结束了的桌面会话里空闲时间的那部分记成世界事件（desktopConflict）：先读一次世界（结算、把排着的空闲活动停在会话开始），再算还空着的分钟 */
    function recordDesktopWorld(now: number): void {
        const sharedWorld = world?.sharedWorld;
        const worldCard = world?.worldCard;
        if (!desktopWorldReady || !desktopSource || !desktopConflictOn || !sharedWorld || !worldCard?.schedule || desktopWorldSince === undefined) return;
        const schedule = worldCard.schedule;
        const { timeline, lifeQueue, bedtimesSince } = world!;
        try {
            const events = sharedWorld.events();
            const said = bedtimesSince(schedule, now - DESKTOP_LOOKBACK_MS - 86_400_000);
            const did = (timeline?.read() ?? [])
                .filter(entry => entry.channel === 'desktop' && entry.ok !== false && entry.kind !== DESKTOP_SESSION_KIND && !entry.id?.startsWith(DESKTOP_SESSION_PREFIX))
                .map(entry => Date.parse(entry.at)).filter(Number.isFinite);
            const drafts = desktopWorldEvents({
                turns: desktopSource.turns(now), lease: desktopSource.lease(), now,
                stateAt: at => stateAt(schedule, at), asleep: at => Boolean(asleepSince(schedule, said, at)),
                events, ...(lifeQueue ? { pending: lifeQueue.pending() } : {}), did, since: desktopWorldSince,
                ...(desktopOwner ? { contact: desktopOwner.qq } : {}),
            });
            if (!drafts.length) return;
            sharedWorld.recordEvents(drafts);
            log(`作息冲突：桌面上陪他的空闲时间记进世界 ${drafts.length} 件（${drafts.map(draft => `${Math.round((Date.parse(draft.at) - Date.parse(draft.startedAt!)) / 60_000)} 分钟`).join('、')}）`);
        } catch (error) {
            log(`作息冲突：世界事件这次没记（${error instanceof Error ? error.message : String(error)}）`);
        }
    }

    return {
        owner: desktopOwner,
        source: desktopSource,
        conflictOn: desktopConflictOn,
        conflictHerNow: desktopConflictHerNow,
        moodOn: desktopMoodOn,
        busy: () => desktopBusyCache,
        chat: () => desktopChatCache,
        mood: () => desktopMoodCache,
        calledAt: desktopCalledAt,
        attachWorld(attached) {
            world = attached;
            const { sharedWorld } = attached;
            // 作息冲突的世界事件（desktopConflict）只记打开开关以后开始的会话：第一次打开时记下那一刻，重启照旧从那一刻算（不会一打开就把两天的会话灌进去）
            desktopWorldSince = (() => {
                if (!desktopConflictOn || !sharedWorld) return undefined;
                const file = join(config.dataDir, 'world', 'desktop-conflict-since.json');
                try {
                    const saved = (JSON.parse(files.read(file)) as { since?: unknown } | null)?.since;
                    const at = typeof saved === 'string' ? Date.parse(saved) : NaN;
                    if (Number.isFinite(at)) return at;
                } catch { /* 第一次打开（或文件坏了）：从现在算 */ }
                const since = worldNow();
                try { files.mkdir(dirname(file)); files.write(file, JSON.stringify({ since: new Date(since).toISOString() })); }
                catch (error) { log(`作息冲突：打开的时刻没记下（${error instanceof Error ? error.message : String(error)}），这次从现在算`); }
                return since;
            })();
        },
        worldReady() { desktopWorldReady = true; },
        syncInbox(now) {
            // 桌面记录（ADR 0347 第 3 层，desktopDay）：把插件整份重写的 desktop-recent.jsonl 收进 QQ 自己的 desktop-log.jsonl；
            // 收完刷新作息冲突的缓存、把结束了的会话记进时间线（只有时长和动作类别）、空闲时间那部分记成世界事件（desktopConflict）
            if (!desktopSource) return;
            const timeline = world?.timeline;
            const memoryDir = join(config.dataDir, 'memory');
            // 旧账读不了时它会抛（不覆盖 14 天的记录）：单独接住，别连带后面的回执一起失败
            try { ingestDesktopRecent({ recentFile: desktopRecentPath(memoryDir), logFile: desktopLogPath(config.dataDir), now: now.getTime(), log }); }
            catch (error) { log(`桌面记录：这次没收（${error instanceof Error ? error.message : String(error)}）`); }
            refreshDesktopCaches(now.getTime());
            if (timeline) recordDesktopSessions(timeline, { turns: desktopSource.turns(now.getTime()), lease: desktopSource.lease(), now: now.getTime() }, log);
            recordDesktopWorld(now.getTime());
        },
        diaryLine(date, diarySchedule) {
            return desktopDiaryLine({
                date, dayOf: at => formatDate(herDay(diarySchedule, at)),
                turns: desktopTurns(config.dataDir, worldNow()),
            });
        },
    };
}
