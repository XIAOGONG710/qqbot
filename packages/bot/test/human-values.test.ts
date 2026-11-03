import assert from 'node:assert/strict';
import test from 'node:test';
import { describeHumanState, describeHumanValues, humanValuesAt, humanValuesFromAnchor, HUMAN_VALUE_KEYS, type HumanValues } from '../src/human-values.ts';
import { needsAt } from '../src/life/needs.ts';

const needs = { at: '2026-11-01T00:00:00.000Z', energy: 68, hunger: 35, stress: 24 } as const;
const message = (role: 'user' | 'assistant', content: string, hours: number) => ({
    role, content, time: new Date(Date.parse(needs.at) + hours * 3_600_000).toISOString(),
});

function valuesAt(history: ReturnType<typeof message>[], hours = 30) {
    return humanValuesAt({
        at: new Date(Date.parse(needs.at) + hours * 3_600_000),
        needs,
        history,
        tier: 'boyfriend',
        events: [],
    });
}

function assertBounded(values: HumanValues): void {
    const relationshipKeys = new Set(['intimacy', 'trust', 'familiarity', 'attachment', 'friction']);
    const scalar = values as unknown as Record<string, number>;
    for (const key of HUMAN_VALUE_KEYS) if (!relationshipKeys.has(key)) {
        const value = scalar[key];
        assert.ok(value !== undefined && value >= 0 && value <= 100, `${key}=${value}`);
    }
    for (const value of Object.values(values.relationship)) assert.ok(value >= 0 && value <= 100, `relationship=${value}`);
}

test('真人式状态所有维度都在 0–100，并保留现有需要值', () => {
    const values = valuesAt([
        message('user', '今天有点累，但是谢谢你抱抱我', 20),
        message('assistant', '我在呢', 20.1),
        message('user', '你觉得这个要不要改？', 24),
    ]);
    assert.equal(values.energy, needs.energy);
    assert.equal(values.hunger, needs.hunger);
    assert.equal(values.stress, needs.stress);
    assertBounded(values);
});

test('稳定的亲密互动会提高亲密 / 熟悉 / 依恋，冲突会提高摩擦', () => {
    const warm = valuesAt([
        message('user', '我想你了，抱抱', 2), message('assistant', '我在', 2.1),
        message('user', '谢谢你，今天告诉你个事', 10), message('assistant', '好呀', 10.1),
        message('user', '你觉得这个要不要？', 20),
    ]);
    const cold = valuesAt([
        message('user', '你太假了，我生气，别理我', 2),
        message('user', '算了，失望', 10),
    ]);
    assert.ok(warm.relationship.intimacy > cold.relationship.intimacy);
    assert.ok(warm.relationship.familiarity >= cold.relationship.familiarity);
    assert.ok(warm.relationship.attachment > cold.relationship.attachment);
    assert.ok(cold.relationship.friction > warm.relationship.friction);
});

test('状态是时间可重算的，旧聊天信号会自然衰减', () => {
    const history = [message('user', '我想你了，抱抱', 2), message('assistant', '嗯', 2.1)];
    const near = valuesAt(history, 4);
    const far = valuesAt(history, 72);
    assert.ok(near.mood > far.mood);
    assert.ok(far.loneliness > near.loneliness);
    assertBounded(far);
});

test('历史记录无序时仍按最新时间计算沉默时长', () => {
    const ordered = [message('user', '早一点', 2), message('user', '刚刚', 28)];
    const unordered = [...ordered].reverse();
    const expected = valuesAt(ordered, 30);
    const actual = valuesAt(unordered, 30);
    assert.equal(actual.loneliness, expected.loneliness);
    assert.equal(actual.relationship.attachment, expected.relationship.attachment);
});

test('摘要只输出数值，不泄露聊天原文', () => {
    const line = describeHumanValues(valuesAt([message('user', '我的秘密是 123', 2)]));
    assert.match(line, /^数值：/);
    assert.doesNotMatch(line, /秘密|123/);
});

test('给模型的是自然语言底色，不是数字仪表盘', () => {
    const values = valuesAt([message('user', '我想你了，抱抱', 2)]);
    const line = describeHumanState({ ...values, energy: 22, hunger: 84, stress: 76, loneliness: 75 }, 'boyfriend');
    assert.match(line ?? '', /有点累/);
    assert.match(line ?? '', /肚子明显饿了/);
    assert.match(line ?? '', /跟他很亲近/);
    assert.doesNotMatch(line ?? '', /22|84|76|75/);
});

test('行动结算会改变对应数值：吃饭降饥饿，社交降孤独，学习提信心', () => {
    const meal = {
        id: 'life:meal', actor: 'linmengyao' as const, kind: 'eat', day: '2026-11-01',
        startedAt: '2026-11-01T04:00:00.000Z', endedAt: '2026-11-01T05:00:00.000Z',
        source: 'simulation' as const, result: 'succeeded' as const, subject: 'lunch',
    };
    const social = { ...meal, id: 'life:social', kind: 'interact_npc', startedAt: '2026-11-01T06:00:00.000Z', endedAt: '2026-11-01T06:30:00.000Z', subject: '和朋友聊了会儿' };
    const study = { ...meal, id: 'life:study', kind: 'study', startedAt: '2026-11-01T07:00:00.000Z', endedAt: '2026-11-01T08:00:00.000Z', subject: '高数作业' };
    const events = [meal, social, study];
    const at = new Date('2026-11-01T08:00:00.000Z');
    const startingNeeds = { ...needs, hunger: 85 };
    const before = humanValuesAt({ at, needs: startingNeeds, history: [], tier: 'boyfriend', events: [] });
    const projectedNeeds = needsAt(startingNeeds, [meal, social, study], at);
    const after = humanValuesAt({ at, needs: projectedNeeds, history: [], tier: 'boyfriend', events });
    const fromAnchor = humanValuesFromAnchor({ at, anchor: startingNeeds, history: [], tier: 'boyfriend', events });
    assert.ok(after.hunger < before.hunger, `${before.hunger} -> ${after.hunger}`);
    assert.ok(after.loneliness < before.loneliness, `${before.loneliness} -> ${after.loneliness}`);
    assert.ok(after.confidence > before.confidence, `${before.confidence} -> ${after.confidence}`);
    assert.ok(after.mood > before.mood, `${before.mood} -> ${after.mood}`);
    assert.deepEqual(fromAnchor, after);
});

test('数值会联动：身体负荷会传导到舒适、心情、动机、开放和挫败', () => {
    const at = new Date('2026-11-01T12:00:00.000Z');
    const calm = humanValuesAt({
        at, needs: { ...needs, energy: 78, hunger: 18, stress: 12 }, history: [], tier: 'boyfriend', events: [],
    });
    const strained = humanValuesAt({
        at, needs: { ...needs, energy: 30, hunger: 86, stress: 82 }, history: [], tier: 'boyfriend', events: [],
    });
    assert.ok(strained.comfort < calm.comfort);
    assert.ok(strained.mood < calm.mood);
    assert.ok(strained.motivation < calm.motivation);
    assert.ok(strained.openness < calm.openness);
    assert.ok(strained.frustration > calm.frustration);
});

test('带 meal 标记的见面同时结算社交和吃饭余波', () => {
    const at = new Date('2026-11-01T08:00:00.000Z');
    const plainMeet = {
        id: 'life:plain-meet', actor: 'linmengyao' as const, kind: 'meet', day: '2026-11-01',
        startedAt: '2026-11-01T06:00:00.000Z', endedAt: '2026-11-01T07:00:00.000Z',
        source: 'simulation' as const, result: 'succeeded' as const,
    };
    const mealMeet = { ...plainMeet, id: 'life:meal-meet', meal: true };
    const noAction = humanValuesAt({ at, needs: { ...needs, hunger: 85 }, history: [], tier: 'boyfriend', events: [] });
    const plain = humanValuesAt({ at, needs: { ...needs, hunger: 85 }, history: [], tier: 'boyfriend', events: [plainMeet] });
    const withMeal = humanValuesAt({ at, needs: needsAt({ ...needs, hunger: 85 }, [mealMeet], at), history: [], tier: 'boyfriend', events: [mealMeet] });
    assert.ok(withMeal.hunger < plain.hunger);
    assert.ok(withMeal.comfort > plain.comfort);
    assert.ok(withMeal.satisfaction > plain.satisfaction);
    assert.ok(withMeal.loneliness < noAction.loneliness);
});

test('同一行动 ID 重复出现时，身体与心理数值都只结算一次', () => {
    const at = new Date('2026-11-01T08:00:00.000Z');
    const study = {
        id: 'life:study-once', actor: 'linmengyao' as const, kind: 'study', day: '2026-11-01',
        startedAt: '2026-11-01T07:00:00.000Z', endedAt: '2026-11-01T08:00:00.000Z',
        source: 'simulation' as const, result: 'succeeded' as const,
    };
    const once = humanValuesFromAnchor({ at, anchor: needs, history: [], tier: 'boyfriend', events: [study] });
    const conflictingRetry = { ...study, kind: 'rest' };
    const duplicated = humanValuesFromAnchor({ at, anchor: needs, history: [], tier: 'boyfriend', events: [study, conflictingRetry] });
    assert.deepEqual(duplicated, once);
});
