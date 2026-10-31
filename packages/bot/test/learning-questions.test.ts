import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadQuestion, questionLine, questionPrompt, QUESTION_TTL_MS, saveQuestion } from '../src/life/learning-questions.ts';

// 用户 10-31：她学的不会的没问过他
test('存一个问题、两天内递给她、过期就作废', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-lq-'));
    const now = Date.now();
    saveQuestion(dir, { at: now, question: '「别客套」到底算不算把话说死', from: '说话笔记' });
    assert.equal(loadQuestion(dir)?.question, '「别客套」到底算不算把话说死');
    const line = questionLine(loadQuestion(dir), now)!;
    assert.ok(line.includes('没想通'));
    assert.ok(line.includes('说话笔记'));
    assert.equal(questionLine(loadQuestion(dir), now + QUESTION_TTL_MS + 1), undefined, '两天没问出口就不追了');
    assert.equal(questionLine(undefined, now), undefined);
});

test('让她自己想一个真没想通的问题，不要开场白', () => {
    const prompt = questionPrompt({ notes: '我说话爱拆条', journal: '今天去图书馆', books: '人间草木', name: '林梦瑶' });
    assert.ok(prompt.system.includes('SKIP'));
    assert.ok(prompt.system.includes('不超过 40 字'));
    assert.ok(prompt.user.includes('我说话爱拆条'));
});
