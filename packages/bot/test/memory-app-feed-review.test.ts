import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
async function until(check: () => boolean) { const deadline = Date.now() + 3000; while (!check()) { assert.ok(Date.now() < deadline, '合成等待超时'); await new Promise(done => setTimeout(done, 5)); } }
type Stage = 'nav-fetch' | 'nav-body' | 'recommend-fetch' | 'recommend-body' | 'none';
const nav = JSON.stringify({ code: 0, data: { wbi_img: { img_url: `https://synthetic.invalid/${'a'.repeat(32)}.png`, sub_url: `https://synthetic.invalid/${'b'.repeat(32)}.png` } } });
const recommendation = JSON.stringify({ code: 0, data: { item: [{ bvid: 'BV1abcdefghj', title: '合成猫咪', owner: { name: '合成作者' }, tname: '喵星人', duration: 120, stat: { view: 500 } }] } });

async function fixture(stage: Stage, mode: 'on' | 'dryRun') {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-feed-review-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const previousFetch = globalThis.fetch, logs: string[] = [], requests: string[] = [];
    let app: App | undefined, release!: () => void, entered = false;
    const held = new Promise<void>(done => { release = done; });
    for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
    const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
        contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], biliFeed: mode, jokes: false, idioms: false,
        schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
    globalThis.fetch = async () => { throw new Error('unexpected synthetic network request'); };
    const cleanup = async () => {
        release(); await app?.stop(); await settle(); globalThis.fetch = previousFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-feed-review-')); rmSync(root, { recursive: true, force: true });
    };
    try {
        app = startApp({ config, sensitive: { on: () => false, describe: () => '' }, log: line => logs.push(line), transport: { friendHistory: async () => [], sendPrivateText: async () => 900 },
            pipeline: { now: () => new Date(2026, 10, 5, 16).getTime(), generate: async () => '合成回应' },
            bilibiliFetch: async url => {
                const parsed = new URL(url); assert.equal(parsed.origin, 'https://api.bilibili.com');
                const name = parsed.pathname.endsWith('/nav') ? 'nav' : 'recommend'; requests.push(name);
                if (stage === `${name}-fetch`) { entered = true; await held; }
                return { ok: true, status: 200, text: async () => { if (stage === `${name}-body`) { entered = true; await held; } return name === 'nav' ? nav : recommendation; } };
            },
        });
        await app.connected(20000); if (stage !== 'none') await until(() => entered);
    } catch (error) { await cleanup(); throw error; }
    return { root, dataDir, file: join(dataDir, 'watching', 'feed.json'), draft: join(dataDir, 'presence', 'drafts.md'), app, logs, requests, release, cleanup };
}

for (const [stage, mode] of [['nav-fetch', 'on'], ['nav-body', 'on'], ['recommend-fetch', 'on'], ['recommend-body', 'on'], ['recommend-body', 'dryRun']] as const) {
    test(`真实App.stop取消推荐流${stage}/${mode}，晚结果不写文件/草稿/日志或派后继请求`, async () => {
        const f = await fixture(stage, mode);
        try {
            await f.app.stop(); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
            const logs = [...f.logs], count = f.requests.length; f.release(); await settle();
            assert.equal(existsSync(f.file), false); assert.equal(existsSync(f.draft), false); assert.deepEqual(f.logs, logs);
            assert.equal(f.requests.length, count, '已取消nav结果不能在旧链里继续派推荐请求');
        } finally { await f.cleanup(); }
    });
}

for (const mode of ['on', 'dryRun'] as const) test(`推荐流${mode}已确认同步事实在正常停止后保留`, async () => {
    const f = await fixture('none', mode);
    try {
        const target = mode === 'on' ? f.file : f.draft; await until(() => existsSync(target)); const bytes = readFileSync(target, 'utf8');
        assert.ok(bytes.includes('合成猫咪')); await f.app.stop(); assert.equal(readFileSync(target, 'utf8'), bytes);
        assert.equal(f.requests.length, 2); assert.equal(existsSync(join(f.dataDir, 'bot.lock')), false);
    } finally { await f.cleanup(); }
});
