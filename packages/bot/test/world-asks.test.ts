import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { busySpans } from '../src/life-selector.ts';
import { dayPlan, describePlans } from '../src/day-plan.ts';
import { herDay } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { dateSpan, describeDate, describeWorld, occupationAt, planDates, recapDay, recentWith, worldAt, type FriendDate, type WorldNow } from '../src/world.ts';

const card = (tier: string) => loadCharacterCard(resolve(import.meta.dirname, `../../../characters/linmengyao/st/linmengyao-${tier}.json`));
const boyfriend = card('boyfriend');
const classmate = card('classmate');
const schedule = boyfriend.schedule!;
const off = boyfriend.herWorld!;
const on = { ...off, asks: true };
const day = (m: number, d: number, h = 0, min = 0) => new Date(2026, m - 1, d, h, min);

/** 学期里每一天 23:00 的世界（那一刻今天的约都已知），带日期 */
const nights: { at: Date; now: WorldNow }[] = [];
for (let d = day(9, 14, 23); d < day(12, 31); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 23)) {
    const now = worldAt(on, schedule, d);
    if (now) nights.push({ at: d, now });
}
const todays = (now: WorldNow) => (now.dates ?? []).filter(x => `${x.start.getFullYear()}-${String(x.start.getMonth() + 1).padStart(2, '0')}-${String(x.start.getDate()).padStart(2, '0')}` === now.day);
const all = nights.flatMap(({ now }) => todays(now).map(date => ({ date, now })));
const first = (f: (d: FriendDate) => boolean) => all.find(x => f(x.date));

describe('闺蜜的约进世界（ADR 0061，World.asks）', () => {
    test('没开关就没有约：dates 不存在，「你那边」没有「约：」，随机的一起吃午饭照旧会有', () => {
        let lunches = 0;
        for (let d = day(9, 14, 23); d < day(12, 31); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 23)) {
            const now = worldAt(off, schedule, d)!;
            assert.equal(now.dates, undefined);
            assert.doesNotMatch(describeWorld(now, d) ?? '', /约：/);
            lunches += now.events.filter(e => e.id === 'lunch_with_friend').length;
        }
        assert.ok(lunches > 3, `关着时一学期只有 ${lunches} 次随机一起吃午饭`);
    });

    test('开了：随机的一起吃午饭让位给「约」，别的小事照旧', () => {
        for (const { now } of nights) assert.ok(!now.events.some(e => e.id === 'lunch_with_friend'));
        assert.ok(nights.some(({ now }) => now.events.length > 0), '别的小事还在');
        assert.ok(all.some(x => x.date.kind === 'canteen'), '学期里有约在食堂吃饭的');
    });

    test('同一刻重放一样；同学档的卡上没有这两个人，也就没有约', () => {
        const at = nights.find(n => todays(n.now).length)!.at;
        assert.deepEqual(worldAt(on, schedule, at), worldAt(on, schedule, at));
        const mate = { ...classmate.herWorld!, asks: true };
        for (const { at: when } of nights) assert.equal(worldAt(mate, classmate.schedule!, when)?.dates, undefined);
    });

    test('前一晚说的约，前一晚就在「你那边」；说之前还不知道', () => {
        const x = all.find(({ date }) => date.askedAt.getDate() !== date.start.getDate() && date.askedAt.getHours() >= 20)!;
        assert.ok(x, '学期里有前一晚说的约');
        const before = new Date(x.date.askedAt.getTime() - 60_000);
        const after = new Date(x.date.askedAt.getTime() + 60_000);
        assert.ok(!(worldAt(on, schedule, before)!.dates ?? []).some(d => d.id === x.date.id));
        const now = worldAt(on, schedule, after)!;
        assert.ok((now.dates ?? []).some(d => d.id === x.date.id));
        assert.match(describeWorld(now, after) ?? '', new RegExp(`约：.*约好明天 ${String(x.date.start.getHours()).padStart(2, '0')}:`));
    });

    test('答应了的约：到点状态行写在一起；约的是吃饭的那顿，用「在食堂和某某吃饭」盖住「在食堂吃午饭」', () => {
        const x = first(d => d.held && d.kind !== 'canteen' && d.kind !== 'dinner' && d.outcome === 'on_time')!;
        const during = new Date(dateSpan(x.date).start.getTime() + 5 * 60_000);
        const now = worldAt(on, schedule, during)!;
        assert.equal(occupationAt(now, during), x.date.doing);
        const meal = first(d => d.held && d.kind === 'canteen')!;
        const mealAt = new Date(dateSpan(meal.date).start.getTime() + 5 * 60_000);
        assert.equal(occupationAt(worldAt(on, schedule, mealAt)!, mealAt), meal.date.doing);
        assert.match(meal.date.doing, /食堂/);
    });

    test('选择器让出这一段（非吃饭的约进 busySpans，吃饭的由饭点处理）', () => {
        const x = first(d => d.held && d.kind !== 'canteen' && d.kind !== 'dinner')!;
        const spans = busySpans(x.now);
        const span = dateSpan(x.date);
        assert.ok(spans.some(s => s.start.getTime() === span.start.getTime() && s.end.getTime() === span.end.getTime() && s.text === x.date.doing));
        const meal = first(d => d.held && d.kind === 'canteen')!;
        assert.ok(!busySpans(meal.now).some(s => s.text === meal.date.doing));
    });

    test('迟到：到点前只写约好的，到点没到才写「她还没到」，到了写迟到几分钟；占的是实际那一段', () => {
        const x = first(d => d.outcome === 'late' && d.held)!;
        const ahead = new Date(x.date.start.getTime() - 60 * 60_000);
        const wait = new Date(x.date.start.getTime() + 60_000);
        const there = new Date(dateSpan(x.date).start.getTime() + 60_000);
        const read = (at: Date) => describeWorld(worldAt(on, schedule, at)!, at) ?? '';
        assert.match(read(ahead), /约好/);
        assert.doesNotMatch(read(ahead), /迟到|还没到/);
        assert.match(read(wait), /她还没到/);
        assert.match(read(there), /她迟到了 \d+ 分钟/);
        assert.equal(occupationAt(worldAt(on, schedule, there)!, there), x.date.doing);
        assert.equal(occupationAt(worldAt(on, schedule, wait)!, wait) === x.date.doing, false, '她还没到的时候不算在一起');
    });

    test('改约：通知之前原样，通知之后写改到几点；占的是新的时间', () => {
        const x = first(d => d.outcome === 'moved' && d.held)!;
        const before = new Date(x.date.knownAt!.getTime() - 60_000);
        const after = new Date(x.date.knownAt!.getTime() + 60_000);
        assert.doesNotMatch(describeWorld(worldAt(on, schedule, before)!, before) ?? '', /改到/);
        assert.match(describeWorld(worldAt(on, schedule, after)!, after) ?? '', /她说改到 \d\d:\d\d/);
        const newTime = new Date(x.date.actualStart!.getTime() + 60_000);
        assert.equal(occupationAt(worldAt(on, schedule, newTime)!, newTime), x.date.doing);
    });

    test('取消：通知之后写去不了了（私事理由只给说得出口的档位）；不占时间', () => {
        const x = first(d => d.outcome === 'cancelled' && !d.declined)!;
        const after = new Date(x.date.knownAt!.getTime() + 60_000);
        const now = worldAt(on, schedule, after)!;
        assert.match(describeWorld(now, after) ?? '', /她说去不了了/);
        assert.equal(x.date.held, false);
        const during = new Date(x.date.start.getTime() + 5 * 60_000);
        assert.notEqual(occupationAt(worldAt(on, schedule, during)!, during), x.date.doing);
        assert.ok(!busySpans(worldAt(on, schedule, new Date(x.date.start.getTime() + 12 * 3600_000))!).some(s => s.text === x.date.doing));
    });

    test('她推掉的：有理由，写「你推掉了」，不占时间', () => {
        const x = first(d => d.declined !== undefined && d.declinedAt!.getTime() === d.askedAt.getTime())!;
        assert.ok(x, '学期里有她推掉的');
        assert.equal(x.date.held, false);
        const after = new Date(x.date.askedAt.getTime() + 60_000);
        assert.match(describeWorld(worldAt(on, schedule, after)!, after) ?? '', /你推掉了（.+）/);
    });

    test('改约、迟到之后才撞上她的安排的：知道变了之前只写约好的，知道之后才写「你推掉了」', () => {
        // 真学期里一次都没遇上这种（都是说的时候就推掉了），把学期拉长去找
        const long = { ...schedule, semester: { ...schedule.semester, weeks: 200 }, holidays: [] as typeof schedule.holidays, courses: schedule.courses.map(c => ({ ...c, weeks: '1-200' })) };
        let found: FriendDate | undefined;
        for (let d = day(9, 14, 23); d < new Date(2027, 2, 1) && !found; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 23)) {
            found = (worldAt(on, long, d)?.dates ?? []).find(x => x.declined !== undefined && x.declinedAt!.getTime() > x.askedAt.getTime());
        }
        assert.ok(found, '拉长的学期里有改约之后才推掉的');
        const before = new Date(found.declinedAt!.getTime() - 60_000);
        const after = new Date(found.declinedAt!.getTime() + 60_000);
        assert.doesNotMatch(describeWorld(worldAt(on, long, before)!, before) ?? '', /你推掉了/);
        assert.match(describeWorld(worldAt(on, long, after)!, after) ?? '', /你推掉了（.+）/);
        assert.equal(found.held, false);
    });

    test('一天的打算里写上约：接在原来的打算后面；改约要等她知道才换时间，取消要等她知道才去掉，推掉的不写', () => {
        const plan = (now: WorldNow, at: Date) => describePlans(schedule, dayPlan(schedule, on.plans, herDay(schedule, at), { homework: now.homework, dates: planDates(now, at) }), at) ?? '';
        const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const moved = first(d => d.outcome === 'moved' && d.held && d.kind === 'video')!;
        const early = new Date(moved.date.knownAt!.getTime() - 60_000);
        const late = new Date(moved.date.knownAt!.getTime() + 60_000);
        assert.match(plan(worldAt(on, schedule, early)!, early), new RegExp(`${hhmm(moved.date.start)} 和${moved.date.person.name}${moved.date.what}`));
        assert.match(plan(worldAt(on, schedule, late)!, late), new RegExp(`${hhmm(moved.date.actualStart!)} 和${moved.date.person.name}${moved.date.what}`));
        const cancelled = first(d => d.outcome === 'cancelled' && !d.declined)!;
        const before = new Date(cancelled.date.knownAt!.getTime() - 60_000);
        const after = new Date(cancelled.date.knownAt!.getTime() + 60_000);
        assert.match(plan(worldAt(on, schedule, before)!, before), new RegExp(`${hhmm(cancelled.date.start)} 和${cancelled.date.person.name}`));
        assert.doesNotMatch(plan(worldAt(on, schedule, after)!, after), new RegExp(`和${cancelled.date.person.name}${cancelled.date.what}`));
        const declined = first(d => d.declined !== undefined && d.declinedAt!.getTime() === d.askedAt.getTime())!;
        const when = new Date(declined.date.askedAt.getTime() + 60_000);
        assert.doesNotMatch(plan(worldAt(on, schedule, when)!, when), new RegExp(`和${declined.date.person.name}${declined.date.what}`));
    });

    test('复盘那天、说起她时都带上约', () => {
        const x = first(d => d.person.id === 'su_yutong' && d.start < day(12, 20))!;
        const lines = recapDay(worldAt(on, schedule, new Date(x.date.start.getFullYear(), x.date.start.getMonth(), x.date.start.getDate(), 23, 30))!);
        assert.ok(lines.some(l => l.includes('苏雨桐') && l.includes(x.date.what.slice(0, 2))), lines.join('｜'));
        // 说起她时：先一句数（按时的也算进去，免得只剩变卦的让她以为总在放鸽子），再写最近两件变卦
        const changed = first(d => d.person.id === 'su_yutong' && d.outcome !== 'on_time' && !d.declined && d.start < day(12, 20))!;
        const recent = recentWith(on, schedule, new Date(changed.date.start.getTime() + 24 * 3600_000), 'su_yutong')!;
        assert.ok(recent.some(l => /^最近 14 天约过 \d+ 次（.*）$/.test(l)), recent.join('｜'));
        assert.ok(recent.some(l => l.includes('苏雨桐') && l.includes(changed.date.what.slice(0, 2))), recent.join('｜'));
        const tally = recent.find(l => l.startsWith('最近 14 天约过'))!;
        assert.ok(/按时 \d+|迟到 \d+|改时间 \d+|她临时去不了 \d+/.test(tally));
        assert.deepEqual(recentWith(off, schedule, new Date(x.date.start.getTime() + 24 * 3600_000), 'su_yutong')!.filter(l => /约的|推掉/.test(l)), []);
    });

    test('私事理由：说不出口的档位不写理由（只写去不了了）', () => {
        const privately = all.find(({ date }) => date.outcome === 'cancelled' && date.reason === undefined && !date.declined);
        // 关掉说得出口的档位（body.period.detail）：私事理由不出现
        const noDetail = { ...on, body: on.body ? { ...on.body, period: on.body.period ? { ...on.body.period, detail: false } : undefined } : undefined };
        let seen = 0;
        for (const { at } of nights) {
            for (const d of worldAt(noDetail, schedule, at)?.dates ?? []) {
                if (d.reason !== undefined) seen++;
                assert.ok(!['突然肚子疼', '家里有点事', '感冒了'].includes(d.reason ?? ''), `${d.id} 把私事理由给了说不出口的档位`);
            }
        }
        assert.ok(seen > 0 || privately === undefined, '至少还有普通理由');
    });

    test('一句话的写法：只写事实，没有台词', () => {
        const x = first(d => d.outcome === 'late' && d.held)!;
        const herToday = new Date(`${x.now.day}T00:00:00`);
        const line = describeDate(x.date, new Date(x.date.start.getTime() + 3600_000), herToday);
        assert.doesNotMatch(line, /[“”"「」！!？?]/);
    });
});
