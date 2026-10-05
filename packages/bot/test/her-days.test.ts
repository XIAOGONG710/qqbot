import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
    availableBookNodes, bookMention, bookProgressAt, bookProgressOn, describeBooks, describeHerDaySummary, describeMood, herDayLogger,
    moodAt, moodDayConditions, parseBooks, parseMoods, readingActivities, readingActivity, readingSection, unreadBookTopics, type DailyMood,
} from '../src/her-days.ts';
import type { StoredMessage } from '../src/history.ts';
import { describeState, formatDate, herDay, stateAt } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const classmate = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-classmate.json'));
const stranger = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-stranger.json'));
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

    test('熟悉的五档有心情；陌生人和名单外没有', () => {
        assert.equal(card.moods.length, 5);
        assert.equal(classmate.moods.length, 5);
        assert.deepEqual(stranger.moods, []);
    });
});

describe('在读的书（ADR 0015）', () => {
    test('进度按天推进、到上限停；读完和放下分开', () => {
        const yaowu = book('yaowu');
        assert.deepEqual(bookProgressOn(yaowu, at('2026-10-03T12:00:00')), { amount: 6, unit: '卷', finished: false, stopped: false });
        assert.equal(bookProgressOn(yaowu, at('2026-10-05T12:00:00')).amount, 6);
        assert.equal(bookProgressOn(yaowu, at('2026-10-06T12:00:00')).amount, 7);
        assert.deepEqual(bookProgressOn(yaowu, at('2026-10-20T12:00:00')), { amount: 10, unit: '卷', finished: false, stopped: true });

        const rejinzhi = book('rejinzhi');
        assert.equal(bookProgressAt(schedule, rejinzhi, at('2026-10-05T12:00:00')).amount, 500);
        assert.deepEqual(bookProgressAt(schedule, rejinzhi, at('2026-10-15T12:00:00')), { amount: 550, unit: '章', finished: true, stopped: true });

        const jiasi = book('jiasi');
        assert.deepEqual(bookProgressOn(jiasi, at('2027-01-01T12:00:00')), { amount: 300, unit: '章', finished: false, stopped: true });
    });

    test('只开放读到的节点；没读到和没有资料的问法被挡住', () => {
        const rejinzhi = book('rejinzhi');
        const at500 = bookProgressOn(rejinzhi, at('2026-10-05T12:00:00'));
        assert.ok(availableBookNodes(rejinzhi, at500).some(node => node.id === 'rejinzhi-mid'));
        assert.ok(!availableBookNodes(rejinzhi, at500).some(node => node.id === 'rejinzhi-ending'));
        assert.deepEqual(unreadBookTopics(rejinzhi, at500, '结局最后是什么'), ['结局']);

        const yaowu = book('yaowu');
        const at6 = bookProgressOn(yaowu, at('2026-10-05T12:00:00'));
        assert.deepEqual(unreadBookTopics(yaowu, at6, '猫猫是谁'), []);
        assert.deepEqual(unreadBookTopics(yaowu, at6, '最后谁是凶手'), ['后面的情节']);
    });

    test('提到书只看他的最后 3 条和她最后 2 次回复；能认书名、作者、人物和泛问', () => {
        const message = (role: StoredMessage['role'], content: string, n: number): StoredMessage => ({ role, content, time: new Date(n * 1000).toISOString() });
        assert.deepEqual(bookMention([message('user', '你在看什么书', 1)], card.books), { mentioned: true, bookIds: ['yaowu', 'rejinzhi', 'jiasi'], named: false });
        assert.deepEqual(bookMention([message('user', '时不虞后来怎么样', 1)], card.books), { mentioned: true, bookIds: ['rejinzhi'], named: true });
        const old = [message('user', '药屋好看吗', 1), message('user', '一', 2), message('user', '二', 3), message('user', '三', 4), message('user', '四', 5)];
        assert.deepEqual(bookMention(old, card.books), { mentioned: false, bookIds: [], named: false });

        const replies = [
            message('assistant', '我在看《惹金枝》', 1), message('assistant', '已经到后面了', 2), message('user', '哦', 3),
            message('assistant', '今天天气还行', 4), message('user', '嗯', 5), message('assistant', '准备睡了', 6), message('user', '好', 7),
        ];
        assert.deepEqual(bookMention(replies, card.books), { mentioned: false, bookIds: [], named: false }, '三次以前的回复不再算');
        assert.equal(readingActivity('窝在床上看《药屋少女的呢喃》', card.books), true);
        assert.equal(readingActivity('在宿舍跟室友扯淡', card.books), false);
    });

    test('平时聊天的常用词、「图书馆」不算聊到书', () => {
        const message = (role: StoredMessage['role'], content: string, n: number): StoredMessage => ({ role, content, time: new Date(n * 1000).toISOString() });
        for (const text of ['最后一节课是体育', '游戏更新了', '番茄炒蛋', '成绩出来了', '去图书馆占座', '这剧第几集了', '你哪来的零食']) {
            assert.equal(bookMention([message('user', text, 1)], card.books).mentioned, false, text);
        }
        assert.deepEqual(bookMention([message('user', '壬氏是谁', 1)], card.books), { mentioned: true, bookIds: ['yaowu'], named: true });
        const chat = [message('user', '你在看什么书', 1), message('assistant', '在看《惹金枝》', 2), message('user', '那结局呢', 3)];
        assert.deepEqual(bookMention(chat, card.books), { mentioned: true, bookIds: ['rejinzhi'], named: true }, '最近一条没点名时往前找');
    });

    test('那一段：你的感受、称呼替换；点名的书给全部读到的节点，泛问每本给主角和主线', () => {
        const now = at('2026-10-06T19:00:00');
        const named = describeBooks(schedule, [book('rejinzhi')], now, { userText: '那结局呢', userName: '宝宝', named: ['rejinzhi'] })!;
        assert.match(named.text, /《惹金枝》.*看到第 505 章；全书 550 章；你的感受：/);
        assert.match(named.text, /成绩与出版：入选/);
        assert.match(named.text, /宝宝问的《惹金枝》结局你还没看到/);
        assert.match(named.text, /也可以问问宝宝看到哪了。\]$/);
        assert.doesNotMatch(named.text, /\{\{user\}\}|她的感觉/);
        assert.deepEqual(named.context.focusIds, ['rejinzhi']);

        const generic = describeBooks(schedule, card.books, now, { userText: '你在看什么书', userName: '宝宝' })!;
        assert.match(generic.text, /主角是谁：女主叫猫猫，原本在花街当药师\n/);
        assert.match(generic.text, /主线：回京复仇：十五年后/);
        assert.doesNotMatch(generic.text, /成绩与出版|原作与出版/);
        assert.ok([...generic.text].length <= 600, `泛问的那一段 ${[...generic.text].length} 字`);
        for (const id of ['yaowu', 'rejinzhi', 'jiasi']) {
            const one = describeBooks(schedule, [book(id)], now, { userText: '', userName: '宝宝', named: [id] })!;
            assert.ok([...one.text].length <= 600, `${id} 点名时 ${[...one.text].length} 字`);
        }
    });

    test('放不放那一段：聊到书或者她正在看书；看书的活动只在 herDays 时并进空闲活动', () => {
        const message = (role: StoredMessage['role'], content: string, n: number): StoredMessage => ({ role, content, time: new Date(n * 1000).toISOString() });
        const now = at('2026-10-06T21:00:00');
        assert.equal(readingSection(schedule, card.books, now, { history: [message('user', '在干嘛', 1)], userName: '宝宝', activity: '在追一部剧' }), undefined);
        const reading = readingSection(schedule, card.books, now, { history: [message('user', '在干嘛', 1)], userName: '宝宝', activity: '窝在床上看《药屋少女的呢喃》' })!;
        assert.deepEqual(reading.context.books.map(item => item.book.id), ['yaowu']);
        const asked = readingSection(schedule, card.books, now, { history: [message('user', '时不虞后来怎么样', 1)], userName: '宝宝' })!;
        assert.deepEqual(asked.context.focusIds, ['rejinzhi']);

        const extra = readingActivities(card.books);
        assert.deepEqual(extra, [{ window: 'evening', text: '窝在床上看《药屋少女的呢喃》' }]);
        const evenings = Array.from({ length: 60 }, (_, i) => describeState(stateAt(schedule, new Date(at('2026-10-01T21:00:00').getTime() + i * 86_400_000), extra), schedule));
        assert.ok(evenings.some(line => line.includes('药屋')), '60 个晚上里总有在看书的');
        const without = Array.from({ length: 60 }, (_, i) => describeState(stateAt(schedule, new Date(at('2026-10-01T21:00:00').getTime() + i * 86_400_000)), schedule));
        assert.ok(!without.some(line => line.includes('药屋')), '不传就是旧的空闲活动');
    });

    test('心情行换称呼；日志摘要按她的一天只写一次；模拟器能指定心情', () => {
        const choice = moodAt(schedule, card.moods, at('2026-10-14T19:00:00'), '黏人')!;
        assert.equal(choice.mood.name, '黏人');
        assert.match(describeMood(choice, '宝宝'), /^\[你今天的心情：黏人（说不上为什么，今天就是这样）。今天特别想宝宝：/);
        assert.equal(moodAt(schedule, card.moods, at('2026-10-14T19:00:00'), '不存在'), undefined);
        assert.match(describeHerDaySummary(schedule, card.moods, card.books, at('2026-10-06T19:00:00'))!,
            /^今天（10-06）：心情 .+（.+）；在读 药屋少女的呢喃 第 7 卷、惹金枝 第 505 章、恰似寒光遇骄阳 第 300 章（放下了）$/);
        const lines: string[] = [];
        const note = herDayLogger(schedule, card.moods, card.books, line => lines.push(line));
        note(at('2026-10-06T19:00:00'));
        note(at('2026-10-07T01:30:00'));
        note(at('2026-10-07T09:00:00'));
        assert.equal(lines.length, 2);
        assert.match(lines[1]!, /^她自己的日子：今天（10-07）/);
    });

    test('同学档没有含禁用词的出版节点；旧卡没有新字段；读卡写坏会早报错', () => {
        assert.ok(!classmate.books.find(item => item.id === 'jiasi')!.nodes.some(node => node.id === 'jiasi-publish'));
        assert.deepEqual(stranger.books, []);
        assert.throws(() => parseMoods([{ name: '坏', weight: 1, style: 'x', when: [{ day: 'rainy', factor: 1, reason: 'x' }] }], '卡'), /day 不认识/);
        assert.throws(() => parseBooks([{ id: '坏' }], '卡'), /progress 应为对象/);
    });
});
