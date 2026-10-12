import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { crisisInHistory, detectCrisis } from '../src/crisis.ts';

// 全部是虚构的短句。命中表：明确想伤害自己、想结束生命；排除表：夸张、想念、骂别人、说别人和剧情里的事、物价。
const HITS = [
    '我想自杀',
    '我真的不想活了',
    '活不下去了',
    '我想去死',
    '好想死',
    '真想死',
    '我想结束自己的生命',
    '我不想再活了',
    '活着没意思',
    '活着好累，不如死了',
    '我想从这个世界消失',
    '死了算了',
    '我昨晚割腕了',
    '我想从楼上跳楼',
    '我想伤害自己',
    '我有自残的念头',
    'i want to kill myself',
    '没有我会更好',
    '今天作业好多\n我不想活了',
];

const MISSES = [
    '笑死我了哈哈哈',
    '累死了今天',
    '气得我想死',
    '烦得想死',
    '作业多得想死',
    '这数据库实验难得我想死',
    '无聊得想死',
    '想死你了宝宝',
    '想死你啦',
    '想死我了没看到你',
    '你去死吧',
    '他去死吧哈哈',
    '这家店在搞跳楼价大甩卖',
    '新闻里说有人跳楼了',
    '小说里主角想自杀，写得好惨',
    '他说他想自杀，我陪他聊了聊',
    '剧里她轻生那段哭死我了',
    '今天天气真好',
    '我饿死了，想吃火锅',
    '我杀了这个boss，哈哈',
    '',
];

describe('危机信号检测（ADR 0068 决策 1）', () => {
    for (const text of HITS) {
        test(`命中：${text.replace(/\n/g, ' / ')}`, () => {
            assert.ok(detectCrisis(text), text);
        });
    }

    for (const text of MISSES) {
        test(`不命中：${text.replace(/\n/g, ' / ') || '(空)'}`, () => {
            assert.equal(detectCrisis(text), undefined, text);
        });
    }

    test('持续窗口：说过以后一小时内的每一轮都还算（「宿舍就我一个人」），他明着解除或过了一小时就不算', () => {
        const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 14, minute)).toISOString();
        const chat = (...rest: { role: 'user' | 'assistant'; content: string; time: string }[]) => rest;
        const u = (minute: number, content: string) => ({ role: 'user' as const, content, time: at(minute) });
        const a = (minute: number, content: string) => ({ role: 'assistant' as const, content, time: at(minute) });
        assert.ok(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(3, '宿舍就我一个人'))), '第二句仍在危机里');
        assert.ok(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(3, '嗯'), a(4, '你现在安全吗'), u(30, '不知道'))));
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(3, '开玩笑的'), a(4, '真的吗'), u(5, '嗯'))), undefined, '他解除了');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(90, '今天吃了火锅'))), undefined, '过了一小时');
        assert.equal(crisisInHistory(chat(u(0, '在吗'), a(1, '在'), u(3, '宿舍就我一个人'))), undefined);
    });

    test('只看她上一次回复以后他发的内容（没有时间时）；她自己说的、更早的不算', () => {
        assert.ok(crisisInHistory([
            { role: 'user', content: '在吗' },
            { role: 'assistant', content: '在' },
            { role: 'user', content: '我不想活了' },
        ]));
        assert.equal(crisisInHistory([
            { role: 'user', content: '我不想活了' },
            { role: 'assistant', content: '怎么了，你现在安全吗' },
            { role: 'user', content: '开玩笑的，没事' },
        ]), undefined);
        assert.equal(crisisInHistory([{ role: 'assistant', content: '想死你了' }]), undefined);
        // 连着发的几条拼起来看
        assert.ok(crisisInHistory([
            { role: 'assistant', content: '嗯' },
            { role: 'user', content: '我真的撑不住了' },
            { role: 'user', content: '好想死' },
        ]));
    });
});
