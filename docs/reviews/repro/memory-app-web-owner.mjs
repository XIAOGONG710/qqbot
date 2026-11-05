// Synthetic real-App correctness probe for the continuity WebLookup lifetime.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';

const NOW = Date.parse('2026-11-05T12:00:00+08:00');
const tick = () => new Promise(done => setImmediate(done));
async function settle(rounds = 16) { for (let i = 0; i < rounds; i++) await tick(); }
async function until(check, label, rounds = 400) {
    for (let i = 0; i < rounds; i++) { if (check()) return; await new Promise(done => setTimeout(done, 2)); }
    throw new Error(`synthetic timeout: ${label}`);
}
const wiki = () => new Response(JSON.stringify({ query: { pages: { 1: {
    pageid: 1, title: '合成资料', extract: '合成资料明确写着星云土豆是一项离线测试事实。', index: 1,
} } } }), { headers: { 'content-type': 'application/json' } });

function event(id, text) {
    return { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001,
        message_id: id, real_seq: String(900000 + id), time: NOW / 1000, raw_message: text,
        sender: { user_id: 10001 }, message: text };
}

function makeConfig(root, dataDir) {
    for (const tier of ['boyfriend', 'boyfriend-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({
        spec: 'chara_card_v2', data: { name: '合成角色' },
    }));
    return parseAppConfig({
        llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'boyfriend', name: '合成联系人' }], timeline: true, webLookup: 'explicit',
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false,
        jokes: false, idioms: false,
    }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
}

async function stopWhileGathering() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-web-owner-stop-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, logs = [], sent = [];
    let app, releaseFetch, fetchCalls = 0, extractCalls = 0;
    const held = new Promise(done => { releaseFetch = done; });
    try {
        const config = makeConfig(root, dataDir);
        globalThis.fetch = async url => { fetchCalls++; assert.match(String(url), /wikipedia/); await held; return wiki(); };
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => { sent.push(text); return 1; } },
            pipeline: { now: () => NOW, settle: { quietMs: 0, maxMs: 0 }, generate: async messages => {
                const text = messages.map(line => line.content).join('\n');
                if (text.includes('资料摘录员')) { extractCalls++; return '星云土豆是一项离线测试事实'; }
                return '合成主回复';
            } },
        });
        await app.connected(20000); app.receive(event(1, '帮我查一下星云土豆是什么'));
        await until(() => fetchCalls === 1, 'web gather entered');
        let stopResolved = false; const stopping = Promise.resolve(app.stop()).then(() => { stopResolved = true; });
        await settle();
        const beforeRelease = { stopResolved, lease: existsSync(join(dataDir, 'bot.lock')), logs: logs.length,
            timelineExists: existsSync(join(dataDir, 'timeline.jsonl')), extractCalls, sent: sent.length };
        releaseFetch(); await stopping; await settle(32);
        const timeline = existsSync(join(dataDir, 'timeline.jsonl')) ? readFileSync(join(dataDir, 'timeline.jsonl'), 'utf8') : '';
        assert.equal(extractCalls, 0); assert.equal(sent.length, 0); assert.equal(timeline, '');
        assert.deepEqual(logs.slice(beforeRelease.logs), []);
        console.log(JSON.stringify({ diagnostic: false, scenario: 'stop-held-gather', beforeRelease,
            afterRelease: { lease: existsSync(join(dataDir, 'bot.lock')), extractCalls, sent, lateLogs: logs.slice(beforeRelease.logs),
                timelineHasLateWeb: timeline.includes('上网查了「星云土豆是什么」'), timeline },
        }));
    } finally {
        releaseFetch?.(); await app?.stop(); await settle(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-web-owner-stop-'));
        rmSync(root, { recursive: true, force: true });
    }
}

async function timeoutThenRestart() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-web-owner-restart-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch, oldSetTimeout = globalThis.setTimeout;
    const logs1 = [], logs2 = [], sent1 = [], sent2 = [], prompts2 = [];
    let app1, app2, releaseFetch, fetchCalls = 0, extractCalls = 0;
    const held = new Promise(done => { releaseFetch = done; });
    try {
        const config = makeConfig(root, dataDir);
        globalThis.setTimeout = ((callback, ms, ...args) => oldSetTimeout(callback, ms === 25_000 ? 5 : ms, ...args));
        globalThis.fetch = async url => { fetchCalls++; assert.match(String(url), /wikipedia/); await held; return wiki(); };
        app1 = startApp({ config, log: line => logs1.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => { sent1.push(text); return 11; } },
            pipeline: { now: () => NOW, settle: { quietMs: 0, maxMs: 0 }, generate: async messages => {
                const text = messages.map(line => line.content).join('\n');
                if (text.includes('资料摘录员')) { extractCalls++; return '星云土豆是一项离线测试事实'; }
                return '第一实例合成主回复';
            } },
        });
        await app1.connected(20000); app1.receive(event(10, '帮我查一下星云土豆是什么'));
        await until(() => fetchCalls === 1, 'first instance web gather');
        await until(() => sent1.length === 1, 'first reply after web deadline');
        await app1.stop();
        const beforeRestart = { lease: existsSync(join(dataDir, 'bot.lock')), extractCalls,
            timelineExists: existsSync(join(dataDir, 'timeline.jsonl')), state: readFileSync(join(dataDir, 'web', 'state.json'), 'utf8') };

        app2 = startApp({ config, log: line => logs2.push(line), sensitive: { on: () => false, describe: () => '' },
            transport: { friendHistory: async () => [], sendPrivateText: async (_qq, text) => { sent2.push(text); return 22; } },
            pipeline: { now: () => NOW, settle: { quietMs: 0, maxMs: 0 }, generate: async messages => { prompts2.push(messages.map(line => line.content).join('\n')); return '第二实例合成主回复'; } },
        });
        await app2.connected(20000);
        releaseFetch(); await settle(32);
        const timelineAfterOld = existsSync(join(dataDir, 'timeline.jsonl')) ? readFileSync(join(dataDir, 'timeline.jsonl'), 'utf8') : '';
        app2.receive(event(11, '晚上好'));
        await until(() => sent2.length === 1, 'second instance reply');
        const prompt = prompts2.at(-1) ?? '';
        assert.equal(extractCalls, 0); assert.equal(timelineAfterOld, '');
        assert.equal(prompt.includes('上网查了「星云土豆是什么」'), false);
        console.log(JSON.stringify({ diagnostic: false, scenario: 'deadline-old-result-after-restart', beforeRestart,
            afterOldRelease: { extractCalls, oldLateLogs: logs1.filter(line => line.includes('上网：')), timelineAfterOld,
                newInstancePromptHasOldWeb: prompt.includes('上网查了「星云土豆是什么」'), sent1, sent2 },
        }));
    } finally {
        releaseFetch?.(); await app2?.stop(); await app1?.stop(); await settle();
        globalThis.fetch = oldFetch; globalThis.setTimeout = oldSetTimeout;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-web-owner-restart-'));
        rmSync(root, { recursive: true, force: true });
    }
}

await stopWhileGathering();
await timeoutThenRestart();
