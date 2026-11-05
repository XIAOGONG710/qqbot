import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { loadWatched, saveWatched, watchOne, type WatchDeps } from '../src/language/watching.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { openAccount, type BiliResponse } from '../src/bilibili/bilibili-account.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-watch-owner-')), path = join(root, 'watched.json'), logs: string[] = [], calls: string[] = [], controller = new AbortController();
    const video = { bvid: 'BV1abcdefghj', aid: 1, cid: 2, title: '合成摄影', desc: '合成', owner: '合成作者', category: '摄影摄像', duration: 60, views: 1000, likes: 50, link: 'https://synthetic.invalid/video' };
    saveWatched(path, { version: 1, entries: [{ bvid: 'BVsyntheticold', title: '合成旧记录', owner: '合成作者', tname: '日常', excerpt: '合成已确认字幕', hot: [], day: '2026-11-04' }] });
    const results = { search: [video], sleep: undefined, subtitle: { status: 'ok' as const, lan: 'zh', lines: ['合成摄影字幕'] }, hotComments: ['合成热评'], view: { cid: 2, chapters: [] }, danmaku: [], storyboard: ['https://synthetic.invalid/image'], describeImage: '合成画面' };
    const deps: WatchDeps = { path, now: () => new Date('2026-11-05T20:00:00+08:00'), signal: controller.signal, log: line => logs.push(line),
        search: async () => { calls.push('search'); return results.search; }, sleep: async () => { calls.push('sleep'); }, subtitle: async () => { calls.push('subtitle'); return results.subtitle; },
        hotComments: async () => { calls.push('hotComments'); return results.hotComments; }, view: async () => { calls.push('view'); return results.view; },
        danmaku: async () => { calls.push('danmaku'); return results.danmaku; }, storyboard: async () => { calls.push('storyboard'); return results.storyboard; }, describeImage: async () => { calls.push('describeImage'); return results.describeImage; },
    };
    return { root, path, deps, results, calls, logs, controller, clean() { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-watch-owner-')); rmSync(root, { recursive: true, force: true }); } };
}
for (const stage of ['search', 'sleep', 'subtitle', 'hotComments', 'view', 'danmaku', 'storyboard', 'describeImage'] as const) test(`观看held ${stage}取消本地等待，晚成功无后继/落盘/日志`, async () => {
    const f = fixture(); let release!: (value: unknown) => void, entered = false, timer: ReturnType<typeof setTimeout> | undefined;
    const held = new Promise<unknown>(done => { release = done; });
    const deps = Object.assign({}, f.deps, { [stage]: () => { f.calls.push(stage); entered = true; return held; } }) as WatchDeps;
    const before = readFileSync(f.path, 'utf8'), task = watchOne(deps);
    try {
        for (let i = 0; i < 10 && !entered; i++) await tick(); assert.equal(entered, true); f.controller.abort();
        assert.equal(await Promise.race([task, new Promise<never>((_, error) => { timer = setTimeout(() => error(new Error('watch still waits for provider')), 1000); })]), 'cancelled');
        const calls = [...f.calls], logs = [...f.logs]; release(f.results[stage]); await tick(); await tick();
        assert.deepEqual(f.calls, calls); assert.deepEqual(f.logs, logs); assert.equal(readFileSync(f.path, 'utf8'), before);
    } finally { clearTimeout(timer); release(f.results[stage]); await task; f.clean(); }
});

test('取消后搜索晚失败不输出旧provider错误、不重试其它关键词', async () => {
    const f = fixture(); let reject!: (error: Error) => void;
    const held = new Promise<never>((_, fail) => { reject = fail; }), task = watchOne({ ...f.deps, search: () => held });
    try { await tick(); f.controller.abort(); assert.equal(await task, 'cancelled'); reject(new Error('SYNTHETIC_PRIVATE_SEARCH_FAILURE')); await tick(); assert.deepEqual(f.logs, []); assert.deepEqual(f.calls, []); }
    finally { reject(new Error('synthetic cleanup')); await task; f.clean(); }
});

test('已停止/now回调同步停止均不进入搜索，纯read provider同步停止无后继', async () => {
    const f = fixture();
    try {
        f.controller.abort(); assert.equal(await watchOne(f.deps), 'cancelled'); assert.deepEqual(f.calls, []);
        const next = new AbortController(); assert.equal(await watchOne({ ...f.deps, signal: next.signal, now: () => { next.abort(); return f.deps.now(); } }), 'cancelled'); assert.deepEqual(f.calls, []);
        const third = new AbortController(); assert.equal(await watchOne({ ...f.deps, signal: third.signal, search: async () => { third.abort(); return f.results.search; } }), 'cancelled'); assert.deepEqual(f.calls, []);
    } finally { f.clean(); }
});

test('已经同步确认的观看文件stop不回滚，新实例今天已看不再调服务', async () => {
    const f = fixture();
    try {
        assert.equal(await watchOne(f.deps), 'watched'); assert.equal(loadWatched(f.path).entries.length, 2); const before = readFileSync(f.path, 'utf8');
        f.controller.abort(); assert.equal(await watchOne({ ...f.deps, signal: new AbortController().signal, search: async () => { assert.fail('已看过不得新搜索'); } }), 'done'); assert.equal(readFileSync(f.path, 'utf8'), before);
    } finally { f.clean(); }
});

test('原子发布已成功但rename回调同步abort，保watched事实且不晚log', async () => {
    const f = fixture(), rename = fileOps.renameSync;
    try {
        fileOps.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === f.path) f.controller.abort(); return result; }) as typeof fileOps.renameSync;
        assert.equal(await watchOne(f.deps), 'watched'); assert.equal(loadWatched(f.path).entries.length, 2); assert.deepEqual(f.logs, []);
    } finally { fileOps.renameSync = rename; f.clean(); }
});

test('due判定Date.getHours同步abort不能伪报done', async () => {
    const f = fixture(), date = f.deps.now();
    try { date.getHours = () => { f.controller.abort(); return 13; }; assert.equal(await watchOne({ ...f.deps, now: () => date }), 'cancelled'); assert.deepEqual(f.calls, []); }
    finally { f.clean(); }
});

test('trim规划Date.getFullYear同步abort必须发生在最终commit守卫前', async () => {
    const f = fixture(), date = f.deps.now(), original = date.getFullYear.bind(date), before = readFileSync(f.path, 'utf8'); let reads = 0;
    try {
        date.getFullYear = () => { if (++reads === 3) f.controller.abort(); return original(); };
        const result = await watchOne({ ...f.deps, now: () => date });
        assert.equal(reads, 3); assert.deepEqual({ result, originalKept: readFileSync(f.path, 'utf8') === before }, { result: 'cancelled', originalKept: true });
    } finally { f.clean(); }
});

for (const stage of ['search-fetch', 'search-body', 'view-fetch', 'view-body', 'player-fetch', 'player-body', 'subtitle-fetch', 'subtitle-body'] as const) test(`真实账号纯读内部${stage}取消不继续后继，响应this与signal保持`, async () => {
    const controller = new AbortController(), calls: string[] = []; let entered = false, releaseFetch!: (response: BiliResponse) => void, releaseBody!: (text: string) => void, seenSignal: AbortSignal | undefined;
    const heldFetch = new Promise<BiliResponse>(done => { releaseFetch = done; }), heldBody = new Promise<string>(done => { releaseBody = done; });
    const data = (tag: string) => tag === 'nav' ? { code: 0, data: { isLogin: true, uname: '合成账号', mid: 123,
        wbi_img: { img_url: 'https://synthetic.invalid/01234567890123456789012345678901.png', sub_url: 'https://synthetic.invalid/12345678901234567890123456789012.png' } } }
        : tag === 'view' ? { code: 0, data: { cid: 1 } } : tag === 'player' ? { code: 0, data: { subtitle: { subtitles: [{ lan: 'zh', subtitle_url: 'https://synthetic.invalid/subtitle' }] } } }
            : tag === 'subtitle' ? { body: [{ content: '合成字幕' }] } : { code: 0, data: { result: [] } };
    const response = (tag: string): BiliResponse => {
        const value: BiliResponse = { ok: true, status: 200, async text() { assert.equal(this, value); calls.push(`${tag}:body`); if (stage === `${tag}-body`) { entered = true; return heldBody; } return JSON.stringify(data(tag)); } }; return value;
    };
    const account = await openAccount(async (url, init) => {
        const tag = url.includes('/nav') ? 'nav' : url.includes('/search/type') ? 'search' : url.includes('/web-interface/view') ? 'view' : url.includes('/player/') ? 'player' : 'subtitle';
        calls.push(`${tag}:fetch`); if (tag !== 'nav') seenSignal = init.signal;
        if (stage === `${tag}-fetch`) { entered = true; return heldFetch; } return response(tag);
    }, { sessdata: 'SYNTHETIC', biliJct: 'SYNTHETIC', dedeUserId: '123', buvid3: 'SYNTHETIC', savedAt: '2026-11-05T00:00:00Z' });
    assert.ok(account);
    const task = stage.startsWith('search') ? account.search('合成摄影', undefined, controller.signal) : account.subtitle({ bvid: 'BV1abcdefghj' }, controller.signal);
    const result = task.then(() => 'resolved', () => 'cancelled');
    try {
        for (let i = 0; i < 10 && !entered; i++) await tick(); assert.equal(entered, true); controller.abort(); assert.equal(await result, 'cancelled'); assert.equal(seenSignal?.aborted, true);
        const before = [...calls], tag = stage.split('-')[0]!; releaseFetch(response(tag)); releaseBody(JSON.stringify(data(tag))); await tick(); await tick(); assert.deepEqual(calls, before);
    } finally { releaseFetch(response(stage.split('-')[0]!)); releaseBody(JSON.stringify(data(stage.split('-')[0]!))); await result; }
});
