// 每个联系人一份聊天记录：<dataDir>/chats/<QQ 号>.jsonl，一行一条，只追加。

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { ioErrorCode } from './transient-io.ts';

export interface StoredMessage {
    /** ISO 时间 */
    time: string;
    role: 'user' | 'assistant';
    content: string;
    /** QQ 消息 id（收到的或发出的） */
    messageId?: number;
    /** NapCat原始msgSeq；message_seq/real_id仍是短ID，不能代用。 */
    messageSeq?: string;
    /** 仅来源已知时记录QQ源秒。助手发送ACK的本地time不是源时间。 */
    sourceTime?: number;
}

export const sourceMessageSeq = (value: unknown): string | undefined => {
    const text = typeof value === 'string' ? value : Number.isSafeInteger(value) && Number(value) >= 0 ? String(value) : '';
    return /^\d+$/.test(text) ? text.replace(/^0+/, '') || '0' : undefined;
};
export type MessageIdentity = Pick<StoredMessage, 'time' | 'role' | 'messageId' | 'messageSeq' | 'sourceTime'>;
export function sourceSeconds(message: MessageIdentity): number | undefined {
    return message.sourceTime ?? (message.role === 'user' ? Math.floor(Date.parse(message.time) / 1000) : undefined);
}
/** Legacy ACK-only assistant rows retain their weak ID match; never invent QQ source time from ACK. */
export function sameMessage(a: MessageIdentity, b: MessageIdentity): boolean {
    if (a.messageId === undefined || a.messageId !== b.messageId || a.role !== b.role) return false;
    const left = sourceSeconds(a), right = sourceSeconds(b);
    if (left !== undefined && right !== undefined && left !== right) return false;
    return !a.messageSeq || !b.messageSeq || a.messageSeq === b.messageSeq;
}

/** 他撤回的那一条在 load() 里的样子（ADR 0082）；原文还在文件里 */
export const RECALLED_TEXT = '[撤回了一条消息]';
const MAX_RECALLED = 200;
type RecallMark = MessageIdentity & { contentHash: string };
interface RecalledState { version: 2; legacyIds: number[]; messages: RecallMark[]; order?: number[] }
const validRecallId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function validRecalledState(value: unknown): value is RecalledState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const state = value as Partial<RecalledState>;
    const valid = state.version === 2 && Array.isArray(state.legacyIds) && state.legacyIds.every(validRecallId)
        && (state.order === undefined || Array.isArray(state.order) && state.order.every(validRecallId))
        && Array.isArray(state.messages) && state.messages.every(message => validStoredMessage({ ...message, content: '' }) && message.role === 'user' && validRecallId(message.messageId)
            && typeof message.contentHash === 'string' && /^[a-f0-9]{64}$/.test(message.contentHash));
    if (!valid) return false;
    if (state.order) {
        const known = new Set([...state.legacyIds!, ...state.messages!.map(mark => mark.messageId!)]);
        if (new Set(state.order).size !== state.order.length || known.size !== state.order.length || state.order.some(id => !known.has(id))) return false;
    }
    return true;
}
const contentHash = (message: StoredMessage) => createHash('sha256').update(message.content).digest('hex');
const recalledMatch = (message: StoredMessage, mark: RecallMark) => sameMessage(message, mark) && contentHash(message) === mark.contentHash;
const recallIdentity = ({ time, role, messageId, messageSeq, sourceTime, content }: StoredMessage): RecallMark => ({
    time, role, messageId, ...(messageSeq === undefined ? {} : { messageSeq }), ...(sourceTime === undefined ? {} : { sourceTime }),
    contentHash: createHash('sha256').update(content).digest('hex'),
});

/** existsSync会把非ENOENT的探测失败也说成“不在”；历史不能因此变成空白。 */
function historyStat(path: string): BigIntStats | undefined {
    try { return statSync(path, { bigint: true }); }
    catch (error) { if (ioErrorCode(error) === 'ENOENT') return undefined; throw error; }
}

const historyKey = (stat: BigIntStats) => `${stat.dev}:${stat.ino}:${stat.birthtimeNs}:${stat.ctimeNs}:${stat.mtimeNs}:${stat.size}`;

export class ChatHistory {
    #dir: string;
    readonly #cache = new Map<number, { key: string; messages: StoredMessage[]; ids: Set<number>; byId: Map<number, StoredMessage[]> }>();
    readonly #log: (message: string) => void;
    /** 每人撤回过的消息 id（<QQ 号>.recalled.json，最近 MAX_RECALLED 个） */
    readonly #recalled = new Map<number, RecalledState>();

    constructor(dataDir: string, log: (message: string) => void = () => undefined) {
        this.#dir = join(dataDir, 'chats');
        this.#log = log;
        mkdirSync(this.#dir, { recursive: true });
    }

    #path(userId: number): string {
        return join(this.#dir, `${userId}.jsonl`);
    }

    /** 聊天记录；他撤回的那几条（recall）里的字换成「[撤回了一条消息]」，别的原样 */
    load(userId: number): StoredMessage[] {
        const messages = this.#loadRaw(userId).map(message => ({ ...message }));
        const recalled = this.#recalledState(userId, messages);
        const legacy = new Set(recalled.legacyIds);
        const byId = new Map<number, RecallMark[]>();
        for (const mark of recalled.messages) { const rows = byId.get(mark.messageId!) ?? []; rows.push(mark); byId.set(mark.messageId!, rows); }
        return messages.map(message => message.role === 'user' && message.messageId !== undefined
            && (legacy.has(message.messageId) || byId.get(message.messageId)?.some(mark => recalledMatch(message, mark))) ? { ...message, content: RECALLED_TEXT } : message);
    }

    #recalledPath(userId: number): string {
        return join(this.#dir, `${userId}.recalled.json`);
    }

    #saveRecalled(userId: number, state: RecalledState): void {
        try { writeJsonAtomic(this.#recalledPath(userId), state); }
        catch (error) {
            try {
                const saved = readJsonOr<unknown>(this.#recalledPath(userId), undefined, undefined, { invalid: 'throw' });
                if (JSON.stringify(saved) === JSON.stringify(state)) return;
            } catch { /* An unconfirmed publication remains a failure. */ }
            throw error;
        }
    }

    #recalledState(userId: number, messages: StoredMessage[]): RecalledState {
        const known = this.#recalled.get(userId);
        if (known) return known;
        // 撤回标记损坏不能当成“从没撤回”，否则原文会重新进入提示词。
        const stored = readJsonOr<number[] | RecalledState>(this.#recalledPath(userId), { version: 2, legacyIds: [], messages: [] }, undefined, {
            validate: (value): value is number[] | RecalledState => Array.isArray(value) ? value.every(validRecallId) : validRecalledState(value),
            invalid: 'throw', label: '聊天撤回状态',
        });
        let state: RecalledState;
        if (Array.isArray(stored)) {
            const existing = messages.filter(message => message.role === 'user' && message.messageId !== undefined && stored.includes(message.messageId));
            state = { version: 2, legacyIds: stored.filter(id => !existing.some(message => message.messageId === id)), messages: existing.map(recallIdentity), order: [...new Set(stored)] };
            // Freeze only what the old wildcard already hid. Publish before
            // accepting a new occurrence, never guess an orphan legacy target.
            this.#saveRecalled(userId, state);
        } else state = stored;
        this.#recalled.set(userId, state);
        return state;
    }

    /**
     * 他撤回了 messageId 这一条（ADR 0082）。只有他发的、她还没回过的才记（回过的她已经看过）；keep 说「这条原样留着」（危机的话）。
     * 原文留在文件里（只追加不改），之后 load() 给出去的是「[撤回了一条消息]」。记下了返回 true
     */
    recall(userId: number, messageId: number, keep: (content: string) => boolean = () => false): boolean {
        const messages = this.#loadRaw(userId);
        const state = this.#recalledState(userId, messages);
        const unanswered = messages.slice(messages.findLastIndex(message => message.role === 'assistant') + 1);
        const candidates = unanswered.filter(message => message.role === 'user' && message.messageId === messageId && !keep(message.content));
        const fresh = candidates.filter(message => !state.legacyIds.includes(messageId) && !state.messages.some(mark => recalledMatch(message, mark)));
        if (!fresh.length) return false;
        // A recall notice has no original source time/seq. For ambiguous short
        // IDs, redact this existing non-crisis candidate set rather than guess
        // one target or expose the actual withdrawn content.
        if (candidates.length > 1) this.#log(`聊天撤回：短ID有${candidates.length}个未答候选，仅对当前非保留候选占位`);
        const previous = state.order ?? [...state.legacyIds, ...state.messages.map(mark => mark.messageId!)];
        const ids = [...new Set(previous.filter(id => id !== messageId)), messageId].slice(-MAX_RECALLED);
        const next: RecalledState = { ...state, order: ids, legacyIds: state.legacyIds.filter(id => ids.includes(id)), messages: [...state.messages, ...fresh.map(recallIdentity)].filter(mark => ids.includes(mark.messageId!)) };
        this.#saveRecalled(userId, next);
        this.#recalled.set(userId, next);
        return true;
    }

    #loadRaw(userId: number): StoredMessage[] {
        const path = this.#path(userId);
        const stat = historyStat(path);
        if (!stat) {
            this.#cache.delete(userId);
            return [];
        }
        const key = historyKey(stat);
        const cached = this.#cache.get(userId);
        // 只向类内部返回缓存；公开load另做条目级快照，hasMessage不必复制整条历史。
        if (cached && cached.key === key) return cached.messages;
        const messages: StoredMessage[] = [];
        let rejected = 0;
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const value: unknown = JSON.parse(line);
                if (validStoredMessage(value)) messages.push(value);
                else rejected++;
            } catch {
                // 进程在写入中途被杀时最后一行可能不完整，跳过
                rejected++;
            }
        }
        if (rejected) this.#log(`聊天记录 ${userId}.jsonl 忽略 ${rejected} 行损坏或不符合 schema 的内容`);
        const byId = new Map<number, StoredMessage[]>();
        for (const message of messages) if (message.messageId !== undefined) {
            const rows = byId.get(message.messageId) ?? []; rows.push(message); byId.set(message.messageId, rows);
        }
        this.#cache.set(userId, {
            key,
            messages,
            ids: new Set(messages.flatMap(message => message.messageId === undefined ? [] : [message.messageId])),
            byId,
        });
        return messages;
    }

    append(userId: number, message: StoredMessage): void {
        if (!validStoredMessage(message)) throw new Error('拒绝写入不符合 schema 的聊天记录');
        // Freeze old wildcard marks before this new occurrence can enter the
        // history; a later ID reuse must not become part of the old snapshot.
        this.#recalledState(userId, this.#loadRaw(userId));
        const path = this.#path(userId);
        let cached = this.#cache.get(userId);
        let prefix = '';
        // A chat file can be moved away by privacy/simulation tools while the process is alive.
        // Do not extend that old cache into the newly-created file; refresh external changes too.
        const before = historyStat(path);
        if (!before) {
            this.#cache.delete(userId);
            cached = undefined;
        } else {
            if (cached && cached.key !== historyKey(before)) {
                this.#loadRaw(userId);
                cached = this.#cache.get(userId);
            }
            // 崩溃可能留下半行或没有换行的完整旧行。只补分隔符，不删除旧字节。
            if (before.size > 0n) {
                const fd = openSync(path, 'r');
                try {
                    const tail = Buffer.alloc(1);
                    if (readSync(fd, tail, 0, 1, before.size - 1n) === 1 && tail[0] !== 10) prefix = '\n';
                } finally { closeSync(fd); }
            }
        }
        const line = prefix + JSON.stringify(message) + '\n';
        appendFileSync(path, line);
        if (cached) {
            cached.messages.push({ ...message });
            if (message.messageId !== undefined) cached.ids.add(message.messageId);
            if (message.messageId !== undefined) {
                const rows = cached.byId.get(message.messageId) ?? []; rows.push({ ...message }); cached.byId.set(message.messageId, rows);
            }
            cached.key = historyKey(statSync(path, { bigint: true }));
        }
    }

    /** ID bucket lookup after the first load; optional source distinguishes occurrences within that bucket. */
    hasMessage(userId: number, messageId: number, source?: Omit<MessageIdentity, 'messageId'>): boolean {
        this.#loadRaw(userId);
        if (source) return this.#cache.get(userId)?.byId.get(messageId)?.some(message => sameMessage(message, { ...source, messageId })) ?? false;
        return this.#cache.get(userId)?.ids.has(messageId) ?? false;
    }
}

export function validStoredMessage(value: unknown): value is StoredMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Partial<StoredMessage>;
    return typeof message.time === 'string' && Number.isFinite(Date.parse(message.time))
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string'
        && (message.messageId === undefined || (Number.isSafeInteger(message.messageId) && message.messageId >= 0))
        && (message.messageSeq === undefined || typeof message.messageSeq === 'string' && /^(?:0|[1-9]\d*)$/.test(message.messageSeq))
        && (message.sourceTime === undefined || Number.isSafeInteger(message.sourceTime) && Number.isFinite(new Date(message.sourceTime * 1000).getTime()));
}
