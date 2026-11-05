import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { BiliAccount } from '../src/bilibili/bilibili-account.ts';
import { createRiskMonitor } from '../src/bilibili/bilibili-risk.ts';

const now = new Date('2026-11-05T12:00:00+08:00').getTime();
const notice = { id: '123456', title: '合成账号警告', content: '合成风险事件', at: now };
const tick = () => new Promise<void>(done => setImmediate(done));
const until = async (check: () => boolean) => { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成检查点超时'); await tick(); } };
function fixture(stage: 'account' | 'unread' | 'notices' | 'dm' | 'none', fail = false) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-risk-core-review-')), file = join(root, 'bilibili-risk.json'), logs: string[] = [], calls: string[] = [];
    let release!: () => void, entered = false;
    const held = new Promise<void>(done => { release = done; });
    const work = async (name: string) => { calls.push(name); if (name === stage) { entered = true; await held; if (fail) throw new Error('SYNTHETIC_LATE_RISK_FAILURE'); } };
    const account = {
        systemNoticeUnread: async () => { await work('unread'); return 1; },
        systemNotices: async () => { await work('notices'); return [notice]; },
        sendDm: async () => { await work('dm'); },
    } as unknown as BiliAccount;
    const monitor = createRiskMonitor({ dir: root, uid: 456, now: () => now, log: line => logs.push(line), account: async () => { await work('account'); return account; } });
    return { root, file, logs, calls, monitor, release, entered: () => entered,
        async cleanup() { release(); await monitor.stop(); await tick(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-risk-core-review-')); rmSync(root, { recursive: true, force: true }); } };
}

for (const stage of ['account', 'unread', 'notices'] as const) test(`risk stop取消held ${stage}，无后继请求/文件/日志并永久拒新`, async () => {
    const f = fixture(stage);
    try {
        const running = f.monitor.tick(); await until(f.entered);
        await f.monitor.stop(); const calls = [...f.calls], logs = [...f.logs];
        let completed = false; void running.then(() => { completed = true; }); await tick(); assert.equal(completed, true, '纯依赖即使不合作也不阻本体取消');
        f.release(); await running; await tick();
        assert.deepEqual(f.calls, calls); assert.deepEqual(f.logs, logs); assert.equal(existsSync(f.file), false);
        await f.monitor.tick(); await f.monitor.trip({ why: '停止后的新工作' }); f.monitor.start(); await tick();
        assert.deepEqual(f.calls, calls); assert.deepEqual(f.logs, logs); assert.equal(existsSync(f.file), false);
    } finally { await f.cleanup(); }
});

for (const fail of [false, true]) test(`risk已派私信${fail ? '失败' : '成功'}ACK必须先收尾，再结束stop`, async () => {
    const f = fixture('dm', fail);
    try {
        const running = f.monitor.tick(); await until(f.entered); let stopped = false;
        const draining = Promise.resolve(f.monitor.stop()).then(() => { stopped = true; }); await tick(); assert.equal(stopped, false);
        const before = readFileSync(f.file, 'utf8'); assert.ok(JSON.parse(before).until > now); f.release(); await draining; await running;
        assert.equal(stopped, true); assert.deepEqual(f.calls.filter(name => name === 'dm'), ['dm']);
        assert.ok(f.logs.some(line => line.includes(fail ? '私信提醒也没发出去' : '已私信提醒他')));
        assert.equal(readFileSync(f.file, 'utf8'), before);
    } finally { await f.cleanup(); }
});

test('risk正常完成后stop保留已确认风险和提醒事实，重复stop复用drain', async () => {
    const f = fixture('none');
    try {
        await f.monitor.tick(); const body = readFileSync(f.file, 'utf8'); assert.equal(f.monitor.halted(), true); assert.equal(f.calls.filter(name => name === 'dm').length, 1);
        const first = f.monitor.stop(), second = f.monitor.stop(); assert.equal(first, second); await first;
        assert.equal(readFileSync(f.file, 'utf8'), body);
    } finally { await f.cleanup(); }
});

test('停止后record保已派公开mutation真实风险，不新查账号/DM或写晚日志', async () => {
    const f = fixture('none');
    try {
        await f.monitor.stop(); await f.monitor.record!({ why: '已派公开评论返回风控', wanted: '合成原评论' });
        assert.ok(JSON.parse(readFileSync(f.file, 'utf8')).until > now); assert.equal(f.monitor.halted(), true);
        assert.deepEqual(f.calls, []); assert.deepEqual(f.logs, []);
        const restarted = createRiskMonitor({ dir: f.root, uid: 456, now: () => now, log() {}, account: async () => { throw new Error('不应查账号'); } });
        assert.equal(restarted.halted(), true); await restarted.stop();
    } finally { await f.cleanup(); }
});

test('trip已记现实风险但提醒账号尚held时stop只取消未派提醒，保已记事实', async () => {
    const f = fixture('account');
    try {
        const running = f.monitor.trip({ why: '合成已观察风险' }); await until(f.entered);
        const body = readFileSync(f.file, 'utf8'); await f.monitor.stop(); await running;
        f.release(); await tick(); assert.equal(readFileSync(f.file, 'utf8'), body); assert.equal(f.monitor.halted(), true);
        assert.deepEqual(f.calls, ['account']); assert.equal(f.logs.some(line => line.includes('已私信')), false);
    } finally { await f.cleanup(); }
});

test('停止后不合作系统读取晚失败不写诊断或副状态', async () => {
    const f = fixture('unread', true);
    try {
        const running = f.monitor.tick(); await until(f.entered); await f.monitor.stop(); await running;
        const logs = [...f.logs]; f.release(); await tick(); await tick();
        assert.deepEqual(f.logs, logs); assert.equal(existsSync(f.file), false); assert.deepEqual(f.calls, ['account', 'unread']);
    } finally { await f.cleanup(); }
});

test('sendDm公开依赖同步stop时预登记本体，直到该次真实ACK确认才结束drain', async () => {
    const f = fixture('none'); let release!: () => void, entered = false, stopped = false, draining: Promise<void> | undefined;
    const held = new Promise<void>(done => { release = done; });
    let monitor!: ReturnType<typeof createRiskMonitor>;
    const account = { sendDm: async () => { entered = true; draining = monitor.stop().then(() => { stopped = true; }); await held; } } as unknown as BiliAccount;
    monitor = createRiskMonitor({ dir: f.root, uid: 456, now: () => now, log() {}, account });
    try {
        const running = monitor.trip({ why: '合成风险' }); await until(() => entered); await tick(); assert.equal(stopped, false);
        release(); await running; await draining; assert.equal(stopped, true); assert.ok(JSON.parse(readFileSync(f.file, 'utf8')).lastAlertAt);
    } finally { release(); await monitor.stop(); await f.cleanup(); }
});
