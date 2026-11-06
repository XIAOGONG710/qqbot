import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import { bodyAt, describeBody } from '../src/life/body.ts';
import { describeNight, HARD_HOURS, lastNight, SLEEPY_HOURS, withLastNight } from '../src/life/nights.ts';
import { classesOn, describeState, stateAt, wakeTime } from '../src/life/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { syntheticCardPath } from './fixtures/card.ts';

// ADR 0219：昨晚真的怎么睡的。她：「那不是从身上长出来的，是我记着的」「别给我按课表编个『早八所以很累』出来，听着假」
const card = loadCharacterCard(syntheticCardPath('boyfriend'));
// 真实卡从 10-26 起起床时间带浮动（ADR 0078），这些测试的前提就是它（按课表的「早八上午困」从此对不上）；合成卡上补同样的设定
const schedule = { ...card.schedule!, wake: { ...card.schedule!.wake, jitter: { from: '2026-10-26', spreadMin: 40, weekendMin: 60 } } };
const body = card.herWorld!.body!;
const HIM = 10001;
const OTHER = 10002;
const msg = (role: 'user' | 'assistant', at: Date, content: string): StoredMessage => ({ time: at.toISOString(), role, content });

/** 11 月里第一个早八的日子、第一个不早起的日子（起床时间按作息算，带浮动） */
function findDay(early: boolean): { day: Date; wake: Date } {
    for (let d = 3; d < 30; d++) {
        const day = new Date(2026, 10, d);
        const wake = wakeTime(schedule, day, classesOn(schedule, day).lessons);
        if ((wake.getHours() < 8) === early) return { day, wake };
    }
    throw new Error('找不到');
}
const at = (base: Date, dayOffset: number, h: number, m = 0) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, h, m);

describe('昨晚真的怎么睡的', () => {
    const { day: earlyDay, wake: earlyWake } = findDay(true);
    const { day: lazyDay } = findDay(false);
    const morning = (day: Date) => at(day, 0, 10, 0);

    test('前一晚 23:20 就说了「睡了」：早八也不困（课表那条拿掉）', () => {
        const his = [msg('user', at(earlyDay, -1, 23, 15), '睡吧'), msg('assistant', at(earlyDay, -1, 23, 20), '嗯 睡了 晚安')];
        const night = lastNight([{ qq: HIM, messages: his }], HIM, schedule, morning(earlyDay))!;
        assert.equal(night.said, true);
        assert.ok(night.hours >= SLEEPY_HOURS, String(night.hours));
        const plain = bodyAt(body, schedule, morning(earlyDay));
        // 原来按课表的「早八上午困」：10-26 起床时间有了浮动（ADR 0078）以后就对不上 07:40 了，早上从来不困（ADR 0219 发现）
        assert.equal(plain.sleepy, undefined, '课表那条已经不起作用');
        assert.equal(withLastNight(plain, night, morning(earlyDay), earlyDay).sleepy, undefined, '睡够了就不困');
    });

    test('跟他聊到 1:40 才说「睡了」：上午困，写明跟他聊到那会儿', () => {
        const his = [msg('user', at(earlyDay, 0, 1, 30), '还不睡'), msg('assistant', at(earlyDay, 0, 1, 40), '我睡了 晚安')];
        const night = lastNight([{ qq: HIM, messages: his }], HIM, schedule, morning(earlyDay))!;
        assert.equal(night.withHim, true);
        assert.ok(night.hours < SLEEPY_HOURS);
        assert.equal(bodyAt(body, schedule, morning(earlyDay)).sleepy, undefined, '没开时：聊到快两点，第二天早上也不困');
        const felt = withLastNight(bodyAt(body, schedule, morning(earlyDay)), night, morning(earlyDay), earlyDay);
        const line = describeBody(felt)!;
        assert.match(line, /昨晚 1:40 睡（跟他聊到那会儿）、今早 \d+:\d\d 起的，上午困/);
        assert.match(line, /不用特意说/, '她的条件：别把「累」弄成一说话就带出来');
        assert.equal(withLastNight(bodyAt(body, schedule, at(earlyDay, 0, 13)), night, at(earlyDay, 0, 13), earlyDay).sleepy, undefined, '睡了 6 个小时左右，过了中午就不困了');
    });

    test('没说「睡了」就按作息（02:00）；半夜被他连着发的消息吵醒：扣 45 分钟，写明被他吵醒', () => {
        const his = [
            msg('user', at(earlyDay, 0, 3, 50), '在吗'), msg('user', at(earlyDay, 0, 3, 52), '睡了吗'), msg('user', at(earlyDay, 0, 3, 55), '醒醒'),
            msg('assistant', at(earlyDay, 0, 3, 56), '？你最好有事'),
        ];
        const night = lastNight([{ qq: HIM, messages: his }], HIM, schedule, morning(earlyDay))!;
        assert.equal(night.said, false);
        assert.deepEqual(night.woken, { at: at(earlyDay, 0, 3, 56).getTime(), byHim: true });
        const expected = (earlyWake.getTime() - at(earlyDay, 0, 2).getTime()) / 3_600_000 - 0.75;
        assert.ok(Math.abs(night.hours - expected) < 0.1, `${night.hours} vs ${expected}`);
        const text = describeNight(night);
        assert.match(text, /昨晚 2:00 睡、半夜 3:56 被他消息吵醒过一次/);
        if (night.hours < HARD_HOURS) {
            assert.match(text, /困得不行，下午可能都缓不过来/);
            assert.ok(withLastNight(bodyAt(body, schedule, at(earlyDay, 0, 14)), night, at(earlyDay, 0, 14), earlyDay).sleepy, '困到下午');
        }
    });

    test('被别人吵醒不算他；不是早起的日子，凌晨一点说睡了就睡够了', () => {
        const other = [msg('user', at(earlyDay, 0, 3, 0), '醒醒'), msg('assistant', at(earlyDay, 0, 3, 5), '干嘛啊')];
        assert.equal(lastNight([{ qq: HIM, messages: [] }, { qq: OTHER, messages: other }], HIM, schedule, morning(earlyDay))!.woken?.byHim, false);
        const his = [msg('assistant', at(lazyDay, 0, 1, 0), '睡了睡了')];
        const night = lastNight([{ qq: HIM, messages: his }], HIM, schedule, at(lazyDay, 0, 11))!;
        assert.ok(night.hours >= SLEEPY_HOURS, String(night.hours));
        assert.equal(withLastNight(bodyAt(body, schedule, at(lazyDay, 0, 11)), night, at(lazyDay, 0, 11), lazyDay).sleepy, undefined);
    });

    test('还没到今早起床（还在夜里）就没有昨晚；过了零点半的困照旧', () => {
        assert.equal(lastNight([{ qq: HIM, messages: [] }], HIM, schedule, at(earlyDay, 0, 5)), undefined);
        const late = bodyAt(body, schedule, at(earlyDay, 1, 0, 50));
        if (late.sleepy?.when === 'late') {
            const night = lastNight([{ qq: HIM, messages: [] }], HIM, schedule, at(earlyDay, 0, 23))!;
            assert.equal(withLastNight(late, night, at(earlyDay, 1, 0, 50), earlyDay).sleepy?.when, 'late');
        }
    });

    test('被吵醒那一下有起床气（她：「先回你个『？』，然后『你最好有事』」）；没开时和原来一样', () => {
        const night = at(earlyDay, 0, 3, 0);
        const state = stateAt(schedule, night);
        assert.equal(state.activity.kind, 'sleep');
        const plain = describeState(state, schedule, { woken: true });
        const grumpy = describeState(state, schedule, { woken: true, grumpy: true });
        assert.ok(plain.includes('被消息震醒了，迷迷糊糊的') && !plain.includes('起床气'));
        assert.ok(grumpy.includes('迷迷糊糊的，有点起床气：回一两句，没正经事就接着睡'), grumpy);
    });
});
