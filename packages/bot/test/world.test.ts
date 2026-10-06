import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { Schedule } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { describeWorld, parseWorld, simulateWorld, worldAt, worldLogger, type World } from '../src/world.ts';

const cards = resolve(import.meta.dirname, '../../../characters/linmengyao/st');
const boyfriend = loadCharacterCard(join(cards, 'linmengyao-boyfriend.json'));
const classmate = loadCharacterCard(join(cards, 'linmengyao-classmate.json'));
const schedule = boyfriend.schedule!;
const world = boyfriend.herWorld!;
const at = (text: string) => new Date(`${text}+08:00`);

/** 换掉卡上世界的某几块（随机部分按日期取哈希，换概率能把「下不下雨」「有没有快递」钉死） */
const patch = (change: (w: World) => void): World => {
    const copy = structuredClone(world);
    change(copy);
    return copy;
};

describe('她的世界（ADR 0021 W1）', () => {
    test('卡上有世界；同一时刻可复现，各档位同一天的猫、天气、快递一样，只是看得到的块不同', () => {
        const now = at('2026-10-11T21:30:00');
        const a = worldAt(world, schedule, now)!;
        assert.deepEqual(worldAt(world, schedule, now), a);
        const low = worldAt(classmate.herWorld!, classmate.schedule!, now)!;
        assert.deepEqual(low.weather, a.weather);
        assert.deepEqual(low.cat, a.cat);
        assert.deepEqual(low.parcels, a.parcels);
        assert.ok(a.cameraFund && !low.cameraFund, '相机基金只给 BFGK');
        assert.equal(low.familyCall, undefined);
    });

    test('猫：下雨不下楼；喂一次少一天猫粮，剩得少了下单猫粮，取回来就加一袋；吃完了不喂', () => {
        const dry = patch(w => { w.weather!.rainChance = 0; w.parcels!.perWeek = 0; w.cat!.food.left = 4; w.cat!.food.reorderAt = 2; });
        const timeline = simulateWorld(dry, schedule, at('2026-09-20T23:00:00'));
        const fed = [...timeline.days.values()].filter(d => d.cat?.fed).length;
        assert.ok(fed > 4, '猫粮补上了，接着喂');
        const food = timeline.parcels.filter(p => p.food);
        assert.ok(food.length >= 1 && food.every(p => p.item === '猫粮'));
        assert.ok(food[0]!.picked, '猫粮到了就取');
        const rainy = patch(w => { w.weather!.rainChance = 1; });
        const day = worldAt(rainy, schedule, at('2026-09-15T22:30:00'))!;
        assert.deepEqual(day.cat!.today, { skipped: 'rain' });
        const empty = patch(w => { w.weather!.rainChance = 0; w.cat!.food.left = 0; w.cat!.food.reorderAt = -1; });
        assert.deepEqual(worldAt(empty, schedule, at('2026-09-02T22:30:00'))!.cat!.today, { skipped: 'no_food' });
    });

    test('还没到的不写：晚上喂猫之前是「还没下楼」，之后是几点喂的；今天的小事只写已经发生的', () => {
        const dry = patch(w => { w.weather!.rainChance = 0; });
        const before = worldAt(dry, schedule, at('2026-09-16T12:00:00'))!;
        assert.ok('later' in before.cat!.today);
        const after = worldAt(dry, schedule, at('2026-09-16T23:30:00'))!;
        assert.ok('fed' in after.cat!.today);
        const always = patch(w => { w.events = [{ id: 'x', text: '傍晚的小事', window: 'evening', chance: 1, when: 'any' }]; });
        assert.equal(worldAt(always, schedule, at('2026-09-16T12:00:00'))!.events.length, 0);
        assert.equal(worldAt(always, schedule, at('2026-09-16T23:30:00'))!.events.length, 1);
    });

    test('快递：到了驿站、空的时候取；人不在学校取不了，过了最后一天退回；先下单的先到', () => {
        const busy = patch(w => { w.parcels!.perWeek = 7; });
        const timeline = simulateWorld(busy, schedule, at('2026-09-30T23:00:00'));
        const normal = timeline.parcels.filter(p => !p.food);
        assert.ok(normal.length > 10);
        for (const parcel of normal.filter(p => p.picked)) {
            assert.ok(parcel.picked! >= parcel.arrive, '到了才取');
            assert.ok(parcel.picked!.toISOString().slice(0, 10) <= parcel.deadline, '最后一天之前');
        }
        // 国庆回家：那几天到的快递取不了
        const home = patch(w => { w.parcels!.perWeek = 7; w.awayHolidays = ['国庆节']; });
        const parcels = simulateWorld(home, schedule, at('2026-10-12T23:00:00')).parcels.filter(p => !p.food);
        const awayStart = at('2026-10-01T00:00:00');
        const awayEnd = at('2026-10-08T00:00:00');
        assert.ok(parcels.every(p => !p.picked || p.picked < awayStart || p.picked >= awayEnd), '回家那几天没取');
        assert.ok(parcels.every(p => p.ordered < '2026-10-01' || p.ordered > '2026-10-07'), '不在学校不下单');
        assert.ok(parcels.some(p => p.returned), '放假前下单、放假里过期的退回');
    });

    test('作业：上课时留，下一次这门课之前交，写完的时刻在交之前；不在列表里的课型不留', () => {
        const all = patch(w => { w.homework!.chance = 1; w.homework!.earlyChance = 0; });
        const timeline = simulateWorld(all, schedule, at('2026-09-20T23:00:00'));
        assert.ok(timeline.homework.length > 3);
        for (const item of timeline.homework) {
            assert.ok(item.done < item.due, `${item.course} 交之前写完`);
            assert.ok(item.course, '男朋友档看得到课名');
        }
        const none = patch(w => { w.homework!.kinds = ['pe']; w.homework!.chance = 1; });
        assert.ok(simulateWorld(none, schedule, at('2026-09-20T23:00:00')).homework.every(h => !/Linux|MySQL/.test(h.course)));
    });

    test('相机基金：每周那天晚上存一笔，到目标停；存之前还是上周的数', () => {
        const fund = world.cameraFund!;
        const sunday = at('2026-09-06T20:00:00');
        assert.equal(worldAt(world, schedule, sunday)!.cameraFund!.saved, fund.saved, '21:00 存之前');
        assert.equal(worldAt(world, schedule, at('2026-09-06T22:00:00'))!.cameraFund!.saved, fund.saved + fund.weekly);
        const rich = patch(w => { w.cameraFund!.saved = w.cameraFund!.goal - 50; });
        assert.equal(worldAt(rich, schedule, at('2026-10-30T22:00:00'))!.cameraFund!.saved, rich.cameraFund!.goal);
    });

    test('学期开始以前没有世界；卡上没有世界的旧卡照常', () => {
        assert.equal(worldAt(world, schedule, at('2026-08-20T12:00:00')), undefined);
        assert.equal(parseWorld(undefined, 'x'), undefined);
        assert.throws(() => parseWorld({ startDay: '9-1' }, 'x'), /startDay/);
    });
});

describe('「你那边」进时间块（ADR 0021 W2）', () => {
    test('只写事实和约束：天气、猫、快递、作业、相机基金、小事；人名按档位换；有总说明「别照着念、没写的别编」', () => {
        const now = at('2026-10-11T21:30:00');
        const text = describeWorld(worldAt(world, schedule, now)!, now)!;
        assert.match(text, /^\[你那边（今天到现在的事实，用不用、怎么说你自己定，别照着念；这里没写的别编）：/);
        assert.match(text, /土豆（楼下的流浪猫）/);
        assert.match(text, /攒钱买相机：\d+ \/ 4500 元/);
        assert.doesNotMatch(text, /[我你]觉得|好开心|好烦|！/, '不写情绪和能照抄的句子');
        const friend = patch(w => { w.events = [{ id: 'x', text: '{person}在微信上跟你互损了几句', person: 'chen_jianing', window: 'morning', chance: 1, when: 'any' }]; });
        const withFriend = describeWorld(worldAt(friend, schedule, now)!, now)!;
        assert.match(withFriend, /陈佳宁在微信上跟你互损了几句（陈佳宁：高中同班，你的死党/);
    });

    test('看不到课名的档位，几份一样的作业合成一条', () => {
        const all = patch(w => { w.homework!.chance = 1; w.homework!.earlyChance = 0; });
        const nameless = structuredClone(all);
        const schedulePlain: Schedule = { ...schedule, courses: schedule.courses.map(({ name: _name, ...c }) => c) };
        const now = at('2026-09-13T21:30:00');
        const text = describeWorld(worldAt(nameless, schedulePlain, now)!, now)!;
        assert.doesNotMatch(text, /作业明天交，还没写；作业明天交/);
        assert.match(text, /作业：\d 份作业明天交，还没写|作业：作业明天交，还没写/);
    });

    test('每天第一次写一行摘要和 state.json，同一天不重复', () => {
        const dir = mkdtempSync(join(tmpdir(), 'world-'));
        try {
            const logs: string[] = [];
            const note = worldLogger(world, schedule, message => logs.push(message), dir);
            note(at('2026-10-11T12:00:00'));
            note(at('2026-10-11T21:00:00'));
            note(at('2026-10-12T01:59:00'));
            assert.equal(logs.length, 1);
            assert.match(logs[0]!, /^她的世界：今天（10-11）：/);
            const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
            assert.equal(state.day, '2026-10-11');
            note(at('2026-10-12T09:00:00'));
            assert.equal(logs.length, 2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
