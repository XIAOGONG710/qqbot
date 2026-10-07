import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { bodyAt, describeBody, unwell, type Body } from '../src/body.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const card = (tier: string) => loadCharacterCard(resolve(import.meta.dirname, `../../../characters/linmengyao/st/linmengyao-${tier}.json`));
const boyfriend = card('boyfriend');
const classmate = card('classmate');
const schedule = boyfriend.schedule!;
const at = (text: string) => new Date(text);
const line = (body: Body, time: string) => describeBody(bodyAt(body, schedule, at(time)));

describe('她的身体（ADR 0025）', () => {
    test('卡上有：生理期细节只给男朋友、闺蜜、女生朋友档', () => {
        assert.equal(boyfriend.herWorld!.body!.period!.detail, true);
        assert.equal(classmate.herWorld!.body!.period!.detail, false);
        assert.equal(card('girl_friend').herWorld!.body!.period!.detail, true);
        assert.equal(card('known').herWorld!.body!.period!.detail, false);
    });

    test('生理期按周期推：第 1 天疼得厉害、第 2 天隐隐地疼、之后只写第几天；同一天每次一样', () => {
        const body = boyfriend.herWorld!.body!;
        assert.match(line(body, '2026-12-21T21:30:00+08:00')!, /生理期第 1 天，肚子疼得厉害，只想躺着/);
        assert.match(line(body, '2026-12-22T21:30:00+08:00')!, /生理期第 2 天，肚子隐隐地疼，懒得动/);
        assert.match(line(body, '2026-10-22T21:30:00+08:00')!, /生理期第 3 天(｜|\])/);
        assert.equal(line(body, '2026-12-21T21:30:00+08:00'), line(body, '2026-12-21T21:30:00+08:00'));
        assert.ok(!(line(body, '2026-10-26T21:30:00+08:00') ?? '').includes('生理期'), '五天以后没有');
        assert.equal(bodyAt({ period: { ...body.period!, first: '2027-01-01' } }, schedule, at('2026-12-21T21:30:00+08:00')).period, undefined, 'first 之前没有');
    });

    test('说不出口的档位：疼的那两天只说身上不舒服，不疼的日子什么都不写', () => {
        const body = classmate.herWorld!.body!;
        const bad = line(body, '2026-12-21T21:30:00+08:00')!;
        assert.match(bad, /身上不太舒服，只想躺着/);
        assert.doesNotMatch(bad, /生理期|痛经|肚子/);
        assert.match(line(body, '2026-12-22T21:30:00+08:00')!, /身上有点不舒服，懒得动/);
        assert.ok(!(line(body, '2026-10-22T21:30:00+08:00') ?? '').includes('不舒服'));
    });

    test('小感冒：四天里嗓子疼 → 鼻塞 → 快好了', () => {
        const body = boyfriend.herWorld!.body!;
        assert.match(line(body, '2026-11-16T21:30:00+08:00')!, /有点感冒，嗓子疼/);
        assert.match(line(body, '2026-11-17T21:30:00+08:00')!, /感冒第 2 天，鼻塞/);
        assert.match(line(body, '2026-11-19T21:30:00+08:00')!, /感冒快好了，还有点咳/);
        assert.ok(!(line(body, '2026-11-20T21:30:00+08:00') ?? '').includes('感冒'));
        assert.equal(bodyAt({ cold: { perMonth: 0, days: 4 } }, schedule, at('2026-11-16T21:30:00+08:00')).cold, undefined);
    });

    test('困、累、饿按作息：早八那天上午困；过了零点半困；饭点前饿', () => {
        const none: Body = {};
        assert.match(line(none, '2026-10-12T09:30:00+08:00')!, /昨晚 2:00 睡、今早 7:40 起的，上午困/);
        assert.ok(!(line(none, '2026-10-12T13:30:00+08:00') ?? '').includes('困'), '下午不写');
        assert.ok(!(line(none, '2026-10-11T09:30:00+08:00') ?? '').includes('上午困'), '周日没早八');
        assert.match(line(none, '2026-10-12T00:45:00+08:00')!, /过了零点半，有点困了/);
        assert.ok(!(line(none, '2026-10-12T00:10:00+08:00') ?? '').includes('困了'), '零点半以前不写');
        assert.match(line(none, '2026-10-11T11:40:00+08:00')!, /快到饭点了，有点饿/);
        assert.match(line(none, '2026-10-11T17:30:00+08:00')!, /快到饭点了，有点饿/);
    });

    test('身上不舒服：痛经、感冒算，困、饿、没疼的生理期不算（表达层不加「话多」）', () => {
        const body = boyfriend.herWorld!.body!;
        const now = (time: string) => bodyAt(body, schedule, at(time));
        assert.equal(unwell(now('2026-12-21T21:30:00+08:00')), true);
        assert.equal(unwell(now('2026-11-17T21:30:00+08:00')), true);
        assert.equal(unwell(now('2026-10-22T21:30:00+08:00')), false);
        assert.equal(unwell(now('2026-10-12T09:30:00+08:00')), false);
    });

    test('提示词：只有事实和一句约束；什么都没有就不放', () => {
        const text = line(boyfriend.herWorld!.body!, '2026-12-21T21:30:00+08:00')!;
        assert.match(text, /^\[你的身体（事实，影响你说话的劲头和能做的事；不用特意说，他问起或者话赶到了再说，说了就前后一致——不舒服就不会同时疯玩）：/);
        assert.equal(line({}, '2026-10-11T15:00:00+08:00'), undefined);
    });
});
