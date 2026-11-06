import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { promiseKeeper, type HerPromise } from '../src/life/promises.ts';
import { emptyPromiseState } from '../src/life/promise-state.ts';
import { actionQueue } from '../src/world/action-queue.ts';
import { lifeExecutor, lifeActionId, type LifeSources } from '../src/world/life-selector.ts';
import type { Schedule } from '../src/life/schedule.ts';
import type { LifeEvent } from '../src/world/life-events.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const at = (clock: string) => new Date(`2026-11-05T${clock}:00+08:00`);
function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-meeting-review-')); dirs.push(dir);
    const schedule: Schedule = {
        sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
        periods: { one: { start: '08:20', end: '09:50' }, evening: { start: '19:00', end: '20:00' } },
        semester: { start: '2026-09-07', weeks: 20 }, holidays: [], makeups: [],
        kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
        free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍',
    };
    const state = emptyPromiseState();
    const original: HerPromise = { id: 'p-stable', what: '东门吃饭', date: '2026-11-05', said: '2026-11-05', episode: 'ep-1', meet: { time: '18:00', where: '东门', minutes: 90 } };
    state.promises = [original];
    const save = () => writeFileSync(join(dir, '1-boyfriend.json'), JSON.stringify(state)); save();
    const promises = promiseKeeper({ contacts: [{ qq: 1, name: '测试用户', tier: 'boyfriend' }], names: () => ({ user: '测试用户', char: '测试角色' }),
        history: { load: () => [] }, schedule, dir, now: () => at('17:50').getTime(), log: () => {}, extract: async () => '{"add":[]}' });
    const events: LifeEvent[] = [];
    const sources: LifeSources = { schedule, books: [], worldAt: () => undefined, events: () => events,
        appointmentsBetween: (from, to) => promises.appointmentsBetween(from, to) };
    const path = join(dir, 'queue.json');
    let queue = actionQueue(path);
    let executor = lifeExecutor(sources, queue, { since: at('17:45') });
    return { state, original, save, sources, promises, events, get queue() { return queue; },
        fill: (clock: string) => executor.fill(at(clock)),
        restart: () => { queue = actionQueue(path); executor = lifeExecutor(sources, queue, { since: at('17:45') }); },
    };
}

test('同 ID 改正文及吃饭属性同步到未结算队列，重复推进保持幂等', () => {
    const s = setup(); s.fill('17:46');
    const old = s.queue.pending()[0]!;
    s.state.promises = [{ ...s.original, what: '西门散步', meet: { ...s.original.meet!, where: '西门' } }]; s.save();
    assert.equal(s.promises.appointmentsBetween(at('17:45'), at('20:00'))[0]!.promise.what, '西门散步');
    s.fill('17:50');
    const updated = s.queue.pending()[0]!;
    assert.equal(updated.id, old.id);
    assert.equal(updated.event.startedAt, old.event.startedAt);
    assert.equal(updated.event.subject, '西门散步');
    assert.equal(updated.event.meal, false);
    assert.equal(updated.occupation, '在赴约（西门散步）');
    s.fill('17:51');
    assert.equal(s.queue.pending().length, 1);
    assert.deepEqual(s.queue.pending()[0], updated);
    s.restart(); s.fill('17:52');
    assert.deepEqual(s.queue.pending()[0], updated);
});

test('同 ID 见面延长与缩短采用最新结束时刻，保留已开始的时段', () => {
    const s = setup(); s.fill('17:46');
    const id = s.queue.pending()[0]!.id;
    s.state.promises = [{ ...s.original, meet: { ...s.original.meet!, minutes: 150 } }]; s.save();
    s.fill('17:50');
    assert.equal(s.queue.pending()[0]!.event.at, at('20:30').toISOString());
    assert.equal(s.queue.pending()[0]!.id, id);
    assert.equal(s.queue.pending()[0]!.actualMinutes, 165);
    s.restart();
    s.state.promises = [{ ...s.original, meet: { ...s.original.meet!, minutes: 30 } }]; s.save();
    s.fill('17:55');
    assert.equal(s.queue.pending()[0]!.event.at, at('18:30').toISOString());
    assert.equal(s.queue.pending()[0]!.event.startedAt, at('17:45').toISOString());
    assert.equal(s.queue.pending()[0]!.actualMinutes, 45);
});

test('最新课表硬时段仍截断见面延长，前一段不能结算吃完一顿饭', () => {
    const s = setup(); s.fill('17:46');
    s.sources.schedule.courses.push({ day: 4, slot: 'evening', weeks: '1-20', kind: 'hard', name: '合成课' });
    s.state.promises = [{ ...s.original, meet: { ...s.original.meet!, minutes: 150 } }]; s.save();
    s.fill('17:50');
    const meet = s.queue.pending().find(item => item.kind === 'meet')!;
    assert.equal(meet.event.at, at('19:00').toISOString());
    assert.equal(meet.event.meal, false);
});

test('出门预留期取消不算吃完饭，重启后仍有确定的原见面时刻证据', () => {
    const s = setup(); s.fill('17:46'); s.restart();
    s.state.promises = []; s.save(); s.fill('17:55');
    const meet = s.queue.pending().find(item => item.kind === 'meet')!;
    assert.equal(meet.event.at, at('17:55').toISOString());
    assert.equal(meet.actualMinutes, 10);
    assert.equal(meet.event.meal, false);
});

test('见面开始后取消保持已有吃饭语义，改时间则停止旧时段再排新约', () => {
    const cancelled = setup(); cancelled.fill('17:46');
    cancelled.state.promises = []; cancelled.save(); cancelled.fill('18:30');
    assert.equal(cancelled.queue.pending().find(item => item.kind === 'meet')!.event.meal, true);
    const moved = setup(); moved.fill('17:46');
    const old = moved.queue.pending()[0]!.id;
    moved.state.promises = [{ ...moved.original, meet: { ...moved.original.meet!, time: '19:00' } }]; moved.save();
    moved.fill('17:50');
    assert.equal(moved.queue.pending().find(item => item.id === old)!.event.at, at('17:50').toISOString());
    assert.equal(moved.queue.pending().find(item => item.id === old)!.event.meal, false);
    moved.fill('18:46');
    const fresh = moved.queue.pending().find(item => item.kind === 'meet' && item.id !== old)!;
    assert.equal(fresh.event.startedAt, at('18:45').toISOString());
});

test('取消前尚未出门的计划被去掉，已落账见面不会因后来内容更新被改写', () => {
    const s = setup();
    const id = `${lifeActionId(at('17:45'), 'meet')}:1:${s.original.id}`;
    s.queue.schedule({ id, kind: 'meet', startedAt: at('17:45') }, { schedule: s.sources.schedule,
        appointments: [{ id, start: at('17:45'), end: at('19:30'), subject: '东门吃饭', target: 'contact:1', meal: true }] });
    s.state.promises = []; s.save(); s.fill('17:40');
    assert.deepEqual(s.queue.pending(), []);
    s.state.promises = [s.original]; s.save(); s.fill('17:46');
    s.queue.settleDue(at('19:30'), { events: () => s.events, recordEvents: drafts => {
        for (const draft of drafts) s.events.push({ ...draft, actor: 'linmengyao', day: '2026-11-05', startedAt: draft.startedAt!, endedAt: draft.at });
    } });
    const snapshot = structuredClone(s.events);
    s.state.promises = [{ ...s.original, what: '后来才说的西门吃饭' }]; s.save(); s.fill('19:31');
    assert.deepEqual(s.events, snapshot);
});

test('刷新不会恢复失败或已取消的见面；延长与其他已排计划冲突时保留原计划', () => {
    const s = setup(); s.fill('17:46');
    const item = s.queue.pending()[0]!;
    const latest = { id: item.id, start: at('17:45'), end: at('20:30'), subject: '西门吃饭', target: 'contact:1', meal: true, meetingAt: at('18:00') };
    const context = { schedule: s.sources.schedule };
    s.queue.schedule({ id: 'another-meet', kind: 'meet', startedAt: at('19:45') }, { ...context,
        appointments: [{ id: 'another-meet', start: at('19:45'), end: at('20:45'), subject: '另一条确定计划', target: 'contact:2', meal: false }] });
    const rejected = s.queue.refreshMeeting(latest, context);
    assert.equal(rejected?.ok, false);
    if (rejected && !rejected.ok) assert.equal(rejected.reason, 'conflict');
    assert.deepEqual(s.queue.pending().find(p => p.id === item.id), item);
    s.queue.cancel(item.id, at('17:40'), '未出门前取消');
    const failed = structuredClone(s.queue.pending().find(p => p.id === item.id));
    assert.equal(s.queue.refreshMeeting(latest, context), undefined);
    assert.deepEqual(s.queue.pending().find(p => p.id === item.id), failed);

    const cancelled = setup(); cancelled.fill('17:46');
    const previous = cancelled.queue.pending()[0]!;
    cancelled.state.promises = []; cancelled.save(); cancelled.fill('17:55');
    const stopped = structuredClone(cancelled.queue.pending().find(p => p.id === previous.id));
    assert.equal(cancelled.queue.refreshMeeting({ ...latest, id: previous.id }, { schedule: cancelled.sources.schedule }), undefined);
    assert.deepEqual(cancelled.queue.pending().find(p => p.id === previous.id), stopped);
});
