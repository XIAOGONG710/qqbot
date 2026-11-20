// 行为基线（ADR 0336 第 2 步）：架构迁移的每一步都必须让这些快照逐字不变。
// 有意改变行为时才更新快照：UPDATE_BASELINE=1 npm test -w @qqbot/bot（或只跑这个文件），并在提交说明里写清为什么变。
// 对不上时，实际结果写到系统临时目录，断言信息里给出路径和第一处不同。
//
// 平时（不更新快照）：场景分给几个子进程并行跑（baseline/parallel.ts，和 npm run baseline:fast 同一套），每个场景仍是这里的一项测试；
// 进程数默认 CPU 数 - 1，BASELINE_JOBS=1 就是在子进程里一个接一个跑。更新快照时照旧在本进程里依次跑、写快照。

import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { before, describe, test } from 'node:test';
import { SNAPSHOTS, snapshotPath } from './baseline/compare.ts';
import { runScenario } from './baseline/harness.ts';
import { defaultJobs, runParallel, type Result } from './baseline/parallel.ts';
import { SCENARIOS } from './baseline/scenarios.ts';

const update = process.env.UPDATE_BASELINE === '1';
const jobs = /^\d+$/.test(process.env.BASELINE_JOBS ?? '') && Number(process.env.BASELINE_JOBS) >= 1 ? Number(process.env.BASELINE_JOBS) : defaultJobs();

describe('行为基线（ADR 0336）', () => {
    test('场景名不重复', () => {
        assert.equal(new Set(SCENARIOS.map(s => s.name)).size, SCENARIOS.length);
    });

    if (update) {
        for (const scenario of SCENARIOS) {
            test(`${scenario.name}：${scenario.about}（更新快照）`, async () => {
                mkdirSync(SNAPSHOTS, { recursive: true });
                writeFileSync(snapshotPath(scenario.name), await runScenario(scenario));
            });
        }
        return;
    }

    const results = new Map<string, Result>();
    before(async () => {
        for (const result of await runParallel(SCENARIOS.map(s => s.name), jobs)) results.set(result.name, result);
    });
    for (const scenario of SCENARIOS) {
        test(`${scenario.name}：${scenario.about}`, () => {
            const result = results.get(scenario.name);
            assert.ok(result, '这个场景没有结果（子进程没跑到它）');
            if (!result.ok) assert.fail(result.problem ?? '没过');
        });
    }
});

