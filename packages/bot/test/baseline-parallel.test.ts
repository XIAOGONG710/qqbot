import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { parseOptions, pickScenarios, summarize } from './baseline/parallel.ts';
import { firstDifference } from './baseline/compare.ts';

// 行为基线的并行跑法（baseline/parallel.ts）：参数、挑场景、汇总。真跑场景的那一半就是 baseline.test.ts 的同一个 runScenario + compareSnapshot。

describe('行为基线的并行跑法', () => {
    test('参数：默认进程数 = CPU - 1（至少 1、最多 8）；--jobs、--only；不认识的报错', () => {
        assert.deepEqual(parseOptions([], 6), { jobs: 5 });
        assert.deepEqual(parseOptions([], 1), { jobs: 1 });
        assert.deepEqual(parseOptions([], 32), { jobs: 8 });
        assert.deepEqual(parseOptions(['--jobs', '3', '--only', 'a, b'], 6), { jobs: 3, only: ['a', 'b'] });
        assert.match(parseOptions(['--jobs', '0'], 6) as string, /不认识/);
        assert.match(parseOptions(['--only'], 6) as string, /要跟值/);
        assert.match(parseOptions(['--update'], 6) as string, /--update/);
    });

    test('挑场景：按原顺序；--only 里有不存在的名字就报错', () => {
        assert.deepEqual(pickScenarios(['a', 'b', 'c'], undefined), ['a', 'b', 'c']);
        assert.deepEqual(pickScenarios(['a', 'b', 'c'], ['c', 'a']), ['a', 'c']);
        assert.match(pickScenarios(['a'], ['a', 'x']) as string, /没有这些场景：x/);
    });

    test('汇总：全过才算过；没跑完的也算没过；不一样的逐个列出', () => {
        assert.deepEqual(summarize([{ name: 'a', ok: true, ms: 1 }], 1, 5000), { ok: true, text: '行为基线：1/1 逐字一致（5 秒）' });
        const bad = summarize([{ name: 'a', ok: true, ms: 1 }, { name: 'b', ok: false, ms: 1, problem: '第 3 行' }], 3, 1000);
        assert.equal(bad.ok, false);
        assert.match(bad.text, /1\/3 逐字一致，1 个没跑完/);
        assert.match(bad.text, /✖ b\n第 3 行/);
    });

    test('第一处不同（两种跑法共用）', () => {
        assert.match(firstDifference('a\nb', 'a\nc'), /第 2 行\n  快照：b\n  实际：c/);
        assert.equal(firstDifference('a', 'a\n'), '第 2 行\n  快照：（没有这一行）\n  实际：');
    });
});

describe('和快照比（两种跑法共用）', () => {
    test('一样返回 undefined；不一样给出第一处不同、实际结果写到临时目录；没有快照就说', async () => {
        const { compareSnapshot, snapshotPath } = await import('./baseline/compare.ts');
        const { readFileSync, existsSync } = await import('node:fs');
        const expected = readFileSync(snapshotPath('asleep'), 'utf8');
        assert.equal(compareSnapshot('asleep', expected), undefined);
        const problem = compareSnapshot('asleep', `${expected}多一行`)!;
        assert.match(problem, /行为和快照不一致/);
        const out = /实际结果：(.+)/.exec(problem)![1]!;
        assert.ok(existsSync(out));
        assert.match(compareSnapshot('没有这个场景', '')!, /没有快照/);
    });
});

describe('长的先发', () => {
    test('按上次用时从长到短；没记过的排最前；一样长保持原顺序', async () => {
        const { longestFirst } = await import('./baseline/parallel.ts');
        assert.deepEqual(longestFirst(['a', 'b', 'c', 'd'], { a: 10, b: 300, d: 10 }), ['c', 'b', 'a', 'd']);
    });
    test('记录读不了、格式不对：当没有', async () => {
        const { readTimes } = await import('./baseline/parallel.ts');
        const { mkdtempSync, writeFileSync } = await import('node:fs');
        const { join } = await import('node:path');
        const { tmpdir } = await import('node:os');
        const dir = mkdtempSync(join(tmpdir(), 'baseline-times-'));
        assert.deepEqual(readTimes(join(dir, '没有')), {});
        writeFileSync(join(dir, 't.json'), '[1,2]');
        assert.deepEqual(readTimes(join(dir, 't.json')), {});
        writeFileSync(join(dir, 't.json'), '{"a":5,"b":"x"}');
        assert.deepEqual(readTimes(join(dir, 't.json')), { a: 5 });
    });
});
