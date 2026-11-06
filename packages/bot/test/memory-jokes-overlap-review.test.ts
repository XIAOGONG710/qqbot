import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { jokeStore, refreshJokes } from '../src/language/jokes.ts';
const now = Date.parse('2026-11-05T12:00:00+08:00');
const tick = () => new Promise<void>(done => setImmediate(done));
for (const newerFails of [false, true]) test(`重叠小梗刷新：较新提交${newerFails ? '失败不能伪造进度' : '成功后旧结果不能回退已确认来源'}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-jokes-overlap-')), store = jokeStore({ dir, log() {} });
    const history = Array.from({ length: 42 }, (_, i) => ({ role: 'user' as const, content: `星云团子饼 合成经历${i}`, time: new Date(now - (42-i)*1000).toISOString() }));
    let release!: (text: string) => void;
    const held = new Promise<string>(done => { release = done; });
    const common = { qq: 10001, userName: '合成甲', charName: '合成乙', store, now, log() {}, freshHistory: () => history };
    const old = refreshJokes({ ...common, history, extract: () => held });
    try {
        await tick();
        for (let i = 0; i < 12; i++) history.push({ role: 'user', content: `星云团子饼 合成新增${i}`, time: new Date(now + i*1000).toISOString() });
        const next = refreshJokes({ ...common, now: now + 12_000, history,
            store: newerFails ? { load: store.load, save() { throw new Error('SYNTHETIC_SAVE_EIO'); } } : store,
            extract: async () => '[{"梗":"星云团子饼","来历":"较新来源"}]' });
        if (newerFails) await assert.rejects(next, /SYNTHETIC_SAVE_EIO/); else assert.equal(await next, true);
        release('[{"梗":"星云团子饼","来历":"较旧来源"}]');
        const oldAccepted = await old;
        const state = store.load(10001);
        assert.equal(state.source?.count, newerFails ? 42 : 54);
        assert.equal(state.messageCount, newerFails ? 42 : 54);
        assert.equal(state.jokes[0]?.origin, newerFails ? '较旧来源' : '较新来源');
        assert.equal(oldAccepted, newerFails);
    } finally {
        release('[]'); await old;
        assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-jokes-overlap-')); rmSync(dir, { recursive: true, force: true });
    }
});

