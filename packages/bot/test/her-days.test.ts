import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { BotConfig } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import {
    availableBookNodes, bookMention, bookProgressAt, bookProgressOn, describeBooks, describeHerDaySummary, describeMood, herDayLogger,
    moodAt, moodDayConditions, parseBooks, parseMoods, readingActivities, readingActivity, readingSection, unreadBookTopics, type DailyMood,
} from '../src/life/her-days.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { describeState, formatDate, herDay, stateAt } from '../src/life/schedule.ts';
import { runScenario } from '../src/sim/runner.ts';
import { parseScenario } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPath, syntheticCardPattern } from './fixtures/card.ts';

const card = loadCharacterCard(syntheticCardPath('boyfriend'));
const classmate = loadCharacterCard(syntheticCardPath('classmate'));
const stranger = loadCharacterCard(syntheticCardPath('stranger'));
const schedule = card.schedule!;
const book = (id: string) => card.books.find(item => item.id === id)!;
const at = (text: string) => new Date(`${text}+08:00`);

describe('她的一天与每日心情（ADR 0015）', () => {
    test('02:00 以前算前一天；同一天的心情可复现', () => {
        assert.equal(formatDate(herDay(schedule, at('2026-10-06T01:59:00'))), '2026-10-05');
        assert.equal(formatDate(herDay(schedule, at('2026-10-06T02:00:00'))), '2026-10-06');
        const beforeSleep = moodAt(schedule, card.moods, at('2026-10-06T01:59:00'))!;
        const afternoon = moodAt(schedule, card.moods, at('2026-10-05T15:00:00'))!;
        assert.equal(beforeSleep.day, '2026-10-05');
        assert.equal(beforeSleep.mood.name, afternoon.mood.name);
        assert.equal(beforeSleep.reason, afternoon.reason);
    });

    test('早八、课多、没课、放假按当天课表判；权重条件真的参与抽取', () => {
        assert.deepEqual(moodDayConditions(schedule, at('2026-10-12T12:00:00')), ['early', 'busy']); // 周一
        assert.deepEqual(moodDayConditions(schedule, at('2026-10-11T12:00:00')), ['no_class']); // 学期内周日
        assert.deepEqual(moodDayConditions(schedule, at('2026-10-05T12:00:00')), ['holiday']);

        const plain: DailyMood[] = [
            { name: '普通', weight: 1, style: '普通', when: [] },
            { name: '放假调权', weight: 1, style: '放假', when: [{ day: 'holiday', factor: 10_000, reason: '今天放假' }] },
        ];
        assert.equal(moodAt(schedule, plain, at('2026-10-05T12:00:00'))!.mood.name, '放假调权');
        assert.equal(moodAt(schedule, plain, at('2026-10-05T12:00:00'))!.reason, '今天放假');
    });

    test('身体事实压低当下心境；显式模拟心情仍保持可控', () => {
        const energetic: DailyMood[] = [
            { name: '话痨', weight: 100, style: '话很多', when: [] },
            { name: '安静', weight: 0, style: '没什么精神', when: [] },
        ];
        const bad = { period: { day: 1, cramps: 'bad' as const, detail: true } };
        const grounded = moodAt(schedule, energetic, at('2026-12-21T21:30:00'), undefined, { body: bad })!;
        assert.equal(grounded.mood.name, '安静');
        assert.equal(grounded.reason, '今天肚子疼得厉害，没什么精神');
        assert.equal(moodAt(schedule, energetic, at('2026-12-21T21:30:00'), '话痨', { body: bad })!.mood.name, '话痨');
        assert.equal(moodAt(schedule, energetic, at('2026-10-12T09:30:00'), undefined,
            { body: { sleepy: { when: 'morning', slept: '02:00', woke: '07:40' } } })!.reason,
        '昨晚睡得晚，今早又起得早，有点困');
        const deadline = moodAt(schedule, energetic, at('2026-10-13T20:00:00'), undefined, { world: {
            day: '2026-10-13', atSchool: true, parcels: [], events: [],
            homework: [{ course: 'course-1', due: at('2026-10-14T12:00:00'), done: false, doneAt: at('2026-10-13T23:00:00') }],
        } })!;
        assert.equal(deadline.mood.name, '安静');
        assert.equal(deadline.reason, '有份作业快到截止时间了，心里还挂着');
    });

    test('熟悉的档有心情（合成卡 3 种）；陌生人和名单外没有', () => {
        assert.deepEqual(card.moods.map(mood => mood.name), ['平静', '烦躁', '开心']);
        assert.equal(classmate.moods.length, 3);
        assert.deepEqual(stranger.moods, []);
    });
});

describe('在读的书（ADR 0015）', () => {
    test('进度按天推进、到上限停；读完和放下分开', () => {
        // 合成卡在读的一本：8-31 第 10 章起，每 2 天 3 章，全书 120 章；上限比全书小时只停住、不叫读完（测试里把上限改到 100）
        const fog = book('fog-harbor');
        const capped = { ...fog, progress: { ...fog.progress, max: 100 } };
        assert.deepEqual(bookProgressOn(capped, at('2026-10-04T12:00:00')), { amount: 61, unit: '章', finished: false, stopped: false });
        assert.equal(bookProgressOn(capped, at('2026-10-05T12:00:00')).amount, 61);
        assert.equal(bookProgressOn(capped, at('2026-10-06T12:00:00')).amount, 64);
        assert.deepEqual(bookProgressOn(capped, at('2026-11-20T12:00:00')), { amount: 100, unit: '章', finished: false, stopped: true });

        assert.equal(bookProgressAt(schedule, fog, at('2026-10-05T12:00:00')).amount, 61);
        assert.deepEqual(bookProgressAt(schedule, fog, at('2026-11-20T12:00:00')), { amount: 120, unit: '章', finished: true, stopped: true });

        const paperPlane = book('paper-plane');
        assert.deepEqual(bookProgressOn(paperPlane, at('2027-01-01T12:00:00')), { amount: 30, unit: '话', finished: false, stopped: true });
    });

    test('只开放读到的节点；没读到和没有资料的问法被挡住', () => {
        const fog = book('fog-harbor');
        const at25 = bookProgressOn(fog, at('2026-09-10T12:00:00'));
        assert.ok(availableBookNodes(fog, at25).some(node => node.id === 'opening'));
        assert.ok(!availableBookNodes(fog, at25).some(node => node.id === 'lighthouse'));
        assert.deepEqual(unreadBookTopics(fog, at25, '灯塔里最后有什么'), ['灯塔']);

        const at61 = bookProgressOn(fog, at('2026-10-05T12:00:00'));
        assert.deepEqual(unreadBookTopics(fog, at61, '灯塔里有什么'), []);
        assert.deepEqual(unreadBookTopics(fog, at61, '大结局是什么'), ['后面的情节']);
    });

    test('提到书只看他的最后 3 条和她最后 2 次回复；能认书名、作者、人物和泛问', () => {
        const message = (role: StoredMessage['role'], content: string, n: number): StoredMessage => ({ role, content, time: new Date(n * 1000).toISOString() });
        assert.deepEqual(bookMention([message('user', '你在看什么书', 1)], card.books), { mentioned: true, bookIds: ['fog-harbor', 'paper-plane'], named: false });
        assert.deepEqual(bookMention([message('user', '虚构作者甲后来还写了什么', 1)], card.books), { mentioned: true, bookIds: ['fog-harbor'], named: true });
        const old = [message('user', '雾港好看吗', 1), message('user', '一', 2), message('user', '二', 3), message('user', '三', 4), message('user', '四', 5)];
        assert.deepEqual(bookMention(old, card.books), { mentioned: false, bookIds: [], named: false });

        const replies = [
            message('assistant', '我在看《雾港旧事》', 1), message('assistant', '已经到后面了', 2), message('user', '哦', 3),
            message('assistant', '今天天气还行', 4), message('user', '嗯', 5), message('assistant', '准备睡了', 6), message('user', '好', 7),
        ];
        assert.deepEqual(bookMention(replies, card.books), { mentioned: false, bookIds: [], named: false }, '三次以前的回复不再算');
        assert.equal(readingActivity('睡前看几章《雾港旧事》', card.books), true);
        assert.equal(readingActivity('在宿舍跟室友扯淡', card.books), false);
    });

    test('平时聊天的常用词、「图书馆」不算聊到书', () => {
        const message = (role: StoredMessage['role'], content: string, n: number): StoredMessage => ({ role, content, time: new Date(n * 1000).toISOString() });
        for (const text of ['最后一节课是体育', '游戏更新了', '番茄炒蛋', '成绩出来了', '去图书馆占座', '这剧第几集了', '你哪来的零食']) {
            assert.equal(bookMention([message('user', text, 1)], card.books).mentioned, false, text);
        }
        assert.deepEqual(bookMention([message('user', '那个灯塔是怎么回事', 1)], card.books), { mentioned: true, bookIds: ['fog-harbor'], named: true });
        const chat = [message('user', '你在看什么书', 1), message('assistant', '在看《雾港旧事》', 2), message('user', '那结局呢', 3)];
        assert.deepEqual(bookMention(chat, card.books), { mentioned: true, bookIds: ['fog-harbor'], named: true }, '最近一条没点名时往前找');
    });

    test('那一段：你的感受、称呼替换；点名的书给全部读到的节点，泛问每本给主角和主线', () => {
        const now = at('2026-10-06T19:00:00');
        const named = describeBooks(schedule, [book('fog-harbor')], now, { userText: '那结局呢', userName: '宝宝', named: ['fog-harbor'] })!;
        assert.match(named.text, /《雾港旧事》.*看到第 64 章；全书 120 章；你的感受：/);
        assert.match(named.text, /灯塔：灯塔里藏着一封信/);
        assert.match(named.text, /宝宝问的《雾港旧事》后面的情节你还没看到/);
        assert.match(named.text, /也可以问问宝宝看到哪了。\]$/);
        assert.doesNotMatch(named.text, /\{\{user\}\}|她的感觉/);
        assert.deepEqual(named.context.focusIds, ['fog-harbor']);

        const generic = describeBooks(schedule, card.books, now, { userText: '你在看什么书', userName: '宝宝' })!;
        assert.match(generic.text, /开头：主角在港口长大\n/);
        assert.match(generic.text, /《纸飞机物语》[^\n]*停在第 30 话，已经放下了/);
        assert.doesNotMatch(generic.text, /灯塔：/);
        assert.ok([...generic.text].length <= 600, `泛问的那一段 ${[...generic.text].length} 字`);
        for (const id of ['fog-harbor', 'paper-plane']) {
            const one = describeBooks(schedule, [book(id)], now, { userText: '', userName: '宝宝', named: [id] })!;
            assert.ok([...one.text].length <= 600, `${id} 点名时 ${[...one.text].length} 字`);
        }
    });

    test('放不放那一段：聊到书或者她正在看书；看书的活动只在 herDays 时并进空闲活动', () => {
        const message = (role: StoredMessage['role'], content: string, n: number): StoredMessage => ({ role, content, time: new Date(n * 1000).toISOString() });
        const now = at('2026-10-06T21:00:00');
        assert.equal(readingSection(schedule, card.books, now, { history: [message('user', '在干嘛', 1)], userName: '宝宝', activity: '在追一部剧' }), undefined);
        const reading = readingSection(schedule, card.books, now, { history: [message('user', '在干嘛', 1)], userName: '宝宝', activity: '睡前看几章《雾港旧事》' })!;
        assert.deepEqual(reading.context.books.map(item => item.book.id), ['fog-harbor']);
        const asked = readingSection(schedule, card.books, now, { history: [message('user', '灯塔后来怎么样', 1)], userName: '宝宝' })!;
        assert.deepEqual(asked.context.focusIds, ['fog-harbor']);

        const extra = readingActivities(card.books);
        assert.deepEqual(extra, [{ window: 'evening', text: '睡前看几章《雾港旧事》' }]);
        const evenings = Array.from({ length: 60 }, (_, i) => describeState(stateAt(schedule, new Date(at('2026-10-01T21:00:00').getTime() + i * 86_400_000), extra), schedule));
        assert.ok(evenings.some(line => line.includes('雾港')), '60 个晚上里总有在看书的');
        const without = Array.from({ length: 60 }, (_, i) => describeState(stateAt(schedule, new Date(at('2026-10-01T21:00:00').getTime() + i * 86_400_000)), schedule));
        assert.ok(!without.some(line => line.includes('雾港')), '不传就是旧的空闲活动');
    });

    test('心情行换称呼；日志摘要按她的一天只写一次；模拟器能指定心情', () => {
        const choice = moodAt(schedule, card.moods, at('2026-10-14T19:00:00'), '开心')!;
        assert.equal(choice.mood.name, '开心');
        // 合成卡的心情说法里没有 {{user}}，换称呼用同一条心情改一句说法来测
        assert.equal(describeMood({ ...choice, mood: { ...choice.mood, style: '今天有点想{{user}}' } }, '宝宝'), '[你今天的心情：开心（说不上为什么，今天就是这样）。今天有点想宝宝]');
        assert.equal(moodAt(schedule, card.moods, at('2026-10-14T19:00:00'), '不存在'), undefined);
        assert.match(describeHerDaySummary(schedule, card.moods, card.books, at('2026-10-06T19:00:00'))!,
            /^今天（10-06）：心情 .+（.+）；在读 雾港旧事 第 64 章、纸飞机物语 第 30 话（放下了）$/);
        const lines: string[] = [];
        const note = herDayLogger(schedule, card.moods, card.books, line => lines.push(line));
        note(at('2026-10-06T19:00:00'));
        note(at('2026-10-07T01:30:00'));
        note(at('2026-10-07T09:00:00'));
        assert.equal(lines.length, 2);
        assert.match(lines[1]!, /^她自己的日子：今天（10-07）/);
    });

    test('同学档没有只给前两档的节点；旧卡没有新字段；读卡写坏会早报错', () => {
        assert.ok(!classmate.books.find(item => item.id === 'fog-harbor')!.nodes.some(node => node.id === 'lighthouse'));
        assert.deepEqual(stranger.books, []);
        assert.throws(() => parseMoods([{ name: '坏', weight: 1, style: 'x', when: [{ day: 'rainy', factor: 1, reason: 'x' }] }], '卡'), /day 不认识/);
        assert.throws(() => parseBooks([{ id: '坏' }], '卡'), /progress 应为对象/);
    });
});

describe('接进流水线（ADR 0015 第 5 步，假模型）', () => {
    const tierCard = loadTierCard(syntheticCardPattern, 'boyfriend');
    const llm: BotConfig['llm'] = {
        baseUrl: 'http://127.0.0.1:1', model: 'x', apiKey: 'x', temperature: 0.7, maxTokens: 300, timeoutMs: 1000,
        promptPostProcessing: '', extraBody: {},
    };
    const prompt: BotConfig['prompt'] = { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true };
    const run = async (herDays: boolean, replies: string[], extra: Record<string, unknown> = {}) => {
        const dir = mkdtempSync(join(tmpdir(), 'her-days-'));
        try {
            const scenario = parseScenario({
                name: 'x', tier: 'boyfriend', user: '宝宝', start: '2026-10-06T19:00:00+08:00', memory: false, schedule: false, ...extra,
                steps: [{ say: '在干嘛' }, { say: '你最近在看什么书' }],
            });
            return await runScenario(scenario, {
                runId: 't', dataDir: dir, card: tierCard, llm, prompt, settle: { quietMs: 10, maxMs: 50 }, herDays,
                generate: async () => replies.shift()!,
            });
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    };

    test('心情行每轮都在；聊到书才有那一段；说错卷数带说明重写一次', async () => {
        const result = await run(true, ['在宿舍躺着', '在看雾港，就翻了前两章', '在看雾港，看到第六十四章了']);
        const [chat, books] = result.steps.filter(step => step.kind === 'say');
        assert.match(chat!.generations[0]!.timeBlock!, /\n\[你今天的心情：[^\]]+\](\n|$)/);
        assert.match(chat!.generations[0]!.timeBlock!, /\n\[你那边（今天到现在的事实[^\]]+团子饼（楼下的流浪猫）/, '她的世界跟着她自己的日子（ADR 0021）');
        assert.doesNotMatch(chat!.generations[0]!.timeBlock!, /在读的书/);
        assert.match(books!.generations[0]!.timeBlock!, /\[在读的书：\n- 《雾港旧事》[^\n]*看到第 64 章/);
        assert.equal(books!.generations[0]!.rewrites?.length, 1);
        assert.ok(books!.logs.some(line => line.includes('进度数字「两章」（《雾港旧事》看到第 64 章）')));
        assert.deepEqual(books!.bubbles.map(bubble => bubble.text), ['在看雾港，看到第六十四章了']);
        assert.ok(chat!.logs.some(line => /^她自己的日子：今天（10-06）/.test(line)));
    });

    test('关掉就什么都没有；场景指定的心情照用', async () => {
        const off = await run(false, ['在宿舍躺着', '在看雾港，就翻了前两章']);
        const offBooks = off.steps.filter(step => step.kind === 'say')[1]!;
        assert.doesNotMatch(offBooks.generations[0]!.timeBlock!, /心情|在读的书|你那边/);
        assert.equal(offBooks.generations[0]!.rewrites, undefined);

        const quiet = await run(true, ['嗯', '雾港'], { mood: '平静' });
        assert.match(quiet.steps.find(step => step.kind === 'say')!.generations[0]!.timeBlock!, /\[你今天的心情：平静（/);
        await assert.rejects(run(true, [], { mood: '暴躁' }), /不是卡上的心情/);
    });
});
