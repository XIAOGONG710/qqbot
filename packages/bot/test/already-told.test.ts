import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { alreadyTold, TOLD_WINDOW_MS } from '../src/language/expression.ts';

// ADR 0098：她主动跟他说过的、关于她自己的事，一天半里不再自己提（10-20 到 10-21 三个晚上每晚都提「肚子坠着」，他说她会老是重复一件事）。台词是虚构的
const at = (hoursAgo: number, now: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
const now = Date.parse('2026-10-22T02:00:00+08:00');
const her = (content: string, hoursAgo: number) => ({ role: 'assistant' as const, content, time: at(hoursAgo, now) });
const him = (content: string, hoursAgo: number) => ({ role: 'user' as const, content, time: at(hoursAgo, now) });

describe('她已经主动说过的事（alreadyTold）', () => {
    test('他没问、她自己提了：算说过；三个晚上提三次也只列一次', () => {
        const history = [
            him('在吗', 31), her('肚子有点坠，今天的题先欠着', 31),
            him('你现在可以刷b站了', 26), her('嗯嗯，肚子不难受了陪你做完', 26),
            him('多陪我聊会', 2), her('那我也不睡了', 2), her('肚子还坠着，就陪你说说话', 2),
        ];
        assert.deepEqual(alreadyTold(history, now), ['肚子不舒服']);
    });

    test('他先问起来、她答的，不算主动', () => {
        const history = [him('你肚子还疼吗', 3), her('还有点坠', 3), him('那早点睡', 2), her('嗯', 2)];
        assert.deepEqual(alreadyTold(history, now), []);
    });

    test('超过一天半的不算；别的事各算各的', () => {
        const history = [
            him('在吗', 40), her('肚子疼', 40),
            him('在干嘛', 5), her('在调相机参数，头都大了', 5),
            him('吃了吗', 4), her('土豆今天又蹲楼下了', 4),
        ];
        assert.deepEqual(alreadyTold(history, now).sort(), ['猫', '相机'].sort());
        assert.equal(TOLD_WINDOW_MS, 36 * 3_600_000);
    });

    test('没有时间的消息、表情包、他自己的话都不算', () => {
        const history = [
            him('我肚子疼', 5), { role: 'assistant' as const, content: '肚子疼吗', time: undefined },
            her('[捂脸]', 4), him('我在调相机', 3), her('嗯', 3),
        ];
        assert.deepEqual(alreadyTold(history, now), []);
    });
});
