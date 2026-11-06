import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { JOKES_REFRESH_MS, jokeStore, refreshJokes, verifiedJokes } from '../src/language/jokes.ts';

const now = Date.parse('2026-11-05T12:00:00+08:00');
const proposal = (origin = '旧来历唯一') => JSON.stringify([{ 梗: '星云团子饼', 来历: origin }]);
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-jokes-provenance-')), store = jokeStore({ dir, log() {} }), history = Array.from({ length: 42 }, (_, i) => ({
        role: i % 2 ? 'assistant' as const : 'user' as const, content: `星云团子饼 合成记录${i}${i === 0 ? '旧来历唯一' : ''}`, time: new Date(now - (42 - i) * 1000).toISOString(),
    }));
    return { dir, store, history, path: join(dir, '10001.json'), options: { qq: 10001, userName: '合成甲', charName: '合成乙', history, store, now, log() {} },
        clean() { assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-jokes-provenance-')); rmSync(dir, { recursive: true, force: true }); },
    };
}

test('持久清单绑定完整历史前缀、原样实际请求和phrase+origin，新实例可验证且正常追加安全', async () => {
    const f = fixture(); let request: unknown;
    try {
        await refreshJokes({ ...f.options, extract: async messages => { request = structuredClone(messages); messages[0]!.content = '供应商改了自己收到的对象'; return proposal(); } });
        const state = f.store.load(10001); assert.ok(state.source); assert.equal(state.source.count, 42);
        assert.equal(state.source.historyHash, digest(f.history.map(message => [message.role, message.time, message.content])));
        assert.equal(state.source.requestHash, digest(request)); assert.equal(state.source.jokesHash, digest([['星云团子饼', '旧来历唯一']]));
        const restarted = jokeStore({ dir: f.dir, log() {} }), bytes = readFileSync(f.path, 'utf8');
        assert.equal(verifiedJokes(restarted.load(10001), f.history).length, 1);
        f.history.push({ role: 'user', content: '合成追加', time: new Date(now).toISOString() });
        assert.equal(verifiedJokes(restarted.load(10001), f.history).length, 1); assert.equal(readFileSync(f.path, 'utf8'), bytes);
        assert.ok(!JSON.stringify(state.source).includes('旧来历唯一'), 'manifest仅hash，不新增聊天正文');
    } finally { f.clean(); }
});

test('已完成origin唯一来源撤回或改角色时间，重启读口遮盖并保原文件', async () => {
    const f = fixture();
    try {
        await refreshJokes({ ...f.options, extract: async () => proposal() }); const before = readFileSync(f.path, 'utf8');
        for (const field of ['content', 'role', 'time'] as const) {
            const current = f.history.map(message => ({ ...message }));
            if (field === 'content') current[0]!.content = '[撤回了一条消息]'; else if (field === 'role') current[0]!.role = 'assistant'; else current[0]!.time = new Date(now).toISOString();
            assert.deepEqual(verifiedJokes(jokeStore({ dir: f.dir, log() {} }).load(10001), current), []);
        }
        assert.equal(readFileSync(f.path, 'utf8'), before);
    } finally { f.clean(); }
});

test('有效旧梗经正常刷新继承完整旧依赖，不能贴新manifest洗白旧origin', async () => {
    const f = fixture();
    try {
        await refreshJokes({ ...f.options, extract: async () => proposal() });
        for (let i = 0; i < 12; i++) f.history.push({ role: 'user', content: `合成新记录${i}`, time: new Date(now + i * 1000).toISOString() });
        assert.equal(await refreshJokes({ ...f.options, now: now + JOKES_REFRESH_MS + 1, extract: async () => '[]' }), true);
        assert.equal(f.store.load(10001).source?.count, 54); assert.equal(verifiedJokes(f.store.load(10001), f.history)[0]?.origin, '旧来历唯一');
        f.history[0]!.content = '[撤回了一条消息]'; assert.deepEqual(verifiedJokes(f.store.load(10001), f.history), []);
    } finally { f.clean(); }
});

test('失效源保20h冷却，到期无新消息也可重建，但不能carry旧origin', async () => {
    const f = fixture(); let calls = 0;
    try {
        await refreshJokes({ ...f.options, extract: async () => proposal() }); const original = readFileSync(f.path, 'utf8'); f.history[0]!.content = '[撤回了一条消息]';
        const extract = async () => { calls++; return proposal('合成新的来历'); };
        assert.equal(await refreshJokes({ ...f.options, now: now + 1, extract }), false); assert.equal(calls, 0); assert.equal(readFileSync(f.path, 'utf8'), original);
        assert.equal(await refreshJokes({ ...f.options, now: now + JOKES_REFRESH_MS + 1, extract }), true); assert.equal(calls, 1);
        assert.deepEqual(verifiedJokes(f.store.load(10001), f.history).map(joke => joke.origin), ['合成新的来历']);
        assert.equal(await refreshJokes({ ...f.options, now: now + JOKES_REFRESH_MS + 2, extract }), false); assert.equal(calls, 1);
    } finally { f.clean(); }
});

test('legacy不猜已证明，保原暂避且到期可重建，正常40条门槛保持', async () => {
    const f = fixture(); let calls = 0;
    try {
        f.store.save(10001, { version: 1, jokes: [{ phrase: '星云团子饼', origin: '无来源的旧来历' }], updatedAt: new Date(now).toISOString(), messageCount: 42 });
        const before = readFileSync(f.path, 'utf8'), extract = async () => { calls++; return proposal('重新核验的来历'); };
        assert.deepEqual(verifiedJokes(f.store.load(10001), f.history), []);
        assert.equal(await refreshJokes({ ...f.options, now: now + 1, extract }), false); assert.equal(readFileSync(f.path, 'utf8'), before);
        assert.equal(await refreshJokes({ ...f.options, history: f.history.slice(0, 39), now: now + JOKES_REFRESH_MS + 1, extract }), false); assert.equal(calls, 0);
        assert.equal(await refreshJokes({ ...f.options, now: now + JOKES_REFRESH_MS + 1, extract }), true); assert.equal(calls, 1);
        assert.equal(verifiedJokes(f.store.load(10001), f.history)[0]?.origin, '重新核验的来历');
    } finally { f.clean(); }
});

for (const bad of ['unknown-version', 'missing-hash', 'changed-origin'] as const) test(`显式坏manifest ${bad}不能降级legacy或自动覆盖`, async () => {
    const f = fixture(); let calls = 0;
    try {
        await refreshJokes({ ...f.options, extract: async () => proposal() }); const value = JSON.parse(readFileSync(f.path, 'utf8'));
        if (bad === 'unknown-version') value.source.version = 99; else if (bad === 'missing-hash') delete value.source.historyHash; else value.jokes[0].origin = '手改了来历';
        writeFileSync(f.path, JSON.stringify(value)); const before = readFileSync(f.path, 'utf8'), state = f.store.load(10001);
        assert.equal(state.source, null); assert.deepEqual(verifiedJokes(state, f.history), []);
        assert.equal(await refreshJokes({ ...f.options, now: now + JOKES_REFRESH_MS + 1, extract: async () => { calls++; return proposal(); } }), false);
        assert.equal(calls, 0); assert.equal(readFileSync(f.path, 'utf8'), before);
    } finally { f.clean(); }
});

for (const failure of ['bad-json', 'read-eio', 'log-throws'] as const) test(`来源文件${failure}不能被catch降级legacy后覆盖`, async () => {
    const f = fixture(), originalRead = fs.readFileSync; let calls = 0;
    try {
        await refreshJokes({ ...f.options, extract: async () => proposal() });
        if (failure === 'bad-json') { const saved = readFileSync(f.path, 'utf8'); writeFileSync(f.path, saved.slice(0, -5)); }
        else if (failure === 'log-throws') { const saved = JSON.parse(readFileSync(f.path, 'utf8')); saved.source.version = 99; writeFileSync(f.path, JSON.stringify(saved)); }
        const before = originalRead(f.path, 'utf8');
        if (failure === 'read-eio') {
            fs.readFileSync = ((path: unknown, ...args: unknown[]) => {
                if (String(path) === f.path) throw Object.assign(new Error('SYNTHETIC_SOURCE_READ_EIO'), { code: 'EIO' });
                return Reflect.apply(originalRead, fs, [path, ...args]);
            }) as typeof fs.readFileSync; syncBuiltinESMExports();
        }
        const store = failure === 'log-throws' ? jokeStore({ dir: f.dir, log() { throw new Error('SYNTHETIC_LOG_FAILURE'); } }) : f.store;
        const state = store.load(10001), refreshed = await refreshJokes({ ...f.options, store, now: now + JOKES_REFRESH_MS + 1, extract: async () => { calls++; return proposal(); } });
        assert.deepEqual({ invalidSource: state.source === null, refreshed, modelCalls: calls, originalBytesKept: originalRead(f.path, 'utf8') === before },
            { invalidSource: true, refreshed: false, modelCalls: 0, originalBytesKept: true });
    } finally { fs.readFileSync = originalRead; syncBuiltinESMExports(); f.clean(); }
});

test('首次真正ENOENT仍允许正常提取，不把无文件永久当坏来源', async () => {
    const f = fixture();
    try {
        assert.equal(Object.hasOwn(f.store.load(10001), 'source'), false);
        assert.equal(await refreshJokes({ ...f.options, extract: async () => proposal() }), true);
        assert.equal(verifiedJokes(f.store.load(10001), f.history).length, 1);
    } finally { f.clean(); }
});
