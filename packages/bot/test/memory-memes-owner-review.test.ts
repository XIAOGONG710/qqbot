import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { emptyLists, fetchLists, gatherEvidence, loadMemes, refreshDue, refreshMemes, saveMemes, type MemeLists } from '../src/language/memes.ts';
import { fileOps } from '../src/memory/json-file.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
const term = '星云团子饼', candidates = '{"词":"星云团子饼","来源":"合成热搜"}', explanation = '{"是梗":true,"意思":"朋友间形容轻松快乐的状态","例句":"今天真是星云团子饼","把握":"高","适合聊天":true}';
function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-memes-owner-')), path = join(root, 'memes.json'), controller = new AbortController(), calls: string[] = [], logs: string[] = [];
    saveMemes(path, { version: 1, refreshedAt: '2026-11-04T00:00:00Z', entries: [{ term: '合成旧梗', meaning: '合成且已经确认的解释', example: '合成例句', confidence: 'high', firstSeen: '2026-11-01', lastSeen: '2026-11-04', seen: 1 }] });
    const lists: MemeLists = { ...emptyLists(), hot: [term] };
    const deps = { path, signal: controller.signal, now: () => new Date('2026-11-05T20:00:00+08:00'), log: (line: string) => logs.push(line),
        fetchLists: async () => { calls.push('lists'); return lists; }, ask: async (prompt: string) => { const stage = prompt.startsWith('词：') ? 'explain' : 'candidate'; calls.push(stage); return stage === 'explain' ? explanation : candidates; },
        gather: async () => { calls.push('gather'); return ['合成字幕明确解释这个词']; },
    };
    return { root, path, controller, calls, logs, lists, deps, clean() { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-memes-owner-')); rmSync(root, { recursive: true, force: true }); } };
}

for (const stage of ['lists', 'candidate', 'gather', 'explain'] as const) test(`热梗held ${stage}取消后不继续模型/证据或写旧缓存`, async () => {
    const f = fixture(); let release!: (value: unknown) => void, entered = false;
    const held = new Promise<unknown>(done => { release = done; });
    const deps = { ...f.deps,
        ...(stage === 'lists' ? { fetchLists: async () => { f.calls.push('lists'); entered = true; return held as Promise<MemeLists>; } } : {}),
        ...(stage === 'gather' ? { gather: async () => { f.calls.push('gather'); entered = true; return held as Promise<string[]>; } } : {}),
        ask: async (prompt: string) => {
            const asked = prompt.startsWith('词：') ? 'explain' : 'candidate';
            if (stage === asked) { f.calls.push(asked); entered = true; return held as Promise<string>; } return f.deps.ask(prompt);
        },
    };
    const before = readFileSync(f.path, 'utf8'), task = refreshMemes(deps);
    const value = stage === 'lists' ? f.lists : stage === 'gather' ? ['合成字幕解释'] : stage === 'candidate' ? candidates : explanation;
    try {
        for (let i = 0; i < 10 && !entered; i++) await tick(); assert.equal(entered, true); const calls = [...f.calls], logs = [...f.logs]; f.controller.abort(); release(value);
        const result = await task; await tick();
        assert.deepEqual({ skipped: result.skipped, bytesKept: readFileSync(f.path, 'utf8') === before, calls: f.calls, logs: f.logs }, { skipped: 'cancelled', bytesKept: true, calls, logs });
    } finally { release(value); await task; f.clean(); }
});

test('热梗取消不等不合作模型，微任务派发前已停止不进入任何来源', async () => {
    const f = fixture(); let release!: (text: string) => void, entered = false, timer: ReturnType<typeof setTimeout> | undefined;
    const held = new Promise<string>(done => { release = done; }), task = refreshMemes({ ...f.deps, ask: async () => { entered = true; return held; } });
    try {
        for (let i = 0; i < 10 && !entered; i++) await tick(); assert.equal(entered, true); f.controller.abort();
        const result = await Promise.race([task, new Promise<never>((_, error) => { timer = setTimeout(() => error(new Error('memes still waits for model')), 1000); })]);
        assert.equal(result.skipped, 'cancelled'); const calls = [...f.calls]; assert.equal((await refreshMemes(f.deps)).skipped, 'cancelled'); assert.deepEqual(f.calls, calls);
        release(explanation); await tick(); assert.deepEqual(f.logs, []);
    } finally { clearTimeout(timer); release('[]'); await task; f.clean(); }
});

for (const stage of ['fetch', 'json'] as const) test(`热榜held ${stage}取消不读晚body、不取后续分页或来源`, async () => {
    const controller = new AbortController(), calls: string[] = [], logs: string[] = []; let entered = false, release!: (value: unknown) => void, transportSignal: AbortSignal | undefined;
    const held = new Promise<unknown>(done => { release = done; });
    const response = { ok: true, status: 200, async json() { assert.equal(this, response); calls.push('json'); if (stage === 'json') { entered = true; return held; } return { data: { list: [] } }; } };
    const task = fetchLists(async (_url, init) => { calls.push('fetch'); transportSignal = init.signal; if (stage === 'fetch') { entered = true; return held as Promise<typeof response>; } return response; }, line => logs.push(line), controller.signal);
    const outcome = task.then(() => 'done', () => 'cancelled');
    try {
        for (let i = 0; i < 10 && !entered; i++) await tick(); assert.equal(entered, true); controller.abort(); assert.equal(await outcome, 'cancelled'); assert.equal(transportSignal?.aborted, true);
        const before = [...calls]; release(stage === 'fetch' ? response : { data: { list: [] } }); await tick(); await tick(); assert.deepEqual(calls, before); assert.deepEqual(logs, []);
    } finally { release(stage === 'fetch' ? response : {}); await outcome; }
});

for (const stage of ['search', 'sleep', 'subtitle', 'hotComments'] as const) test(`证据held ${stage}取消后不取后继视频/热评且不返回部分证据`, async () => {
    const controller = new AbortController(), calls: string[] = []; let release!: (value: unknown) => void, entered = false;
    const held = new Promise<unknown>(done => { release = done; });
    const video = { bvid: 'BV1abcdefghj', aid: 1, title: '星云团子饼是什么梗', desc: '合成简介', owner: '合成作者', category: '日常', views: 1, likes: 1, duration: 60, link: 'https://synthetic.invalid/video' };
    const results = { search: [video], sleep: undefined, subtitle: { status: 'ok' as const, lan: 'zh', lines: ['合成解释字幕'] }, hotComments: ['合成热评'] };
    const deps = { signal: controller.signal, search: async () => { calls.push('search'); return results.search; }, sleep: async () => { calls.push('sleep'); },
        subtitle: async () => { calls.push('subtitle'); return results.subtitle; }, hotComments: async () => { calls.push('hotComments'); return results.hotComments; } };
    const override = { [stage]: () => { calls.push(stage); entered = true; return held; } };
    const task = gatherEvidence(term, Object.assign({}, deps, override) as typeof deps), outcome = task.then(() => 'done', () => 'cancelled');
    try {
        for (let i = 0; i < 10 && !entered; i++) await tick(); assert.equal(entered, true); controller.abort(); assert.equal(await outcome, 'cancelled'); const before = [...calls];
        release(results[stage]); await tick(); await tick(); assert.deepEqual(calls, before);
    } finally { release(results[stage]); await outcome; }
});

test('热梗正常新词/旧词事实与12小时策略保留，已确认提交不因停止回滚', async () => {
    const f = fixture();
    try {
        assert.deepEqual(await refreshMemes(f.deps), { added: 1, bumped: 0, tried: 1 }); const saved = readFileSync(f.path, 'utf8'), file = loadMemes(f.path);
        assert.equal(file.entries.length, 2); assert.equal(refreshDue(file, new Date('2026-11-06T07:59:59+08:00')), false); assert.equal(refreshDue(file, new Date('2026-11-06T08:00:00+08:00')), true);
        f.controller.abort(); assert.equal((await refreshMemes(f.deps)).skipped, 'cancelled'); assert.equal(readFileSync(f.path, 'utf8'), saved);
        const next = new AbortController(); const result = await refreshMemes({ ...f.deps, signal: next.signal, ask: async () => candidates, gather: async () => { assert.fail('已知词不得再找证据'); } });
        assert.deepEqual(result, { added: 0, bumped: 1, tried: 0 }); assert.equal(loadMemes(f.path).entries.find(entry => entry.term === term)?.seen, 2);
    } finally { f.clean(); }
});

test('非取消模型失败仍按原降级返回，已确认缓存字节不变', async () => {
    const f = fixture(), before = readFileSync(f.path, 'utf8');
    try { const result = await refreshMemes({ ...f.deps, ask: async () => { throw new Error('SYNTHETIC_MODEL_FAILURE'); } }); assert.equal(result.skipped, '挑词失败'); assert.equal(readFileSync(f.path, 'utf8'), before); assert.equal(f.logs.length, 1); }
    finally { f.clean(); }
});

test('榜单单一来源失败仍继续其它源，证据无字幕时保简介热评且最多三视频', async () => {
    let fetched = 0;
    const lists = await fetchLists(async url => { fetched++; if (url.includes('/popular')) throw new Error('synthetic source down'); return { ok: true, status: 200, json: async () => url.includes('/hotword') ? { list: [{ show_name: term }] } : {} }; });
    assert.ok(fetched >= 4); assert.deepEqual(lists.hot, [term]); let subtitles = 0;
    const evidence = await gatherEvidence(term, { search: async () => Array.from({ length: 5 }, (_, i) => ({ bvid: `BVsynthetic${i}`, aid: i, title: `${term}解释${i}`, desc: '合成简介', owner: '合成作者', category: '日常', views: 1, likes: 1, duration: 60, link: 'https://synthetic.invalid' })),
        sleep: async () => {}, subtitle: async () => { subtitles++; throw new Error('synthetic subtitles missing'); }, hotComments: async () => ['合成热评'] });
    assert.equal(subtitles, 3); assert.equal(evidence.length, 3); assert.ok(evidence.every(line => line.includes('合成简介') && line.includes('合成热评')));
});

for (const stage of ['trim', 'iso'] as const) test(`Date ${stage}最终规划同步停止后不保存或伪报成功`, async () => {
    const f = fixture(), now = f.deps.now(), before = readFileSync(f.path, 'utf8'); let calls = 0;
    try {
        if (stage === 'trim') { const original = now.getFullYear.bind(now); now.getFullYear = () => { if (++calls === 2) f.controller.abort(); return original(); }; }
        else { const original = now.toISOString.bind(now); now.toISOString = () => { calls++; f.controller.abort(); return original(); }; }
        const result = await refreshMemes({ ...f.deps, now: () => now }); assert.equal(result.skipped, 'cancelled'); assert.equal(readFileSync(f.path, 'utf8'), before); assert.ok(calls > 0);
    } finally { f.clean(); }
});

test('原子发布成功后rename回调同步停止保留确认事实，禁止晚成功日志', async () => {
    const f = fixture(), rename = fileOps.renameSync;
    try {
        fileOps.renameSync = ((from, to) => { const result = rename(from, to); if (String(to) === f.path) f.controller.abort(); return result; }) as typeof fileOps.renameSync;
        assert.deepEqual(await refreshMemes(f.deps), { added: 1, bumped: 0, tried: 1 }); assert.equal(loadMemes(f.path).entries.length, 2); assert.deepEqual(f.logs, []);
    } finally { fileOps.renameSync = rename; f.clean(); }
});
