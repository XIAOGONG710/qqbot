import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/history.ts';
import {
    arrivedWhileAsleep, isAck, isAckAfterClosing, isReaction, MOODY_CHANCE, MOODY_MAX_CHANCE, moodySkip, pendingMessages, typingMs, wakeUpTime, whenSeen,
} from '../src/reply-timing.ts';
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

    test('在忙得看不了手机（ADR 0031：洗澡）：忙完 1–3 分钟后才看到，正聊着也一样；不忙照常', () => {
        const until = t(10, 12, 23, 10);
        const busy = { ...boyfriend, busy: (now: number) => (now < until ? { until, reason: '在洗澡，洗完才看到' } : undefined) };
        const hot = [her(t(10, 12, 22, 38)), user(t(10, 12, 22, 40))];
        const seen = whenSeen(hot, t(10, 12, 22, 40), busy)!;
        assert.equal(seen.reason, '在洗澡，洗完才看到');
        assert.ok(seen.at >= until + MIN && seen.at <= until + 3 * MIN, String(new Date(seen.at)));
        assert.deepEqual(whenSeen(hot, t(10, 12, 23, 20), busy), { at: t(10, 12, 22, 40), reason: '正聊着' }, '洗完以后照常');
    });

    test('在外面办事（10-11 逛市场挑相机）：正聊着也隔 2–8 分钟才看到，最多回 2 条；洗澡这种看不了手机的排在前面；回来以后照常', () => {
        const until = t(10, 11, 16, 30);
        const out = { ...boyfriend, out: (now: number) => (now < until ? '在山大路科技市场挑相机，隔一会儿才看手机' : undefined) };
        const hot = [her(t(10, 11, 15, 2)), user(t(10, 11, 15, 3), '挑好没')];
        const seen = whenSeen(hot, t(10, 11, 15, 3), out)!;
        assert.equal(seen.reason, '在山大路科技市场挑相机，隔一会儿才看手机');
        assert.ok(seen.at >= t(10, 11, 15, 5) && seen.at <= t(10, 11, 15, 11), String(new Date(seen.at)));
        assert.equal(seen.maxBubbles, 2);
        assert.equal(whenSeen(hot, t(10, 11, 15, 3), out)!.at, seen.at, '同一串算出同一个时刻');
        const both = { ...out, busy: () => ({ until: t(10, 11, 15, 20), reason: '在洗澡，洗完才看到' }) };
        assert.equal(whenSeen(hot, t(10, 11, 15, 3), both)!.reason, '在洗澡，洗完才看到');
        const back = [her(t(10, 11, 16, 38)), user(t(10, 11, 16, 40), '买到了？')];
        assert.deepEqual(whenSeen(back, t(10, 11, 16, 40), out), { at: t(10, 11, 16, 40), reason: '正聊着' });
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

    test('收尾后的附和没回，对方隔很久才说别的：这一串从那句算起（冷场延迟、夜里的消息都按它）', () => {
        const closed = [user(t(10, 5, 22)), her(t(10, 5, 22, 1), '早点睡'), user(t(10, 5, 22, 2), '晚安')];
        const next = user(t(10, 6, 14), '过了！');
        assert.deepEqual(pendingMessages([...closed, next]), [next]);
        assert.deepEqual(pendingMessages(closed), []);
        assert.equal(isAckAfterClosing([...closed, next]), false);
        // 她 10 月 5 日 22:01 之后没说过话：冷场，15–60 秒后才看到（按附和算的话，22:02 早就过了，马上回）
        const seen = whenSeen([...closed, next], t(10, 6, 14), boyfriend)!;
        assert.equal(seen.reason, '冷场，过一会儿才看到');
        assert.ok(seen.at >= t(10, 6, 14, 0, 15), String(new Date(seen.at)));
        // 附和之后夜里 3 点来的消息：起床后照样回
        assert.equal(arrivedWhileAsleep([...closed, user(t(10, 6, 3), '睡不着')], t(10, 6, 10), schedule), true);
        // 收尾后先附和、紧接着说别的：附和不算进这一串，说别的那句照常回
        assert.deepEqual(pendingMessages([...closed, user(t(10, 5, 22, 2), '对了 明天几点起')]).map(m => m.content), ['对了 明天几点起']);
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

describe('档位节奏和看心情不回（ADR 0013）', () => {
    /** 她 14:00 回过，对方 14:01 起发的一串（id 指定） */
    const chat = (...messages: [id: number, minute: number, second: number, content: string][]): StoredMessage[] => [
        her(t(10, 5, 14), '笑死我了'),
        ...messages.map(([id, m, s, content]) => ({ time: new Date(t(10, 5, 14, m, s)).toISOString(), role: 'user' as const, content, messageId: id })),
    ];
    const ids = Array.from({ length: 2000 }, (_, i) => 10_000 + i);
    const skippedIds = (pace: number) => ids.filter(id => moodySkip(chat([id, 1, 0, '哈哈哈']), pace));

    test('节奏系数乘在冷场时多久看到和打字时间上；正聊着照样马上看到', () => {
        const cold = [her(t(10, 5, 13, 40)), user(t(10, 5, 14))];
        const base = whenSeen(cold, t(10, 5, 14), boyfriend)!.at - t(10, 5, 14);
        const slow = whenSeen(cold, t(10, 5, 14), { ...classmate, pace: 2.2 })!.at - t(10, 5, 14);
        assert.ok(Math.abs(slow - base * 2.2) <= 1, `${base} → ${slow}`);
        const hot = [her(t(10, 5, 13, 55)), user(t(10, 5, 14))];
        assert.deepEqual(whenSeen(hot, t(10, 5, 14), { ...classmate, pace: 2.2 }), { at: t(10, 5, 14), reason: '正聊着' });
        assert.ok(Math.abs(typingMs('一二三四五六七八九十', 1.6) - typingMs('一二三四五六七八九十') * 1.6) <= 1);
    });

    test('反应：哈哈、嗯、确实、表情算；问句、图片、语音、戳一戳、晚安拜拜、带了别的话都不算', () => {
        for (const text of ['哈哈哈', 'hhh', '嗯嗯', '笑死', '确实。', '好的～', '[表情]', '[动画表情]', '👍', '哈哈哈[表情]', '666', '草']) {
            assert.equal(isReaction(text), true, text);
        }
        for (const text of ['哈哈哈？', '真的吗', '[图片]', '[语音]', '[视频]', '[poke]', '晚安', '拜拜', '哈哈你真逗', '今天好累', '']) {
            assert.equal(isReaction(text), false, text);
        }
    });

    test('正聊着、一串都是反应：按第一条的 id 定，男朋友档约 15%，系数越大越多，最多 35%', () => {
        const rate = (pace: number) => skippedIds(pace).length / ids.length;
        assert.ok(Math.abs(rate(1) - MOODY_CHANCE) < 0.03, String(rate(1)));
        assert.ok(Math.abs(rate(2.2) - MOODY_CHANCE * 2.2) < 0.04, String(rate(2.2)));
        assert.ok(Math.abs(rate(3) - MOODY_MAX_CHANCE) < 0.04, String(rate(3)));
        // 同一串重算多少次都一样（重启后也一样）
        const id = skippedIds(1)[0]!;
        assert.match(moodySkip(chat([id, 1, 0, '哈哈哈']), 1)!, /看心情没回.*隔一分钟以上再来一条一定回/);
        assert.equal(moodySkip(chat([id, 1, 0, '哈哈哈']), 1), moodySkip(chat([id, 1, 0, '哈哈哈']), 1));
    });

    test('同一个 id：不是反应、冷场、问句都照样回', () => {
        const id = skippedIds(1)[0]!;
        assert.equal(moodySkip(chat([id, 1, 0, '哈哈哈 你今天几点下课']), 1), undefined);
        assert.equal(moodySkip(chat([id, 1, 0, '哈哈哈？']), 1), undefined);
        assert.equal(moodySkip(chat([id, 1, 0, '[图片]']), 1), undefined);
        assert.equal(moodySkip(chat([id, 11, 0, '哈哈哈']), 1), undefined, '离她上次回复超过 10 分钟：冷场，看到了就回');
        assert.equal(moodySkip([user(t(10, 5, 14), '哈哈')]), undefined, '她还没说过话');
    });

    test('不回之后：一分钟内接着来的反应一起不回；隔一分钟以上再来一条（哪怕还是反应）一定回；一串里带了正事也回', () => {
        const id = skippedIds(1)[0]!;
        assert.ok(moodySkip(chat([id, 1, 0, '哈哈哈'], [id + 5000, 1, 40, '[表情]']), 1));
        assert.equal(moodySkip(chat([id, 1, 0, '哈哈哈'], [id + 5000, 2, 30, '[表情]']), 1), undefined);
        assert.equal(moodySkip(chat([id, 1, 0, '哈哈哈'], [id + 5000, 1, 10, '你吃饭了吗']), 1), undefined);
    });
});

describe('听语音（ADR 0052）', () => {
    test('正聊着来了语音：听完才算看到（几秒按记录里写的，只有字按字数，都没有按 6 秒）；两条语音接着听', () => {
        const hot = [her(t(10, 5, 13, 55)), user(t(10, 5, 14), '[语音 8秒：今天食堂人好多]')];
        assert.deepEqual(whenSeen(hot, t(10, 5, 14), boyfriend), { at: t(10, 5, 14, 0, 8), reason: '正聊着，听完语音（8 秒）' });
        const unknown = [her(t(10, 5, 13, 55)), user(t(10, 5, 14), '[语音]')];
        assert.equal(whenSeen(unknown, t(10, 5, 14), boyfriend)!.at, t(10, 5, 14, 0, 6));
        // 文字先到、语音 3 秒后到：从语音到了开始听；第二条语音接着第一条听完
        const two = [her(t(10, 5, 13, 55)), user(t(10, 5, 14), '你听听'), user(t(10, 5, 14, 0, 3), '[语音 10秒]'), user(t(10, 5, 14, 0, 5), '[语音 4秒：还有这个]')];
        assert.deepEqual(whenSeen(two, t(10, 5, 14, 0, 5), boyfriend), { at: t(10, 5, 14, 0, 17), reason: '正聊着，听完语音（14 秒）' });
        // 没有语音的照旧
        assert.deepEqual(whenSeen([her(t(10, 5, 13, 55)), user(t(10, 5, 14), '[图片]')], t(10, 5, 14), boyfriend), { at: t(10, 5, 14), reason: '正聊着' });
    });

    test('冷场：过一会儿看到，再加上听的时间；上硬课不听（看转出来的字或者让他打字），照旧', () => {
        const cold = [her(t(10, 5, 13, 40)), user(t(10, 5, 14))];
        const base = whenSeen(cold, t(10, 5, 14), boyfriend)!;
        const voice = [her(t(10, 5, 13, 40)), { ...cold[1]!, content: '[语音 20秒]' }];
        assert.deepEqual(whenSeen(voice, t(10, 5, 14), boyfriend), { at: base.at + 20_000, reason: '冷场，过一会儿才看到，听完语音（20 秒）' });
        const inClass = [user(t(10, 12, 10), '[语音 20秒：下课一起吃饭]')];
        const text = [{ ...inClass[0]!, content: '下课一起吃饭' }];
        assert.deepEqual(whenSeen(inClass, t(10, 12, 10), boyfriend), whenSeen(text, t(10, 12, 10), boyfriend));
    });

    test('附和看语音里说的：「[语音 2秒：嗯嗯]」算，说了别的不算；没转出来的语音、照片不知道是什么，不算（照样回）；表情包照旧算', () => {
        assert.equal(isAck('[语音 2秒：嗯嗯]'), true);
        assert.equal(isAck('[语音：晚安]'), true);
        assert.equal(isAck('[语音 5秒：我还有个事跟你说]'), false);
        assert.equal(isAck('[语音 3秒]'), false);
        assert.equal(isAck('[语音]'), false);
        assert.equal(isAck('[图片]'), false);
        assert.equal(isAck('[图片，上面写着：晚安]'), false);
        assert.equal(isAck('[动画表情]'), true);
        // 前一晚她道了晚安，第二天来一条没转出来的语音：要回
        assert.equal(isAckAfterClosing([her(t(10, 11, 22, 41), '晚安'), user(t(10, 12, 10, 5), '[语音 15秒]')]), false);
        assert.equal(isReaction('[语音 2秒：哈哈哈]'), false, '语音不算反应，照样回');
    });
});
