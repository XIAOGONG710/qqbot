// 行为基线（ADR 0263 第 2 步）：架构迁移的每一步都必须让这些快照逐字不变。
// 有意改变行为时才更新快照：UPDATE_BASELINE=1 npm test -w @qqbot/bot（或只跑这个文件），并在提交说明里写清为什么变。
// 对不上时，实际结果写到系统临时目录，断言信息里给出路径和第一处不同。

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { runScenario } from './baseline/harness.ts';
import { SCENARIOS } from './baseline/scenarios.ts';

const SNAPSHOTS = resolve(import.meta.dirname, 'baseline', 'snapshots');
const update = process.env.UPDATE_BASELINE === '1';

function firstDifference(expected: string, actual: string): string {
    const a = expected.split('\n');
    const b = actual.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) return `第 ${i + 1} 行\n  快照：${(a[i] ?? '（没有这一行）').slice(0, 300)}\n  实际：${(b[i] ?? '（没有这一行）').slice(0, 300)}`;
    }
    return '（逐行相同，差在结尾）';
}

describe('行为基线（ADR 0263）', () => {
    test('场景名不重复', () => {
        assert.equal(new Set(SCENARIOS.map(s => s.name)).size, SCENARIOS.length);
    });

    for (const scenario of SCENARIOS) {
        test(`${scenario.name}：${scenario.about}`, async () => {
            const actual = await runScenario(scenario);
            const path = join(SNAPSHOTS, `${scenario.name}.txt`);
            if (update) {
                mkdirSync(SNAPSHOTS, { recursive: true });
                writeFileSync(path, actual);
                return;
            }
            assert.ok(existsSync(path), `没有快照 ${path}：先用 UPDATE_BASELINE=1 生成`);
            const expected = readFileSync(path, 'utf8');
            if (actual !== expected) {
                const out = join(mkdtempSync(join(tmpdir(), 'qqbot-baseline-diff-')), `${scenario.name}.txt`);
                writeFileSync(out, actual);
                assert.fail(`行为和快照不一致：${firstDifference(expected, actual)}\n实际结果：${out}\n快照：${path}`);
            }
        });
    }
});
