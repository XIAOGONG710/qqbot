import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 16; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成热梗等待超时'); await new Promise(done => setTimeout(done, 5)); } }
type Stage = 'account' | 'lists-body' | 'candidate-model' | 'gather-search' | 'explain-model' | 'none';
const term = '霓虹团子饼';
const login = { code: 0, data: { isLogin: true, uname: '合成账号', mid: 123, wbi_img: { img_url: `https://synthetic.invalid/${'a'.repeat(32)}.png`, sub_url: `https://synthetic.invalid/${'b'.repeat(32)}.png` } } };
const explanation = JSON.stringify({ 是梗: true, 意思: '表示遇到有趣小事时的合成玩笑', 例句: '这波霓虹团子饼', 把握: '高', 适合聊天: true });

async function fixture(stage: Stage, failModel = false, corruptLibrary = false) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-memes-review-')), dataDir = join(root, 'data'); mkdirSync(join(dataDir, 'secrets'), { recursive: true });
    const previousFetch = globalThis.fetch, previousTimeout = globalThis.setTimeout, requests: string[] = [], logs: string[] = [];
    let app: App | undefined, release!: () => void, entered = false, modelCalls = 0, grantedLog: ((line: string) => void) | undefined;
    const held = new Promise<void>(done => { release = done; });
    if (corruptLibrary) { mkdirSync(join(dataDir, 'memes')); writeFileSync(join(dataDir, 'memes', 'memes.json'), '{synthetic-invalid'); }
    for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    writeFileSync(join(dataDir, 'secrets', 'bilibili.json'), JSON.stringify({ sessdata: 'SYNTHETIC_SESSION', biliJct: 'SYNTHETIC_CSRF', dedeUserId: '123', buvid3: 'SYNTHETIC_DEVICE', savedAt: '2026-11-05T00:00:00Z' }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], memes: true, bilibiliAccount: true, timeline: true,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => previousTimeout(callback, ms === 1000 ? 0 : ms, ...args)) as typeof setTimeout;
    globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        assert.ok(['api.bilibili.com', 's.search.bilibili.com', 'weibo.com', 'top.baidu.com', 'synthetic.invalid'].includes(url.hostname), '所有请求必须在合成路由内');
        assert.notEqual(init?.method, 'POST', '热梗采集没有远端mutation'); requests.push(url.pathname);
        if (url.pathname.endsWith('/nav')) { if (stage === 'account') { entered = true; await held; } return Response.json(login); }
        if (url.pathname.endsWith('/popular')) {
            const body = { code: 0, data: { list: [{ title: `${term}是什么梗`, tname: '日常' }] } };
            if (stage === 'lists-body' && url.searchParams.get('pn') === '1') {
                const response = Response.json({}); Object.defineProperty(response, 'json', { value: async () => { entered = true; await held; return body; } }); return response;
            }
            return Response.json(body);
        }
        if (url.pathname.includes('hotword') || url.hostname === 'weibo.com' || url.hostname === 'top.baidu.com') return Response.json({});
        if (url.pathname.endsWith('/search/type')) {
            if (stage === 'gather-search') { entered = true; await held; }
            return Response.json({ code: 0, data: { result: [{ bvid: 'BV1abcdefghj', aid: 1, title: `${term}是什么梗`, description: '合成词说明', author: '合成作者', typename: '日常', play: 500, like: 50, duration: '03:00' }] } });
        }
        if (url.pathname.endsWith('/web-interface/view')) return Response.json({ code: 0, data: { cid: 1 } });
        if (url.pathname.includes('/player/')) return Response.json({ code: 0, data: { subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://synthetic.invalid/subtitle' }] } } });
        if (url.hostname === 'synthetic.invalid' && url.pathname === '/subtitle') return Response.json({ body: [{ content: '这是表示遇到有趣小事时的合成玩笑' }] });
        if (url.pathname.includes('/reply/')) return Response.json({ code: 0, data: { replies: [] } });
        assert.fail(`Unexpected synthetic endpoint ${url.pathname}`);
    };
    const make = () => startApp({ config, sensitive: { on: () => false, describe: () => '' }, log: line => logs.push(line), transport: { friendHistory: async () => [], sendPrivateText: async () => 900 },
        pipeline: { now: () => new Date(2026, 10, 5, 16).getTime(), generate: async (messages, log) => {
            const candidate = messages[0]?.content.includes('下面是今天几个榜单上的标题');
            assert.ok(candidate || messages[0]?.content.includes('判断这是不是一个网络梗'), '无普通聊天模型调用'); modelCalls++;
            if ((stage === 'candidate-model' && candidate) || (stage === 'explain-model' && !candidate)) { grantedLog = log; entered = true; await held; if (failModel) throw new Error('SYNTHETIC_LATE_MEME_MODEL_ERROR'); }
            return candidate ? JSON.stringify({ 词: term, 来源: '合成榜' }) : explanation;
        } } });
    const cleanup = async () => {
        release(); await app?.stop(); await new Promise(done => previousTimeout(done, 30)); await settle(); globalThis.fetch = previousFetch; globalThis.setTimeout = previousTimeout;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-memes-review-')); rmSync(root, { recursive: true, force: true });
    };
    try { app = make(); await app.connected(20000); if (stage !== 'none') await until(() => entered); }
    catch (error) { await cleanup(); throw error; }
    const timelinePath = join(dataDir, 'timeline.jsonl');
    return { root, dataDir, file: join(dataDir, 'memes', 'memes.json'), requests, logs, release, grantedLog: () => grantedLog, modelCalls: () => modelCalls,
        stop: () => app!.stop(), timeline: () => existsSync(timelinePath) ? readFileSync(timelinePath, 'utf8') : '',
        async restart() { await app!.stop(); app = make(); await app.connected(20000); await settle(); }, cleanup,
    };
}

for (const stage of ['account', 'lists-body', 'candidate-model', 'gather-search', 'explain-model'] as const) test(`真实App热梗${stage}停止后无新请求/模型/写入/日志`, async () => {
    const f = await fixture(stage);
    try {
        const stopping = f.stop(); const requests = [...f.requests], modelCalls = f.modelCalls(), logs = [...f.logs], timeline = f.timeline();
        // Real account guards own durable breaker observations. Let their held
        // GET settle while stop drains; pure reads must not start successors.
        if (stage === 'account' || stage === 'gather-search') assert.equal(existsSync(join(f.dataDir, 'bot.lock')), true);
        f.release(); await stopping; await new Promise(done => setTimeout(done, 30)); await settle();
        assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
        assert.deepEqual(f.requests, requests, '停止后旧账号/榜单/模型/证据链不能再派后继请求'); assert.equal(f.modelCalls(), modelCalls);
        assert.equal(existsSync(f.file), false); assert.deepEqual(f.logs, logs); assert.equal(f.timeline(), timeline);
    } finally { await f.cleanup(); }
});

test('热梗晚模型失败与授出logger不在停止后复活日志', async () => {
    const f = await fixture('candidate-model', true);
    try {
        await f.stop(); const logs = [...f.logs]; f.grantedLog()!('SYNTHETIC_LATE_MEME_LOG'); f.release(); await settle();
        assert.deepEqual(f.logs, logs); assert.equal(existsSync(f.file), false);
    } finally { await f.cleanup(); }
});

test('热梗已确认成功事实跨停止重启保留，12小时内不重抓或重问模型', async () => {
    const f = await fixture('none');
    try {
        await until(() => existsSync(f.file)); const bytes = readFileSync(f.file, 'utf8'); assert.ok(bytes.includes(term));
        const requests = f.requests.length, models = f.modelCalls(); await f.stop(); await f.restart();
        assert.equal(readFileSync(f.file, 'utf8'), bytes); assert.equal(f.requests.length, requests); assert.equal(f.modelCalls(), models);
    } finally { await f.cleanup(); }
});

test('热梗坏库跳过后台刷新并保原，不让严格读取异常逃出App连接入口', async () => {
    const f = await fixture('none', false, true);
    try {
        await settle(); assert.equal(f.modelCalls(), 0);
        assert.equal(readFileSync(f.file, 'utf8'), '{synthetic-invalid');
        assert.ok(f.logs.some(line => line.includes('热梗')));
    } finally { await f.cleanup(); }
});
