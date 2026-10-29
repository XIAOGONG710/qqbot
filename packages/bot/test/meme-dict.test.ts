import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openMemeDict } from '../src/language/meme-dict.ts';

const dir = mkdtempSync(join(tmpdir(), 'meme-dict-'));
const path = join(dir, 'dict.json');
const entry = (term: string, patch: Record<string, string> = {}) => ({ term, meaning: `${term}怎么用的一句话`, origin: `${term}的出处`, tags: '游戏、抽象', summary: '', ...patch });
writeFileSync(path, JSON.stringify({ version: 1, entries: [entry('启动！'), entry('启动'), entry('省流', { tags: '论坛、缩写' })] }));

test('字典：完全同名叫得出来；读不到就 undefined', () => {
    const dict = openMemeDict(path)!;
    assert.ok(dict);
    assert.equal(dict.count(), 3);
    assert.equal(dict.lookup('省流')?.tags, '论坛、缩写');
    assert.equal(dict.lookup('不存在的词'), undefined);
    assert.equal(openMemeDict(join(dir, 'nope.json')), undefined);
});

test('字典：他这句里最长的那个词优先（「启动！」压过「启动」）', () => {
    const dict = openMemeDict(path)!;
    const hit = dict.mention('原神，启动！今天必须打上分');
    assert.equal(hit?.term, '启动！');
    assert.equal(dict.mention('今天天气不错'), undefined);
});

test('字典：坏文件不抛', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ 不是 json');
    assert.equal(openMemeDict(bad), undefined);
});

test.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Windows 上可能删不掉 */ } });
