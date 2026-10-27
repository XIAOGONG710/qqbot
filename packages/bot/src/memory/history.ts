// 每个联系人一份聊天记录：<dataDir>/chats/<QQ 号>.jsonl，一行一条，只追加。

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StoredMessage {
    /** ISO 时间 */
    time: string;
    role: 'user' | 'assistant';
    content: string;
    /** QQ 消息 id（收到的或发出的） */
    messageId?: number;
}

/** 他撤回的那一条在 load() 里的样子（ADR 0082）；原文还在文件里 */
export const RECALLED_TEXT = '[撤回了一条消息]';
const MAX_RECALLED = 200;

export class ChatHistory {
    #dir: string;
    readonly #cache = new Map<number, { size: number; mtimeMs: number; messages: StoredMessage[]; ids: Set<number> }>();
    readonly #log: (message: string) => void;
    /** 每人撤回过的消息 id（<QQ 号>.recalled.json，最近 MAX_RECALLED 个） */
    readonly #recalled = new Map<number, number[]>();

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
        const messages = this.#loadRaw(userId);
        const recalled = this.#recalledIds(userId);
        if (recalled.length === 0) return messages;
        const hidden = new Set(recalled);
        return messages.map(message => message.role === 'user' && message.messageId !== undefined && hidden.has(message.messageId) ? { ...message, content: RECALLED_TEXT } : message);
    }

    #recalledPath(userId: number): string {
        return join(this.#dir, `${userId}.recalled.json`);
    }

    #recalledIds(userId: number): number[] {
        const known = this.#recalled.get(userId);
        if (known) return known;
        let ids: number[] = [];
        try {
            const value: unknown = JSON.parse(readFileSync(this.#recalledPath(userId), 'utf8'));
            if (Array.isArray(value)) ids = value.filter((id): id is number => Number.isSafeInteger(id) && id >= 0);
        } catch {
            // 没有这个文件、坏了：当作没有撤回过
        }
        this.#recalled.set(userId, ids);
        return ids;
    }

    /**
     * 他撤回了 messageId 这一条（ADR 0082）。只有他发的、她还没回过的才记（回过的她已经看过）；keep 说「这条原样留着」（危机的话）。
     * 原文留在文件里（只追加不改），之后 load() 给出去的是「[撤回了一条消息]」。记下了返回 true
     */
    recall(userId: number, messageId: number, keep: (content: string) => boolean = () => false): boolean {
        const messages = this.#loadRaw(userId);
        const index = messages.findLastIndex(message => message.messageId === messageId);
        const found = messages[index];
        if (!found || found.role !== 'user' || keep(found.content)) return false;
        if (messages.slice(index + 1).some(message => message.role === 'assistant')) return false;
        const ids = this.#recalledIds(userId);
        if (ids.includes(messageId)) return false;
        const next = [...ids, messageId].slice(-MAX_RECALLED);
        writeFileSync(this.#recalledPath(userId), JSON.stringify(next));
        this.#recalled.set(userId, next);
        return true;
    }

    #loadRaw(userId: number): StoredMessage[] {
        const path = this.#path(userId);
        if (!existsSync(path)) {
            this.#cache.delete(userId);
            return [];
        }
        const stat = statSync(path);
        const cached = this.#cache.get(userId);
        // Callers use this as a point-in-time snapshot (for example, to detect a message arriving
        // while a reply is generated). Never expose the mutable cache array itself.
        if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return [...cached.messages];
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
        this.#cache.set(userId, {
            size: stat.size,
            mtimeMs: stat.mtimeMs,
            messages,
            ids: new Set(messages.flatMap(message => message.messageId === undefined ? [] : [message.messageId])),
        });
        return [...messages];
    }

    append(userId: number, message: StoredMessage): void {
        if (!validStoredMessage(message)) throw new Error('拒绝写入不符合 schema 的聊天记录');
        const path = this.#path(userId);
        let cached = this.#cache.get(userId);
        // A chat file can be moved away by privacy/simulation tools while the process is alive.
        // Do not extend that old cache into the newly-created file; refresh external changes too.
        if (!existsSync(path)) {
            this.#cache.delete(userId);
            cached = undefined;
        } else if (cached) {
            const before = statSync(path);
            if (cached.size !== before.size || cached.mtimeMs !== before.mtimeMs) {
                this.#loadRaw(userId);
                cached = this.#cache.get(userId);
            }
        }
        const line = JSON.stringify(message) + '\n';
        appendFileSync(path, line);
        if (cached) {
            cached.messages.push(message);
            if (message.messageId !== undefined) cached.ids.add(message.messageId);
            const stat = statSync(path);
            cached.size = stat.size;
            cached.mtimeMs = stat.mtimeMs;
        }
    }

    /** O(1) message-id lookup after the first load; used by high-volume ingress paths. */
    hasMessage(userId: number, messageId: number): boolean {
        this.#loadRaw(userId);
        return this.#cache.get(userId)?.ids.has(messageId) ?? false;
    }
}

export function validStoredMessage(value: unknown): value is StoredMessage {
    if (!value || typeof value !== 'object') return false;
    const message = value as Partial<StoredMessage>;
    return typeof message.time === 'string' && Number.isFinite(Date.parse(message.time))
        && (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string'
        && (message.messageId === undefined || (Number.isSafeInteger(message.messageId) && message.messageId >= 0));
}
