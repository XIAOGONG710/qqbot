import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opinionHint } from '../src/language/opinion.ts';

// 证据：最近 200 条她说的，带自己判断的 0 条
test('他问看法：先给判断，不准把问题推回去', () => {
    const hint = opinionHint('你觉得我这份工作怎么样？')!;
    assert.ok(hint.line.includes('先给你的判断'));
    assert.ok(hint.line.includes('不是反问'));
});

test('他让她选：先选一个，说清卡在哪也行', () => {
    assert.equal(opinionHint('这两个哪个好')?.why, '他在让你选');
    assert.ok(opinionHint('要不要买这个相机')!.line.includes('先选一个'));
});

test('他试探态度：直接给喜欢/不喜欢，别糊', () => {
    assert.equal(opinionHint('你喜不喜欢我这样')?.why, '他在试探你的态度');
    assert.ok(opinionHint('你介意我晚点回吗')!.line.includes('直接给态度'));
});

test('普通聊天不硬塞表态', () => {
    assert.equal(opinionHint('今天下雨了'), undefined);
    assert.equal(opinionHint(''), undefined);
});
