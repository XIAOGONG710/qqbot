import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askHint } from '../src/language/asks.ts';

// 用户 10-31：「我希望她能有更多的问题来问我」——要真问题，不是多打问号
test('他只丢情绪：让她问具体的事，不是「你怎么了」', () => {
    const hint = askHint('好烦')!;
    assert.equal(hint.why, '只有情绪');
    assert.ok(hint.line.includes('问具体的'));
    assert.ok(hint.line.includes('别问'));
});

test('他只给结论 / 太短：也给她一个问的方向', () => {
    assert.equal(askHint('确实')?.why, '只有结论');
    assert.equal(askHint('在吗')?.why, '太短');
    assert.ok(askHint('没事')!.line.includes('问具体的'));
    assert.ok(askHint('在吗')!.line.includes('一句'));
});

test('他在问她时不抢着问；说了一句完整的话也不硬加问题', () => {
    assert.equal(askHint('你今天吃什么了？'), undefined);
    assert.equal(askHint('今天面试官问了我三个问题，最后一个挺刁的'), undefined);
    assert.equal(askHint(''), undefined);
});
