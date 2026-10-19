import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isPokeAtMe, segmentsToText, type PokeEvent } from '../src/onebot.ts';
import { createPokeLimiter, POKE_BACK_CHANCE, POKE_BACK_DELAY_MS, POKE_MAX_IN_WINDOW, POKE_OUT_QUIET_MS, POKE_OUT_TEXT, POKE_TEXT, POKE_WINDOW_MS, pokeBackPlan, pokeMessage, pokeOutMessageId, quietEnoughToPoke } from '../src/pokes.ts';

const SELF = 20000;
const poke = (overrides: Record<string, unknown> = {}) => ({
    post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: SELF, user_id: 10001, sender_id: 10001, target_id: SELF, time: 1_800_000_000, ...overrides,
});

describe('戳一戳（ADR 0079）', () => {
    test('认得出：别人私聊戳了小号才算；群里戳、小号戳别人、戳的是别人、别的通知都不算', () => {
        assert.equal(isPokeAtMe(poke()), true);
        assert.equal(isPokeAtMe(poke({ group_id: 555 })), false, '群里的');
        assert.equal(isPokeAtMe(poke({ sender_id: SELF, target_id: 10001 })), false, '小号自己戳他（user_id 仍是他）');
        assert.equal(isPokeAtMe(poke({ target_id: 10002 })), false, '戳的是别人');
        assert.equal(isPokeAtMe(poke({ sub_type: 'honor' })), false);
        assert.equal(isPokeAtMe(poke({ notice_type: 'friend_recall' })), false);
        assert.equal(isPokeAtMe({ ...poke(), post_type: 'message' }), false);
        assert.equal(isPokeAtMe(poke({ user_id: '10001' })), false, 'user_id 不是数字就不认');
    });

    test('变成一条「[戳了戳你]」：是他发的私聊文字，id 比真 id 大，连着戳两下 id 不撞', () => {
        const event = poke() as PokeEvent;
        const a = pokeMessage(event);
        const b = pokeMessage(event);
        assert.equal(a.message_type, 'private');
        assert.equal(a.sub_type, 'friend');
        assert.equal(a.user_id, 10001);
        assert.equal(a.time, event.time);
        assert.equal(segmentsToText(a.message), POKE_TEXT);
        assert.equal(POKE_TEXT, '[戳了戳你]');
        assert.ok(a.message_id >= 2 ** 32 && Number.isSafeInteger(a.message_id), '比 NapCat 的 32 位真 id 大，聊天记录收得下');
        assert.notEqual(a.message_id, b.message_id);
    });

    test('限频：5 分钟里最多算 3 下，超出的不记；窗口滑过去又能算；每个人单独算', () => {
        const limiter = createPokeLimiter();
        const t0 = 1_000_000;
        assert.deepEqual([0, 1000, 2000, 3000].map(dt => limiter.take(1, t0 + dt)), [true, true, true, false]);
        assert.equal(POKE_MAX_IN_WINDOW, 3);
        assert.equal(limiter.take(2, t0 + 3000), true, '另一个人不受影响');
        assert.equal(limiter.take(1, t0 + POKE_WINDOW_MS - 1), false, '第一下还在窗口里');
        assert.equal(limiter.take(1, t0 + POKE_WINDOW_MS), true, '第一下滑出窗口');
        assert.equal(limiter.take(1, t0 + POKE_WINDOW_MS + 100), false, '窗口里现在有 第二、第三、新的一下');
    });

    test('戳回去：按人和时间定（同一下每次一样），约 POKE_BACK_CHANCE 的概率，隔 1.2–3.5 秒', () => {
        const plans = Array.from({ length: 2000 }, (_, i) => pokeBackPlan(10001, 1_800_000_000 + i));
        const hits = plans.filter(plan => plan !== undefined);
        assert.ok(Math.abs(hits.length / plans.length - POKE_BACK_CHANCE) < 0.05, String(hits.length / plans.length));
        assert.ok(hits.every(plan => plan!.delayMs >= POKE_BACK_DELAY_MS[0] && plan!.delayMs <= POKE_BACK_DELAY_MS[1]));
        assert.deepEqual(pokeBackPlan(10001, 1_800_000_007), pokeBackPlan(10001, 1_800_000_007));
    });
});

describe('主动戳他：什么时候合适（ADR 0087）', () => {
    const now = Date.parse('2026-11-03T20:30:00+08:00');
    const msg = (minutesAgo: number, role: 'user' | 'assistant', content: string) => ({ time: new Date(now - minutesAgo * 60_000).toISOString(), role, content });
    test('最后一条是她说的、安静了 90 分钟以上、最近几条里没有道晚安才合适；没聊过、他最后说的（还等她回）、刚聊完都不戳', () => {
        assert.equal(quietEnoughToPoke([msg(120, 'user', '在吗'), msg(110, 'assistant', '在呀')], now), true);
        assert.equal(quietEnoughToPoke([msg(120, 'user', '在吗'), msg(POKE_OUT_QUIET_MS / 60_000 - 1, 'assistant', '在呀')], now), false, '才安静不到 90 分钟');
        assert.equal(quietEnoughToPoke([msg(200, 'assistant', '在呀'), msg(120, 'user', '嗯嗯')], now), false, '他说的最后一条，她还没回');
        assert.equal(quietEnoughToPoke([], now), false, '没聊过');
        assert.equal(quietEnoughToPoke([msg(300, 'user', '晚安'), msg(290, 'assistant', '晚安宝宝')], now), false, '刚道过晚安');
        assert.equal(quietEnoughToPoke([msg(400, 'user', '我先去睡了'), msg(390, 'assistant', '好')], now), false, '他说去睡了');
        assert.equal(quietEnoughToPoke([msg(900, 'assistant', '晚安'), msg(800, 'user', '早'), msg(790, 'user', '在吗'), msg(780, 'assistant', '在'), msg(120, 'assistant', '人呢')], now), true, '更早的晚安不算');
        assert.equal(quietEnoughToPoke([{ time: 'bad', role: 'assistant', content: 'x' }], now), false);
    });

    test('记进聊天记录的那条：id 是非负安全整数、不和真 id（32 位）、他的戳（2^40 起）撞', () => {
        assert.equal(POKE_OUT_TEXT, '[你戳了戳他]');
        const id = pokeOutMessageId(now);
        assert.ok(Number.isSafeInteger(id) && id >= 2 ** 41 && id > 2 ** 32);
        assert.ok(id > 2 ** 40 + now * 1000 / 1000, '大于他的戳的起头');
        assert.notEqual(pokeOutMessageId(now), pokeOutMessageId(now + 1));
    });
});
