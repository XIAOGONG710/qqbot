import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { MEMORY_REVIEW_FILE, MEMORY_REVIEW_LIMIT, readMemoryReviews, recordMemoryReview } from '../src/memory/memory-review.ts';

describe('待核对的旧记忆', () => {
    test('只追加她明确给出的核对线索；不会改写原记忆；有界保存', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-review-'));
        try {
            recordMemoryReview(dir, '  10月2日｜和阿明聊的｜第一次见面地点｜可能记错  ', Date.parse('2026-11-18T12:00:00Z'));
            assert.deepEqual(readMemoryReviews(dir).reviews, [{
                at: '2026-11-18T12:00:00.000Z', note: '10月2日｜和阿明聊的｜第一次见面地点｜可能记错',
            }]);
            for (let i = 0; i < MEMORY_REVIEW_LIMIT + 3; i++) recordMemoryReview(dir, `线索 ${i}`, Date.parse('2026-11-18T12:00:00Z') + i);
            const reviews = readMemoryReviews(dir).reviews;
            assert.equal(reviews.length, MEMORY_REVIEW_LIMIT);
            assert.equal(reviews[0]!.note, '线索 3');
            assert.equal(reviews.at(-1)!.note, `线索 ${MEMORY_REVIEW_LIMIT + 2}`);
            assert.deepEqual(JSON.parse(readFileSync(join(dir, MEMORY_REVIEW_FILE), 'utf8')).reviews, reviews);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('空线索不落盘', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-review-empty-'));
        try {
            recordMemoryReview(dir, '  ');
            assert.deepEqual(readMemoryReviews(dir), { reviews: [] });
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });
});
