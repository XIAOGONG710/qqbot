import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { photoShelf, type FoodSource, type PhotoCandidate, type PhotoSource } from '../src/vision/photos.ts';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const candidate = (food: boolean, n = 1): PhotoCandidate => ({ kind: food ? 'food' : 'cat', title: `synthetic-${n}`, series: 'synthetic', imageUrl: `https://example.org/${n}`, pageUrl: 'https://example.org', width: 3000, height: 2000, license: 'CC0', artist: '' });

for (const food of [false, true]) for (const stage of ['search', 'download', 'judge'] as const) for (const reject of [false, true]) {
    test(`${food ? 'food' : '普通'}发现在${stage}等待中停止，晚${reject ? 'reject' : '返回'}不继续调用或写入`, { timeout: 5000 }, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-stop-')); dirs.push(dir);
        const stop = new AbortController(); const ready = deferred(); const release = deferred(); const calls = { search: 0, download: 0, judge: 0 }; const logs: string[] = [];
        const wait = async (at: typeof stage) => { calls[at]++; if (stage === at) { ready.resolve(); await release.promise; if (reject) throw new Error('PRIVATE_LATE_PROVIDER_ERROR'); } };
        const provider = {
            search: async (kind: string) => { await wait('search'); return food || kind === 'cat' ? [candidate(food)] : []; },
            download: async () => { await wait('download'); return { bytes: new Uint8Array(130 * 1024).fill(1), type: 'image/jpeg' as const }; },
            judge: async () => { await wait('judge'); return { keep: true, caption: '合成照片' }; },
        } satisfies PhotoSource & FoodSource;
        const shelf = photoShelf({ dir, signal: stop.signal, log: line => logs.push(line), source: provider, foodSource: provider, pauseMs: 0 });
        const pending = food ? shelf.discoverFood(['合成菜甲', '合成菜乙']) : shelf.discover();
        try { await ready.promise; stop.abort(); } finally { release.resolve(); }
        assert.equal(await pending, 'done');
        assert.equal(calls.search, 1); assert.equal(calls.download, stage === 'search' ? 0 : 1); assert.equal(calls.judge, stage === 'judge' ? 1 : 0);
        assert.equal(existsSync(join(dir, 'index.json')), false); assert.equal(shelf.list().length, 0);
        assert.ok(logs.every(line => !line.includes('PRIVATE_LATE_PROVIDER_ERROR')));
    });
}

test('预先停止不启动来源；下载间隔等待中停止不开始下一张或下一道菜', { timeout: 5000 }, async () => {
    for (const food of [false, true]) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-stop-pause-')); dirs.push(dir); const stop = new AbortController(); const added = deferred();
        let searched = 0; let downloaded = 0;
        const provider = { search: async (kind: string) => { searched++; return food || kind === 'cat' ? [candidate(food, 1), candidate(food, 2)] : []; },
            download: async () => ({ bytes: new Uint8Array(130 * 1024).fill(++downloaded), type: 'image/jpeg' as const }), judge: async () => ({ keep: true, caption: '合成照片' }) } satisfies PhotoSource & FoodSource;
        const shelf = photoShelf({ dir, signal: stop.signal, source: provider, foodSource: provider, pauseMs: 30, log: line => { if (line.includes('收了一张')) added.resolve(); } });
        const pending = food ? shelf.discoverFood(['合成菜甲', '合成菜乙']) : shelf.discover(); await added.promise;
        const before = readFileSync(join(dir, 'index.json'), 'utf8'); stop.abort(); assert.equal(await pending, 'done');
        assert.equal(searched, 1); assert.equal(downloaded, 1); assert.equal(readFileSync(join(dir, 'index.json'), 'utf8'), before);
        assert.equal(await shelf.discover(), 'done'); assert.equal(await shelf.discoverFood(['合成菜乙']), 'done'); assert.equal(searched, 1);
    }
});

test('收图日志同步停止后不再进入下一种类或下一道菜的来源', async () => {
    for (const food of [false, true]) {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-photo-stop-log-')); dirs.push(dir); const stop = new AbortController(); let searched = 0;
        const provider = { search: async () => { searched++; return [candidate(food)]; },
            download: async () => ({ bytes: new Uint8Array(130 * 1024).fill(1), type: 'image/jpeg' as const }), judge: async () => ({ keep: true, caption: '合成照片' }) } satisfies PhotoSource & FoodSource;
        const shelf = photoShelf({ dir, signal: stop.signal, source: provider, foodSource: provider, pauseMs: 0,
            log: line => { if (line.includes('收了一张')) stop.abort(); } });
        assert.equal(await (food ? shelf.discoverFood(['合成菜甲', '合成菜乙']) : shelf.discover()), 'done');
        assert.equal(searched, 1); assert.equal(shelf.list().length, 1);
    }
});
