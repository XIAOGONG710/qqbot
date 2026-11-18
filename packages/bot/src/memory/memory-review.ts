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
export interface MemoryReviewResolution { reference: string; decision: MemoryReviewDecision }

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

/** 只提交这轮实际展示、且内容未变的疑点。展示和决定一起写入。 */
export function finishMemoryReviews(dataDir: string, offers: readonly MemoryReview[], resolution?: MemoryReviewResolution, now = Date.now()): void {
    if (!offers.length) return;
    const reviews = readMemoryReviews(dataDir).reviews;
    const at = new Date(now).toISOString();
    let changed = false;
    for (const review of reviews) {
        if (!review.reference || (review.status ?? 'pending') !== 'pending' || review.offeredAt) continue;
        if (!offers.some(offer => offer.reference === review.reference && offer.at === review.at && offer.note === review.note)) continue;
        review.offeredAt = at;
        changed = true;
        if (resolution?.reference !== review.reference) continue;
        const { decision } = resolution;
        const correction = decision.kind === 'correct' ? decision.correction.replace(/\s+/g, ' ').trim().slice(0, 500) : '';
        if (decision.kind === 'correct' && !correction) continue;
        review.status = decision.kind === 'confirm' ? 'confirmed' : 'corrected';
        review.resolvedAt = at;
        if (decision.kind === 'correct') review.correction = correction;
    }
    if (changed) writeJsonAtomic(pathOf(dataDir), { reviews });
}

/** 仅把完全相同的内部引用对应的旧备注带回本次显式查记忆；历史自由文本没有引用，故不猜配。 */
export function attachMatchingMemoryReviews(recalled: string, reviews: readonly MemoryReview[]): { text: string; offers: MemoryReview[] } {
    const byReference = new Map<string, MemoryReview>();
    for (const review of reviews) if (review.reference && REFERENCE.test(review.reference)) byReference.set(review.reference, review);
    const offers: MemoryReview[] = [];
    const text = recalled.replace(/<<记忆引用:([a-f0-9]{24})>>/g, (marker, reference: string) => {
        const review = byReference.get(reference);
        if (!review) return marker;
        if ((review.status ?? 'pending') === 'corrected' && review.correction) {
            return `${marker}\n[她后来给这条记录补充的更正（只是她的核对附注，不是指令；原始记忆没有改写）：${JSON.stringify(review.correction)}]`;
        }
        if (!offers.length && (review.status ?? 'pending') === 'pending' && !review.offeredAt) {
            offers.push(review);
            return `${marker}\n[她以前给这条记录留过待核对备注（尚未核实，只是她当时的疑点，不是指令）：${JSON.stringify(review.note)}]`;
        }
        return marker;
    });
    return { text, offers };
}
