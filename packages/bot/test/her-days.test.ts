import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import {
    availableBookNodes, bookMention, bookProgressAt, bookProgressOn, moodAt, moodDayConditions, parseBooks, parseMoods,
    readingActivity, unreadBookTopics, type DailyMood,
} from '../src/her-days.ts';
import type { StoredMessage } from '../src/history.ts';
import { formatDate, herDay } from '../src/schedule.ts';
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
        assert.deepEqual(unreadBookTopics(yaowu, at6, '最后谁是凶手'), ['资料里没有的后续']);
    });

    test('提到书只看他的最后 3 条和她最后 2 次回复；能认书名、作者、人物和泛问', () => {
        const message = (role: StoredMessage['role'], content: string, n: number): StoredMessage => ({ role, content, time: new Date(n * 1000).toISOString() });
        assert.deepEqual(bookMention([message('user', '你在看什么书', 1)], card.books), { mentioned: true, bookIds: ['yaowu', 'rejinzhi', 'jiasi'] });
        assert.deepEqual(bookMention([message('user', '时不虞后来怎么样', 1)], card.books), { mentioned: true, bookIds: ['rejinzhi'] });
        const old = [message('user', '药屋好看吗', 1), message('user', '一', 2), message('user', '二', 3), message('user', '三', 4), message('user', '四', 5)];
        assert.deepEqual(bookMention(old, card.books), { mentioned: false, bookIds: [] });

        const replies = [
            message('assistant', '我在看《惹金枝》', 1), message('assistant', '已经到后面了', 2), message('user', '哦', 3),
            message('assistant', '今天天气还行', 4), message('user', '嗯', 5), message('assistant', '准备睡了', 6), message('user', '好', 7),
        ];
        assert.deepEqual(bookMention(replies, card.books), { mentioned: false, bookIds: [] }, '三次以前的回复不再算');
        assert.equal(readingActivity('窝在床上看《药屋少女的呢喃》', card.books), true);
        assert.equal(readingActivity('在宿舍跟室友扯淡', card.books), false);
    });

    test('同学档没有含禁用词的出版节点；旧卡没有新字段；读卡写坏会早报错', () => {
        assert.ok(!classmate.books.find(item => item.id === 'jiasi')!.nodes.some(node => node.id === 'jiasi-publish'));
        assert.deepEqual(stranger.books, []);
        assert.throws(() => parseMoods([{ name: '坏', weight: 1, style: 'x', when: [{ day: 'rainy', factor: 1, reason: 'x' }] }], '卡'), /day 不认识/);
        assert.throws(() => parseBooks([{ id: '坏' }], '卡'), /progress 应为对象/);
    });
});
