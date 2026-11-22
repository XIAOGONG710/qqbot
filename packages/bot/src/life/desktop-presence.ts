// 「他是不是正在电脑前陪着她」（ADR 0347 第 3 层地基，方案 docs/plans/2026-11-22-same-her-layer3-writeback.md §2.1「会话」，
// 研究 docs/research/2026-11-22-private-companion-v2.md 建议 2「桌面在场租约」、建议 4「对账口径」）。只是纯函数，还没接线，不改她的言行。
//
// 两路证据，租约优先：
// 1. 租约：DSH 插件在会话开始、每隔几分钟、结束时往灵魂目录写一份 desktop-presence.json（格式见 PresenceLease）。
//    还在有效期（renewedAt + ttlMs ≥ 现在）、没写 ended、时间不比现在晚 1 分钟以上，就算他在。插件崩了不用管，过期自然失效。
// 2. 兜底：租约缺失 / 过期 / 已结束 / 时间不对时，从桌面回合（desktop-recent.jsonl / 方案里的 desktop-log 的 { at, userAt? }）反推：
//    相邻两轮之间安静不到 EPISODE_GAP_MS（45 分钟，和长期记忆切片段同一个间隔，方案 :39、:77）算同一段；
//    最后一轮在 CHATTING_WINDOW_MS（10 分钟，和 NOW.md「和你聊天中」同一个窗口）以内就算他在。
// 和作息重叠只给标签（本来在睡 / 上课 / 课间 / 空闲），不决定怎么说——措辞是她的事，以后单独问她（研究建议 4、方案 §2.6）。
// 不读文件、不落盘、不记日志；读 JSON、接进闸门由调用方做。

import { join } from 'node:path';
import { EPISODE_GAP_MS } from '../memory/episodes.ts';
import { CHATTING_WINDOW_MS } from './now-export.ts';
import type { Activity } from './schedule.ts';

/** 租约文件名（放在灵魂目录下，插件写、QQ 只读） */
export const DESKTOP_PRESENCE_FILE = 'desktop-presence.json';
export const PRESENCE_KIND = 'dsh-presence';
export const PRESENCE_VERSION = 1;
/** 租约 / 回合的时间比现在晚这么多以内当作两台钟没对齐，再晚就不信（方案 §2.1：晚 1 分钟以上的行跳过） */
export const PRESENCE_FUTURE_SLACK_MS = 60_000;
/** ttlMs 的合理范围（研究 §三 1：外部活动租约限 30–3600 秒）；超出算格式不对，免得插件写错一个大数让她「永远在陪他」 */
export const PRESENCE_TTL_MIN_MS = 30_000;
export const PRESENCE_TTL_MAX_MS = 3_600_000;
/** 回合之间安静这么久算新的一段（和长期记忆切片段一致） */
export const DESKTOP_GAP_MS = EPISODE_GAP_MS;
/** 最后一轮在这么久以内算他还在电脑前（和 NOW.md 的「和你聊天中」一致） */
export const DESKTOP_WITH_MS = CHATTING_WINDOW_MS;
/** 旧格式没有 userAt 时，一轮的开始取 at 往前推这么久（方案 §2.1） */
export const TURN_LEAD_MS = 2 * 60_000;

export const desktopPresencePath = (soulDir: string): string => join(soulDir, DESKTOP_PRESENCE_FILE);

/** 插件写的在场租约（纯 JSON；时间都是 ISO） */
export interface PresenceLease {
    kind: typeof PRESENCE_KIND;
    version: typeof PRESENCE_VERSION;
    /** 插件给这一段起的 id，续租时不变 */
    session: string;
    startedAt: string;
    /** 最近一次心跳 */
    renewedAt: string;
    /** 心跳之后多久没再续就失效 */
    ttlMs: number;
    /** 插件明确结束（窗口关了 / 他走了）时写上 */
    ended?: string;
}

/** 一轮桌面对话里用得到的时间（毫秒）：at 是一轮结束，userAt 是他开口（插件新加的字段，可缺） */
export interface PresenceTurn {
    at: number;
    userAt?: number;
}

export interface DesktopSession<T extends PresenceTurn = PresenceTurn> {
    /** 第一轮他开口的时刻（没有 userAt 就是 at − TURN_LEAD_MS） */
    start: number;
    /** 最后一轮结束的时刻 */
    end: number;
    turns: T[];
}

export interface Presence {
    with: boolean;
    /** 这一段从几点开始（with 时才有） */
    since?: number;
    /** 不再续 / 不再有新回合的话，到几点就不算在了（with 时才有） */
    until?: number;
    /** 谁判的「在」；不在时是 none */
    source: 'lease' | 'turns' | 'none';
}

const isIso = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));

/** 格式对不对（插件按同样的条件写） */
export function isPresenceLease(value: unknown): value is PresenceLease {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const lease = value as PresenceLease;
    return lease.kind === PRESENCE_KIND && lease.version === PRESENCE_VERSION
        && typeof lease.session === 'string' && lease.session.length > 0
        && isIso(lease.startedAt) && isIso(lease.renewedAt) && Date.parse(lease.startedAt) <= Date.parse(lease.renewedAt)
        && typeof lease.ttlMs === 'number' && Number.isFinite(lease.ttlMs) && lease.ttlMs >= PRESENCE_TTL_MIN_MS && lease.ttlMs <= PRESENCE_TTL_MAX_MS
        && (lease.ended === undefined || isIso(lease.ended));
}

/** 时间不比现在晚太多（两台钟差 1 分钟以内照收） */
const notFuture = (lease: PresenceLease, now: number) =>
    Date.parse(lease.startedAt) <= now + PRESENCE_FUTURE_SLACK_MS && Date.parse(lease.renewedAt) <= now + PRESENCE_FUTURE_SLACK_MS;

/** 租约此刻是否作数：格式对、没结束、不在未来、还在有效期 */
export function leaseActive(lease: unknown, now: number): lease is PresenceLease {
    return isPresenceLease(lease) && lease.ended === undefined && notFuture(lease, now)
        && Date.parse(lease.renewedAt) + lease.ttlMs >= now;
}

const turnStart = (turn: PresenceTurn) =>
    turn.userAt !== undefined && Number.isFinite(turn.userAt) ? Math.min(turn.userAt, turn.at) : turn.at - TURN_LEAD_MS;

/**
 * 按时间切成一段一段：上一轮结束到下一轮他开口，安静不到 gapMs 算同一段（和 splitEpisodes 一样是「小于」）。
 * at 不是有限数的回合丢掉；按 at 排序（输入顺序不要求），同一时刻保持原顺序。
 */
export function sessionsFromTurns<T extends PresenceTurn>(turns: readonly T[], gapMs = DESKTOP_GAP_MS): DesktopSession<T>[] {
    const sorted = turns.filter(turn => Number.isFinite(turn.at)).map((turn, index) => ({ turn, index }))
        .sort((a, b) => a.turn.at - b.turn.at || a.index - b.index).map(item => item.turn);
    const sessions: DesktopSession<T>[] = [];
    for (const turn of sorted) {
        const current = sessions.at(-1);
        const start = turnStart(turn);
        if (current && start - current.end < gapMs) {
            current.turns.push(turn);
            current.end = Math.max(current.end, turn.at);
        } else {
            sessions.push({ start, end: turn.at, turns: [turn] });
        }
    }
    return sessions;
}

export interface PresenceInput<T extends PresenceTurn = PresenceTurn> {
    /** 读到的 desktop-presence.json 原样（没有文件就 undefined），这里校验 */
    lease?: unknown;
    turns: readonly T[];
    now: number;
    /** 最后一轮多久以内算还在（默认 DESKTOP_WITH_MS） */
    withinMs?: number;
    gapMs?: number;
}

/** 晚于现在 1 分钟以上的回合不信（方案 §2.1），切段前先去掉 */
const pastSessions = <T extends PresenceTurn>(input: PresenceInput<T>) =>
    sessionsFromTurns(input.turns.filter(turn => turn.at <= input.now + PRESENCE_FUTURE_SLACK_MS), input.gapMs);

/** 此刻他在不在电脑前：租约作数就听租约，否则看最后一段回合 */
export function presenceAt<T extends PresenceTurn>(input: PresenceInput<T>): Presence {
    const { lease, now } = input;
    if (leaseActive(lease, now)) {
        return { with: true, since: Date.parse(lease.startedAt), until: Date.parse(lease.renewedAt) + lease.ttlMs, source: 'lease' };
    }
    const withinMs = input.withinMs ?? DESKTOP_WITH_MS;
    const last = pastSessions(input).at(-1);
    if (last && now - last.end <= withinMs) return { with: true, since: last.start, until: last.end + withinMs, source: 'turns' };
    return { with: false, source: 'none' };
}

export interface JustLeft {
    /** 最后一次确知他在的时刻：结束的租约取 ended，过期的取最后一次心跳，回合取最后一轮结束 */
    at: number;
    /** 那一段从几点开始 */
    since: number;
    source: 'lease' | 'turns';
}

/**
 * 「刚陪完」（以后给主动消息、留话的闸门用）：此刻已经不在，而且最后确知他在的时刻离现在不超过 windowMs（含边界）。
 * 租约和回合都有结束时刻时取较晚的那个，一样晚算租约；时间在未来的租约不算。还在陪着就不是「刚陪完」。
 */
export function justLeft<T extends PresenceTurn>(input: PresenceInput<T> & { windowMs: number }): JustLeft | undefined {
    if (presenceAt(input).with) return undefined;
    const { lease, now } = input;
    let best: JustLeft | undefined;
    if (isPresenceLease(lease) && notFuture(lease, now)) {
        const since = Date.parse(lease.startedAt);
        const at = lease.ended !== undefined ? Math.max(since, Date.parse(lease.ended)) : Date.parse(lease.renewedAt);
        best = { at, since, source: 'lease' };
    }
    const last = pastSessions(input).at(-1);
    if (last && (!best || last.end > best.at)) best = { at: last.end, since: last.start, source: 'turns' };
    if (!best || best.at > now || now - best.at > input.windowMs) return undefined;
    return best;
}

/** 这段桌面会话开始时她作息上本来在干嘛（只是标签，不带措辞） */
export interface ScheduleOverlap {
    overlaps: Activity['kind'];
}

/**
 * 和作息对账（研究建议 4、方案 §2.6）：按会话开始那一刻的作息给标签——sleep 本来在睡、class 本来在上课、between 课间 / 赶去上课、free 空闲。
 * 不把那段课或觉改成没发生，也不算完成了别的事；怎么讲那段时间以后单独定。没开作息（stateAt 返回 undefined）就没有标签。
 */
export function sessionOverlap(session: Pick<DesktopSession, 'start'>, stateAt: (at: Date) => { activity: Activity } | undefined): ScheduleOverlap | undefined {
    const state = stateAt(new Date(session.start));
    return state ? { overlaps: state.activity.kind } : undefined;
}
