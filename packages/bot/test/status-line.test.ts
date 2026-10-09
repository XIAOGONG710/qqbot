import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { bodyAt } from '../src/body.ts';
import { readingActivities } from '../src/her-days.ts';
import { herStatus } from '../src/status-line.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { worldAt } from '../src/world.ts';

const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = card.schedule!;
const herWorld = card.herWorld!;
const extraFree = readingActivities(card.books);
const at = (text: string) => new Date(`${text}+08:00`);
const status = (text: string, asleep?: { since: Date; until: Date }) => {
    const time = at(text);
    const world = worldAt(herWorld, schedule, time)!;
    return herStatus(schedule, time, {
        extraFree,
        world,
        ...(asleep ? { asleep } : {}),
        plans: { plans: herWorld.plans, body: bodyAt(herWorld.body!, schedule, time) },
    });
};

describe('统一状态行（ADR 0042）', () => {
    test('世界里的事情覆盖空闲活动，上课不被覆盖', () => {
        const video = status('2026-10-11T20:40:00');
        assert.equal(video.busy, '在和家里视频');
        assert.deepEqual(video.state.activity, { kind: 'free', text: '在和家里视频' });
        assert.equal(video.doing, undefined);

        const inClass = status('2026-10-12T10:00:00');
        assert.equal(inClass.state.activity.kind, 'class');
        assert.equal(inClass.busy, undefined);
    });

    test('改了打算：对外保留原因，生活执行器拿到实际在做的事', () => {
        const rainy = status('2026-10-20T15:00:00');
        assert.equal(rainy.revised, '本来打算在图书馆赶作业，下雨了，在宿舍赶作业');
        assert.deepEqual(rainy.state.activity, { kind: 'free', text: rainy.revised });
        assert.equal(rainy.doing, '在宿舍赶作业');
        assert.ok(rainy.slots.some(slot => slot.done !== slot.planned));
    });

    test('她说过睡了以后，所有联系人看到同一个睡眠状态', () => {
        const since = at('2026-10-13T00:32:00');
        const until = at('2026-10-13T09:30:00');
        const asleep = status('2026-10-13T01:40:00', { since, until });
        assert.deepEqual(asleep.saidAsleep, { since, until });
        assert.deepEqual(asleep.state.activity, { kind: 'sleep', until });
        assert.equal(asleep.busy, undefined);
        assert.equal(asleep.revised, undefined);
        assert.equal(asleep.doing, undefined);
        assert.deepEqual(asleep.slots, []);
    });
});
