import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { jokeRefresher, jokeStore, refreshJokes } from '../src/language/jokes.ts';

const now = Date.parse('2026-11-05T12:00:00+08:00'), tick = () => new Promise<void>(done => setImmediate(done));
const proposal = '[{"梗":"星云团子饼","来历":"合成聊天玩笑"}]';
function source() { return Array.from({ length: 42 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `星云团子饼 合成对话${i}`, time: new Date(now - (42 - i) * 1000).toISOString() })); }
function temp() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-jokes-stop-')), store = jokeStore({ dir, log() {} });
    return { dir, store, path: join(dir, '10001.json'), options: { qq: 10001, userName: '合成甲', charName: '合成乙', history: source(), store, now, log() {} }, clean() {
        assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-jokes-stop-')); rmSync(dir, { recursive: true, force: true });
    } };
}

test('小梗owner同步stop阻止尚未派发模型，后续refresh不读写', async () => {
    const f = temp(), owner = jokeRefresher(); let calls = 0;
    const run = () => owner.refresh({ ...f.options, extract: async () => { calls++; return proposal; } });
    try { const task = run(); await owner.stop(); assert.equal(await task, false); assert.equal(await run(), false); assert.equal(calls, 0); assert.equal(existsSync(f.path), false); }
    finally { await owner.stop(); f.clean(); }
});

for (const fail of [false, true]) test(`小梗owner不等不合作模型，重复stop同drain，晚${fail ? '失败' : '成功'}不保存或log`, async () => {
    const f = temp(), owner = jokeRefresher(), logs: string[] = []; let calls = 0, release!: (text: string) => void, reject!: (error: Error) => void;
    const held = new Promise<string>((done, error) => { release = done; reject = error; });
    const task = owner.refresh({ ...f.options, log: line => logs.push(line), extract: async () => { calls++; return held; } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await tick(); assert.equal(calls, 1); const drain = owner.stop(); assert.ok(drain instanceof Promise); assert.equal(owner.stop(), drain);
        await Promise.race([drain, new Promise<never>((_, error) => { timer = setTimeout(() => error(new Error('joke owner still waits for provider')), 1000); })]);
        assert.equal(await task, false); const before = [...logs]; if (fail) reject(new Error('SYNTHETIC_LATE_JOKES_FAILURE')); else release(proposal);
        await tick(); await tick(); assert.equal(existsSync(f.path), false); assert.deepEqual(logs, before);
    } finally { clearTimeout(timer); release('[]'); await task; await owner.stop(); f.clean(); }
});

test('小梗正常确认文件stop后保留，新owner/standalone遵守既有刷新间隔', async () => {
    const f = temp(), owner = jokeRefresher(); let calls = 0;
    const options = { ...f.options, extract: async () => { calls++; return proposal; } };
    let next: ReturnType<typeof jokeRefresher> | undefined;
    try {
        assert.equal(await owner.refresh(options), true); const saved = readFileSync(f.path, 'utf8'); assert.equal(f.store.load(10001).jokes[0]?.phrase, '星云团子饼');
        await owner.stop(); assert.equal(await owner.refresh(options), false); assert.equal(readFileSync(f.path, 'utf8'), saved);
        next = jokeRefresher(); assert.equal(await next.refresh(options), false); assert.equal(await refreshJokes(options), false); assert.equal(calls, 1);
    } finally { await owner.stop(); await next?.stop(); f.clean(); }
});

for (const field of ['content', 'role', 'time'] as const) test(`小梗在途源${field}同长度变化不能提交旧结果`, async () => {
    const f = temp(), owner = jokeRefresher(), messages = source(); let release!: (text: string) => void, calls = 0;
    const held = new Promise<string>(done => { release = done; });
    const task = owner.refresh({ ...f.options, history: messages, freshHistory: () => messages, extract: async () => { calls++; return held; } });
    try {
        await tick(); assert.equal(calls, 1);
        if (field === 'content') messages[0]!.content = '[撤回了消息]';
        else if (field === 'role') messages[0]!.role = 'assistant';
        else messages[0]!.time = new Date(Date.parse(messages[0]!.time) + 1).toISOString();
        release(proposal); assert.equal(await task, false); assert.equal(existsSync(f.path), false);
    } finally { release('[]'); await task; await owner.stop(); f.clean(); }
});

test('owner调用时冻结来源，进入派发微任务前被改写不能从新源生成旧预约', async () => {
    const f = temp(), owner = jokeRefresher(), messages = source(); let calls = 0;
    try {
        const task = owner.refresh({ ...f.options, history: messages, freshHistory: () => messages, extract: async () => { calls++; return proposal; } });
        messages[0]!.content = '[撤回了消息]';
        assert.equal(await task, false); assert.equal(calls, 0); assert.equal(existsSync(f.path), false);
    } finally { await owner.stop(); f.clean(); }
});

test('来源正常尾追加允许原快照提交，进度只记模型实际消耗条数', async () => {
    const f = temp(), owner = jokeRefresher(), messages = source(); let release!: (text: string) => void;
    const held = new Promise<string>(done => { release = done; });
    const task = owner.refresh({ ...f.options, history: messages, freshHistory: () => messages, extract: () => held });
    try {
        await tick(); messages.push({ role: 'user', content: '合成正常新消息', time: new Date(now).toISOString() });
        release(proposal); assert.equal(await task, true); assert.equal(f.store.load(10001).messageCount, 42); assert.equal(f.store.load(10001).jokes[0]?.phrase, '星云团子饼');
    } finally { release('[]'); await task; await owner.stop(); f.clean(); }
});

test('在途后来源读取EIO明确失败，不保存旧正文或进度', async () => {
    const f = temp(), owner = jokeRefresher(); let release!: (text: string) => void, ioFailed = false;
    const held = new Promise<string>(done => { release = done; });
    const task = owner.refresh({ ...f.options, freshHistory: () => { if (ioFailed) throw new Error('SYNTHETIC_SOURCE_EIO'); return f.options.history; }, extract: () => held });
    try {
        await tick(); ioFailed = true; release(proposal); await assert.rejects(task, /SYNTHETIC_SOURCE_EIO/); assert.equal(existsSync(f.path), false);
    } finally { release('[]'); await task.catch(() => {}); await owner.stop(); f.clean(); }
});

test('未取消的provider失败仍向宿主报告，不伪称成功或改已确认文件', async () => {
    const f = temp(), owner = jokeRefresher(); f.store.save(10001, { version: 1, jokes: [{ phrase: '星云团子饼', origin: '合成已确认' }] });
    const before = readFileSync(f.path, 'utf8');
    try { await assert.rejects(owner.refresh({ ...f.options, extract: async () => { throw new Error('SYNTHETIC_PROVIDER_FAILURE'); } }), /SYNTHETIC_PROVIDER_FAILURE/); assert.equal(readFileSync(f.path, 'utf8'), before); }
    finally { await owner.stop(); f.clean(); }
});

for (const atRead of [1, 2]) test(`来源公开回调在第${atRead}次核验同步stop后，不继续派发或保存`, async () => {
    const f = temp(), owner = jokeRefresher(); let reads = 0, calls = 0;
    try {
        const task = owner.refresh({ ...f.options, freshHistory: () => { if (++reads === atRead) owner.stop(); return f.options.history; }, extract: async () => { calls++; return proposal; } });
        assert.equal(await task, false); await owner.stop(); assert.equal(calls, atRead === 1 ? 0 : 1); assert.equal(existsSync(f.path), false);
    } finally { await owner.stop(); f.clean(); }
});
