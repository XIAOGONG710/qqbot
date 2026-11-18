import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { attachMatchingMemoryReviews, finishMemoryReviews, memoryReviewReference, MEMORY_REVIEW_FILE, MEMORY_REVIEW_LIMIT, readMemoryReviews, recordMemoryReview } from '../src/memory/memory-review.ts';

describe('待核对的旧记忆', () => {
    test('只结案本轮展示且未被替换的疑点', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-review-finish-'));
        try {
            const reference = 'a'.repeat(24);
            const recalled = `- 合成记录 <<记忆引用:${reference}>>`;
            const resolution = { reference, decision: { kind: 'correct', correction: '是校门外' } } as const;
            recordMemoryReview(dir, { reference, note: '疑点一' }, 1);
            const previous = attachMatchingMemoryReviews(recalled, readMemoryReviews(dir).reviews).offers;
            recordMemoryReview(dir, { reference, note: '更新后的疑点' }, 2);
            finishMemoryReviews(dir, previous, resolution, 3);
            assert.equal(readMemoryReviews(dir).reviews[0]?.offeredAt, undefined);

            const current = attachMatchingMemoryReviews(recalled, readMemoryReviews(dir).reviews);
            finishMemoryReviews(dir, current.offers, resolution, 4);
            const state = readMemoryReviews(dir);
            assert.equal(state.reviews[0]?.status, 'corrected');
            assert.equal(state.reviews[0]?.correction, '是校门外');
            assert.deepEqual(attachMatchingMemoryReviews(recalled, state.reviews).offers, []);
            assert.match(attachMatchingMemoryReviews(recalled, state.reviews).text, /补充的更正.*是校门外/);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('只追加她明确给出的核对线索；不会改写原记忆；有界保存', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-review-'));
        try {
            const reference = 'a'.repeat(24);
            recordMemoryReview(dir, { reference, note: '  可能记错  ' }, Date.parse('2026-11-18T12:00:00Z'));
            assert.deepEqual(readMemoryReviews(dir).reviews, [{
                at: '2026-11-18T12:00:00.000Z', reference, note: '可能记错',
            }]);
            for (let i = 0; i < MEMORY_REVIEW_LIMIT + 3; i++) recordMemoryReview(dir, { reference: i.toString(16).padStart(24, '0'), note: `线索 ${i}` }, Date.parse('2026-11-18T12:00:00Z') + i);
            const reviews = readMemoryReviews(dir).reviews;
            assert.equal(reviews.length, MEMORY_REVIEW_LIMIT);
            assert.equal(reviews[0]!.note, '线索 3');
            assert.equal(reviews.at(-1)!.note, `线索 ${MEMORY_REVIEW_LIMIT + 2}`);
            assert.equal(reviews[0]!.reference, (3).toString(16).padStart(24, '0'));
            assert.deepEqual(JSON.parse(readFileSync(join(dir, MEMORY_REVIEW_FILE), 'utf8')).reviews, reviews);
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('空线索不落盘', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-review-empty-'));
        try {
            recordMemoryReview(dir, { reference: 'a'.repeat(24), note: '  ' });
            assert.deepEqual(readMemoryReviews(dir), { reviews: [] });
        } finally { rmSync(dir, { recursive: true, force: true }); }
    });

    test('回查只接受完全相同的来源、日期、文档与原记录；不确定来源不建引用', () => {
        const base = { source: '和阿明的私聊', date: '2026-10-02', documentId: '0:ep-1', text: '第一次见面在校门口' };
        const reference = memoryReviewReference(base)!;
        assert.equal(memoryReviewReference(base), reference);
        assert.notEqual(memoryReviewReference({ ...base, source: '和小李的私聊' }), reference);
        assert.notEqual(memoryReviewReference({ ...base, date: '2026-10-03' }), reference);
        assert.notEqual(memoryReviewReference({ ...base, documentId: '1:ep-1' }), reference);
        assert.notEqual(memoryReviewReference({ ...base, text: '第一次见面在校门外' }), reference);
        assert.equal(memoryReviewReference({ ...base, source: '来源不明' }), undefined);

        const pending = [{ at: '2026-11-18T12:00:00Z', reference, note: '地点可能记错' }];
        const recalled = `- 10月2日（和阿明的私聊）：第一次见面在校门口 <<记忆引用:${reference}>>`;
        const attached = attachMatchingMemoryReviews(recalled, pending);
        assert.match(attached.text, /待核对备注.*地点可能记错/);
        assert.deepEqual(attached.offers, pending);
        assert.equal(attachMatchingMemoryReviews(recalled, [{ at: pending[0]!.at, note: pending[0]!.note }]).text, recalled, '旧的自由文本记录没有引用时不猜配');
        assert.equal(attachMatchingMemoryReviews(recalled, [{ ...pending[0]!, reference: 'b'.repeat(24) }]).text, recalled, '其他引用不匹配');
    });
});
