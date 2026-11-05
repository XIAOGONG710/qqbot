// Synthetic real-App correctness probe for responder-owned self-recall.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';
import { ChatHistory } from '../../../packages/bot/src/memory/history.ts';
import { maybeTypo, RECALL_SHARE } from '../../../packages/bot/src/language/expression.ts';

const tick = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check, detail) { const deadline = Date.now() + 15000; while (!check()) { assert.ok(Date.now() < deadline, `synthetic self-recall checkpoint timeout: ${detail()}`); await new Promise(done => setTimeout(done, 10)); } }
const reply = Array.from({ length: 20000 }, (_, i) => `我应该明天去${i}`).find(text => {
    const plan = maybeTypo([text], `10001 ${text}`, 3, RECALL_SHARE).recall;
    return plan && plan.afterMs < 1700;
});
assert.ok(reply, '找到可稳定触发撤回且等待较短的合成回复');
const plan = maybeTypo([reply], `10001 ${reply}`, 3, RECALL_SHARE).recall;
assert.ok(plan);

async function observe(mode) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-self-recall-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs = [], sends = [], deletes = [];
    let app, releaseDelete, deleteSettled = false, stopInsideDelete, leaseInsideDelete;
    const deleteHeld = new Promise(done => { releaseDelete = done; });
    const base = Date.parse('2026-11-05T12:00:00+08:00'); let virtual = base, realAnchor = Date.now();
    const now = () => virtual + (Date.now() - realAnchor);
    try {
        const schedule = { sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' }, periods: { '1': { start: '08:00', end: '09:00' } }, semester: { start: '2026-09-01', weeks: 52 },
            holidays: [], makeups: [], kinds: { hard: {}, water: {}, machine: {}, pe: {} }, courses: [],
            free: { morning: ['合成休闲'], afternoon: ['合成休闲'], evening: ['合成休闲'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
        for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色', extensions: { qqbot: { schedule } } } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], selfRecall: true, jokes: false, idioms: false,
            schedule: true, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
        const deleteMessage = messageId => {
            deletes.push(messageId);
            if (mode === 'reentrant' || mode === 'sync-throw') {
                stopInsideDelete = app.stop(); leaseInsideDelete = existsSync(join(dataDir, 'bot.lock'));
                if (mode === 'sync-throw') throw new Error('SYNTHETIC_DELETE_SYNC_THROW');
            }
            return deleteHeld.then(() => { deleteSettled = true; if (mode === 'held-failure') throw new Error('SYNTHETIC_DELETE_ACK_FAILURE'); });
        };
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], deleteMessage, sendPrivateText: async (_qq, text) => { sends.push(text); return 900 + sends.length - 1; } },
            pipeline: { now, waitUntil: async at => { virtual = at; realAnchor = Date.now(); }, settle: { quietMs: 0, maxMs: 0 }, generate: async () => reply },
        });
        await app.connected(20000);
        app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 1, real_seq: '100001',
            time: Math.floor(now() / 1000), raw_message: '你哪天去', sender: { user_id: 10001 }, message: '你哪天去' });
        await until(() => deletes.length === 1, () => JSON.stringify({ mode, sends, deletes, logs }));
        let stopResolved = false; const drain = Promise.resolve(stopInsideDelete ?? app.stop()).then(() => { stopResolved = true; }); await settle();
        const atStop = { stopResolved, lease: existsSync(join(dataDir, 'bot.lock')), deleteSettled, sends: [...sends], deletes: [...deletes], logs: logs.length };
        releaseDelete(); await drain; await settle();
        const result = { correctnessProbe: true, chain: 'selfRecall deleteMessage', mode, expectedWrong: plan.wrong, atStop,
            deleteSettled, stopInsideDeleteWasPromise: stopInsideDelete instanceof Promise, leaseInsideDelete, sends, lateLogs: logs.slice(atStop.logs),
            history: new ChatHistory(dataDir).load(10001).map(row => ({ role: row.role, content: row.content, messageId: row.messageId })) };
        assert.deepEqual(result.sends, [plan.wrong]); assert.deepEqual(result.atStop.deletes, [900]);
        assert.equal(logs.some(line => line.includes('撤回自己打错的那条失败')), false, '停止后的失败不触发补发链或晚失败诊断');
        if (mode === 'sync-throw') {
            assert.equal(result.leaseInsideDelete, true); assert.equal(result.atStop.stopResolved, true); assert.equal(result.atStop.lease, false);
            assert.equal(result.history.filter(row => row.role === 'assistant').length, 1, '同步失败保留实际已发错字');
        } else {
            assert.equal(result.atStop.stopResolved, false); assert.equal(result.atStop.lease, true); assert.equal(result.deleteSettled, true);
            if (mode === 'held-failure') assert.equal(result.history.filter(row => row.role === 'assistant').length, 1, '撤回失败保留实际已发错字');
            else assert.equal(result.history.filter(row => row.role === 'assistant').length, 0, '撤回成功不保留已撤消息');
        }
        console.log(JSON.stringify(result));
    } finally {
        releaseDelete(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-self-recall-owner-')); rmSync(root, { recursive: true, force: true });
    }
}

for (const mode of ['held-success', 'held-failure', 'reentrant', 'sync-throw']) await observe(mode);
