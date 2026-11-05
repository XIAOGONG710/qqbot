import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import type { BiliRequest } from '../src/bilibili/bilibili-account.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 20; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成风险检查点超时'); await tick(); } }
const login = { code: 0, data: { isLogin: true, uname: '合成账号', mid: 123, wbi_img: { img_url: `https://synthetic.invalid/${'a'.repeat(32)}.png`, sub_url: `https://synthetic.invalid/${'b'.repeat(32)}.png` } } };
async function fixture(stage: 'account' | 'unread' | 'notices' | 'dm' | 'none', fail = false, realGuard = false) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-risk-review-')), dataDir = join(root, 'data');
    mkdirSync(join(dataDir, 'secrets'), { recursive: true });
    const previousFetch = globalThis.fetch, requests: string[] = [], logs: string[] = [];
    let app: App | undefined, entered = false, release!: () => void;
    const held = new Promise<void>(done => { release = done; });
    for (const tier of ['stranger', 'classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    writeFileSync(join(dataDir, 'secrets', 'bilibili.json'), JSON.stringify({ sessdata: 'SYNTHETIC_SESSION', biliJct: 'SYNTHETIC_CSRF', dedeUserId: '123', buvid3: 'SYNTHETIC_DEVICE', savedAt: '2026-11-05T00:00:00Z' }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], bilibiliAccount: true, bilibiliReplies: 'dryRun', bilibiliAtUid: 456,
        jokes: false, idioms: false, memes: false, watching: false, biliFeed: 'off', schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    const request: BiliRequest = async raw => {
        const url = new URL(raw); requests.push(url.pathname); let name: string, body: object;
        if (url.pathname.endsWith('/nav')) { name = 'account'; body = login; }
        else if (url.pathname.endsWith('/reply')) { name = 'reply'; body = { code: 0, data: { items: [] } }; }
        else if (url.pathname.endsWith('/unread')) { name = 'unread'; body = { code: 0, data: { sys_msg: 1 } }; }
        else if (url.pathname.endsWith('/query_unified_notify')) { name = 'notices'; body = { code: 0, data: { system_notify_list: [{ id: '123456', title: '合成账号警告', content: '合成风险事件', time_at: '2026-11-05 12:00:00' }] } }; }
        else if (url.pathname.endsWith('/send_msg')) { name = 'dm'; body = { code: 0, data: {} }; }
        else throw new Error(`unexpected synthetic route ${url.pathname}`);
        if (name === stage) { entered = true; await held; if (fail) throw new Error('SYNTHETIC_LATE_RISK_FAILURE'); }
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
    };
    globalThis.fetch = realGuard ? async input => { const response = await request(String(input), { headers: {}, signal: new AbortController().signal }); return new Response(await response.text(), { status: response.status }); } : async () => { throw new Error('unexpected synthetic network'); };
    const cleanup = async () => { release(); await app?.stop(); await settle(); globalThis.fetch = previousFetch; assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-risk-review-')); rmSync(root, { recursive: true, force: true }); };
    try {
        app = startApp({ config, sensitive: { on: () => false, describe: () => '' }, log: line => logs.push(line), transport: { friendHistory: async () => [], sendPrivateText: async () => 900 },
            pipeline: { now: () => new Date(2026, 10, 5, 16).getTime(), generate: async () => { throw new Error('no synthetic compose expected'); } }, ...(!realGuard ? { bilibiliRequest: request } : {}) });
        await app.connected(20000); if (stage !== 'none') await until(() => entered);
    } catch (error) { await cleanup(); throw error; }
    return { app, dataDir, file: join(dataDir, 'presence', 'bilibili-risk.json'), logs, requests, release, cleanup };
}

for (const stage of ['account', 'unread', 'notices'] as const) test(`真实App风险${stage}纯读取stop后不派后继/私信或落状态日志`, async () => {
    const f = await fixture(stage);
    try {
        await f.app.stop(); const requests = [...f.requests], logs = [...f.logs]; assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        f.release(); await settle(); assert.deepEqual(f.requests, requests); assert.deepEqual(f.logs, logs); assert.equal(existsSync(f.file), false);
    } finally { await f.cleanup(); }
});

for (const fail of [false, true]) test(`真实App已派风险DM${fail ? '失败' : '成功'}ACK在租约内收尾且不再派请求`, async () => {
    const f = await fixture('dm', fail);
    try {
        const stopping = f.app.stop(); await tick(); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true);
        const requests = [...f.requests], before = readFileSync(f.file, 'utf8'); f.release(); await stopping; await settle();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.deepEqual(f.requests, requests); assert.equal(readFileSync(f.file, 'utf8'), before);
        assert.ok(f.logs.some(line => line.includes(fail ? '私信提醒也没发出去' : '已私信提醒他')));
    } finally { await f.cleanup(); }
});

test('真实guard的held unread停止后仅等待已派运输收尾，不因晚结果续派新通知或DM', async () => {
    const f = await fixture('unread', false, true);
    try {
        const requests = [...f.requests], logs = [...f.logs], stopping = f.app.stop(); await tick();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true); f.release(); await stopping; await settle();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false); assert.deepEqual(f.requests, requests); assert.deepEqual(f.logs, logs); assert.equal(existsSync(f.file), false);
    } finally { await f.cleanup(); }
});

test('正常风险提醒已确认事实在停止后保留且只派一次DM', async () => {
    const f = await fixture('none');
    try {
        await until(() => f.logs.some(line => line.includes('已私信提醒他'))); const body = readFileSync(f.file, 'utf8');
        await f.app.stop(); assert.equal(readFileSync(f.file, 'utf8'), body); assert.equal(f.requests.filter(path => path.endsWith('/send_msg')).length, 1);
    } finally { await f.cleanup(); }
});
