// 「你这两天自己在做的」的真实来源（ADR 0347 第 2 层，方案第三节）：recentDayHighlights + ownDaysLine。
// 只用合成数据：作息取合成卡的（她的一天 02:00 开始），世界是手写的 WorldNow，按取的时刻给昨天 / 今天那一份。
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { loadCharacterCard } from '../src/st/card.ts';
import { ownDaysLine, recentDayHighlights, worldHighlights } from '../src/world/highlights.ts';
import { worldAt as realWorldAt, type WorldNow } from '../src/world/world.ts';
import { syntheticCardPath } from './fixtures/card.ts';

const card = loadCharacterCard(syntheticCardPath('boyfriend'));
const schedule = card.schedule!;
const at = (d: number, h: number, m = 0) => new Date(2026, 10, d, h, m);

function world(day: string, patch: Partial<WorldNow> = {}): WorldNow {
    return { day, atSchool: true, parcels: [], homework: [], events: [], ...patch };
}

/** 假的世界账：她的昨天（11-04）23:30 那一份、今天（11-05）的那一份；记下被问过的时刻 */
function ledger(yesterday: WorldNow | undefined, today: WorldNow | undefined) {
    const asked: Date[] = [];
    const fn = (time: Date) => {
        asked.push(time);
        if (time.getTime() === at(4, 23, 30).getTime()) return yesterday;
        if (time >= at(5, 2)) return today;
        return undefined;
    };
    return { fn, asked };
}

const YESTERDAY = world('2026-11-04', {
    cat: { name: '小橘', today: { fed: at(4, 18, 20), seen: true }, yesterdayFed: true, foodDays: 5 },
    routine: { meals: [{ kind: 'dinner', start: at(4, 18), end: at(4, 18, 40), where: 'canteen', dish: '麻辣烫' }] },
    parcels: [{ item: '相机背带', status: 'picked_today', when: at(4, 17, 40) }],
    homework: [
        { course: '高数', due: at(6, 8), done: true, doneAt: at(4, 21) },
        { course: '英语', due: at(5, 8), done: true, doneAt: at(4, 20) },
        { course: '物理', due: at(6, 8), done: true, doneAt: at(3, 21) },
    ],
    events: [
        { id: 'walk', text: '去操场拍了晚霞', at: at(4, 19, 10) },
        { id: 'tea', text: '室友请她喝了奶茶', at: at(4, 15) },
    ],
});

const TODAY = world('2026-11-05', {
    cat: { name: '小橘', today: { fed: at(5, 12, 10) }, yesterdayFed: true, foodDays: 4 },
    // 高数昨天写完、明天才交：今天的 world 行还列着「高数的作业已经写完了」
    homework: [{ course: '高数', due: at(6, 8), done: true, doneAt: at(4, 21) }],
    parcels: [{ item: '耳机', status: 'picked_today', when: at(5, 12, 30) }],
    events: [
        { id: 'lib', text: '在图书馆借了本摄影书', at: at(5, 14) },
        { id: 'quiz', text: '课上小测', at: at(5, 10) },
    ],
});

describe('这两天自己在做的（ADR 0347 第 2 层）', () => {
    test('默认只取昨天：吃饭、喂猫不放，今天 world 行还列着的作业不放，昨天以前写完的不算昨天', () => {
        const { fn, asked } = ledger(YESTERDAY, TODAY);
        const items = recentDayHighlights(fn, schedule, at(5, 16));
        assert.deepEqual(items.map(item => item.text), ['英语作业写完了', '去操场拍了晚霞']);
        assert.ok(items.every(item => item.yesterday));
        assert.ok(asked.some(time => time.getTime() === at(4, 23, 30).getTime()), '昨天按 23:30 取（和 recapOf 一致）');
        assert.equal(ownDaysLine(items), '[你这两天自己在做的：昨天英语作业写完了；昨天去操场拍了晚霞]');
    });

    test('includeToday：今天到此刻的小事和昨天的合在一起，新的在前，最多 2 件；今天的猫、快递不放', () => {
        const { fn } = ledger(YESTERDAY, TODAY);
        const items = recentDayHighlights(fn, schedule, at(5, 16), { includeToday: true });
        assert.deepEqual(items.map(item => [item.text, item.yesterday]), [['在图书馆借了本摄影书', false], ['课上小测', false]]);
        const three = recentDayHighlights(fn, schedule, at(5, 16), { includeToday: true, limit: 3 });
        assert.deepEqual(three.map(item => item.text), ['在图书馆借了本摄影书', '课上小测', '英语作业写完了']);
        assert.equal(ownDaysLine(three), '[你这两天自己在做的：在图书馆借了本摄影书；课上小测；昨天英语作业写完了]');
    });

    test('未来的不放：今天还没到的小事、昨天世界里打算以后写的作业', () => {
        const yesterday = world('2026-11-04', {
            homework: [{ course: '化学', due: at(7, 8), done: false, doneAt: at(5, 21) }],
            events: [{ id: 'walk', text: '去操场拍了晚霞', at: at(4, 19, 10) }],
        });
        const today = world('2026-11-05', { events: [
            { id: 'later', text: '晚上去社团', at: at(5, 19) },
            { id: 'lib', text: '在图书馆借了本摄影书', at: at(5, 14) },
        ] });
        const now = at(5, 16);
        const items = recentDayHighlights(ledger(yesterday, today).fn, schedule, now, { includeToday: true, limit: 5 });
        assert.deepEqual(items.map(item => item.text), ['在图书馆借了本摄影书', '去操场拍了晚霞']);
        assert.ok(items.every(item => Date.parse(item.at) <= now.getTime()));
    });

    test('没有可写的：世界账没有、只有日常、条数非法、时刻非法都为空，那一行不返回', () => {
        assert.deepEqual(recentDayHighlights(() => undefined, schedule, at(5, 16)), []);
        const routineOnly = world('2026-11-04', {
            cat: { name: '小橘', today: { fed: at(4, 18, 20) }, yesterdayFed: true, foodDays: 5 },
            routine: { meals: [{ kind: 'lunch', start: at(4, 12), end: at(4, 12, 30), where: 'canteen', dish: '面' }] },
        });
        assert.deepEqual(recentDayHighlights(ledger(routineOnly, TODAY).fn, schedule, at(5, 16)), []);
        assert.deepEqual(recentDayHighlights(ledger(YESTERDAY, TODAY).fn, schedule, at(5, 16), { limit: 0 }), []);
        assert.deepEqual(recentDayHighlights(ledger(YESTERDAY, TODAY).fn, schedule, new Date(Number.NaN)), []);
        assert.equal(ownDaysLine([]), undefined);
    });

    test('她的一天 02:00 开始：凌晨一点还算 11-05，「昨天」是 11-04；两点以后昨天才换成 11-05', () => {
        const asked: Date[] = [];
        const fn = (time: Date) => { asked.push(time); return undefined; };
        recentDayHighlights(fn, schedule, at(6, 1));
        assert.ok(asked.some(time => time.getTime() === at(4, 23, 30).getTime()), `01:00 取的是 11-04 23:30：${asked.map(t => t.toString())}`);
        asked.length = 0;
        recentDayHighlights(fn, schedule, at(6, 3));
        assert.ok(asked.some(time => time.getTime() === at(5, 23, 30).getTime()), '03:00 取的是 11-05 23:30');

        // 凌晨一点时「今天」还是 11-05：11-05 晚上的小事算今天，不标昨天
        const lateToday = world('2026-11-05', { events: [{ id: 'night', text: '熬夜修了照片', at: at(6, 0, 30) }] });
        const items = recentDayHighlights(time => (time >= at(5, 2) ? lateToday : undefined), schedule, at(6, 1), { includeToday: true });
        assert.deepEqual(items.map(item => [item.text, item.yesterday]), [['熬夜修了照片', false]]);
    });

    test('那一行最多 80 字，同样的文字只放一次', () => {
        const long = '在宿舍把这学期拍的照片一张一张挑出来，修了色调、裁了构图，又按月份分好文件夹，准备挑几张最满意的冲印出来贴在床头';
        const yesterday = world('2026-11-04', { events: [
            { id: 'a', text: long, at: at(4, 20) },
            { id: 'b', text: long, at: at(4, 21) },
            { id: 'c', text: long.split('').reverse().join(''), at: at(4, 19) },
        ] });
        const items = recentDayHighlights(ledger(yesterday, undefined).fn, schedule, at(5, 16));
        assert.equal(items.length, 2);
        assert.notEqual(items[0]!.text, items[1]!.text);
        const line = ownDaysLine(items)!;
        const content = line.slice('[你这两天自己在做的：'.length, -1);
        assert.equal(content.length, 80);
        assert.ok(line.startsWith('[你这两天自己在做的：昨天') && line.endsWith(']'));
    });

    test('同一时刻结果相同；接合成卡的真世界也只给已经发生的', () => {
        const fn = (time: Date) => realWorldAt(card.herWorld!, schedule, time);
        const now = at(5, 21);
        const first = recentDayHighlights(fn, schedule, now, { includeToday: true });
        assert.deepEqual(recentDayHighlights(fn, schedule, now, { includeToday: true }), first);
        assert.ok(first.length <= 2);
        assert.ok(first.every(item => Date.parse(item.at) <= now.getTime()));
    });

    test('控制台的 worldHighlights 不变：还是吃饭、喂猫都算，最多 3 条', () => {
        const items = worldHighlights(YESTERDAY, at(4, 23, 30));
        assert.deepEqual(items.map(item => item.text), ['高数作业写完了', '英语作业写完了', '去操场拍了晚霞']);
        assert.deepEqual(worldHighlights(YESTERDAY, at(4, 18, 30), 10).map(item => item.text),
            ['喂过小橘，也见到它了', '取了相机背带', '室友请她喝了奶茶', '物理作业写完了']);
    });
});
