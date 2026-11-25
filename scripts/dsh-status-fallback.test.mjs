import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createController } from '../dsh-plugins/dsh-qqbot-services/controller.js';
import { failedStatus, PROBE_PORTS } from '../dsh-plugins/dsh-qqbot-services/status-fallback.js';

test('a failed probe still yields a status the controller accepts', async () => {
    const controller = createController({
        probe: () => Promise.reject(new Error('spawn DeepSeek Harness.exe ENOENT')),
        launch: () => Promise.resolve(),
        sleep: () => Promise.resolve(),
        now: () => 1,
    });
    const fallback = failedStatus(new Error('spawn DeepSeek Harness.exe ENOENT'));
    assert.equal(typeof fallback.probeFailed, 'string');
    assert.match(fallback.probeFailed, /ENOENT/);
    for (const key of ['napcat', 'hindsight', 'koishi', 'koishiListening', 'watchdog', 'maintenance']) {
        assert.equal(typeof fallback[key], 'boolean', key);
    }
    assert.deepEqual(fallback.ports, PROBE_PORTS);
    assert.deepEqual(fallback.launchers, {});

    const state = await createController({
        probe: () => Promise.resolve(fallback),
        launch: () => Promise.resolve(),
        sleep: () => Promise.resolve(),
        now: () => 1,
    }).state();
    assert.equal(state.health.probeFailed, fallback.probeFailed);
    assert.equal(state.health.napcat, false);

    await assert.rejects(() => controller.state(), /ENOENT/);
});

test('an empty failure still carries a readable reason', () => {
    const fallback = failedStatus(undefined);
    assert.equal(typeof fallback.probeFailed, 'string');
    assert.ok(fallback.probeFailed.length > 0);
    assert.equal(fallback.probeFailed.length <= 200, true);
});
