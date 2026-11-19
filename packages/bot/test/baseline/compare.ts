// 行为基线的比对（baseline.test.ts 和并行跑法 parallel.ts 共用，两边的判定逐字一样）。

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const SNAPSHOTS = resolve(import.meta.dirname, 'snapshots');

export const snapshotPath = (name: string) => join(SNAPSHOTS, `${name}.txt`);

/** 第一处不同（给人看的） */
export function firstDifference(expected: string, actual: string): string {
    const a = expected.split('\n');
    const b = actual.split('\n');
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        if (a[i] !== b[i]) return `第 ${i + 1} 行\n  快照：${(a[i] ?? '（没有这一行）').slice(0, 300)}\n  实际：${(b[i] ?? '（没有这一行）').slice(0, 300)}`;
    }
    return '（逐行相同，差在结尾）';
}

/** 和快照比：一样返回 undefined；不一样把实际结果写到系统临时目录，返回说明（含第一处不同和两边的路径） */
export function compareSnapshot(name: string, actual: string): string | undefined {
    const path = snapshotPath(name);
    if (!existsSync(path)) return `没有快照 ${path}：先用 UPDATE_BASELINE=1 生成`;
    const expected = readFileSync(path, 'utf8');
    if (actual === expected) return undefined;
    const out = join(mkdtempSync(join(tmpdir(), 'qqbot-baseline-diff-')), `${name}.txt`);
    writeFileSync(out, actual);
    return `行为和快照不一致：${firstDifference(expected, actual)}\n实际结果：${out}\n快照：${path}`;
}
