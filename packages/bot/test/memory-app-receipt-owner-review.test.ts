import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成已读回执检查点超时'); await tick(); } }

async function fixture(mode: 'success' | 'failure' | 'reentrant' | 'throw') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-receipt-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs: string[] = []; let app: App | undefined, releaseReceipt!: () => void, releaseModel!: () => void, calls = 0, settledReceipt = false, leaseInside: boolean | undefined, stopInside: Promise<void> | undefined;
    const receiptHeld = new Promise<void>(done => { releaseReceipt = done; }), modelHeld = new Promise<void>(done => { releaseModel = done; });
    let now = Date.parse('2026-11-05T12:00:00+08:00');
    const schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:00' } }, semester: { start: '2026-09-01', weeks: 52 }, holidays: [], makeups: [], kinds: { hard: {}, water: {}, machine: {}, pe: {} }, courses: [], free: { morning: ['合成休闲'], afternoon: ['合成休闲'], evening: ['合成休闲'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule } } } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], readReceipts: true, jokes: false, idioms: false,
        schedule: true, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
    const cleanup = async () => { releaseReceipt(); releaseModel(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-receipt-owner-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' }, transport: { friendHistory: async () => [], sendPrivateText: async () => 900,
            markRead: () => { calls++; if (mode === 'reentrant' || mode === 'throw') { stopInside = Promise.resolve(app!.stop()); leaseInside = existsSync(join(dataDir, 'bot.lock')); } if (mode === 'throw') throw new Error('SYNTHETIC_MARK_READ_SYNC_THROW'); return receiptHeld.then(() => { settledReceipt = true; if (mode === 'failure') throw new Error('SYNTHETIC_MARK_READ_FAILURE'); }); } },
            pipeline: { now: () => now, waitUntil: async at => { now = at; }, settle: { quietMs: 0, maxMs: 0 }, generate: async () => { await modelHeld; return 'SYNTHETIC_REPLY'; } },
        });
        await app.connected(20000);
    } catch (error) { await cleanup(); throw error; }
    const owner = app;
    return { app: owner, dataDir, logs, releaseReceipt, releaseModel, calls: () => calls, settled: () => settledReceipt, leaseInside: () => leaseInside, stopInside: () => stopInside,
        receive() { owner.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 1, real_seq: '100001', time: now / 1000, raw_message: '合成消息', sender: { user_id: 10001 }, message: '合成消息' }); }, cleanup };
}

for (const mode of ['success', 'failure'] as const) test(`已派已读回执${mode === 'success' ? '成功' : '失败'}确认前App不释放租约`, async () => {
    const f = await fixture(mode);
    try {
        f.receive(); await until(() => f.calls() === 1); let stopped = false; const drain = Promise.resolve(f.app.stop()).then(() => { stopped = true; }); await settle();
        assert.equal(stopped, false); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true); f.releaseReceipt(); f.releaseModel(); await drain; assert.equal(f.settled(), true); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        assert.equal(f.logs.some(line => line.includes('已读回执失败')), mode === 'failure');
    } finally { await f.cleanup(); }
});

for (const mode of ['reentrant', 'throw'] as const) test(`已读回执transport同步stop${mode === 'throw' ? '并throw' : ''}仍预登记本次收尾`, async () => {
    const f = await fixture(mode);
    try {
        f.receive(); await until(() => f.calls() === 1); assert.equal(f.leaseInside(), true); f.releaseReceipt(); f.releaseModel(); await f.stopInside();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.logs.some(line => line.includes('SYNTHETIC_MARK_READ_SYNC_THROW')), mode === 'throw');
    } finally { await f.cleanup(); }
});
