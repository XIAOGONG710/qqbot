import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/history.ts';
import {
    blockReason, candidatesOn, dayMatches, herDay, lunarMonthDay, parseDates, parseProactive, planFrom, unansweredCount,
    occasionNote, untoldNews, type Candidate, type ProactiveInput, type ProactiveRecord,
} from '../src/proactive.ts';
import { rainingAt, rainOf } from '../src/proactive-planner.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// 用转换器生成的真卡：男朋友档有作息、三个日子和主动设置（四种时机 + 待跟进 + 日子，每天 2 条，1 条没回就停）
const cardPath = (tier: string) => resolve(import.meta.dirname, `../../../characters/linmengyao/st/linmengyao-${tier}.json`);
const boyfriend = loadCharacterCard(cardPath('boyfriend'));
const schedule = boyfriend.schedule!;
/** 本地时间（默认 2026 年）的毫秒时间戳 */
const t = (month: number, day: number, h: number, m = 0, year = 2026) => new Date(year, month - 1, day, h, m).getTime();
const day = (month: number, d: number, year = 2026) => new Date(year, month - 1, d);
let nextId = 1;
const user = (time: number, content = '在吗'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'user', content, messageId: nextId++ });
const her = (time: number, content = '嗯'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'assistant', content, messageId: nextId++ });
const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
    qq: 10001, schedule, settings: boyfriend.proactive!, dates: boyfriend.dates, history: [], records: [], mode: 'on', ...patch,
});
const record = (id: string, at: number, result: ProactiveRecord['result'] = 'sent'): ProactiveRecord => ({
    id, occasion: id.split(':')[1] as ProactiveRecord['occasion'], plannedAt: new Date(at).toISOString(), at: new Date(at).toISOString(), result,
});
const find = (list: Candidate[], occasion: string) => list.find(c => c.occasion === occasion);
const hm = (time: number) => new Date(time).toTimeString().slice(0, 5);

describe('主动消息：读卡', () => {
    test('男朋友档有主动设置和三个日子，同学档都没有', () => {
        assert.deepEqual(boyfriend.proactive, { occasions: ['morning', 'after_class', 'bedtime', 'quiet', 'follow_up', 'dates', 'weather', 'news'], dailyMax: 2, unansweredMax: 1 });
        assert.deepEqual(boyfriend.dates.map(d => d.name), ['你的生日', '你们在一起的纪念日', '他的生日']);
        const classmate = loadCharacterCard(cardPath('classmate'));
        assert.equal(classmate.proactive, undefined);
        assert.deepEqual(classmate.dates, []);
    });

    test('卡上写错时报错', () => {
        assert.throws(() => parseDates([{ name: 'x' }], '卡'), /要有 date 或 lunar/);
        assert.throws(() => parseDates([{ name: 'x', date: '9-29' }], '卡'), /date 应为 MM-DD/);
        assert.throws(() => parseProactive({ occasions: ['lunch'], dailyMax: 1, unansweredMax: 1 }, '卡'), /occasions/);
        assert.throws(() => parseProactive({ occasions: [], dailyMax: 0, unansweredMax: 1 }, '卡'), /dailyMax 应为正整数/);
    });
});

describe('主动消息：她的那一天和日子', () => {
    test('00:00 到 02:00 算前一天', () => {
        assert.deepEqual(herDay(schedule, new Date(t(10, 12, 1, 59))), day(10, 11));
        assert.deepEqual(herDay(schedule, new Date(t(10, 12, 2))), day(10, 12));
    });

    test('农历：2026-09-18、2027-09-08 是八月初八；闰月不算', () => {
        assert.equal(lunarMonthDay(day(9, 18)), '08-08');
        assert.equal(lunarMonthDay(day(9, 8, 2027)), '08-08');
        assert.equal(lunarMonthDay(day(7, 25, 2025)), undefined); // 2025 年闰六月初一
        const his = boyfriend.dates.find(d => d.name === '他的生日')!;
        assert.equal(dayMatches(his, day(9, 29)), 'solar');
        assert.equal(dayMatches(his, day(9, 18)), 'lunar');
        assert.equal(dayMatches(his, day(9, 30)), undefined);
    });
});

describe('主动消息：每一天的候选', () => {
    test('国庆假期：早安在起床（09:30）后 10–40 分钟、睡前在 23:00–00:30；没课就没有下课', () => {
        const list = candidatesOn(day(10, 5), input());
        const morning = find(list, 'morning')!;
        assert.ok(morning.at >= t(10, 5, 9, 40) && morning.at <= t(10, 5, 10, 10), hm(morning.at));
        const bedtime = find(list, 'bedtime')!;
        assert.ok(bedtime.at >= t(10, 5, 23) && bedtime.at < t(10, 6, 0, 30), hm(bedtime.at));
        assert.equal(find(list, 'after_class'), undefined);
        assert.equal(find(list, 'quiet'), undefined, '没聊过天就没有冷场');
        assert.deepEqual(candidatesOn(day(10, 5), input()), list, '同一天算多少次都一样');
        assert.equal(morning.id, '2026-10-05:morning');
    });

    test('有课的周一：早安落在上课时间里就推到下课后；下课在最后一节（16:35）后 5–20 分钟', () => {
        // 换几个联系人，早安总有落在 08:20 之后（在上 Linux）的
        for (let qq = 1; qq <= 30; qq++) {
            const list = candidatesOn(day(10, 12), input({ qq }));
            const morning = find(list, 'morning')!;
            const inClass = morning.at >= t(10, 12, 8, 20) && morning.at < t(10, 12, 9, 40);
            assert.ok(!inClass, `qq ${qq} 早安 ${hm(morning.at)} 在上课`);
            assert.ok(morning.at >= t(10, 12, 7, 50) && morning.at <= t(10, 12, 9, 55), hm(morning.at));
            const afterClass = find(list, 'after_class')!;
            assert.ok(afterClass.at >= t(10, 12, 16, 40) && afterClass.at <= t(10, 12, 16, 55), hm(afterClass.at));
        }
    });

    test('冷场：最后一条消息 8 小时之后 0–30 分钟，不早于起床后 1 小时；过了 00:30 的就没有', () => {
        const quiet = (history: StoredMessage[]) => find(candidatesOn(day(10, 5), input({ history })), 'quiet');
        const noon = quiet([user(t(10, 5, 11)), her(t(10, 5, 11, 5))])!;
        assert.ok(noon.at >= t(10, 5, 19, 5) && noon.at <= t(10, 5, 19, 35), hm(noon.at));
        const lastNight = quiet([user(t(10, 4, 23))])!;
        assert.ok(lastNight.at >= t(10, 5, 10, 30) && lastNight.at <= t(10, 5, 11), hm(lastNight.at));
        assert.equal(quiet([user(t(10, 5, 17))]), undefined, '17:00 + 8 小时过了 00:30');
    });

    test('他的生日：公历那天零点（算前一天的晚上）发一条；农历那天不主动；她的生日和纪念日同一天，并进早安成一条', () => {
        const birthday = candidatesOn(day(9, 28), input()).filter(c => c.occasion === 'dates');
        assert.equal(birthday.length, 1);
        assert.equal(birthday[0]!.id, '2026-09-28:dates:midnight');
        assert.ok(birthday[0]!.at >= t(9, 29, 0) && birthday[0]!.at <= t(9, 29, 0, 5), hm(birthday[0]!.at));
        assert.equal(find(candidatesOn(day(9, 28), input()), 'bedtime'), undefined, '零点要祝的晚上不另说睡前');
        assert.equal(candidatesOn(day(9, 17), input()).filter(c => c.occasion === 'dates').length, 0, '农历八月初八的前一晚');

        const july = candidatesOn(day(7, 17, 2027), input());
        const dates = july.filter(c => c.occasion === 'dates');
        assert.equal(dates.length, 1);
        assert.deepEqual(dates[0]!.importantDays!.map(d => d.name), ['你的生日', '你们在一起的纪念日']);
        assert.equal(find(july, 'morning'), undefined, '早安就是这一条');
    });

    test('档位上没开的时机没有候选', () => {
        const list = candidatesOn(day(10, 12), input({ settings: { occasions: ['bedtime'], dailyMax: 2, unansweredMax: 1 } }));
        assert.deepEqual(list.map(c => c.occasion), ['bedtime']);
    });
});

describe('主动消息：计划（上限、优先级、错过不补）', () => {
    test('周一 12:00 才算：早安错过了不补；剩下的两条按优先级留下课和睡前', () => {
        const plan = planFrom(t(10, 12, 12), input({ history: [user(t(10, 11, 22)), her(t(10, 11, 22, 1), '晚安')] }));
        assert.deepEqual(plan.missed.map(c => c.occasion).sort(), ['morning', 'quiet']);
        assert.deepEqual(plan.upcoming.map(c => c.occasion), ['after_class', 'bedtime']);
    });

    test('一天的候选比剩下的条数多：按优先级留，低的让出来；今天发够了就看明天', () => {
        const history = [user(t(10, 11, 22)), her(t(10, 11, 22, 1))];
        const early = planFrom(t(10, 12, 7), input({ history }));
        assert.deepEqual(early.upcoming.map(c => c.occasion), ['morning', 'after_class']);
        assert.deepEqual(early.yielded.map(c => c.occasion).sort(), ['bedtime', 'quiet']);

        const records = [record('2026-10-12:morning', t(10, 12, 8)), record('2026-10-12:after_class', t(10, 12, 16, 50))];
        const replied = [...history, her(t(10, 12, 8)), user(t(10, 12, 8, 30)), her(t(10, 12, 16, 50)), user(t(10, 12, 16, 55))];
        const done = planFrom(t(10, 12, 17), input({ history: replied, records }));
        assert.ok(done.upcoming.length > 0 && done.upcoming.every(c => c.day === '2026-10-13'), done.upcoming.map(c => c.id).join());
    });

    test('她主动发的他还没回：除了日子先不排（状态里写原因）；他回了就接着排', () => {
        const morning = [record('2026-10-12:morning', t(10, 12, 8))];
        const ignored = [user(t(10, 11, 22)), her(t(10, 11, 22, 1)), her(t(10, 12, 8), '早')];
        const paused = planFrom(t(10, 12, 9, 50), input({ history: ignored, records: morning }));
        assert.equal(paused.paused, '上一条主动消息他还没回，等他回了再排');
        assert.deepEqual(paused.upcoming, []);
        const resumed = planFrom(t(10, 12, 12), input({ history: [...ignored, user(t(10, 12, 11, 30)), her(t(10, 12, 11, 31))], records: morning }));
        assert.equal(resumed.paused, undefined);
        assert.deepEqual(resumed.upcoming.map(c => c.occasion), ['after_class']);
    });

    test('记过的（发了、试运行、没发）不再排；日子不占条数', () => {
        const history = [user(t(9, 28, 12))];
        const records = [record('2026-09-28:morning', t(9, 28, 8), 'skipped'), record('2026-09-28:after_class', t(9, 28, 16, 50)), record('2026-09-28:bedtime', t(9, 28, 23), 'dryRun')];
        const plan = planFrom(t(9, 28, 23, 30), input({ history, records }));
        assert.deepEqual(plan.upcoming.map(c => c.id), ['2026-09-28:dates:midnight']);
    });
});

describe('主动消息：到点时能不能发', () => {
    const at = (occasion: string, time: number, extra: Partial<Candidate> = {}): Candidate => ({
        id: `x:${occasion}`, occasion: occasion as Candidate['occasion'], day: '2026-10-12', at: time, reason: '', ...extra,
    });
    const history = [user(t(10, 11, 22)), her(t(10, 11, 22, 1))];

    test('他最近说过想伤害自己的话（ADR 0068）：早安、下课、睡前、冷场、事、下雨都暂停；待跟进和重要的日子照旧', () => {
        const calm = [user(t(10, 12, 10)), her(t(10, 12, 10, 1))];
        const when = t(10, 12, 14);
        for (const occasion of ['morning', 'after_class', 'bedtime', 'quiet', 'news', 'weather']) {
            assert.equal(blockReason(at(occasion, when), when, input({ history: calm, crisisPaused: true })), '他最近说过想伤害自己的话，普通的主动消息先暂停', occasion);
            assert.notEqual(blockReason(at(occasion, when), when, input({ history: calm })), '他最近说过想伤害自己的话，普通的主动消息先暂停', occasion);
        }
        for (const occasion of ['dates', 'follow_up']) {
            assert.notEqual(blockReason(at(occasion, when), when, input({ history: calm, crisisPaused: true })), '他最近说过想伤害自己的话，普通的主动消息先暂停', occasion);
        }
    });

    test('睡觉、上课、夜里 00:30 以后不发', () => {
        assert.equal(blockReason(at('morning', t(10, 12, 7)), t(10, 12, 7), input({ history })), '她在睡觉');
        assert.equal(blockReason(at('morning', t(10, 12, 8, 30)), t(10, 12, 8, 30), input({ history })), '她在上课');
        assert.equal(blockReason(at('bedtime', t(10, 13, 0, 40), { day: '2026-10-12' }), t(10, 13, 0, 40), input({ history })), '夜里了，不打扰');
        assert.equal(blockReason(at('bedtime', t(10, 13, 0, 20), { day: '2026-10-12' }), t(10, 13, 0, 20), input({ history: [user(t(10, 12, 20)), her(t(10, 12, 20, 1), '去洗澡了')] })), undefined);
    });

    test('有没回的消息、一小时内聊过都不发', () => {
        assert.equal(blockReason(at('quiet', t(10, 12, 18)), t(10, 12, 18), input({ history: [...history, user(t(10, 12, 10))] })), '有没回的消息，回复就好');
        assert.equal(blockReason(at('after_class', t(10, 12, 17), { classEnd: t(10, 12, 16, 35) }), t(10, 12, 17), input({ history: [user(t(10, 12, 16, 10)), her(t(10, 12, 16, 20))] })), '一小时内聊过');
        // 睡前只看 20 分钟（10-06：23:58 聊完，00:25 的睡前被一小时挡掉了）
        const lateChat = [user(t(10, 12, 23, 48)), her(t(10, 12, 23, 58), '还没睡呢')];
        assert.equal(blockReason(at('bedtime', t(10, 13, 0, 25)), t(10, 13, 0, 25), input({ history: lateChat })), undefined);
        assert.equal(blockReason(at('bedtime', t(10, 13, 0, 10)), t(10, 13, 0, 10), input({ history: lateChat })), '20 分钟内聊过');
        // 回复器按「不回」处理了的那串（看心情没回的「哈哈」，ADR 0013）不算
        const laughed = [user(t(10, 12, 9, 50)), her(t(10, 12, 9, 51)), user(t(10, 12, 9, 52), '哈哈哈')];
        const skip = (h: { content: string }[]) => (h.at(-1)?.content === '哈哈哈' ? '看心情没回' : undefined);
        assert.equal(blockReason(at('quiet', t(10, 12, 18)), t(10, 12, 18), input({ history: laughed, skip })), undefined);
        assert.equal(blockReason(at('quiet', t(10, 12, 18)), t(10, 12, 18), input({ history: laughed })), '有没回的消息，回复就好');
    });

    test('每天上限；她主动发的 1 条他没回就停，他回了就接着来；试运行时算试运行的记录', () => {
        const two = [record('2026-10-12:morning', t(10, 12, 8)), record('2026-10-12:after_class', t(10, 12, 9, 50))];
        const replied = [...history, her(t(10, 12, 8)), user(t(10, 12, 8, 30)), her(t(10, 12, 8, 31)), her(t(10, 12, 9, 50)), user(t(10, 12, 10)), her(t(10, 12, 10, 1))];
        assert.equal(blockReason(at('bedtime', t(10, 12, 23, 30)), t(10, 12, 23, 30), input({ history: replied, records: two })), '今天已经主动了 2 条');

        const one = [record('2026-10-12:morning', t(10, 12, 8))];
        const ignored = [...history, her(t(10, 12, 8), '早')];
        assert.equal(unansweredCount(input({ history: ignored, records: one })), 1);
        assert.equal(blockReason(at('after_class', t(10, 12, 16, 50), { classEnd: t(10, 12, 16, 35) }), t(10, 12, 16, 50), input({ history: ignored, records: one })), '上一条主动消息他还没回');
        const answered = [...ignored, user(t(10, 12, 9, 50)), her(t(10, 12, 9, 51))];
        assert.equal(blockReason(at('after_class', t(10, 12, 16, 50), { classEnd: t(10, 12, 16, 35) }), t(10, 12, 16, 50), input({ history: answered, records: one })), undefined);

        // 试运行：真发的记录不算，试运行的记录算
        assert.equal(unansweredCount(input({ history: ignored, records: one, mode: 'dryRun' })), 0);
        assert.equal(unansweredCount(input({ history: ignored, records: [record('2026-10-12:morning', t(10, 12, 8), 'dryRun')], mode: 'dryRun' })), 1);
    });

    test('各时机自己的条件：他先来过就不说早安；下课后聊过就不说下课；睡前要今天聊过、还没道晚安；冷场要满 8 小时', () => {
        // 09:45 是课间
        assert.equal(blockReason(at('morning', t(10, 12, 9, 45)), t(10, 12, 9, 45), input({ history: [user(t(10, 12, 7, 45)), her(t(10, 12, 7, 50))] })), '他今天已经来过消息');
        assert.equal(blockReason(at('after_class', t(10, 12, 18), { classEnd: t(10, 12, 16, 35) }), t(10, 12, 18), input({ history: [user(t(10, 12, 16, 40)), her(t(10, 12, 16, 41))] })), '下课后已经聊过');
        assert.equal(blockReason(at('bedtime', t(10, 12, 23, 30)), t(10, 12, 23, 30), input({ history })), '今天没聊过');
        assert.equal(blockReason(at('bedtime', t(10, 12, 23, 30)), t(10, 12, 23, 30), input({ history: [user(t(10, 12, 21)), her(t(10, 12, 21, 1), '晚安，明天见')] })), '已经道过晚安');
        // 他道了晚安、她回的话里没有这几个词：也算道过了
        assert.equal(blockReason(at('bedtime', t(10, 12, 23, 30)), t(10, 12, 23, 30), input({ history: [user(t(10, 12, 21), '我先睡了，晚安'), her(t(10, 12, 21, 1), '好梦')] })), '已经道过晚安');
        assert.equal(blockReason(at('bedtime', t(10, 12, 23, 30)), t(10, 12, 23, 30), input({ history: [user(t(10, 12, 21)), her(t(10, 12, 21, 1), '去吧')] })), undefined);
        assert.equal(blockReason(at('quiet', t(10, 12, 18)), t(10, 12, 18), input({ history: [user(t(10, 12, 11)), her(t(10, 12, 11, 1))] })), '没到 8 小时');
    });

    test('日子：正聊着、到了上限、他没回都照样发；有没回的消息时由回复带上', () => {
        const dates = at('dates', t(9, 29, 0, 3), { id: '2026-09-28:dates:midnight', day: '2026-09-28' });
        const busy = [user(t(9, 28, 23, 50)), her(t(9, 28, 23, 55))];
        const full = [record('2026-09-28:morning', t(9, 28, 8)), record('2026-09-28:after_class', t(9, 28, 17))];
        assert.equal(blockReason(dates, t(9, 29, 0, 3), input({ history: busy, records: full })), undefined);
        assert.equal(blockReason(dates, t(9, 29, 0, 3), input({ history: [...busy, user(t(9, 29, 0, 1))] })), '有没回的消息，回复就好');
    });
});

describe('主动消息：下雨了（ADR 0050，只认真实天气）', () => {
    const real = (rainHours: number[], laterHour?: number) => ({
        rain: rainHours.length > 0, low: 15, high: 22, real: true as const, rainHours, ...(laterHour !== undefined ? { laterHour, later: `预报 ${laterHour} 点后有雨` } : {}),
    });
    const seen = (weather: ReturnType<typeof real> | { rain: boolean; low: number; high: number }) => ({ day: '2026-10-16', weather });

    test('今天的雨：在下的按这场开始的钟头；还没下的按预报；早上下过又停了的、生成的天气都不算', () => {
        assert.deepEqual(rainOf(seen(real([13, 14, 15])), new Date(t(10, 16, 15, 20))), { day: '2026-10-16', start: t(10, 16, 13), forecast: false });
        assert.deepEqual(rainOf(seen(real([], 17)), new Date(t(10, 16, 9))), { day: '2026-10-16', start: t(10, 16, 17), forecast: true });
        assert.equal(rainOf(seen(real([8])), new Date(t(10, 16, 15))), undefined, '早上那场停了，不追着说');
        assert.equal(rainOf(seen({ rain: true, low: 11, high: 18 }), new Date(t(10, 16, 15))), undefined, '生成的天气不触发');
        assert.equal(rainingAt(real([14]), new Date(t(10, 16, 15, 30))), true, '上一个钟头还在下');
        assert.equal(rainingAt(real([14]), new Date(t(10, 16, 16, 30))), false);
    });

    test('候选：这场雨开始后 10–25 分钟；晚上 10 点后不发；卡上没开就没有', () => {
        const rain = { day: '2026-10-16', start: t(10, 16, 16), forecast: false };
        const list = candidatesOn(day(10, 16), input({ rain }));
        const c = find(list, 'weather')!;
        assert.ok(c.at >= t(10, 16, 16, 10) && c.at <= t(10, 16, 16, 25), hm(c.at));
        assert.equal(c.reason, '16:00 开始下雨');
        assert.equal(c.id, '2026-10-16:weather');
        assert.equal(find(candidatesOn(day(10, 16), input({ rain: { ...rain, start: t(10, 16, 22) } })), 'weather'), undefined);
        const off = { ...boyfriend.proactive!, occasions: boyfriend.proactive!.occasions.filter(o => o !== 'weather') };
        assert.equal(find(candidatesOn(day(10, 16), input({ rain, settings: off })), 'weather'), undefined);
        assert.match(occasionNote(c, '宝宝'), /你这边下雨了.*带没带伞/);
    });

    test('到点核实：预报的雨没下就不发', () => {
        const rain = { day: '2026-10-16', start: t(10, 16, 16), forecast: true };
        const c = find(candidatesOn(day(10, 16), input({ rain })), 'weather')!;
        const history = [user(t(10, 16, 9)), her(t(10, 16, 9, 1))];
        assert.equal(blockReason(c, c.at, input({ rain, history, rainingNow: () => false })), '没在下雨');
        assert.equal(blockReason(c, c.at, input({ rain, history, rainingNow: () => true })), undefined);
    });
});

describe('主动消息：她那边的事（ADR 0057）', () => {
    // 10-11 周日 14:00–16:30 去山大路科技市场买相机（ADR 0053）
    const camera = { id: 'camera', kind: 'camera' as const, day: '2026-10-11', at: t(10, 11, 16, 30), what: '在山大路科技市场买到了二手索尼 a6100 加 16-50 套机镜头' };

    test('候选：了结后 5–20 分钟，一件一条；别的日子的、卡上没开的没有', () => {
        const c = find(candidatesOn(day(10, 11), input({ news: [camera] })), 'news')!;
        assert.ok(c.at >= t(10, 11, 16, 35) && c.at <= t(10, 11, 16, 50), hm(c.at));
        assert.equal(c.id, '2026-10-11:news:camera');
        assert.equal(c.reason, camera.what);
        assert.equal(find(candidatesOn(day(10, 12), input({ news: [camera] })), 'news'), undefined);
        const off = { ...boyfriend.proactive!, occasions: boyfriend.proactive!.occasions.filter(o => o !== 'news') };
        assert.equal(find(candidatesOn(day(10, 11), input({ news: [camera], settings: off })), 'news'), undefined);
        // 说明：事实和方向，不带引号里的台词
        const note = occasionNote(c, '宝宝');
        assert.match(note, /你刚在山大路科技市场买到了二手索尼 a6100.*想第一时间告诉宝宝/);
        assert.doesNotMatch(note, /「[^」]*[！!]」/);
    });

    test('到点：没发生的不发；那之后聊过不发；正聊着（10 分钟内）不发；隔了半小时照发', () => {
        const c = find(candidatesOn(day(10, 11), input({ news: [camera] })), 'news')!;
        const morning = [user(t(10, 11, 11)), her(t(10, 11, 11, 1))];
        assert.equal(blockReason(c, c.at, input({ news: [camera], history: morning })), undefined);
        assert.equal(blockReason(c, c.at, input({ news: [], history: morning })), '那件事没发生');
        assert.equal(blockReason(c, t(10, 11, 16, 50), input({ news: [camera], history: [...morning, user(t(10, 11, 16, 31), '买到没'), her(t(10, 11, 16, 32), '买到了')] })), '那之后聊过了');
        // 16:29 还在聊（在店里），16:36 到点：10 分钟内，聊天里说
        const chatting = [...morning, user(t(10, 11, 16, 28), '挑好没'), her(t(10, 11, 16, 29), '在付钱')];
        assert.equal(blockReason(c, t(10, 11, 16, 36), input({ news: [camera], history: chatting })), '正聊着，聊天里说');
        assert.equal(blockReason(c, t(10, 11, 16, 45), input({ news: [camera], history: chatting })), undefined);
        assert.equal(blockReason(c, c.at, input({ news: [camera], history: [...morning, user(t(10, 11, 16, 0), '买到没'), her(t(10, 11, 16, 1), '还在挑')] })), undefined);
    });

    test('没连上模型的（带 retryAt）按再试的时刻再排；不带的不再排；再试的时刻过了 GRACE_MS 才算到就算错过', () => {
        const history = [user(t(10, 11, 11)), her(t(10, 11, 11, 1))];
        const c = find(candidatesOn(day(10, 11), input({ news: [camera] })), 'news')!;
        const failed = (extra: Partial<ProactiveRecord>): ProactiveRecord => ({ ...record(c.id, c.at, 'failed'), occasion: 'news', reason: '生成失败：模型接口请求失败（ENOTFOUND）', ...extra });
        const retry = failed({ retryAt: new Date(c.at + 15 * 60_000).toISOString(), tries: 1 });
        const plan = planFrom(c.at + 60_000, input({ news: [camera], history, records: [retry] }));
        const again = plan.upcoming.find(x => x.id === c.id);
        assert.equal(again?.at, c.at + 15 * 60_000);
        assert.ok(!plan.missed.some(x => x.id === c.id));
        assert.equal(planFrom(c.at + 60_000, input({ news: [camera], history, records: [failed({})] })).upcoming.find(x => x.id === c.id), undefined);
        const late = planFrom(c.at + 40 * 60_000, input({ news: [camera], history, records: [retry] }));
        assert.ok(late.missed.some(x => x.id === c.id));
    });

    test('一天只剩一条时先留她那边的事（日子之后、待跟进之前）', () => {
        const records = [record('2026-10-11:morning', t(10, 11, 10))];
        const plan = planFrom(t(10, 11, 12), input({ news: [camera], records, history: [user(t(10, 11, 10, 5)), her(t(10, 11, 10, 6))] }));
        assert.deepEqual(plan.upcoming.map(c => c.occasion), ['news']);
        assert.ok(plan.yielded.some(c => c.occasion === 'bedtime'));
    });

    test('没说成的（10-11 断网）：这一天后面的冷场、睡前顺带说；发出去了、等着再试的、那之后聊过的、别的日子的不带', () => {
        const morning = [user(t(10, 11, 11)), her(t(10, 11, 11, 1))];
        const bedtime = find(candidatesOn(day(10, 11), input({ news: [camera] })), 'bedtime')!;
        const news = find(candidatesOn(day(10, 11), input({ news: [camera] })), 'news')!;
        const failed: ProactiveRecord = { ...record(news.id, news.at, 'failed'), reason: '生成失败：模型接口请求失败（UND_ERR_CONNECT_TIMEOUT）', tries: 3 };
        const at = bedtime.at;
        assert.deepEqual(untoldNews(bedtime, at, input({ news: [camera], history: morning, records: [failed] })), [camera]);
        assert.deepEqual(untoldNews({ ...bedtime, occasion: 'quiet' }, at, input({ news: [camera], history: morning, records: [failed] })), [camera]);
        // 错过了、没排上（skipped）的也算没说成
        assert.deepEqual(untoldNews(bedtime, at, input({ news: [camera], history: morning, records: [{ ...failed, result: 'skipped', reason: '错过了，不补' }] })), [camera]);
        assert.deepEqual(untoldNews(bedtime, at, input({ news: [camera], history: morning, records: [record(news.id, news.at)] })), [], '发出去了');
        assert.deepEqual(untoldNews(bedtime, at, input({ news: [camera], history: morning, records: [{ ...failed, retryAt: new Date(at + 60_000).toISOString(), tries: 1 }] })), [], '还等着再试');
        assert.deepEqual(untoldNews(bedtime, at, input({ news: [camera], history: [...morning, user(t(10, 11, 20), '买到没'), her(t(10, 11, 20, 1), '买到了')], records: [failed] })), [], '那之后聊过');
        assert.deepEqual(untoldNews(bedtime, t(10, 11, 16), input({ news: [camera], history: morning, records: [failed] })), [], '还没了结');
        assert.deepEqual(untoldNews({ ...bedtime, day: '2026-10-12' }, at + 86_400_000, input({ news: [camera], history: morning, records: [failed] })), [], '第二天不带');
        assert.deepEqual(untoldNews({ ...bedtime, occasion: 'weather' }, at, input({ news: [camera], history: morning, records: [failed] })), [], '下雨只说这一件');
        // 说明：睡前道晚安，顺带说这件；不给台词、不说为什么没说成
        const note = occasionNote(bedtime, '宝宝', [camera]);
        assert.match(note, /跟宝宝道个晚安；你今天在山大路科技市场买到了二手索尼 a6100 加 16-50 套机镜头，还没跟宝宝说过，这次一起说/);
        assert.doesNotMatch(note, /断网|网不好|发不出去|没发出去/);
        assert.equal(occasionNote(bedtime, '宝宝'), occasionNote(bedtime, '宝宝', []));
        assert.doesNotMatch(occasionNote(bedtime, '宝宝'), /相机/);
    });
});
