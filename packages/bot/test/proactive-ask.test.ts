import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/history.ts';
import {
    ASK_MAX_PER_WEEK, ASK_MIN_GAP_DAYS, blockReason, candidatesOn, occasionNote, OCCASIONS, REACH_DECLINE, withAsk, withReach,
    type Candidate, type ProactiveInput, type ProactiveRecord,
} from '../src/proactive.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// ADR 0116：问问他的意见（配置 proactiveAsk）
const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const HOUR = 3_600_000;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
let nextId = 1;
const user = (time: number, content: string): StoredMessage => ({ time: new Date(time).toISOString(), role: 'user', content, messageId: nextId++ });
const her = (time: number, content: string): StoredMessage => ({ time: new Date(time).toISOString(), role: 'assistant', content, messageId: nextId++ });
const record = (id: string, at: number): ProactiveRecord => ({ id, occasion: id.split(':')[1] as ProactiveRecord['occasion'], plannedAt: new Date(at).toISOString(), at: new Date(at).toISOString(), result: 'sent' });
const on = withAsk(boyfriend.proactive!);
const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({ qq: 10001, schedule, settings: on, dates: [], history: [], records: [], mode: 'on', ...patch });
const askOf = (list: Candidate[]) => list.find(c => c.occasion === 'ask');
const firstAsk = () => { for (let i = 0; i < 40; i++) { const c = askOf(candidatesOn(new Date(2026, 9, 9 + i), input())); if (c) return c; } throw new Error('no ask'); };

describe('问问他的意见：什么时候', () => {
    test('withAsk 只加 ask；优先级在约他之后、随口说件事之前；没开就没有', () => {
        assert.ok(!boyfriend.proactive!.occasions.includes('ask') && on.occasions.includes('ask'));
        assert.deepEqual(withAsk(on).occasions, on.occasions);
        assert.ok(OCCASIONS.indexOf('ask') > OCCASIONS.indexOf('invite') && OCCASIONS.indexOf('ask') < OCCASIONS.indexOf('share'));
        assert.equal(askOf(candidatesOn(new Date(2026, 9, 10), input({ settings: boyfriend.proactive! }))), undefined);
    });

    test('120 天里约 28–32% 的天有；下午 14:30 到傍晚；同一天每次一样', () => {
        const days = Array.from({ length: 120 }, (_, i) => new Date(2026, 9, 1 + i));
        const hits = days.map(d => ({ d, c: askOf(candidatesOn(d, input())) })).filter(x => x.c);
        assert.ok(hits.length >= 22 && hits.length <= 52, `${hits.length}`);
        for (const { d, c } of hits) {
            assert.ok(c!.at >= new Date(d.getFullYear(), d.getMonth(), d.getDate(), 14, 30).getTime() && c!.at < new Date(d.getFullYear(), d.getMonth(), d.getDate(), 17, 1).getTime());
        }
        assert.deepEqual(askOf(candidatesOn(hits[0]!.d, input())), askOf(candidatesOn(hits[0]!.d, input())));
    });

    test('不勉强：任意 7 天最多 ASK_MAX_PER_WEEK 次、两次之间至少隔 ASK_MIN_GAP_DAYS 天', () => {
        const records: ProactiveRecord[] = [];
        const days: Date[] = [];
        for (let i = 0; i < 150; i++) {
            const d = new Date(2026, 9, 1 + i);
            const c = askOf(candidatesOn(d, input({ records })));
            if (c) { days.push(d); records.push(record(c.id, c.at)); }
        }
        assert.ok(days.length > 20);
        for (let i = 1; i < days.length; i++) assert.ok((days[i]!.getTime() - days[i - 1]!.getTime()) / (24 * HOUR) >= ASK_MIN_GAP_DAYS);
        for (const d of days) assert.ok(days.filter(x => x.getTime() >= d.getTime() && x.getTime() < d.getTime() + 7 * 24 * HOUR).length <= ASK_MAX_PER_WEEK);
    });
});

describe('问问他的意见：到点再查和提示词', () => {
    test('他刚说过去忙 / 在忙 / 累了、下午晚上有事、太晚了：不问；其余可以', () => {
        const c = firstAsk();
        const now = c.at;
        assert.equal(blockReason(c, now, input()), undefined);
        assert.equal(blockReason(c, now, input({ history: [user(now - 2.5 * HOUR, '我先去忙了'), her(now - 2.5 * HOUR + 60_000, '好')] })), '他刚说过去忙 / 去睡了，不问');
        assert.equal(blockReason(c, now, input({ history: [user(now - 2 * HOUR, '今天好累'), her(now - 2 * HOUR + 60_000, '抱抱')] })), '他刚说过在忙 / 累了 / 没空，不问');
        assert.equal(blockReason(c, now, input({ history: [user(now - 5 * HOUR, '今天好累'), her(now - 5 * HOUR + 60_000, '抱抱')] })), undefined, '5 小时前说的不算');
        const follow = { id: 'f', what: '面试', date: c.day, time: 'evening', episode: 'x' };
        assert.equal(blockReason(c, now, input({ followUps: [follow] })), '他下午 / 晚上有事，不问');
        assert.equal(blockReason(c, now, input({ followUps: [{ ...follow, time: 'morning' }] })), undefined);
        const late = new Date(c.at); late.setHours(21, 5);
        assert.equal(blockReason(c, late.getTime(), input()), '太晚了，不问他');
    });

    test('他没回这个问题：她不催（reach 不接）', () => {
        const withBoth = withAsk(withReach(boyfriend.proactive!));
        const state = (id: string) => ({ settings: withBoth, history: [user(t(10, 5, 11, 0), '我去忙一下'), her(t(10, 5, 11, 1), '好'), her(t(10, 5, 15, 30), '晚上吃啥')], records: [record(id, t(10, 5, 15, 30))] });
        const reachOf = (s: ReturnType<typeof state>) => candidatesOn(new Date(2026, 9, 5), input(s)).filter(c => c.occasion === 'reach');
        assert.equal(reachOf(state('2026-10-05:ask')).length, 0);
        assert.ok(reachOf(state('2026-10-05:share')).length > 0, '对照：随口说的那条没回照样催');
    });

    test('提示词：只问小事、选项最多两个、不考知识、不让他替她做大决定；难过 / 累可以只输出「不发」；开头不叫名字', () => {
        const note = occasionNote(firstAsk(), '宝宝');
        for (const word of ['想随口问问宝宝的意见', '选项最多两个', '不是考他知识', '别让他替你做大决定', '没有合适的就问晚上吃什么', `只输出「${REACH_DECLINE}」两个字`, '开头直接说事']) assert.ok(note.includes(word), word + '\n' + note);
    });
});
