import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { SENSITIVE_OFF, sensitiveSwitch } from '../src/platform/sensitive.ts';

describe('敏感调试开关（ADR 0070 第 8 项）', () => {
    test('没设、off、乱写都是关；on 一直开；15m / 2h 到点自动关', () => {
        for (const value of [undefined, '', 'off', 'no', 'maybe', '15', 'm']) assert.equal(sensitiveSwitch({ QQBOT_SENSITIVE_LOGS: value }).on(), false, String(value));
        assert.equal(sensitiveSwitch({ QQBOT_SENSITIVE_LOGS: 'on' }).on(), true);
        let now = 1_000_000;
        const quarter = sensitiveSwitch({ QQBOT_SENSITIVE_LOGS: '15m' }, () => now);
        assert.equal(quarter.on(), true);
        assert.ok(quarter.describe().includes('自动关'));
        now += 14 * 60_000;
        assert.equal(quarter.on(), true);
        now += 2 * 60_000;
        assert.equal(quarter.on(), false);
        const hours = sensitiveSwitch({ QQBOT_SENSITIVE_LOGS: '2h' }, () => now);
        now += 119 * 60_000;
        assert.equal(hours.on(), true);
        now += 2 * 60_000;
        assert.equal(hours.on(), false);
        assert.ok(SENSITIVE_OFF.describe().includes('关着'));
    });
});
