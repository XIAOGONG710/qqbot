import assert from 'node:assert/strict';
import { test } from 'node:test';
import { idleHint, thinkHint } from '../src/language/asks.ts';

// 用户 10-31：要「真正的思考的问题」，不是打探日程
test('他收尾或只说一句短话：让她带着自己的判断去问，而不是问吃啥', () => {
    const hint = thinkHint('好烦')!;
    assert.equal(hint.why, '他在收尾');
    assert.ok(hint.line.includes('你自己的看法'));
    assert.ok(hint.line.includes('别问日程'));
    const short = thinkHint('在吗')!;
    assert.ok(short.line.includes('假设'));
});

test('他在问她、或说了一句完整的话：不抢着问', () => {
    assert.equal(thinkHint('你觉得我今天该干嘛？'), undefined);
    assert.equal(thinkHint('今天面试官问了三个问题，最后一个挺刁的'), undefined);
    assert.equal(thinkHint(''), undefined);
});

test('两个人都干着的时候：给她一次自己开话题的机会', () => {
    const line = idleHint();
    assert.ok(line.includes('先说你怎么想的'));
    assert.ok(line.includes('问他的看法'));
});
