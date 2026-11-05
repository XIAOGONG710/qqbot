import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { IDIOMS_REFRESH_MS, idiomRefresher, idiomStore, refreshIdioms, verifiedIdioms } from '../src/language/idioms.ts';

const now = Date.parse('2026-11-05T12:00:00+08:00'), tick = () => new Promise<void>(done => setImmediate(done));
const proposal = '[{"说法":"妙妙然","类型":"网络说法"}]';
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-idioms-owner-')), store = idiomStore({ dir, log() {} });
    const history = Array.from({ length: 64 }, (_, i) => ({ role: 'user' as 'user' | 'assistant', content: i < 4 ? `妙妙然 合成体验${i}` : `合成日常${i}`, time: new Date(now - ((i % 4) + 1) * 86400000 - i * 1000).toISOString() }));
    return { dir, store, history, path: join(dir, '10001.json'), options: { qq: 10001, userName: '合成甲', charName: '合成乙', history, store, now, blocked: ['合成甲', '合成乙'], log() {} }, clean() {
        assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-idioms-owner-')); rmSync(dir, { recursive: true, force: true });
    } };
}

for (const fail of [false, true]) test(`口头习惯signal取消后旧模型${fail ? '失败' : '成功'}不保存或log`, async () => {
    const f = fixture(), controller = new AbortController(), logs: string[] = []; let calls = 0, release!: (text: string) => void, reject!: (error: Error) => void;
    const held = new Promise<string>((done, error) => { release = done; reject = error; });
    const options = { ...f.options, signal: controller.signal, log: (line: string) => logs.push(line), extract: async () => { calls++; return held; } };
    const task = refreshIdioms(options); const outcome = task.then(value => ({ value }), error => ({ error }));
    try {
        await tick(); assert.equal(calls, 1); controller.abort(); if (fail) reject(new Error('SYNTHETIC_PRIVATE_IDIOMS_FAILURE')); else release(proposal);
        assert.deepEqual(await outcome, { value: false }); await tick(); assert.equal(existsSync(f.path), false); assert.deepEqual(logs, []);
    } finally { release('[]'); await outcome; f.clean(); }
});

test('口头习惯同长度在途来源撤回不能保存原四次三天的旧习惯', async () => {
    const f = fixture(); let release!: (text: string) => void;
    const held = new Promise<string>(done => { release = done; });
    const options = { ...f.options, freshHistory: () => f.history, extract: async () => held };
    const task = refreshIdioms(options);
    try {
        await tick(); f.history[0]!.content = '[撤回了一条消息]'; f.history[1]!.content = '[撤回了一条消息]'; release(proposal);
        assert.equal(await task, false); assert.equal(existsSync(f.path), false);
    } finally { release('[]'); await task; f.clean(); }
});

test('owner微任务派发前同步stop，不派新模型；调用时冻结原始来源', async () => {
    const f = fixture(), owner = idiomRefresher(); let calls = 0;
    try {
        const task = owner.refresh({ ...f.options, extract: async () => { calls++; return proposal; } });
        const drain = owner.stop(); assert.equal(owner.stop(), drain); await drain; assert.equal(await task, false);
        assert.equal(await owner.refresh({ ...f.options, extract: async () => { calls++; return proposal; } }), false);
        assert.equal(calls, 0); assert.equal(existsSync(f.path), false);
        const next = idiomRefresher(); const queued = next.refresh({ ...f.options, freshHistory: () => f.history, extract: async () => { calls++; return proposal; } });
        f.history[0]!.content = '[撤回了一条消息]'; assert.equal(await queued, false); assert.equal(calls, 0); await next.stop();
    } finally { await owner.stop(); f.clean(); }
});

test('owner取消不合作模型的本地等待，重复stop同drain，不等底层完成', async () => {
    const f = fixture(), owner = idiomRefresher(); let release!: (text: string) => void, calls = 0, timer: ReturnType<typeof setTimeout> | undefined;
    const held = new Promise<string>(done => { release = done; }), task = owner.refresh({ ...f.options, extract: async () => { calls++; return held; } });
    try {
        await tick(); assert.equal(calls, 1); const drain = owner.stop(); assert.ok(drain instanceof Promise); assert.equal(owner.stop(), drain);
        await Promise.race([drain, new Promise<never>((_, error) => { timer = setTimeout(() => error(new Error('idiom owner still waits for provider')), 1000); })]);
        assert.equal(await task, false); assert.equal(existsSync(f.path), false); release(proposal); await tick(); assert.equal(existsSync(f.path), false);
    } finally { clearTimeout(timer); release('[]'); await task; await owner.stop(); f.clean(); }
});

test('完整持久manifest绑定原请求/分类计数与禁用词政策，重启/正常追加有效，政策变更暂避', async () => {
    const f = fixture(); let request: unknown;
    try {
        assert.equal(await refreshIdioms({ ...f.options, extract: async messages => { request = structuredClone(messages); messages[0]!.content = 'provider改了入参'; return proposal; } }), true);
        const state = f.store.load(10001), before = readFileSync(f.path, 'utf8'); assert.ok(state.source);
        assert.equal(state.source.requestHash, createHash('sha256').update(JSON.stringify(request)).digest('hex')); assert.equal(state.source.count, 64);
        assert.equal(verifiedIdioms(idiomStore({ dir: f.dir, log() {} }).load(10001), f.history, [...f.options.blocked].reverse()).length, 1);
        assert.deepEqual(verifiedIdioms(state, f.history, [...f.options.blocked, '妙妙然']), []);
        f.history.push({ role: 'assistant', content: '合成正常追加', time: new Date(now).toISOString() });
        assert.equal(verifiedIdioms(state, f.history, f.options.blocked).length, 1); assert.equal(readFileSync(f.path, 'utf8'), before);
        assert.ok(!JSON.stringify(state.source).includes('妙妙然'));
    } finally { f.clean(); }
});

for (const field of ['role', 'time'] as const) test(`在途来源${field}同长度变化拒旧提交`, async () => {
    const f = fixture(); let release!: (text: string) => void;
    const held = new Promise<string>(done => { release = done; }), task = refreshIdioms({ ...f.options, freshHistory: () => f.history, extract: () => held });
    try {
        await tick(); if (field === 'role') f.history[0]!.role = 'assistant'; else f.history[0]!.time = new Date(now).toISOString();
        release(proposal); assert.equal(await task, false); assert.equal(existsSync(f.path), false);
    } finally { release('[]'); await task; f.clean(); }
});

test('正常刷新保留分类的旧依赖；源失效到期重建不能洗白旧kind', async () => {
    const f = fixture();
    try {
        await refreshIdioms({ ...f.options, extract: async () => proposal });
        for (let i = 0; i < 20; i++) f.history.push({ role: 'user', content: `合成新话${i}`, time: new Date(now + i * 1000).toISOString() });
        assert.equal(await refreshIdioms({ ...f.options, now: now + IDIOMS_REFRESH_MS + 1, extract: async () => '[]' }), true);
        assert.equal(f.store.load(10001).source?.count, 84); assert.equal(verifiedIdioms(f.store.load(10001), f.history, f.options.blocked)[0]?.kind, '网络说法');
        f.history[0]!.content = '妙妙然 合成改变上下文'; assert.deepEqual(verifiedIdioms(f.store.load(10001), f.history, f.options.blocked), []);
        let calls = 0; const extract = async () => { calls++; return '[{"说法":"妙妙然","类型":"新分类"}]'; };
        const before = readFileSync(f.path, 'utf8'); assert.equal(await refreshIdioms({ ...f.options, now: now + IDIOMS_REFRESH_MS + 2, extract }), false); assert.equal(readFileSync(f.path, 'utf8'), before);
        assert.equal(await refreshIdioms({ ...f.options, now: now + 2 * IDIOMS_REFRESH_MS + 2, extract }), true); assert.equal(calls, 1);
        assert.equal(verifiedIdioms(f.store.load(10001), f.history, f.options.blocked)[0]?.kind, '新分类');
    } finally { f.clean(); }
});

test('legacy不猜清白且保持20h/60用户条门槛，到期无需20条新话可重建', async () => {
    const f = fixture(); let calls = 0;
    try {
        f.store.save(10001, { version: 1, items: [{ phrase: '妙妙然', kind: '未知旧分类', count: 4, days: 4 }], updatedAt: new Date(now).toISOString(), messageCount: 64 });
        const before = readFileSync(f.path, 'utf8'), extract = async () => { calls++; return proposal; };
        assert.deepEqual(verifiedIdioms(f.store.load(10001), f.history, f.options.blocked), []);
        assert.equal(await refreshIdioms({ ...f.options, now: now + 1, extract }), false); assert.equal(readFileSync(f.path, 'utf8'), before);
        assert.equal(await refreshIdioms({ ...f.options, history: f.history.slice(0, 59), now: now + IDIOMS_REFRESH_MS + 1, extract }), false); assert.equal(calls, 0);
        assert.equal(await refreshIdioms({ ...f.options, now: now + IDIOMS_REFRESH_MS + 1, extract }), true); assert.equal(calls, 1);
        assert.equal(verifiedIdioms(f.store.load(10001), f.history, f.options.blocked)[0]?.kind, '网络说法');
    } finally { f.clean(); }
});

test('正常有效来源仍须20小时且至少20条新用户消息，不放宽原配额', async () => {
    const f = fixture(); let calls = 0;
    const extract = async () => { calls++; return proposal; };
    try {
        assert.equal(await refreshIdioms({ ...f.options, extract }), true); const before = readFileSync(f.path, 'utf8');
        assert.equal(await refreshIdioms({ ...f.options, now: now + IDIOMS_REFRESH_MS + 1, extract }), false);
        for (let i = 0; i < 19; i++) f.history.push({ role: 'user', content: `合成新话${i}`, time: new Date(now + i * 1000).toISOString() });
        assert.equal(await refreshIdioms({ ...f.options, now: now + IDIOMS_REFRESH_MS + 1, extract }), false);
        f.history.push({ role: 'user', content: '合成第二十条', time: new Date(now + 19000).toISOString() });
        assert.equal(await refreshIdioms({ ...f.options, now: now + IDIOMS_REFRESH_MS - 1, extract }), false);
        assert.equal(calls, 1); assert.equal(readFileSync(f.path, 'utf8'), before);
        assert.equal(await refreshIdioms({ ...f.options, now: now + IDIOMS_REFRESH_MS + 1, extract }), true); assert.equal(calls, 2);
    } finally { f.clean(); }
});

for (const failure of ['version', 'changed-kind', 'json', 'eio', 'logger'] as const) test(`坏口头习惯来源${failure}保原失败关闭，不降级legacy重写`, async () => {
    const f = fixture(), originalRead = fs.readFileSync; let calls = 0;
    try {
        await refreshIdioms({ ...f.options, extract: async () => proposal }); const saved = readFileSync(f.path, 'utf8'), value = JSON.parse(saved);
        if (failure === 'version' || failure === 'logger') { value.source.version = 99; writeFileSync(f.path, JSON.stringify(value)); }
        else if (failure === 'changed-kind') { value.items[0].kind = '手改旧分类'; writeFileSync(f.path, JSON.stringify(value)); }
        else if (failure === 'json') writeFileSync(f.path, saved.slice(0, -5));
        const before = originalRead(f.path, 'utf8');
        if (failure === 'eio') { fs.readFileSync = ((path: unknown, ...args: unknown[]) => { if (String(path) === f.path) throw Object.assign(new Error('SYNTHETIC_IDIOM_READ_EIO'), { code: 'EIO' }); return Reflect.apply(originalRead, fs, [path, ...args]); }) as typeof fs.readFileSync; syncBuiltinESMExports(); }
        const store = failure === 'logger' ? idiomStore({ dir: f.dir, log() { throw new Error('SYNTHETIC_LOG_THROW'); } }) : f.store;
        assert.equal(store.load(10001).source, null);
        assert.equal(await refreshIdioms({ ...f.options, store, now: now + IDIOMS_REFRESH_MS + 1, extract: async () => { calls++; return proposal; } }), false);
        assert.equal(calls, 0); assert.equal(originalRead(f.path, 'utf8'), before);
    } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); f.clean(); }
});

for (const atRead of [1, 2]) test(`freshHistory第${atRead}次公开回调同步stop后不继续派发/保存`, async () => {
    const f = fixture(), owner = idiomRefresher(); let calls = 0, reads = 0;
    try {
        const task = owner.refresh({ ...f.options, freshHistory: () => { if (++reads === atRead) owner.stop(); return f.history; }, extract: async () => { calls++; return proposal; } });
        assert.equal(await task, false); await owner.stop(); assert.equal(calls, atRead === 1 ? 0 : 1); assert.equal(existsSync(f.path), false);
    } finally { await owner.stop(); f.clean(); }
});
