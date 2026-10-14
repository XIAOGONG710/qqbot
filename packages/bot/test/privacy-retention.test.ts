import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { planRetention, retainLocalLogs } from '../src/privacy-retention.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })));
function fixture() {
    const base = mkdtempSync(join(tmpdir(), 'qqbot-retention-')); dirs.push(base);
    const dir = join(base, 'bot'); mkdirSync(join(dir, 'logs'), { recursive: true });
    for (const name of ['2026-09-01.log', '2026-09-14.log', '2026-10-14.log', '2026-02-30.log', 'manual.log']) writeFileSync(join(dir, 'logs', name), 'fictional');
    return { base, dir };
}
test('期限按日历日期且不含当天；非法文件名、无效日期和未知版本不能误清理', () => {
    const { dir } = fixture();
    const plan = planRetention(dir, { version: 1, logsDays: 30 }, '2026-10-14');
    assert.equal(plan.cutoff, '2026-09-14');
    assert.deepEqual(plan.files.map(f => f.path.replaceAll('\\', '/')), ['logs/2026-09-01.log']);
    assert.throws(() => planRetention(dir, { version: 1, logsDays: 0 }, '2026-10-14'), /logsDays/);
    assert.throws(() => planRetention(dir, { version: 1, logsDays: 30 }, '2026-02-30'), /无效日期/);
});
test('默认演练不移动；apply 保留原文和报告，运行中或目标在数据目录内拒绝', async () => {
    const { base, dir } = fixture();
    const policy = { version: 1 as const, logsDays: 30 };
    assert.equal((await retainLocalLogs(dir, policy, { asOf: '2026-10-14' })).applied, false);
    await assert.rejects(retainLocalLogs(dir, policy, { asOf: '2026-10-14', apply: true, archiveDir: join(dir, 'trash') }), /数据目录之外/);
    writeFileSync(join(dir, 'bot.lock'), '4242');
    await assert.rejects(retainLocalLogs(dir, policy, { asOf: '2026-10-14', apply: true, archiveDir: join(base, 'trash'), isAlive: () => true }), /还在运行/);
    const result = await retainLocalLogs(dir, policy, { asOf: '2026-10-14', apply: true, archiveDir: join(base, 'trash'), isAlive: () => false });
    assert.deepEqual(result.failures, []);
    assert.equal(existsSync(join(dir, 'logs', '2026-09-01.log')), false);
    assert.equal(readFileSync(join(result.archive!, '2026-09-01.log'), 'utf8'), 'fictional');
    assert.ok(existsSync(join(result.archive!, 'retention-report.json')));
    assert.ok(existsSync(join(dir, 'logs', '2026-10-14.log')));
});
