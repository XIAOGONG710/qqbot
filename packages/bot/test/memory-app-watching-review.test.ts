import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import type { BiliResponse } from '../src/bilibili/bilibili-account.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < end, '合成观看等待超时'); await new Promise(done => setTimeout(done, 5)); } }
const response = (data: unknown): BiliResponse => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });
const login = { code: 0, data: { isLogin: true, uname: '合成账号', mid: 123, wbi_img: { img_url: 'https://synthetic.invalid/01234567890123456789012345678901.png', sub_url: 'https://synthetic.invalid/12345678901234567890123456789012.png' } } };

for (const stage of ['account', 'subtitle'] as const) test(`真实App停止取消held观看${stage}，晚结果不后继请求/落盘/日志`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-watch-stop-')), dataDir = join(root, 'data'); mkdirSync(join(dataDir, 'secrets'), { recursive: true });
    const oldFetch = globalThis.fetch, oldTimeout = globalThis.setTimeout, logs: string[] = [], requests: string[] = [];
    let app: App | undefined, entered = false, release!: (value: BiliResponse) => void;
    const held = new Promise<BiliResponse>(done => { release = done; });
    try {
        for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        writeFileSync(join(dataDir, 'secrets', 'bilibili.json'), JSON.stringify({ sessdata: 'SYNTHETIC_SESSION', biliJct: 'SYNTHETIC_CSRF', dedeUserId: '123', buvid3: 'SYNTHETIC_DEVICE', savedAt: '2026-11-05T00:00:00Z' }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], bilibiliAccount: true, watching: true, timeline: true,
            schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async () => { assert.fail('Network prohibited in synthetic watch App fixture'); };
        globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => oldTimeout(callback, ms === 800 ? 0 : ms, ...args)) as typeof setTimeout;
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' }, transport: { friendHistory: async () => [], sendPrivateText: async () => 1 },
            pipeline: { now: () => Date.parse('2026-11-05T20:00:00+08:00'), generate: async () => { assert.fail('No chat model in watch fixture'); } },
            bilibiliRequest: async (url, init) => {
                assert.notEqual(init.method, 'POST', '观看只读不得触发mutation'); requests.push(url);
                if (url.includes('/nav')) { if (stage === 'account') { entered = true; return held; } return response(login); }
                if (url.includes('/search/type')) return response({ code: 0, data: { result: [{ bvid: 'BV1abcdefghj', aid: 1, title: '合成摄影', description: '合成', author: '合成作者', typename: '摄影摄像', play: 1000, like: 50, duration: '03:00' }] } });
                if (url.includes('/web-interface/view')) return response({ code: 0, data: { cid: 1 } });
                if (url.includes('/player/')) return response({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://synthetic.invalid/subtitle' }] } } });
                if (url === 'https://synthetic.invalid/subtitle') { entered = true; return held; }
                assert.fail(`Unexpected fake account endpoint ${new URL(url).pathname}`);
            },
            bilibiliFetch: async url => { requests.push(url); return response({ code: 0, data: { replies: [] } }); },
        });
        await app.connected(20000); await until(() => entered); await app.stop(); assert.equal(existsSync(join(dataDir, 'bot.lock')), false);
        const beforeLogs = [...logs], beforeRequests = [...requests], timelinePath = join(dataDir, 'timeline.jsonl');
        const timeline = existsSync(timelinePath) ? readFileSync(timelinePath, 'utf8') : '';
        release(response(stage === 'account' ? login : { body: [{ content: '合成摄影字幕' }] }));
        await new Promise(done => oldTimeout(done, 30)); await tick();
        assert.equal(existsSync(join(dataDir, 'watching', 'watched.json')), false);
        assert.deepEqual(requests, beforeRequests, '停止后不能从旧read继续搜索/热评等后继'); assert.deepEqual(logs, beforeLogs);
        assert.equal(existsSync(timelinePath) ? readFileSync(timelinePath, 'utf8') : '', timeline, 'subtitle装饰器不能在旧read晚完成时写timeline');
    } finally {
        release?.(response(stage === 'account' ? login : { body: [{ content: '合成清理' }] })); await app?.stop(); await new Promise(done => oldTimeout(done, 30));
        globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimeout;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-watch-stop-')); rmSync(root, { recursive: true, force: true });
    }
});

for (const stage of ['status', 'body'] as const) test(`生产guard分支held风险${stage}必须持锁记录真实breaker后再停`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-watch-stop-')), dataDir = join(root, 'data'); mkdirSync(join(dataDir, 'secrets'), { recursive: true });
    const oldFetch = globalThis.fetch; let app: App | undefined, entered = false, releaseFetch!: (value: Response) => void, releaseBody!: (value: string) => void;
    const heldFetch = new Promise<Response>(done => { releaseFetch = done; }), heldBody = new Promise<string>(done => { releaseBody = done; });
    try {
        for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        writeFileSync(join(dataDir, 'secrets', 'bilibili.json'), JSON.stringify({ sessdata: 'SYNTHETIC_SESSION', biliJct: 'SYNTHETIC_CSRF', dedeUserId: '123', buvid3: 'SYNTHETIC_DEVICE', savedAt: '2026-11-05T00:00:00Z' }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], bilibiliAccount: true, watching: true,
            schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async input => {
            assert.ok(String(input).startsWith('https://api.bilibili.com/x/web-interface/nav'));
            if (stage === 'status') { entered = true; return heldFetch; }
            const response = Response.json({}); Object.defineProperty(response, 'text', { value: async () => { entered = true; return heldBody; } }); return response;
        };
        app = startApp({ config, log() {}, sensitive: { on: () => false, describe: () => '' }, transport: { friendHistory: async () => [], sendPrivateText: async () => 1 },
            pipeline: { now: () => Date.parse('2026-11-05T20:00:00+08:00'), generate: async () => { assert.fail('No chat model'); } } });
        await app.connected(20000); await until(() => entered); const drain = app.stop();
        await tick(); const heldLease = existsSync(join(dataDir, 'bot.lock'));
        if (stage === 'status') releaseFetch(new Response('', { status: 429 })); else releaseBody(JSON.stringify({ code: -352 }));
        await drain; await tick(); await tick(); const breaker = JSON.parse(readFileSync(join(dataDir, 'platforms', 'bilibili', 'breaker.json'), 'utf8'));
        assert.deepEqual({ heldLease, actualRiskCode: breaker.code, releasedAfter: !existsSync(join(dataDir, 'bot.lock')) },
            { heldLease: true, actualRiskCode: stage === 'status' ? 429 : -352, releasedAfter: true });
    } finally {
        releaseFetch(new Response('', { status: 429 })); releaseBody(JSON.stringify({ code: -352 })); await app?.stop(); await tick(); await tick(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-watch-stop-')); rmSync(root, { recursive: true, force: true });
    }
});
