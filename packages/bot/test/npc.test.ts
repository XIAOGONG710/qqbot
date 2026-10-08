import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { npcAllows, npcMentioned, npcSpans, npcStates, type NpcLife } from '../src/npc.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { describeWorld, recapDay, recentWith, worldAt } from '../src/world.ts';

const card = (tier: string) => loadCharacterCard(resolve(import.meta.dirname, `../../../characters/linmengyao/st/linmengyao-${tier}.json`));
const boyfriend = card('boyfriend');
const classmate = card('classmate');
const schedule = boyfriend.schedule!;
const day = (m: number, d: number, y = 2026) => new Date(y, m - 1, d);
const he = (content: string) => ({ role: 'user' as const, content });
const she = (content: string) => ({ role: 'assistant' as const, content });

describe('两位闺蜜自己的日子（ADR 0033）', () => {
    const life: NpcLife = { sick: { perMonth: 0.5, days: [2, 4] }, busy: { perMonth: 0.8, days: [3, 5], labels: ['有考试', '赶作业'] }, home: { weekendChance: 0.4, holidays: true } };
    const year = Array.from({ length: 365 }, (_, i) => day(9, 1 + i));

    test('按日期推，重放一样；一年里病几回、忙几回跟着每月的次数走，每段在天数范围里、一天天往下数', () => {
        assert.deepEqual(npcStates('x', life, schedule, day(10, 19)), npcStates('x', life, schedule, day(10, 19)));
        const spans = npcSpans(year.map(d => ({ day: d, states: npcStates('x', life, schedule, d) })));
        const sick = spans.filter(s => s.kind === 'sick');
        const busy = spans.filter(s => s.kind === 'busy');
        assert.ok(sick.length >= 3 && sick.length <= 9, `一年病 ${sick.length} 回`);
        assert.ok(busy.length >= 6 && busy.length <= 14, `一年忙 ${busy.length} 回`);
        for (const d of year) {
            for (const s of npcStates('x', life, schedule, d)) {
                if (s.kind === 'sick') assert.ok(s.day >= 1 && s.day <= s.of && s.of >= 2 && s.of <= 4);
                if (s.kind === 'busy') assert.ok(s.of >= 3 && s.of <= 5 && life.busy!.labels.includes(s.label));
            }
        }
    });

    test('回家：一个周末要么两天都在家要么都不在；放假都在家；放假不忙', () => {
        for (const d of year.filter(d => d.getDay() === 6)) {
            const home = (x: Date) => npcStates('x', life, schedule, x).some(s => s.kind === 'home');
            assert.equal(home(d), home(day(d.getMonth() + 1, d.getDate() + 1, d.getFullYear())), `${d.toDateString()} 那个周末`);
        }
        assert.ok(npcStates('x', life, schedule, day(10, 3)).some(s => s.kind === 'home'), '国庆');
        for (let d = 1; d <= 7; d++) assert.ok(!npcStates('x', life, schedule, day(10, d)).some(s => s.kind === 'busy'), `10-${d} 放假不忙`);
        assert.deepEqual(npcStates('x', undefined, schedule, day(10, 3)), []);
    });

    test('小事看那人那天：skip_when 有就不发生，only_when 要有其中一个', () => {
        const sick = [{ kind: 'sick' as const, day: 1, of: 3 }];
        assert.equal(npcAllows(sick, ['sick', 'home']), false);
        assert.equal(npcAllows([], ['sick']), true);
        assert.equal(npcAllows([], [], ['sick']), false);
        assert.equal(npcAllows(sick, [], ['sick']), true);
    });

    test('他说起谁：全名、名都算，只看她上次回复之后的', () => {
        const people = boyfriend.herWorld!.people;
        assert.deepEqual(npcMentioned([he('佳宁最近咋样')], people).map(p => p.id), ['chen_jianing']);
        assert.deepEqual(npcMentioned([he('你和苏雨桐还一起吃饭吗')], people).map(p => p.id), ['su_yutong']);
        assert.deepEqual(npcMentioned([he('雨桐呢'), she('她感冒了'), he('那你一个人吃？')], people), []);
        assert.deepEqual(npcMentioned([he('最近忙啥')], people), []);
    });

    // 卡上：苏雨桐 10-18（周日）起感冒 4 天
    test('苏雨桐感冒那几天：「你那边」写她病了，不一起吃饭；问到那天想得起；说起她时知道最近两周', () => {
        const at = new Date(2026, 9, 19, 21, 0);
        const now = worldAt(boyfriend.herWorld!, schedule, at)!;
        assert.match(describeWorld(now, at)!, /朋友：苏雨桐感冒第 2 天/);
        assert.match(recapDay(worldAt(boyfriend.herWorld!, schedule, new Date(2026, 9, 20, 23, 30))!).join('；'), /苏雨桐感冒第 3 天/);
        assert.match(recentWith(boyfriend.herWorld!, schedule, new Date(2026, 9, 23, 20, 0), 'su_yutong')!.join('；'), /10月18日–10月21日感冒/);
        assert.match(recentWith(boyfriend.herWorld!, schedule, at, 'su_yutong')!.join('；'), /10月18日起感冒，还没好/);
        for (let d = 18; d <= 21; d++) {
            const events = worldAt(boyfriend.herWorld!, schedule, new Date(2026, 9, d, 23, 30))!.events.map(e => e.id);
            assert.ok(!events.includes('lunch_with_friend') && !events.includes('spicy_noodles'), `10-${d} 不一起吃`);
        }
    });

    test('整个学期：一起吃饭只在她没病、没回家的日子；拍板书只在她病了的日子', () => {
        const su = boyfriend.herWorld!.people.find(p => p.id === 'su_yutong')!;
        const timelineDays = Array.from({ length: 120 }, (_, i) => day(9, 1 + i));
        let notes = 0;
        for (const d of timelineDays) {
            const states = npcStates('su_yutong', su.life, schedule, d).map(s => s.kind);
            const events = worldAt(boyfriend.herWorld!, schedule, new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 30))!.events.map(e => e.id);
            if (events.includes('lunch_with_friend')) assert.ok(!states.includes('sick') && !states.includes('home'), d.toDateString());
            if (events.includes('notes_for_friend')) { notes++; assert.ok(states.includes('sick'), d.toDateString()); }
        }
        assert.ok(notes >= 1, '病的那几天有课的日子里至少拍过一回板书');
    });

    test('同学档：看不到闺蜜，也就没有她们的日子', () => {
        const at = new Date(2026, 9, 19, 21, 0);
        const now = worldAt(classmate.herWorld!, classmate.schedule!, at)!;
        assert.equal(now.people, undefined);
        assert.doesNotMatch(describeWorld(now, at) ?? '', /苏雨桐|陈佳宁/);
        assert.equal(recentWith(classmate.herWorld!, classmate.schedule!, at, 'su_yutong'), undefined);
    });
});
