import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { registerHooks } from 'node:module';
import { test } from 'node:test';
import type { App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const linkKey = Symbol.for('qqbot.synthetic.dsh-owner-review-link');
const globals = globalThis as unknown as Record<symbol, unknown>;
const dshUrl = new URL('../src/dsh-link.ts', import.meta.url).href;
const hooks = registerHooks({ load(url, context, next) {
    if (url === dshUrl) return { format: 'module', shortCircuit: true, source: `export const dshOptionsFromLlm=(o,p={})=>({...o,...p});export const createDshLink=()=>globalThis[Symbol.for('qqbot.synthetic.dsh-owner-review-link')]();` };
    return next(url, context);
} });
const { startApp } = await import('../src/platform/app.ts'); hooks.deregister();
const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成DSH检查点超时'); await tick(); } }

async function fixture(first: 'held-success' | 'held-failure' | 'immediate') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-dsh-owner-test-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, oldLink = globals[linkKey], calls: Array<{ question: string; recentTurns?: Array<{ role: string; content: string }> }> = [], sends: string[] = [], logs: string[] = [];
    let app: App | undefined, release!: () => void;
    const held = new Promise<void>(done => { release = done; }), now = Date.parse('2026-11-05T12:00:00+08:00');
    globals[linkKey] = () => ({ model: 'synthetic', probe: async () => { throw new Error('no synthetic probe expected'); }, advise: async (request: { question: string; recentTurns?: Array<{ role: string; content: string }> }) => {
        const index = calls.length; calls.push(structuredClone(request));
        if (index === 0 && first !== 'immediate') { await held; if (first === 'held-failure') throw new Error('SYNTHETIC_FIRST_ADVICE_FAILURE'); }
        return index === 0 ? 'SYNTHETIC_FIRST_ADVICE' : 'SYNTHETIC_SECOND_ADVICE';
    } });
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], dsh: { enabled: true }, jokes: false, idioms: false,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
    const cleanup = async () => { release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch; globals[linkKey] = oldLink; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-dsh-owner-test-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => { sends.push(text); return 900; } },
            pipeline: { now: () => now, generate: async () => { throw new Error('no synthetic chat generation expected'); } },
        });
        await app.connected(20000);
    } catch (error) { await cleanup(); throw error; }
    const owner = app;
    return { app: owner, dataDir, calls, sends, logs, release,
        receive(id: number, question: string) { owner.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: id, real_seq: String(100000 + id), time: now / 1000,
            raw_message: '', sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: `/dsh ask ${question}` } }] }); }, cleanup };
}

for (const first of ['held-success', 'held-failure'] as const) test(`DSH首问晚${first === 'held-success' ? '成功' : '失败'}不写上下文或派发排队后继`, async () => {
    const f = await fixture(first);
    try {
        f.receive(1, '第一问'); await until(() => f.calls.length === 1); f.receive(2, '第二问');
        await f.app.stop(); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); const logs = [...f.logs];
        f.release(); await settle(); assert.equal(f.calls.length, 1); assert.deepEqual(f.sends, []); assert.deepEqual(f.logs, logs);
    } finally { await f.cleanup(); }
});

test('DSH问题入队后同栈stop不在微任务中派发', async () => {
    const f = await fixture('held-success');
    try { f.receive(1, '第一问'); await f.app.stop(); f.release(); await settle(); assert.equal(f.calls.length, 0); assert.deepEqual(f.sends, []); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); }
    finally { await f.cleanup(); }
});

test('DSH未停止时两问保持顺序和连续上下文', async () => {
    const f = await fixture('immediate');
    try {
        f.receive(1, '第一问'); f.receive(2, '第二问'); await until(() => f.calls.length === 2 && f.sends.length === 2);
        assert.equal(f.calls[0]?.question, '第一问'); assert.equal(f.calls[1]?.question, '第二问');
        assert.deepEqual(f.calls[1]?.recentTurns, [{ role: 'user', content: '第一问' }, { role: 'assistant', content: 'SYNTHETIC_FIRST_ADVICE' }]);
        assert.deepEqual(f.sends, ['SYNTHETIC_FIRST_ADVICE', 'SYNTHETIC_SECOND_ADVICE']);
    } finally { await f.cleanup(); }
});
