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

test('四个阶段按顺序列出，正式切换标了要授权', async () => {
    assert.deepEqual(STAGES.map(stage => stage.id), ['artifacts', 'files', 'database', 'switch']);
    assert.equal(STAGES.at(-1).writes, '需要单独授权');
});

test('制品校验：只读标记和大小，给出摘要', async () => {
    const root = workspace();
    try {
        const stage = await createRestoreStages({ root }).artifacts(DAY);
        assert.equal(stage.ok, true);
        assert.equal(stage.database.bytes, Buffer.byteLength('PGDMP\u0001rest'));
        assert.equal(stage.state.source, 'runtime/bot');
        assert.equal(stage.state.digest.length, 16);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('制品校验：大小与标记不一致就停下，不进入后面阶段', async () => {
    const root = workspace();
    try {
        writeFileSync(join(root, 'runtime', 'backups', DAY, 'hindsight.sql'), 'PGDMP-more-bytes');
        const stage = await createRestoreStages({ root }).artifacts(DAY);
        assert.equal(stage.ok, false);
        assert.equal(stage.error, 'artifact_invalid');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('制品校验：日期不合法、备份不存在都不会被当成可演练的备份', async () => {
    const root = workspace();
    try {
        const stages = createRestoreStages({ root });
        assert.equal((await stages.artifacts('../etc')).ok, false);
        assert.equal((await stages.artifacts('2026-01-01')).ok, false);
        assert.equal(stages.switchPlan('2026-01-01').ok, false, '切换步骤找不到备份也不抛错');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('文件隔离恢复：解到隔离目录检查完就删掉，不碰 runtime/bot', async () => {
    const root = workspace();
    try {
        const stage = await createRestoreStages({
            root,
            extract: (archive, target) => writeFileSync(join(target, 'memory.json'), '{"items":[]}'),
        }).files(DAY);
        assert.equal(stage.ok, true);
        assert.equal(stage.files, 1);
        assert.equal(stage.target, null, '默认不留演练目录');
        assert.deepEqual(drillDirectories(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('文件隔离恢复：解压中途失败要回滚成空，不留半成品', async () => {
    const root = workspace();
    try {
        const stage = await createRestoreStages({
            root,
            extract: (archive, target) => {
                writeFileSync(join(target, 'half.json'), '{}');
                throw new Error('解压在 60% 时断掉');
            },
        }).files(DAY);
        assert.equal(stage.ok, false);
        assert.equal(stage.error, 'extract_failed');
        assert.deepEqual(drillDirectories(root), [], '失败后不留任何演练目录');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('文件隔离恢复：隔离内容含禁区目录时判失败并清理', async () => {
    const root = workspace();
    try {
        const stage = await createRestoreStages({
            root,
            extract: (archive, target) => {
                mkdirSync(join(target, 'secrets'), { recursive: true });
                writeFileSync(join(target, 'secrets', 'x.json'), '{}');
            },
        }).files(DAY);
        assert.equal(stage.ok, false);
        assert.equal(stage.error, 'restored_state_invalid');
        assert.deepEqual(drillDirectories(root), []);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('隔离数据库恢复：dump 进临时假库，只给命令不连真库', async () => {
    const root = workspace();
    try {
        const calls = [];
        const stage = await createRestoreStages({ root, run: request => { calls.push(request); return { executed: false }; } }).database(DAY);
        assert.equal(stage.ok, true);
        assert.equal(stage.isolated, 'planned');
        assert.equal(calls.length, 1);
        assert.equal(calls[0].database, 'hindsight_restore_drill');
        assert.ok(calls[0].dump.includes('hindsight-restore-'), 'dump 副本放在一次性目录里');
        assert.ok(calls[0].args.includes('hindsight_restore_drill'));
        assert.ok(!calls[0].args.some(value => /postgres|linmengyao/.test(value)), '命令里不出现正式库名');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('隔离数据库恢复：dump 头部不认识就判失败', async () => {
    const root = workspace({ dump: 'not-a-dump' });
    try {
        const stage = await createRestoreStages({ root }).database(DAY);
        assert.equal(stage.ok, false);
        assert.equal(stage.error, 'not_a_dump');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('正式切换：只交步骤，不执行、不碰数据', async () => {
    const root = workspace();
    try {
        const calls = [];
        const stage = await createRestoreStages({
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

test('隔离目录用完即删，不在系统临时目录里留 dump 副本', async () => {
    const root = workspace();
    try {
        const before = readdirSync(tmpdir()).filter(name => name.startsWith('hindsight-restore-')).length;
        await createRestoreStages({ root }).database(DAY);
        const after = readdirSync(tmpdir()).filter(name => name.startsWith('hindsight-restore-')).length;
        assert.equal(after, before);
        assert.ok(readFileSync(join(root, 'runtime', 'backups', DAY, 'hindsight.sql')).length > 0, '原备份不动');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('阶段在异步里跑：解压没完成时事件循环照样转，不卡住面板进程（审查第 7 条）', async () => {
    const root = workspace();
    try {
        let release;
        const extracting = new Promise(resolve => { release = resolve; });
        const pending = createRestoreStages({
            root,
            extract: async (archive, target) => {
                await extracting;
                writeFileSync(join(target, 'memory.json'), '{"items":[]}');
            },
        }).files(DAY);
        assert.equal(typeof pending.then, 'function', '阶段返回 Promise');
        let ticked = false;
        await new Promise(resolve => setImmediate(() => { ticked = true; resolve(); }));
        assert.equal(ticked, true);
        release();
        assert.equal((await pending).ok, true);
        const artifacts = await createRestoreStages({ root }).artifacts(DAY);
        const { createHash } = await import('node:crypto');
        assert.equal(artifacts.database.digest, createHash('sha256').update('PGDMP\u0001rest').digest('hex').slice(0, 16), '流式摘要和整读一致');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('面板的 /backup/stage：找不到备份回 404、请求体读坏和阶段抛错都回 503，不让 handler 的 Promise 被拒绝（审查第 6 条）', async () => {
    const { createHandler } = await import('../dsh-plugins/dsh-qqbot-services/index.js');
    const root = workspace();
    try {
        const real = createRestoreStages({ root });
        let throwing = false;
        const restoreStages = { ...real, artifacts: async day => { if (throwing) throw new Error('boom C:\secret'); return real.artifacts(day); } };
        const handler = createHandler({}, () => [], undefined, { requestRejection: () => undefined }, Date.now, undefined, { restoreStages });
        const call = async (body, { broken = false } = {}) => {
            let status, payload;
            await handler({
                method: 'POST', url: '/api/qqbot-services/backup/stage', socket: { remoteAddress: '127.0.0.1' },
                headers: { host: '127.0.0.1:3080', 'content-type': 'application/json', 'x-qqbot-service-panel': '1' },
                async *[Symbol.asyncIterator]() {
                    if (broken) throw new Error('aborted');
                    yield JSON.stringify(body);
                },
            }, { writeHead(code) { status = code; }, end(value) { payload = JSON.parse(value); } });
            return { status, payload };
        };
        assert.equal((await call({ day: '2026-01-01', stage: 'switch' })).status, 404, '日期合法但没有这份备份');
        assert.equal((await call({ day: DAY, stage: 'switch' })).status, 403, '有备份：只给步骤');
        assert.equal((await call({ day: DAY, stage: 'artifacts' }, { broken: true })).status, 503, '请求体读到一半断开');
        throwing = true;
        const failed = await call({ day: DAY, stage: 'artifacts' });
        assert.equal(failed.status, 503);
        assert.ok(!JSON.stringify(failed.payload).includes('secret'));
        throwing = false;
        assert.equal((await call({ day: DAY, stage: 'artifacts' })).status, 200, '出过错以后不会一直卡在「正在跑」');
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('阶段结果不带本机绝对路径和原始错误文本，原始文本只进本机日志（审查第 15 条）', async () => {
    const root = workspace();
    try {
        const logged = [];
        const stages = createRestoreStages({
            root,
            log: text => logged.push(text),
            extract: () => { throw new Error(`EPERM: open '${join(root, 'private', 'x.json')}'`); },
        });
        const ok = await stages.artifacts(DAY);
        assert.equal(ok.day, DAY);
        assert.ok(!JSON.stringify(ok).includes(root), '成功结果里没有本机路径');
        const failed = await stages.files(DAY);
        assert.deepEqual(failed, { ok: false, stage: 'files', error: 'extract_failed' });
        assert.equal(logged.length, 1);
        assert.match(logged[0], /files extract_failed: EPERM/);
        assert.equal((await stages.artifacts('2026-01-01')).error, 'backup_missing');
        assert.equal((await stages.artifacts('../etc')).error, 'invalid_day');
        const kept = await createRestoreStages({ root, extract: (archive, target) => writeFileSync(join(target, 'memory.json'), '{"items":[]}') })
            .files(DAY, { keep: true });
        assert.match(kept.target, /^runtime\/restore-drills\/[\w-]+$/, '留下的演练目录只给相对路径');
    } finally { rmSync(root, { recursive: true, force: true }); }
});
