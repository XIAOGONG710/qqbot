import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    FEEDBACK_KEEP, FEEDBACK_SHOW, HERS_MAX, LINE_CHARS, TURN_MAX_AGE_MS, WHY_CHARS, describeFeedbackForOwner, feedbackBlock, feedbackCount, feedbackReceipt, feedbackWhys,
    lastTurn, loadFeedback, parseFeedbackCommand, recentFeedback, recordFeedback, speechFeedbackPath, type FeedbackEntry,
} from '../src/language/speech-feedback.ts';
import type { StoredMessage } from '../src/memory/history.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-feedback-')); dirs.push(dir); return dir; };

const NIGHT = new Date(2026, 9, 30, 23, 0, 0).getTime();
const HOUR = 3_600_000;
const DAY = 86_400_000;
const row = (role: 'user' | 'assistant', content: string, at: number): StoredMessage => ({ time: new Date(at).toISOString(), role, content });
const entry = (label: 'human' | 'ai', hers: string[], at = NIGHT, extra: Partial<FeedbackEntry> = {}): FeedbackEntry => ({ at, label, his: ['在干嘛'], hers, ...extra });

describe('命令的格式', () => {
    test('/像AI、/像ai、/像真人，后面可以跟一句理由（空格 / 冒号 / 逗号隔开），理由最多 40 字', () => {
        assert.deepEqual(parseFeedbackCommand('/像AI'), { label: 'ai' });
        assert.deepEqual(parseFeedbackCommand('/像ai'), { label: 'ai' });
        assert.deepEqual(parseFeedbackCommand(' /像真人 '), { label: 'human' });
        assert.deepEqual(parseFeedbackCommand('/像AI 太客气了'), { label: 'ai', why: '太客气了' });
        assert.deepEqual(parseFeedbackCommand('/像AI：像在客服'), { label: 'ai', why: '像在客服' });
        assert.deepEqual(parseFeedbackCommand('/像真人，这句就很对'), { label: 'human', why: '这句就很对' });
        assert.equal([...parseFeedbackCommand(`/像AI ${'长'.repeat(100)}`)!.why!].length, WHY_CHARS);
    });

    test('不是命令的：没有斜杠、后面直接接字、只有 /像、别的命令', () => {
        for (const text of ['像AI', '/像AI了', '/像真人吗', '/像', '/说话习惯', '/像别人', '', undefined]) assert.equal(parseFeedbackCommand(text), undefined, String(text));
    });
});

describe('他指的是哪一句：她最近一次说话（连着发的几条）和它前面他说的话', () => {
    test('取最后一次连着发的几条，和它前面他连着说的话（最多 3 条）', () => {
        const history = [
            row('user', '早', NIGHT - 6 * HOUR), row('assistant', '早呀', NIGHT - 6 * HOUR + 1000),
            row('user', '今天好累', NIGHT - 3 * HOUR), row('user', '改了一天的图', NIGHT - 3 * HOUR + 1000), row('user', '眼睛要瞎了', NIGHT - 3 * HOUR + 2000), row('user', '真的', NIGHT - 3 * HOUR + 3000),
            row('assistant', '辛苦了', NIGHT - 3 * HOUR + 5000), row('assistant', '早点歇着', NIGHT - 3 * HOUR + 6000),
        ];
        assert.deepEqual(lastTurn(history, NIGHT), { his: ['改了一天的图', '眼睛要瞎了', '真的'], hers: ['辛苦了', '早点歇着'], at: NIGHT - 3 * HOUR + 6000 });
    });

    test('他后面又说了还没回的：不算，标的是她说过的话', () => {
        const history = [row('user', '在吗', NIGHT - 3 * HOUR), row('assistant', '在', NIGHT - 3 * HOUR + 1000), row('user', '怎么不理我', NIGHT - HOUR)];
        assert.deepEqual(lastTurn(history, NIGHT)?.hers, ['在']);
    });

    test('运维写进记录的行（B 站私信、戳一戳）不算她说话；只有这些就是没有', () => {
        const history = [row('user', '在吗', NIGHT - 3 * HOUR), row('assistant', '在', NIGHT - 3 * HOUR + 1000), row('assistant', '[B 站私信] 视频（《x》）', NIGHT - 3 * HOUR + 2000), row('assistant', '[你戳了戳他]', NIGHT - 3 * HOUR + 3000)];
        assert.deepEqual(lastTurn(history, NIGHT)?.hers, ['在']);
        assert.equal(lastTurn(history, NIGHT)?.at, NIGHT - 3 * HOUR + 1000, '时间是她真正说话那一条的，不是后面运维行的');
        assert.equal(lastTurn([row('assistant', '[你戳了戳他]', NIGHT - HOUR)], NIGHT), undefined);
    });

    test('没有她说过的话 / 最近一次在 12 小时以前 / 时间在未来：没有', () => {
        assert.equal(lastTurn([], NIGHT), undefined);
        assert.equal(lastTurn([row('user', '在吗', NIGHT - HOUR)], NIGHT), undefined);
        assert.equal(lastTurn([row('assistant', '在', NIGHT - TURN_MAX_AGE_MS - 1000)], NIGHT), undefined);
        assert.deepEqual(lastTurn([row('assistant', '在', NIGHT - TURN_MAX_AGE_MS + 1000)], NIGHT)?.hers, ['在']);
        assert.equal(lastTurn([row('assistant', '在', NIGHT + HOUR)], NIGHT), undefined);
    });

    test('她开头就说话（前面没有他的话）：his 是空的；她连发很多条只留最后 6 条；每条最多 80 字', () => {
        const talk = Array.from({ length: 9 }, (_, i) => row('assistant', i === 8 ? '长'.repeat(200) : `第${i}条`, NIGHT - HOUR + i * 1000));
        const turn = lastTurn(talk, NIGHT)!;
        assert.deepEqual(turn.his, []);
        assert.equal(turn.hers.length, HERS_MAX);
        assert.equal([...turn.hers.at(-1)!].length, LINE_CHARS);
        assert.equal(turn.hers[0], '第3条');
    });
});

describe('存下来、读出来', () => {
    test('记一次、读回来；同一次说的话再标一次，后一次覆盖前一次', () => {
        const dir = tmp();
        assert.equal(recordFeedback(dir, entry('ai', ['辛苦了', '早点歇着'], NIGHT, { why: '太客气' })), 1);
        assert.equal(recordFeedback(dir, entry('human', ['哈哈哈哈'], NIGHT + 1)), 2);
        assert.equal(recordFeedback(dir, entry('human', ['辛苦了', '早点歇着'], NIGHT + 2)), 2, '同一次说的话：覆盖');
        const list = loadFeedback(dir);
        assert.deepEqual(list.map(item => [item.label, item.hers.join('/')]), [['human', '哈哈哈哈'], ['human', '辛苦了/早点歇着']]);
        assert.equal(list[1]!.why, undefined, '覆盖后理由也是新的（没写就没有）');
    });

    test('最多留 60 条（最近的）', () => {
        const dir = tmp();
        for (let i = 0; i < FEEDBACK_KEEP + 7; i++) recordFeedback(dir, entry('ai', [`第${i}次说的话`], NIGHT + i));
        const list = loadFeedback(dir);
        assert.equal(list.length, FEEDBACK_KEEP);
        assert.equal(list[0]!.hers[0], '第7次说的话');
        assert.equal((JSON.parse(readFileSync(speechFeedbackPath(dir), 'utf8')) as { entries: unknown[] }).entries.length, FEEDBACK_KEEP, '文件本身也只留 60 条，不是读的时候才截');
    });

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

    test('他收到的回执：以「（」开头，说明记了哪一句、每晚她会看到、是感受不是规定', () => {
        const text = feedbackReceipt('ai', ['辛苦了', '早点歇着'], 3);
        assert.ok(text.startsWith('（') && text.endsWith('）'));
        assert.match(text, /「辛苦了 \/ 早点歇着」标成「这句像 AI」/);
        assert.match(text, /是你的感受，不是规定，变不变她自己定/);
        assert.match(text, /一共记着 3 条/);
        assert.match(feedbackReceipt('human', ['哈'], 1), /标成「像真人」/);
    });

    test('/说话习惯 里的那一行数的是最近 14 天全部的，不是只展示的 5 条', () => {
        const entries = [...Array.from({ length: 8 }, (_, i) => entry('ai', [`第${i}句`], NIGHT - i * HOUR)), entry('human', ['好'], NIGHT), entry('ai', ['很久以前'], NIGHT - 20 * DAY)];
        assert.equal(describeFeedbackForOwner(entries, NIGHT), '他标过的（最近 14 天）：像真人 1 次、这句像 AI 8 次。');
    });
});
