import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DEFAULT_ASKS, describeAsk, judgeAsk, npcAsksBetween, npcAsksOn, type AskFacts, type AsksConfig, type NpcAsk } from '../src/world/npc-asks.ts';
import { classesOn, formatDate } from '../src/life/schedule.ts';
import { npcStates } from '../src/world/npc.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { syntheticCardPath } from './fixtures/card.ts';

const card = (tier: string) => loadCharacterCard(syntheticCardPath(tier));
const boyfriend = card('boyfriend');
const classmate = card('classmate');
const schedule = boyfriend.schedule!;
const people = boyfriend.herWorld!.people;
const day = (m: number, d: number, y = 2026) => new Date(y, m - 1, d);
const minutes = (t: Date) => t.getHours() * 60 + t.getMinutes();
// 源码里的默认约（DEFAULT_ASKS）按真实角色的 NPC id 写的；合成卡的两个 NPC 用同样两份配置：
// 室友（在学校、一起吃饭自习）用第一份，高中闺蜜（不在一个学校、视频）用第二份
const [nearby, faraway] = Object.values(DEFAULT_ASKS) as [AsksConfig, AsksConfig];
const ASKS: Record<string, AsksConfig> = { 'su_yutong': nearby, 'chen_jianing': faraway };

// 一个学期多一点：学期第 1 周起 ~20 周（课表按学期算），再加一整年看分布
const semester = npcAsksBetween(people, schedule, day(9, 14), day(12, 31), ASKS);
// 真课表只有一个学期（学期外不约），统计占比要样本：把学期拉长到三年多、去掉假期，其余照旧
const longSchedule = { ...schedule, semester: { ...schedule.semester, weeks: 200 }, holidays: [] as typeof schedule.holidays, courses: schedule.courses.map(c => ({ ...c, weeks: '1-200' })) };
const many = npcAsksBetween(people, longSchedule, day(9, 14), day(12, 31, 2029), ASKS);

describe('闺蜜的约（ADR 0061）', () => {
    test('按日期推，重放一样；按天取和按段取是同一批', () => {
        const again = npcAsksBetween(people, schedule, day(9, 14), day(12, 31), ASKS);
        assert.deepEqual(semester.map(a => a.id), again.map(a => a.id));
        assert.deepEqual(npcAsksOn(people, schedule, day(10, 17), ASKS).map(a => a.id), semester.filter(a => a.day === '2026-10-17').map(a => a.id));
        assert.deepEqual(semester, again);
        assert.equal(new Set(many.map(a => a.id)).size, many.length, 'id 不重复');
    });

    test('频率：每月次数跟着配置走（扣掉病着、放假不约的日子）；学期里每周大约 1–2 次', () => {
        const weeks = (day(12, 31).getTime() - day(9, 14).getTime()) / (7 * 86_400_000);
        const perWeek = semester.length / weeks;
        assert.ok(perWeek > 0.8 && perWeek < 2.2, `学期里每周 ${perWeek.toFixed(2)} 次`);
        const roommate = semester.filter(a => a.person === 'su_yutong').length;
        const friend = semester.filter(a => a.person === 'chen_jianing').length;
        assert.ok(roommate >= 8 && roommate <= 20, `室友 ${roommate}`);
        assert.ok(friend >= 6 && friend <= 16, `高中闺蜜 ${friend}`);
    });

    test('每个约都合理：在上课的日子 / 周末，不在放假、学期外；开始落在那一段里；和课前后各留十分钟；一天一个人最多一个', () => {
        for (const ask of many) {
            const d = new Date(`${ask.day}T00:00`);
            const { lessons, outsideSemester } = classesOn(longSchedule, d);
            assert.ok(!outsideSemester, `${ask.id} 学期外`);
            assert.ok(!longSchedule.holidays.some(h => h.start <= ask.day && ask.day <= h.end), `${ask.id} 放假`);
            const config = ASKS[ask.person]!;
            const kind = config.kinds.find(k => k.id === ask.kind)!;
            if (kind.when === 'class_day') assert.ok(lessons.length > 0, `${ask.id} 没课的日子约了上课日的事`);
            if (kind.when === 'weekend') assert.ok(d.getDay() === 0 || d.getDay() === 6, `${ask.id} 不是周末`);
            for (const l of lessons) assert.ok(ask.start >= new Date(l.end.getTime() + 9 * 60_000) || new Date(ask.start.getTime() + ask.minutes * 60_000) <= new Date(l.start.getTime() - 9 * 60_000), `${ask.id} 撞课`);
            assert.ok(ask.askedAt < ask.start, `${ask.id} 说的时候已经过了开始`);
            assert.ok(ask.start.getTime() - ask.askedAt.getTime() >= 90 * 60_000, `${ask.id} 提前不到一个半小时`);
        }
        const perDay = new Map<string, number>();
        for (const ask of many) perDay.set(`${ask.day} ${ask.person}`, (perDay.get(`${ask.day} ${ask.person}`) ?? 0) + 1);
        assert.ok([...perDay.values()].every(n => n === 1));
    });

    test('对方自己病着、忙着、在家的时候不发起约；约了之后新发的病 / 忙 / 回家 → 取消，理由是那个状态', () => {
        for (const ask of many) {
            const person = people.find(p => p.id === ask.person)!;
            const askedDay = new Date(ask.askedAt.getFullYear(), ask.askedAt.getMonth(), ask.askedAt.getDate());
            const blocking = (d: Date) => npcStates(person.id, person.life, longSchedule, d).filter(s => s.kind === 'sick' || s.kind === 'busy' || s.kind === 'home');
            assert.equal(blocking(askedDay).length, 0, `${ask.id} 说的那天她自己病着 / 忙 / 在家`);
            const onDay = blocking(new Date(`${ask.day}T00:00`));
            if (onDay.length) {
                assert.equal(ask.outcome, 'cancelled', `${ask.id} 那天她有事却没取消`);
                assert.equal(ask.fromState, onDay[0]!.kind);
            } else assert.equal(ask.fromState, undefined, `${ask.id} 没有状态却标了状态`);
        }
    });

    test('结果的占比跟着配置走：取消、改约、迟到各有，按时占多数；改约只往后、迟到在范围里、理由都在配置里', () => {
        const by = (o: string) => many.filter(a => a.outcome === o);
        const share = (n: number) => n / many.length;
        // 配置：迟到 15% / 改约 10–15% / 取消 5%，再加上新发的病、忙、回家取消的几个
        const within = (o: string, lo: number, hi: number) => assert.ok(share(by(o).length) >= lo && share(by(o).length) <= hi, `${o} ${share(by(o).length).toFixed(3)}`);
        within('on_time', 0.55, 0.80);
        within('late', 0.08, 0.20);
        within('moved', 0.07, 0.18);
        within('cancelled', 0.03, 0.13);
        assert.ok(many.length > 200, `三年多只有 ${many.length} 次`);
        for (const ask of by('late')) {
            const [lo, hi] = ASKS[ask.person]!.late.minutes;
            const late = (ask.actualStart!.getTime() - ask.start.getTime()) / 60_000;
            assert.ok(late >= lo && late <= hi, `${ask.id} 迟到 ${late} 分钟`);
            assert.ok(ASKS[ask.person]!.late.reasons.some(r => r.text === ask.reason!.text));
        }
        for (const ask of by('moved')) {
            const [lo, hi] = ASKS[ask.person]!.moved.shiftMinutes;
            const shift = (ask.actualStart!.getTime() - ask.start.getTime()) / 60_000;
            assert.ok(shift >= lo && shift <= hi && shift % 10 === 0, `${ask.id} 改到 ${shift} 分钟以后`);
            assert.ok(minutes(ask.actualStart!) + ask.minutes <= 22 * 60 + 30, `${ask.id} 改得太晚`);
        }
        for (const ask of by('cancelled').filter(a => !a.fromState)) assert.ok(ASKS[ask.person]!.cancelled.reasons.some(r => r.text === ask.reason!.text));
        for (const ask of by('on_time')) assert.equal(ask.reason, undefined);
    });

    test('长期计划 C 阶段的门槛：两周里至少一次变卦（迟到、改约或取消）——任意连续 14 天窗口里都不会连着十几周一次没有', () => {
        let quiet = 0;
        for (let start = day(9, 14); start < day(12, 17); start = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 7)) {
            const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 13);
            const asks = npcAsksBetween(people, schedule, start, end, ASKS);
            if (!asks.some(a => a.outcome !== 'on_time')) quiet++;
        }
        assert.ok(quiet <= 6, `${quiet} 个两周窗口里一次变卦都没有`);
    });

    test('同学档的卡上没有高中闺蜜，也就没有她的约；没写配置的人没有约', () => {
        const friendOnly = { 'chen_jianing': ASKS['chen_jianing']! };
        assert.ok(npcAsksBetween(people, schedule, day(9, 14), day(12, 31), friendOnly).length > 0, '男朋友档有她的约');
        assert.deepEqual(npcAsksBetween(classmate.herWorld?.people ?? [], classmate.schedule!, day(9, 14), day(12, 31), friendOnly), []);
        assert.deepEqual(npcAsksBetween(people, schedule, day(9, 14), day(12, 31), {}), []);
    });

    test('一次放鸽子不会让别的约不发生（每个约各自按哈希，互不影响）', () => {
        const only = (id: string): Record<string, AsksConfig> => ({ [id]: ASKS[id]! });
        const together = semester.filter(a => a.person === 'su_yutong').map(a => a.id);
        const alone = npcAsksBetween(people, schedule, day(9, 14), day(12, 31), only('su_yutong')).map(a => a.id);
        assert.deepEqual(together, alone);
    });
});

describe('她答不答应（规则判，不问模型）', () => {
    const base = semester.find(a => a.kind === 'library')!;
    const none: AskFacts = { classes: [], meetups: [] };
    const win = (offset = 0) => ({ start: new Date(base.start.getTime() + offset * 60_000), end: new Date(base.start.getTime() + (offset + base.minutes) * 60_000) });

    test('没撞上就答应', () => assert.deepEqual(judgeAsk(base, none), { accept: true }));

    test('撞他的约 > 撞课 > 身上不舒服 > 作业快交了', () => {
        const meetup = { start: new Date(base.start.getTime() + 30 * 60_000), end: new Date(base.start.getTime() + 120 * 60_000) };
        const lesson = { start: new Date(base.start.getTime() - 30 * 60_000), end: new Date(base.start.getTime() + 30 * 60_000) };
        const all: AskFacts = { classes: [lesson], meetups: [meetup], unwell: true, homeworkDue: new Date(base.start.getTime() + 24 * 3600_000) };
        assert.deepEqual(judgeAsk(base, all), { accept: false, because: 'meetup', reason: '跟他约好了' });
        assert.equal((judgeAsk(base, { ...all, meetups: [] }) as { because: string }).because, 'class');
        assert.equal((judgeAsk(base, { ...all, meetups: [], classes: [] }) as { because: string }).because, 'unwell');
        assert.equal((judgeAsk(base, { ...all, meetups: [], classes: [], unwell: false }) as { because: string }).because, 'homework');
    });

    test('只擦边不算撞（前一节课刚好在约开始时结束）', () => {
        const lesson = { start: new Date(base.start.getTime() - 100 * 60_000), end: base.start };
        assert.deepEqual(judgeAsk(base, { ...none, classes: [lesson] }), { accept: true });
    });

    test('作业：48 小时之内要交才推；吃饭不推；已经过期 / 还早得很不推', () => {
        const due = (hours: number) => ({ ...none, homeworkDue: new Date(base.start.getTime() + hours * 3600_000) });
        assert.equal(judgeAsk(base, due(47)).accept, false);
        assert.equal(judgeAsk(base, due(49)).accept, true);
        assert.equal(judgeAsk(base, due(-1)).accept, true);
        const meal = semester.find(a => a.kind === 'dinner' || a.kind === 'canteen')!;
        assert.equal(judgeAsk(meal, { ...none, homeworkDue: new Date(meal.start.getTime() + 3600_000) }).accept, true);
    });

    test('改约、迟到之后按新的那段再判一次', () => {
        const lesson = { start: new Date(base.start.getTime() + 120 * 60_000), end: new Date(base.start.getTime() + 180 * 60_000) };
        assert.equal(judgeAsk(base, { ...none, classes: [lesson] }).accept, true);
        assert.equal(judgeAsk(base, { ...none, classes: [lesson] }, win(100)).accept, false);
    });
});

describe('日志里的一句', () => {
    test('按时 / 迟到 / 改约 / 取消各一句，写上时刻和理由', () => {
        const pick = (o: string) => many.find(a => a.outcome === o && !a.fromState)!;
        assert.match(describeAsk(pick('on_time')), /按时/);
        assert.match(describeAsk(pick('late')), /迟到到 \d\d:\d\d：/);
        assert.match(describeAsk(pick('moved')), /改到 \d\d:\d\d：/);
        assert.match(describeAsk(pick('cancelled')), /取消：/);
        const ask: NpcAsk = pick('on_time');
        assert.ok(describeAsk(ask).includes(ask.name) && describeAsk(ask).includes(formatDate(ask.start).slice(0, 0)));
    });
});
