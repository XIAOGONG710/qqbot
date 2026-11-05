// Synthetic real-App behavior probe; assertions cover the repaired owner.
// Already-issued owner notice ACK (success and failure).
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';
import { ChatHistory } from '../../../packages/bot/src/memory/history.ts';
const tick = () => new Promise(done => setImmediate(done));
const settle = async () => { for (let i = 0; i < 16; i++) await tick(); };
const until = async check => { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, 'synthetic checkpoint timeout'); await tick(); } };

async function observe(failure) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-tell-owner-review-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs = [], sends = []; let app, release, entered = false, completed = false;
    const held = new Promise(done => { release = done; }), now = Date.parse('2026-11-05T12:00:00+08:00');
    try {
        for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], memoryAudit: true, dsh: { enabled: false }, jokes: false, idioms: false,
            schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async (qq, text) => { sends.push({ qq, text }); entered = true; await held; completed = true; if (failure) throw new Error('SYNTHETIC_OWNER_NOTICE_ACK_FAILURE'); return 900; } },
            pipeline: { now: () => now, generate: async () => { throw new Error('no synthetic chat generation expected'); } },
        });
        await app.connected(20000);
        app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 1, real_seq: '100001', time: now / 1000,
            raw_message: '', sender: { user_id: 10001 }, message: [{ type: 'text', data: { text: '/设定' } }] });
        await until(() => entered);
        let stopped = false; const drain = Promise.resolve(app.stop()).then(() => { stopped = true; }); await settle();
        const atStop = { stopped, lease: existsSync(join(dataDir, 'bot.lock')), sends: sends.length, logs: logs.length };
        assert.equal(atStop.stopped, false); assert.equal(atStop.lease, true);
        release(); await drain; await settle();
        assert.equal(completed, true); assert.equal(existsSync(join(dataDir, 'bot.lock')), false);
        assert.equal(new ChatHistory(dataDir).load(10001).length, 0);
        assert.equal(logs.slice(atStop.logs).length, failure ? 1 : 0);
        console.log(JSON.stringify({ mode: 'held-notice-ACK', failure, atStop, completed,
            sendsAfterStop: sends.slice(atStop.sends), ackLogsBeforeDrain: logs.slice(atStop.logs), historyRows: new ChatHistory(dataDir).load(10001).length }, null, 2));
    } finally {
        release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-tell-owner-review-')); rmSync(root, { recursive: true, force: true });
    }
}
await observe(false); await observe(true);
