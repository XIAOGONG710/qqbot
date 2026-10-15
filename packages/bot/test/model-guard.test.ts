import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { chatCompletion, ModelUnreachable, type Fetch } from '../src/llm.ts';
import { GuardRejected, ModelGuard } from '../src/model-guard.ts';

const tick = () => new Promise(resolve => setTimeout(resolve, 5));
const gate = () => {
    let open!: () => void;
    const wait = new Promise<void>(resolve => { open = resolve; });
    return { wait, open };
};

describe('模型调用总闸（ADR 0070 第 7 项）', () => {
    test('已取消请求不入队；排队取消会移除等待者；拿到位置后取消也不启动工作', async () => {
        const guard = new ModelGuard({ concurrent: 1, backgroundConcurrent: 1 });
        const stopped = AbortSignal.abort(new Error('cancelled'));
        await assert.rejects(guard.run('chat', async () => assert.fail('不能启动'), undefined, stopped), /cancelled/);
        assert.equal(guard.status().callsToday, 0);
        const hold = gate();
        const first = guard.run('chat', () => hold.wait);
        const controller = new AbortController();
        const queued = guard.run('background', async () => assert.fail('不能启动'), undefined, controller.signal);
        assert.equal(guard.status().waiting, 1);
        controller.abort(new Error('queued cancelled'));
        await assert.rejects(queued, /queued cancelled/);
        assert.equal(guard.status().waiting, 0);
        hold.open(); await first;
        const racing = new AbortController();
        const job = guard.run('chat', async () => assert.fail('不能启动'), undefined, racing.signal);
        racing.abort(new Error('cancelled before work'));
        await assert.rejects(job, /cancelled before work/);
        assert.equal(guard.status().active, 0);
    });

    test('并发有上限，后台任务最多占自己那份；空出来的位置聊天先拿', async () => {
        const guard = new ModelGuard({ concurrent: 3, backgroundConcurrent: 1 });
        const started: string[] = [];
        const hold = gate();
        const call = (name: string, purpose: 'chat' | 'background') => guard.run(purpose, async () => { started.push(name); await hold.wait; });
        const jobs = [call('b1', 'background'), call('b2', 'background'), call('c1', 'chat'), call('c2', 'chat'), call('c3', 'chat')];
        await tick();
        // 3 个位置：b1（后台那一份）、c1、c2；b2 超过后台的份额，c3 没有位置
        assert.deepEqual(started, ['b1', 'c1', 'c2']);
        assert.equal(guard.status().waiting, 2);
        hold.open();
        await Promise.all(jobs);
        assert.deepEqual(started, ['b1', 'c1', 'c2', 'c3', 'b2'], '空位先给排队的聊天，再给后台');
    });

    test('排队太久就拒绝；被拒绝的不占位置', async () => {
        const guard = new ModelGuard({ concurrent: 1, backgroundConcurrent: 1, chatWaitMs: 20 });
        const hold = gate();
        const first = guard.run('chat', () => hold.wait);
        await tick();
        await assert.rejects(() => guard.run('chat', async () => 'x'), (error: unknown) => error instanceof GuardRejected && error.reason === 'queue');
        hold.open();
        await first;
        assert.equal(await guard.run('chat', async () => 'ok'), 'ok');
    });

    test('每日额度：后台到上限就不放行，聊天到 1.5 倍才拒绝；第二天恢复', async () => {
        let now = new Date(2026, 9, 13, 10, 0).getTime();
        const logs: string[] = [];
        const guard = new ModelGuard({ dailyCalls: 4, hardMultiplier: 1.5, now: () => now, log: message => logs.push(message) });
        for (let i = 0; i < 4; i++) await guard.run('background', async () => i);
        await assert.rejects(() => guard.run('background', async () => 1), (error: unknown) => error instanceof GuardRejected && error.reason === 'budget');
        await guard.run('chat', async () => 1);
        await guard.run('chat', async () => 1);
        await assert.rejects(() => guard.run('chat', async () => 1), (error: unknown) => error instanceof GuardRejected && error.reason === 'budget');
        assert.equal(logs.filter(line => line.includes('模型额度')).length >= 2, true);
        now += 24 * 60 * 60_000;
        assert.equal(await guard.run('background', async () => 'next day'), 'next day');
        assert.equal(guard.status().callsToday, 1);
    });

    test('连续没连上就熔断：后台直接拒绝，聊天一次只放一个探路的，连上一次就恢复', async () => {
        let now = 1_000_000;
        const guard = new ModelGuard({ breakerFailures: 3, breakerOpenMs: 10_000, now: () => now });
        const unreachable = (error: unknown) => error instanceof ModelUnreachable;
        for (let i = 0; i < 3; i++) await assert.rejects(() => guard.run('chat', async () => { throw new ModelUnreachable('down'); }, unreachable));
        assert.equal(guard.status().breakerOpen, true);
        await assert.rejects(() => guard.run('background', async () => 1), (error: unknown) => error instanceof GuardRejected && error.reason === 'breaker');
        const hold = gate();
        const probe = guard.run('chat', async () => { await hold.wait; return 'up'; }, unreachable);
        await tick();
        await assert.rejects(() => guard.run('chat', async () => 'second'), (error: unknown) => error instanceof GuardRejected && error.reason === 'breaker');
        hold.open();
        assert.equal(await probe, 'up');
        assert.equal(guard.status().breakerOpen, false);
        assert.equal(await guard.run('background', async () => 'back'), 'back');
    });

    test('熔断时间过了以后后台任务也能当探路的；其他错误（比如 HTTP 400）不算没连上', async () => {
        let now = 5_000_000;
        const guard = new ModelGuard({ breakerFailures: 2, breakerOpenMs: 1000, now: () => now });
        const unreachable = (error: unknown) => error instanceof ModelUnreachable;
        for (let i = 0; i < 2; i++) await assert.rejects(() => guard.run('chat', async () => { throw new ModelUnreachable('down'); }, unreachable));
        now += 1500;
        assert.equal(await guard.run('background', async () => 'probe'), 'probe');
        for (let i = 0; i < 5; i++) await assert.rejects(() => guard.run('chat', async () => { throw new Error('HTTP 400'); }, unreachable), /400/);
        assert.equal(guard.status().breakerOpen, false);
    });

    test('chatCompletion 走总闸：被挡住时换成 ModelUnreachable（后台任务等好了再来）；没被挡住照旧', async () => {
        const options = { baseUrl: 'https://llm.invalid', model: 'm', apiKey: 'k', temperature: 0.5, maxTokens: 10, timeoutMs: 1000, extraBody: {} };
        const reply: Fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '嗯' } }] }) });
        const closed = new ModelGuard({ dailyCalls: 1 });
        assert.equal(await chatCompletion(options, [], { fetch: reply, guard: closed, purpose: 'background' }), '嗯');
        await assert.rejects(
            () => chatCompletion(options, [], { fetch: reply, guard: closed, purpose: 'background' }),
            (error: unknown) => error instanceof ModelUnreachable && /额度/.test(error.message),
        );
        assert.equal(await chatCompletion(options, [], { fetch: reply, guard: closed }), '嗯', '聊天还没到 1.5 倍');
    });
});
