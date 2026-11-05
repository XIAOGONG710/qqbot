import assert from 'node:assert/strict';
import { basename, dirname, join, resolve } from 'node:path';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterEach, test } from 'node:test';
import { worldState, type World, type WorldActionDraft } from '../src/world/world.ts';
import type { Schedule } from '../src/life/schedule.ts';
import { promiseKeeper } from '../src/life/promises.ts';
import { splitEpisodes } from '../src/memory/episodes.ts';
import { fileOps } from '../src/memory/json-file.ts';

const roots: string[] = [];
afterEach(() => { for (const dir of roots.splice(0)) { const target = resolve(dir); assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith('qqbot-world-effect-id-')); rmSync(target, { recursive: true, force: true }); } });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-world-effect-id-')); roots.push(dir); return dir; };
const schedule: Schedule = { sleep: '02:00', wake: { early: '07:00', lazy: '09:00', earlySlot: 'one' }, periods: { one: { start: '08:00', end: '10:00' } },
    semester: { start: '2026-09-01', weeks: 20 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, pe: {}, water: {} }, courses: [],
    free: { morning: ['合成休息'], afternoon: ['合成休息'], evening: ['合成休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '合成地点' };
const world: World = { startDay: '2026-11-05', awayHolidays: [], events: [], people: [] };
const now = Date.parse('2026-11-05T12:00:00+08:00'), contact = { qq: 10001, tier: 'boyfriend' as const, name: 'Synthetic User' };
const chat = [{ role: 'user' as const, content: '先给你转10元红包，再给你转20元红包', time: '2026-11-05T10:00:00+08:00' },
    { role: 'assistant' as const, content: '10元和20元我都收到了', time: '2026-11-05T10:01:00+08:00' }];
const episode = splitEpisodes(chat)[0]!;
const draft = (amount: number): WorldActionDraft => ({ kind: 'receive_money', at: '2026-11-05T10:01', amount });
const service = (dir: string) => worldState(world, schedule, () => {}, dir, () => now);
const amounts = (state: ReturnType<typeof service>) => state.actions().map(action => action.amount).sort((a, b) => a! - b!);

test('同一已验证两笔事实的事件ID不随模型数组顺序变化', () => {
    const a = service(temp()), b = service(temp());
    a.record(contact, episode, [draft(10), draft(20)]); b.record(contact, episode, [draft(20), draft(10)]);
    const identities = (state: typeof a) => state.actions().map(action => [action.amount, action.id]).sort((x, y) => Number(x[0]) - Number(y[0]));
    assert.deepEqual(identities(a), identities(b)); assert.equal(a.events().length, 2);
});

test('已落部分批次重启再重排补齐，不以旧数组位置吞掉另一笔金额', () => {
    const dir = temp(); let state = service(dir); state.record(contact, episode, [draft(10)]);
    const oldId = state.actions()[0]!.id; state = service(dir); state.record(contact, episode, [draft(20), draft(10)]);
    assert.deepEqual(amounts(state), [10, 20]); assert.equal(state.actions().find(action => action.amount === 10)!.id, oldId);
    state.record(contact, episode, [draft(10), draft(20)]); assert.equal(state.events().length, 2);
    assert.deepEqual(amounts(service(dir)), [10, 20]);
});

test('真实承诺进度EIO后重新抽取顺序变化，两笔事实都持久且进度完成后不再重复抽', async () => {
    const root = temp(), state = service(join(root, 'world')), dir = join(root, 'promises'); let extracts = 0;
    const keeper = promiseKeeper({ contacts: [contact], history: { load: () => chat }, dir, names: () => ({ char: 'Synthetic Character', user: contact.name }),
        now: () => now, log() {}, onWorldActions: state.record,
        extract: async () => JSON.stringify({ add: [], resolved: [], world: ++extracts === 1 ? [draft(10)] : [draft(20), draft(10)] }) });
    const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = ((from, to) => {
            if (String(to) === join(dir, '10001-boyfriend.json')) throw Object.assign(new Error('synthetic progress IO'), { code: 'EIO' }); return rename(from, to);
        }) as typeof rename;
        await keeper.sync(); assert.deepEqual(amounts(state), [10]);
        fileOps.renameSync = rename; fileOps.writeDelaysMs = delays;
        await keeper.sync(); await keeper.sync(); assert.equal(extracts, 2);
        assert.deepEqual(amounts(state), [10, 20]); assert.deepEqual(amounts(service(join(root, 'world'))), [10, 20]);
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; await keeper.stop(); }
});

for (const restart of [false, true]) test(`events落盘后actions投影EIO，重排重试仍补齐第二笔 restart=${restart}`, () => {
    const dir = temp(); let state = service(dir); const rename = fileOps.renameSync, delays = fileOps.writeDelaysMs;
    try {
        fileOps.writeDelaysMs = [0]; fileOps.renameSync = ((from, to) => {
            if (String(to) === join(dir, 'actions.json')) throw Object.assign(new Error('synthetic projection IO'), { code: 'EIO' }); return rename(from, to);
        }) as typeof rename;
        assert.throws(() => state.record(contact, episode, [draft(10)]));
        assert.equal(JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8')).events.length, 1);
        fileOps.renameSync = rename; fileOps.writeDelaysMs = delays;
        if (restart) state = service(dir);
        state.record(contact, episode, [draft(20), draft(10)]); assert.deepEqual(amounts(state), [10, 20]);
        assert.deepEqual(amounts(service(dir)), [10, 20]);
    } finally { fileOps.renameSync = rename; fileOps.writeDelaysMs = delays; }
});

test('旧索引ID成功事件保持原ID，不生成同义副本，同时允许新不同金额', () => {
    const dir = temp(), oldId = `${contact.qq}:${episode.id}:1:receive_money`;
    writeFileSync(join(dir, 'actions.json'), JSON.stringify({ actions: [{ id: oldId, kind: 'receive_money', day: '2026-11-05',
        at: '2026-11-05T10:01', contact: contact.qq, episode: episode.id, amount: 10 }] }));
    const state = service(dir); state.record(contact, episode, [draft(20), draft(10)]);
    assert.deepEqual(amounts(state), [10, 20]); assert.equal(state.actions().find(action => action.amount === 10)!.id, oldId);
    assert.equal(service(dir).events().length, 2);
});

test('保留同日同联系人同金额合并政策，另一联系人同金额仍独立计入', () => {
    const state = service(temp()); state.record(contact, episode, [draft(10), draft(10)]);
    state.record(contact, { ...episode, id: 'ep-another' }, [draft(10)]);
    state.record({ ...contact, qq: 10002 }, episode, [draft(10)]);
    assert.deepEqual(amounts(state), [10, 10]); assert.equal(state.events().length, 2);
});
