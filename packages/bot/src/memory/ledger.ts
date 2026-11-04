// 只追加、哈希链的账本（ADR 0157）。设定改动、记忆改动都记在这种账本里。
// 为什么：10-25 用户给了 B 站一份「AI 伙伴的权利与能力清单」，其中一条是「客观记录、修改留痕和校验机制」——
// 「假如你回顾过去，没有发现重大矛盾，你怎么知道它真的没发生，而不是被悄悄抹去了？」
// 做法：每条记录带上一条的哈希，一条被改、被删、被插进去，后面的哈希全对不上；账本末尾的哈希另存一份（.head），
// 整段尾巴被截掉也能发现。这不是防住有管理员权限的人（他同时改账本和 .head 就改得掉），是让「悄悄改」留得下痕迹：
// 对得上就说明没人动过，对不上就知道从哪一条开始不对。
// 账本里只记「发生了什么、什么时候、谁、哈希」，不记聊天和记忆的原文。

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { stateObject, stateTimestamp } from './state-schema.ts';

export interface LedgerEntry {
    seq: number;
    /** ISO 时间 */
    at: string;
    kind: string;
    data: Record<string, unknown>;
    /** 上一条的哈希（第一条是 64 个 0） */
    prev: string;
    hash: string;
}

export const GENESIS_PREV = '0'.repeat(64);

/** 键排好序的 JSON（同样的内容永远同样的字符串），哈希才稳 */
export function canonical(value: unknown): string {
    return canonicalJson(JSON.parse(JSON.stringify(value) ?? 'null'));
}
function canonicalJson(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? 'null';
}

const HASH = /^[a-f0-9]{64}$/;
function validEntry(value: unknown): value is LedgerEntry {
    return stateObject(value) && Number.isSafeInteger(value.seq) && Number(value.seq) >= 0 && stateTimestamp(value.at)
        && typeof value.kind === 'string' && Boolean(value.kind.trim()) && stateObject(value.data)
        && typeof value.prev === 'string' && HASH.test(value.prev) && typeof value.hash === 'string' && HASH.test(value.hash);
}
export class LedgerWriteError extends Error {
    readonly retryable: boolean;
    constructor(message = '账本写入失败；原状态保留，请检查完整性后重试', retryable = false) { super(message); this.retryable = retryable; }
}
function readText(path: string): string | undefined {
    try { return readFileSync(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('账本文件读取失败'); }
}

export const sha256 = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex');

export function entryHash(entry: Omit<LedgerEntry, 'hash'>): string {
    return sha256(`${entry.seq}|${entry.at}|${entry.kind}|${canonical(entry.data)}|${entry.prev}`);
}

export interface VerifyResult {
    ok: boolean;
    count: number;
    /** 第一处对不上的是第几条（seq）；整条链都对但尾巴被截了时是最后一条之后 */
    brokenAt?: number;
    reason?: string;
}

export class Ledger {
    readonly path: string;
    readonly #headPath: string;

    constructor(path: string) {
        this.path = path;
        this.#headPath = `${path}.head`;
    }

    read(): LedgerEntry[] {
        const text = readText(this.path);
        if (text === undefined) return [];
        const entries: LedgerEntry[] = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const value: unknown = JSON.parse(line);
                if (!validEntry(value)) throw new Error('schema');
                entries.push(value);
            } catch {
                // 读不出来的一行留一个占位，verify 会在这里报断点，不能悄悄跳过
                entries.push({ seq: -1, at: '', kind: 'unreadable', data: {}, prev: '', hash: '' });
            }
        }
        return entries;
    }

    last(): LedgerEntry | undefined {
        return this.read().at(-1);
    }

    append(kind: string, data: Record<string, unknown>, at: Date = new Date()): LedgerEntry {
        let normalized: unknown;
        try { normalized = JSON.parse(JSON.stringify(data)); } catch { throw new LedgerWriteError('账本元数据不是有效JSON；未写入'); }
        if (!stateObject(normalized) || typeof kind !== 'string' || !kind.trim() || kind === 'unreadable'
            || !Number.isFinite(at.getTime()) || !stateTimestamp(at.toISOString())) throw new LedgerWriteError('账本记录无效；未写入');
        let db: DatabaseSync | undefined;
        let locked = false;
        try {
            try {
                mkdirSync(dirname(this.path), { recursive: true });
                db = new DatabaseSync(`${this.path}.coordination.sqlite`, { timeout: 50 });
                db.exec('BEGIN IMMEDIATE'); locked = true;
            } catch (error) {
                const code = (error as { errcode?: number })?.errcode;
                throw new LedgerWriteError('账本协调锁不可用；未追加，请稍后重试', typeof code === 'number' && [5, 6].includes(code & 255));
            }
            if (!this.verify().ok) throw new LedgerWriteError('账本完整性未通过；拒绝追加，原断点保留');
            const entries = this.read(); const last = entries.at(-1);
            const base = { seq: entries.length, at: at.toISOString(), kind, data: normalized, prev: last?.hash ?? GENESIS_PREV };
            const entry: LedgerEntry = { ...base, hash: entryHash(base) };
            const before = readText(this.path) ?? '';
            const suffix = `${before && !before.endsWith('\n') ? '\n' : ''}${JSON.stringify(entry)}\n`;
            try { appendFileSync(this.path, suffix); }
            catch { if (readText(this.path) !== before + suffix) throw new LedgerWriteError(); }
            const temporary = `${this.#headPath}.tmp-${process.pid}-${randomUUID()}`;
            try {
                writeFileSync(temporary, entry.hash, { flag: 'wx' }); renameSync(temporary, this.#headPath);
            } catch { if (readText(this.#headPath)?.trim() !== entry.hash) throw new LedgerWriteError('账本已追加但末尾检查点未确认；请保留文件检查，不自动重放'); }
            finally { try { unlinkSync(temporary); } catch { /* 不覆盖原始发布结果。 */ } }
            return entry;
        } finally {
            if (locked) { try { db!.exec('ROLLBACK'); } catch { /* 日志已发布，不转成可重放失败。 */ } }
            if (db) { try { db.close(); } catch { /* 保留成功结果或最初失败。 */ } }
        }
    }

    verify(): VerifyResult {
        const entries = this.read();
        let prev = GENESIS_PREV;
        for (const [i, entry] of entries.entries()) {
            if (entry.kind === 'unreadable') return { ok: false, count: entries.length, brokenAt: i, reason: '有一行读不出来' };
            if (entry.seq !== i) return { ok: false, count: entries.length, brokenAt: i, reason: `序号对不上（应该是 ${i}，写的是 ${entry.seq}）` };
            if (entry.prev !== prev) return { ok: false, count: entries.length, brokenAt: i, reason: '和上一条接不上（中间被删过或插进去过）' };
            if (entryHash(entry) !== entry.hash) return { ok: false, count: entries.length, brokenAt: i, reason: '这一条的内容和它的哈希对不上（被改过）' };
            prev = entry.hash;
        }
        const storedHead = readText(this.#headPath);
        if (storedHead !== undefined) {
            const head = storedHead.trim();
            if (head !== prev) return { ok: false, count: entries.length, brokenAt: entries.length, reason: '账本末尾和另存的末尾哈希对不上（尾巴被截掉过，或被改过）' };
        } else if (entries.length) {
            return { ok: false, count: entries.length, brokenAt: entries.length, reason: '另存的末尾哈希不见了' };
        }
        return { ok: true, count: entries.length };
    }
}
