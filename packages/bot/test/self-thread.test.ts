import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selfThread, selfThreadLine } from '../src/language/self-thread.ts';

const journal = `# 日记

## 2026-10-29
今天睡睡醒醒，把《药屋少女的呢喃》剩下的几卷看完了。夜里他又不肯睡，先嘱咐我早点睡。他先睡的，我躺着又想了半天。
`;

test('从日记最后一段摘一两句', () => {
    const thread = selfThread(journal)!;
    assert.equal(thread.date, '2026-10-29');
    assert.ok(thread.text.includes('药屋少女'));
    assert.ok([...thread.text].length <= 90);
});

test('没有日记就是没有；不编', () => {
    assert.equal(selfThread(''), undefined);
    assert.equal(selfThread('只有一行没日期的话'), undefined);
    assert.equal(selfThreadLine(undefined), undefined);
});

test('递给她的是许可，不是任务', () => {
    const line = selfThreadLine(selfThread(journal))!;
    assert.ok(line.includes('想带一句自己的事就带一句'));
    assert.ok(line.includes('不用每轮都带'));
    assert.ok(!line.includes('必须'));
});
