import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成健康探针检查点超时'); await tick(); } }

async function fixture(failure = false) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-health-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs: string[] = []; let app: App | undefined, release!: () => void, calls = 0;
    const held = new Promise<void>(done => { release = done; });
    for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic-health', timeoutMs: 5000, recallTimeoutMs: 100 },
        jokes: false, idioms: false, schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { calls++; await held; if (failure) throw new Error('SYNTHETIC_HEALTH_FAILURE'); return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }); };
    const cleanup = async () => { release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-health-owner-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async () => 900 }, pipeline: { generate: async () => { throw new Error('no synthetic model expected'); } },
        });
    } catch (error) { await cleanup(); throw error; }
    return { app, dataDir, logs, release, calls: () => calls, cleanup };
}

for (const failure of [false, true]) test(`Hindsight健康探针晚${failure ? '失败' : '成功'}不修改已停止App状态`, async () => {
    const f = await fixture(failure);
    try {
        assert.equal(f.app.status().memory?.health, undefined); await until(() => f.calls() === 1); await f.app.stop(); const before = f.app.status(), logs = [...f.logs];
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); f.release(); await settle(); assert.deepEqual(f.app.status().memory?.health, before.memory?.health); assert.deepEqual(f.logs, logs);
    } finally { await f.cleanup(); }
});

test('Hindsight健康探针活跃成功仍更新一次且一分钟内不重复请求', async () => {
    const f = await fixture();
    try {
        f.app.status(); await until(() => f.calls() === 1); f.release(); await settle(); const health = f.app.status().memory?.health;
        assert.equal(health?.ok, true); assert.equal(f.calls(), 1); await f.app.stop();
    } finally { await f.cleanup(); }
});
