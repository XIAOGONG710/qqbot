import assert from 'node:assert/strict';
import { test } from 'node:test';
import { biliStickerDiscover } from '../src/language/bili-stickers.ts';
import type { BiliAccount } from '../src/bilibili/bilibili-account.ts';
import { bqbDiscover } from '../src/social/sticker-sources.ts';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve, join } from 'node:path';

const tick = () => new Promise<void>(done => setImmediate(done));
for (const phase of ['account', 'packages', 'popular-fetch', 'popular-body', 'comment-body', 'fallback'] as const) test(`B站表情来源${phase}取消后不续派/更新旧缓存或晚日志`, async () => {
    const controller = new AbortController(), calls: string[] = [], logs: string[] = [];
    let entered = false, release!: () => void, hold = true;
    const held = new Promise<void>(done => { release = done; });
    const pause = async (at: typeof phase) => { if (hold && at === phase) { entered = true; await held; } };
    const source = biliStickerDiscover({ now: () => new Date('2026-11-05T12:00:00Z'), log: line => logs.push(line),
        account: async () => { calls.push('account'); await pause('account'); return { emotePackages: async () => { calls.push('packages'); await pause('packages'); return []; } } as unknown as BiliAccount; },
        fetch: async url => {
            calls.push(url.includes('popular') ? 'popular-fetch' : 'comment-fetch');
            if (url.includes('popular')) await pause('popular-fetch');
            return { ok: true, status: 200, json: async () => {
                calls.push(url.includes('popular') ? 'popular-body' : 'comment-body');
                await pause(url.includes('popular') ? 'popular-body' : 'comment-body');
                return url.includes('popular') ? { data: { list: phase === 'comment-body' ? [{ aid: 1 }] : [] } } : { data: { replies: [] } };
            } };
        },
    }, async () => { calls.push('fallback'); await pause('fallback'); return ['https://synthetic.invalid/sticker.png']; }) as (signal?: AbortSignal) => Promise<string[]>;
    const result = source(controller.signal).then(value => ({ value }), error => ({ error }));
    for (let n = 0; n < 50 && !entered; n++) await tick(); assert.ok(entered);
    const before = [...calls], beforeLogs = [...logs]; controller.abort(); release();
    const settled = await result;
    assert.ok('error' in settled, '取消不能继续提供旧候选');
    assert.deepEqual(calls, before); assert.deepEqual(logs, beforeLogs);
    // Aborted work cannot poison a reusable source cache for a later owner.
    hold = false; calls.length = 0; await source(new AbortController().signal);
    if (phase === 'account' || phase === 'packages') assert.ok(calls.includes('packages'), '未完成旧刷新不能被追认为缓存完成');
});

test('B站表情来源预先取消不派任何读取', async () => {
    const controller = new AbortController(); controller.abort(); let calls = 0;
    const source = biliStickerDiscover({ now: () => new Date(), log: () => {}, account: async () => { calls++; return undefined; }, fetch: async () => { calls++; return { ok: true, status: 200, json: async () => ({}) }; } }) as (signal?: AbortSignal) => Promise<string[]>;
    await assert.rejects(source(controller.signal)); assert.equal(calls, 0);
});

for (const fail of [false, true]) test(`公开目录取消后晚${fail ? '失败' : '成功'}不写缓存或日志，可由新调用重新读取`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-sticker-source-owner-')), controller = new AbortController(), logs: string[] = [];
    let entered = false, release!: () => void, first = true;
    const held = new Promise<void>(done => { release = done; });
    const source = bqbDiscover({ dir: root, allow: ['合成猫'], log: line => logs.push(line), fetchJson: async () => {
        if (first) { entered = true; await held; if (fail) throw new Error('synthetic late failure'); }
        return [{ categoryTitle: '合成猫', src: 'media/synthetic.png', bytes: 100, width: 80, height: 80 }];
    } }) as (signal?: AbortSignal) => Promise<string[]>;
    try {
        const task = source(controller.signal).then(value => ({ value }), error => ({ error }));
        for (let i = 0; i < 50 && !entered; i++) await tick(); assert.ok(entered);
        controller.abort(); release(); const result = await task;
        assert.ok('error' in result); assert.equal(existsSync(join(root, 'bqb-catalog.json')), false); assert.deepEqual(logs, []);
        first = false; assert.equal((await source(new AbortController().signal)).length, 1); assert.ok(existsSync(join(root, 'bqb-catalog.json')));
    } finally {
        release(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-sticker-source-owner-')); rmSync(root, { recursive: true, force: true });
    }
});
