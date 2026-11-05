// Synthetic real-App correctness probe for QQ friend-request mutation ownership.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';

const tick = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, 'synthetic friend-request checkpoint timeout'); await tick(); } }

async function observe(failure) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-friend-request-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs = []; let app, release, settledMutation = false, calls = 0;
    const held = new Promise(done => { release = done; });
    try {
        const schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:00' } }, semester: { start: '2026-09-01', weeks: 52 }, holidays: [], makeups: [], kinds: { hard: {}, water: {}, machine: {}, pe: {} }, courses: [], free: { morning: ['合成休闲'], afternoon: ['合成休闲'], evening: ['合成休闲'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
        for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule } } } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], qqControl: 'on', qqFriendGate: 'allow', qqAllowFriends: [10001],
            jokes: false, idioms: false, schedule: true, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async () => 900, callAction: () => { calls++; return held.then(() => { settledMutation = true; if (failure) throw new Error('SYNTHETIC_FRIEND_REQUEST_FAILURE'); return {}; }); } },
            pipeline: { now: () => Date.parse('2026-11-05T12:00:00+08:00'), settle: { quietMs: 0, maxMs: 0 }, waitUntil: async () => {}, generate: async () => 'unused' },
        });
        app.receiveFriendRequest({ userId: 10001, flag: 'synthetic-flag' });
        await until(() => calls === 1);
        let stopResolved = false; const drain = Promise.resolve(app.stop()).then(() => { stopResolved = true; }); await settle();
        const before = logs.length, auditBefore = existsSync(join(dataDir, 'account-audit.jsonl'));
        const atStop = { stopResolved, lease: existsSync(join(dataDir, 'bot.lock')), calls, settledMutation, auditBefore };
        release(); await drain; await settle();
        const auditAfter = existsSync(join(dataDir, 'account-audit.jsonl'));
        assert.equal(atStop.stopResolved, false); assert.equal(atStop.lease, true); assert.equal(atStop.settledMutation, false); assert.equal(atStop.auditBefore, false);
        assert.equal(settledMutation, true); assert.equal(auditAfter, true); assert.equal(logs.slice(before).some(line => line.includes('处理失败')), failure);
        console.log(JSON.stringify({ correctnessProbe: true, chain: 'friend request account mutation', failure, atStop, settledMutation,
            auditAfter, lateLogs: logs.slice(before) }));
    } finally {
        release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-friend-request-owner-')); rmSync(root, { recursive: true, force: true });
    }
}

await observe(false);
await observe(true);
