// 重启记录（任务书 T3a）：每次重启 / 上线追加一行到 <数据目录>/restarts.log，上线前检查据此拦「不满 48 小时就再上一个变量」。
// 为什么：10-12 一天重启 6 次，「一次一个开关、看 48 小时」靠口头约定守不住；现在让脚本能拦。
// 行是 JSON：{ at, to, kind, reason, by }。kind：
//   behavior  代码 / 配置的改动会改变她的行为或多一个变量——计入 48 小时
//   safety    修故障 / 安全——不计入，但上线前检查要 --safety "<理由>" 才放行
//   recovery  整机重启 / 崩溃后恢复，同一版代码——不计入

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const RESTART_KINDS = ['behavior', 'safety', 'recovery'] as const;
export type RestartKind = (typeof RESTART_KINDS)[number];

/** 两次「行为变化」的重启之间至少隔这么久 */
export const BEHAVIOR_GAP_MS = 48 * 3_600_000;

export interface RestartEntry {
    /** 重启的时刻（ISO） */
    at: string;
    /** 跑起来的提交（或分支名） */
    to: string;
    kind: RestartKind;
    reason: string;
    by: string;
}

export function parseRestartLog(text: string): RestartEntry[] {
    const entries: RestartEntry[] = [];
    for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try {
            const entry = JSON.parse(line) as Partial<RestartEntry>;
            if (typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at)) && typeof entry.to === 'string'
                && (RESTART_KINDS as readonly string[]).includes(entry.kind as string)) {
                entries.push({ at: entry.at, to: entry.to, kind: entry.kind as RestartKind, reason: String(entry.reason ?? ''), by: String(entry.by ?? '') });
            }
        } catch { /* 坏行跳过 */ }
    }
    return entries.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

export function readRestartLog(path: string): RestartEntry[] {
    return existsSync(path) ? parseRestartLog(readFileSync(path, 'utf8')) : [];
}

/** 最近一次计入 48 小时的重启（kind = behavior） */
export function lastBehaviorRestart(entries: readonly RestartEntry[]): RestartEntry | undefined {
    return [...entries].reverse().find(entry => entry.kind === 'behavior');
}

export function appendRestart(path: string, entry: RestartEntry): void {
    if (!Number.isFinite(Date.parse(entry.at))) throw new Error(`时间不对：${entry.at}`);
    if (!entry.to.trim()) throw new Error('--to 不能空：写这次跑起来的提交');
    if (!entry.reason.trim()) throw new Error('--reason 不能空：写为什么重启');
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, 'utf8');
}

export interface GapVerdict {
    ok: boolean;
    /** 距上一次行为变化的重启过了多少毫秒；没有记录是 undefined */
    sinceMs?: number;
    last?: RestartEntry;
}

/** 距上一次「行为变化」的重启够不够 48 小时；没有记录算够（但检查脚本会提示记录是空的） */
export function behaviorGap(entries: readonly RestartEntry[], now: Date, gapMs = BEHAVIOR_GAP_MS): GapVerdict {
    const last = lastBehaviorRestart(entries);
    if (!last) return { ok: true };
    const sinceMs = now.getTime() - Date.parse(last.at);
    return { ok: sinceMs >= gapMs, sinceMs, last };
}
