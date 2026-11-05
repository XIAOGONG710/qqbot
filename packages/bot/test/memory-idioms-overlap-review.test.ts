import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { idiomStore, refreshIdioms } from '../src/language/idioms.ts';
const now = Date.parse('2026-11-05T12:00:00+08:00');
const tick = () => new Promise<void>(done => setImmediate(done));
for (const newerFails of [false, true]) test(`重叠口头习惯刷新：较新提交${newerFails ? '失败不能伪造进度' : '成功后旧结果不能回退已确认来源'}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-idioms-overlap-')), store = idiomStore({ dir, log() {} });
    const history = Array.from({ length: 64 }, (_, i) => ({ role: 'user' as const, content: `妙妙然 合成经历${i}`, time: new Date(now - ((i % 4) + 1) * 86400000 - i * 1000).toISOString() }));
    let release!: (text: string) => void;
    const held = new Promise<string>(done => { release = done; });
    const common = { qq: 10001, userName: '合成甲', charName: '合成乙', store, now, blocked: [], log() {}, freshHistory: () => history };
    const old = refreshIdioms({ ...common, history, extract: () => held });
    try {
        await tick();
        for (let i = 0; i < 20; i++) history.push({ role: 'user', content: `妙妙然 合成新增${i}`, time: new Date(now + i*1000).toISOString() });
        const next = refreshIdioms({ ...common, now: now + 20_000, history,
            store: newerFails ? { load: store.load, save() { throw new Error('SYNTHETIC_SAVE_EIO'); } } : store,
            extract: async () => '[{"说法":"妙妙然","类型":"网络说法"}]' });
        if (newerFails) await assert.rejects(next, /SYNTHETIC_SAVE_EIO/); else assert.equal(await next, true);
        release('[{"说法":"妙妙然","类型":"口头禅"}]');
        const oldAccepted = await old;
        const state = store.load(10001);
        assert.equal(state.source?.count, newerFails ? 64 : 84);
        assert.equal(state.messageCount, newerFails ? 64 : 84);
        assert.equal(state.items[0]?.kind, newerFails ? '口头禅' : '网络说法');
        assert.equal(oldAccepted, newerFails);
    } finally {
        release('[]'); await old;
        assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(basename(dir).startsWith('qqbot-idioms-overlap-')); rmSync(dir, { recursive: true, force: true });
    }
});
