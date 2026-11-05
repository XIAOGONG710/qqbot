import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileOps, readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { calendarDate, stateObject, stateTimestamp } from '../memory/state-schema.ts';
import type { MemeEntry, MemeFile } from './memes.ts';

export class MemeStoreLockError extends Error {
    readonly retryable: boolean;
    constructor(retryable = false) {
        super(retryable ? '热梗协调锁暂时繁忙，请稍后重试' : '热梗协调锁不可用；保留原文件，请修复后重试');
        this.name = 'MemeStoreLockError';
        this.retryable = retryable;
    }
}

/** SQLite is an OS mutex only; JSON remains the sole committed fact source. */
export function withMemeStoreLock<T>(path: string, work: () => T & (T extends PromiseLike<unknown> ? never : unknown)): T;
export function withMemeStoreLock<T>(path: string, work: () => T): T {
    let database: DatabaseSync | undefined, locked = false;
    try {
        try {
            mkdirSync(dirname(path), { recursive: true });
            database = new DatabaseSync(`${path}.coordination.sqlite`, { timeout: 50 });
            database.exec('BEGIN IMMEDIATE'); locked = true;
        } catch (error) {
            const code = (error as { errcode?: number } | null)?.errcode;
            throw new MemeStoreLockError(typeof code === 'number' && ((code & 255) === 5 || (code & 255) === 6));
        }
        const result = work();
        if (result && (typeof result === 'object' || typeof result === 'function') && typeof (result as { then?: unknown }).then === 'function') {
            void Promise.resolve(result).catch(() => {}); throw new TypeError('热梗协调锁只接受同步操作');
        }
        return result;
    } finally {
        if (locked) { try { database!.exec('ROLLBACK'); } catch { /* JSON publication is the commit point. */ } }
        try { database?.close(); } catch { /* Release failure cannot turn confirmed JSON into a replayable failure. */ }
    }
}

const counter = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function validEntry(value: unknown): value is MemeEntry {
    if (!stateObject(value)) return false;
    const firstSeen = value.firstSeen, lastSeen = value.lastSeen;
    return typeof value.term === 'string' && Boolean(value.term.trim()) && typeof value.meaning === 'string' && Boolean(value.meaning.trim())
        && typeof value.example === 'string' && (value.confidence === 'high' || value.confidence === 'mid')
        && typeof firstSeen === 'string' && typeof lastSeen === 'string' && calendarDate(firstSeen) && calendarDate(lastSeen) && firstSeen <= lastSeen
        && counter(value.seen) && value.seen >= 1 && (value.authorRevision === undefined || counter(value.authorRevision));
}
function validFile(value: unknown): value is MemeFile {
    if (!stateObject(value) || value.version !== 1) return false;
    const revision = value.revision, authorRevision = value.authorRevision, entries = value.entries;
    if (revision !== undefined && !counter(revision) || authorRevision !== undefined && !counter(authorRevision)) return false;
    return (value.refreshedAt === undefined || stateTimestamp(value.refreshedAt)) && (authorRevision ?? 0) <= (revision ?? 0)
        && Array.isArray(entries) && entries.every(validEntry)
        && new Set(entries.map(entry => entry.term)).size === entries.length
        && entries.every(entry => (entry.authorRevision ?? 0) <= (authorRevision ?? 0));
}

function readUnlocked(path: string): MemeFile {
    try { return readJsonOr<MemeFile>(path, { version: 1, entries: [] }, undefined, { validate: validFile, invalid: 'throw', label: '热梗库' }); }
    catch { throw new Error('热梗库读取或校验失败；保留原文件，拒绝把作者资料当空白重建'); }
}
export function readMemeFile(path: string): MemeFile { return withMemeStoreLock(path, () => readUnlocked(path)); }

function nextRevision(file: MemeFile): number {
    const previous = file.revision ?? 0;
    if (previous >= Number.MAX_SAFE_INTEGER) throw new Error('热梗修订计数已达到安全上限，保留原文件');
    return previous + 1;
}
function publish(path: string, file: MemeFile): MemeFile {
    if (!validFile(file)) throw new Error('热梗更新结构无效，原文件未改变');
    const bytes = `${JSON.stringify(file, null, 2)}\n`;
    try { writeJsonAtomic(path, file); }
    catch (error) {
        // An IO error after rename is not evidence that publication failed.
        try { if (fileOps.readFileSync(path, 'utf8') === bytes) return file; } catch { /* Preserve the original failure. */ }
        throw error;
    }
    return file;
}
const authorIdentity = (entry: MemeEntry) => {
    const { authorRevision: _revision, ...rest } = entry;
    return JSON.stringify(rest);
};
const meaningIdentity = (entry: MemeEntry) => JSON.stringify([entry.term, entry.meaning, entry.example, entry.confidence, entry.firstSeen]);

/** Author RMW. Explicitly touched terms also acquire a new identity on an ABA
 * replacement whose displayed text happens to be identical. */
export function updateMemes(path: string, work: (fresh: MemeFile) => MemeFile | undefined, options: { touch?: readonly string[] } = {}): MemeFile {
    return withMemeStoreLock(path, () => {
        const current = readUnlocked(path), revision = nextRevision(current);
        const proposed = work(structuredClone(current));
        if (proposed && typeof (proposed as unknown as { then?: unknown }).then === 'function') {
            void Promise.resolve(proposed).catch(() => {}); throw new TypeError('热梗更新只接受同步操作');
        }
        if (proposed === undefined) return current;
        if (!validFile(proposed)) throw new Error('热梗作者更新结构无效，原文件未改变');
        const previous = new Map(current.entries.map(entry => [entry.term, entry])), touched = new Set(options.touch ?? []);
        const entries = proposed.entries.map(entry => {
            const old = previous.get(entry.term);
            return { ...entry, authorRevision: touched.has(entry.term) || !old || authorIdentity(old) !== authorIdentity(entry) ? revision : old.authorRevision ?? 0 };
        });
        return publish(path, { ...current, ...proposed, entries, revision, authorRevision: revision });
    });
}
export function replaceMemes(path: string, file: MemeFile): MemeFile {
    if (!validFile(file)) throw new Error('热梗替换结构无效，原文件未改变');
    const frozen = structuredClone(file);
    return updateMemes(path, () => frozen, { touch: frozen.entries.map(entry => entry.term) });
}

export interface MemeRefreshDelta {
    terms: readonly string[];
    learned: readonly MemeEntry[];
    today: string;
    refreshedAt: string;
    keepDays: number;
    max: number;
    signal?: AbortSignal;
}

/** Apply background observations to fresh JSON, never the old whole snapshot.
 * No model, network, public callback or Date instance is invoked under lock. */
export function commitMemeRefresh(path: string, base: MemeFile, delta: MemeRefreshDelta): { file: MemeFile; added: number; bumped: number } {
    if (!calendarDate(delta.today) || !stateTimestamp(delta.refreshedAt)) throw new Error('热梗刷新日期无效');
    return withMemeStoreLock(path, () => {
        const current = readUnlocked(path), revision = nextRevision(current);
        delta.signal?.throwIfAborted();
        const entries = current.entries.map(entry => ({ ...entry })), byTerm = new Map(entries.map(entry => [entry.term, entry]));
        const previous = new Map(base.entries.map(entry => [entry.term, entry]));
        let added = 0, bumped = 0;
        const bump = (entry: MemeEntry) => {
            if (entry.seen >= Number.MAX_SAFE_INTEGER) throw new Error('热梗出现计数已达到安全上限，原文件未改变');
            entry.seen++; if (entry.lastSeen < delta.today) entry.lastSeen = delta.today; bumped++;
        };
        for (const term of delta.terms) {
            const old = previous.get(term), live = byTerm.get(term);
            if (old && live && (old.authorRevision ?? 0) === (live.authorRevision ?? 0) && meaningIdentity(old) === meaningIdentity(live)) bump(live);
        }
        // A global author generation protects absent terms without an unbounded
        // tombstone list: any intervening author intent defers new learning.
        if ((base.authorRevision ?? 0) === (current.authorRevision ?? 0)) for (const learned of delta.learned) {
            if (previous.has(learned.term)) continue;
            const live = byTerm.get(learned.term);
            if (live) bump(live);
            else { const entry = { ...learned, authorRevision: 0 }; entries.push(entry); byTerm.set(entry.term, entry); added++; }
        }
        const day = Math.floor(Date.parse(`${delta.today}T00:00:00Z`) / 86400000);
        const trimmed = entries.filter(entry => day - Math.floor(Date.parse(`${entry.lastSeen}T00:00:00Z`) / 86400000) <= delta.keepDays)
            .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen) || b.seen - a.seen).slice(0, delta.max);
        const refreshedAt = current.refreshedAt && Date.parse(current.refreshedAt) > Date.parse(delta.refreshedAt) ? current.refreshedAt : delta.refreshedAt;
        const next: MemeFile = { ...current, entries: trimmed, refreshedAt, revision };
        delta.signal?.throwIfAborted();
        return { file: publish(path, next), added, bumped };
    });
}
