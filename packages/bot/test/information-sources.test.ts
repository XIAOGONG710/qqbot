import assert from 'node:assert/strict';
import { test } from 'node:test';
import { informationObservationEvent } from '../src/world/information-sources.ts';

test('大新闻和校园小信息保留范围、权威性和有效期，但不携带原文或账号', () => {
    const at = new Date('2026-11-17T10:00:00.000Z');
    const global = informationObservationEvent({ sourceId: 'news-app', scope: 'global', authority: 'editorial', occurredAt: at, validUntil: new Date(at.getTime() + 3_600_000), topic: '合成科技新闻', confidence: 0.8 }, at);
    const campus = informationObservationEvent({ sourceId: 'campus-wall', scope: 'campus', authority: 'community', occurredAt: at, validUntil: new Date(at.getTime() + 3_600_000), topic: '合成校园活动', confidence: 0.55 }, at);
    assert.equal(global?.kind, 'society.news.observed');
    assert.equal(campus?.kind, 'campus.information.observed');
    assert.deepEqual(campus?.subjects, ['self', 'space:campus']);
    assert.doesNotMatch(JSON.stringify([global, campus]), /cookie|token|https?:\/\//i);
});

test('来源、主题、时间或可信度不安全时拒绝进入世界', () => {
    const at = new Date('2026-11-17T10:00:00.000Z');
    const base = { sourceId: 'campus-wall', scope: 'campus' as const, authority: 'community' as const, occurredAt: at, validUntil: at, topic: '合成校园活动', confidence: 0.5 };
    assert.equal(informationObservationEvent({ ...base, sourceId: '../bad' }, at), undefined);
    assert.equal(informationObservationEvent({ ...base, topic: ' 带空格的主题' }, at), undefined);
    assert.equal(informationObservationEvent({ ...base, topic: '带换行\n的主题' }, at), undefined);
    assert.equal(informationObservationEvent({ ...base, topic: 'x'.repeat(81) }, at), undefined);
    assert.equal(informationObservationEvent({ ...base, validUntil: new Date(at.getTime() - 1) }, at), undefined);
});
