import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成好友申请检查点超时'); await tick(); } }

async function fixture(mode: 'success' | 'failure' | 'reentrant' | 'throw') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-friend-request-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs: string[] = []; let app: App | undefined, release!: () => void, calls = 0, settledMutation = false, leaseInside: boolean | undefined, stopInside: Promise<void> | undefined;
    const held = new Promise<void>(done => { release = done; });
    const schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:00' } }, semester: { start: '2026-09-01', weeks: 52 }, holidays: [], makeups: [], kinds: { hard: {}, water: {}, machine: {}, pe: {} }, courses: [], free: { morning: ['合成休闲'], afternoon: ['合成休闲'], evening: ['合成休闲'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule } } } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], qqControl: 'on', qqFriendGate: 'allow', qqAllowFriends: [10001],
        jokes: false, idioms: false, schedule: true, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
    const cleanup = async () => { release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-friend-request-owner-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async () => 900, callAction: () => {
                calls++;
                if (mode === 'reentrant' || mode === 'throw') { stopInside = Promise.resolve(app!.stop()); leaseInside = existsSync(join(dataDir, 'bot.lock')); }
                if (mode === 'throw') throw new Error('SYNTHETIC_FRIEND_REQUEST_SYNC_THROW');
                return held.then(() => { settledMutation = true; if (mode === 'failure') throw new Error('SYNTHETIC_FRIEND_REQUEST_FAILURE'); return {}; });
            } },
            pipeline: { now: () => Date.parse('2026-11-05T12:00:00+08:00'), settle: { quietMs: 0, maxMs: 0 }, waitUntil: async () => {}, generate: async () => 'unused' },
        });
    } catch (error) { await cleanup(); throw error; }
    return { app, dataDir, logs, release, calls: () => calls, settled: () => settledMutation, leaseInside: () => leaseInside, stopInside: () => stopInside,
        request() { app!.receiveFriendRequest({ userId: 10001, flag: 'synthetic-flag' }); }, cleanup };
}

for (const mode of ['success', 'failure'] as const) test(`好友申请mutation${mode === 'success' ? '成功' : '失败'}与审计确认前App不释放租约`, async () => {
    const f = await fixture(mode);
    try {
        f.request(); await until(() => f.calls() === 1); let stopped = false; const drain = Promise.resolve(f.app!.stop()).then(() => { stopped = true; }); await settle();
        assert.equal(stopped, false); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true); assert.equal(existsSync(join(f.dataDir, 'account-audit.jsonl')), false);
        f.release(); await drain; assert.equal(f.settled(), true); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        const audit = readFileSync(join(f.dataDir, 'account-audit.jsonl'), 'utf8'); assert.match(audit, /set_friend_add_request/);
        assert.equal(audit.includes('SYNTHETIC_FRIEND_REQUEST_FAILURE'), mode === 'failure');
        assert.equal(f.logs.some(line => line.includes('处理失败')), mode === 'failure');
    } finally { await f.cleanup(); }
});

test('App停止后新的好友申请不再调用控制面或写诊断', async () => {
    const f = await fixture('success');
    try {
        await f.app!.stop(); f.request(); await settle(); assert.equal(f.calls(), 0); assert.equal(existsSync(join(f.dataDir, 'account-audit.jsonl')), false);
        assert.equal(f.logs.some(line => line.includes('[好友申请]')), false);
    } finally { await f.cleanup(); }
});

for (const mode of ['reentrant', 'throw'] as const) test(`好友申请transport同步stop${mode === 'throw' ? '并throw' : ''}仍预登记mutation与审计收尾`, async () => {
    const f = await fixture(mode);
    try {
        f.request(); await until(() => f.calls() === 1); assert.equal(f.leaseInside(), true); f.release(); await f.stopInside();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.match(readFileSync(join(f.dataDir, 'account-audit.jsonl'), 'utf8'), /set_friend_add_request/);
        assert.equal(f.logs.some(line => line.includes('SYNTHETIC_FRIEND_REQUEST_SYNC_THROW')), mode === 'throw');
    } finally { await f.cleanup(); }
});
