// 行为基线（ADR 0336 第 2 步）：架构迁移的每一步都必须让这些快照逐字不变。
// 有意改变行为时才更新快照：UPDATE_BASELINE=1 npm test -w @qqbot/bot（或只跑这个文件），并在提交说明里写清为什么变。
// 对不上时，实际结果写到系统临时目录，断言信息里给出路径和第一处不同。
// 只想快点核对基线：npm run baseline:fast -w @qqbot/bot（同一套场景和比对，分给几个进程并行跑，见 baseline/parallel.ts）。

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { compareSnapshot, SNAPSHOTS, snapshotPath } from './baseline/compare.ts';
import { runScenario } from './baseline/harness.ts';
import { SCENARIOS } from './baseline/scenarios.ts';

const update = process.env.UPDATE_BASELINE === '1';

describe('行为基线（ADR 0336）', () => {
    test('场景名不重复', () => {
        assert.equal(new Set(SCENARIOS.map(s => s.name)).size, SCENARIOS.length);
    });

    for (const scenario of SCENARIOS) {
        test(`${scenario.name}：${scenario.about}`, async () => {
            const actual = await runScenario(scenario);
            if (update) {
                mkdirSync(SNAPSHOTS, { recursive: true });
                writeFileSync(snapshotPath(scenario.name), actual);
                return;
            }
            const problem = compareSnapshot(scenario.name, actual);
            if (problem) assert.fail(problem);
        });
    }
});
