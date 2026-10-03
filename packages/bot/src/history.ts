// 每个联系人一份聊天记录：<dataDir>/chats/<QQ 号>.jsonl，一行一条，只追加。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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

    constructor(dataDir: string) {
        this.#dir = join(dataDir, 'chats');
        mkdirSync(this.#dir, { recursive: true });
    }

    #path(userId: number): string {
        return join(this.#dir, `${userId}.jsonl`);
    }

    load(userId: number): StoredMessage[] {
        const path = this.#path(userId);
        if (!existsSync(path)) return [];
        const messages: StoredMessage[] = [];
        for (const line of readFileSync(path, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                messages.push(JSON.parse(line) as StoredMessage);
            } catch {
                // 进程在写入中途被杀时最后一行可能不完整，跳过
            }
        }
        return messages;
    }

    append(userId: number, message: StoredMessage): void {
        appendFileSync(this.#path(userId), JSON.stringify(message) + '\n');
    }
}
