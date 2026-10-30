import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readTurn, readingLine, recentTopics } from '../src/language/reading.ts';

const msg = (role: 'user' | 'assistant', content: string, minutes: number) => ({ role, content, time: new Date(Date.UTC(2026, 9, 30, 12, minutes)).toISOString() });

// 线上真实 bug：「我长相一般」+「的」分两条发，她只回了最后那个「的」
test('他连着发几条算一句，不被最后那个碎片骗', () => {
    const turn = readTurn([msg('assistant', '你咋了', 0), msg('user', '我长相一般', 1), msg('user', '的', 1)]);
    assert.ok(turn);
    assert.equal(turn.parts, 2);
    assert.equal(turn.said, '我长相一般的');
});

test('他自己另起一句（隔得久）就不并', () => {
    const turn = readTurn([msg('user', '在吗', 0), msg('assistant', '在', 1), msg('user', '明天吃什么', 30)]);
    assert.equal(turn?.parts, 1);
});

test('指代词：把他前面说过的事摆出来当候选', () => {
    const turn = readTurn([msg('user', '今天面试被拒了', 0), msg('assistant', '啊？', 1), msg('user', '那个我还没缓过来', 2)]);
    assert.deepEqual(turn?.referent, ['今天面试被拒了']);
    const line = readingLine(turn)!;
    assert.ok(line.includes('面试被拒'));
    assert.ok(line.includes('先想清楚'));
});

test('寒暄和太短的句子不当候选；没他的话就没有这一行', () => {
    assert.deepEqual(recentTopics([msg('user', '在吗', 0), msg('user', '嗯', 1)], 2), []);
    assert.equal(readTurn([]), undefined);
    assert.equal(readingLine(undefined), undefined);
});
