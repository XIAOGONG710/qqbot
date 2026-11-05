import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成主动提示检查点超时'); await tick(); } }

async function fixture(mode: 'held' | 'reentrant' | 'throw' | 'immediate', failure = false) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-direct-text-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs: string[] = [], sends: string[] = [];
    let app: App | undefined, release!: () => void, entered = false, leaseInsideTransport: boolean | undefined;
    const held = new Promise<void>(done => { release = done; }), now = Date.parse('2026-11-05T12:00:00+08:00');
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], proactive: 'off', jokes: false, idioms: false,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
    const cleanup = async () => { release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-direct-text-owner-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: (_qq, text) => {
                sends.push(text); entered = true;
                if (mode === 'reentrant' || mode === 'throw') { void app!.stop(); leaseInsideTransport = existsSync(join(dataDir, 'bot.lock')); }
                if (mode === 'throw') throw new Error('SYNTHETIC_DIRECT_SYNC_THROW');
                if (mode === 'held' || mode === 'reentrant') return held.then(() => { if (failure) throw new Error('SYNTHETIC_DIRECT_ACK_FAILURE'); return 900; });
                if (failure) return Promise.reject(new Error('SYNTHETIC_DIRECT_ACK_FAILURE'));
                return Promise.resolve(900);
            } }, pipeline: { now: () => now, generate: async () => { throw new Error('no synthetic model expected'); } },
        });
        await app.connected(20000);
    } catch (error) { await cleanup(); throw error; }
    const owner = app;
    return { app: owner, dataDir, logs, sends, release, entered: () => entered, leaseInsideTransport: () => leaseInsideTransport,
        receive() { owner.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 1, real_seq: '100001', time: now / 1000,
            raw_message: '/主动', sender: { user_id: 10001 }, message: '/主动' }); },
        history: () => new ChatHistory(dataDir).load(10001), cleanup };
}

test('/主动原因尚未派发时停止，不在释放租约后新发提示', { skip: 'DSH 线已把指令收敛（2026-10-31），/主动 不在保留名单里，由 tellOwner 在 receive 里同步回「这些指令已经不用了」，没有「提示尚未派发」的窗口；stop 按设计等 ACK，这条按 main 的 /主动 命令写的前提在这里不成立' }, async () => {
    const f = await fixture('held');
    try { f.receive(); await f.app.stop(); await settle(); assert.deepEqual(f.sends, []); assert.deepEqual(f.history(), []); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); }
    finally { await f.cleanup(); }
});

for (const failure of [false, true]) test(`/主动原因提示已派${failure ? '失败' : '成功'}ACK收尾前不释放租约`, async () => {
    const f = await fixture('held', failure);
    try {
        f.receive(); await until(f.entered); let stopped = false; const drain = Promise.resolve(f.app.stop()).then(() => { stopped = true; }); await settle();
        assert.equal(stopped, false); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true); f.release(); await drain;
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.sends.length, 1); assert.deepEqual(f.history(), []);
        assert.equal(f.logs.some(line => line.includes('SYNTHETIC_DIRECT_ACK_FAILURE')), failure);
    } finally { await f.cleanup(); }
});

test('/主动原因提示transport同步stop时已预登记本次ACK', async () => {
    const f = await fixture('reentrant');
    try { f.receive(); await until(f.entered); assert.equal(f.leaseInsideTransport(), true); f.release(); await f.app.stop(); assert.equal(f.sends.length, 1); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.deepEqual(f.history(), []); }
    finally { await f.cleanup(); }
});

test('/主动原因提示transport同步stop再throw仍完成诊断和租约收尾', async () => {
    const f = await fixture('throw');
    try { f.receive(); await until(f.entered); await f.app.stop(); assert.equal(f.leaseInsideTransport(), true); assert.equal(f.logs.filter(line => line.includes('SYNTHETIC_DIRECT_SYNC_THROW')).length, 1); assert.deepEqual(f.history(), []); }
    finally { await f.cleanup(); }
});

for (const failure of [false, true]) test(`/主动正常即时提示${failure ? '失败' : '成功'}保持不写聊天历史`, async () => {
    const f = await fixture('immediate', failure);
    try { f.receive(); await until(f.entered); await settle(); await f.app.stop(); assert.equal(f.sends.length, 1); assert.deepEqual(f.history(), []); assert.equal(f.logs.some(line => line.includes('SYNTHETIC_DIRECT_ACK_FAILURE')), failure); }
    finally { await f.cleanup(); }
});
