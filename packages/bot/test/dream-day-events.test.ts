// 做梦用的「白天的事」（2026-11-22 修）：原来读生活事件的 .text（没有这个字段），夜里和午睡的梦一直没有白天的素材
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dreamDayEvents } from '../src/life/dream-jobs.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { worldHighlights } from '../src/world/highlights.ts';
import type { LifeEvent } from '../src/world/life-events.ts';
import { worldAt as realWorldAt } from '../src/world/world.ts';
import { syntheticCardPath } from './fixtures/card.ts';

const at = new Date(2026, 10, 4, 2, 30);
const event = (id: string, endedAt: Date, extra: Partial<LifeEvent> = {}): LifeEvent => ({
    id, actor: 'linmengyao', kind: 'work_on_project', day: '2026-11-03', startedAt: new Date(endedAt.getTime() - 3_600_000).toISOString(), endedAt: endedAt.toISOString(),
    source: 'life', result: 'succeeded', subject: `做了${id}`, ...extra,
} as LifeEvent);

test('她自己做成的事进来：失败 / 被打断 / 没 subject / 只是编号（course-5、lunch）/ 还没结束 / 一天半以前的都不要；旧到新、去重、最多 limit 条', () => {
    const events = [
        event('a', new Date(2026, 10, 3, 15)),
        event('b', new Date(2026, 10, 3, 20)),
        event('fail', new Date(2026, 10, 3, 21), { result: 'failed' }),
        event('cut', new Date(2026, 10, 3, 21), { result: 'interrupted' }),
        event('blank', new Date(2026, 10, 3, 21), { subject: '  ' }),
        event('later', new Date(2026, 10, 4, 9)),
        event('old', new Date(2026, 10, 1, 9)),
        event('b2', new Date(2026, 10, 3, 22), { subject: '做了b' }),
        event('course', new Date(2026, 10, 3, 10), { kind: 'attend_class', subject: 'course-5' }),
        event('meal', new Date(2026, 10, 3, 12), { kind: 'eat', subject: 'lunch' }),
    ];
    assert.deepEqual(dreamDayEvents(events, undefined, at, 8), ['做了a', '做了b']);
    assert.deepEqual(dreamDayEvents(events, undefined, at, 1), ['做了b']);
    assert.deepEqual(dreamDayEvents([], undefined, at, 8), []);
});

test('世界账里今天已经发生的也进来（和 NOW.md「最近」同一份投影），和她做的事按时间合在一起', () => {
    const card = loadCharacterCard(syntheticCardPath('boyfriend'));
    const when = new Date(2026, 9, 29, 23, 30);
    const world = realWorldAt(card.herWorld!, card.schedule!, when);
    const seen = worldHighlights(world, when, 8).map(item => item.text);
    assert.ok(seen.length > 0, '合成世界这一刻有已经发生的事');
    const out = dreamDayEvents([event('p', new Date(2026, 9, 29, 22))], world, when, 8);
    assert.ok(out.includes('做了p'));
    for (const text of seen) assert.ok(out.includes(text), text);
});
