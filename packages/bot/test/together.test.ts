import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { blockReason, candidatesOn, type Candidate, type ProactiveInput } from '../src/proactive/proactive.ts';
import { activityOf, describeTogether, TOGETHER_MAX_MS, togetherNow } from '../src/language/together.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { syntheticCardPath } from './fixtures/card.ts';

// ADR 0111：答应邀约之后的两三个小时，她正和他一起玩
const t = (h: number, m = 0) => new Date(2026, 9, 24, h, m).getTime();
const iso = (h: number, m = 0) => new Date(t(h, m)).toISOString();
const her = (h: number, m: number, content: string) => ({ role: 'assistant' as const, content, time: iso(h, m) });
const him = (h: number, m: number, content: string) => ({ role: 'user' as const, content, time: iso(h, m) });

describe('陪玩状态：谁邀谁答应', () => {
    test('她邀、他应了：从他答应的那一刻起，在 TOGETHER_MAX_MS 之内；玩的是邀约里的那样', () => {
        const history = [her(20, 0, '宝宝，晚上双排不'), him(20, 5, '来啊，我马上上线')];
        const now = togetherNow(history, t(20, 6))!;
        assert.equal(now.activity, 'wzry');
        assert.equal(now.since, t(20, 5));
        assert.ok(togetherNow(history, t(22, 30)), '2.5 小时内');
        assert.equal(togetherNow(history, t(20, 5) + TOGETHER_MAX_MS), undefined, '2.5 小时到了');
        assert.equal(togetherNow([her(20, 0, '要不要上我的世界看看我盖的'), him(20, 2, '好呀')], t(20, 10))!.activity, 'minecraft');
    });

    test('他邀、她应了：她的回应开头是来 / 好 / 行……且前面没有推掉的话', () => {
        for (const reply of ['来，你跟紧我', '好呀，等我一下', '行，开吧', '走起']) {
            assert.ok(togetherNow([him(21, 0, '今晚王者双排吗'), her(21, 1, reply)], t(21, 2)), reply);
        }
        for (const reply of ['不了，今天累', '我晚点再说', '在上课呢，等下课陪你打', '嗯']) {
            assert.equal(togetherNow([him(21, 0, '今晚王者双排吗'), her(21, 1, reply)], t(21, 2)), undefined, reply);
        }
    });

    test('他没应 / 拒绝 / 隔太久才回：不算；他的拒绝不会被当成应了', () => {
        assert.equal(togetherNow([her(20, 0, '宝宝，晚上双排不')], t(20, 30)), undefined, '没回');
        assert.equal(togetherNow([her(20, 0, '宝宝，晚上双排不'), him(20, 5, '今天不行，在赶东西')], t(20, 30)), undefined);
        assert.equal(togetherNow([her(20, 0, '宝宝，晚上双排不'), him(20, 5, '来')].slice(0, 1).concat([him(21, 0, '来')]), t(21, 5)), undefined, '隔了 1 小时才回，不是回这个邀约');
        assert.equal(togetherNow([her(20, 0, '在干嘛'), him(20, 5, '来')], t(20, 10)), undefined, '她没约');
    });

    test('谁说了“下了 / 不玩了 / 睡了 / 晚安 / 散了”就结束', () => {
        const base = [her(20, 0, '宝宝，晚上双排不'), him(20, 5, '来啊')];
        assert.ok(togetherNow([...base, her(20, 40, '这把稳了'), him(20, 41, '哈哈')], t(20, 45)));
        for (const end of ['我下了，明天还有课', '不玩了不玩了', '困死了我先睡了', '晚安']) {
            assert.equal(togetherNow([...base, him(21, 30, end)], t(21, 31)), undefined, end);
            assert.equal(togetherNow([...base, her(21, 30, end)], t(21, 31)), undefined, end);
        }
    });

    test('活动：我的世界 / 王者 / 别的游戏', () => {
        assert.equal(activityOf('一起上我的世界存档'), 'minecraft');
        assert.equal(activityOf('开黑打王者'), 'wzry');
        assert.equal(activityOf('来联机吗'), 'game');
    });

    test('时间块那一行：写明在玩什么、玩了多久，回得短、聊局里的事，不编以前的事', () => {
        const line = describeTogether({ activity: 'wzry', since: t(20, 5) }, t(20, 35));
        assert.ok(line.includes('打王者') && line.includes('约 30 分钟') && line.includes('回话短一点') && line.includes('别编你们以前没一起经历过的事'), line);
        assert.doesNotMatch(line, /[「」]/, '不给台词');
    });
});

describe('陪玩状态：这段时间不插别的主动消息', () => {
    const boyfriend = loadCharacterCard(syntheticCardPath('boyfriend'));
    const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
        qq: 10001, schedule: boyfriend.schedule!, settings: boyfriend.proactive!, dates: [], history: [], records: [], mode: 'on', ...patch,
    });
    test('together 回答是：除了重要的日子，到点再查都不发（原因写明）；不是就照旧', () => {
        const day = new Date(2026, 9, 24);
        const share = candidatesOn(day, input()).find(c => c.occasion === 'share')!;
        assert.ok(share);
        assert.equal(blockReason(share, share.at, input({ together: () => true })), '正和他一起玩');
        assert.notEqual(blockReason(share, share.at, input({ together: () => false })), '正和他一起玩');
        const bedtime = candidatesOn(day, input()).find(c => c.occasion === 'bedtime')!;
        assert.notEqual(blockReason(bedtime, bedtime.at, input({ together: () => true })), '正和他一起玩', '睡前那句晚安照常说');
        const dates: Candidate = { id: '2026-10-24:dates', occasion: 'dates', day: '2026-10-24', at: t(20), reason: 'x' };
        assert.notEqual(blockReason(dates, t(20), input({ together: () => true })), '正和他一起玩', '重要的日子不受限');
    });
});
