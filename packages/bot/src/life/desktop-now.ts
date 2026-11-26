// 「他是不是正在电脑前 / 刚在电脑上聊过」接进 QQ 这边的几道闸（ADR 0347 第 3 层 B 块「此刻」，开关 desktopDay，
// 方案 docs/plans/2026-11-22-same-her-layer3-writeback.md §2.2，研究 docs/research/2026-11-22-private-companion-v2.md 建议 2）。
//
// - 读两样：灵魂目录的 desktop-presence.json（插件写的在场租约）、数据目录的 memory/desktop-log.jsonl（QQ 自己收的桌面回合）。
//   在不在按 desktop-presence.ts 的 presenceAt：租约作数就听租约，否则看最后一轮在不在 10 分钟以内。
// - 给主动消息（desktopProactiveHooks → planner-host 的 desktop 依赖 → ProactiveInput 的 desktopWith / lastDesktopAt / desktopTurns）、
//   留话（outboxDesktopBlock：他在电脑前就先留着，走了 10 分钟以上再发）和 NOW.md（desktopPresence）用。
// - 原文只在内存里给 blockReason 认「晚安」，不进日志、不落盘、不进提示词（方案 §2.8）。
// - 读不到（不是「没有」）就当他不在电脑前、照原来的规矩走，只记一次日志，不记内容。
// 只有 App 在 desktopDay 和 crossRecent 都开着时才建它；不建就什么都不变。

import { readFileSync, statSync } from 'node:fs';
import { desktopLogPath, desktopTurns, type DesktopLogOps, type DesktopLogTurn } from '../memory/desktop-log.ts';
import type { DesktopTurnText } from '../proactive/proactive.ts';
import { desktopPresencePath, desktopUserActivityAt, justLeft, PRESENCE_FUTURE_SLACK_MS, presenceAt, type Presence, type PresenceTurn } from './desktop-presence.ts';

/** 留话：他在电脑前时先留着不发的原因（和 app.ts 的「主动留话：先留着不发（…）」日志拼在一起） */
export const OUTBOX_DESKTOP_REASON = '他就在电脑前';
/** 留话：他离开电脑这么久以后才发（方案 §2.2-3） */
export const OUTBOX_AWAY_MS = 10 * 60_000;

/** 桌面这边的两份输入；测试里可以直接给 */
export interface DesktopNowSource {
    /** 14 天以内的桌面回合，按时间排好 */
    turns(now: number): readonly DesktopLogTurn[];
    /** desktop-presence.json 原样（没有文件 / 读不了是 undefined），presenceAt 自己校验 */
    lease(): unknown;
}

/** 给 planner-host 的那三项（ProactiveInput 同名） */
export interface DesktopProactiveHooks {
    desktopWith: (now: number) => boolean;
    lastDesktopAt: (now: number) => number | undefined;
    desktopTurns: (now: number) => readonly DesktopTurnText[];
}

const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const missing = (error: unknown) => errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';
const describe = (error: unknown) => errorCode(error) ?? (error instanceof SyntaxError ? '格式不对' : error instanceof Error ? error.name : '未知');

export interface DesktopNowSourceOptions {
    dataDir: string;
    soulDir: string;
    log?: (message: string) => void;
    /** 测试换掉账本的文件读写 */
    ops?: DesktopLogOps;
}

/**
 * 从文件读的那一份。账本按（修改时间、大小、分钟）缓存：留话每 30 秒问一次、主动消息到点问几次，同一分钟里没变就不重读。
 * 读不了只记一次（恢复了再记一次），当作没有。
 */
export function desktopNowSource(options: DesktopNowSourceOptions): DesktopNowSource {
    const { dataDir, soulDir, log } = options;
    const logFile = desktopLogPath(dataDir);
    const leaseFile = desktopPresencePath(soulDir);
    let cache: { key: string; turns: readonly DesktopLogTurn[] } | undefined;
    const failing = new Set<string>();
    const fail = (what: string, error: unknown) => {
        if (failing.has(what)) return;
        failing.add(what);
        log?.(`桌面：${what}读不了（${describe(error)}），先当他不在电脑前`);
    };
    const recover = (what: string) => {
        if (failing.delete(what)) log?.(`桌面：${what}又读得到了`);
    };
    return {
        turns(now) {
            try {
                let key: string;
                try {
                    const stat = statSync(logFile);
                    key = `${stat.mtimeMs}:${stat.size}:${Math.floor(now / 60_000)}`;
                } catch (error) {
                    if (!missing(error)) throw error;
                    recover('桌面记录');
                    cache = undefined;
                    return [];
                }
                if (cache?.key !== key) cache = { key, turns: desktopTurns(dataDir, now, { ...(log ? { log } : {}), ...(options.ops ? { ops: options.ops } : {}) }) };
                recover('桌面记录');
                return cache.turns;
            } catch (error) {
                fail('桌面记录', error);
                return [];
            }
        },
        lease() {
            try {
                const value: unknown = JSON.parse(readFileSync(leaseFile, 'utf8'));
                recover('在场租约');
                return value;
            } catch (error) {
                if (missing(error)) { recover('在场租约'); return undefined; }
                fail('在场租约', error);
                return undefined;
            }
        },
    };
}

/** 此刻他在不在电脑前（租约优先、回合兜底） */
export function desktopPresence(source: DesktopNowSource, now: number): Presence {
    return presenceAt({ lease: source.lease(), turns: source.turns(now), now });
}

/** 桌面上用户最近开口的时刻；晚于现在 1 分钟以上的回合不信（同 presenceAt） */
export function lastDesktopTurnAt(turns: readonly PresenceTurn[], now: number): number | undefined {
    let last: number | undefined;
    for (const turn of turns) {
        if (!Number.isFinite(turn.at) || turn.at > now + PRESENCE_FUTURE_SLACK_MS) continue;
        const at = desktopUserActivityAt(turn);
        if (last === undefined || at > last) last = at;
    }
    return last;
}

/** 给主动消息的三项（planner-host 的 desktop 依赖） */
export function desktopProactiveHooks(source: DesktopNowSource): DesktopProactiveHooks {
    return {
        desktopWith: now => desktopPresence(source, now).with,
        lastDesktopAt: now => lastDesktopTurnAt(source.turns(now), now),
        desktopTurns: now => source.turns(now),
    };
}

/**
 * 留话的闸（方案 §2.2-3，加在 app.ts drainOutbox 的 blocked 里）：他在电脑前，或者离开还不到 OUTBOX_AWAY_MS，就返回「他就在电脑前」，留话原样留着；
 * 走了 10 分钟以上返回 undefined，照原来的规矩发（留话超过 OUTBOX_MAX_AGE_MS 的照旧不发）。
 * 回合兜底从最近一次开口算；租约结束 / 过期的从最后确知他在的时刻算。
 */
export function outboxDesktopBlock(source: DesktopNowSource, now: number, awayMs = OUTBOX_AWAY_MS): string | undefined {
    const lease = source.lease();
    const turns = source.turns(now);
    if (presenceAt({ lease, turns, now }).with) return OUTBOX_DESKTOP_REASON;
    return justLeft({ lease, turns, now, windowMs: awayMs }) ? OUTBOX_DESKTOP_REASON : undefined;
}
