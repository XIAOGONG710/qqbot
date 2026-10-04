import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/history.ts';
import { arrivedWhileAsleep, isAck, isAckAfterClosing, typingMs, wakeUpTime, whenSeen } from '../src/reply-timing.ts';
import { loadCharacterCard } from '../src/st/card.ts';

const schedule = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json')).schedule!;
const boyfriend = { schedule, wakeable: true };
const classmate = { schedule, wakeable: false };
/** 本地时间 2026 年的毫秒时间戳 */
const t = (month: number, day: number, h: number, m = 0, s = 0) => new Date(2026, month - 1, day, h, m, s).getTime();
let nextId = 1;
const user = (time: number, content = '在吗'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'user', content, messageId: nextId++ });
const her = (time: number, content = '嗯'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'assistant', content });
const MIN = 60_000;

describe('回复时机：什么时候看到', () => {
    test('没有没回的消息', () => {
        assert.equal(whenSeen([], t(10, 5, 14), boyfriend), undefined);
        assert.equal(whenSeen([user(t(10, 5, 14)), her(t(10, 5, 14, 1))], t(10, 5, 14, 2), boyfriend), undefined);
    });

    test('空闲时：正聊着（她 10 分钟内回过）马上看到；冷场 15–60 秒后看到，同一串重算结果不变', () => {
        const hot = [her(t(10, 5, 13, 55)), user(t(10, 5, 14))];
        assert.deepEqual(whenSeen(hot, t(10, 5, 14), boyfriend), { at: t(10, 5, 14), reason: '正聊着' });

        const cold = [her(t(10, 5, 13, 40)), user(t(10, 5, 14))];
        const seen = whenSeen(cold, t(10, 5, 14), boyfriend)!;
        assert.ok(seen.at >= t(10, 5, 14, 0, 15) && seen.at <= t(10, 5, 14, 1), String(new Date(seen.at)));
        assert.equal(seen.reason, '冷场，过一会儿才看到');
        assert.deepEqual(whenSeen([...cold, user(t(10, 5, 14, 0, 5))], t(10, 5, 14, 0, 5), boyfriend), seen);
        // 从来没回过也算冷场
        assert.ok(whenSeen([user(t(10, 5, 14))], t(10, 5, 14), boyfriend)!.at > t(10, 5, 14));
    });

    test('上硬课：5–20 分钟后看到，最多回 1 条；上机房课 2–6 分钟、最多 2 条；水课照常', () => {
        const hard = whenSeen([user(t(10, 12, 10))], t(10, 12, 10), boyfriend)!;
        assert.ok(hard.at >= t(10, 12, 10, 5) && hard.at <= t(10, 12, 10, 20));
        assert.equal(hard.maxBubbles, 1);
        assert.equal(hard.reason, '在上专业课，认真听');

        const machine = whenSeen([user(t(10, 12, 8, 30))], t(10, 12, 8, 30), boyfriend)!;
        assert.ok(machine.at >= t(10, 12, 8, 32) && machine.at <= t(10, 12, 8, 36));
        assert.equal(machine.maxBubbles, 2);

        // 周四晚上的 Python数据分析 是水课
        const water = whenSeen([user(t(10, 15, 19))], t(10, 15, 19), boyfriend)!;
        assert.equal(water.maxBubbles, undefined);
        assert.ok(water.at <= t(10, 15, 19, 1));
    });

    test('快下课时来的消息：下课后 0.5–2 分钟看到', () => {
        // Linux 09:40 下课
        const seen = whenSeen([user(t(10, 12, 9, 39))], t(10, 12, 9, 39), boyfriend)!;
        assert.ok(seen.at <= t(10, 12, 9, 42) && seen.at >= t(10, 12, 9, 40, 30), String(new Date(seen.at)));
    });

    test('睡着时：起床后 0–30 分钟看到；同学档连着发也不会被吵醒', () => {
        const one = whenSeen([user(t(10, 5, 3))], t(10, 5, 3), boyfriend)!;
        assert.ok(one.at >= t(10, 5, 9, 30) && one.at <= t(10, 5, 10));
        assert.equal(one.woken, undefined);
        const many = [user(t(10, 5, 3)), user(t(10, 5, 3, 1)), user(t(10, 5, 3, 2))];
        assert.equal(whenSeen(many, t(10, 5, 3, 2), classmate)!.woken, undefined);
        // 有早课的日子 07:40 起
        assert.ok(whenSeen([user(t(10, 12, 3))], t(10, 12, 3), classmate)!.at < t(10, 12, 8, 20));
    });

    test('男朋友档：15 分钟内第 3 条，或者隔 2 分钟以上又来一条，被吵醒回一句', () => {
        const three = [user(t(10, 5, 3)), user(t(10, 5, 3, 0, 20)), user(t(10, 5, 3, 0, 40))];
        assert.deepEqual(whenSeen(three, t(10, 5, 3, 0, 40), boyfriend), { at: t(10, 5, 3, 0, 40), reason: '睡着了，被连着来的消息吵醒', woken: true, maxBubbles: 1 });
        const again = [user(t(10, 5, 3)), user(t(10, 5, 3, 3))];
        assert.equal(whenSeen(again, t(10, 5, 3, 3), boyfriend)!.woken, true);
        const twoQuick = [user(t(10, 5, 3)), user(t(10, 5, 3, 0, 30))];
        assert.equal(whenSeen(twoQuick, t(10, 5, 3, 0, 30), boyfriend)!.woken, undefined);
        // 隔太久的两条不算连着发
        const farApart = [user(t(10, 5, 3)), user(t(10, 5, 4))];
        assert.equal(whenSeen(farApart, t(10, 5, 4), boyfriend)!.woken, undefined);
        // 睡着之前（02:00 之前）的消息不算
        const beforeSleep = [user(t(10, 5, 1, 50)), user(t(10, 5, 1, 59)), user(t(10, 5, 2, 1))];
        assert.equal(whenSeen(beforeSleep, t(10, 5, 2, 1), boyfriend)!.woken, undefined);
    });

    test('一晚最多被吵醒一次：回过一句之后再来消息就等起床', () => {
        const history = [user(t(10, 5, 3)), user(t(10, 5, 3, 3)), her(t(10, 5, 3, 4), '干嘛呀…睡了'),
            user(t(10, 5, 3, 10)), user(t(10, 5, 3, 11)), user(t(10, 5, 3, 12))];
        const seen = whenSeen(history, t(10, 5, 3, 12), boyfriend)!;
        assert.equal(seen.woken, undefined);
        assert.ok(seen.at >= t(10, 5, 9, 30));
    });

    test('wakeUpTime', () => {
        assert.equal(wakeUpTime([]), undefined);
        assert.equal(wakeUpTime([0, 10_000, 20_000]), 20_000);
        assert.equal(wakeUpTime([0, 2 * MIN]), 2 * MIN);
        assert.equal(wakeUpTime([0, 16 * MIN]), undefined);
        assert.equal(wakeUpTime([0, 16 * MIN, 17 * MIN, 17.5 * MIN]), 17.5 * MIN);
    });
});

describe('回复时机：打字、附和、夜里的消息', () => {
    test('打字时间按字数：0.8 秒 + 每字 0.1 秒，限制在 1–4 秒，±20%', () => {
        const ten = typingMs('一二三四五六七八九十');
        assert.ok(ten >= 1800 * 0.8 && ten <= 1800 * 1.2, String(ten));
        assert.ok(typingMs('嗯') >= 800 && typingMs('嗯') <= 1200);
        assert.ok(typingMs('长'.repeat(100)) <= 4800 && typingMs('长'.repeat(100)) >= 3200);
        assert.equal(typingMs('一二三四五六七八九十'), ten);
    });

    test('她已经收尾，对方只回附和：不回；说了别的照常回', () => {
        const closed = [user(t(10, 5, 23)), her(t(10, 5, 23, 1), '晚安，明天见')];
        assert.equal(isAckAfterClosing([...closed, user(t(10, 5, 23, 2), '嗯嗯')]), true);
        assert.equal(isAckAfterClosing([...closed, user(t(10, 5, 23, 2), '晚安[表情]')]), true);
        assert.equal(isAckAfterClosing([...closed, user(t(10, 5, 23, 2), '好的～'), user(t(10, 5, 23, 2), '[动画表情]')]), true);
        assert.equal(isAckAfterClosing([...closed, user(t(10, 5, 23, 2), '嗯 你明天几点起')]), false);
        // 收尾在她这次回复的前一条气泡里
        assert.equal(isAckAfterClosing([user(t(10, 5, 23)), her(t(10, 5, 23, 1), '行，去吧'), her(t(10, 5, 23, 1), '回来再说'), user(t(10, 5, 23, 2), '好')]), true);
        assert.equal(isAckAfterClosing([user(t(10, 5, 23)), her(t(10, 5, 23, 1), '在干嘛'), user(t(10, 5, 23, 2), '嗯')]), false);
        assert.equal(isAckAfterClosing([...closed]), false);
    });

    test('isAck', () => {
        for (const text of ['嗯', '嗯嗯嗯', '好', '好的', 'OK', 'ok!', '哦哦', '晚安', '嗯嗯晚安', '[表情]', '👌', '88']) assert.equal(isAck(text), true, text);
        for (const text of ['好想你', '嗯？你说啥', '晚安宝宝', '为什么', '']) assert.equal(isAck(text), false, text);
    });

    test('夜里来的消息 12 小时内起床后照样回（重启后的补回）', () => {
        assert.equal(arrivedWhileAsleep([user(t(10, 5, 3))], t(10, 5, 10), schedule), true);
        assert.equal(arrivedWhileAsleep([user(t(10, 5, 1))], t(10, 5, 10), schedule), false);
        assert.equal(arrivedWhileAsleep([user(t(10, 5, 3))], t(10, 5, 15, 30), schedule), false);
        assert.equal(arrivedWhileAsleep([user(t(10, 5, 3)), her(t(10, 5, 9, 40))], t(10, 5, 10), schedule), false);
    });
});
