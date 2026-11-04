import type { DshConversationTurn } from './dsh-link.ts';
import type { StoredMessage } from './memory/history.ts';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { readJsonOr, writeJsonAtomic } from './memory/json-file.ts';

interface TimedTurn extends DshConversationTurn {
    at: number;
}

interface ContinuityFile {
    version: 1;
    turns: TimedTurn[];
}

export interface DshConversationContextOptions {
    file?: string;
    maxTurns?: number;
    log?: (message: string) => void;
}

function validFile(value: unknown): value is ContinuityFile {
    if (!value || typeof value !== 'object') return false;
    const input = value as Partial<ContinuityFile>;
    return input.version === 1 && Array.isArray(input.turns) && input.turns.length <= 80
        && input.turns.every(turn => turn && (turn.role === 'user' || turn.role === 'assistant')
            && typeof turn.content === 'string' && turn.content.length > 0 && turn.content.length <= 4_000
            && Number.isFinite(turn.at) && turn.at >= 0);
}

/**
 * 合并 QQ 与显式 DSH 咨询的短期上下文。
 * DSH 私有问答带时间保存，避免固定拼接顺序让旧咨询永久盖住更新的 QQ 消息。
 */
export class DshConversationContext {
    readonly #turns: TimedTurn[];
    readonly #file?: string;
    readonly #maxTurns: number;

    constructor(options: DshConversationContextOptions = {}) {
        this.#file = options.file;
        this.#maxTurns = options.maxTurns ?? 12;
        if (!Number.isInteger(this.#maxTurns) || this.#maxTurns < 2 || this.#maxTurns > 80) throw new Error('DSH 连续上下文容量不合法');
        const loaded = this.#file
            ? readJsonOr<ContinuityFile>(this.#file, { version: 1, turns: [] }, options.log, { validate: validFile, label: 'DSH 连续上下文' })
            : { version: 1 as const, turns: [] };
        this.#turns = loaded.turns.slice(-this.#maxTurns);
    }

    recent(history: readonly StoredMessage[], limit = 6): DshConversationTurn[] | undefined {
        if (!Number.isInteger(limit) || limit < 1 || limit > 40) throw new Error('DSH 连续上下文长度不合法');
        const qq = history.slice(-limit).map((turn, index) => ({
            role: turn.role,
            content: turn.content,
            at: Date.parse(turn.time),
            order: index,
        })).filter(turn => Number.isFinite(turn.at));
        const offset = qq.length;
        const privateTurns = this.#turns.map((turn, index) => ({ ...turn, order: offset + index }));
        const merged = [...qq, ...privateTurns]
            .sort((left, right) => left.at - right.at || left.order - right.order)
            .slice(-limit)
            .map(({ role, content }) => ({ role, content }));
        return merged.length ? merged : undefined;
    }

    /** 只在 DSH 成功返回后提交完整问答；失败请求不会污染下一轮上下文。 */
    commit(question: string, reply: string, askedAt: number, repliedAt: number): void {
        if (!Number.isFinite(askedAt) || !Number.isFinite(repliedAt)) throw new Error('DSH 对话时间不合法');
        this.#turns.push(
            { role: 'user', content: question, at: askedAt },
            { role: 'assistant', content: reply, at: Math.max(askedAt, repliedAt) },
        );
        this.#turns.splice(0, Math.max(0, this.#turns.length - this.#maxTurns));
        if (this.#file) {
            mkdirSync(dirname(this.#file), { recursive: true });
            writeJsonAtomic(this.#file, { version: 1, turns: this.#turns } satisfies ContinuityFile);
        }
    }
}
