// Synthetic real-App correctness probe. Only temporary synthetic cards and
// credentials are read; no real runtime or external services are accessed.
// node docs/reviews/repro/memory-risk-owner.mjs [--issued-dm] [--real-guard]
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp } from '../../../packages/bot/src/platform/app.ts';
import { parseAppConfig } from '../../../packages/bot/src/platform/config.ts';

const issued = process.argv.includes('--issued-dm'), realGuard = process.argv.includes('--real-guard');
const root = mkdtempSync(join(tmpdir(), 'qqbot-risk-owner-review-')), dataDir = join(root, 'data');
const previousFetch = globalThis.fetch, logs = [], requests = [];
let app, entered = false, release;
const held = new Promise(done => { release = done; });
const tick = () => new Promise(done => setImmediate(done));
const until = async check => { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, 'synthetic checkpoint timeout'); await tick(); } };
const login = { code: 0, data: { isLogin: true, uname: '合成账号', mid: 123, wbi_img: { img_url: `https://synthetic.invalid/${'a'.repeat(32)}.png`, sub_url: `https://synthetic.invalid/${'b'.repeat(32)}.png` } } };
const request = async raw => {
    const url = new URL(String(raw)); requests.push(url.pathname);
    let body;
    if (url.pathname.endsWith('/nav')) body = login;
    else if (url.pathname.endsWith('/reply')) body = { code: 0, data: { items: [] } };
    else if (url.pathname.endsWith('/unread')) {
        if (!issued) { entered = true; await held; }
        body = { code: 0, data: { sys_msg: 1 } };
    } else if (url.pathname.endsWith('/query_unified_notify')) body = { code: 0, data: { system_notify_list: [{ id: '123456', title: '合成账号警告', content: '合成风险事件', time_at: '2026-11-05 12:00:00' }] } };
    else if (url.pathname.endsWith('/send_msg')) { if (issued) { entered = true; await held; } body = { code: 0, data: {} }; }
    else throw new Error(`unexpected synthetic route ${url.pathname}`);
    return realGuard ? Response.json(body) : { ok: true, status: 200, text: async () => JSON.stringify(body) };
};
try {
    mkdirSync(join(dataDir, 'secrets'), { recursive: true });
    for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    writeFileSync(join(dataDir, 'secrets', 'bilibili.json'), JSON.stringify({ sessdata: 'SYNTHETIC_SESSION', biliJct: 'SYNTHETIC_CSRF', dedeUserId: '123', buvid3: 'SYNTHETIC_DEVICE', savedAt: '2026-11-05T00:00:00Z' }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], bilibiliAccount: true, bilibiliReplies: 'dryRun', bilibiliAtUid: 456,
        jokes: false, idioms: false, memes: false, watching: false, biliFeed: 'off', schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = realGuard ? request : async () => { throw new Error('unexpected synthetic network'); };
    app = startApp({ config, sensitive: { on: () => false, describe: () => '' }, log: line => logs.push(line),
        transport: { friendHistory: async () => [], sendPrivateText: async () => 900 }, pipeline: { now: () => new Date(2026, 10, 5, 16).getTime(), generate: async () => { throw new Error('no synthetic compose expected'); } },
        ...(!realGuard ? { bilibiliRequest: request } : {}) });
    await app.connected(20000); await until(() => entered);
    const file = join(dataDir, 'presence', 'bilibili-risk.json'), lock = join(dataDir, 'bot.lock');
    const before = { file: existsSync(file) ? readFileSync(file, 'utf8') : null, requests: requests.length, logs: logs.length };
    let drained = false; const stopping = Promise.resolve(app.stop()).then(() => { drained = true; });
    for (let i = 0; i < 12; i++) await tick();
    const heldAtStop = { drained, lease: existsSync(lock) };
    release(); await stopping;
    const atDrain = { requests: requests.length, logs: logs.length, file: existsSync(file) ? readFileSync(file, 'utf8') : null };
    for (let i = 0; i < 30; i++) await tick();
    const after = { requests: requests.length, logs: logs.length, file: existsSync(file) ? readFileSync(file, 'utf8') : null };
    assert.deepEqual(requests.slice(before.requests), []);
    assert.deepEqual(after, atDrain);
    if (issued) { assert.equal(heldAtStop.drained, false); assert.equal(heldAtStop.lease, true); }
    else { assert.equal(after.file, before.file); assert.equal(after.logs, before.logs); }
    console.log(JSON.stringify({ mode: issued ? 'issued-dm' : 'held-unread', realGuard, heldAtStop, requestsAtStop: before.requests,
        successorRequests: requests.slice(before.requests), fileChangedAfterStop: after.file !== before.file,
        changedAfterDrain: after.file !== atDrain.file || after.requests !== atDrain.requests || after.logs !== atDrain.logs,
        lateLogs: logs.slice(before.logs), finalState: after.file === null ? null : JSON.parse(after.file) }, null, 2));
} finally {
    release(); await app?.stop(); for (let i = 0; i < 12; i++) await tick(); globalThis.fetch = previousFetch;
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-risk-owner-review-'));
    rmSync(root, { recursive: true, force: true });
}
