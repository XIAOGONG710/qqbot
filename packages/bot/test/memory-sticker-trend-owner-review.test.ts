import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, join } from 'node:path';
import { stickerShelf } from '../src/social/stickers.ts';
import { startApp } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';

test('App停止后归还借用货架原来源，外部发现不调用旧App账号或网络', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-sticker-trend-owner-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const oldFetch = globalThis.fetch; let sourceCalls = 0, requests = 0;
    let app: ReturnType<typeof startApp> | undefined;
    try {
        globalThis.fetch = async () => { requests++; return Response.json({ data: { list: [] } }); };
        for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `card-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const shelf = stickerShelf({ dir: join(dataDir, 'stickers'), log: () => {}, describe: async () => '', decide: async () => ({ keep: false, description: '', tags: [] }), trendDiscover: async () => { sourceCalls++; return []; } });
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'card-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], stickers: 'collect', biliStickers: true, bilibiliAccount: true,
            schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic' });
        app = startApp({ config, stickers: shelf, sensitive: { on: () => false, describe: () => '' }, log: () => {}, transport: { friendHistory: async () => [], sendPrivateText: async () => 900 }, pipeline: { generate: async () => '合成回应' } });
        await app.stop(); await shelf.discover();
        assert.equal(sourceCalls, 1); assert.equal(requests, 0, '借用货架不能继续保有停止App安装的网络来源');
    } finally {
        await app?.stop(); globalThis.fetch = oldFetch;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-sticker-trend-owner-')); rmSync(root, { recursive: true, force: true });
    }
});

test('多个借用来源逆序结束，后安装者不被覆盖且fallback不会复活已结束前任', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-sticker-trend-owner-')), calls: string[] = [];
    try {
        const shelf = stickerShelf({ dir: root, discoveryIntervalMs: 0, log: () => {}, describe: async () => '', decide: async () => ({ keep: false, description: '', tags: [] }),
            trendDiscover: async () => { calls.push('base'); return []; } });
        const a = shelf.setTrend!(previous => async () => { calls.push('a'); return previous ? previous() : []; }) as (() => void) | undefined;
        const b = shelf.setTrend!(previous => async () => { calls.push('b'); return previous ? previous() : []; }) as (() => void) | undefined;
        a?.(); await shelf.discover(); assert.deepEqual(calls, ['b', 'base']);
        calls.length = 0; b?.(); await shelf.discover(); assert.deepEqual(calls, ['base']);
    } finally {
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-sticker-trend-owner-')); rmSync(root, { recursive: true, force: true });
    }
});
