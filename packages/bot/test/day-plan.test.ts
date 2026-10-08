import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { bodyAt, type BodyNow } from '../src/body.ts';
import { dayPlan, describePlans, describeSlot, planNow, type PlanFacts, type Plans } from '../src/day-plan.ts';
import { readingActivities } from '../src/her-days.ts';
import { stateAt } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { worldAt } from '../src/world.ts';

const card = (tier: string) => loadCharacterCard(resolve(import.meta.dirname, `../../../characters/linmengyao/st/linmengyao-${tier}.json`));
const boyfriend = card('boyfriend');
const classmate = card('classmate');
const schedule = boyfriend.schedule!;
const plans = boyfriend.herWorld!.plans!;
const extra = readingActivities(boyfriend.books);
const day = (m: number, d: number) => new Date(2026, m - 1, d);
const at = (m: number, d: number, h: number, min = 0) => new Date(2026, m - 1, d, h, min);
/** 那天的事实，和 contact.ts、diary.ts 一样从世界和身体来 */
const facts = (c: ReturnType<typeof card>, m: number, d: number): PlanFacts => {
    const around = worldAt(c.herWorld!, c.schedule!, at(m, d, 23, 30))!;
    return { rain: around.weather?.rain, body: bodyAt(c.herWorld!.body!, c.schedule!, at(m, d, 15)), homework: around.homework };
};
const planOn = (c: ReturnType<typeof card>, m: number, d: number) => dayPlan(c.schedule!, c.herWorld!.plans, day(m, d), facts(c, m, d), readingActivities(c.books));

describe('她一天的打算会改（ADR 0034）', () => {
    test('打算就是作息里那一段的空闲活动；没事就照做', () => {
        // 10-08（周四）：没下雨，晚上没有明天要交的作业
        const slots = planOn(boyfriend, 10, 8);
        assert.deepEqual(slots.map(s => s.window), ['morning', 'afternoon', 'evening']);
        for (const slot of slots) assert.equal(slot.done, slot.planned);
        const evening = stateAt(schedule, at(10, 8, 21), extra).activity;
        assert.equal(evening.kind === 'free' && evening.text, slots[2]!.planned);
        assert.equal(planNow(schedule, slots, at(10, 8, 21)), undefined);
    });

    test('下雨：要出门的换成在宿舍；状态行写「本来打算……，下雨了，……」', () => {
        // 10-20（周二）下雨，上午打算去图书馆占座、下午在图书馆赶作业
        const slots = planOn(boyfriend, 10, 20);
        assert.equal(describeSlot(slots[0]!), '上午本来打算去图书馆占座，下雨了，在宿舍写作业');
        assert.equal(describeSlot(slots[1]!), '下午本来打算在图书馆赶作业，下雨了，在宿舍赶作业');
        assert.equal(planNow(schedule, slots, at(10, 20, 15)), '本来打算在图书馆赶作业，下雨了，在宿舍赶作业');
        assert.match(describePlans(slots)!, /^\[你今天的打算（早上起来想的/);
    });

    test('作业明天要交：晚上打算玩的先赶作业，写完回到原来的打算', () => {
        // 10-12（周一）晚上打算打独立游戏，计算机网络技术的作业 10-13 交、22:00 写完
        const slots = planOn(boyfriend, 10, 12);
        const evening = slots.find(s => s.window === 'evening')!;
        assert.equal(describeSlot(evening), '晚上本来打算打独立游戏，计算机网络技术的作业明天要交，先赶作业');
        assert.equal(planNow(schedule, slots, at(10, 12, 19, 30)), '本来打算打独立游戏，计算机网络技术的作业明天要交，先赶作业');
        assert.equal(planNow(schedule, slots, new Date(evening.until!.getTime() + 60_000)), undefined, '写完了');
        // 本来就打算写作业的不用改（10-29 晚上「熬夜赶作业」）
        assert.ok(planOn(boyfriend, 10, 29).every(s => s.done === s.planned));
    });

    test('身上：肚子疼得厉害就躺着；感冒、不太舒服时只是不出门；说不出口的档位只说不舒服', () => {
        const fixed: Plans = { outings: [{ text: '去图书馆占座', indoors: '在宿舍写作业' }], study: [], rest: '躺在床上刷手机' };
        const one = (planned: string, body: BodyNow, detail = true) => {
            const b = { ...body, ...(body.period ? { period: { ...body.period, detail } } : {}) };
            // 用 10-08 上午的打算（去图书馆占座）当「打算」，换掉事实看怎么结算
            const slots = dayPlan(schedule, { ...fixed, outings: [{ text: planned, indoors: '在宿舍写作业' }] }, day(10, 8), { body: b }, extra);
            return slots[0]!;
        };
        const planned = planOn(boyfriend, 10, 8)[0]!.planned;
        assert.equal(one(planned, { period: { day: 1, cramps: 'bad', detail: true } }).done, '躺在床上刷手机');
        assert.equal(one(planned, { period: { day: 1, cramps: 'bad', detail: true } }).because, '肚子疼得厉害');
        assert.equal(one(planned, { period: { day: 1, cramps: 'bad', detail: false } }, false).because, '身上不太舒服');
        assert.equal(one(planned, { cold: { day: 2, of: 4 } }).because, '感冒了，不想出门');
        assert.equal(one(planned, { period: { day: 2, cramps: 'mild', detail: true } }).done, '在宿舍写作业');
    });

    test('男朋友档和同学档同一时刻是同一件事（看不到的那条是 cover）；一个月里总有改了的打算', () => {
        let changed = 0;
        for (let d = 1; d <= 31; d++) {
            const a = planOn(boyfriend, 10, d);
            const b = planOn(classmate, 10, d);
            assert.equal(a.length, b.length, `10-${d}`);
            a.forEach((slot, i) => {
                assert.ok(slot.planned === b[i]!.planned || b[i]!.planned === '窝着刷手机', `10-${d} ${slot.window}：${slot.planned} / ${b[i]!.planned}`);
                assert.equal(slot.done === slot.planned, b[i]!.done === b[i]!.planned, `10-${d} ${slot.window} 改没改`);
            });
            changed += a.filter(s => s.done !== s.planned).length;
        }
        assert.ok(changed >= 5, `10 月改了 ${changed} 回`);
    });

    test('卡上没有 plans：照作息，不改', () => {
        const slots = dayPlan(schedule, undefined, day(10, 20), facts(boyfriend, 10, 20), extra);
        assert.ok(slots.every(s => s.done === s.planned));
        assert.equal(plans.rest, '躺在床上刷手机');
    });
});
