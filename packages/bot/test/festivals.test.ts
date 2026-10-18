import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { festivalActivities, festivalDays, festivalYears, solarTerm, withFestivalActivities, withFestivals, FESTIVAL_MODES } from '../src/festivals.ts';
import { stateAt } from '../src/schedule.ts';
import { candidatesOn, dayMatches, type ImportantDay, type ProactiveInput } from '../src/proactive.ts';
import { describeDays } from '../src/time-context.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const at = (text: string) => new Date(text);
const dateOf = (days: ImportantDay[], name: string, year: number) => days.find(d => d.name === name && d.year === year)?.date;
const input = (dates: ImportantDay[]): ProactiveInput => ({
    qq: 10001, schedule: boyfriend.schedule!, settings: boyfriend.proactive!, dates, history: [], records: [], mode: 'on',
});

describe('公共节日（ADR 0076）：换算成公历', () => {
    const days = festivalDays([2026, 2027, 2028], 'greet');

    test('农历的节日落在对的公历日（对照万年历）', () => {
        assert.equal(dateOf(days, '中秋节', 2026), '09-25', '和课表里的中秋假一致');
        assert.equal(dateOf(days, '春节', 2027), '02-06');
        assert.equal(dateOf(days, '除夕', 2027), '02-05');
        assert.equal(dateOf(days, '元宵节', 2027), '02-20');
        assert.equal(dateOf(days, '端午节', 2027), '06-09');
        assert.equal(dateOf(days, '七夕', 2027), '08-08');
        assert.equal(dateOf(days, '中秋节', 2027), '09-15');
        assert.equal(dateOf(days, '春节', 2028), '01-26');
        assert.equal(dateOf(days, '除夕', 2028), '01-25');
    });

    test('春节按公布的日子，Intl 差一天的年份（2027、2030）也对', () => {
        const spring = (y: number, name: string) => dateOf(festivalDays([y], 'greet'), name, y);
        assert.deepEqual([2026, 2027, 2028, 2029, 2030, 2031].map(y => spring(y, '春节')), ['02-17', '02-06', '01-26', '02-13', '02-03', '01-23']);
        assert.deepEqual([2026, 2027, 2028, 2029, 2030].map(y => spring(y, '元宵节')), ['03-03', '02-20', '02-09', '02-27', '02-17']);
        // 端午、七夕、中秋靠 Intl，逐年对公布的日子
        assert.deepEqual([2026, 2027, 2028, 2029, 2030].map(y => spring(y, '端午节')), ['06-19', '06-09', '05-28', '06-16', '06-05']);
        assert.deepEqual([2026, 2027, 2028, 2029, 2030].map(y => spring(y, '七夕')), ['08-19', '08-08', '08-26', '08-16', '08-05']);
        assert.deepEqual([2026, 2027, 2028, 2029, 2030].map(y => spring(y, '中秋节')), ['09-25', '09-15', '10-03', '09-22', '09-12']);
    });

    test('节气：冬至、清明按公式算，对得上历年的日子', () => {
        assert.equal(solarTerm(2026, '冬至'), '12-22');
        assert.equal(solarTerm(2027, '冬至'), '12-22');
        assert.equal(solarTerm(2028, '冬至'), '12-21');
        assert.equal(solarTerm(2026, '清明'), '04-05');
        assert.equal(solarTerm(2027, '清明'), '04-05');
        assert.equal(solarTerm(2028, '清明'), '04-04');
    });

    test('公历的节日每年那一天，每条只在自己那一年算', () => {
        assert.equal(dateOf(days, '平安夜', 2026), '12-24');
        assert.equal(dateOf(days, '情人节', 2027), '02-14');
        const eve2026 = days.find(d => d.name === '平安夜' && d.year === 2026)!;
        assert.equal(dayMatches(eve2026, new Date(2026, 11, 24)), 'solar');
        assert.equal(dayMatches(eve2026, new Date(2027, 11, 24)), undefined, '换了一年就不是这一条');
        // 春节 2027 是 2 月 6 日；2028 年的 2 月 6 日不是
        const spring = days.find(d => d.name === '春节' && d.year === 2027)!;
        assert.equal(dayMatches(spring, new Date(2028, 1, 6)), undefined);
    });

    test('每年每个节日一条；off 没有', () => {
        assert.equal(days.length, 19 * 3);
        assert.deepEqual(festivalDays([2026], 'off'), []);
        assert.deepEqual([...FESTIVAL_MODES], ['off', 'notes', 'greet']);
        assert.deepEqual(festivalYears(new Date(2026, 9, 19)), [2026, 2027, 2028]);
    });

    test('notes 里每个都只在时间块出现；greet 里只有情侣之间一定会说一句的主动说', () => {
        assert.ok(festivalDays([2027], 'notes').every(d => d.silent && !d.midnight));
        const greet = festivalDays([2027], 'greet').filter(d => !d.silent);
        assert.deepEqual(greet.map(d => d.name), ['元旦', '除夕', '春节', '元宵节', '情人节', '520', '端午节', '七夕', '中秋节', '平安夜']);
        assert.deepEqual(greet.filter(d => d.midnight).map(d => d.name), ['元旦', '春节'], '零点第一个说的只有新年两头');
    });
});

describe('公共节日：时间块', () => {
    const days = festivalDays([2026, 2027], 'notes');

    test('提前几天起提醒，当天说今天', () => {
        assert.equal(describeDays(days, at('2026-12-20T12:00:00')), undefined);
        assert.equal(describeDays(days, at('2026-12-21T12:00:00')), '[明天是冬至（北方吃饺子）]\n[再过 3 天（12月24日）是平安夜（年轻人爱互送苹果）]');
        assert.equal(describeDays(days, at('2026-12-23T12:00:00')), '[明天是平安夜（年轻人爱互送苹果）]');
        assert.equal(describeDays(days, at('2026-12-24T21:00:00')), '[今天是平安夜（年轻人爱互送苹果）]\n[明天是圣诞节]');
    });

    test('跨年：12 月 30 日已经看得到元旦', () => {
        assert.equal(describeDays(days, at('2026-12-30T12:00:00')), '[明天是跨年夜（等零点，说新年快乐）]\n[后天是元旦（新年第一天）]');
    });

    test('除夕和春节提前一个星期', () => {
        const text = describeDays(days, at('2027-01-30T12:00:00'))!;
        assert.ok(text.includes('再过 6 天（2月5日）是除夕（一家人吃年夜饭、看春晚）'), text);
        assert.ok(text.includes('再过 7 天（2月6日）是春节（新年第一天，拜年）'), text);
    });
});

describe('公共节日：主动说', () => {
    const greetDays = festivalDays([2026, 2027], 'greet');

    test('平安夜：并进当天的早安，一条', () => {
        const list = candidatesOn(new Date(2026, 11, 24), input(greetDays)).filter(c => c.occasion === 'dates');
        assert.equal(list.length, 1);
        assert.deepEqual(list[0]!.importantDays!.map(d => d.name), ['平安夜']);
        assert.equal(list[0]!.id, '2026-12-24:dates');
    });

    test('新年：12 月 31 日夜里零点第一个说', () => {
        const list = candidatesOn(new Date(2026, 11, 31), input(greetDays)).filter(c => c.occasion === 'dates');
        assert.equal(list.length, 1);
        assert.equal(list[0]!.id, '2026-12-31:dates:midnight');
        assert.deepEqual(list[0]!.importantDays!.map(d => d.name), ['元旦']);
        // 12-31 白天只是跨年夜（只在时间块里），不另发
        assert.equal(candidatesOn(new Date(2026, 11, 31), input(greetDays)).filter(c => c.occasion === 'dates' && !c.id.endsWith(':midnight')).length, 0);
    });

    test('notes 模式、没人说的节日（万圣节、双十一、冬至）不发', () => {
        const notes = festivalDays([2026, 2027], 'notes');
        for (const [m, d] of [[12, 24], [12, 31], [11, 11], [10, 31], [12, 22]] as const) {
            assert.equal(candidatesOn(new Date(2026, m - 1, d), input(notes)).filter(c => c.occasion === 'dates').length, 0, `${m}-${d}`);
        }
        for (const [m, d] of [[11, 11], [10, 31], [12, 22]] as const) {
            assert.equal(candidatesOn(new Date(2026, m - 1, d), input(greetDays)).filter(c => c.occasion === 'dates').length, 0, `greet ${m}-${d}`);
        }
    });

    test('卡上自己的日子（生日）不受影响，和节日同一天并成一条', () => {
        const mixed = [...boyfriend.dates, ...greetDays];
        const july = candidatesOn(new Date(2027, 6, 17), input(mixed)).filter(c => c.occasion === 'dates');
        assert.equal(july.length, 1);
        assert.deepEqual(july[0]!.importantDays!.map(d => d.name), ['你的生日', '你们在一起的纪念日']);
    });
});

describe('公共节日：并进卡', () => {
    test('并两次不重复；off 原样；卡上自己的日子留着', () => {
        const now = new Date(2026, 9, 19);
        const once = withFestivals(boyfriend.dates, now, 'greet');
        assert.equal(withFestivals(once, now, 'greet').length, once.length);
        assert.equal(withFestivals(boyfriend.dates, now, 'off').length, boyfriend.dates.length);
        assert.deepEqual(once.slice(0, 3).map(d => d.name), ['你的生日', '你们在一起的纪念日', '他的生日']);
        assert.equal(once.length, boyfriend.dates.length + 19 * 3);
    });
});

describe('公共节日：那一天她在做的事', () => {
    const schedule = structuredClone(boyfriend.schedule!);
    const state = (text: string) => stateAt(schedule, new Date(text));
    const doing = (text: string) => { const a = state(text).activity; return a.kind === 'free' ? a.text : undefined; };

    test('没开节日时晚上照旧从空闲活动里挑', () => {
        assert.ok(!doing('2026-12-24T21:00:00')?.includes('分苹果'));
    });

    test('开着：平安夜晚上在学校，只从节日的事里挑；在家的那条不会出现', () => {
        withFestivalActivities(schedule, new Date(2026, 9, 19), 'notes');
        assert.equal(doing('2026-12-24T21:00:00'), '跟室友分苹果，看她们拍照');
        assert.equal(doing('2026-12-23T21:00:00')?.includes('苹果'), false, '别的日子不受影响');
    });

    test('除夕在寒假（在家）：整天都是过年的事；寒假里别的日子用在家的那份', () => {
        withFestivalActivities(schedule, new Date(2026, 9, 19), 'greet');
        assert.equal(doing('2027-02-05T10:00:00'), '在家帮着收拾，准备过年');
        assert.equal(doing('2027-02-05T15:00:00'), '在家跟爸妈一起包饺子');
        assert.equal(doing('2027-02-05T20:00:00'), '跟爸妈一起看春晚');
        assert.ok(/^(在家|在追|打独立|跟爸妈|刷手机|陪妈妈|在房间)/.test(doing('2027-01-20T21:00:00')!), doing('2027-01-20T21:00:00'));
    });

    test('活动表按年份写成公历那天；off 没有', () => {
        assert.ok(festivalActivities([2027], 'greet').some(item => item.date === '2027-02-06' && item.window === 'afternoon'));
        assert.deepEqual(festivalActivities([2027], 'off'), []);
    });
});
