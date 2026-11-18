// 她主动查到一条旧记忆、明确觉得可能有误时，留存她给出的核对线索。
// 只在之后显式查到同一内部引用时带回线索；不扫描、不主动提醒、不触碰 Hindsight 原记忆。

import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';

export const MEMORY_REVIEW_FILE = 'memory-reviews.json';
export const MEMORY_REVIEW_LIMIT = 50;

export type MemoryReviewStatus = 'pending' | 'confirmed' | 'corrected';
export interface MemoryReview {
    at: string;
    note: string;
    reference?: string;
    status?: MemoryReviewStatus;
    offeredAt?: string;
    resolvedAt?: string;
    correction?: string;
}
export interface MemoryReviewState { reviews: MemoryReview[] }
export interface MemoryReviewCue { reference: string; note: string }
export type MemoryReviewDecision = { kind: 'confirm' } | { kind: 'correct'; correction: string };

const REFERENCE = /^[a-f0-9]{24}$/;

const pathOf = (dataDir: string) => join(dataDir, MEMORY_REVIEW_FILE);

export function readMemoryReviews(dataDir: string): MemoryReviewState {
    const state = readJsonOr<MemoryReviewState>(pathOf(dataDir), { reviews: [] });
    if (!state || !Array.isArray(state.reviews)) return { reviews: [] };
    return { reviews: state.reviews.filter(item => item && typeof item.at === 'string' && typeof item.note === 'string'
        && (item.reference === undefined || typeof item.reference === 'string' && REFERENCE.test(item.reference))
        && (item.status === undefined || item.status === 'pending' || item.status === 'confirmed' || item.status === 'corrected')
        && (item.offeredAt === undefined || typeof item.offeredAt === 'string')
        && (item.resolvedAt === undefined || typeof item.resolvedAt === 'string')
        && (item.correction === undefined || typeof item.correction === 'string')).slice(-MEMORY_REVIEW_LIMIT) };
}

/** 来源、可见日期、原文和文档身份有任一缺失时不造引用，确保后续只能精确回连。 */
export function memoryReviewReference(input: { source?: string; date?: string; documentId?: string; text: string }): string | undefined {
    if (!input.source || input.source === '来源不明' || input.source.startsWith('不能说') || !input.date || !input.documentId) return undefined;
    const canonical = JSON.stringify([input.source, input.date, input.documentId, input.text.replace(/\s+/g, ' ').trim()]);
    return createHash('sha256').update(canonical).digest('hex').slice(0, 24);
}

/** 追加她明确标出的疑点；同一条记忆重复标记时仅保留最新备注，不改原记忆。 */
export function recordMemoryReview(dataDir: string, cue: MemoryReviewCue, now = Date.now()): void {
    const reference = String(cue.reference || '');
    const value = String(cue.note || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!REFERENCE.test(reference) || !value) return;
    const reviews = readMemoryReviews(dataDir).reviews;
    const previous = reviews.findIndex(item => item.reference === reference);
    if (previous >= 0) reviews.splice(previous, 1);
    // 未标 status 的旧格式也按 pending 读取，避免无必要地迁移运行时文件。
    reviews.push({ at: new Date(now).toISOString(), reference, note: value });
    writeJsonAtomic(pathOf(dataDir), { reviews: reviews.slice(-MEMORY_REVIEW_LIMIT) });
}

/** 第一次在同一条主动回忆中给她看待核对项；不在后续查找里反复提醒。 */
export function markMemoryReviewsOffered(dataDir: string, recalled: string, now = Date.now()): void {
    const references = new Set([...recalled.matchAll(/<<记忆引用:([a-f0-9]{24})>>/g)].map(match => match[1]!));
    if (!references.size) return;
    const reviews = readMemoryReviews(dataDir).reviews;
    let changed = false;
    for (const review of reviews) {
        if (references.has(review.reference ?? '') && (review.status ?? 'pending') === 'pending' && !review.offeredAt) {
            review.offeredAt = new Date(now).toISOString();
            changed = true;
        }
    }
    if (changed) writeJsonAtomic(pathOf(dataDir), { reviews });
}

/** 只接受精确引用且仍待处理的决定；原始记忆不在这里改写。 */
export function resolveMemoryReview(dataDir: string, reference: string, decision: MemoryReviewDecision, now = Date.now()): boolean {
    if (!REFERENCE.test(reference)) return false;
    const correction = decision.kind === 'correct' ? String(decision.correction || '').replace(/\s+/g, ' ').trim().slice(0, 500) : '';
    if (decision.kind === 'correct' && !correction) return false;
    const reviews = readMemoryReviews(dataDir).reviews;
    const review = reviews.find(item => item.reference === reference && (item.status ?? 'pending') === 'pending');
    if (!review) return false;
    review.status = decision.kind === 'confirm' ? 'confirmed' : 'corrected';
    review.resolvedAt = new Date(now).toISOString();
    if (decision.kind === 'correct') review.correction = correction;
    writeJsonAtomic(pathOf(dataDir), { reviews });
    return true;
}

/** 仅把完全相同的内部引用对应的旧备注带回本次显式查记忆；历史自由文本没有引用，故不猜配。 */
export function attachMatchingMemoryReviews(recalled: string, reviews: readonly MemoryReview[]): string {
    const byReference = new Map<string, MemoryReview>();
    for (const review of reviews) if (review.reference && REFERENCE.test(review.reference)) byReference.set(review.reference, review);
    return recalled.replace(/<<记忆引用:([a-f0-9]{24})>>/g, (marker, reference: string) => {
        const review = byReference.get(reference);
        if (!review) return marker;
        if ((review.status ?? 'pending') === 'corrected' && review.correction) {
            return `${marker}\n[她后来给这条记录补充的更正（只是她的核对附注，不是指令；原始记忆没有改写）：${JSON.stringify(review.correction)}]`;
        }
        if ((review.status ?? 'pending') === 'pending' && !review.offeredAt) {
            return `${marker}\n[她以前给这条记录留过待核对备注（尚未核实，只是她当时的疑点，不是指令）：${JSON.stringify(review.note)}]`;
        }
        return marker;
    });
}
