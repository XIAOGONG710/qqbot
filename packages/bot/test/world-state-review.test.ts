import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import type { Schedule } from '../src/life/schedule.ts';
import { fileOps } from '../src/memory/json-file.ts';
import { splitEpisodes } from '../src/memory/episodes.ts';
import { parseWorld, worldAt, worldState, type World, type WorldAction } from '../src/world/world.ts';
import type { LifeEventDraft } from '../src/world/life-events.ts';

const dirs: string[] = [];
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-world-review-')); dirs.push(dir); return dir; };
const originalRename = fileOps.renameSync;
afterEach(() => { fileOps.renameSync = originalRename; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = (text: string) => new Date(`${text}+08:00`);
const now = at('2026-11-05T14:00:00');
const schedule: Schedule = { sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' } }, semester: { start: '2026-10-26', weeks: 20 },
    holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍' };
const base: World = { startDay: '2026-11-01', awayHolidays: [], events: [], people: [] };
const catWorld: World = { ...base, cat: { name: '测试猫', feed: ['19:00', '20:00'], seenChance: 1, food: { bagDays: 10, left: 1, reorderAt: 1 } } };
const first: LifeEventDraft = { id: 'first', kind: 'feed_cat', at: at('2026-11-05T10:00:00').toISOString(), source: 'external', result: 'succeeded' };
const second: LifeEventDraft = { id: 'second', kind: 'rest', at: at('2026-11-05T11:00:00').toISOString(), source: 'external', result: 'succeeded' };
const storedIds = (dir: string) => JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8')).events.map((event: { id: string }) => event.id);

for (const restart of [false, true]) test(`兼容投影写失败不丢已持久事实，后续写入与重试幂等 restart=${restart}`, () => {
    const dir = fixture(); let state = worldState(catWorld, schedule, () => {}, dir, () => now.getTime());
    fileOps.renameSync = (from, to) => { if (to === join(dir, 'actions.json')) throw new Error('合成投影写失败'); return originalRename(from, to); };
    assert.throws(() => state.recordEvents([first]));
    assert.deepEqual(storedIds(dir), ['first']);
    assert.deepEqual(state.events().map(e => e.id), ['first']);
    fileOps.renameSync = originalRename;
    if (restart) state = worldState(catWorld, schedule, () => {}, dir, () => now.getTime());
    state.recordEvents([first]);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'actions.json'), 'utf8')).actions.map((action: { id: string }) => action.id), ['first']);
    state.recordEvents([second]);
    assert.deepEqual(storedIds(dir), ['first', 'second']);
    state.recordEvents([first, second]);
    assert.deepEqual(storedIds(dir), ['first', 'second']);
    assert.deepEqual(worldState(catWorld, schedule, () => {}, dir, () => now.getTime()).events().map(e => e.id), ['first', 'second']);
});

const cameraWorld: World = { ...base, startDay: '2026-11-05', cameraFund: { goal: 100, saved: 0, weekly: 0, depositDay: 7,
    purchase: { date: '2026-11-05', from: '12:00', minutes: 30, where: '测试市场', what: '测试相机', price: 100 } } };
const gift = (time: string): WorldAction => ({ id: 'gift', kind: 'receive_money', day: '2026-11-05', at: `2026-11-05T${time}`, contact: 1, episode: 'ep-1', amount: 100, target: 'camera_fund' });
test('出门后收到的钱不能倒填先前购买；出门前资金够时仍按既定行程买', () => {
    const late = worldAt(cameraWorld, schedule, at('2026-11-05T13:10:00'), [gift('13:00')])!;
    assert.equal(late.cameraFund!.camera, undefined);
    assert.equal(late.cameraFund!.saved, 100);
    const early = worldAt(cameraWorld, schedule, at('2026-11-05T13:10:00'), [gift('11:00')])!;
    assert.equal(early.cameraFund!.camera!.state, 'bought');
    assert.equal(early.cameraFund!.camera!.start.getTime(), at('2026-11-05T12:00:00').getTime());
});

test('猫粮到站未取前不计入库存，实际取件时才增加', () => {
    const before = worldAt(catWorld, schedule, at('2026-11-03T11:00:00'))!;
    assert.ok(before.parcels.some(p => p.item === '猫粮' && p.status === 'station'));
    assert.equal(before.cat!.foodDays, 0);
    const saidFed: WorldAction = { id: 'said-fed', kind: 'feed_cat', day: '2026-11-03', at: '2026-11-03T11:00', contact: 1, episode: 'ep-1' };
    assert.equal(worldAt(catWorld, schedule, at('2026-11-03T11:05:00'), [saidFed])!.cat!.foodDays, 0);
    const after = worldAt(catWorld, schedule, at('2026-11-03T12:30:00'))!;
    assert.equal(after.cat!.foodDays, 10);
});

test('上午喂猫不能提前使用中午才取回的粮；口头提前取粮也按实际时刻入库', () => {
    const morning: World = { ...catWorld, cat: { ...catWorld.cat!, feed: ['08:00', '09:00'] } };
    const before = worldAt(morning, schedule, at('2026-11-03T11:00:00'))!;
    assert.deepEqual(before.cat!.today, { skipped: 'no_food' });
    assert.equal(before.cat!.foodDays, 0);
    const pickup: WorldAction = { id: 'pickup', kind: 'pick_parcel', day: '2026-11-03', at: '2026-11-03T11:00', contact: 1, episode: 'ep-1', subject: '猫粮' };
    assert.equal(worldAt(morning, schedule, at('2026-11-03T11:05:00'), [pickup])!.cat!.foodDays, 10);
});

const hwSchedule: Schedule = { ...schedule, courses: [{ day: 4, slot: 'one', weeks: '1-20', kind: 'hard', name: '测试课程' }],
    makeups: [{ date: '2026-11-06', asDay: 4 }] };
const hwWorld: World = { ...base, startDay: '2026-11-05', homework: { kinds: ['hard'], chance: 1, earlyChance: 1 } };
test('课程开始前作业不可见，外部或聊天声称提前写完都不改变它', () => {
    assert.deepEqual(worldAt(hwWorld, hwSchedule, at('2026-11-05T07:00:00'))!.homework, []);
    assert.equal(worldAt(hwWorld, hwSchedule, at('2026-11-05T08:20:00'))!.homework.length, 1);
    const state = worldState(hwWorld, hwSchedule, () => {}, fixture(), () => now.getTime());
    state.recordEvents([{ id: 'too-early', kind: 'finish_homework', subject: '测试课程', at: at('2026-11-05T07:00:00').toISOString(), source: 'external', result: 'succeeded' }]);
    assert.equal(state.events()[0]!.result, 'failed');
    const [episode] = splitEpisodes([{ role: 'user', content: '作业呢', time: at('2026-11-05T07:01:00').toISOString() },
        { role: 'assistant', content: '测试课程作业写完了', time: at('2026-11-05T07:02:00').toISOString() }]);
    state.record({ qq: 1, name: '合成用户', tier: 'boyfriend' }, episode!, [{ kind: 'finish_homework', subject: '测试课程', at: '2026-11-05T07:02' }]);
    assert.equal(state.actions().length, 0);
    state.recordEvents([{ id: 'after-start', kind: 'finish_homework', subject: '测试课程', at: at('2026-11-05T08:21:00').toISOString(), source: 'external', result: 'succeeded' }]);
    assert.equal(state.events().find(e => e.id === 'after-start')!.result, 'succeeded');
});

test('归一化入口拒绝不安全金额和联系人，不写出无法重启的账本', () => {
    const state = worldState(base, schedule, () => {}, fixture(), () => now.getTime());
    for (const amount of [-1, 0, Infinity, Number.MAX_SAFE_INTEGER + 1]) state.recordEvents([{ ...second, id: `amount-${amount}`, amount }]);
    for (const contact of [-1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) state.recordEvents([{ ...second, id: `contact-${contact}`, contact }]);
    assert.deepEqual(state.events(), []);
});

test('世界配置入口校验NPC生活，不把失控月次数留给运行时循环', () => {
    for (const perMonth of [Infinity, 1e9, -1]) assert.throws(() => parseWorld({ ...base,
        people: [{ id: 'synthetic', name: '合成NPC', relation: '同学', life: { sick: { perMonth, days: [2, 4] } } }],
    }, '合成配置'), /people\[0\].life/);
    assert.ok(parseWorld({ ...base, people: [{ id: 'synthetic', name: '合成NPC', relation: '同学', life: { sick: { perMonth: 0, days: [2, 4] } } }] }, '合成配置'));
});
