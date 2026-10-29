import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exemplarLine, loadExemplars, looksCopied, pickExemplars, type Exemplar } from '../src/language/exemplars.ts';

const ex = (id: string, said: string, replied: string[]): Exemplar => ({ id, source: `t#${id}`, license: 'test', said, replied });

test('挑例子：按他说的话挑最像的，同样的输入挑同样的', () => {
    const pool = [
        ex('a', '今天好累啊', ['累就别硬撑了']),
        ex('b', '晚上吃什么', ['随便，你定']),
        ex('c', '我今天好累', ['那早点睡']),
    ];
    const picked = pickExemplars(pool, '今天真的好累', { k: 2 });
    assert.equal(picked.length, 2);
    assert.ok(picked.some(p => p.id === 'a'));
    assert.deepEqual(picked, pickExemplars(pool, '今天真的好累', { k: 2 }));
    assert.deepEqual(pickExemplars(pool, '完全不相关的一句话'), [], '没有共同二字词就不硬凑');
});

test('例子行：写清是怎么回、别抄别搬情景', () => {
    const line = exemplarLine([ex('a', '今天好累', ['累就早点歇着'])]);
    assert.ok(line?.includes('学那个'));
    assert.ok(line?.includes('不准原样抄'));
    assert.ok(line?.includes('累就早点歇着'));
    assert.equal(exemplarLine([]), undefined);
});

test('防照抄：连着 8 个字一样就报', () => {
    const examples = [ex('a', 'x', ['那就早点睡别再熬夜了'])];
    assert.equal(looksCopied('那就早点睡别再熬夜了', examples), true);
    assert.equal(looksCopied('早点睡吧', examples), false);
});

test('语料文件不在就是空的，不抛', () => {
    assert.deepEqual(loadExemplars(join(mkdtempSync(join(tmpdir(), 'ex-')), 'nope.jsonl')), []);
});

test('语料：坏行跳过', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ex-'));
    const path = join(dir, 'corpus.jsonl');
    writeFileSync(path, `${JSON.stringify(ex('a', '在吗', ['在']))}\n{坏行\n`);
    assert.equal(loadExemplars(path).length, 1);
});
