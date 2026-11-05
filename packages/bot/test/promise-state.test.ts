import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promiseKeeper, parsePromises, type PromiseKeeperOptions } from '../src/life/promises.ts';
import { emptyPromiseState, PromiseStateUnavailable, readPromiseState } from '../src/life/promise-state.ts';
import { checkStates } from '../src/ops/state-check.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-promise-state-')); dirs.push(dir); return dir; };
const at = new Date('2026-10-14T12:00:00+08:00');
const a = { qq: 10001, name: '阿明', tier: 'boyfriend' as const };
const b = { qq: 10002, name: '小林', tier: 'classmate' as const };
const item = { id: 'p-0-1', what: '一起吃饭', said: '2026-10-13', date: '2026-10-14', episode: 'ep-0', meet: { time: '18:00', minutes: 90 } };
const loop = { id: 'a-0-1', kind: 'waiting', what: '等面试结果', said: '2026-10-13', episode: 'ep-0' };
const conversation = [
    { role: 'user' as const, time: '2026-10-14T09:00:00+08:00', content: '周末干嘛' },
    { role: 'assistant' as const, time: '2026-10-14T09:01:00+08:00', content: '下次给你推荐一本书' },
];
const options = (dir: string, patch: Partial<PromiseKeeperOptions> = {}): PromiseKeeperOptions => ({
    dir, contacts: [a], names: () => ({ char: '林梦瑶', user: '阿明' }), log: () => {}, now: () => at.getTime(),
    history: { load: () => conversation }, extract: async () => '{"add":[],"resolved":[]}', ...patch,
});

test('旧承诺只在内存迁移，保留约见、未了事项和真实进度；缺关键字段不能当空状态', () => {
    const dir = fixture(); const path = join(dir, 'state.json');
    assert.deepEqual(readPromiseState(path), emptyPromiseState());
    const old = { promises: [item], extracted: { 'ep-0': true } };
    const original = JSON.stringify(old); writeFileSync(path, original);
    assert.deepEqual(readPromiseState(path), { ...old, version: 1, loops: [], early: {} });
    assert.equal(readFileSync(path, 'utf8'), original);
    writeFileSync(path, JSON.stringify({ ...old, loops: [loop], early: { 'ep-1': 2 } }));
    assert.deepEqual(readPromiseState(path).loops, [loop]);
});

test('未知版本、无效日期/约见、重复 id、未了事项及错误计数失败关闭，不隔离或覆盖', () => {
    const dir = fixture(); const path = join(dir, 'state.json'); const base = emptyPromiseState();
    for (const bad of [null, [], {}, { promises: [] }, { ...base, version: 9 }, { version: 1, promises: [], extracted: {} },
        { ...base, promises: [item, item] }, { ...base, promises: [{ ...item, said: '2026-02-30' }] },
        { ...base, promises: [{ ...item, date: null }] }, { ...base, promises: [{ ...item, date: undefined }] },
        { ...base, promises: [{ ...item, meet: { time: '25:00', minutes: 90 } }] },
        { ...base, promises: [{ ...item, meet: { time: '18:00', minutes: -1 } }] },
        { ...base, promises: [{ ...item, meet: { time: '18:00', minutes: Number.MAX_SAFE_INTEGER } }] },
        { ...base, promises: [{ ...item, early: false }] }, { ...base, loops: [{ ...loop, kind: 'unknown' }] },
        { ...base, loops: [{ ...loop, id: item.id }], promises: [item] },
        { ...base, extracted: { 'ep-0': false } }, { ...base, extracted: { 'ep-0': 3 } },
        { ...base, early: { bad: 2 } }, { ...base, early: { 'ep-0': -1 } }]) {
        const original = JSON.stringify(bad); writeFileSync(path, original);
        assert.throws(() => readPromiseState(path), PromiseStateUnavailable);
        assert.equal(readFileSync(path, 'utf8'), original);
        assert.deepEqual(readdirSync(dir), ['state.json']);
    }
});

test('模型候选中的无效日历日不变成新日期或无限期承诺；旧“周末”处理保留', () => {
    const parsed = parsePromises(JSON.stringify({ add: [{ what: '无效约见', date: '2026-02-30' }, { what: '以后读书', date: '周末' }],
        waiting: [{ what: '无效计划', date: '2026-13-01' }] }));
    assert.deepEqual(parsed.add, [{ what: '以后读书' }]);
    assert.deepEqual(parsed.waiting, []);
});

test('坏联系人暂停自身抽取且不影响另一人；未知约定拒绝排期/日记，聊天提示不伪造空日历', async () => {
    const dir = fixture(); const path = join(dir, '10001-boyfriend.json'); const original = 'PRIVATE_BODY bad json';
    writeFileSync(path, original);
    let extracts = 0; const logs: string[] = [];
    const keeper = promiseKeeper(options(dir, { contacts: [a, b], extract: async () => { extracts++; return '{"add":[],"resolved":[]}'; }, log: line => logs.push(line) }));
    await keeper.sync(); await keeper.sync();
    assert.equal(extracts, 1, '另一联系人正常抽取且不重复；坏联系人不送模型');
    assert.equal(keeper.available(), false);
    assert.match(keeper.describe(a, conversation, at)!, /暂不可确认/);
    assert.deepEqual(keeper.openLoops(a, conversation, at), { waiting: [], unanswered: [], unsettled: [] });
    assert.throws(() => keeper.appointmentsBetween(at, new Date(at.getTime() + 86_400_000)), /未知约定/);
    assert.throws(() => keeper.plansOn('2026-10-14'), /来源不可用/);
    assert.equal(readFileSync(path, 'utf8'), original);
    assert.ok(logs.every(line => !line.includes('PRIVATE_BODY')));
    writeFileSync(path, JSON.stringify(emptyPromiseState()));
    assert.equal(keeper.available(), false, '修文件不自动恢复已暂停对象');
    assert.equal(promiseKeeper(options(dir)).available(), true, '修好后显式重建才恢复');
});

test('正常抽取保存 v1 和完成进度，重建后不重复模型调用或世界回写', async () => {
    const dir = fixture(); let calls = 0; let worlds = 0;
    const opts = options(dir, { extract: async () => { calls++; return '{"add":[{"what":"推荐书","date":null}],"resolved":[]}'; }, onWorldActions: () => { worlds++; } });
    await promiseKeeper(opts).sync(); await promiseKeeper(opts).sync();
    const state = readPromiseState(join(dir, '10001-boyfriend.json'));
    assert.equal(state.version, 1); assert.equal(state.promises.length, 1);
    assert.equal(calls, 1); assert.equal(worlds, 1);
});

test('模型抽取期间发现状态损坏，结果返回后也不回写世界或覆盖坏文件', async () => {
    const dir = fixture(); const path = join(dir, '10001-boyfriend.json');
    let release!: (text: string) => void; let worlds = 0;
    let entered!: () => void;
    const extracting = new Promise<void>(resolve => { entered = resolve; });
    const keeper = promiseKeeper(options(dir, { extract: () => new Promise(resolve => { release = resolve; entered(); }), onWorldActions: () => { worlds++; } }));
    const running = keeper.sync();
    await extracting;
    const original = 'PRIVATE_BODY bad json'; writeFileSync(path, original);
    assert.equal(keeper.available(), false);
    release('{"add":[],"resolved":[],"world":[{"kind":"feed_cat","at":"2026-10-14T09:01"}]}');
    await running;
    assert.equal(worlds, 0);
    assert.equal(readFileSync(path, 'utf8'), original);
});

test('承诺写盘失败被接住并暂停后续抽取，不伪装成无约', async () => {
    const dir = fixture(); let calls = 0;
    const keeper = promiseKeeper(options(dir, { extract: async () => {
        calls++; mkdirSync(join(dir, '10001-boyfriend.json')); return '{"add":[],"resolved":[]}';
    } }));
    await keeper.sync(); await keeper.sync();
    assert.equal(calls, 1); assert.equal(keeper.available(), false);
    assert.throws(() => keeper.appointmentsBetween(at, at), PromiseStateUnavailable);
});

test('离线检查使用实际承诺 schema，合法 JSON 的错误约见也会失败且不改原文件', () => {
    const dir = fixture(); mkdirSync(join(dir, 'promises')); const path = join(dir, 'promises', '10001-boyfriend.json');
    const original = JSON.stringify({ ...emptyPromiseState(), promises: [{ ...item, date: '2026-02-30' }] }); writeFileSync(path, original);
    assert.equal(checkStates(dir).find(c => c.name === 'promises/10001-boyfriend.json')!.ok, false);
    assert.equal(readFileSync(path, 'utf8'), original);
});
