import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { loadTierCard } from '../src/platform/contact.ts';
import { DEFAULT_MENU, dishNote, dishOn, loadMenuFrom, menuOf } from '../src/life/menu.ts';
import { describeWorld, occupationAt, recapDay, worldAt } from '../src/world/world.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// ADR 0125：每顿吃什么。账上以前只有“午饭 / 晚饭、在哪吃”，没有“吃了什么”——他问“中午吃的啥”她就现编，前后对不上
const pattern = syntheticCardPattern;
const on = loadTierCard(pattern, 'boyfriend', { menu: true }).character;
const off = loadTierCard(pattern, 'boyfriend').character;
const at = (text: string) => new Date(text);
const dateText = (offset: number) => new Date(Date.UTC(2026, 9, 1 + offset)).toISOString().slice(0, 10);

describe('菜是日期的函数', () => {
    test('同一天同一顿永远是同一道；午饭晚饭各有各的菜单；菜都在菜单里', () => {
        for (let i = 0; i < 60; i++) {
            const date = dateText(i);
            assert.equal(dishOn(date, 'lunch'), dishOn(date, 'lunch'));
            assert.ok(DEFAULT_MENU.lunch.includes(dishOn(date, 'lunch')!), date);
            assert.ok(DEFAULT_MENU.dinner.includes(dishOn(date, 'dinner')!), date);
        }
    });

    test('不会连着两天吃一样的（含循环交界处），一个循环里每道出现一次', () => {
        for (const kind of ['lunch', 'dinner'] as const) {
            const days = Array.from({ length: 400 }, (_, i) => dishOn(dateText(i), kind)!);
            for (let i = 1; i < days.length; i++) assert.notEqual(days[i], days[i - 1], `${kind} 第 ${i} 天和前一天一样：${days[i]}`);
            const size = new Set(DEFAULT_MENU[kind]).size;
            for (let block = 0; block < 6; block++) {
                // 一个循环 = 菜单道数的连续天数（按日历日分块，起点不一定是 10-01，所以用 dayNumber 对齐）
                const start = Math.ceil(Date.UTC(2026, 9, 1) / 86_400_000 / size) * size - Date.UTC(2026, 9, 1) / 86_400_000;
                const slice = days.slice(start + block * size, start + (block + 1) * size);
                assert.equal(new Set(slice).size, size, `${kind} 第 ${block} 个循环有重样的`);
            }
        }
    });

    test('一年里没有哪道菜一直占着（都出现过）', () => {
        const seen = new Set(Array.from({ length: 365 }, (_, i) => dishOn(dateText(i), 'lunch')));
        assert.equal(seen.size, new Set(DEFAULT_MENU.lunch).size);
    });

    test('菜单为空没有菜；只有一道就是那一道；自定义菜单用自己的；写得不对用默认', () => {
        assert.equal(dishOn('2026-10-01', 'lunch', { lunch: [], dinner: ['x'] }), undefined);
        assert.equal(dishOn('2026-10-01', 'lunch', { lunch: ['面'], dinner: ['x'] }), '面');
        assert.equal(dishOn('2026-10-01', 'dinner', { lunch: ['a'], dinner: ['粥', '粥', ' '] }), '粥', '去重去空');
        assert.deepEqual(menuOf({ lunch: ['炸鸡'], dinner: 3 }), { lunch: ['炸鸡'], dinner: DEFAULT_MENU.dinner });
        assert.deepEqual(menuOf(undefined), DEFAULT_MENU);
        assert.equal(dishNote(undefined), '');
        assert.equal(dishNote('麻辣烫'), '，吃的是麻辣烫');
    });

    test('菜单里每道都是一句话说得出口的菜名：不带店名、不带人、不带标点', () => {
        for (const dish of [...DEFAULT_MENU.lunch, ...DEFAULT_MENU.dinner]) {
            assert.ok([...dish].length >= 2 && [...dish].length <= 8, dish);
            assert.doesNotMatch(dish, /[，。！？、（）()\s]/, dish);
            assert.doesNotMatch(dish, /妈|爸|奶奶|外婆|我家|老板|阿姨|麦当劳|肯德基|星巴克/, dish);
        }
    });
});

describe('“从哪天起”', () => {
    test('第一次开定下第二天并存起来，以后重启读同一个；文件坏了保留锚点并失败关闭', () => {
        const dir = mkdtempSync(join(tmpdir(), 'menu-from-'));
        try {
            const path = join(dir, 'menu-from.json');
            const logs: string[] = [];
            assert.equal(loadMenuFrom(path, new Date(2026, 9, 23, 11, 0), m => logs.push(m)), '2026-10-24');
            assert.equal(loadMenuFrom(path, new Date(2026, 9, 29, 9, 0)), '2026-10-24', '以后读同一个');
            assert.match(readFileSync(path, 'utf8'), /2026-10-24/);
            writeFileSync(path, '{坏了');
            assert.throws(() => loadMenuFrom(path, new Date(2026, 10, 2, 9, 0)), /菜单启用状态无效或读取失败/);
            assert.equal(readFileSync(path, 'utf8'), '{坏了', '加固策略：保留原路径和内容，由用户明确修复或删除后重新启用');
            assert.ok(logs.some(l => l.includes('2026-10-24')));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('接进她的一天', () => {
    const now = (c: typeof on, time: string) => worldAt(c.herWorld!, c.schedule!, at(time))!;

    test('开了：吃饭那会儿写“吃的是什么”，和账上同一顿同一道；没开：和原来一样', () => {
        const lunch = now(on, '2026-10-12T12:10:00+08:00');
        const dish = dishOn('2026-10-12', 'lunch')!;
        assert.equal(lunch.routine?.meals.find(m => m.kind === 'lunch')?.dish, dish);
        assert.equal(occupationAt(lunch, at('2026-10-12T12:10:00+08:00')), `在食堂吃午饭，吃的是${dish}`);
        assert.equal(occupationAt(now(off, '2026-10-12T12:10:00+08:00'), at('2026-10-12T12:10:00+08:00')), '在食堂吃午饭');
        assert.equal(now(off, '2026-10-12T12:10:00+08:00').routine?.meals.find(m => m.kind === 'lunch')?.dish, undefined);
    });

    test('她那边的事实里写今天吃过的（还没到的饭点不写）；没开不写', () => {
        const afternoon = describeWorld(now(on, '2026-10-12T15:00:00+08:00'), at('2026-10-12T15:00:00+08:00'))!;
        assert.ok(afternoon.includes(`午饭在食堂吃的${dishOn('2026-10-12', 'lunch')}`), afternoon);
        assert.ok(!afternoon.includes('晚饭在食堂吃的'), '晚饭还没到饭点');
        const evening = describeWorld(now(on, '2026-10-12T19:00:00+08:00'), at('2026-10-12T19:00:00+08:00'))!;
        assert.ok(evening.includes(`晚饭在食堂吃的${dishOn('2026-10-12', 'dinner')}`), evening);
        const plain = describeWorld(now(off, '2026-10-12T19:00:00+08:00'), at('2026-10-12T19:00:00+08:00')) ?? '';
        assert.ok(!plain.includes('吃的：'), '没开不写');
    });

    test('复盘那一天写两顿吃了什么；外卖和在家的说法不同', () => {
        const recap = recapDay(now(on, '2026-10-12T23:30:00+08:00')).join('；');
        assert.ok(recap.includes(`午饭在食堂吃的${dishOn('2026-10-12', 'lunch')}`) && recap.includes(`晚饭在食堂吃的${dishOn('2026-10-12', 'dinner')}`), recap);
        const lines: string[] = [];
        for (let i = 0; i < 90; i++) {
            const date = new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
            const snapshot = now(on, `${date}T23:30:00+08:00`);
            for (const meal of snapshot.routine?.meals ?? []) if (meal.where !== 'canteen') lines.push(recapDay(snapshot).find(l => l.startsWith(meal.kind === 'lunch' ? '午饭' : '晚饭')) ?? '');
        }
        assert.ok(lines.some(l => /点的外卖，/.test(l)) || lines.some(l => /在家吃的/.test(l)), '90 天里有外卖或在家的饭');
        assert.ok(lines.every(l => l.length > 0));
    });

    test('“从哪天起”之前的日子不改：菜单 from 之后才有', () => {
        const later = loadTierCard(pattern, 'boyfriend', { menu: true, menuFrom: '2026-10-13' }).character;
        assert.equal(now(later, '2026-10-12T12:10:00+08:00').routine?.meals.find(m => m.kind === 'lunch')?.dish, undefined);
        assert.ok(now(later, '2026-10-13T12:10:00+08:00').routine?.meals.find(m => m.kind === 'lunch')?.dish);
    });
});
