import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askExpired, askLine, CONSENT, takeConsent } from '../src/platform/consent.ts';

// 2026-10-30 用户：「给她拒绝的权利，让她做为人而不是程序」
test('答应：摘掉标记，照常说话', () => {
    const r = takeConsent(`行啊，看吧 ${CONSENT}`);
    assert.equal(r.consent, true);
    assert.equal(r.text, '行啊，看吧');
});

test('拒绝：留下原因，标记不发给用户', () => {
    const r = takeConsent('不给看，换衣服呢。<<拒绝：我在换衣服>>');
    assert.equal(r.consent, false);
    assert.equal(r.refusal, '我在换衣服');
    assert.equal(r.text, '不给看，换衣服呢。');
});

test('没表态：原样返回，不动', () => {
    const r = takeConsent('今天好累啊');
    assert.equal(r.consent, false);
    assert.equal(r.refusal, undefined);
    assert.equal(r.text, '今天好累啊');
});

test('问句写成请求、带分钟数；超过 10 分钟作废', () => {
    const line = askLine('看你的屏幕', 3);
    assert.ok(line.includes('想 看你的屏幕') || line.includes('想看你的屏幕'), line);
    assert.ok(line.includes(CONSENT));
    assert.ok(askExpired(0, 9 * 60_000) === false);
    assert.ok(askExpired(0, 11 * 60_000) === true);
});
