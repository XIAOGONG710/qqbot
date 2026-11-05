// Synthetic real-App correctness probe for the immediate device owner reply chain.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';
import { ChatHistory } from '../../../packages/bot/src/memory/history.ts';

const tick = () => new Promise(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }

async function observe(mode) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-device-reply-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs = [], sends = [];
    let app, release, sendSettled = false, stopInsideTransport, leaseInsideTransport, receiveError;
    const held = new Promise(done => { release = done; });
    try {
        for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], deviceControl: 'on', jokes: false, idioms: false,
            schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async () => { throw new Error('unexpected synthetic network'); };
        const service = {
            control: { menu: () => '', parse: text => ({ reply: text, proposals: [], rejected: [] }), commit: () => undefined },
            hub: {}, owner: () => ({ kind: 'reply', text: 'SYNTHETIC_DEVICE_DIRECT_REPLY' }), stop: async () => {},
        };
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            startDevices: async () => service,
            transport: { friendHistory: async () => [], sendPrivateText: (_qq, text) => {
                sends.push({ text, lease: existsSync(join(dataDir, 'bot.lock')) });
                if (mode === 'reentrant' || mode === 'sync-throw') {
                    stopInsideTransport = app.stop(); leaseInsideTransport = existsSync(join(dataDir, 'bot.lock'));
                    if (mode === 'sync-throw') throw new Error('SYNTHETIC_DEVICE_DIRECT_SYNC_THROW');
                }
                return held.then(() => {
                    sendSettled = true;
                    if (mode === 'held-failure') throw new Error('SYNTHETIC_DEVICE_DIRECT_ACK_FAILURE');
                    return 900;
                });
            } },
            pipeline: { now: () => Date.parse('2026-11-05T12:00:00+08:00'), generate: async () => { throw new Error('no synthetic model expected'); } },
        });
        await app.connected(20000); await settle();
        const receive = () => app.receive({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001,
            message_id: 1, real_seq: '100001', time: Date.parse('2026-11-05T12:00:00+08:00') / 1000, raw_message: '/设备', sender: { user_id: 10001 }, message: '/设备' });
        if (mode === 'stopped-before-receive') { await app.stop(); receive(); await settle(); }
        else {
            try { receive(); } catch (error) { receiveError = error instanceof Error ? error.message : String(error); }
            let stopResolved = false; const drain = Promise.resolve(stopInsideTransport ?? app.stop()).then(() => { stopResolved = true; });
            await settle(); const before = logs.length;
            const heldObservation = { stopResolved, lease: existsSync(join(dataDir, 'bot.lock')), lateLogsBeforeRelease: logs.slice(before) };
            release(); await drain; await settle();
            const result = { correctnessProbe: true, chain: 'device owner immediate reply', mode, heldObservation, sends, sendSettled,
                stopInsideTransportWasPromise: stopInsideTransport instanceof Promise, leaseInsideTransport, receiveError, lateLogs: logs.slice(before),
                syntheticErrorLogs: logs.filter(line => line.includes('SYNTHETIC_DEVICE_DIRECT')), ...(mode === 'sync-throw' ? { allLogs: logs } : {}),
                historyCount: new ChatHistory(dataDir).load(10001).length };
            assert.equal(result.sends.length, 1); assert.equal(result.historyCount, 0); assert.equal(result.receiveError, undefined);
            if (mode === 'sync-throw') { assert.equal(result.leaseInsideTransport, true); assert.equal(result.syntheticErrorLogs.length, 1); }
            else { assert.equal(result.heldObservation.stopResolved, false); assert.equal(result.heldObservation.lease, true); assert.equal(result.sendSettled, true); }
            if (mode === 'held-failure') assert.equal(result.syntheticErrorLogs.length, 1);
            console.log(JSON.stringify(result));
            return;
        }
        const result = { correctnessProbe: true, chain: 'device owner immediate reply', mode, sends, historyCount: new ChatHistory(dataDir).load(10001).length,
            leaseAfterStop: existsSync(join(dataDir, 'bot.lock')) }; assert.deepEqual(result.sends, []); assert.equal(result.historyCount, 0); assert.equal(result.leaseAfterStop, false);
        console.log(JSON.stringify(result));
    } finally {
        release(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-device-reply-owner-')); rmSync(root, { recursive: true, force: true });
    }
}

for (const mode of ['stopped-before-receive', 'held-success', 'held-failure', 'reentrant', 'sync-throw']) await observe(mode);
