import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 常驻的她的生活引擎（scripts/her-life.mjs）和作息判断（scripts/her-schedule.mjs）。
// 生活引擎每个模块实例读一次 HER_SOUL_DIR，所以每个用例换一个带查询串的实例，目录都是临时的。

const root = fileURLToPath(new URL('../../..', import.meta.url));
interface Life {
    tick: (now?: number) => { state: LifeState; changed: boolean };
    noteInteraction: (text: string, from?: string, forcedNegative?: boolean) => void;
    load: () => LifeState;
    nowText: (state?: LifeState) => string;
    setRandom: (fn?: () => number) => void;
    isNegativeAtHer: (text: string) => boolean;
    isPositiveAtHer: (text: string) => boolean;
}
interface LifeState { today: string; mood: number; activity: string; events: Array<{ at: number; text: string }>; relationships: Record<string, { trust: number; resentment: number }>; at: number }
interface Schedule {
    localDay: (at?: Date) => string;
    isNightHour: (hour: number) => boolean;
    sleepDue: (input: { now: Date; lastSleepDay?: string; offline?: boolean }) => boolean;
    wakeDue: (input: { now: Date; roll: number; activity?: string; offline?: boolean; chance?: number }) => boolean;
}

const dirs: string[] = [];
let counter = 0;
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function boot(): Promise<{ life: Life; dir: string }> {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-life-'));
    dirs.push(dir);
    process.env.HER_SOUL_DIR = dir;
    const life = await import(`${pathToFileURL(join(root, 'scripts/her-life.mjs')).href}?t=${++counter}`) as Life;
    life.setRandom(mulberry32(7));
    return { life, dir };
}

/** 固定种子的随机数：同一个种子永远同一串，这样生活引擎的结果可以复现 */
function mulberry32(seed: number): () => number {
    let a = seed;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

describe('作息判断（her-schedule）：原来睡眠整合白天也触发、醒来不看钟点', async () => {
    const schedule = await import(pathToFileURL(join(root, 'scripts/her-schedule.mjs')).href) as Schedule;
    const at = (h: number, m = 0) => new Date(2026, 9, 29, h, m);

    test('睡眠整合 03:00 之后到当天 21:00 都行（夜里没做成就白天补），且每个本地日一次', () => {
        assert.equal(schedule.sleepDue({ now: at(2, 59) }), false);
        assert.equal(schedule.sleepDue({ now: at(3, 0) }), true);
        assert.equal(schedule.sleepDue({ now: at(6, 59) }), true);
        assert.equal(schedule.sleepDue({ now: at(7, 0) }), true, '10-30 起 7 点以后也能补做（原来只到 7 点，笔记本一睡就永远漏）');
        assert.equal(schedule.sleepDue({ now: at(14, 0) }), true, '第二天白天补');
        assert.equal(schedule.sleepDue({ now: at(20, 59) }), true);
        assert.equal(schedule.sleepDue({ now: at(21, 0) }), false, '太晚了不补，等第二天');
        assert.equal(schedule.sleepDue({ now: at(4, 0), lastSleepDay: '2026-10-29' }), false, '今天已经整合过');
        assert.equal(schedule.sleepDue({ now: at(4, 0), lastSleepDay: '2026-10-28' }), true, '昨天的不算今天的');
        assert.equal(schedule.sleepDue({ now: at(4, 0), offline: true }), false, '她自己离开电脑时不做');
    });

    test('随机醒来：夜里不醒、她自己在睡觉不醒、离开电脑不醒；白天按概率', () => {
        for (const hour of [23, 0, 3, 6]) assert.equal(schedule.wakeDue({ now: at(hour), roll: 0 }), false, `${hour} 点`);
        assert.equal(schedule.wakeDue({ now: at(7), roll: 0.1 }), true);
        assert.equal(schedule.wakeDue({ now: at(15), roll: 0.1 }), true);
        assert.equal(schedule.wakeDue({ now: at(15), roll: 0.5 }), false);
        assert.equal(schedule.wakeDue({ now: at(15), roll: 0.1, activity: '睡觉' }), false, '白天累了在睡，也不起来');
        assert.equal(schedule.wakeDue({ now: at(15), roll: 0.1, offline: true }), false);
    });

    test('本地日期，不是 UTC：本地 00:30 还是今天', () => {
        assert.equal(schedule.localDay(new Date(2026, 9, 29, 0, 30)), '2026-10-29');
        assert.equal(schedule.localDay(new Date(2026, 0, 5, 23, 59)), '2026-01-05');
    });
});

describe('生活引擎：他的倾诉不是冲她的负面', () => {
    test('「我今天好烦，项目压力大，烦死了」连说 4 次：怨气、信任、心情都不变，NOW.md 里没有「不想哄他」', async () => {
        const { life, dir } = await boot();
        for (let i = 0; i < 4; i++) life.noteInteraction('我今天好烦啊，项目压力大，烦死了', 'baobao');
        const state = life.load();
        assert.equal(state.relationships.baobao!.resentment, 0);
        assert.equal(state.relationships.baobao!.trust, 70);
        assert.equal(state.mood, 0.2);
        const now = readFileSync(join(dir, 'NOW.md'), 'utf8');
        assert.ok(!now.includes('还在生他的气') && !now.includes('不想哄他'), now);
    });

    test('冲着她的才算：「你好烦」「闭嘴」「滚开」「不想理你」', async () => {
        const { life } = await boot();
        for (const text of ['你好烦', '闭嘴', '滚开', '我不想理你了', '讨厌你', '烦死你了', '我生你的气了']) {
            assert.equal(life.isNegativeAtHer(text), true, text);
        }
        for (const text of ['我今天好烦', '烦死了', '作业太多了好烦', '他一直不理我', '滚动条坏了', '好讨厌这个天气', '我有点冷淡的样子吗']) {
            assert.equal(life.isNegativeAtHer(text), false, text);
        }
    });

    test('「我想问你个事，你想吃什么」不是「想你」；真的说想她才加信任', async () => {
        const { life } = await boot();
        life.noteInteraction('我想问你个事，你想吃什么', 'baobao');
        assert.equal(life.load().relationships.baobao!.trust, 70);
        life.noteInteraction('好想你', 'baobao');
        assert.equal(life.load().relationships.baobao!.trust, 72);
        for (const text of ['陪我一会儿', '亲亲', '谢谢你', '晚安', '辛苦了']) assert.equal(life.isPositiveAtHer(text), true, text);
        for (const text of ['我想吃火锅', '我喜欢吃辣', '陪审团', '亲戚来了']) assert.equal(life.isPositiveAtHer(text), false, text);
    });

    test('程序明确标记的负面（forcedNegative）照旧', async () => {
        const { life } = await boot();
        life.noteInteraction('嗯', 'baobao', true);
        assert.equal(life.load().relationships.baobao!.resentment, 8);
    });
});

describe('生活引擎：不编关于真人的事，结果可复现', () => {
    const start = new Date(2026, 9, 29, 10, 0).getTime();
    /** 每 10 分钟推进一次，把出现过的事件（引擎自己只留最近 40 条）都收起来 */
    const run = async (ticks: number, seed: number) => {
        const { life } = await boot();
        life.setRandom(mulberry32(seed));
        let now = start;
        const seen = new Map<string, string>();
        for (let i = 0; i < ticks; i++) {
            now += 10 * 60_000;
            for (const event of life.tick(now).state.events) seen.set(`${event.at}:${event.text}`, event.text);
        }
        return [...seen.values()];
    };

    test('跑 400 次（约两天半）：事件里没有「鸽鸽」，同学的事照样有', async () => {
        const events = await run(400, 11);
        assert.ok(events.some(text => /同学/.test(text)), '有同学的事');
        assert.ok(events.some(text => /苏雨桐|妈妈|爸爸/.test(text)), '室友、家人的事也有');
        assert.ok(!events.some(text => text.includes('鸽鸽')), events.filter(text => text.includes('鸽鸽')).join(' / '));
    });

    test('NPC 台词本身：源码里没有真人名字', () => {
        const source = readFileSync(join(root, 'scripts/her-life.mjs'), 'utf8');
        assert.ok(!source.includes('鸽鸽发消息') && !source.includes('鸽鸽在群里'), '不再编「鸽鸽说了什么」');
        assert.ok(!/name:\s*'鸽鸽'/.test(source));
    });

    test('同一个随机种子：两次跑出来的事件一模一样（可复现）', async () => {
        const first = await run(120, 5);
        const second = await run(120, 5);
        assert.deepEqual(first, second);
        assert.ok(first.length > 5);
        assert.notDeepEqual(first, await run(120, 6), '换个种子就不一样');
    });

    test('跨过本地午夜：state.today 变成本地的新一天', async () => {
        const { life, dir } = await boot();
        const before = new Date(2026, 9, 28, 23, 50).getTime();
        life.tick(before);
        life.tick(new Date(2026, 9, 29, 0, 30).getTime());
        const state = JSON.parse(readFileSync(join(dir, 'LIFE.json'), 'utf8')) as LifeState;
        assert.equal(state.today, '2026-10-29');
        assert.ok(state.events.some(event => event.text === '新的一天。'));
    });

    test('tick 返回的 changed 真的反映活动有没有变（原来恒为 false）', async () => {
        const { life, dir } = await boot();
        writeFileSync(join(dir, 'LIFE.json'), JSON.stringify({ activity: '在宿舍待着', energy: 80, hunger: 20, at: start }));
        const result = life.tick(start + 10 * 60_000);
        assert.notEqual(result.state.activity, '在宿舍待着', '随机选出的活动不会是「在宿舍待着」');
        assert.equal(result.changed, true);
    });
});
