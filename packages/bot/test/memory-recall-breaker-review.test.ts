// Hindsight 卡住时的熔断（决定单第 26 条，记忆审查 U1）：每一轮的召回连续 2 次超时，1 分钟内不查（这几轮不带记忆），
// 到点后试一次：还超时再停 1 分钟，有回应就恢复。日志只记状态变化，不带记忆和查询的字。只用假的 Hindsight。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HindsightClient, HindsightError, type HindsightApi, type RecallRequest } from '../src/memory/hindsight.ts';
import { LongTermMemory, RECALL_BREAKER_MS } from '../src/memory/long-term.ts';

const T0 = new Date('2026-10-01T20:00:00').getTime();
const A = { qq: 1, tier: 'boyfriend' };
const SECRET = '我明天下午去医院复查';

function setup() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-memory-breaker-'));
    const logs: string[] = [];
    let clock = T0 + 86_400_000;
    let mode: 'hang' | 'refused' | 'ok' = 'hang';
    let recalls = 0;
    const api: HindsightApi = {
        putBank: async () => {}, retain: async () => {},
        recall: async () => {
            recalls++;
            if (mode === 'hang') throw new HindsightError('记忆服务超时（3000 ms）', undefined, true);
            if (mode === 'refused') throw new HindsightError('记忆服务连不上');
            return [];
        },
        getMentalModel: async () => undefined, createMentalModel: async () => {}, updateMentalModel: async () => {}, refreshMentalModel: async () => 'op-1',
    };
    const memory = new LongTermMemory({ api, dir, bankPrefix: 'linmengyao', recallTimeoutMs: 3000, log: m => logs.push(m), now: () => clock });
    const ask = () => memory.recall(A, [{ role: 'user', content: SECRET, time: new Date(clock).toISOString() }], new Date(clock));
    return {
        memory, logs, ask,
        get recalls() { return recalls; },
        setMode: (next: typeof mode) => { mode = next; },
        advance: (ms: number) => { clock += ms; },
        cleanup: async () => { await memory.stop(); rmSync(dir, { recursive: true, force: true }); },
    };
}

test('连续 2 次超时后 1 分钟内不查；到点试一次还超时再停 1 分钟；有回应就恢复', async () => {
    const t = setup();
    try {
        await t.memory.sync(A, { user: '阿明', char: '林梦瑶' }, [{ time: new Date(T0).toISOString(), role: 'user', content: '在吗', messageId: 1 }]);
        assert.equal(await t.ask(), undefined);
        assert.equal(t.logs.filter(line => line.includes('不查')).length, 0, '超时一次还不停');
        assert.equal(await t.ask(), undefined);
        assert.equal(t.recalls, 2);
        assert.ok(t.logs.some(line => line.includes('记忆服务连续 2 次超时，1 分钟内不查记忆')));

        assert.equal(await t.ask(), undefined, '停着的时候这一轮照常往下走、不带记忆');
        t.advance(RECALL_BREAKER_MS - 1);
        assert.equal(await t.ask(), undefined);
        assert.equal(t.recalls, 2, '1 分钟之内一次都不发');

        t.advance(1);
        assert.equal(await t.ask(), undefined);
        assert.equal(t.recalls, 3, '到点试一次');
        assert.ok(t.logs.some(line => line.includes('记忆服务还是超时，再停 1 分钟不查')));
        assert.equal(await t.ask(), undefined);
        assert.equal(t.recalls, 3, '试的那一次还超时：又停 1 分钟');

        t.advance(RECALL_BREAKER_MS);
        t.setMode('ok');
        await t.ask();
        assert.equal(t.recalls, 4);
        assert.ok(t.logs.some(line => line.includes('记忆服务有回应了，接着查记忆')));
        t.setMode('hang');
        await t.ask();
        await t.ask();
        assert.equal(t.recalls, 6, '恢复以后重新从 0 数');

        const breakerLines = t.logs.filter(line => line.includes('记忆服务') && !line.includes('失败'));
        assert.ok(breakerLines.length >= 3);
        assert.ok(t.logs.every(line => !line.includes(SECRET) && !line.includes('医院')), '日志里没有查询和记忆的字');
    } finally {
        await t.cleanup();
    }
});

test('很快报错（连不上）不算超时，会把连续超时的计数清掉', async () => {
    const t = setup();
    try {
        await t.memory.sync(A, { user: '阿明', char: '林梦瑶' }, [{ time: new Date(T0).toISOString(), role: 'user', content: '在吗', messageId: 1 }]);
        await t.ask();
        t.setMode('refused');
        await t.ask();
        t.setMode('hang');
        await t.ask();
        await t.ask();
        assert.equal(t.recalls, 4, '中间隔了一次连不上：第 3 次超时还不停');
        await t.ask();
        assert.equal(t.recalls, 4);
    } finally {
        await t.cleanup();
    }
});

test('HindsightClient 自己的超时标成 timedOut，别的错误不标', async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = ((_url: string, init?: RequestInit) => new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        })) as typeof fetch;
        const hung = await new HindsightClient('http://127.0.0.1:1', 1000).recall('b', {} as RecallRequest, 20).catch((error: unknown) => error);
        assert.ok(hung instanceof HindsightError && hung.timedOut);
        globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
        const failed = await new HindsightClient('http://127.0.0.1:1', 1000).recall('b', {} as RecallRequest, 20).catch((error: unknown) => error);
        assert.ok(failed instanceof HindsightError && !failed.timedOut);
    } finally {
        globalThis.fetch = original;
    }
});
