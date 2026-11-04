import assert from 'node:assert/strict';
import test from 'node:test';
import type { HumanValues } from '../src/human-values.ts';
import {
    auditDevelopment, autonomyDecision, creativeDraftIntents, describeDevelopment, developmentSnapshot,
    developmentSummary, emotionContinuity, lifeArcs, proactiveShare, reflectionLessons,
    relationshipDevelopment, sharedExperiences, tasteProfile,
} from '../src/life/development.ts';
import { sanitizeDshState } from '../src/dsh-link.ts';
import type { LifeEvent } from '../src/world/life-events.ts';

const now = new Date('2026-11-04T08:00:00.000Z');
const values = (overrides: Partial<HumanValues> = {}): HumanValues => ({
    at: now.toISOString(), energy: 65, hunger: 30, stress: 35, mood: 68, health: 90,
    loneliness: 28, confidence: 65, curiosity: 72, boredom: 25, motivation: 68,
    socialBattery: 65, selfEsteem: 64, openness: 72, satisfaction: 65, comfort: 70,
    frustration: 20,
    relationship: { intimacy: 82, trust: 76, familiarity: 84, attachment: 78, friction: 8 },
    ...overrides,
});
const event = (id: string, kind: string, daysAgo = 0, result: LifeEvent['result'] = 'succeeded', extra: Partial<LifeEvent> = {}): LifeEvent => {
    const ended = new Date(now.getTime() - daysAgo * 86_400_000);
    return {
        id, actor: 'linmengyao', kind, day: ended.toISOString().slice(0, 10),
        startedAt: new Date(ended.getTime() - 30 * 60_000).toISOString(), endedAt: ended.toISOString(),
        source: 'simulation', result, ...extra,
    };
};

test('长期人生线从九十天生活事件重算并区分活跃和停滞', () => {
    const arcs = lifeArcs([event('p1', 'photography_edit', 1), event('p2', 'photography_shoot', 2), event('s1', 'study', 45)], now);
    assert.deepEqual(arcs.map(arc => [arc.id, arc.state]), [['study', 'stalled'], ['photography', 'active']]);
    assert.ok(arcs.find(arc => arc.id === 'photography')!.progress > 0);
});

test('自主决策让身体、压力、连接和探索改变柔性计划', () => {
    assert.equal(autonomyDecision(values({ energy: 20 })).mode, 'recover');
    assert.equal(autonomyDecision(values({ stress: 85 })).mode, 'focus');
    assert.equal(autonomyDecision(values({ loneliness: 80, socialBattery: 60, curiosity: 30 })).mode, 'connect');
    assert.equal(autonomyDecision(values()).mode, 'explore');
});

test('关系阶段把安全感、靠近需要、摩擦与修复放在一起', () => {
    const strained = values({ relationship: { intimacy: 70, trust: 68, familiarity: 80, attachment: 75, friction: 48 } });
    const relation = relationshipDevelopment(strained, [{ role: 'user', content: '对不起，是我不好', time: now.toISOString() }]);
    assert.equal(relation.stage, 'repairing');
    assert.ok(relation.security < 80);
    assert.ok(relation.repairReadiness > 50);
});

test('情绪具有来源和惯性，和好不会瞬间归零', () => {
    const relation = relationshipDevelopment(values({ relationship: { intimacy: 70, trust: 65, familiarity: 75, attachment: 70, friction: 45 } }), [{ role: 'user', content: '抱歉，我们和好吧' }]);
    const emotion = emotionContinuity(values(), relation, [{ role: 'user', content: '抱歉，我们和好吧' }]);
    assert.equal(emotion.tone, 'recovering');
    assert.equal(emotion.source, 'relationship');
});

test('主动分享只取未见的真实成功事件，私密事件与低电量会按住', () => {
    assert.equal(proactiveShare([event('photo', 'photography_finish')], values(), now)?.readiness, 'share');
    assert.equal(proactiveShare([event('private', 'private_conflict')], values(), now)?.reason, 'too-private');
    assert.equal(proactiveShare([event('photo', 'photography_finish')], values({ energy: 15 }), now)?.reason, 'too-tired');
});

test('审美与观点只从她自己明确说过的话形成，不拿用户偏好冒充', () => {
    const tastes = tasteProfile([
        { role: 'user', content: '我喜欢摇滚' },
        { role: 'assistant', content: '我还是挺喜欢这种光影的，想拍下来' },
        { role: 'assistant', content: '这种构图也挺好看，我喜欢' },
        { role: 'assistant', content: '香菜我不喜欢，不爱吃' },
        { role: 'assistant', content: '我还是不爱吃香菜' },
    ]);
    assert.deepEqual(tastes.map(item => [item.theme, item.leaning]), [['photography', 'like'], ['food', 'dislike']]);
});

test('生活创作只生成待审核意图并绑定真实事件编号', () => {
    const events = [event('photo-1', 'photography_finish')];
    const drafts = creativeDraftIntents(events, { eventKind: 'photography_finish', readiness: 'share', reason: 'worth-sharing' }, now);
    assert.ok(drafts.some(draft => draft.kind === 'photo'));
    assert.ok(drafts.every(draft => draft.sourceEventId === 'photo-1' && draft.requiresReview));
});

test('共同经历只保存类型、计数和时间，不复制私聊正文', () => {
    const experiences = sharedExperiences([
        { role: 'user', content: '下次我们一起去', time: now.toISOString() },
        { role: 'assistant', content: '说好了，不许忘', time: now.toISOString() },
        { role: 'user', content: '这个老梗又来了', time: now.toISOString() },
    ]);
    assert.deepEqual(experiences.map(item => item.kind), ['promise', 'plan', 'inside-joke']);
    assert.ok(experiences.every(item => !('content' in item)));
});

test('失败、打断、恢复和关系修复会形成有证据的反思', () => {
    const events = [event('a', 'study', 2, 'failed'), event('b', 'study', 1), event('c', 'photography', 0, 'interrupted')];
    const relation = relationshipDevelopment(values({ relationship: { intimacy: 70, trust: 65, familiarity: 75, attachment: 70, friction: 45 } }), [{ role: 'user', content: '对不起' }]);
    const lessons = reflectionLessons(events, relation, values({ energy: 20 }));
    for (const kind of ['retry', 'pace', 'rest', 'repair'] as const) assert.ok(lessons.some(item => item.kind === kind));
});

test('十项投影共用同一证据，自检通过，并向 QQ/DSH 只给自然语言和脱敏摘要', () => {
    const events = [event('photo-1', 'photography_finish')];
    const snapshot = developmentSnapshot({
        at: now, values: values(), events,
        history: [
            { role: 'assistant', content: '我挺喜欢这种光影的，想拍下来', time: now.toISOString() },
            { role: 'assistant', content: '这种构图也挺好看，我喜欢', time: now.toISOString() },
        ],
    });
    assert.deepEqual(auditDevelopment(snapshot, events), []);
    assert.match(describeDevelopment(snapshot)!, /生活脉络/);
    assert.doesNotMatch(describeDevelopment(snapshot)!, /亲密\s*\d|信任\s*\d/);
    const summary = developmentSummary(snapshot);
    const safe = sanitizeDshState({ at: now.toISOString(), development: { ...summary, extraSecret: 'no' } as typeof summary });
    assert.deepEqual(safe.development, summary);
    assert.equal('extraSecret' in (safe.development as object), false);
});
