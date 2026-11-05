import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { feedOnce, type FeedDeps } from '../src/bilibili/feed-browsing.ts';
import { fileOps } from '../src/memory/json-file.ts';

const tick = () => new Promise<void>(done => setImmediate(done));
async function settle() { for (let i = 0; i < 8; i++) await tick(); }
const nav = JSON.stringify({ code: 0, data: { wbi_img: { img_url: `https://synthetic.invalid/${'a'.repeat(32)}.png`, sub_url: `https://synthetic.invalid/${'b'.repeat(32)}.png` } } });
const recommendation = JSON.stringify({ code: 0, data: { item: [{ bvid: 'BV1abcdefghj', title: '合成猫咪', owner: { name: '合成作者' }, tname: '喵星人', duration: 120 }] } });
type Stage = 'nav-fetch' | 'nav-body' | 'recommend-fetch' | 'recommend-body' | 'none';
function fixture(stage: Stage = 'none', lateFailure = false) {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-feed-owner-')), path = join(root, 'feed.json'), controller = new AbortController();
    const logs: string[] = [], requests: string[] = [], bodies: string[] = [];
    let release!: () => void, entered = false;
    const held = new Promise<void>(done => { release = done; });
    class SyntheticResponse {
        readonly ok = true; readonly status = 200; #body: string; readonly name: string;
        constructor(name: string) { this.name = name; this.#body = name === 'nav' ? nav : recommendation; }
        async text() { bodies.push(this.name); if (stage === `${this.name}-body`) { entered = true; await held; if (lateFailure) throw new Error('SYNTHETIC_LATE_PRIVATE_BODY'); } return this.#body; }
    }
    const deps: FeedDeps & { signal: AbortSignal } = {
        mode: 'on', path, now: () => new Date(2026, 10, 5, 16), signal: controller.signal, log: line => logs.push(line),
        fetch: async (url, init) => {
            assert.equal(new URL(url).origin, 'https://api.bilibili.com');
            const name = new URL(url).pathname.endsWith('/nav') ? 'nav' : 'recommend'; requests.push(name);
            if (stage === `${name}-fetch`) { entered = true; await held; if (lateFailure) throw new Error('SYNTHETIC_LATE_PRIVATE_FETCH'); }
            return new SyntheticResponse(name);
        },
    };
    return { root, path, deps, controller, logs, requests, bodies, release, entered: () => entered, cleanup() {
        release(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-feed-owner-')); rmSync(root, { recursive: true, force: true });
    } };
}

for (const stage of ['nav-fetch', 'nav-body', 'recommend-fetch', 'recommend-body'] as const) test(`推荐流取消${stage}纯读等待后本地结束，晚结果无后继/落盘/log`, async () => {
    const f = fixture(stage); const task = feedOnce(f.deps);
    try {
        await settle(); assert.equal(f.entered(), true); const count = f.requests.length; f.controller.abort();
        const outcome = await Promise.race([task, new Promise<string>(done => setTimeout(() => done('held'), 100))]);
        assert.equal(outcome, 'cancelled'); f.release(); await task; await settle();
        assert.equal(f.requests.length, count); assert.equal(existsSync(f.path), false); assert.deepEqual(f.logs, []);
    } finally { f.release(); await task; f.cleanup(); }
});

test('已取消推荐响应体晚失败不复活日志或失败状态', async () => {
    const f = fixture('recommend-body', true); const task = feedOnce(f.deps);
    try {
        await settle(); assert.equal(f.entered(), true); f.controller.abort(); f.release();
        assert.equal(await task, 'cancelled'); await settle(); assert.equal(existsSync(f.path), false); assert.deepEqual(f.logs, []);
    } finally { f.release(); await task; f.cleanup(); }
});

test('预取消或now/awake回调同步取消不读取模型/网络或保存状态', async () => {
    for (const [before, awake] of [[true, true], [false, true], [false, false]] as const) {
        const f = fixture(); let nowCalls = 0;
        if (before) f.controller.abort();
        try {
            const result = await feedOnce({ ...f.deps, now: () => { nowCalls++; return new Date(2026, 10, 5, 16); }, awake: () => { f.controller.abort(); return awake; } });
            assert.equal(result, 'cancelled'); assert.equal(nowCalls, before ? 0 : 1); assert.deepEqual(f.requests, []); assert.deepEqual(f.logs, []);
        } finally { f.cleanup(); }
    }
    const f = fixture();
    try {
        assert.equal(await feedOnce({ ...f.deps, now: () => { f.controller.abort(); return new Date(2026, 10, 5, 16); } }), 'cancelled');
        assert.deepEqual(f.requests, []); assert.equal(existsSync(f.path), false);
    } finally { f.cleanup(); }
    const due = fixture(), date = new Date(2026, 10, 5, 16);
    date.getHours = () => { due.controller.abort(); return 13; };
    try {
        assert.equal(await feedOnce({ ...due.deps, now: () => date }), 'cancelled'); assert.deepEqual(due.requests, []);
    } finally { due.cleanup(); }
});

test('fetch函数体同步取消在派发前已注册取消，不再读响应体', async () => {
    const f = fixture();
    try {
        const result = await feedOnce({ ...f.deps, fetch: async () => { f.controller.abort(); return { ok: true, status: 200, text: async () => { assert.fail('取消后不得开始响应体'); } }; } });
        assert.equal(result, 'cancelled'); assert.equal(existsSync(f.path), false); assert.deepEqual(f.logs, []);
    } finally { f.cleanup(); }
});

test('响应体保原this且每次请求转发所有者signal，正常同步事实可保存', async () => {
    const f = fixture(); const base = f.deps.fetch;
    try {
        assert.equal(await feedOnce({ ...f.deps, fetch: (url, init) => { assert.equal(init.signal, f.controller.signal); return base(url, init); } }), 'browsed');
        assert.deepEqual(f.requests, ['nav', 'recommend']); assert.deepEqual(f.bodies, ['nav', 'recommend']); assert.ok(readFileSync(f.path, 'utf8').includes('合成猫咪'));
    } finally { f.cleanup(); }
});

test('draft已同步执行期间取消仍承认browsed事实，取消后不再log', async () => {
    const f = fixture(); let draft = '';
    try {
        assert.equal(await feedOnce({ ...f.deps, mode: 'dryRun', draft: (_title, body) => { draft = body; f.controller.abort(); } }), 'browsed');
        assert.ok(draft.includes('合成猫咪')); assert.equal(existsSync(f.path), false); assert.deepEqual(f.logs, []);
    } finally { f.cleanup(); }
});

test('原子发布已确认后取消保留browsed事实与原文件，不反写为空', async () => {
    const f = fixture(), rename = fileOps.renameSync;
    try {
        fileOps.renameSync = ((source: string, target: string) => { rename(source, target); if (String(target) === f.path) f.controller.abort(); }) as typeof rename;
        assert.equal(await feedOnce(f.deps), 'browsed'); assert.ok(readFileSync(f.path, 'utf8').includes('合成猫咪')); assert.deepEqual(f.logs, []);
    } finally { fileOps.renameSync = rename; f.cleanup(); }
});

for (const mode of ['dryRun', 'on'] as const) test(`公共Date回调同步取消后不能再开始${mode === 'on' ? 'save' : 'draft'}`, async () => {
        const f = fixture(); let drafts = 0, years = 0;
        const date = new Date(2026, 10, 5, 16), getFullYear = date.getFullYear.bind(date);
        if (mode === 'dryRun') date.toLocaleString = () => { f.controller.abort(); return '合成日期'; };
        else date.getFullYear = () => { if (++years === 2) f.controller.abort(); return getFullYear(); };
        try {
            assert.equal(await feedOnce({ ...f.deps, mode, now: () => date, draft: () => { drafts++; } }), 'cancelled');
            assert.equal(drafts, 0); assert.equal(existsSync(f.path), false); assert.deepEqual(f.logs, []);
        } finally { f.cleanup(); }
});
