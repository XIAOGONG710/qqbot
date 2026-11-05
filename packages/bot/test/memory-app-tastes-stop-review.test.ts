import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp, type App } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function until(check: () => boolean) { const end = Date.now() + 3000; while (!check()) { if (Date.now() > end) assert.fail('合成等待超时'); await tick(); } }
for (const failure of [false, true]) test(`真实App.stop取消口味反思，旧模型${failure ? '失败' : '成功'}和授予log不晚写，旧timer不再派发`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-tastes-stop-')), dataDir = join(root, 'data'); mkdirSync(join(dataDir, 'watching'), { recursive: true });
    const oldFetch = globalThis.fetch, oldTimeout = globalThis.setTimeout; let app: App | undefined, first: (() => void) | undefined;
    let release!: (value: string) => void, reject!: (error: Error) => void, calls = 0, modelLog: ((line: string) => void) | undefined;
    const held = new Promise<string>((done, fail) => { release = done; reject = fail; }), logs: string[] = [];
    const tastesPath = join(dataDir, 'tastes.json'), timelinePath = join(dataDir, 'timeline.jsonl'), originalState = JSON.stringify({ version: 1, tastes: [] });
    writeFileSync(tastesPath, originalState);
    writeFileSync(join(dataDir, 'watching', 'watched.json'), JSON.stringify({ version: 1, entries: Array.from({ length: 6 }, (_, i) => ({ bvid: `BVsynthetic${i}`, title: `合成摄影经历${i}`, owner: '合成作者', tname: '合成分区', excerpt: '合成公开视频记录', hot: [], day: '2026-11-08' })) }));
    try {
        for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], tastes: true, timeline: true,
            schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async () => { assert.fail('Network prohibited in synthetic tastes-stop fixture'); };
        globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
            if (ms === 120_000) first = () => callback(...args);
            return oldTimeout(callback, ms, ...args);
        }) as typeof setTimeout;
        app = startApp({ config, log: line => logs.push(line), sensitive: { on: () => false, describe: () => '' }, transport: { friendHistory: async () => [], sendPrivateText: async () => 99 },
            pipeline: { now: () => Date.parse('2026-11-09T12:00:00+08:00'), generate: async (messages, log) => {
                assert.ok(messages[0]?.content.includes('看得出来的偏好')); calls++; modelLog = log; return held;
            } } });
        assert.ok(first); first(); await until(() => calls === 1); await app.stop(); assert.equal(existsSync(join(dataDir, 'bot.lock')), false);
        const before = [...logs], timeline = existsSync(timelinePath) ? readFileSync(timelinePath, 'utf8') : ''; assert.ok(modelLog);
        modelLog('SYNTHETIC_LATE_TASTES_MODEL_LOG');
        if (failure) reject(new Error('SYNTHETIC_LATE_TASTES_FAILURE'));
        else release(JSON.stringify([{ name: '合成摄影', stance: 'like', strength: 2, why: '多次合成经历', refs: ['BVsynthetic0', 'BVsynthetic1'] }]));
        await tick(); await tick();
        assert.equal(readFileSync(tastesPath, 'utf8'), originalState, '已释放租约的旧反思不能写口味及lastReflectAt');
        assert.equal(existsSync(timelinePath) ? readFileSync(timelinePath, 'utf8') : '', timeline, '旧onChange不能写新时间线');
        assert.deepEqual(logs, before, '旧模型授予log及反思失败/成功诊断均停止');
        first(); await tick(); await tick(); assert.equal(calls, 1, '已取消timer的迟到回调也不能再派模型');
    } finally {
        release?.('[]'); await app?.stop(); await tick(); await tick(); globalThis.fetch = oldFetch; globalThis.setTimeout = oldTimeout;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-tastes-stop-')); rmSync(root, { recursive: true, force: true });
    }
});
