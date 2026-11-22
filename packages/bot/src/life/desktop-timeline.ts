// 一段桌面会话记进时间线（ADR 0347 第 3 层 B 块，开关 desktopDay，方案 docs/plans/2026-11-22-same-her-layer3-writeback.md §2.2-4）。
//
// 一段会话结束（最后一轮以后 45 分钟没有新回合，而且租约也不再说他在这一场里）时，记一条
// { id: 'desktop-session:<开始毫秒>', channel: 'desktop', kind: 'session', summary }，at 是这一段开始的时刻。
// summary 只有时长和这一段里 desktop 渠道已有的动作类别（插件 timeline_record / memory_save 记的 kind，换成固定的几个说法），
// 比如「在电脑上陪他待了约 2 小时（中间查了资料、写了东西）」。**不放原文**：这里根本不读回合的 user / assistant，
// 别的条目的 summary 也不抄（方案 §2.8：时间线只放概述）。
// Timeline.record 同一个 id 只记一次，重启重算也安全；只补最近 24 小时里结束的，打开开关那一刻不会把 14 天的会话一口气灌进去。
// 要 timeline 开着才有地方记；记进去以后，QQ 回复和念头的连续性块（timeline.promptLine）就能看到「下午在电脑上陪了他两小时」。

import type { Timeline, TimelineEntry } from '../memory/timeline.ts';
import { leaseActive, sessionsFromTurns, DESKTOP_GAP_MS, PRESENCE_FUTURE_SLACK_MS, type DesktopSession, type PresenceTurn } from './desktop-presence.ts';

export const DESKTOP_SESSION_KIND = 'session';
export const DESKTOP_SESSION_PREFIX = 'desktop-session:';
/** 只补这么久以内结束的会话 */
export const DESKTOP_TIMELINE_LOOKBACK_MS = 24 * 3_600_000;
/** 动作的时刻在会话开始前这么久、结束后这么久以内都算这一段（插件记时间线和一轮结束不是同一刻） */
const ACTION_LEAD_MS = 60_000;
const ACTION_TAIL_MS = 5 * 60_000;
/** 动作类别最多说几种 */
const ACTION_MAX = 3;

/** 插件那边的动作类别 → 固定说法；不认识的一律「弄了点别的」，不把 kind 原样抄进来 */
const ACTION_LABELS: Readonly<Record<string, string>> = {
    search: '查了资料',
    web: '查了资料',
    read: '看了些东西',
    write: '写了东西',
    action: '帮他在电脑上弄了点事',
    memory_save: '记下了一件事',
};
const OTHER_LABEL = '弄了点别的';

export const desktopSessionId = (start: number): string => `${DESKTOP_SESSION_PREFIX}${start}`;

/** 时长：15 分钟以内「一会儿」，一小时以内按 5 分钟取整，再长按半小时取整 */
export function durationText(ms: number): string {
    const minutes = Math.max(0, ms) / 60_000;
    if (minutes < 15) return '一会儿';
    if (minutes < 55) return `约 ${Math.round(minutes / 5) * 5} 分钟`;
    const halves = Math.round(minutes / 30);
    return halves % 2 ? `约 ${(halves - 1) / 2} 个半小时` : `约 ${halves / 2} 小时`;
}

/** 时间线里一条动作（只看时间、渠道、类别、成没成） */
export type DesktopAction = Pick<TimelineEntry, 'at' | 'kind' | 'channel'> & Partial<Pick<TimelineEntry, 'ok' | 'id'>>;

/** 这一段里做过的动作类别（按先后、去重、最多 3 种）；只认 desktop 渠道做成了的，不算会话条目本身 */
export function sessionActions(session: Pick<DesktopSession, 'start' | 'end'>, entries: readonly DesktopAction[]): string[] {
    const labels: string[] = [];
    const inside = entries
        .filter(entry => entry.channel === 'desktop' && entry.ok !== false && entry.kind !== DESKTOP_SESSION_KIND && !entry.id?.startsWith(DESKTOP_SESSION_PREFIX))
        .map(entry => ({ at: Date.parse(entry.at), kind: entry.kind }))
        .filter(entry => Number.isFinite(entry.at) && entry.at >= session.start - ACTION_LEAD_MS && entry.at <= session.end + ACTION_TAIL_MS)
        .sort((a, b) => a.at - b.at);
    for (const entry of inside) {
        const label = Object.hasOwn(ACTION_LABELS, entry.kind) ? ACTION_LABELS[entry.kind]! : OTHER_LABEL;
        if (!labels.includes(label)) labels.push(label);
    }
    // 认识的排前面，「弄了点别的」放最后
    const known = labels.filter(label => label !== OTHER_LABEL);
    return [...known, ...(labels.includes(OTHER_LABEL) ? [OTHER_LABEL] : [])].slice(0, ACTION_MAX);
}

/** 一句概述：只有时长和动作类别 */
export function desktopSessionSummary(session: Pick<DesktopSession, 'start' | 'end'>, entries: readonly DesktopAction[] = []): string {
    const actions = sessionActions(session, entries);
    return `在电脑上陪他待了${durationText(session.end - session.start)}${actions.length ? `（中间${actions.join('、')}）` : ''}`;
}

export interface EndedSessionsInput<T extends PresenceTurn> {
    turns: readonly T[];
    now: number;
    /** desktop-presence.json 原样：还作数、而且是在这一段结束之前就开始的，就当这一场还没完 */
    lease?: unknown;
    gapMs?: number;
    lookbackMs?: number;
}

/** 已经结束的会话：最后一轮以后 gapMs 没有新回合、不在作数的租约里、结束在 lookbackMs 以内；晚于现在 1 分钟以上的回合不信 */
export function endedSessions<T extends PresenceTurn>(input: EndedSessionsInput<T>): DesktopSession<T>[] {
    const { now } = input;
    const gapMs = input.gapMs ?? DESKTOP_GAP_MS;
    const lookbackMs = input.lookbackMs ?? DESKTOP_TIMELINE_LOOKBACK_MS;
    const lease = leaseActive(input.lease, now) ? input.lease : undefined;
    return sessionsFromTurns(input.turns.filter(turn => turn.at <= now + PRESENCE_FUTURE_SLACK_MS), gapMs)
        .filter(session => now - session.end >= gapMs && now - session.end <= lookbackMs)
        .filter(session => !lease || Date.parse(lease.startedAt) > session.end);
}

/** 要记进时间线的那几条（已经记过的 id 不再给） */
export interface DesktopSessionRecord {
    id: string;
    at: Date;
    channel: 'desktop';
    kind: typeof DESKTOP_SESSION_KIND;
    summary: string;
    /** 只给日志用 */
    start: number;
    end: number;
}

export function desktopSessionRecords<T extends PresenceTurn>(input: EndedSessionsInput<T> & { entries: readonly DesktopAction[] }): DesktopSessionRecord[] {
    const recorded = new Set(input.entries.map(entry => entry.id).filter((id): id is string => typeof id === 'string'));
    return endedSessions(input)
        .filter(session => !recorded.has(desktopSessionId(session.start)))
        .map(session => ({
            id: desktopSessionId(session.start), at: new Date(session.start), channel: 'desktop', kind: DESKTOP_SESSION_KIND,
            summary: desktopSessionSummary(session, input.entries), start: session.start, end: session.end,
        }));
}

const two = (n: number) => String(n).padStart(2, '0');
const hm = (ms: number) => { const d = new Date(ms); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

/**
 * App 在收完桌面记录之后调（dsh-inbox 模块那一拍）：把结束了的会话记进时间线，返回新记了几条。
 * 日志只有起止时刻和分钟数（「桌面：一段 14:10–16:05（约 115 分钟）记进时间线」），不记内容。时间线读写失败只记日志、不抛。
 */
export function recordDesktopSessions<T extends PresenceTurn>(
    timeline: Pick<Timeline, 'read' | 'record'>, input: EndedSessionsInput<T>, log?: (message: string) => void,
): number {
    let records: DesktopSessionRecord[];
    try {
        records = desktopSessionRecords({ ...input, entries: timeline.read() });
    } catch (error) {
        log?.(`桌面：时间线读不了，会话这次不记（${error instanceof Error ? error.name : '未知'}）`);
        return 0;
    }
    let added = 0;
    for (const { start, end, ...entry } of records) {
        try {
            timeline.record(entry);
            added++;
            log?.(`桌面：一段 ${hm(start)}–${hm(end)}（约 ${Math.round((end - start) / 60_000)} 分钟）记进时间线`);
        } catch (error) {
            log?.(`桌面：一段 ${hm(start)}–${hm(end)} 没记进时间线（${error instanceof Error ? error.name : '未知'}）`);
        }
    }
    return added;
}
