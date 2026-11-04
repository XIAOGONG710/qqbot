import assert from 'node:assert/strict';
import test from 'node:test';
import { describeHumanState, describeHumanValues, humanValuesAt, humanValuesFromAnchor, HUMAN_VALUE_KEYS, type HumanValues } from '../src/human-values.ts';
import { effectiveLifeEvents, needsAt } from '../src/life/needs.ts';

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

test('他说自己压力大、焦虑、难受或很累是在倾诉，不误算成对她的关系冲突', () => {
    const neutral = valuesAt([message('user', '我今天事情有点多', 20)]);
    const distressed = valuesAt([message('user', '我今天压力大，又焦虑又难受，真的好累', 20)]);
    assert.equal(distressed.relationship.friction, neutral.relationship.friction);
    assert.equal(distressed.relationship.trust, neutral.relationship.trust);
    assert.equal(distressed.relationship.intimacy, neutral.relationship.intimacy);
    assert.ok(distressed.mood < neutral.mood, '她仍会感受到他在难受，只是不把倾诉当成冲突');
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

test('未来的异常行动不算刚活动过，也不提前压低孤独和无聊', () => {
    const at = new Date('2026-11-01T08:00:00.000Z');
    const future = {
        id: 'life:future', actor: 'linmengyao' as const, kind: 'leisure', day: '2026-11-02',
        startedAt: '2026-11-02T07:00:00.000Z', endedAt: '2026-11-02T08:00:00.000Z',
        source: 'simulation' as const, result: 'succeeded' as const,
    };
    const baseline = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [] });
    const withFuture = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [future] });
    assert.equal(withFuture.loneliness, baseline.loneliness);
    assert.equal(withFuture.boredom, baseline.boredom);
});

test('未来时间戳的聊天不算刚互动过，也不提前压低孤独和无聊', () => {
    const at = new Date('2026-11-01T08:00:00.000Z');
    const futureMessage = {
        role: 'user' as const,
        content: '来自未来的异常消息',
        time: '2026-11-02T08:00:00.000Z',
    };
    const baseline = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [] });
    const withFuture = humanValuesAt({ at, needs, history: [futureMessage], tier: 'boyfriend', events: [] });
    assert.equal(withFuture.loneliness, baseline.loneliness);
    assert.equal(withFuture.boredom, baseline.boredom);
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

test('成功的瞬时家庭视频保留为事实：缓解孤独、略提心情并消耗少量社交电量', () => {
    const at = new Date('2026-11-01T08:00:00.000Z');
    const call = {
        id: 'life:family-call', actor: 'linmengyao' as const, kind: 'family_call', day: '2026-11-01',
        startedAt: at.toISOString(), endedAt: at.toISOString(),
        source: 'conversation' as const, result: 'succeeded' as const,
    };
    assert.deepEqual(effectiveLifeEvents([call]), [call], '零时长事实不占时间轴，但不能被心理投影过滤');
    assert.deepEqual(needsAt(needs, [call], at), needsAt(needs, [], at), '零时长事实不改变精力、饥饿和压力的持续速率');

    const failed = { ...call, id: 'life:family-call-failed', result: 'failed' as const, reason: '世界设定里没有家庭联系' };
    const after = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [call] });
    const failedAttempt = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [failed] });
    assert.ok(after.loneliness < failedAttempt.loneliness, `${failedAttempt.loneliness} -> ${after.loneliness}`);
    assert.ok(after.mood > failedAttempt.mood, `${failedAttempt.mood} -> ${after.mood}`);
    assert.ok(after.comfort > failedAttempt.comfort, `${failedAttempt.comfort} -> ${after.comfort}`);
    assert.ok(after.socialBattery < failedAttempt.socialBattery, `${failedAttempt.socialBattery} -> ${after.socialBattery}`);
});

test('成功喂猫会带来温和的陪伴和满足余波，失败尝试不会得到奖励', () => {
    const at = new Date('2026-11-01T08:00:00.000Z');
    const fed = {
        id: 'life:feed-cat', actor: 'linmengyao' as const, kind: 'feed_cat', day: '2026-11-01',
        startedAt: at.toISOString(), endedAt: at.toISOString(),
        source: 'conversation' as const, result: 'succeeded' as const, seen: true,
    };
    const failed = { ...fed, id: 'life:feed-cat-failed', result: 'failed' as const, reason: '下雨，没见到猫' };
    const after = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [fed] });
    const failedAttempt = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [failed] });
    assert.ok(after.loneliness < failedAttempt.loneliness, `${failedAttempt.loneliness} -> ${after.loneliness}`);
    assert.ok(after.mood > failedAttempt.mood, `${failedAttempt.mood} -> ${after.mood}`);
    assert.ok(after.comfort > failedAttempt.comfort, `${failedAttempt.comfort} -> ${after.comfort}`);
    assert.ok(after.satisfaction > failedAttempt.satisfaction, `${failedAttempt.satisfaction} -> ${after.satisfaction}`);
});

test('完成作业提高信心和满足，取到快递带来轻微期待感；失败都不获得正向余波', () => {
    const at = new Date('2026-11-01T08:00:00.000Z');
    const event = (id: string, kind: string, result: 'succeeded' | 'failed') => ({
        id, actor: 'linmengyao' as const, kind, day: '2026-11-01',
        startedAt: at.toISOString(), endedAt: at.toISOString(),
        source: 'conversation' as const, result,
    });
    const homework = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [event('life:homework', 'finish_homework', 'succeeded')] });
    const failedHomework = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [event('life:homework-failed', 'finish_homework', 'failed')] });
    assert.ok(homework.confidence > failedHomework.confidence);
    assert.ok(homework.selfEsteem > failedHomework.selfEsteem);
    assert.ok(homework.satisfaction > failedHomework.satisfaction);
    assert.ok(homework.frustration < failedHomework.frustration);

    const parcel = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [event('life:parcel', 'pick_parcel', 'succeeded')] });
    const failedParcel = humanValuesAt({ at, needs, history: [], tier: 'boyfriend', events: [event('life:parcel-failed', 'pick_parcel', 'failed')] });
    assert.ok(parcel.mood > failedParcel.mood);
    assert.ok(parcel.curiosity > failedParcel.curiosity);
    assert.ok(parcel.satisfaction > failedParcel.satisfaction);
    assert.ok(parcel.boredom < failedParcel.boredom);
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

test('不同 ID 的重叠冲突行动，身体与心理都只采用稳定选中的一件', () => {
    const at = new Date('2026-11-01T08:00:00.000Z');
    const first = {
        id: 'life:meet-a', actor: 'linmengyao' as const, kind: 'meet', day: '2026-11-01',
        startedAt: '2026-11-01T06:00:00.000Z', endedAt: '2026-11-01T07:00:00.000Z',
        source: 'simulation' as const, result: 'succeeded' as const, meal: true,
    };
    const conflict = { ...first, id: 'life:meet-b' };
    const expected = humanValuesFromAnchor({ at, anchor: { ...needs, hunger: 85 }, history: [], tier: 'boyfriend', events: [first] });
    const combined = humanValuesFromAnchor({ at, anchor: { ...needs, hunger: 85 }, history: [], tier: 'boyfriend', events: [first, conflict] });
    const reversed = humanValuesFromAnchor({ at, anchor: { ...needs, hunger: 85 }, history: [], tier: 'boyfriend', events: [conflict, first] });
    assert.deepEqual(combined, expected);
    assert.deepEqual(reversed, expected, '输入乱序也必须选择稳定 ID，而不是叠加两次社交和吃饭余波');

    const failed = { ...first, id: 'life:failed-study', kind: 'study', meal: false, result: 'failed' as const };
    const withFailedAttempt = humanValuesFromAnchor({ at, anchor: { ...needs, hunger: 85 }, history: [], tier: 'boyfriend', events: [first, failed] });
    assert.equal(withFailedAttempt.hunger, expected.hunger, '失败尝试不产生身体或吃饭收益');
    assert.ok(withFailedAttempt.frustration > expected.frustration, '失败尝试仍保留挫败余波');
});
