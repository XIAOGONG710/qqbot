import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SlidingWindowRateLimiter } from '../src/rate-limit.ts';

describe('名单外好友限流', () => {
    test('分别限制单个联系人和全部名单外好友，窗口过后恢复', () => {
        const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, perContact: 2, global: 3 });
        assert.deepEqual(limiter.take(1, 0), { allowed: true });
        assert.deepEqual(limiter.take(1, 100), { allowed: true });
        assert.deepEqual(limiter.take(1, 200), { allowed: false, scope: 'contact', retryAfterMs: 800 });
        assert.deepEqual(limiter.take(2, 200), { allowed: true });
        assert.deepEqual(limiter.take(3, 300), { allowed: false, scope: 'global', retryAfterMs: 700 });
        assert.deepEqual(limiter.take(1, 1000), { allowed: true });
    });

    test('被拒绝的消息不占全局额度', () => {
        const limiter = new SlidingWindowRateLimiter({ windowMs: 1000, perContact: 1, global: 2 });
        assert.equal(limiter.take(1, 0).allowed, true);
        assert.equal(limiter.take(1, 10).allowed, false);
        assert.equal(limiter.take(2, 20).allowed, true);
    });
});
