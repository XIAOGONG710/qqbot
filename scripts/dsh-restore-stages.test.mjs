import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createRestoreStages, STAGES } from './restore-stages.mjs';

const DAY = '2026-11-24';

function workspace({ dump = 'PGDMP\u0001rest', state = 'PK\u0003\u0004state' } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'restore-stages-'));
    const backup = join(root, 'runtime', 'backups', DAY);
    mkdirSync(backup, { recursive: true });
    writeFileSync(join(backup, 'hindsight.sql'), dump);
    writeFileSync(join(backup, 'her-state.zip'), state);
    writeFileSync(join(backup, '.complete.json'), JSON.stringify({
        completed: true,
        components: {
            database: { ok: true, bytes: Buffer.byteLength(dump) },
            state: { ok: true, bytes: Buffer.byteLength(state), source: 'runtime/bot' },
        },
    }));
    return root;
}

function drillDirectories(root) {
    try { return readdirSync(join(root, 'runtime', 'restore-drills')); } catch { return []; }
}

test('四个阶段按顺序列出，正式切换标了要授权', () => {
    assert.deepEqual(STAGES.map(stage => stage.id), ['artifacts', 'files', 'database', 'switch']);
    assert.equal(STAGES.at(-1).writes, '需要单独授权');
});

test('制品校验：只读标记和大小，给出摘要', () => {
    const root = workspace();
    try {
        const stage = createRestoreStages({ root }).artifacts(DAY);
        assert.equal(stage.ok, true);
        assert.equal(stage.database.bytes, Buffer.byteLength('PGDMP\u0001rest'));
        assert.equal(stage.state.source, 'runtime/bot');
        assert.equal(stage.state.digest.length, 16);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('制品校验：大小与标记不一致就停下，不进入后面阶段', () => {
    const root = workspace();
    try {
        writeFileSync(join(root, 'runtime', 'backups', DAY, 'hindsight.sql'), 'PGDMP-more-bytes');
        const stage = createRestoreStages({ root }).artifacts(DAY);
        assert.equal(stage.ok, false);
        assert.match(stage.error, /不一致/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('制品校验：日期不合法、备份不存在都不会被当成可演练的备份', () => {
    const root = workspace();
    try {
        const stages = createRestoreStages({ root });
        assert.equal(stages.artifacts('../etc').ok, false);
        assert.equal(stages.artifacts('2026-01-01').ok, false);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('文件隔离恢复：解到隔离目录检查完就删掉，不碰 runtime/bot', () => {
    const root = workspace();
    try {
        const stage = createRestoreStages({
            root,
            extract: (archive, target) => writeFileSync(join(target, 'memory.json'), '{"items":[]}'),
        }).files(DAY);
        assert.equal(stage.ok, true);
        assert.equal(stage.files, 1);
        assert.equal(stage.target, null, '默认不留演练目录');
        assert.deepEqual(drillDirectories(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('文件隔离恢复：解压中途失败要回滚成空，不留半成品', () => {
    const root = workspace();
    try {
        const stage = createRestoreStages({
            root,
            extract: (archive, target) => {
                writeFileSync(join(target, 'half.json'), '{}');
                throw new Error('解压在 60% 时断掉');
            },
        }).files(DAY);
        assert.equal(stage.ok, false);
        assert.match(stage.error, /60%/);
        assert.deepEqual(drillDirectories(root), [], '失败后不留任何演练目录');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('文件隔离恢复：隔离内容含禁区目录时判失败并清理', () => {
    const root = workspace();
    try {
        const stage = createRestoreStages({
            root,
            extract: (archive, target) => {
                mkdirSync(join(target, 'secrets'), { recursive: true });
                writeFileSync(join(target, 'secrets', 'x.json'), '{}');
            },
        }).files(DAY);
        assert.equal(stage.ok, false);
        assert.match(stage.error, /敏感/);
        assert.deepEqual(drillDirectories(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('隔离数据库恢复：dump 进临时假库，只给命令不连真库', () => {
    const root = workspace();
    try {
        const calls = [];
        const stage = createRestoreStages({ root, run: request => { calls.push(request); return { executed: false }; } }).database(DAY);
        assert.equal(stage.ok, true);
        assert.equal(stage.isolated, 'planned');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].database, 'hindsight_restore_drill');
        assert.ok(calls[0].dump.includes('hindsight-restore-'), 'dump 副本放在一次性目录里');
        assert.ok(calls[0].args.includes('hindsight_restore_drill'));
        assert.ok(!calls[0].args.some(value => /postgres|linmengyao/.test(value)), '命令里不出现正式库名');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('隔离数据库恢复：dump 头部不认识就判失败', () => {
    const root = workspace({ dump: 'not-a-dump' });
    try {
        const stage = createRestoreStages({ root }).database(DAY);
        assert.equal(stage.ok, false);
        assert.match(stage.error, /dump/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('正式切换：只交步骤，不执行、不碰数据', () => {
    const root = workspace();
    try {
        const calls = [];
        const stage = createRestoreStages({
            root,
            run: request => { calls.push(request); return { executed: true }; },
            extract: (archive, target) => calls.push({ archive, target }),
        }).switchPlan(DAY);
        assert.equal(stage.ok, true);
        assert.equal(stage.requiresApproval, true);
        assert.equal(stage.executed, false);
        assert.equal(calls.length, 0, '切换阶段不调用任何执行器');
        assert.ok(stage.steps.length >= 5);
        assert.match(stage.steps.join(''), /bot\.before-restore/);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('隔离目录用完即删，不在系统临时目录里留 dump 副本', () => {
    const root = workspace();
    try {
        const before = readdirSync(tmpdir()).filter(name => name.startsWith('hindsight-restore-')).length;
        createRestoreStages({ root }).database(DAY);
        const after = readdirSync(tmpdir()).filter(name => name.startsWith('hindsight-restore-')).length;
        assert.equal(after, before);
        assert.ok(readFileSync(join(root, 'runtime', 'backups', DAY, 'hindsight.sql')).length > 0, '原备份不动');
    } finally { rmSync(root, { recursive: true, force: true }); }
});
