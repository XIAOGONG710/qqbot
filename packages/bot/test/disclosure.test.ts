import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    disclosureMode, disclosureRules, isClose, ownSourceLabel, sourceLabel, startsConversation, todayStart,
} from '../src/disclosure.ts';
import type { Schedule } from '../src/schedule.ts';

describe('披露分级（ADR 0020）', () => {
    test('亲密联系人可听大面事实；低档位对普通来源只能含糊、对亲密来源完全封口', () => {
        const boyfriend = { name: '阿明', tier: 'boyfriend' };
        const bestie = { name: '小雨', tier: 'bestie' };
        const classmate = { name: '同学', tier: 'classmate' };
        const known = { name: '鸽鸽', tier: 'known' };

        assert.equal(isClose('boyfriend'), true);
        assert.equal(isClose('bestie'), true);
        assert.equal(isClose('girl_friend'), false);
        assert.equal(disclosureMode(known, boyfriend), 'open');
        assert.equal(disclosureMode(known, classmate), 'vague');
        assert.equal(disclosureMode(bestie, classmate), 'sealed');
        assert.equal(sourceLabel(known, boyfriend), '可明说·和鸽鸽聊的');
        assert.equal(sourceLabel(known, classmate), '只能含糊·和鸽鸽聊的');
        assert.equal(sourceLabel(bestie, classmate), '不能说·私下聊的', '封口标签本身不泄露是谁');
        assert.equal(ownSourceLabel('你的日记', boyfriend), '可明说·你的日记');
        assert.equal(ownSourceLabel('你的日记', classmate), '只能含糊·你的日记');
    });

    test('规则说明三档、永久边界和主动提及时再收紧一级', () => {
        const close = disclosureRules({ name: '阿明', tier: 'boyfriend' });
        for (const phrase of ['可明说', '只能含糊', '不能说', '主动', '再保守一级', '私事', '只跟那个人说', '看法', '不主动说', '说句实在的']) {
            assert.ok(close.includes(phrase), phrase);
        }
        const distant = disclosureRules({ name: '同学', tier: 'classmate' });
        assert.match(distant, /看法.*不主动说；被问起某人怎么样，只说当着他的面也能说的客气话.*不背后议论/);
        assert.ok(!distant.includes('说句实在的'), '普通听众问起只说客气话');
        assert.match(distant, /不要主动向同学提任何别人的事/);
        assert.match(distant, /不能因为不能说就突然截断整句/);
    });
});

describe('何时想起今天和别人聊过的事', () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 6, 12, minute)).toISOString();

    test('新片段里她还没回过才算开场；45 分钟后的新消息重新算一段', () => {
        assert.equal(startsConversation([]), false);
        assert.equal(startsConversation([{ role: 'user', time: at(0) }]), true);
        assert.equal(startsConversation([
            { role: 'user', time: at(0) },
            { role: 'assistant', time: at(1) },
            { role: 'user', time: at(2) },
        ]), false);
        assert.equal(startsConversation([
            { role: 'user', time: at(0) },
            { role: 'assistant', time: at(1) },
            { role: 'user', time: at(46) },
        ]), true);
    });

    test('有作息时从凌晨睡觉分界算今天；没有作息从零点算', () => {
        const schedule = { sleep: '02:00' } as Schedule;
        assert.equal(todayStart(undefined, new Date(2026, 9, 6, 12, 0)).toString(), new Date(2026, 9, 6, 0, 0).toString());
        assert.equal(todayStart(schedule, new Date(2026, 9, 6, 12, 0)).toString(), new Date(2026, 9, 6, 2, 0).toString());
        assert.equal(todayStart(schedule, new Date(2026, 9, 6, 1, 0)).toString(), new Date(2026, 9, 5, 2, 0).toString());
    });
});
