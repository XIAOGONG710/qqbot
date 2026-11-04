import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseAt, type LifeSources } from '../src/world/life-selector.ts';
import type { Schedule } from '../src/life/schedule.ts';
import type { WorldNow } from '../src/world/world.ts';

const at = (clock: string) => new Date(`2026-11-05T${clock}:00+08:00`);
const schedule: Schedule = { sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' } }, semester: { start: '2026-09-07', weeks: 20 },
    holidays: [], makeups: [], courses: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} },
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍' };
const social = (id: string, time: string, person: string): WorldNow['events'][number] => ({ id, text: '合成社交', at: at(time), person: { id: person, name: '合成朋友', relation: '朋友' } });
const sources = (events: WorldNow['events'], dates?: WorldNow['dates']): LifeSources => ({ schedule, books: [], events: () => [],
    worldAt: now => ({ day: '2026-11-05', atSchool: true, parcels: [], homework: [], events: events.filter(e => e.at <= now), dates,
        routine: { meals: [{ kind: 'lunch', start: at('12:00'), end: at('12:30'), where: 'canteen' }, { kind: 'dinner', start: at('17:50'), end: at('18:20'), where: 'canteen' }] } }) });
const target = (clock: string, source: LifeSources) => {
    const choice = chooseAt(at(clock), source);
    assert.ok('intent' in choice);
    assert.equal(choice.intent.kind, 'eat');
    return choice.intent.target;
};

test('晚饭社交不冒充午饭同伴，晚饭自身保留正确 NPC 目标', () => {
    const s = sources([social('spicy_noodles', '17:50', 'dinner-friend')]);
    assert.equal(target('12:00', s), undefined);
    assert.equal(target('17:50', s), 'dinner-friend');
});

test('同一天午晚饭不同朋友时分别关联，不按全日第一条社交复用', () => {
    const s = sources([social('lunch_with_friend', '12:00', 'lunch-friend'), social('spicy_noodles', '17:50', 'dinner-friend')]);
    assert.equal(target('12:00', s), 'lunch-friend');
    assert.equal(target('17:50', s), 'dinner-friend');
    assert.equal(target('12:10', s), 'lunch-friend');
});

test('晚饭食堂约不变成午饭同伴，迟到吃饭也关联实际那顿已举行的约', () => {
    const dates: WorldNow['dates'] = [{ id: 'meal-date', held: true, kind: 'dinner', start: at('17:50'), minutes: 30,
        person: { id: 'dated-friend', name: '合成朋友', relation: '朋友' }, what: '吃饭', doing: '吃饭', askedAt: at('10:00'), outcome: 'on_time' }];
    const s = sources([], dates);
    assert.equal(target('12:00', s), undefined);
    assert.equal(target('17:50', s), 'dated-friend');
    assert.equal(target('18:00', s), 'dated-friend');
});

test('饭后叙事钟点不等于实际饭点，显式午饭事实仍进入午饭且不串到晚饭', () => {
    const s = sources([{ ...social('lunch_with_friend', '16:00', 'lunch-friend'), mealKind: 'lunch' }]);
    assert.equal(target('12:00', s), 'lunch-friend');
    assert.equal(target('12:10', s), 'lunch-friend');
    assert.equal(target('17:50', s), undefined);
});
