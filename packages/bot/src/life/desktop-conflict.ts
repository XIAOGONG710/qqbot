// 作息冲突：他在她本来上课 / 睡觉 / 空闲的时候叫她上电脑（ADR 0347 第 3 层，开关 desktopConflict，要 desktopDay、herDays，睡觉那一行还要 realNights；
// 方案 docs/plans/2026-11-22-same-her-layer3-writeback.md §2.6）。用户 11-22 定的：功能照常、不拖不拒，她知道自己本来在干嘛；
// 上课时间不另扣精力（不上 needs-v2）；电脑上被叫起来和 QQ 上被吵醒一样有起床气（realNights）。
//
// 三件事，都是纯函数（不读文件、不落盘、不记日志；桌面回合由 memory/desktop-log.ts 的 desktopTurns 给，租约由调用方读好）：
// 1. desktopBusySpans：给生活选择器的 LifeSources.desktopBusy。空闲时间里的桌面会话像洗澡、喂猫一样占着时间，
//    排着的空闲活动在会话开始那一刻停（life-selector 的 revise → queue.shorten，和聊天里说过的事改写某一段同一条路）。
//    还在陪着的那一段算到现在。短于 DESKTOP_MIN_MS 的不算（和选择器「短于 10 分钟的空当不记」一致），免得说两句就把她追的剧打断。
// 2. desktopWorldEvents：会话结束（最后一轮以后 DESKTOP_GAP_MS 没有新回合、租约也不在）以后，把空闲时间里的那部分记成世界事件
//    （做过事的 work_on_project、纯聊天的 leisure，subject「陪他（电脑上）」），交给 sharedWorld.recordEvents，按 needs.ts 现有速率扣精力。
//    上课、睡觉、课间的部分不记（课照样记成上过；睡觉走 nights.ts 的吵醒规则）；已经有别的事占着的分钟（饭、说了睡了以后排的觉）让出来。
//    事件里只有时长和「陪他（电脑上）」，没有桌面原文（方案 §2.8）。id 由开始时刻定，事件账按 id 幂等，重启重算也只记一次。
// 3. desktopCalled：此刻他在电脑前、这一段开始时她本来在上课 / 该睡了——给 her-now 的「被他叫上电脑（本来在上课 / 本来该睡了）」那一行和起床气。
//    只是标签（desktop-presence 的 sessionOverlap），不写她该怎么说。

import type { LifeEvent, LifeEventDraft } from '../world/life-events.ts';
import { DESKTOP_GAP_MS, leaseActive, presenceAt, PRESENCE_FUTURE_SLACK_MS, sessionOverlap, sessionsFromTurns, type DesktopSession, type PresenceTurn } from './desktop-presence.ts';
import type { Activity } from './schedule.ts';

/** 世界事件的 subject，也是选择器里跳过 / 停下的原因（进日志）：只说陪他、在电脑上，不带桌面原文 */
export const DESKTOP_SUBJECT = '陪他（电脑上）';
/** 短于这么久的桌面会话不占她的时间、不记世界事件 */
export const DESKTOP_MIN_MS = 10 * 60_000;
/** 只看这么久以内结束的会话（事件账按 id 去重；更早的早就记过或者早就过了） */
export const DESKTOP_LOOKBACK_MS = 2 * 86_400_000;
/** 一段最长算这么久（坏数据把一段拉成几天时不至于逐分钟算到天荒地老） */
export const DESKTOP_SESSION_MAX_MS = 16 * 3_600_000;
/** 世界事件 id 的前缀：desktop-session:<这一部分开始的毫秒> */
export const DESKTOP_EVENT_PREFIX = 'desktop-session:';
/** work_on_project 的 target（projects.ts 只认摄影项目的 id，这个不会算进任何项目进度） */
export const DESKTOP_TARGET = 'desktop';
/** 刚被叫上电脑这么久以内算「刚被吵醒」，有起床气（和 QQ 上被吵醒那一轮相当；之后她已经醒了） */
export const DESKTOP_WOKEN_MS = 10 * 60_000;

const MINUTE = 60_000;

export interface DesktopSpan {
    start: Date;
    end: Date;
}

/** 晚于现在 1 分钟以上的回合不信（同 desktop-presence），切段 */
function sessionsUntil<T extends PresenceTurn>(turns: readonly T[], now: number): DesktopSession<T>[] {
    return sessionsFromTurns(turns.filter(turn => turn.at <= now + PRESENCE_FUTURE_SLACK_MS));
}

/**
 * 给生活选择器的桌面那几段（LifeSources.desktopBusy）：最近 DESKTOP_LOOKBACK_MS 里的会话，还在陪着的那一段算到现在
 * （租约作数时，租约开始得更早就从租约开始；租约那一段和回合对不上就单独一段）。不分空闲不空闲：上课、睡觉在选择器里先判。
 */
export function desktopBusySpans(input: { turns: readonly PresenceTurn[]; lease?: unknown; now: number }): DesktopSpan[] {
    const { now } = input;
    const sessions = sessionsUntil(input.turns, now).map(session => ({ start: session.start, end: session.end }));
    const presence = presenceAt({ ...(input.lease !== undefined ? { lease: input.lease } : {}), turns: input.turns, now });
    if (presence.with) {
        const last = sessions.at(-1);
        const since = presence.since ?? now;
        if (last && (presence.source === 'turns' || last.end >= since - DESKTOP_GAP_MS)) {
            last.start = Math.min(last.start, since);
            last.end = Math.max(last.end, now);
        } else {
            sessions.push({ start: since, end: now });
        }
    }
    return sessions
        .filter(span => span.end >= now - DESKTOP_LOOKBACK_MS && span.end - span.start >= DESKTOP_MIN_MS)
        .map(span => ({ start: new Date(span.start), end: new Date(Math.min(span.end, span.start + DESKTOP_SESSION_MAX_MS)) }));
}

export interface DesktopEventsInput {
    turns: readonly PresenceTurn[];
    lease?: unknown;
    now: number;
    /** 那一刻她作息上在干嘛（life/schedule.ts 的 stateAt）；只有 free 的分钟记事件 */
    stateAt: (at: Date) => { activity: Activity } | undefined;
    /** 那一刻她是不是已经说过睡了（bedtime.ts 的 asleepSince）；说了睡了以后的不算空闲 */
    asleep?: (at: Date) => boolean;
    /** 事件账（sharedWorld.events()）：已经有别的事占着的分钟让出来；自己记过的 id 不再给 */
    events: readonly LifeEvent[];
    /** 行动队列里还没落账的（queue.pending()）：也让出来（比如说了睡了以后排的觉） */
    pending?: readonly { event: Pick<LifeEventDraft, 'at' | 'startedAt' | 'result'> }[];
    /** 她在电脑上做过的事的时刻（时间线里 desktop 渠道、不是会话那一条的）：这一段里有就记 work_on_project */
    did?: readonly number[];
    /** 只看这一刻以后开始的会话（开关打开的时刻；不给就不限） */
    since?: number;
    /** 记在事件的 contact 上（审计用，他的 QQ） */
    contact?: number;
}

/**
 * 结束了的桌面会话里，空闲时间的那部分 → 世界事件草稿（交给 sharedWorld.recordEvents）。
 * 「结束了」：最后一轮以后 DESKTOP_GAP_MS 没有新回合，而且租约不在（插件说他还在就再等等）。
 * 一段被饭点、课、别的事切开时分成几件，每件 id 是 desktop-session:<那一件开始的毫秒>；短于 DESKTOP_MIN_MS 的那一件不记。
 * 调用方应在读过世界之后调（settlingWorld 先排到现在、revise 把排着的空闲活动停在会话开始），这样队列里的空闲活动已经让出来了。
 */
export function desktopWorldEvents(input: DesktopEventsInput): LifeEventDraft[] {
    const { now } = input;
    const lease = input.lease !== undefined && leaseActive(input.lease, now);
    const known = new Set(input.events.map(event => event.id));
    const taken = [
        ...input.events.filter(event => event.result !== 'failed' && !event.id.startsWith(DESKTOP_EVENT_PREFIX))
            .map(event => ({ start: Date.parse(event.startedAt), end: Date.parse(event.endedAt) })),
        ...(input.pending ?? []).filter(item => item.event.result !== 'failed')
            .map(item => ({ start: Date.parse(item.event.startedAt ?? item.event.at), end: Date.parse(item.event.at) })),
    ].filter(span => Number.isFinite(span.start) && Number.isFinite(span.end) && span.end > span.start);
    const sessions = sessionsUntil(input.turns, now);
    const drafts: LifeEventDraft[] = [];
    sessions.forEach((session, index) => {
        const closed = now - session.end >= DESKTOP_GAP_MS && !(lease && index === sessions.length - 1);
        if (!closed || session.end < now - DESKTOP_LOOKBACK_MS) return;
        if (input.since !== undefined && session.start < input.since) return;
        const end = Math.min(session.end, session.start + DESKTOP_SESSION_MAX_MS);
        if (end - session.start < DESKTOP_MIN_MS) return;
        const did = (input.did ?? []).some(at => at >= session.start && at <= session.end);
        for (const part of freeParts(session.start, end, input, taken)) {
            if (part.end - part.start < DESKTOP_MIN_MS) continue;
            const id = `${DESKTOP_EVENT_PREFIX}${part.start}`;
            if (known.has(id)) continue;
            drafts.push({
                id, kind: did ? 'work_on_project' : 'leisure',
                startedAt: new Date(part.start).toISOString(), at: new Date(part.end).toISOString(),
                source: 'external', result: 'succeeded', subject: DESKTOP_SUBJECT,
                ...(did ? { target: DESKTOP_TARGET } : {}),
                ...(input.contact !== undefined ? { contact: input.contact } : {}),
            });
        }
    });
    return drafts;
}

/**
 * start 到 end 之间她作息上空闲、没说过睡了、没被别的事占着的那几段。按整分钟取样（课、饭点都在整分钟开始），
 * 第一段从 start 起、最后一段到 end 止
 */
function freeParts(start: number, end: number, input: Pick<DesktopEventsInput, 'stateAt' | 'asleep'>, taken: readonly { start: number; end: number }[]): { start: number; end: number }[] {
    const free = (at: number) => {
        if (taken.some(span => at >= span.start && at < span.end)) return false;
        const date = new Date(at);
        if (input.asleep?.(date)) return false;
        return input.stateAt(date)?.activity.kind === 'free';
    };
    const points = [start];
    for (let t = Math.floor(start / MINUTE) * MINUTE + MINUTE; t < end; t += MINUTE) points.push(t);
    const parts: { start: number; end: number }[] = [];
    let open: number | undefined;
    for (const at of points) {
        if (free(at)) open ??= at;
        else if (open !== undefined) { parts.push({ start: open, end: at }); open = undefined; }
    }
    if (open !== undefined) parts.push({ start: open, end });
    // 被占着的事在两个取样点之间开始的（取样是整分钟，事件账的事也是整分钟开始，一般碰不到）：截到它开始
    return parts.map(part => ({
        start: part.start,
        end: Math.min(part.end, ...taken.filter(span => span.start > part.start && span.start < part.end).map(span => span.start)),
    })).filter(part => part.end > part.start);
}

/** 此刻被他叫上电脑、本来在干嘛（只有上课和该睡了两种；空闲、课间不算冲突） */
export interface DesktopCalled {
    overlaps: 'class' | 'sleep';
    /** 这一段从几点开始（毫秒） */
    since: number;
}

/**
 * 他此刻在电脑前，而且这一段开始的时候她作息上本来在上课 / 该睡了（或者已经说过睡了）：给 her-now 的 desktopCalled。
 * 不在、开始时空闲或课间、没开作息都返回 undefined
 */
export function desktopCalled(input: {
    turns: readonly PresenceTurn[];
    lease?: unknown;
    now: number;
    stateAt: (at: Date) => { activity: Activity } | undefined;
    asleep?: (at: Date) => boolean;
}): DesktopCalled | undefined {
    const presence = presenceAt({ ...(input.lease !== undefined ? { lease: input.lease } : {}), turns: input.turns, now: input.now });
    if (!presence.with || presence.since === undefined) return undefined;
    const since = presence.since;
    if (input.asleep?.(new Date(since))) return { overlaps: 'sleep', since };
    const overlap = sessionOverlap({ start: since }, input.stateAt)?.overlaps;
    return overlap === 'class' || overlap === 'sleep' ? { overlaps: overlap, since } : undefined;
}
