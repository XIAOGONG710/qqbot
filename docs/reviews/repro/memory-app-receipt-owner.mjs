// Synthetic real-App correctness probe for responder read-receipt ownership.
// Typing/reaction are not
// generalized from this probe.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';

const tick = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check, detail) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, `synthetic receipt checkpoint timeout: ${detail()}`); await tick(); } }

async function observe(failure) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-receipt-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs = [];
    let app, releaseReceipt, releaseModel, receiptSettled = false, receiptCalls = 0, modelCalls = 0, sends = 0;
    let now = Date.parse('2026-11-05T12:00:00+08:00');
    const receiptHeld = new Promise(done => { releaseReceipt = done; }), modelHeld = new Promise(done => { releaseModel = done; });
    try {
        const schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:00' } }, semester: { start: '2026-09-01', weeks: 52 },
            holidays: [], makeups: [], kinds: { hard: {}, water: {}, machine: {}, pe: {} }, courses: [],
            free: { morning: ['合成休闲'], afternoon: ['合成休闲'], evening: ['合成休闲'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
        for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule } } } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], readReceipts: true, jokes: false, idioms: false,
            schedule: true, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: {
                friendHistory: async () => [],
                markRead: () => { receiptCalls++; return receiptHeld.then(() => { receiptSettled = true; if (failure) throw new Error('SYNTHETIC_MARK_READ_FAILURE'); }); },
                sendPrivateText: async () => { sends++; return 900; },
            },
            pipeline: { now: () => now, waitUntil: async at => { now = at; }, settle: { quietMs: 0, maxMs: 0 }, generate: async () => { modelCalls++; await modelHeld; return 'SYNTHETIC_LATE_REPLY'; } },
        });
        await app.connected(20000);
        app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 1, real_seq: '100001',
            time: now / 1000, raw_message: '合成消息', sender: { user_id: 10001 }, message: '合成消息' });
        await until(() => receiptCalls === 1, () => JSON.stringify({ receiptCalls, modelCalls, sends, logs }));
        await until(() => modelCalls === 1, () => JSON.stringify({ receiptCalls, modelCalls, sends, logs }));
        let stopResolved = false; const drain = Promise.resolve(app.stop()).then(() => { stopResolved = true; }); await settle();
        const atStop = { stopResolved, lease: existsSync(join(dataDir, 'bot.lock')), receiptCalls, receiptSettled, modelCalls, sends, logs: logs.length };
        releaseReceipt(); releaseModel(); await drain; await settle();
        const result = { correctnessProbe: true, chain: 'responder markRead', failure, atStop, receiptSettled, lateLogs: logs.slice(atStop.logs), sends };
        assert.equal(result.atStop.stopResolved, false); assert.equal(result.atStop.lease, true); assert.equal(result.receiptSettled, true); assert.equal(result.sends, 0);
        assert.equal(result.lateLogs.some(line => line.includes('已读回执失败')), failure); console.log(JSON.stringify(result));
    } finally {
        releaseReceipt(); releaseModel(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-receipt-owner-')); rmSync(root, { recursive: true, force: true });
    }
}

await observe(false);
await observe(true);
