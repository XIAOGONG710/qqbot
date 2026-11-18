// 她主动查到一条旧记忆、明确觉得可能有误时，留存她给出的核对线索。
// 这里只记待核对记录，不触碰 Hindsight 原记忆，也不自动安排提醒或改写。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';

export const MEMORY_REVIEW_FILE = 'memory-reviews.json';
export const MEMORY_REVIEW_LIMIT = 50;

export interface MemoryReview { at: string; note: string }
export interface MemoryReviewState { reviews: MemoryReview[] }

const pathOf = (dataDir: string) => join(dataDir, MEMORY_REVIEW_FILE);

export function readMemoryReviews(dataDir: string): MemoryReviewState {
    const state = readJsonOr<MemoryReviewState>(pathOf(dataDir), { reviews: [] });
    if (!state || !Array.isArray(state.reviews)) return { reviews: [] };
    return { reviews: state.reviews.filter(item => item && typeof item.at === 'string' && typeof item.note === 'string').slice(-MEMORY_REVIEW_LIMIT) };
}

export function recordMemoryReview(dataDir: string, note: string, now = Date.now()): void {
    const value = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!value) return;
    const reviews = readMemoryReviews(dataDir).reviews;
    reviews.push({ at: new Date(now).toISOString(), note: value });
    writeJsonAtomic(pathOf(dataDir), { reviews: reviews.slice(-MEMORY_REVIEW_LIMIT) });
}
