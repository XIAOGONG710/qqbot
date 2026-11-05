import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';

// Replace only the explicit external DSH dependency. App command dispatch,
// transport, directory ownership and history remain the actual implementation.
const linkKey = Symbol.for('qqbot.synthetic.tell-owner-link');
const globals = globalThis as unknown as Record<symbol, unknown>;
const dshUrl = new URL('../src/dsh-link.ts', import.meta.url).href;
const hooks = registerHooks({ load(url, context, next) {
    if (url === dshUrl) return { format: 'module', shortCircuit: true, source: `export const dshOptionsFromLlm=(o,p={})=>({...o,...p});export const createDshLink=()=>globalThis[Symbol.for('qqbot.synthetic.tell-owner-link')]();` };
    return next(url, context);
} });
const { startApp } = await import('../src/platform/app.ts'); hooks.deregister();
const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 12; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成通知检查点超时'); await tick(); } }

async function fixture(mode: 'held' | 'reentrant' | 'throw' | 'probe' | 'advice' | 'none', fail = false) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-tell-owner-test-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, oldLink = globals[linkKey], logs: string[] = [], sends: string[] = [];
    let app: App | undefined, entered = false, release!: () => void, leaseInsideTransport: boolean | undefined;
    const held = new Promise<void>(done => { release = done; }), now = Date.parse('2026-11-05T12:00:00+08:00');
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const source = async () => { entered = true; await held; if (fail) throw new Error('SYNTHETIC_LATE_OWNER_SOURCE_FAILURE'); };
    globals[linkKey] = () => ({ model: 'synthetic', probe: async () => { await source(); return { ok: true, at: new Date(now).toISOString(), model: 'synthetic', latencyMs: 1 }; }, advise: async () => { await source(); return '合成DSH回答'; } });
    const dsh = mode === 'probe' || mode === 'advice';
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], memoryAudit: !dsh, dsh: { enabled: dsh }, jokes: false, idioms: false,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
    const cleanup = async () => { release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; globals[linkKey] = oldLink; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-tell-owner-test-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: (_qq, text) => {
                sends.push(text); entered = true;
                if (mode === 'reentrant' || mode === 'throw') { void app!.stop(); leaseInsideTransport = existsSync(join(dataDir, 'bot.lock')); }
                if (mode === 'throw') throw new Error('SYNTHETIC_OWNER_SYNC_THROW');
                if (mode === 'held' || mode === 'reentrant') return held.then(() => { if (fail) throw new Error('SYNTHETIC_OWNER_ACK_FAILURE'); return 900; });
                return Promise.resolve(900);
            } }, pipeline: { now: () => now, generate: async () => { throw new Error('no synthetic chat model expected'); } },
        });
        await app.connected(20000);
    } catch (error) { await cleanup(); throw error; }
    const command = mode === 'probe' ? '/dsh' : mode === 'advice' ? '/dsh ask 合成问题' : '/设定';
    return { app, dataDir, logs, sends, release, entered: () => entered, leaseInsideTransport: () => leaseInsideTransport, history: () => new ChatHistory(dataDir).load(10001),
        receive() { app!.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 1, real_seq: '100001', time: now / 1000,
            raw_message: '', sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: command } }] }); }, cleanup };
}

for (const fail of [false, true]) test(`tellOwner已派通知${fail ? '失败' : '成功'}ACK收尾前不释放租约，且不写聊天历史`, async () => {
    const f = await fixture('held', fail);
    try {
        f.receive(); await until(f.entered); let stopped = false; const drain = Promise.resolve(f.app.stop()).then(() => { stopped = true; }); await settle();
        assert.equal(stopped, false); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true); f.release(); await drain;
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.sends.length, 1); assert.deepEqual(f.history(), []);
        if (fail) assert.ok(f.logs.some(line => line.includes('提示没发出去')));
    } finally { await f.cleanup(); }
});

test('tellOwner transport同步stop时先登记本次ACK，防止快照漏收尾', async () => {
    const f = await fixture('reentrant');
    try {
        f.receive(); await until(f.entered); assert.equal(f.leaseInsideTransport(), true); f.release(); await f.app.stop();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.sends.length, 1); assert.deepEqual(f.history(), []);
    } finally { await f.cleanup(); }
});

test('tellOwner transport同步stop并throw仍在锁内诊断，无未结租约或聊天历史', async () => {
    const f = await fixture('throw');
    try {
        assert.doesNotThrow(() => f.receive()); await f.app.stop(); assert.equal(f.leaseInsideTransport(), true);
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.equal(f.logs.filter(line => line.includes('SYNTHETIC_OWNER_SYNC_THROW')).length, 1); assert.deepEqual(f.history(), []);
    } finally { await f.cleanup(); }
});

for (const mode of ['probe', 'advice'] as const) test(`tellOwner的${mode}纯命令来源晚结果在停止后不新派通知`, async () => {
    const f = await fixture(mode);
    try {
        f.receive(); await until(f.entered); await f.app.stop(); const logs = [...f.logs]; assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        f.release(); await settle(); assert.deepEqual(f.sends, []); assert.deepEqual(f.logs, logs); assert.deepEqual(f.history(), []);
    } finally { await f.cleanup(); }
});

test('tellOwner命令来源晚失败在停止后不通过错误提示新发文字', async () => {
    const f = await fixture('advice', true);
    try {
        f.receive(); await until(f.entered); await f.app.stop(); f.release(); await settle(); assert.deepEqual(f.sends, []); assert.deepEqual(f.history(), []);
    } finally { await f.cleanup(); }
});

test('tellOwner正常已确认运维提示保留原不写聊天的政策', async () => {
    const f = await fixture('none');
    try { f.receive(); await until(f.entered); await settle(); await f.app.stop(); assert.equal(f.sends.length, 1); assert.deepEqual(f.history(), []); }
    finally { await f.cleanup(); }
});
