import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { notebookLearning, notebookToneHint } from '../src/life/notebook-learning.ts';
import { emptyTakesState, saveTakesState, type Take } from '../src/life/reading-takes.ts';

test('验证过的笔记经验跨重开复用，偏好按场景，流水保留日期', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-notebook-'));
    try {
        const at = Date.parse('2026-11-27T12:00:00+08:00');
        const take = (id: string, title: string, text: string, time: number): Take => ({ id, key: `book:${id}`, kind: 'book', title, names: [], text, at: time, progress: 1 });
        saveTakesState(dir, { ...emptyTakesState(), takes: [take('early', '航海', '潮汐提醒我换个时间出船。', at),
            take('later', '园艺', '种子放阴凉处。', at + 60_000)] });
        const open = () => notebookLearning(dir, 'Asia/Shanghai', () => {});
        const first = open();
        const query = '找一下读书笔记，主题航海，关键词潮汐';
        first.observe('a', `${query}，按日期查 2026-11-26`, at + 120_000);
        assert.equal(first.preference(query), undefined);
        first.observe('b', `${query}，按主题查`, at + 180_000);
        first.observe('b', `${query}，按主题查`, at + 180_000);
        const stored = [take('early', '航海', '潮汐提醒我换个时间出船。', at), take('later', '园艺', '种子放阴凉处。', at + 60_000),
            take('uncorroborated', '航海补记', '潮汐也会影响另一条路线。', at + 200_000)];
        saveTakesState(dir, { ...emptyTakesState(), takes: stored });
        const next = open();
        assert.deepEqual(next.preference(query), { method: 'topic', evidence: ['a', 'b'] });
        assert.match(next.reply(query)!, /沿用.*主题.*关键词[^]*潮汐提醒/);
        assert.match(next.reply(query, at + 210_000)!, /潮汐提醒[^]*另一条路线/, '复用上次验证可用的笔记，排在后来加入的候选之前');
        assert.match(next.reply('找下关于航海的读书笔记，提到潮汐。', at + 210_000)!, /沿用已验证[^]*潮汐提醒/);
        assert.equal(next.preference('查找读书笔记，主题园艺，关键词种子'), undefined);
        assert.match(next.reply('查一下读书笔记流水')!, /按日期[^]*2026-11-27[^]*航海[^]*园艺/);
        const beforeFeedback = next.preference(query);
        next.observe('feedback', '你刚才说话太直了。', at + 240_000);
        assert.match(notebookToneHint('你刚才说话太直了。')!, /只.*这轮|只在这一轮/);
        assert.equal(notebookToneHint('继续之前的话题'), undefined);
        assert.deepEqual(next.preference(query), beforeFeedback);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
