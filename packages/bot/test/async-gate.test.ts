import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { AsyncGate } from '../src/social/async-gate.ts';

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('并发闸门（AsyncGate）', () => {
    test('构造参数必须是 >= 1 的整数', () => {
        assert.throws(() => new AsyncGate(0), /concurrency limit must be a positive integer/);
        assert.throws(() => new AsyncGate(-1), /concurrency limit must be a positive integer/);
        assert.throws(() => new AsyncGate(1.5), /concurrency limit must be a positive integer/);
        assert.throws(() => new AsyncGate(Number.NaN), /concurrency limit must be a positive integer/);
        assert.doesNotThrow(() => new AsyncGate(1));
        assert.doesNotThrow(() => new AsyncGate(3));
    });

    test('run 返回 work 的结果；work 抛错原样传播', async () => {
        const gate = new AsyncGate(1);
        assert.equal(await gate.run(async () => 42), 42);
        await assert.rejects(gate.run(async () => { throw new Error('boom'); }), /boom/);
    });

    test('limit=1 时第二个任务排队，等第一个释放后才开始', async () => {
        const gate = new AsyncGate(1);
        let calls = 0;
        let release = (_value: string) => {};
        const first = gate.run(() => {
            calls++;
            return new Promise<string>(resolve => { release = resolve; });
        });
        await tick();
        assert.equal(calls, 1);

        let secondRan = false;
        const second = gate.run(() => { secondRan = true; calls++; return Promise.resolve('two'); });
        await tick();
        assert.equal(secondRan, false);
        assert.equal(calls, 1);

        release('one');
        assert.equal(await first, 'one');
        assert.equal(await second, 'two');
        assert.equal(secondRan, true);
        assert.equal(calls, 2);
    });

    test('limit=2 时最多两个并发，其余排队', async () => {
        const gate = new AsyncGate(2);
        let active = 0;
        let max = 0;
        const releases: (() => void)[] = [];
        const work = () => new Promise<string>(resolve => {
            active++;
            max = Math.max(max, active);
            releases.push(() => { active--; resolve('ok'); });
        });
        const jobs = Array.from({ length: 4 }, () => gate.run(work));

        await tick();
        assert.equal(max, 2);
        assert.equal(releases.length, 2);
        for (const release of releases.slice(0, 2)) release();

        await tick();
        assert.equal(releases.length, 4);
        for (const release of releases.slice(2, 4)) release();
        assert.deepEqual(await Promise.all(jobs), ['ok', 'ok', 'ok', 'ok']);
        assert.equal(max, 2);
    });

    test('传入已 abort 的 signal：直接拒绝，work 不执行', async () => {
        const gate = new AsyncGate(1);
        const ac = new AbortController();
        ac.abort(new Error('stop'));
        let ran = false;
        await assert.rejects(gate.run(() => { ran = true; return Promise.resolve(1); }, ac.signal), /stop/);
        assert.equal(ran, false);
    });

    test('无 reason 的 abort 拒绝为 AbortError', async () => {
        const gate = new AsyncGate(1);
        const ac = new AbortController();
        ac.abort();
        await assert.rejects(
            gate.run(async () => 1, ac.signal),
            error => error instanceof DOMException && error.name === 'AbortError',
        );
    });

    test('排队中 abort：从队列移除，后续任务补上这个槽位', async () => {
        const gate = new AsyncGate(1);
        let release = (_value: string) => {};
        const first = gate.run(() => new Promise<string>(resolve => { release = resolve; }));
        await tick();

        const ac = new AbortController();
        let secondRan = false;
        const second = gate.run(() => { secondRan = true; return Promise.resolve(2); }, ac.signal);
        await tick();
        assert.equal(secondRan, false);
        ac.abort(new Error('cancelled second'));
        await assert.rejects(second, /cancelled second/);

        let thirdRan = false;
        const third = gate.run(() => { thirdRan = true; return Promise.resolve(3); });
        await tick();
        assert.equal(thirdRan, false);

        release('one');
        assert.equal(await first, 'one');
        assert.equal(await third, 3);
        assert.equal(thirdRan, true);
        assert.equal(secondRan, false);
    });

    test('已经开始的 work 不受之后 abort 影响', async () => {
        const gate = new AsyncGate(1);
        const ac = new AbortController();
        let release = (_value: string) => {};
        const job = gate.run(() => new Promise<string>(resolve => { release = resolve; }), ac.signal);
        await tick();
        ac.abort(new Error('too late'));
        release('done');
        assert.equal(await job, 'done');
    });

    test('排队的 work 抛错时错误照常传出，且不占住槽位', async () => {
        const gate = new AsyncGate(1);
        let release = () => {};
        const first = gate.run(() => new Promise<void>(resolve => { release = resolve; }));
        await tick();
        const second = gate.run(async () => { throw new Error('queued boom'); });
        let thirdRan = false;
        const third = gate.run(() => { thirdRan = true; return Promise.resolve(3); });
        await tick();
        assert.equal(thirdRan, false);

        release();
        assert.equal(await first, undefined);
        await assert.rejects(second, /queued boom/);
        assert.equal(await third, 3);
        assert.equal(thirdRan, true);
    });
});
