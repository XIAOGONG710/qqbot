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

const MAX_TURN_CONTENT = 4_000;

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
            && typeof turn.content === 'string' && turn.content.length > 0 && turn.content.length <= MAX_TURN_CONTENT
            && Number.isFinite(turn.at) && turn.at >= 0);
}

function normalizeContent(value: string, label: string): string {
    const content = value.trim().slice(0, MAX_TURN_CONTENT);
    if (!content) throw new Error(`DSH ${label}不能为空`);
    return content;
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
        if (!Number.isFinite(askedAt) || askedAt < 0 || !Number.isFinite(repliedAt) || repliedAt < 0) throw new Error('DSH 对话时间不合法');
        const next = [
            ...this.#turns,
            { role: 'user' as const, content: normalizeContent(question, '问题'), at: askedAt },
            { role: 'assistant' as const, content: normalizeContent(reply, '回答'), at: Math.max(askedAt, repliedAt) },
        ].slice(-this.#maxTurns);
        if (this.#file) {
            mkdirSync(dirname(this.#file), { recursive: true });
            // 先落盘再替换内存：写盘失败时，调用方会向用户报告失败，下一轮也不能看到这次未完成提交的“幽灵问答”。
            writeJsonAtomic(this.#file, { version: 1, turns: next } satisfies ContinuityFile);
        }
        this.#turns.splice(0, this.#turns.length, ...next);
    }
}
