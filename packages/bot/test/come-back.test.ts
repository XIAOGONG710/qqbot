import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/history.ts';
import {
    BACK_MIN, blockReason, candidatesOn, occasionNote, planFrom, stepsAway, unansweredCount, usedOn, withBack,
    type Candidate, type ProactiveInput, type ProactiveRecord,
} from '../src/proactive.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// ADR 0112：说了“等下”之后自己回来（配置 comeBack）
const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (h: number, m = 0) => new Date(2026, 9, 24, h, m).getTime();
const msg = (role: 'user' | 'assistant', time: number, content: string): StoredMessage => ({ time: new Date(time).toISOString(), role, content });
const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
    qq: 10001, schedule, settings: withBack(boyfriend.proactive!), dates: [], history: [], records: [], mode: 'on', ...patch,
});
const day = new Date(2026, 9, 24);
const backOf = (list: Candidate[]) => list.find(c => c.occasion === 'back');

describe('哪些话算“短暂离开”', () => {
    test('第一人称的等下 / 去做个小事 / 弄完这个再说 / 几分钟就回来 → 是', () => {
        for (const text of ['等下，我去拿外卖', '稍等', '我去倒杯水', '等我一下', '先把这张修完，弄完这张再说', '十分钟就回来', '马上回来', '我去收个快递', '等会儿哈']) {
            assert.equal(stepsAway(text), true, text);
        }
    });

    test('叫他等 / 要走了 / 平常的话 → 不是', () => {
        for (const text of ['你等下，我想想', '晚安，我去睡了', '我去上课了', '明天聊哈', '哈哈哈', '今天吃了黄焖鸡', '我去忙了，先这样']) {
            assert.equal(stepsAway(text), false, text);
        }
    });
});

describe('说了等下之后回来：什么时候、受什么约束', () => {
    const waited = () => [msg('user', t(19, 50), '在干嘛'), msg('assistant', t(20, 0), '等下，我去拿外卖')];

    test('她最后一句是离开、之后没人说话：过 BACK_MIN 分钟回来；同一句每次一样；id 带那句话的时刻', () => {
        const c = backOf(candidatesOn(day, input({ history: waited() })))!;
        assert.ok(c, '有候选');
        assert.ok(c.at >= t(20, BACK_MIN[0]) && c.at <= t(20, BACK_MIN[1]), new Date(c.at).toTimeString());
        assert.equal(c.id, `2026-10-24:back:${t(20, 0)}`);
        assert.equal(backOf(candidatesOn(day, input({ history: waited() })))!.at, c.at);
    });

    test('没开 / 最后一句是他的 / 不是离开的话 / 昨天说的：没有', () => {
        assert.equal(backOf(candidatesOn(day, input({ history: waited(), settings: boyfriend.proactive! }))), undefined, '没开');
        assert.equal(backOf(candidatesOn(day, input({ history: [...waited(), msg('user', t(20, 3), '好')] }))), undefined);
        assert.equal(backOf(candidatesOn(day, input({ history: [msg('assistant', t(20, 0), '今天好累')] }))), undefined);
        assert.equal(backOf(candidatesOn(new Date(2026, 9, 25), input({ history: waited() }))), undefined, '不是那一天');
    });

    test('到点再查：之后有人说了话不回；隔太久不回；不受一小时内聊过、每天条数、他没回的闸管', () => {
        const history = waited();
        const c = backOf(candidatesOn(day, input({ history })))!;
        assert.equal(blockReason(c, c.at, input({ history })), undefined, '刚聊过也照样回来');
        assert.equal(blockReason(c, c.at, input({ history: [...history, msg('user', c.at - 60_000, '嗯')] })), '有没回的消息，回复就好', '他说了话：先回他，不单发“回来了”');
        assert.equal(blockReason(c, c.at, input({ history: [...history, msg('user', c.at - 120_000, '嗯'), msg('assistant', c.at - 100_000, '哦哦')] })), '那句等下之后又说过话了');
        assert.equal(blockReason(c, c.at, input({ history: [...history, msg('assistant', c.at - 60_000, '回来了')] })), '那句等下之后又说过话了');
        assert.match(blockReason(c, t(21, 0), input({ history }))!, /隔太久/);
        // 今天已经发满 + 前面一条主动他没回：照样回来
        const sent: ProactiveRecord[] = ['morning', 'after_class', 'quiet', 'bedtime'].map((o, i) => ({ id: `2026-10-24:${o}`, occasion: o as ProactiveRecord['occasion'], plannedAt: new Date(t(8 + i)).toISOString(), at: new Date(t(8 + i)).toISOString(), result: 'sent' as const }));
        assert.equal(blockReason(c, c.at, input({ history, records: sent })), undefined);
    });

    test('不算每天的主动条数、不算“他没回”的条数；计划里不被每天上限挤掉', () => {
        const history = waited();
        const c = backOf(candidatesOn(day, input({ history })))!;
        const record: ProactiveRecord = { id: c.id, occasion: 'back', plannedAt: new Date(c.at).toISOString(), at: new Date(c.at).toISOString(), result: 'sent' };
        assert.equal(usedOn('2026-10-24', [record]), 0);
        assert.equal(unansweredCount({ history, records: [record], mode: 'on' }), 0);
        const full: ProactiveRecord[] = Array.from({ length: 6 }, (_, i) => ({ id: `2026-10-24:quiet${i}`, occasion: 'quiet' as const, plannedAt: new Date(t(8)).toISOString(), at: new Date(t(8)).toISOString(), result: 'sent' as const }));
        const plan = planFrom(t(20, 1), input({ history, records: full }));
        assert.ok(plan.upcoming.some(x => x.occasion === 'back'), JSON.stringify(plan.upcoming.map(x => x.occasion)));
    });

    test('提示词：回来了、刚才那件事怎么样，只用前面说的和“你现在”写着的，不要他回应', () => {
        const c = backOf(candidatesOn(day, input({ history: waited() })))!;
        const note = occasionNote(c, '宝宝');
        assert.ok(note.includes('现在回来了') && note.includes('说一声回来了') && note.includes('没写的别编') && note.includes('不要他回应'), note);
        assert.ok(note.includes('开头直接说事，别先叫他的名字或昵称'), '也不先叫名字');
    });
});
