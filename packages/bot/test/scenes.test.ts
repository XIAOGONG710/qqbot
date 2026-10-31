import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readScene } from '../src/language/scenes.ts';

// 证据来自她自己的聊天记录（ginka 批量诊断 45 段）：该接的没接，才写成这句
test('「哄我睡觉呗」要接哄睡，不是让他睡', () => {
    const scene = readScene('哄我睡觉呗')!;
    assert.equal(scene.kind, '哄睡');
    assert.ok(scene.line.includes('先接这个动作'));
    assert.ok(scene.line.includes('别回「那你睡吧'));
});

test('讲代码报错：先问原文，别先调侃', () => {
    assert.equal(readScene('我这边报错了，登录接口 500')?.kind, '报错');
    assert.ok(readScene('跑不起来')!.line.includes('报错原文'));
});

test('自我怀疑：先给明确回答', () => {
    assert.equal(readScene('你会因为这个看不起我吗？')?.kind, '自我怀疑');
    assert.ok(readScene('我是不是有点变态')!.line.includes('先正面给一句明确的回答'));
});

test('看不懂的缩写先问，不猜；普通英文单词不误伤', () => {
    assert.equal(readScene('zdjd')?.kind, '暗号');
    assert.equal(readScene('yyds')?.kind, '暗号');
    assert.equal(readScene('ok'), undefined);
    assert.equal(readScene('今天吃什么'), undefined);
});
