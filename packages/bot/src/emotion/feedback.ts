// 反馈通道（ADR 0073，任务书 T1）：他在 QQ 里对她的话回一个字「假」或「像」，只记下来，不当聊天。
// 为什么：「哪句话像机器人」最直接的信号是他当时的感觉，之前没有采集通道；成本是他 2 秒，比盲评便宜两个数量级。
// 这是工具，不是行为：命中的消息不进聊天记录、不交给回复器、不进长期记忆、不触发主动计划，她也不回应；
// 记录只落在数据目录的 feedback/YYYY-MM.jsonl（runtime/ 被忽略，不进仓库），日志里只写「反馈：假（本月第 N 条）」，不写内容。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { StoredMessage } from '../memory/history.ts';
import type { Segment } from '../platform/onebot.ts';

export type FeedbackLabel = 'fake' | 'real';

/** 没有引用时，只认她最近那一轮；超过这么久就当普通消息 */
export const FEEDBACK_WINDOW_MS = 30 * 60_000;
/** 记录里带的、那一轮之前的上下文条数 */
export const FEEDBACK_CONTEXT = 6;

export interface FeedbackCommand {
    label: FeedbackLabel;
    /** QQ 的「回复」引用的消息 id */
    replyTo?: number;
}

const LABELS: Record<string, FeedbackLabel> = { 假: 'fake', 像: 'real' };
/** 「假」「像」之前可以有一个 /，之后只能是标点和空白（再多一个字就不算：「假的」「太假了」「真假」都不算） */
const COMMAND = /^\s*\/?([假像])[\s。.，,!！?？~～…、]*$/;

/**
 * 这条消息是不是一条反馈指令：只有「假」或「像」一个字（可带前面一个 /、后面的标点、至多一个小黄脸、QQ 的回复引用）。
 * 别的段（图片、语音、@……）一出现就不是。
 */
export function parseFeedback(message: Segment[] | string): FeedbackCommand | undefined {
    if (typeof message === 'string') {
        const match = COMMAND.exec(message);
        return match ? { label: LABELS[match[1]!]! } : undefined;
    }
    let text = '';
    let replyTo: number | undefined;
    let faces = 0;
    for (const segment of message) {
        if (segment.type === 'text') {
            text += String(segment.data.text ?? '');
        } else if (segment.type === 'reply') {
            const id = Number(segment.data.id);
            if (replyTo !== undefined || !Number.isSafeInteger(id) || id <= 0) return undefined;
            replyTo = id;
        } else if (segment.type === 'face') {
            if (++faces > 1) return undefined;
        } else {
            return undefined;
        }
    }
    const match = COMMAND.exec(text);
    if (!match) return undefined;
    return { label: LABELS[match[1]!]!, ...(replyTo !== undefined ? { replyTo } : {}) };
}

export interface FeedbackTurn {
    /** 她那一轮（连续的几条气泡） */
    her: StoredMessage[];
    /** 那一轮之前的最多 FEEDBACK_CONTEXT 条 */
    context: StoredMessage[];
}

/**
 * 找她被评价的那一轮：
 * - 带引用：被引用的那条她的消息所在的一串连续的她的消息；找不到（不是她发的、不在记录里）就是 undefined；
 * - 不带引用：她最近的一串消息，最后一条要在 at 之前 30 分钟内。
 * history 是这个人的聊天记录（反馈这条消息本身不在里面）。
 */
export function locateTurn(history: readonly StoredMessage[], at: Date, replyTo?: number): FeedbackTurn | undefined {
    let anchor = -1;
    if (replyTo !== undefined) {
        anchor = history.findIndex(message => message.role === 'assistant' && message.messageId === replyTo);
    } else {
        for (let i = history.length - 1; i >= 0; i--) {
            if (history[i]!.role === 'assistant') { anchor = i; break; }
        }
        if (anchor >= 0) {
            const age = at.getTime() - Date.parse(history[anchor]!.time);
            if (!Number.isFinite(age) || age > FEEDBACK_WINDOW_MS) return undefined;
        }
    }
    if (anchor < 0) return undefined;
    let start = anchor;
    while (start > 0 && history[start - 1]!.role === 'assistant') start--;
    let end = anchor;
    while (end + 1 < history.length && history[end + 1]!.role === 'assistant') end++;
    return { her: history.slice(start, end + 1), context: history.slice(Math.max(0, start - FEEDBACK_CONTEXT), start) };
}

/** 月份文件名（YYYY-MM.jsonl）：隐私审计按这个找反馈账本 */
export const FEEDBACK_MONTH_FILE = /^\d{4}-(?:0[1-9]|1[0-2])\.jsonl$/;

export interface FeedbackRow {
    at: string;
    label: FeedbackLabel;
    /** 他发的那条「假」/「像」的消息 id，重投和补回时用来去重 */
    messageId: number;
    /** 私有反馈事实的联系人范围；旧记录缺省时只能按来源时刻与短 ID 保守匹配（main 侧字段，隐私审计要用） */
    contact?: number;
    /** 被评价的那条（有引用）或那一轮最后一条她的消息 id */
    herMessageId: number;
    her: string[];
    context: { role: 'user' | 'assistant'; text: string }[];
    tier: string;
}

/** 这一行是不是合法的反馈记录（旧文件里可能混着别的） */
export function isFeedbackRow(value: unknown): value is FeedbackRow {
    if (!value || typeof value !== 'object') return false;
    const row = value as Record<string, unknown>;
    return typeof row.at === 'string' && (row.label === 'fake' || row.label === 'real')
        && (row.contact === undefined || (Number.isSafeInteger(row.contact) && Number(row.contact) > 0));
}

const monthOf = (at: Date) => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}`;

/** feedback/YYYY-MM.jsonl，一行一条；只追加 */
export class FeedbackLog {
    readonly #dir: string;
    #known: Set<number> | undefined;
    #counts = new Map<string, number>();

    constructor(dataDir: string) {
        this.#dir = join(dataDir, 'feedback');
    }

    #load(): Set<number> {
        if (this.#known) return this.#known;
        const known = new Set<number>();
        if (existsSync(this.#dir)) {
            for (const name of readdirSync(this.#dir).filter(file => /^\d{4}-\d{2}\.jsonl$/.test(file))) {
                let count = 0;
                for (const line of readFileSync(join(this.#dir, name), 'utf8').split('\n')) {
                    if (!line.trim()) continue;
                    try {
                        const row = JSON.parse(line) as Partial<FeedbackRow>;
                        if (typeof row.messageId === 'number') known.add(row.messageId);
                        count++;
                    } catch { /* 坏行不挡路，也不算数 */ }
                }
                this.#counts.set(name.slice(0, 7), count);
            }
        }
        return this.#known = known;
    }

    has(messageId: number): boolean {
        return this.#load().has(messageId);
    }

    /** 追加一条，返回这个月的第几条 */
    record(row: FeedbackRow, at: Date): number {
        const known = this.#load();
        mkdirSync(this.#dir, { recursive: true });
        const month = monthOf(at);
        appendFileSync(join(this.#dir, `${month}.jsonl`), `${JSON.stringify(row)}\n`, 'utf8');
        known.add(row.messageId);
        const count = (this.#counts.get(month) ?? 0) + 1;
        this.#counts.set(month, count);
        return count;
    }
}

export interface FeedbackChannel {
    /**
     * 这条消息如果是对她的评价就记下来并返回 true（调用方不再当聊天处理）；不是、或者找不到被评价的那一轮就返回 false。
     * 同一条消息 id 只记一次（入口重投、重启后补回都可能再来一遍）。
     */
    consume(qq: number, tier: string, message: Segment[] | string, messageId: number, time: Date, history: readonly StoredMessage[]): boolean;
}

export function createFeedbackChannel(dataDir: string, log: (message: string) => void): FeedbackChannel {
    const store = new FeedbackLog(dataDir);
    return {
        consume(qq, tier, message, messageId, time, history) {
            const command = parseFeedback(message);
            if (!command) return false;
            if (store.has(messageId)) return true;
            const turn = locateTurn(history, time, command.replyTo);
            if (!turn) return false;
            const last = turn.her[turn.her.length - 1]!;
            const count = store.record({
                at: time.toISOString(),
                label: command.label,
                messageId,
                herMessageId: command.replyTo ?? last.messageId ?? 0,
                her: turn.her.map(message => message.content),
                context: turn.context.map(message => ({ role: message.role, text: message.content })),
                tier,
            }, time);
            log(`[${qq}] 反馈：${command.label === 'fake' ? '假' : '像'}（本月第 ${count} 条）`);
            return true;
        },
    };
}
