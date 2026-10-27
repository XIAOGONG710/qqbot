import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { bodyAt, type Body } from '../src/body.ts';
import type { Contact } from '../src/config.ts';
import type { StoredMessage } from '../src/history.ts';
import { describeObstacles, knownBy, meetupDays, newObstacles, obstaclesBetween, type Obstacle, type ObstacleFacts } from '../src/world/obstacles.ts';
import {
    blockReason, candidateLabel, candidatesOn, occasionNote, planFrom, type ProactiveInput, type ProactiveRecord, type RescheduleItem,
} from '../src/proactive.ts';
import { allowedReschedules, reschedulesFrom } from '../src/proactive-planner.ts';
import { meetWindow, mentionsMeetup, type Appointment, type HerPromise } from '../src/promises.ts';
import { classesOn, formatDate, wakeOn } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import type { WorldNow } from '../src/world/world.ts';

// ADR 0066：推掉和改约要有来源（身体、日程、作业、已有的约）
const cardPath = (tier: string) => resolve(import.meta.dirname, `../../../characters/linmengyao/st/linmengyao-${tier}.json`);
const boyfriend = loadCharacterCard(cardPath('boyfriend'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0, year = 2026) => new Date(year, month - 1, day, h, m);
const day = (month: number, d: number, year = 2026) => new Date(year, month - 1, d);
const him: Contact = { qq: 10001, name: '宝宝', tier: 'boyfriend' } as Contact;

const world = (homework: WorldNow['homework']): WorldNow => ({ day: '2026-10-14', atSchool: true, parcels: [], events: [], homework });
const hw = (course: string, doneAt: Date, due: Date, assigned = '2026-10-12') => ({ course, due, done: false, doneAt, assigned });
const cramps: Body = { period: { first: '2026-12-21', cycle: [28, 28], days: 5, crampsChance: 1, detail: true } };
const facts = (patch: Partial<ObstacleFacts> = {}): ObstacleFacts => ({ schedule, ...patch });

const promise = (id: string, date: string, time: string, said: string, where = '东门口'): HerPromise =>
    ({ id, what: '和他去东门吃麻辣烫', date, said, episode: 'ep-1', meet: { time, where, minutes: 90 } });
const appointment = (p: HerPromise, contact: Contact = him): Appointment => ({ contact, promise: p, ...meetWindow(p)! });

describe('障碍：obstaclesBetween（ADR 0066 决策 1）', () => {
    test('有课：约的时段和课重叠才算；周末、课外的时段没有', () => {
        const lesson = classesOn(schedule, day(10, 12)).lessons[0]!;
        const found = obstaclesBetween(new Date(lesson.start.getTime() + 10 * 60_000), new Date(lesson.start.getTime() + 40 * 60_000), facts());
        assert.equal(found.length, 1);
        assert.equal(found[0]!.kind, 'class');
        assert.match(found[0]!.text, /^有课（.+，\d\d:\d\d–\d\d:\d\d）$/);
        assert.match(found[0]!.id, /^class:2026-10-12:/);
        assert.deepEqual(obstaclesBetween(t(10, 12, 18), t(10, 12, 20), facts()), [], '下课以后');
        assert.deepEqual(obstaclesBetween(t(10, 17, 10), t(10, 17, 12), facts()), [], '周六');
    });

    test('赶作业：24 小时内到期、还没写完，约的时段和她赶作业的那段（写完前 90 分钟）重叠才算', () => {
        const worldAt = () => world([hw('数据结构', t(10, 14, 22), t(10, 15, 8))]);
        const found = obstaclesBetween(t(10, 14, 20, 30), t(10, 14, 21, 30), facts({ worldAt }));
        assert.deepEqual(found.map(o => o.kind), ['homework']);
        assert.equal(found[0]!.id, `homework:${t(10, 15, 8).getTime()}`);
        assert.match(found[0]!.text, /要赶作业（数据结构），22:00 左右写完/);
        assert.deepEqual(obstaclesBetween(t(10, 14, 12), t(10, 14, 13), facts({ worldAt })), [], '中午她还没开始赶');
        assert.deepEqual(obstaclesBetween(t(10, 14, 22, 10), t(10, 14, 23), facts({ worldAt })), [], '写完以后');
        // 离交还远的、已经写完的不算
        assert.deepEqual(obstaclesBetween(t(10, 14, 20, 30), t(10, 14, 21, 30), facts({ worldAt: () => world([hw('数据结构', t(10, 14, 22), t(10, 17, 8))]) })), []);
        assert.deepEqual(obstaclesBetween(t(10, 14, 20, 30), t(10, 14, 21, 30), facts({ worldAt: () => world([{ ...hw('数据结构', t(10, 14, 22), t(10, 15, 8)), done: true }]) })), []);
    });

    test('身体不舒服：当天整天；前一天、生理期以外的日子没有；说得出口的程度跟着档位', () => {
        const bodyOf = (body: Body) => (time: Date) => bodyAt(body, schedule, time);
        const found = obstaclesBetween(t(12, 21, 15), t(12, 21, 16, 30), facts({ bodyAt: bodyOf(cramps) }));
        assert.deepEqual(found.map(o => [o.kind, o.id, o.text]), [['unwell', 'unwell:2026-12-21', '身上不舒服（生理期，肚子疼）']]);
        assert.deepEqual(obstaclesBetween(t(12, 20, 15), t(12, 20, 16, 30), facts({ bodyAt: bodyOf(cramps) })), []);
        const quiet: Body = { period: { ...cramps.period!, detail: false } };
        assert.equal(obstaclesBetween(t(12, 21, 15), t(12, 21, 16), facts({ bodyAt: bodyOf(quiet) }))[0]!.text, '身上不舒服');
        assert.deepEqual(obstaclesBetween(t(12, 21, 15), t(12, 21, 16), facts()), [], '卡上没写身体就没有这一类');
    });

    test('已经约了别的事：重叠才算，自己这件（exclude）不算；出门前一刻钟也占着', () => {
        const other = promise('p-other', '2026-10-16', '18:00', '2026-10-13');
        const appointments = () => [appointment(other)];
        const found = obstaclesBetween(t(10, 16, 18, 30), t(10, 16, 19, 30), facts({ appointments }));
        assert.deepEqual(found.map(o => [o.kind, o.id, o.text]), [['other_meet', 'meet:p-other', '已经约了别的事（18:00）']]);
        assert.equal(obstaclesBetween(t(10, 16, 17, 50), t(10, 16, 18, 0), facts({ appointments })).length, 1, '出门前一刻钟');
        assert.deepEqual(obstaclesBetween(t(10, 16, 18, 30), t(10, 16, 19, 30), facts({ appointments }), 'p-other'), [], '自己这件不算');
        assert.deepEqual(obstaclesBetween(t(10, 16, 20), t(10, 16, 21), facts({ appointments })), []);
    });

    test('同样的输入同样的输出；按开始的时刻排', () => {
        const worldAt = () => world([hw('数据结构', t(10, 14, 22), t(10, 15, 8))]);
        const lesson = classesOn(schedule, day(10, 14)).lessons[0]!;
        const a = obstaclesBetween(t(10, 14, 0), t(10, 15, 0), facts({ worldAt }));
        assert.deepEqual(obstaclesBetween(t(10, 14, 0), t(10, 15, 0), facts({ worldAt })), a);
        assert.deepEqual(a.map(o => o.start.getTime()), [...a.map(o => o.start.getTime())].sort((x, y) => x - y));
        assert.ok(a.some(o => o.kind === 'class' && o.start.getTime() === lesson.start.getTime()));
        assert.ok(a.some(o => o.kind === 'homework'));
    });
});

describe('新出现的障碍：newObstacles（ADR 0066 决策 3）', () => {
    const make = (kind: Obstacle['kind'], start: Date, assigned?: string): Obstacle => ({ kind, id: `${kind}:x`, text: 'x', start, end: new Date(start.getTime() + 3_600_000), ...(assigned ? { assigned } : {}) });

    test('身体：约好之后的日子才算新的（当天的身体不看未来）；约的当天就不舒服不算', () => {
        assert.equal(newObstacles([make('unwell', day(12, 21))], { said: '2026-12-20' }).length, 1);
        assert.equal(newObstacles([make('unwell', day(12, 21))], { said: '2026-12-21' }).length, 0);
    });

    test('作业：约好之后才布置的才算；约的时候已经布置了的她知道', () => {
        assert.equal(newObstacles([make('homework', t(10, 14, 20), '2026-10-13')], { said: '2026-10-12' }).length, 1);
        assert.equal(newObstacles([make('homework', t(10, 14, 20), '2026-10-12')], { said: '2026-10-12' }).length, 0);
        assert.equal(newObstacles([make('homework', t(10, 14, 20))], { said: '2026-10-12' }).length, 0, '不知道哪天布置的就不算新的');
    });

    test('课和别的约约的时候就看得到：不算新的', () => {
        assert.deepEqual(newObstacles([make('class', t(10, 14, 10)), make('other_meet', t(10, 14, 10))], { said: '2026-10-01' }), []);
    });
});

describe('他提到见面时的一行：meetupDays、describeObstacles（ADR 0066 决策 2）', () => {
    const today = day(10, 14); // 周三

    test('看哪几天：话里说了哪天就看哪天，没说看今天到后天', () => {
        const ymd = (days: Date[]) => days.map(formatDate);
        assert.deepEqual(ymd(meetupDays('明天下午三点一起吃饭', today)), ['2026-10-15']);
        assert.deepEqual(ymd(meetupDays('后天晚上看电影', today)), ['2026-10-16']);
        assert.deepEqual(ymd(meetupDays('今晚六点东门口', today)), ['2026-10-14']);
        assert.deepEqual(ymd(meetupDays('周六出来逛逛', today)), ['2026-10-17']);
        assert.deepEqual(ymd(meetupDays('周三一起去', today)), ['2026-10-14'], '说的是今天这个周几就是今天');
        assert.deepEqual(ymd(meetupDays('找个时间见一面', today)), ['2026-10-14', '2026-10-15', '2026-10-16']);
    });

    test('没有障碍就什么都不加；有的列出时段和原因，只给事实，不替她做决定', () => {
        assert.equal(describeObstacles([day(10, 17)], t(10, 14, 12), facts()), undefined);
        const line = describeObstacles([day(10, 14)], t(10, 14, 12), facts({ worldAt: () => world([hw('数据结构', t(10, 14, 22), t(10, 15, 8))]) }))!;
        assert.match(line, /^\[你那天不方便的时段（事实；/);
        assert.match(line, /今天 20:30–22:00 要赶作业（数据结构），22:00 左右写完/);
        assert.match(line, /没写到的时段你都有空\）/);
        assert.doesNotMatch(line, /不能|不许|必须|一定要推/);
    });

    test('她今天已经知道的才列：明天的身体、还没布置的作业不列（当天的身体不看未来）', () => {
        const bodyOf = (time: Date) => bodyAt(cramps, schedule, time);
        assert.equal(describeObstacles([day(12, 21)], t(12, 20, 21), facts({ bodyAt: bodyOf })), undefined, '头天晚上看不到明天的痛经');
        assert.match(describeObstacles([day(12, 21)], t(12, 21, 9), facts({ bodyAt: bodyOf }))!, /今天整天 身上不舒服（生理期，肚子疼）/);
        const later = () => world([hw('数据结构', t(10, 15, 22), t(10, 16, 8), '2026-10-15')]);
        assert.doesNotMatch(describeObstacles([day(10, 15)], t(10, 14, 12), facts({ worldAt: later })) ?? '', /作业/, '明天才布置的作业今天不知道');
        assert.match(describeObstacles([day(10, 15)], t(10, 15, 12), facts({ worldAt: later }))!, /要赶作业（数据结构）/);
        assert.deepEqual(['class', 'other_meet'].map(kind => knownBy({ kind, id: 'x', text: 'x', start: day(12, 30), end: day(12, 30) } as Obstacle, '2026-01-01')), [true, true]);
    });

    test('只看现在以后；一行最多六条', () => {
        const lessons = classesOn(schedule, day(10, 14)).lessons;
        const after = t(10, 14, lessons.at(-1)!.end.getHours(), lessons.at(-1)!.end.getMinutes() + 1);
        assert.doesNotMatch(describeObstacles([day(10, 14)], after, facts()) ?? '', /有课/);
        const many = describeObstacles([day(10, 12), day(10, 13), day(10, 14), day(10, 15)], t(10, 12, 0), facts())!;
        assert.ok((many.match(/有课/g) ?? []).length <= 6, many);
    });
});

describe('改约：reschedulesFrom（ADR 0066 决策 3）', () => {
    const bodyOf = (time: Date) => bodyAt(cramps, schedule, time);
    const source = (promises: HerPromise[], patch: Partial<ObstacleFacts> = {}, contact: Contact = him) => reschedulesFrom({
        qq: 10001,
        appointments: (from, to) => promises.map(p => appointment(p, contact)).filter(a => a.start.getTime() - 15 * 60_000 < to.getTime() && a.end.getTime() > from.getTime()),
        facts: facts({ bodyAt: bodyOf, ...patch }),
    });
    const monday = promise('p-1', '2026-12-21', '15:00', '2026-12-20');

    test('约好之后当天身体不舒服：约那天起床后可以开口，每件约一条，带原因', () => {
        const [item, ...rest] = source([monday])(t(12, 21, 8).getTime());
        assert.equal(rest.length, 0);
        assert.deepEqual(item, {
            id: 'p-1', day: '2026-12-21', at: wakeOn(schedule, day(12, 21)).getTime(), start: t(12, 21, 15).getTime(),
            what: '和他去东门吃麻辣烫', time: '15:00', where: '东门口',
            obstacle: { kind: 'unwell', id: 'unwell:2026-12-21', text: '身上不舒服（生理期，肚子疼）' },
        });
        // 头天晚上就能看到明天的（计划器排明天 09:45 的候选）
        assert.equal(source([monday])(t(12, 20, 22).getTime()).length, 1);
    });

    test('没有新障碍就没有改约：约的当天就不舒服、卡上没写身体、约在别的日子', () => {
        assert.deepEqual(source([promise('p-2', '2026-12-21', '15:00', '2026-12-21')])(t(12, 21, 8).getTime()), [], '约的当天就不舒服');
        assert.deepEqual(reschedulesFrom({ qq: 10001, appointments: () => [appointment(monday)], facts: facts() })(t(12, 21, 8).getTime()), [], '没写身体');
        assert.deepEqual(source([promise('p-3', '2026-12-30', '15:00', '2026-12-20')])(t(12, 21, 8).getTime()), [], '约在九天以后，现在不看');
    });

    test('只给这个联系人的约；已经开始的不改；有课的时段不算「新」的（约的时候就看得到）', () => {
        assert.deepEqual(source([monday], {}, { qq: 99, name: '别人', tier: 'classmate' } as Contact)(t(12, 21, 8).getTime()), []);
        assert.deepEqual(source([monday])(t(12, 21, 15, 5).getTime()), [], '已经开始');
        const lesson = classesOn(schedule, day(10, 12)).lessons[0]!;
        const time = `${String(lesson.start.getHours()).padStart(2, '0')}:${String(lesson.start.getMinutes() + 5).padStart(2, '0')}`;
        assert.deepEqual(reschedulesFrom({ qq: 10001, appointments: () => [appointment(promise('p-4', '2026-10-12', time, '2026-10-01'))], facts: facts() })(t(10, 12, 6).getTime()), []);
    });

    test('不舒服的改约每个周期最多一次：前 20 天里已经为不舒服改过约的不再算', () => {
        const [item] = source([monday])(t(12, 21, 8).getTime());
        const sent = (daysAgo: number, result: ProactiveRecord['result'] = 'sent', obstacle: ProactiveRecord['obstacle'] = 'unwell'): ProactiveRecord => ({
            id: 'x:reschedule:p-0', occasion: 'reschedule', plannedAt: '', at: new Date(t(12, 21, 8).getTime() - daysAgo * 86_400_000).toISOString(), result, obstacle,
        });
        const now = t(12, 21, 8).getTime();
        assert.equal(allowedReschedules([item!], [], now).length, 1);
        assert.equal(allowedReschedules([item!], [sent(10)], now).length, 0, '10 天前刚为不舒服改过');
        assert.equal(allowedReschedules([item!], [sent(25)], now).length, 1, '25 天前的不算');
        assert.equal(allowedReschedules([item!], [sent(5, 'skipped')], now).length, 1, '没发出去的不算');
        // DSH 复核 0066 的缺口：dryRun（试运行，没真发）按已发算额度，免得试运行转正之后同一个周期里又来一次
        assert.equal(allowedReschedules([item!], [sent(5, 'dryRun')], now).length, 0, '试运行里排过的算');
        assert.equal(allowedReschedules([item!], [sent(5, 'sent', 'homework')], now).length, 1, '为别的原因改的不算');
    });
});

describe('改约的候选、说明和到点的检查（ADR 0066 决策 3、4）', () => {
    // 这些测试按“每天 2 条、没有 share”写的（ADR 0066 / 0011 的确认值）；卡上现在多了 share、上限 4（ADR 0096）
    const settings = { ...boyfriend.proactive!, occasions: [...new Set([...boyfriend.proactive!.occasions.filter(o => o !== 'share'), 'reschedule' as const])], dailyMax: 2 };
    const item: RescheduleItem = {
        id: 'p-1', day: '2026-12-21', at: wakeOn(schedule, day(12, 21)).getTime(), start: t(12, 21, 15).getTime(), what: '和他去东门吃麻辣烫', time: '15:00', where: '东门口',
        obstacle: { kind: 'unwell', id: 'unwell:2026-12-21', text: '身上不舒服（生理期，肚子疼）' },
    };
    const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
        qq: 10001, schedule, settings, dates: boyfriend.dates, history: [], records: [], mode: 'on', reschedules: [item], ...patch,
    });
    const find = () => candidatesOn(day(12, 21), input()).find(c => c.occasion === 'reschedule')!;
    const msg = (role: 'user' | 'assistant', time: Date, content: string): StoredMessage => ({ time: time.toISOString(), role, content, messageId: 1 });

    test('候选：起床后 5–20 分钟，一件约一条；卡上没开这个时机的没有', () => {
        const c = find();
        assert.equal(c.id, '2026-12-21:reschedule:p-1');
        assert.ok(c.at >= item.at + 5 * 60_000 && c.at <= item.at + 20 * 60_000);
        assert.equal(candidateLabel(c), '改约（15:00 的约：身上不舒服（生理期，肚子疼））');
        const off = { ...settings, occasions: settings.occasions.filter(o => o !== 'reschedule') };
        assert.equal(candidatesOn(day(12, 21), input({ settings: off })).some(x => x.occasion === 'reschedule'), false);
        assert.equal(candidatesOn(day(12, 22), input()).some(x => x.occasion === 'reschedule'), false, '别的日子没有');
    });

    test('说明：只说原因和提议改个时间，不给台词，不过度道歉，不抱怨', () => {
        const note = occasionNote(find(), '宝宝');
        assert.match(note, /你和宝宝今天 15:00 约好了和他去东门吃麻辣烫（东门口），但今天身上不舒服（生理期，肚子疼）：想跟他说一声，问问能不能改个时间/);
        assert.match(note, /原因只说这一条.*别编别的，别过分道歉，不抱怨他/);
        assert.match(note, /不抱怨对方没找你、没回你/);
        assert.doesNotMatch(note, /「[^」]*[！!]」/);
    });

    test('优先级：日子 > 改约 > 她那边的事；一天只剩一条时留改约', () => {
        const news = { id: 'camera', kind: 'camera' as const, day: '2026-12-21', at: t(12, 21, 11).getTime(), what: '买到了相机' };
        const history = [msg('assistant', t(12, 21, 9, 0), '早'), msg('user', t(12, 21, 9, 5), '早呀')];
        // 起床时刻从 2026-10-26 起每天不一样（ADR 0078），这一项是按 09:30 起床排的时间线：用没有浮动的作息
        const exact = { ...schedule, wake: { early: schedule.wake.early, lazy: schedule.wake.lazy, earlySlot: schedule.wake.earlySlot } };
        const plan = planFrom(t(12, 21, 9, 30).getTime(), input({ schedule: exact, news: [news], history, records: [{ id: '2026-12-21:morning', occasion: 'morning', plannedAt: '', at: t(12, 21, 9).toISOString(), result: 'sent' }] }));
        assert.deepEqual(plan.upcoming.map(c => c.occasion), ['reschedule']);
        assert.ok(plan.yielded.some(c => c.occasion === 'news'));
    });

    test('到点：约还在、障碍还在才发；快出门了不发；聊天里已经说到这件约了不发；正聊着不发', () => {
        const c = find();
        assert.equal(blockReason(c, c.at, input()), undefined);
        assert.equal(blockReason(c, c.at, input({ reschedules: [] })), '约没了，或者那个障碍没了');
        const late = { ...c, at: t(12, 21, 14, 50).getTime() };
        assert.equal(blockReason(late, late.at, input()), '快到约好的时间了');
        const said = [msg('user', new Date(item.at + 60_000), '今天下午三点东门口，别忘了'), msg('assistant', new Date(item.at + 120_000), '好')];
        assert.equal(blockReason(c, item.at + 40 * 60_000, input({ history: said })), '聊天里已经说到这件约了');
        const chatting = [msg('user', new Date(c.at - 5 * 60_000), '早'), msg('assistant', new Date(c.at - 4 * 60_000), '早呀')];
        assert.equal(blockReason(c, c.at, input({ history: chatting })), '正聊着，聊天里说');
    });
});

// DSH 10-15 对 ADR 0066 的实现复核（exchange/reviews/2026-10-15-dsh-review-0064-0068-impl.md 第 5 节），10-22 逐条修
describe('DSH 复核 0066：她的一天、说法、门、截断', () => {
    const ymd = (days: Date[]) => days.map(formatDate);
    const bodyOf = (body: Body) => (time: Date) => bodyAt(body, schedule, time);

    test('问题 3：下周三 = 下一周的周三（不是今天）；周末 = 周六周日；大后天 = 三天后', () => {
        const wed = day(10, 14); // 周三
        assert.deepEqual(ymd(meetupDays('下周三见面吧', wed)), ['2026-10-21']);
        assert.deepEqual(ymd(meetupDays('下个星期五一起吃饭', wed)), ['2026-10-23']);
        assert.deepEqual(ymd(meetupDays('下周日出来玩', wed)), ['2026-10-25']);
        assert.deepEqual(ymd(meetupDays('周末晚上一起吃饭', wed)), ['2026-10-17', '2026-10-18']);
        assert.deepEqual(ymd(meetupDays('周末晚上一起吃饭', day(10, 17))), ['2026-10-17', '2026-10-18'], '今天就是周六');
        assert.deepEqual(ymd(meetupDays('周末晚上一起吃饭', day(10, 18))), ['2026-10-18'], '今天是周日，只剩今天');
        assert.deepEqual(ymd(meetupDays('下周末去看展', wed)), ['2026-10-24', '2026-10-25']);
        assert.deepEqual(ymd(meetupDays('大后天见', wed)), ['2026-10-17']);
        assert.deepEqual(ymd(meetupDays('后天见', wed)), ['2026-10-16'], '后天照旧');
        assert.deepEqual(ymd(meetupDays('周六出来逛逛', wed)), ['2026-10-17'], '周X 照旧');
        assert.deepEqual(ymd(meetupDays('下周三见面吧', day(10, 19))), ['2026-10-28'], '周一问下周三 = 隔了一周');
    });

    test('问题 1：凌晨 00:00–02:00 他说「今天晚上」是日历上的今天（她的一天还没换），原来整桶丢掉', () => {
        const now = t(10, 15, 1, 0);
        const today = day(10, 14); // herDay(01:00) 还是 10-14
        assert.deepEqual(ymd(meetupDays('今天晚上一起吃饭吧', today, now)), ['2026-10-15']);
        assert.deepEqual(ymd(meetupDays('今天晚上一起吃饭吧', today)), ['2026-10-14'], '不给 now 就是老行为');
        assert.deepEqual(ymd(meetupDays('明天见面', today, now)), ['2026-10-15'], '明天照旧（她的一天的下一天）');
        // 10-15 周四 18:30 有课（见 DSH 的复现）：凌晨一点问也要列出来，且叫“今天”
        const lesson = classesOn(schedule, day(10, 15)).lessons.find(l => l.start.getHours() >= 16);
        if (lesson) {
            const line = describeObstacles(meetupDays('今天晚上一起吃饭吧', today, now), now, facts())!;
            assert.ok(line.includes('今天 '), line);
        }
    });

    test('问题 2a：他 20:00 说「明天见面」，前一个她的一天（到 02:00）的身体不能叫成“明天整天不舒服”', () => {
        const now = t(12, 21, 20, 0);
        const line = describeObstacles([day(12, 22)], now, facts({ bodyAt: bodyOf(cramps) }));
        assert.ok(!line || !/明天整天 身上不舒服/.test(line), line);
        // 同一个日历日里“今天”这一天自己的身体照旧
        assert.match(describeObstacles([day(12, 21)], now, facts({ bodyAt: bodyOf(cramps) }))!, /今天整天 身上不舒服（生理期，肚子疼）/);
    });

    test('问题 2b：跨零点的约（12-21 23:45–12-22 00:30）算 12-21 的身体，不把 12-22 的当成障碍', () => {
        const ids = obstaclesBetween(t(12, 21, 23, 45), t(12, 22, 0, 30), facts({ bodyAt: bodyOf(cramps) })).map(o => o.id);
        assert.ok(!ids.includes('unwell:2026-12-22'), ids.join());
        // 身体窗口是她的一天 [D 02:00, D+1 02:00)：02:00 之后才是下一天
        assert.ok(obstaclesBetween(t(12, 22, 2, 30), t(12, 22, 3, 0), facts({ bodyAt: bodyOf({ period: { ...cramps.period!, first: '2026-12-22' } }) })).some(o => o.id === 'unwell:2026-12-22'));
        assert.equal(obstaclesBetween(t(12, 22, 0, 30), t(12, 22, 1, 0), facts({ bodyAt: bodyOf({ period: { ...cramps.period!, first: '2026-12-22' } }) })).some(o => o.id === 'unwell:2026-12-22'), false, '00:30 还是前一天');
    });

    test('问题 7：障碍超过 6 条时写明后面还有没写出来的，不再说“没写到的时段你都有空”', () => {
        const many = Array.from({ length: 8 }, (_, i) => hw(`课${i}`, t(10, 14, 22), new Date(t(10, 15, 8).getTime() + i * 60_000)));
        const line = describeObstacles([day(10, 14), day(10, 15)], t(10, 14, 12), facts({ worldAt: () => world(many) }))!;
        assert.ok(line.includes('后面的还有没写出来的，别当成有空') && !line.includes('没写到的时段你都有空'), line);
        const few = describeObstacles([day(10, 14)], t(10, 14, 12), facts({ worldAt: () => world([hw('数据结构', t(10, 14, 22), t(10, 15, 8))]) }))!;
        assert.ok(few.includes('没写到的时段你都有空') && !few.includes('后面的还有'), few);
    });

    test('问题 4：约见面的门——取快递不算，「明天约吗」「约不约」算，「三点东门口」照旧算', () => {
        const says = (...texts: string[]) => mentionsMeetup(texts.map(content => ({ content })));
        assert.equal(says('我明天去楼下取个快递'), false);
        assert.equal(says('明天下午在门口拿外卖'), false);
        assert.equal(says('明天约吗'), true);
        assert.equal(says('周六约不约'), true);
        assert.equal(says('今天下午三点东门口，别忘了'), true);
        assert.equal(says('明天晚上六点楼下等你'), true);
        assert.equal(says('我下周有空'), false);
        assert.equal(says('你什么时候来'), false);
    });
});

