// DSH → QQ 的只追加收件箱（ADR 0226）。DSH 只负责提交“已经发生”的脱敏摘要，QQ 侧在自己的账和闸里落地。
// 收件箱不是提示词：每行都要经过版本、时间、字段和事件类型校验，并用状态文件按 id 去重。

import { mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import type { Timeline } from './timeline.ts';
import type { LifeEventDraft } from '../world/life-events.ts';
import type { WorldState } from '../world/world.ts';

export interface DshTimelineInboxEntry {
    id: string;
    at: string;
    kind: string;
    summary: string;
    ok?: boolean;
}

export interface DshWorldInboxEntry {
    id: string;
    at: string;
    startedAt?: string;
    kind: string;
    result: 'succeeded' | 'failed' | 'interrupted';
    subject?: string;
    reason?: string;
    meal?: boolean;
    amount?: number;
    seen?: boolean;
}

const INBOX_MAX_AGE_MS = 30 * 86_400_000;
const FUTURE_GRACE_MS = 60_000;
const KEEP_IDS = 2_000;
const ID_RE = /^[A-Za-z0-9:_-]{8,160}$/;
const KIND_RE = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const DSH_WORLD_EVENT_KINDS = new Set([
    'sleep', 'eat', 'meet', 'attend_class', 'study', 'rest', 'read_book', 'leisure', 'work_on_project', 'interact_npc',
    'feed_cat', 'pick_parcel', 'finish_homework', 'family_call', 'receive_money',
]);
const RESULTS = new Set<DshWorldInboxEntry['result']>(['succeeded', 'failed', 'interrupted']);
const UNSAFE_TEXT = /https?:\/\/|(?:[A-Za-z]:[\\/]|(?:^|\s)\\\\|(?:^|\s)\/(?:Users|home|var|tmp)\b)|(?:api[_-]?key|token|password|密码|令牌)/i;

interface InboxState {
    version: 2;
    /** 已经扫描过的完整行数；收件箱是只追加文件，避免超过 KEEP_IDS 后重复应用旧事件。 */
    line: number;
    ids: string[];
}

const validState = (value: unknown): value is InboxState => {
    if (!value || typeof value !== 'object') return false;
    const row = value as { version?: unknown; line?: unknown; ids?: unknown };
    return (row.version === 1 || row.version === 2)
        && (row.version === 1 || (Number.isSafeInteger(row.line) && (row.line as number) >= 0))
        && Array.isArray(row.ids)
        && row.ids.every(id => typeof id === 'string' && ID_RE.test(id));
};

const flat = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) return undefined;
    return [...text].slice(0, max).join('');
};

const timeInWindow = (value: unknown, now: number): value is string => {
    if (typeof value !== 'string') return false;
    const at = Date.parse(value);
    return Number.isFinite(at) && at <= now + FUTURE_GRACE_MS && at >= now - INBOX_MAX_AGE_MS;
};

function readState(path: string, log: (message: string) => void): InboxState {
    const state = readJsonOr<InboxState>(path, { version: 2, line: 0, ids: [] }, message => log(`DSH 收件箱状态：${message}`), {
        label: 'DSH 收件箱状态',
        validate: validState,
    });
    return { version: 2, line: state.version === 2 ? state.line : 0, ids: state.ids.slice(-KEEP_IDS) };
}

function writeState(path: string, state: InboxState): void {
    mkdirSync(dirname(path), { recursive: true });
    writeJsonAtomic(path, { version: 2, line: state.line, ids: state.ids.slice(-KEEP_IDS) });
}

function lines(path: string, from: number, log: (message: string) => void): { values: { text: string; line: number }[]; nextLine: number } {
    if (!existsSync(path)) return { values: [], nextLine: from };
    try {
        const text = readFileSync(path, 'utf8');
        const parts = text.split('\n');
        // DSH 可能正在追加最后一行；没有换行结尾的片段留到下一轮，避免半行 JSON 被永久跳过。
        const complete = text.endsWith('\n') ? parts.slice(0, -1) : parts.slice(0, -1);
        const start = from <= complete.length ? from : 0;
        return {
            values: complete.slice(start)
                .map((text, index) => ({ text: text.trim(), line: start + index }))
                .filter(row => Boolean(row.text)),
            nextLine: complete.length,
        };
    } catch (error) {
        log(`DSH 收件箱：读取失败（${error instanceof Error ? error.message : String(error)}）`);
        return { values: [], nextLine: from };
    }
}

function parseTimeline(value: unknown, now: number): DshTimelineInboxEntry | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const row = value as Partial<DshTimelineInboxEntry>;
    const kind = flat(row.kind, 40);
    const summary = flat(row.summary, 80);
    if (typeof row.id !== 'string' || !ID_RE.test(row.id) || !kind || !KIND_RE.test(kind) || !summary || UNSAFE_TEXT.test(summary) || !timeInWindow(row.at, now)) return undefined;
    if (row.ok !== undefined && typeof row.ok !== 'boolean') return undefined;
    return { id: row.id, at: row.at!, kind, summary, ...(row.ok === false ? { ok: false } : {}) };
}

function parseWorld(value: unknown, now: number): DshWorldInboxEntry | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const row = value as Partial<DshWorldInboxEntry>;
    const kind = flat(row.kind, 40);
    const subject = flat(row.subject, 40);
    const reason = flat(row.reason, 80);
    if (typeof row.id !== 'string' || !ID_RE.test(row.id) || !kind || !KIND_RE.test(kind) || !DSH_WORLD_EVENT_KINDS.has(kind)) return undefined;
    if (!timeInWindow(row.at, now) || typeof row.result !== 'string' || !RESULTS.has(row.result as DshWorldInboxEntry['result'])) return undefined;
    if (row.startedAt !== undefined && !timeInWindow(row.startedAt, now)) return undefined;
    if ((subject && UNSAFE_TEXT.test(subject)) || (reason && UNSAFE_TEXT.test(reason))) return undefined;
    if (row.startedAt !== undefined && Date.parse(row.startedAt) > Date.parse(row.at!)) return undefined;
    if (row.meal !== undefined && typeof row.meal !== 'boolean') return undefined;
    if (row.seen !== undefined && typeof row.seen !== 'boolean') return undefined;
    if (row.amount !== undefined && (!Number.isSafeInteger(row.amount) || row.amount <= 0 || row.amount > 50_000)) return undefined;
    return {
        id: row.id, at: row.at!, kind, result: row.result as DshWorldInboxEntry['result'],
        ...(row.startedAt ? { startedAt: row.startedAt } : {}),
        ...(subject ? { subject } : {}), ...(reason ? { reason } : {}),
        ...(row.meal !== undefined ? { meal: row.meal } : {}),
        ...(row.amount !== undefined ? { amount: row.amount } : {}),
        ...(row.seen !== undefined ? { seen: row.seen } : {}),
    };
}

function consume<T extends { id: string }>(path: string, statePath: string, parse: (value: unknown, now: number) => T | undefined, apply: (entry: T) => void, now: number, log: (message: string) => void): number {
    if (!existsSync(path)) return 0;
    const state = readState(statePath, log);
    const seen = new Set(state.ids);
    const batch = lines(path, state.line, log);
    let nextLine = batch.nextLine;
    let added = 0;
    for (const row of batch.values) {
        let raw: unknown;
        try { raw = JSON.parse(row.text); } catch { continue; }
        const entry = parse(raw, now);
        if (!entry) continue;
        const id = entry.id;
        if (seen.has(id)) continue;
        try {
            apply(entry);
            seen.add(id);
            state.ids.push(id);
            added++;
        } catch (error) {
            log(`DSH 收件箱：${id} 应用失败（${error instanceof Error ? error.message : String(error)}）`);
            // 已通过校验的事实不能因为一次落账失败永久丢失；停在这一行，下轮从这里重试。
            // 后续行也先不处理，保持收件箱的提交顺序。
            nextLine = row.line;
            break;
        }
    }
    if (added || nextLine !== state.line) writeState(statePath, { version: 2, line: nextLine, ids: [...seen].slice(-KEEP_IDS) });
    return added;
}

export function consumeDshTimelineInbox(path: string, statePath: string, now: Date, timeline: Timeline, log: (message: string) => void): number {
    return consume(path, statePath, (value, at) => parseTimeline(value, at), entry => {
        timeline.record({ id: `dsh:${entry.id}`, at: new Date(entry.at), channel: 'desktop', kind: entry.kind, summary: entry.summary, ...(entry.ok === false ? { ok: false } : {}) });
    }, now.getTime(), log);
}

export function consumeDshWorldInbox(path: string, statePath: string, now: Date, world: WorldState, log: (message: string) => void): number {
    return consume(path, statePath, (value, at) => parseWorld(value, at), entry => {
        const draft: LifeEventDraft = {
            id: `dsh:${entry.id}`, kind: entry.kind, at: entry.at, source: 'external', result: entry.result,
            ...(entry.startedAt ? { startedAt: entry.startedAt } : {}), ...(entry.subject ? { subject: entry.subject } : {}),
            ...(entry.reason ? { reason: entry.reason } : {}), ...(entry.meal !== undefined ? { meal: entry.meal } : {}),
            ...(entry.amount !== undefined ? { amount: entry.amount } : {}), ...(entry.seen !== undefined ? { seen: entry.seen } : {}),
        };
        world.recordEvents([draft]);
    }, now.getTime(), log);
}
