import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import type { BiliAccount, SystemNotice } from '../src/bilibili/bilibili-account.ts';
import { createRiskMonitor, RISK_POLL_MS } from '../src/bilibili/bilibili-risk.ts';
import { fileOps } from '../src/memory/json-file.ts';

const start = new Date('2026-11-05T12:00:00+08:00').getTime();
const warning: SystemNotice = { id: '123456', title: '合成账号警告', content: '合成风险通知', at: start };
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-risk-state-review-')), path = join(root, 'bilibili-risk.json'), logs: string[] = [];
    let now = start, reads = 0, sends = 0, unread = 1;
    let listing: () => Promise<SystemNotice[]> = async () => [warning];
    const account = { systemNoticeUnread: async () => unread, systemNotices: async () => { reads++; return listing(); }, sendDm: async () => { sends++; } } as unknown as BiliAccount;
    const make = () => createRiskMonitor({ dir: root, uid: 456, now: () => now, log: line => logs.push(line), account });
    const monitors: ReturnType<typeof make>[] = []; const open = () => { const monitor = make(); monitors.push(monitor); return monitor; };
    return { root, path, logs, account, open, reads: () => reads, sends: () => sends, list: (next: typeof listing) => { listing = next; }, unread: (next: number) => { unread = next; }, advance: () => { now += RISK_POLL_MS; }, read: () => JSON.parse(readFileSync(path, 'utf8')),
        async cleanup() { for (const monitor of monitors) await monitor.stop().catch(() => {}); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-risk-state-review-')); rmSync(root, { recursive: true, force: true }); } };
}

for (const first of ['failure', 'empty'] as const) test(`通知列表${first}不把未读数当成功版本，下一poll同数可重试风险`, async () => {
    const f = fixture(); let calls = 0;
    f.list(async () => { calls++; if (calls === 1) { if (first === 'failure') throw new Error('SYNTHETIC_READ_FAILURE'); return []; } return [warning]; });
    try {
        const monitor = f.open(); await monitor.tick(); assert.equal(monitor.halted(), false);
        f.advance(); await monitor.tick(); assert.equal(f.reads(), 2); assert.equal(monitor.halted(), true); assert.deepEqual(f.read().seen, [warning.id]);
        assert.equal(f.sends(), 1, '原先未知内容提醒与15min后风险提醒仍受30min限频');
    } finally { await f.cleanup(); }
});

test('列表首次失败后重启不追认成功，同未读数仍读回原警告', async () => {
    const f = fixture(); let calls = 0; f.list(async () => { if (++calls === 1) throw new Error('SYNTHETIC_READ_FAILURE'); return [warning]; });
    try {
        const first = f.open(); await first.tick(); await first.stop(); f.advance(); const restarted = f.open(); await restarted.tick();
        assert.equal(f.reads(), 2); assert.equal(restarted.halted(), true); assert.deepEqual(f.read().seen, [warning.id]); assert.equal(f.sends(), 1);
    } finally { await f.cleanup(); }
});

test('同未读数下正常通知换成新警告必须实际读内容，seen去重不重复提醒', async () => {
    const f = fixture(); f.list(async () => [{ ...warning, id: '100', title: '合成普通通知', content: '正常消息' }]);
    try {
        const monitor = f.open(); await monitor.tick(); assert.equal(monitor.halted(), false); assert.equal(f.sends(), 0);
        f.list(async () => [warning]); f.advance(); await monitor.tick(); assert.equal(f.reads(), 2); assert.equal(monitor.halted(), true); assert.equal(f.sends(), 1);
        f.advance(); await monitor.tick(); assert.equal(f.reads(), 3); assert.equal(f.sends(), 1);
    } finally { await f.cleanup(); }
});

test('完整risk状态schema拒坏值且保原不隔离；旧合法epoch与计数兼容', async () => {
    const f = fixture();
    const bad: unknown[] = [null, [], { version: 2, seen: [] }, { version: 1, seen: {} }, { version: 1, seen: [1] }, { version: 1, seen: [''] },
        ...['until', 'lastAlertAt'].flatMap(key => ['not-a-time', null, 1e30].map(value => ({ version: 1, seen: [], [key]: value }))),
        ...[-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null].map(lastUnread => ({ version: 1, seen: [], lastUnread }))];
    try {
        for (const value of bad) { const body = JSON.stringify(value); writeFileSync(f.path, body); assert.throws(() => f.open()); assert.equal(readFileSync(f.path, 'utf8'), body); assert.equal(readdirSync(f.root).some(name => name.includes('.corrupt-')), false); }
        for (const value of [{ version: 1, seen: [] }, { version: 1, seen: ['123'], until: -1, lastAlertAt: 0, lastUnread: 0 }]) { writeFileSync(f.path, JSON.stringify(value)); const monitor = f.open(); assert.equal(monitor.halted(), false); await monitor.stop(); }
    } finally { await f.cleanup(); }
});

test('风险与seen发布失败仍保RAM暂停，恢复先持久整份观察而不吞风险或重复DM', async () => {
    const f = fixture(), original = { ...fileOps }; const monitor = f.open();
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = (() => { throw Object.assign(new Error('synthetic risk EROFS'), { code: 'EROFS' }); }) as typeof fileOps.renameSync;
        await assert.rejects(monitor.tick()); assert.equal(monitor.halted(), true); assert.equal(f.sends(), 0); assert.equal(existsSync(f.path), false);
        Object.assign(fileOps, original); f.advance(); await monitor.tick();
        assert.ok(f.read().until > start); assert.deepEqual(f.read().seen, [warning.id]); assert.equal(monitor.halted(), true);
        assert.equal(f.sends(), 0, '失败轮未派提醒不猜远端状态或补发未知提醒');
        await monitor.stop(); const restarted = f.open(); assert.equal(restarted.halted(), true);
    } finally { Object.assign(fileOps, original); await f.cleanup(); }
});

test('风险JSON rename后异常可精确读回确认事实，seen与until不分裂', async () => {
    const f = fixture(), original = { ...fileOps }; const monitor = f.open();
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = ((from: string, to: string) => { original.renameSync(from, to); if (to === f.path) throw Object.assign(new Error('synthetic post-publish EIO'), { code: 'EIO' }); }) as typeof fileOps.renameSync;
        await monitor.tick(); assert.equal(monitor.halted(), true); assert.deepEqual(f.read().seen, [warning.id]); assert.equal(f.sends(), 1);
    } finally { Object.assign(fileOps, original); await f.cleanup(); }
});

test('seen首提交成功后风险暂停写失败不能让重启永久漏该警告', async () => {
    const f = fixture(), original = { ...fileOps }; const monitor = f.open(); let publications = 0;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = ((from: string, to: string) => { if (to === f.path && ++publications === 2) throw Object.assign(new Error('synthetic second publication EROFS'), { code: 'EROFS' }); return original.renameSync(from, to); }) as typeof fileOps.renameSync;
        await monitor.tick().catch(() => {}); Object.assign(fileOps, original); await monitor.stop();
        const restarted = f.open(); assert.equal(restarted.halted(), true, '任何已存seen警告必须同份拥有until，或未处理警告能重读');
        f.advance(); await restarted.tick(); assert.equal(restarted.halted(), true);
    } finally { Object.assign(fileOps, original); await f.cleanup(); }
});

test('并行trip等待同账号时30min预留只能派一份DM', async () => {
    const f = fixture(); let release!: () => void, enters = 0, sends = 0;
    const held = new Promise<void>(done => { release = done; });
    const monitor = createRiskMonitor({ dir: f.root, uid: 456, now: () => start, log() {}, account: async () => { enters++; await held; return { sendDm: async () => { sends++; } } as unknown as BiliAccount; } });
    try {
        const a = monitor.trip({ why: '合成风险A' }), b = monitor.trip({ why: '合成风险B' });
        const deadline = Date.now() + 3000; while (enters !== 2) { assert.ok(Date.now() < deadline); await new Promise(done => setImmediate(done)); }
        release(); await Promise.all([a, b]); assert.equal(sends, 1);
    } finally { release(); await monitor.stop(); await f.cleanup(); }
});

test('初始坏JSON或读取EIO保原拒启动，不隔离或把错误当空白', async () => {
    const f = fixture(), original = { ...fileOps };
    try {
        writeFileSync(f.path, '{synthetic bad JSON'); assert.throws(() => f.open()); assert.equal(readFileSync(f.path, 'utf8'), '{synthetic bad JSON');
        const body = JSON.stringify({ version: 1, seen: ['123456'], until: start + 1000 }); writeFileSync(f.path, body);
        fileOps.readDelaysMs = [0]; fileOps.readFileSync = (() => { throw Object.assign(new Error('synthetic initial EIO'), { code: 'EIO' }); }) as typeof fileOps.readFileSync;
        assert.throws(() => f.open()); assert.equal(readFileSync(f.path, 'utf8'), body); assert.equal(readdirSync(f.root).some(name => name.includes('.corrupt-')), false);
        assert.equal(f.reads(), 0); assert.equal(f.sends(), 0);
    } finally { Object.assign(fileOps, original); await f.cleanup(); }
});

test('已发布风险但读回未知时仍暂停且不派DM，恢复stop只补本地事实', async () => {
    const f = fixture(), original = { ...fileOps }, monitor = f.open(); let published = false;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.readDelaysMs = [0];
        fileOps.renameSync = ((from: string, to: string) => { original.renameSync(from, to); if (to === f.path) { published = true; throw Object.assign(new Error('synthetic published EIO'), { code: 'EIO' }); } }) as typeof fileOps.renameSync;
        fileOps.readFileSync = ((path: unknown, ...args: unknown[]) => { if (published && String(path) === f.path) throw Object.assign(new Error('synthetic readback EIO'), { code: 'EIO' }); return Reflect.apply(original.readFileSync, fileOps, [path, ...args]); }) as typeof fileOps.readFileSync;
        await assert.rejects(monitor.tick()); assert.equal(monitor.halted(), true); assert.equal(f.sends(), 0); assert.deepEqual(f.read().seen, [warning.id]);
        Object.assign(fileOps, original); const reads = f.reads(); await monitor.stop();
        assert.equal(f.reads(), reads); assert.equal(f.sends(), 0); assert.ok(f.read().until > start); assert.equal(f.open().halted(), true);
    } finally { Object.assign(fileOps, original); await f.cleanup(); }
});

test('持续风险写失败时stop明确拒绝，RAM仍保观察且不做任何新请求', async () => {
    const f = fixture(), original = { ...fileOps }, monitor = f.open();
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = (() => { throw Object.assign(new Error('synthetic sustained EROFS'), { code: 'EROFS' }); }) as typeof fileOps.renameSync;
        await assert.rejects(monitor.tick()); const reads = f.reads(); await assert.rejects(monitor.stop()); assert.equal(monitor.halted(), true); assert.equal(f.sends(), 0); assert.equal(f.reads(), reads);
        Object.assign(fileOps, original); await monitor.record!({ why: '已派mutation的另一次风险' }); assert.ok(f.read().until > start); assert.deepEqual(f.read().seen, [warning.id]); assert.equal(f.sends(), 0);
    } finally { Object.assign(fileOps, original); await f.cleanup(); }
});

test('提醒预留发布失败不派DM，恢复不盲补发同一轮风险提醒', async () => {
    const f = fixture(), original = { ...fileOps }, monitor = f.open(); let publications = 0;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = ((from: string, to: string) => { if (to === f.path && ++publications === 2) throw Object.assign(new Error('synthetic alert reservation EROFS'), { code: 'EROFS' }); return original.renameSync(from, to); }) as typeof fileOps.renameSync;
        await assert.rejects(monitor.tick()); assert.equal(monitor.halted(), true); assert.equal(f.sends(), 0); assert.equal(f.read().lastAlertAt, undefined);
        Object.assign(fileOps, original); f.advance(); await monitor.tick(); assert.equal(f.sends(), 0); assert.deepEqual(f.read().seen, [warning.id]); assert.equal(f.read().lastAlertAt, start);
    } finally { Object.assign(fileOps, original); await f.cleanup(); }
});

test('畸形未读数和非法暂停时间不污染state或触发提醒，成功0重置旧计数', async () => {
    const f = fixture(), monitor = f.open();
    try {
        for (const value of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) { f.unread(value); await monitor.tick(); f.advance(); }
        assert.equal(f.reads(), 0); assert.equal(f.sends(), 0); assert.equal(existsSync(f.path), false);
        for (const days of [-1, Number.NaN, Number.POSITIVE_INFINITY, 1e30]) await assert.rejects(monitor.record!({ why: '合成非法时长', days }));
        assert.equal(existsSync(f.path), false);
        f.list(async () => [{ ...warning, title: '合成正常通知', content: '普通消息' }]); f.unread(1); await monitor.tick(); assert.equal(f.read().lastUnread, 1);
        f.advance(); f.unread(0); await monitor.tick(); assert.equal(f.read().lastUnread, 0); assert.equal(f.reads(), 1); assert.equal(f.sends(), 0);
    } finally { await f.cleanup(); }
});

test('epoch0与负时间首次提醒不被缺省0误当冷却预留', async () => {
    for (const at of [0, -1000]) {
        const f = fixture(); let sends = 0;
        const monitor = createRiskMonitor({ dir: f.root, uid: 456, now: () => at, log() {}, account: { sendDm: async () => { sends++; } } as unknown as BiliAccount });
        try { await monitor.trip({ why: '合成历史时间风险' }); assert.equal(sends, 1); assert.equal(f.read().lastAlertAt, at); assert.equal(monitor.halted(), true); }
        finally { await monitor.stop(); await f.cleanup(); }
    }
});

test('epoch前首次通知轮询不被缺省0当成未来轮询截止', async () => {
    const f = fixture(); let reads = 0;
    const monitor = createRiskMonitor({ dir: f.root, uid: 456, now: () => -1000, log() {}, account: { systemNoticeUnread: async () => { reads++; return 0; } } as unknown as BiliAccount });
    try { await monitor.tick(); assert.equal(reads, 1); await monitor.tick(); assert.equal(reads, 1); }
    finally { await monitor.stop(); await f.cleanup(); }
});
