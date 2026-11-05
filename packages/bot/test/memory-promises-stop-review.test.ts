import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promiseKeeper, type PromiseKeeperOptions } from '../src/life/promises.ts';
import type { StoredMessage } from '../src/memory/history.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = Date.parse('2026-11-05T12:00:00Z');
const history: StoredMessage[] = [
    { role: 'user', content: '下次给我讲讲', time: new Date(at - 2 * 3600_000).toISOString() },
    { role: 'assistant', content: '好，下次给你讲', time: new Date(at - 2 * 3600_000 + 1000).toISOString() },
];
const result = JSON.stringify({ add: [{ what: '给他讲合成故事' }], resolved: [], world: [{ kind: 'feed_cat', at: '2026-11-05T12:00', seen: true }] });
function fixture(extract: PromiseKeeperOptions['extract'], extra: Partial<PromiseKeeperOptions> = {}) {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-promises-stop-')); dirs.push(dir);
    const logs: string[] = [], world: unknown[] = [];
    const keeper = promiseKeeper({ contacts: [{ qq: 1, name: '合成用户', tier: 'boyfriend' }], history: { load: () => history },
        names: () => ({ user: '合成用户', char: '合成角色' }), extract, dir, now: () => at,
        log: text => logs.push(text), onWorldActions: (...args) => { world.push(args); }, ...extra });
    return { keeper, dir, logs, world };
}
const turn = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded(work: Promise<void> | undefined): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('stop未解除纯模型等待')), 1000); })]); }
    finally { clearTimeout(timer); }
}

test('idle stop同步返回undefined，重复stop稳定且之后sync不再抽取', async () => {
    let calls = 0; const f = fixture(async () => { calls++; return result; });
    assert.equal(f.keeper.stop(), undefined); assert.equal(f.keeper.stop(), undefined);
    await f.keeper.sync(); assert.equal(calls, 0); assert.deepEqual(readdirSync(f.dir), []);
});

test('closed提取在途stop返回稳定drain，晚成功不写承诺/世界且不开始下一片段联系人', async () => {
    let release!: (value: string) => void, calls = 0, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture(() => { calls++; entered(); return new Promise<string>(resolve => { release = resolve; }); }, {
        contacts: [{ qq: 1, name: '甲', tier: 'boyfriend' }, { qq: 2, name: '乙', tier: 'classmate' }],
        history: { load: () => [...history, ...history.map(m => ({ ...m, time: new Date(Date.parse(m.time) + 3600_000).toISOString() }))] },
    });
    const running = f.keeper.sync(); await started;
    const stopped = f.keeper.stop(); assert.ok(stopped instanceof Promise); assert.equal(f.keeper.stop(), stopped);
    await bounded(stopped); release(result); await turn(); await running; await f.keeper.sync();
    assert.equal(calls, 1); assert.deepEqual(f.world, []); assert.deepEqual(readdirSync(f.dir), []);
    assert.equal(f.keeper.stop(), stopped);
});

test('永不resolve的纯模型提取不阻止stop drain', async () => {
    let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const f = fixture(() => { entered(); return new Promise<string>(() => {}); });
    const running = f.keeper.sync(); await started; await bounded(f.keeper.stop()); await running;
    assert.deepEqual(readdirSync(f.dir), []);
});

test('sync同栈立即stop不启动抽取，extract内同步stop也取得相同drain', async () => {
    let calls = 0;
    const before = fixture(async () => { calls++; return result; });
    const queued = before.keeper.sync();
    assert.equal(before.keeper.stop(), queued); await bounded(queued);
    assert.equal(calls, 0); assert.deepEqual(readdirSync(before.dir), []);

    let drain: Promise<void> | undefined;
    const inside = fixture(() => { drain = inside.keeper.stop(); return new Promise<string>(() => {}); });
    const running = inside.keeper.sync(); await bounded(running);
    assert.equal(drain, running); assert.equal(inside.keeper.stop(), running);
    assert.deepEqual(readdirSync(inside.dir), []);
});

test('开放片段提前约见的晚结果在stop后不写early/约定', async () => {
    let release!: (value: string) => void, entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
    const open = [ { role: 'user' as const, content: '晚上七点一起吃饭吗', time: new Date(at - 10_000).toISOString() },
        { role: 'assistant' as const, content: '好，晚上七点一起去吃饭', time: new Date(at - 5000).toISOString() } ];
    const f = fixture(() => { entered(); return new Promise<string>(resolve => { release = resolve; }); }, { history: { load: () => open } });
    const running = f.keeper.sync(); await started; await bounded(f.keeper.stop());
    release(JSON.stringify({ add: [{ what: '一起吃饭', date: '2026-11-05', meet: { time: '19:00', minutes: 90 } }], resolved: [] }));
    await running; await turn(); assert.deepEqual(readdirSync(f.dir), []);
});

test('停止前已提交的联系人保留，另一提取晚reject不记失败或污染日志', async () => {
    let reject!: (error: Error) => void, second!: () => void, calls = 0;
    const started = new Promise<void>(resolve => { second = resolve; });
    const f = fixture(() => { if (++calls === 1) return Promise.resolve(result); second(); return new Promise<string>((_, fail) => { reject = fail; }); }, {
        contacts: [{ qq: 1, name: '甲', tier: 'boyfriend' }, { qq: 2, name: '乙', tier: 'classmate' }],
    });
    const running = f.keeper.sync(); await started;
    const path = join(f.dir, '1-boyfriend.json'); assert.equal(existsSync(path), true); const before = readFileSync(path, 'utf8');
    const logs = f.logs.length; await bounded(f.keeper.stop()); reject(new Error('PRIVATE_LATE_REJECTION')); await turn(); await running;
    assert.equal(readFileSync(path, 'utf8'), before); assert.equal(existsSync(join(f.dir, '2-classmate.json')), false);
    assert.equal(f.logs.length, logs); assert.equal(f.world.length, 1);
});
