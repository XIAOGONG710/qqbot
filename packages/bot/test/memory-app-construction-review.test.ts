import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { startApp, MEMORY_SYNC_MS } from '../src/platform/app.ts';
import { parseAppConfig } from '../src/platform/config.ts';
import { acquireLock } from '../src/platform/lock.ts';
import { LongTermMemory } from '../src/memory/long-term.ts';
import { fileOps } from '../src/memory/json-file.ts';

test('真实App在memoryTimer之后构造EIO失败：释放租约之前关闭已建owner和timer', async () => {
    const root = mkdtempSync(join(tmpdir(), 'qqbot-app-construction-')), dataDir = join(root, 'data'); mkdirSync(dataDir);
    const originalFetch = globalThis.fetch, originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
    const originalRead = fileOps.readFileSync, originalDelays = fileOps.readDelaysMs, originalBank = LongTermMemory.prototype.commonBankId;
    const timers: { timer: ReturnType<typeof setInterval>; name: string; ms: number; cleared: boolean }[] = [];
    let memory: LongTermMemory | undefined, failedReads = 0, networkCalls = 0;
    try {
        for (const tier of ['classmate', 'classmate-open']) writeFileSync(join(root, `synthetic-${tier}.json`), JSON.stringify({ spec: 'chara_card_v2', data: { name: '合成角色' } }));
        const config = parseAppConfig({ llm: { baseUrl: 'http://synthetic.invalid', model: 'synthetic' }, characterCard: join(root, 'synthetic-{tier}.json'), dataDir,
            contacts: [{ qq: 10001, tier: 'classmate', name: '合成联系人' }], memory: { baseUrl: 'http://synthetic.invalid', bankPrefix: 'synthetic-construction', timeoutMs: 100, recallTimeoutMs: 100 },
            contextTurns: 1, schedule: false, moody: false, speechCheck: false, herDays: false, realWeather: false, proactive: 'off', media: false }, root, { QQBOT_LLM_API_KEY: 'synthetic-key' });
        globalThis.fetch = async () => { networkCalls++; throw new Error('Network prohibited in synthetic construction fixture'); };
        globalThis.setInterval = ((callback: (...args: unknown[]) => void, ms: number, ...args: unknown[]) => {
            const timer = originalSet(callback, ms, ...args); timers.push({ timer, name: callback.name, ms, cleared: false }); return timer;
        }) as typeof setInterval;
        globalThis.clearInterval = ((timer: Parameters<typeof clearInterval>[0]) => {
            const found = timers.find(entry => entry.timer === timer); if (found) found.cleared = true; originalClear(timer);
        }) as typeof clearInterval;
        LongTermMemory.prototype.commonBankId = function () { memory = this; return originalBank.call(this); };
        fileOps.readDelaysMs = [0];
        fileOps.readFileSync = ((path: Parameters<typeof originalRead>[0], ...args: unknown[]) => {
            if (String(path).replaceAll('\\', '/').endsWith('/context/10001.json')) { failedReads++; throw Object.assign(new Error('synthetic context EIO'), { code: 'EIO' }); }
            return Reflect.apply(originalRead, fileOps, [path, ...args]);
        }) as typeof originalRead;
        assert.throws(() => startApp({ config, transport: { friendHistory: async () => [], sendPrivateText: async () => 1 }, log() {}, sensitive: { on: () => false, describe: () => '' },
            pipeline: { generate: async () => { assert.fail('No model dispatch in construction fixture'); } } }), /EIO/);
        assert.equal(failedReads, 1); assert.ok(memory);
        const timer = timers.find(entry => entry.ms === MEMORY_SYNC_MS && entry.name === 'syncMemory'); assert.ok(timer);
        const released = !existsSync(join(dataDir, 'bot.lock')); assert.equal(released, true);
        const release = acquireLock(join(dataDir, 'bot.lock')); release();
        assert.deepEqual({ directoryLeaseReleased: released, memoryTimerCleared: timer.cleared, memoryDispatchClosed: !memory.derivedAvailable(), networkCalls },
            { directoryLeaseReleased: true, memoryTimerCleared: true, memoryDispatchClosed: true, networkCalls: 0 });
    } finally {
        for (const { timer } of timers) originalClear(timer); await memory?.stop();
        globalThis.fetch = originalFetch; globalThis.setInterval = originalSet; globalThis.clearInterval = originalClear;
        fileOps.readFileSync = originalRead; fileOps.readDelaysMs = originalDelays; LongTermMemory.prototype.commonBankId = originalBank;
        assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('qqbot-app-construction-')); rmSync(root, { recursive: true, force: true });
    }
});
