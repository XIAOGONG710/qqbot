import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { CACHE_FUTURE_TOLERANCE_MS, cacheAgeMs } from '../src/world/cache-freshness.ts';

describe('现实世界缓存时间', () => {
    const now = Date.parse('2026-11-04T04:00:00+08:00');

    test('正常过去时间返回年龄，少量时钟误差按零处理', () => {
        assert.equal(cacheAgeMs(now - 12_345, now), 12_345);
        assert.equal(cacheAgeMs(now + CACHE_FUTURE_TOLERANCE_MS, now), 0);
    });

    test('坏时间和明显来自未来的缓存失败关闭', () => {
        assert.equal(cacheAgeMs('not-a-date', now), undefined);
        assert.equal(cacheAgeMs(now + CACHE_FUTURE_TOLERANCE_MS + 1, now), undefined);
    });
});
