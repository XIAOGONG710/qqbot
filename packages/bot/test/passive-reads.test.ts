import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { passiveReads } from '../src/platform/passive-reads.ts';

// 纯后台读（platform/passive-reads.ts）：停的时候一起取消、等已派出去的收完。计时器用假的（手动触发）。
type FakeTimer = { fn: () => void; ms: number | undefined; cancelled: boolean };
function fakeExec() {
    const timers: FakeTimer[] = [];
    return {
        timers,
        exec: {
            after: (fn: () => void, ms?: number) => { const timer: FakeTimer = { fn, ms, cancelled: false }; timers.push(timer); return timer as unknown as ReturnType<typeof setTimeout>; },
            cancel: (timer: ReturnType<typeof setTimeout> | undefined) => { if (timer) (timer as unknown as FakeTimer).cancelled = true; },
        },
    };
}
const deferred = <T>() => { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('纯后台读', () => {
    test('read：没停时原样返回结果、原样抛出 run 的错', async () => {
        const { exec } = fakeExec();
        const reads = passiveReads({ stopped: () => false, exec });
        assert.equal(await reads.read(async () => 42), 42);
        await assert.rejects(reads.read(async () => { throw new Error('读坏了'); }), /读坏了/);
    });

    test('read：停了之后立刻以停的原因失败，run 一次都不调', async () => {
        const { exec } = fakeExec();
        const reads = passiveReads({ stopped: () => false, exec });
        reads.lifetime.abort(new Error('停了'));
        let ran = 0;
        await assert.rejects(reads.read(async () => { ran++; return 1; }), /停了/);
        assert.equal(ran, 0);
    });

    test('read：读到一半停了，不等 run 完就以停的原因失败', async () => {
        const { exec } = fakeExec();
        const reads = passiveReads({ stopped: () => false, exec });
        const slow = deferred<string>();
        const pending = reads.read(() => slow.promise);
        await tick();
        reads.lifetime.abort(new Error('中途停'));
        await assert.rejects(pending, /中途停/);
        slow.resolve('太晚了');
    });

    test('fetch：请求带上停的 signal（和调用方自己的合在一起），其它字段原样透出，读正文也能被停打断', async () => {
        const { exec } = fakeExec();
        const reads = passiveReads({ stopped: () => false, exec });
        const own = new AbortController();
        let seen: AbortSignal | undefined;
        const body = deferred<string>();
        const wrapped = reads.fetch(async (_url, init) => { seen = init.signal; return { ok: true, status: 203, text: () => body.promise }; });
        const response = await wrapped('https://example.invalid/x', { headers: { a: 'b' }, signal: own.signal });
        assert.equal(response.ok, true);
        assert.equal(response.status, 203);
        assert.equal(seen!.aborted, false);
        own.abort();
        assert.equal(seen!.aborted, true, '调用方自己的 signal 也连着');

        const second = await wrapped('https://example.invalid/y', { headers: {}, signal: new AbortController().signal });
        const text = second.text();
        await tick();
        reads.stop();
        await assert.rejects(text, (error: unknown) => error instanceof Error && error.name === 'AbortError');
        assert.equal(seen!.aborted, true, '停的 signal 也传到了请求');
        body.resolve('迟到的正文');
    });

    test('fetch：没停时 text 正常返回', async () => {
        const { exec } = fakeExec();
        const reads = passiveReads({ stopped: () => false, exec });
        const wrapped = reads.fetch(async () => ({ ok: true, status: 200, text: async () => '正文' }));
        assert.equal(await (await wrapped('u', { headers: {}, signal: new AbortController().signal })).text(), '正文');
    });

    test('sleep：经执行器的计时器等，到点才好；停了取消计时器并失败；已经停了就不开计时器', async () => {
        const { exec, timers } = fakeExec();
        const reads = passiveReads({ stopped: () => false, exec });
        let done = false;
        const nap = reads.sleep(5000).then(() => { done = true; });
        assert.equal(timers.length, 1);
        assert.equal(timers[0]!.ms, 5000);
        await tick();
        assert.equal(done, false);
        timers[0]!.fn();
        await nap;
        assert.equal(done, true);

        const interrupted = reads.sleep(1000);
        reads.lifetime.abort(new Error('停'));
        await assert.rejects(interrupted, /停/);
        assert.equal(timers[1]!.cancelled, true);

        await assert.rejects(reads.sleep(10), /停/);
        assert.equal(timers.length, 2, '已经停了就不开新计时器');
    });

    test('own：做完（成也好败也好）都调 done；stop 等已派出去的收完', async () => {
        const { exec } = fakeExec();
        const reads = passiveReads({ stopped: () => false, exec });
        const work = deferred<void>();
        const events: string[] = [];
        const task = reads.own(() => { events.push('work'); return work.promise; }, () => events.push('done'));
        await tick();
        assert.deepEqual(events, ['work']);
        const drain = reads.stop();
        assert.ok(drain, '有在跑的活时 stop 返回等待用的 promise');
        assert.equal(reads.stop(), drain, '再停一次返回同一个');
        let drained = false;
        void drain!.then(() => { drained = true; });
        await tick();
        assert.equal(drained, false, '活还没完就不算停完');
        work.reject(new Error('活失败了'));
        await assert.rejects(task, /活失败了/);
        await drain;
        assert.deepEqual(events, ['work', 'done']);
    });

    test('own：已经停了（App 停了或这条链停了）就不做，只调 done', async () => {
        const { exec } = fakeExec();
        for (const reads of [passiveReads({ stopped: () => true, exec }), (() => { const r = passiveReads({ stopped: () => false, exec }); r.stop(); return r; })()]) {
            let ran = 0, done = 0;
            await reads.own(async () => { ran++; }, () => { done++; });
            assert.equal(ran, 0);
            assert.equal(done, 1);
        }
    });

    test('own：登记之后、开始之前停了，也不做', async () => {
        const { exec } = fakeExec();
        let stopped = false;
        const reads = passiveReads({ stopped: () => stopped, exec });
        let ran = 0, done = 0;
        const task = reads.own(async () => { ran++; }, () => { done++; });
        stopped = true;
        await task;
        assert.equal(ran, 0);
        assert.equal(done, 1);
    });

    test('stop：没活时返回 undefined；signal 变成已取消', () => {
        const { exec } = fakeExec();
        const reads = passiveReads({ stopped: () => false, exec });
        assert.equal(reads.stop(), undefined);
        assert.equal(reads.lifetime.signal.aborted, true);
        assert.equal(reads.stop(), undefined);
    });
});
