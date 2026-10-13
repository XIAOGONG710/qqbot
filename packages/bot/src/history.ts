// 每个联系人一份聊天记录：<dataDir>/chats/<QQ 号>.jsonl，一行一条，只追加。

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface StoredMessage {
    /** ISO 时间 */
    time: string;
    role: 'user' | 'assistant';
    content: string;
    /** QQ 消息 id（收到的或发出的） */
    messageId?: number;
}

export class ChatHistory {
    #dir: string;
    readonly #cache = new Map<number, { size: number; mtimeMs: number; messages: StoredMessage[]; ids: Set<number> }>();
    readonly #log: (message: string) => void;

    constructor(dataDir: string, log: (message: string) => void = () => undefined) {
        this.#dir = join(dataDir, 'chats');
        this.#log = log;
        mkdirSync(this.#dir, { recursive: true });
    }

    #path(userId: number): string {
        return join(this.#dir, `${userId}.jsonl`);
    }

    load(userId: number): StoredMessage[] {
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
                this.load(userId);
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
        this.load(userId);
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
