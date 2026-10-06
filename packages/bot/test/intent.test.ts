import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeIntent, isEndingTurn, saysOwnThing } from '../src/intent.ts';
import type { Schedule, State } from '../src/schedule.ts';

const now = new Date('2026-10-06T20:00:00+08:00');
const user = (content: string) => ({ role: 'user' as const, content });
const assistant = (content: string) => ({ role: 'assistant' as const, content });
const free = (text: string): State => ({ activity: { kind: 'free', text }, where: '学校', outsideSemester: false });

describe('这一轮你想（ADR 0019）', () => {
    test('他刚说了自己的事：问一个具体细节；普通提问不算', () => {
        assert.equal(saysOwnThing([assistant('嗯'), user('我刚下课，累死了')]), true);
        assert.equal(saysOwnThing([assistant('嗯'), user('你今天干嘛')]), false);
        assert.match(describeIntent({ history: [user('昨晚去看电影了')], now })!, /具体细节/);
        assert.match(describeIntent({ history: [user('你帮我讲讲梯度下降是怎么回事')], now, state: free('打独立游戏') })!, /直接回答/);
    });

    test('按线索顺序只给一个：他的事优先于答应的事，答应的事优先于手上的事', () => {
        assert.match(describeIntent({ history: [user('我今天去面试了')], now, promised: true, books: true })!, /具体细节/);
        assert.match(describeIntent({ history: [user('在吗')], now, promised: true, books: true })!, /答应/);
        assert.match(describeIntent({ history: [user('在吗')], now, books: true })!, /这本书/);
    });

    test('空闲活动给一件进度；忙、上硬课、快睡时只回两句；没线索就没有', () => {
        assert.match(describeIntent({ history: [user('在吗')], now, state: free('在图书馆看《长安的荔枝》') })!, /正在做的事/);
        assert.match(describeIntent({ history: [user('在吗')], now, state: free('在图书馆赶作业') })!, /回两句/);
        const hard: State = { activity: { kind: 'class', lesson: { kind: 'hard', start: now, end: new Date(now.getTime() + 3_600_000) } }, where: '学校', outsideSemester: false };
        assert.match(describeIntent({ history: [user('在吗')], now, state: hard })!, /回两句/);
        const schedule = { sleep: '02:00' } as Schedule;
        assert.match(describeIntent({ history: [user('在吗')], now: new Date('2026-10-07T01:00:00+08:00'), state: free(''), schedule })!, /回两句/);
        assert.equal(describeIntent({ history: [user('在吗')], now, state: free('') }), undefined);
    });

    test('主动找他时不给：主动说明本身就是意图', () => {
        assert.equal(describeIntent({ history: [user('我今天去面试了')], now, initiating: true }), undefined);
    });

    test('他说晚安、不想聊或只附和时只给收尾意图，不再追问或分享进度', () => {
        for (const text of ['今天累死了，我先睡了，晚安', '今天不想说话', '嗯', '哈哈']) {
            const history = [assistant('前一句'), user(text)];
            assert.equal(isEndingTurn(history), true, text);
            assert.match(describeIntent({ history, now, state: free('打独立游戏'), promised: true })!, /收尾/, text);
        }
        assert.equal(isEndingTurn([user('你睡了吗')]), false);
    });
});
