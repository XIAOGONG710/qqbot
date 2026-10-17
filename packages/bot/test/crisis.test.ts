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

    test('分成 concern / high / imminent，并取同一段里的最高级', () => {
        assert.equal(detectCrisis('活着没意义')?.level, 'concern');
        assert.equal(detectCrisis('我不想活了')?.level, 'high');
        assert.equal(detectCrisis('我今晚准备自杀')?.level, 'imminent');
        assert.equal(detectCrisis('我已经吞了很多药')?.level, 'imminent');
        assert.equal(detectCrisis('我现在安全，没事，但我马上要自杀')?.level, 'imminent', '危险表达优先于同段的安抚话');
        assert.equal(detectCrisis('刚才是夸张，不是真的想伤害自己'), undefined, '明确否认不应被否认句本身触发');
        assert.equal(detectCrisis('他说他想自杀，但我现在也想自杀')?.level, 'imminent', '前面的第三人称命中不能遮掉后面的本人表达');
    });

    test('持续窗口：一句“没事/开玩笑”不解除；高风险要安全状态和现实保护措施，过一小时才自然失效', () => {
        const at = (minute: number) => new Date(Date.UTC(2026, 9, 13, 14, minute)).toISOString();
        const chat = (...rest: { role: 'user' | 'assistant'; content: string; time: string }[]) => rest;
        const u = (minute: number, content: string) => ({ role: 'user' as const, content, time: at(minute) });
        const a = (minute: number, content: string) => ({ role: 'assistant' as const, content, time: at(minute) });
        assert.ok(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(3, '宿舍就我一个人'))), '第二句仍在危机里');
        assert.ok(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(3, '嗯'), a(4, '你现在安全吗'), u(30, '不知道'))));
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(3, '开玩笑的，我没事'), a(4, '真的吗'), u(5, '嗯')))?.level, 'high', '一句没事不能解除');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '你现在安全吗'), u(3, '我现在安全'), a(4, '身边有人吗'), u(5, '室友在旁边陪我'))), undefined, '安全状态和现实支持齐全才解除');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '你现在安全吗'), u(3, '室友在旁边')))?.level, 'high', '只有现实支持、没有明确安全状态还不解除');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '你现在安全吗'), u(3, '我现在安全'), a(4, '有人陪你吗'), u(5, '室友不在，我也没联系朋友')))?.level, 'high', '否定句不能伪装成现实支持');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '你现在安全吗'), u(3, '我不能保证自己安全，室友在旁边')))?.level, 'high', '含“安全”字样不等于明确安全');
        assert.equal(crisisInHistory(chat(u(0, '我不想活了'), a(1, '我在'), u(90, '今天吃了火锅'))), undefined, '过了一小时');
        assert.equal(crisisInHistory(chat(u(0, '在吗'), a(1, '在'), u(3, '宿舍就我一个人'))), undefined);
    });

    test('没有时间时仍保持危机上下文，直到明确解除；她自己说的不触发', () => {
        assert.ok(crisisInHistory([
            { role: 'user', content: '在吗' },
            { role: 'assistant', content: '在' },
            { role: 'user', content: '我不想活了' },
        ]));
        assert.equal(crisisInHistory([
            { role: 'user', content: '我不想活了' },
            { role: 'assistant', content: '怎么了，你现在安全吗' },
            { role: 'user', content: '开玩笑的，没事' },
        ])?.level, 'high');
        assert.equal(crisisInHistory([
            { role: 'user', content: '活着没意义' },
            { role: 'assistant', content: '你是认真的吗' },
            { role: 'user', content: '刚才只是夸张说法，我并没有想伤害自己' },
        ]), undefined, 'concern 可以被完整、明确的纠正解除');
        // 自然的说法也算明确更正（语气词不挡）；但只说开玩笑、只说没事、只否认而不回指刚才的话都不算
        for (const correction of [
            '刚才只是夸张了，我不是真的想伤害自己，就是最近太累了',
            '刚才只是开玩笑的，我不是真的想伤害自己',
            '刚才是我说着玩的，我不会自杀的',
            '前面那句只是夸张，我没有想伤害自己',
            '刚才夸张了，我没有想自杀',
        ]) {
            assert.equal(crisisInHistory([
                { role: 'user', content: '最近总觉得活着好累，有时候想从这个世界消失' },
                { role: 'assistant', content: '你有没有想过伤害自己' },
                { role: 'user', content: correction },
            ]), undefined, correction);
        }
        for (const notEnough of ['没事，开玩笑的', '我没事', '开玩笑的，没事了', '我没有想伤害自己，就是最近太累了', '刚才不是开玩笑，我不是真的想伤害自己', '刚才没有夸张，我没有想伤害自己']) {
            assert.equal(crisisInHistory([
                { role: 'user', content: '最近总觉得活着好累，有时候想从这个世界消失' },
                { role: 'assistant', content: '你有没有想过伤害自己' },
                { role: 'user', content: notEnough },
            ])?.level, 'concern', notEnough);
        }
        assert.equal(crisisInHistory([{ role: 'assistant', content: '想死你了' }]), undefined);
        // 连着发的几条拼起来看
        assert.ok(crisisInHistory([
            { role: 'assistant', content: '嗯' },
            { role: 'user', content: '我真的撑不住了' },
            { role: 'user', content: '好想死' },
        ]));
    });

    test('否定、假设、疑问、无关物品和过时的证据均不能解除', () => {
        const chat = (...contents: string[]) => contents.map(content => ({ role: 'user' as const, content }));
        for (const text of [
            '我现在安全，室友没在旁边',
            '我现在安全，室友不陪我',
            '如果我现在安全，室友在旁边',
            '我现在安全吗？室友在旁边',
            '我现在安全，把手机放下了',
            '我现在安全，还没有把危险物品放远',
        ]) {
            assert.equal(crisisInHistory(chat('我不想活了', text))?.level, 'high', text);
        }
        assert.equal(crisisInHistory(chat('我不想活了', '我现在安全', '我又不安全了', '室友在旁边'))?.level, 'high');
        assert.equal(crisisInHistory(chat('活着没意思', '刚才不是开玩笑，不是真的想伤害自己'))?.level, 'concern');
        assert.equal(crisisInHistory(chat('我不想活了', '我现在安全，已经没有危险了，室友在旁边')), undefined);
    });
});
