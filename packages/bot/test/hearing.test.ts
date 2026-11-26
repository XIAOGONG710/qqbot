import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createHearing } from '../src/vision/hearing.ts';

describe('真正听到声音的接口（hearing）', () => {
    test('createHearing 现在没有实现，返回 undefined', () => {
        assert.equal(createHearing(), undefined);
    });

    test('重复调用结果一致，不抛错', () => {
        assert.doesNotThrow(() => createHearing());
        assert.equal(createHearing(), createHearing());
        assert.equal(typeof createHearing(), 'undefined');
    });
});
