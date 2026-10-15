import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { classifyChanges, goLiveReport, type GoLiveInput } from '../src/ops/golive-check.ts';
import { appendRestart, BEHAVIOR_GAP_MS, behaviorGap, lastBehaviorRestart, parseRestartLog, readRestartLog, type RestartEntry } from '../src/ops/restart-log.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-restart-log-')); dirs.push(dir); return dir; };

const NOW = new Date('2026-10-17T12:00:00+08:00');
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000).toISOString();
const entry = (hours: number, kind: RestartEntry['kind'], to = 'abc1234', reason = '测试'): RestartEntry => ({ at: hoursAgo(hours), to, kind, reason, by: 'claude' });

describe('重启记录', () => {
    test('解析：按时间排序，坏行和未知 kind 跳过', () => {
        const text = [JSON.stringify(entry(1, 'recovery')), 'not json', JSON.stringify({ ...entry(5, 'behavior'), kind: 'weird' }), JSON.stringify(entry(30, 'behavior', 'old')), ''].join('\n');
        const entries = parseRestartLog(text);
        assert.deepEqual(entries.map(e => e.to), ['old', 'abc1234']);
        assert.equal(lastBehaviorRestart(entries)!.to, 'old', 'recovery 不算行为变化');
    });

    test('48 小时：不满不行，刚好满可以；recovery / safety 不计入；没有记录算够', () => {
        assert.equal(behaviorGap([], NOW).ok, true);
        assert.equal(behaviorGap([entry(47.9, 'behavior')], NOW).ok, false);
        assert.equal(behaviorGap([entry(48, 'behavior')], NOW).ok, true);
        assert.equal(behaviorGap([entry(48, 'behavior'), entry(1, 'recovery'), entry(2, 'safety')], NOW).ok, true);
        assert.equal(behaviorGap([entry(48, 'behavior')], NOW).sinceMs, BEHAVIOR_GAP_MS);
    });

    test('追加：一行一条 JSON；时间、提交、理由缺了就拒绝', () => {
        const file = join(tmp(), 'nested', 'restarts.log');
        appendRestart(file, entry(1, 'behavior', 'aaa1111', '加固 A'));
        appendRestart(file, entry(0.5, 'recovery', 'aaa1111', '整机重启后恢复'));
        assert.equal(readFileSync(file, 'utf8').trimEnd().split('\n').length, 2);
        assert.deepEqual(readRestartLog(file).map(e => e.kind), ['behavior', 'recovery']);
        assert.throws(() => appendRestart(file, { ...entry(1, 'behavior'), at: 'yesterday' }), /时间不对/);
        assert.throws(() => appendRestart(file, { ...entry(1, 'behavior'), to: ' ' }), /--to/);
        assert.throws(() => appendRestart(file, { ...entry(1, 'behavior'), reason: '' }), /--reason/);
        assert.equal(readRestartLog(file).length, 2);
        assert.deepEqual(readRestartLog(join(tmp(), 'missing.log')), []);
    });
});

describe('上线前检查的 48 小时拦截（T3a）', () => {
    const base = (overrides: Partial<GoLiveInput> = {}): GoLiveInput => ({
        liveHead: 'aaa', targetHead: 'bbb', dirty: false, commits: ['x'], exposed: [], now: NOW,
        changes: classifyChanges(['packages/bot/src/app.ts']), ...overrides,
    });

    test('代码要重启、距上次行为变化不满 48 小时：挡路，写清还差几小时和怎么放行', () => {
        const report = goLiveReport(base({ lastBehaviorRestart: entry(20, 'behavior', '9333bdd', '加固 A + 心跳') }));
        assert.equal(report.blockers.length, 1);
        assert.match(report.blockers[0]!, /才过 20 小时，还差约 28 小时才满 48/);
        assert.match(report.blockers[0]!, /9333bdd/);
        assert.match(report.blockers[0]!, /--safety/);
    });

    test('满 48 小时放行并留一句；--safety 放行并留理由；只有文档的改动不拦；记录是空的会提示', () => {
        const full = goLiveReport(base({ lastBehaviorRestart: entry(49, 'behavior') }));
        assert.deepEqual(full.blockers, []);
        assert.ok(full.notes.some(note => note.includes('已满 48 小时')));
        const safety = goLiveReport(base({ lastBehaviorRestart: entry(2, 'behavior') }), { safety: '修模型接口超时' });
        assert.deepEqual(safety.blockers, []);
        assert.ok(safety.notes.some(note => note.includes('修模型接口超时') && note.includes('kind=safety')));
        const docs = goLiveReport(base({ lastBehaviorRestart: entry(2, 'behavior'), changes: classifyChanges(['docs/adr/0073-x.md']) }));
        assert.deepEqual(docs.blockers, []);
        const empty = goLiveReport(base({ restartLogEmpty: true }));
        assert.deepEqual(empty.blockers, []);
        assert.ok(empty.notes.some(note => note.includes('重启记录是空的')));
        assert.equal(goLiveReport(base({ lastBehaviorRestart: entry(2, 'behavior') }), { safety: '  ' }).blockers.length, 1, '空理由不放行');
    });
});

describe('命令行', () => {
    const cli = resolve(import.meta.dirname, '../src/ops/restart-log-cli.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });

    test('追加、列出（带距上次行为变化多久）；kind 或理由不对退出码 2', () => {
        const file = join(tmp(), 'restarts.log');
        const added = run('--file', file, '--to', 'abc1234', '--kind', 'behavior', '--reason', '加固 A', '--by', 'claude');
        assert.equal(added.status, 0, added.stderr);
        const listed = run('--file', file, '--list');
        assert.equal(listed.status, 0);
        assert.match(listed.stdout, /behavior\s+abc1234\s+claude\s+加固 A/);
        assert.match(listed.stdout, /不满 48 小时/);
        assert.equal(run('--file', file, '--to', 'x', '--kind', 'nope', '--reason', 'y').status, 2);
        const noReason = run('--file', file, '--to', 'x', '--kind', 'safety', '--reason', ' ');
        assert.equal(noReason.status, 2);
        assert.match(noReason.stderr, /--reason/);
        writeFileSync(file, '');
        assert.match(run('--file', file, '--list').stdout, /还没有记录/);
    });
});
