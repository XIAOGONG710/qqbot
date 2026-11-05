// 每个联系人一份聊天记录：<dataDir>/chats/<QQ 号>.jsonl，一行一条，只追加。

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { ioErrorCode } from './transient-io.ts';
import { stateObject, stateTimestamp } from './state-schema.ts';
import type { Segment } from '../platform/onebot.ts';
import { isDeepStrictEqual } from 'node:util';

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
    /** 持久入站预约，仅在prepare事实已经落盘后进入聊天。 */
    incomingId?: string;
    /** 仅load视图根据持久撤回事实生成；原文JSONL中的同名字段不可信。 */
    recalled?: true;
}

export interface IncomingEnvelope { source: MessageIdentity; message: Segment[] | string }
export interface PendingIncoming extends IncomingEnvelope {
    id: string;
    withdrawn: boolean;
    prepared?: StoredMessage;
    preparedKeep?: boolean;
}
const incomingId = (value: unknown): value is string => typeof value === 'string' && /^inc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function jsonClone<T>(value: T): T {
    try { return JSON.parse(JSON.stringify(value)) as T; }
    catch { throw new TypeError('入站预约必须是可持久化JSON'); }
}
const sameStored = (left: StoredMessage, right: StoredMessage) => isDeepStrictEqual(jsonClone(left), jsonClone(right));
/** 两个预约可来自live/backfill；token不是QQ事实身份，未知seq保留既定兼容。 */
const equivalentIncoming = (left: StoredMessage, right: StoredMessage) => left.role === 'user' && right.role === 'user'
    && sameMessage(left, right) && sourceSeconds(left) === sourceSeconds(right) && left.content === right.content;
const envelopeMessage = (value: unknown): boolean => typeof value === 'string' || Array.isArray(value) && value.every(segment => stateObject(segment)
    && typeof segment.type === 'string' && (segment.data === undefined || stateObject(segment.data)));
const sourceIdentity = ({ time, role, messageId, messageSeq, sourceTime }: MessageIdentity): MessageIdentity => ({ time, role, messageId,
    ...(messageSeq === undefined ? {} : { messageSeq }), ...(sourceTime === undefined ? {} : { sourceTime }) });
function validIncomingSource(value: unknown): value is MessageIdentity {
    return stateObject(value) && value.role === 'user' && validRecallId(value.messageId) && stateTimestamp(value.time)
        && validStoredMessage({ ...value, content: '' })
        && (value.sourceTime === undefined || value.sourceTime === Math.floor(Date.parse(value.time) / 1000));
}
function validPending(value: unknown): value is PendingIncoming {
    if (!stateObject(value) || !incomingId(value.id) || !validIncomingSource(value.source) || !envelopeMessage(value.message) || typeof value.withdrawn !== 'boolean') return false;
    return value.prepared === undefined ? value.preparedKeep === undefined : validStoredMessage(value.prepared)
        && value.prepared.time === value.source.time && value.prepared.incomingId === value.id && sameMessage(value.source, value.prepared) && typeof value.preparedKeep === 'boolean';
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
interface RecalledState { version: 2; legacyIds: number[]; messages: RecallMark[]; order?: number[]; pending?: PendingIncoming[]; kept?: RecallMark[] }
const validRecallId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
function validRecalledState(value: unknown): value is RecalledState {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const state = value as Partial<RecalledState>;
    const valid = state.version === 2 && Array.isArray(state.legacyIds) && state.legacyIds.every(validRecallId)
        && (state.order === undefined || Array.isArray(state.order) && state.order.every(validRecallId))
        && (state.pending === undefined || Array.isArray(state.pending) && state.pending.every(validPending) && new Set(state.pending.map(p => p.id)).size === state.pending.length)
        && (state.kept === undefined || Array.isArray(state.kept) && state.kept.every(message => validStoredMessage({ ...message, content: '' }) && message.role === 'user' && validRecallId(message.messageId)
            && typeof message.contentHash === 'string' && /^[a-f0-9]{64}$/.test(message.contentHash)))
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
    readonly #dirtyIncoming = new Set<number>();
    readonly #recallRevisions = new Map<number, number>();

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
        const messages = this.#loadRaw(userId).map(({ recalled: _rawFlag, ...message }) => ({ ...message }));
        const recalled = this.#recalledState(userId, messages);
        const legacy = new Set(recalled.legacyIds);
        const byId = new Map<number, RecallMark[]>();
        for (const mark of recalled.messages) { const rows = byId.get(mark.messageId!) ?? []; rows.push(mark); byId.set(mark.messageId!, rows); }
        return messages.map(message => message.role === 'user' && message.messageId !== undefined
            && !recalled.kept?.some(mark => recalledMatch(message, mark))
            && !recalled.pending?.some(entry => entry.prepared && entry.preparedKeep && equivalentIncoming(message, entry.prepared))
            && (legacy.has(message.messageId) || byId.get(message.messageId)?.some(mark => recalledMatch(message, mark))
                || recalled.pending?.some(entry => entry.prepared && entry.withdrawn && !entry.preparedKeep && equivalentIncoming(message, entry.prepared))) ? { ...message, content: RECALLED_TEXT, recalled: true } : message);
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

    /** 已观察撤回不能因写失败被忘掉。失败仍抛，后续任何处理先补提交。 */
    flushIncoming(userId?: number): void {
        let failed: unknown;
        for (const peer of userId === undefined ? [...this.#dirtyIncoming] : [userId]) {
            if (!this.#dirtyIncoming.has(peer)) continue;
            try { this.#saveRecalled(peer, this.#recalled.get(peer)!); this.#dirtyIncoming.delete(peer); }
            catch (error) { failed ??= error; }
        }
        if (failed !== undefined) throw failed;
    }

    #publish(userId: number, state: RecalledState, observed = false): void {
        if (observed) {
            this.#recalled.set(userId, state); this.#dirtyIncoming.add(userId); this.flushIncoming(userId);
        } else { this.#saveRecalled(userId, state); this.#recalled.set(userId, state); }
    }

    #recalledState(userId: number, messages: StoredMessage[]): RecalledState {
        const known = this.#recalled.get(userId);
        if (known) { this.flushIncoming(userId); return known; }
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

    /** 新的真实观察可以叠加到dirty事实；先flush会在观察第二条之前把它丢掉。
     * 只在已经读到完整副状态时沿用RAM；尚未加载/损坏的状态仍失败关闭，不能当空白覆盖。
     */
    #observeState(userId: number): { state: RecalledState; messages: StoredMessage[] } {
        const known = this.#recalled.get(userId);
        if (known) {
            let messages: StoredMessage[];
            try { messages = this.#loadRaw(userId); }
            catch { messages = this.#cache.get(userId)?.messages ?? []; }
            return { state: known, messages };
        }
        const messages = this.#loadRaw(userId);
        return { state: this.#recalledState(userId, messages), messages };
    }

    #withPrepared(state: RecalledState, entry: PendingIncoming): RecalledState {
        const message = entry.prepared!;
        if (entry.preparedKeep) {
            if (state.kept?.some(mark => recalledMatch(message, mark))) return state;
            return { ...state, kept: [...(state.kept ?? []).filter(mark => !recalledMatch(message, mark)), recallIdentity(message)] };
        }
        if (!entry.withdrawn || state.messages.some(mark => recalledMatch(message, mark))) return state;
        const previous = state.order ?? [...state.legacyIds, ...state.messages.map(mark => mark.messageId!)];
        const ids = [...new Set(previous.filter(id => id !== message.messageId)), message.messageId!].slice(-MAX_RECALLED);
        return { ...state, order: ids, legacyIds: state.legacyIds.filter(id => ids.includes(id)), messages: [...state.messages, recallIdentity(message)].filter(mark => ids.includes(mark.messageId!)) };
    }

    #appended(entry: PendingIncoming, messages: readonly StoredMessage[]): boolean {
        return Boolean(entry.prepared && messages.some(message => equivalentIncoming(message, entry.prepared!)));
    }

    #cleanupPending(userId: number, state: RecalledState, messages: readonly StoredMessage[]): PendingIncoming[] {
        const pending = (state.pending ?? []).filter(entry => !this.#appended(entry, messages));
        if (pending.length !== (state.pending ?? []).length) {
            let next = state;
            for (const entry of state.pending ?? []) if (!pending.includes(entry) && entry.prepared) next = this.#withPrepared(next, entry);
            // 失败保留原已持久pending意图，load仍据它占位；不把完成事实重新交付。
            try { this.#publish(userId, { ...next, pending }); }
            catch { try { this.#log('入站预约：已追加事实的副状态清理暂未完成，将重试；不重放消息'); } catch { /* 日志不能改变事实 */ } }
        }
        return pending;
    }

    stageIncoming(userId: number, envelope: IncomingEnvelope): string {
        const input = jsonClone(envelope);
        if (!validIncomingSource(input.source) || !envelopeMessage(input.message)) throw new TypeError('入站预约来源或载荷无效');
        const { state } = this.#observeState(userId);
        // 观察入口不清理旧pending：其中可能包含尚待发布的prepared/撤回标记。
        const pending = state.pending ?? [];
        const source = sourceIdentity(input.source);
        const existing = pending.find(entry => sameMessage(entry.source, source)
            && (entry.source.messageSeq !== undefined && source.messageSeq !== undefined || JSON.stringify(entry.message) === JSON.stringify(input.message)));
        if (existing) { this.flushIncoming(userId); return existing.id; }
        const id = `inc-${randomUUID()}`;
        this.#publish(userId, { ...state, pending: [...pending, { id, source, message: input.message, withdrawn: false }] }, true);
        return id;
    }

    pendingIncoming(userId: number): PendingIncoming[] {
        const messages = this.#loadRaw(userId), state = this.#recalledState(userId, messages);
        return jsonClone(this.#cleanupPending(userId, state, messages));
    }

    prepareIncoming(userId: number, id: string, decoded: StoredMessage, keep: (content: string) => boolean): StoredMessage {
        const messages = this.#loadRaw(userId), state = this.#recalledState(userId, messages);
        const entry = state.pending?.find(row => row.id === id);
        if (!entry) throw new Error('入站预约不存在或已完成');
        if (entry.prepared) return jsonClone(entry.prepared);
        if (!validStoredMessage(decoded) || !sameMessage(decoded, entry.source) || decoded.incomingId !== undefined && decoded.incomingId !== id) throw new TypeError('入站解码结果与预约来源不符');
        const prepared = jsonClone({ ...decoded, ...entry.source, incomingId: id });
        const nextEntry: PendingIncoming = { ...entry, prepared, preparedKeep: Boolean(keep(prepared.content)) };
        const next = this.#withPrepared({ ...state, pending: state.pending!.map(row => row.id === id ? nextEntry : row) }, nextEntry);
        this.#publish(userId, next);
        return jsonClone(prepared);
    }

    discardIncoming(userId: number, id: string): boolean {
        const state = this.#recalledState(userId, this.#loadRaw(userId));
        const entry = state.pending?.find(row => row.id === id);
        if (!entry || entry.withdrawn) return false;
        this.#publish(userId, { ...state, pending: state.pending!.filter(row => row.id !== id) }); return true;
    }

    /** 本实例已接受的撤回观察世代；仅作调度信号，不代表已持久，读取正文仍须flush成功。 */
    recallRevision(userId: number): number { return this.#recallRevisions.get(userId) ?? 0; }

    /**
     * 他撤回了 messageId 这一条（ADR 0082）。只有他发的、她还没回过的才记（回过的她已经看过）；keep 说「这条原样留着」（危机的话）。
     * 原文留在文件里（只追加不改），之后 load() 给出去的是「[撤回了一条消息]」。记下了返回 true
     */
    recall(userId: number, messageId: number, keep: (content: string) => boolean = () => false): boolean {
        const { messages, state } = this.#observeState(userId);
        const unanswered = messages.slice(messages.findLastIndex(message => message.role === 'assistant') + 1);
        const candidates = unanswered.filter(message => message.role === 'user' && message.messageId === messageId && !keep(message.content));
        const fresh = candidates.filter(message => !state.legacyIds.includes(messageId) && !state.messages.some(mark => recalledMatch(message, mark)));
        const pending = (state.pending ?? []).map(entry => entry.source.messageId === messageId && !entry.withdrawn && !this.#appended(entry, messages)
            ? { ...entry, withdrawn: true } : entry);
        const changedPending = pending.some((entry, index) => entry !== state.pending?.[index]);
        if (!fresh.length && !changedPending) { this.flushIncoming(userId); return false; }
        // A recall notice has no original source time/seq. For ambiguous short
        // IDs, redact this existing non-crisis candidate set rather than guess
        // one target or expose the actual withdrawn content.
        if (candidates.length > 1) this.#log(`聊天撤回：短ID有${candidates.length}个未答候选，仅对当前非保留候选占位`);
        let next: RecalledState = { ...state, pending };
        if (fresh.length) {
            const previous = state.order ?? [...state.legacyIds, ...state.messages.map(mark => mark.messageId!)];
            const ids = [...new Set(previous.filter(id => id !== messageId)), messageId].slice(-MAX_RECALLED);
            next = { ...next, order: ids, legacyIds: state.legacyIds.filter(id => ids.includes(id)), messages: [...state.messages, ...fresh.map(recallIdentity)].filter(mark => ids.includes(mark.messageId!)) };
        }
        for (const entry of pending) if (entry.withdrawn && entry.prepared) next = this.#withPrepared(next, entry);
        this.#recallRevisions.set(userId, this.recallRevision(userId) + 1);
        this.#publish(userId, next, true);
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
        const raw = this.#loadRaw(userId);
        let state = this.#recalledState(userId, raw);
        if (!message.incomingId && message.role === 'user' && state.pending?.some(entry => entry.withdrawn && sameMessage(entry.source, message))) {
            throw new Error('已撤回的待处理来源必须先准备保留决定，拒绝绕过入站预约追加');
        }
        if (message.incomingId !== undefined) {
            const existing = raw.find(row => row.incomingId === message.incomingId);
            if (existing) {
                if (!sameStored(existing, message)) throw new Error('入站预约已追加不同正文');
                this.#cleanupPending(userId, state, raw); return;
            }
            const pending = state.pending?.find(row => row.id === message.incomingId);
            if (raw.some(row => equivalentIncoming(row, message))) {
                if (pending?.prepared && !sameStored(pending.prepared, message)) throw new Error('入站预约正文不匹配');
                this.#cleanupPending(userId, state, raw); return;
            }
            if (!pending?.prepared || !sameStored(pending.prepared, message)) throw new Error('入站预约未准备或正文不匹配');
            const next = this.#withPrepared(state, pending);
            if (next !== state) { this.#publish(userId, next); state = next; }
        }
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
        try { appendFileSync(path, line); }
        catch (error) {
            if (!message.incomingId) throw error;
            // 追加/close报错可能发生在完整行实际发布后，按预约和完整内容读回确认。
            this.#cache.delete(userId);
            let confirmed = false;
            try { confirmed = this.#loadRaw(userId).some(row => row.incomingId === message.incomingId && sameStored(row, message)); } catch { /* 未确认不可放行 */ }
            if (!confirmed) throw error;
            this.#cleanupPending(userId, state, this.#loadRaw(userId)); return;
        }
        try { if (cached) {
            cached.messages.push({ ...message });
            if (message.messageId !== undefined) cached.ids.add(message.messageId);
            if (message.messageId !== undefined) {
                const rows = cached.byId.get(message.messageId) ?? []; rows.push({ ...message }); cached.byId.set(message.messageId, rows);
            }
            cached.key = historyKey(statSync(path, { bigint: true }));
        } } catch (error) { this.#cache.delete(userId); if (!message.incomingId) throw error; }
        if (message.incomingId) {
            // 即便缓存/stat或副状态清理失败，已经追加的事实也不能变成重放授权。
            try { this.#cleanupPending(userId, state, this.#loadRaw(userId)); }
            catch { try { this.#log('入站预约：追加已完成，完成清理稍后重试'); } catch { /* 安全日志 */ } }
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
        && (message.sourceTime === undefined || Number.isSafeInteger(message.sourceTime) && Number.isFinite(new Date(message.sourceTime * 1000).getTime()))
        && (message.incomingId === undefined || incomingId(message.incomingId));
}
