import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    FEEDBACK_KEEP, FEEDBACK_SHOW, WHY_CHARS, feedbackBlock, feedbackCount, feedbackWhys, loadFeedback, recentFeedback, speechFeedbackPath, type FeedbackEntry,
} from '../src/language/speech-feedback.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-feedback-')); dirs.push(dir); return dir; };

const NIGHT = new Date(2026, 9, 30, 23, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const entry = (label: 'human' | 'ai', hers: string[], at = NIGHT, extra: Partial<FeedbackEntry> = {}): FeedbackEntry => ({ at, label, his: ['在干嘛'], hers, ...extra });

describe('读出来（10-31 起不再有新的写入，只读旧的）', () => {
    test('坏文件 / 缺字段 / 标签不对当没有；超长的截断；没有她的话的不要', () => {
        const dir = tmp();
        writeFileSync(speechFeedbackPath(dir), '{坏');
        assert.deepEqual(loadFeedback(dir), []);
        writeFileSync(speechFeedbackPath(dir), JSON.stringify({ entries: [
            { at: 1, label: 'maybe', hers: ['x'] }, { at: 2, label: 'ai' }, { at: 3, label: 'ai', hers: [] }, { at: 4, label: 'ai', hers: [7, '  '] },
            { at: 5, label: 'human', hers: ['好的一条'], his: ['他说的', 3, ''], why: '长'.repeat(100) },
        ] }));
        const list = loadFeedback(dir);
        assert.equal(list.length, 1);
        assert.deepEqual(list[0]!.his, ['他说的']);
        assert.equal([...list[0]!.why!].length, WHY_CHARS);
        writeFileSync(speechFeedbackPath(dir), JSON.stringify([1, 2]));
        assert.deepEqual(loadFeedback(dir), []);
    });

    test('读的时候也只留最近 60 条（文件是别处写的、条数超了）', () => {
        const dir = tmp();
        writeFileSync(speechFeedbackPath(dir), JSON.stringify({ entries: Array.from({ length: FEEDBACK_KEEP + 10 }, (_, i) => ({ at: NIGHT + i, label: 'ai', his: [], hers: [`第${i}次`] })) }));
        const list = loadFeedback(dir);
        assert.equal(list.length, FEEDBACK_KEEP);
        assert.equal(list[0]!.hers[0], '第10次');
    });

    test('recentFeedback：只要最近 14 天的、每一类最近 5 条；未来的不要', () => {
        const entries = [
            entry('human', ['十五天前'], NIGHT - 15 * DAY),
            ...Array.from({ length: 8 }, (_, i) => entry('ai', [`像 AI 第${i}句`], NIGHT - (8 - i) * HOUR)),
            ...Array.from({ length: 2 }, (_, i) => entry('human', [`像真人第${i}句`], NIGHT - (2 - i) * HOUR)),
            entry('human', ['未来的'], NIGHT + 2 * DAY),
        ];
        const bundle = recentFeedback(entries, NIGHT);
        assert.equal(bundle.ai.length, FEEDBACK_SHOW);
        assert.equal(bundle.ai[0]!.hers[0], '像 AI 第3句', '留最近的 5 条');
        assert.deepEqual(bundle.human.map(item => item.hers[0]), ['像真人第0句', '像真人第1句']);
        assert.equal(feedbackCount(bundle), 7);
        assert.ok(![...bundle.ai, ...bundle.human].some(item => /十五天前|未来/.test(item.hers[0]!)));
    });
});

describe('每晚想的时候她看到什么', () => {
    test('两类分开写；带他前面的话和她的回；理由单独一行；写明是他的感受不是规定', () => {
        const block = feedbackBlock({
            human: [entry('human', ['哈哈哈哈', '你好笨'], NIGHT, { his: ['我又把钥匙锁屋里了'] })],
            ai: [entry('ai', ['辛苦了', '早点歇着'], NIGHT, { his: ['今天好累'], why: '像在客服' })],
        }, '宝宝');
        assert.match(block, /宝宝最近标过的（这是他的感受，不是规定；你想不想变、怎么变你自己定/);
        assert.match(block, /他觉得「像真人」的：\n宝宝：我又把钥匙锁屋里了\n你：哈哈哈哈 \/ 你好笨/);
        assert.match(block, /他觉得「这句像 AI」的：\n宝宝：今天好累\n你：辛苦了 \/ 早点歇着\n（宝宝说：像在客服）/);
        assert.ok(block.indexOf('像真人') < block.indexOf('像 AI'));
        assert.equal(feedbackBlock({ human: [], ai: [] }, '宝宝'), '');
        const onlyAi = feedbackBlock({ human: [], ai: [entry('ai', ['好的呢'])] }, '宝宝');
        assert.doesNotMatch(onlyAi, /他觉得「像真人」/);
    });

    test('理由里他的话也交给防照抄：feedbackWhys', () => {
        assert.deepEqual(feedbackWhys({ human: [entry('human', ['a'], NIGHT, { why: '这句就很对' })], ai: [entry('ai', ['b']), entry('ai', ['c'], NIGHT, { why: '像在客服' })] }), ['这句就很对', '像在客服']);
    });
});
