import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createExecutor, type Action } from '../src/executor/executor.ts';
import type { Transport } from '../src/platform/app.ts';
import type { AppConfig } from '../src/platform/config.ts';

const LLM: AppConfig['llm'] = { baseUrl: 'http://127.0.0.1:9', model: 'chat', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: '', extraBody: {} };

function fakeTransport(calls: string[]): Transport {
    return {
        sendPrivateText: async (userId, text, replyTo) => { calls.push(`text ${userId} ${text} ${replyTo ?? '-'}`); return 7; },
        friendHistory: async () => [],
        markRead: async userId => { calls.push(`read ${userId}`); },
    };
}

describe('执行器（ADR 0336）', () => {
    test('QQ 外观和 Transport 同形状：有的方法都在，底层没有的可选方法也没有', () => {
        const exec = createExecutor({ transport: fakeTransport([]) });
        assert.equal(typeof exec.qq.sendPrivateText, 'function');
        assert.equal(typeof exec.qq.markRead, 'function');
        assert.equal(exec.qq.pokeFriend, undefined);
        assert.equal(exec.qq.sendPrivateImage, undefined);
    });

    test('QQ 动作原样返回底层的 promise、带上 this，进行中有登记，结束后去掉', async () => {
        const calls: string[] = [];
        const seen: Action[] = [];
        let resolve!: (id: number) => void;
        const pending = new Promise<number>(r => { resolve = r; });
        const transport = {
            self: 'napcat',
            sendPrivateText(this: { self: string }, userId: number, text: string) { calls.push(`${this.self} ${userId} ${text}`); return pending; },
            friendHistory: async () => [],
        } as unknown as Transport;
        const exec = createExecutor({ transport, observe: action => seen.push(action) });
        const result = exec.qq.sendPrivateText(1, '在吗');
        assert.equal(result, pending, '同一个 promise');
        assert.deepEqual(calls, ['napcat 1 在吗']);
        assert.deepEqual(seen, [{ kind: 'qq', method: 'sendPrivateText', args: [1, '在吗'] }]);
        assert.equal(exec.inFlight, 1);
        resolve(9);
        assert.equal(await result, 9);
        await Promise.resolve();
        assert.equal(exec.inFlight, 0);
    });

    test('底层同步抛错时同步抛出；观察者出错不影响执行', () => {
        const transport = { sendPrivateText() { throw new Error('断开了'); }, friendHistory: async () => [] } as unknown as Transport;
        const exec = createExecutor({ transport, observe: () => { throw new Error('观察者坏了'); } });
        assert.throws(() => exec.qq.sendPrivateText(1, 'x'), /断开了/);
        assert.throws(() => exec.run({ kind: 'qq', method: 'pokeFriend', args: [1] }), /没有 pokeFriend/);
    });

    test('模型调用：有替身时按原来的参数调替身（换模型时才带第三个参数），没有时调真的', async () => {
        const got: unknown[][] = [];
        const log = () => {};
        const exec = createExecutor({ transport: fakeTransport([]), generate: async (...args) => { got.push(args); return '好'; } });
        assert.equal(await exec.llm({ purpose: 'background', config: LLM, messages: [{ role: 'user', content: 'a' }] }, log), '好');
        const deep = { ...LLM, model: 'deep' };
        await exec.llm({ purpose: 'chat', config: deep, use: deep, messages: [{ role: 'user', content: 'b' }] }, log);
        assert.deepEqual(got, [[[{ role: 'user', content: 'a' }], log, undefined], [[{ role: 'user', content: 'b' }], log, deep]]);

        const real: unknown[][] = [];
        const signal = new AbortController().signal;
        const live = createExecutor({ transport: fakeTransport([]), complete: async (...args) => { real.push(args); return '真'; } });
        assert.equal(await live.llm({ purpose: 'background', config: LLM, messages: [], signal }, log), '真');
        assert.deepEqual(real, [[LLM, [], { log, purpose: 'background', signal }]]);
    });

    test('计时器：after 原样交给 setTimeout，every 登记、cancel 去掉；时钟可换', async () => {
        const exec = createExecutor({ transport: fakeTransport([]), now: () => 42 });
        assert.equal(exec.now(), 42);
        let fired = 0;
        exec.after(() => { fired++; }, 0);
        const never = exec.after(() => { fired += 10; }, 60_000);
        const every = exec.every(() => { fired += 100; }, 60_000);
        assert.equal(exec.timers, 1);
        await new Promise(r => setTimeout(r, 5));
        assert.equal(fired, 1);
        exec.cancel(never);
        exec.cancel(every);
        exec.cancel(undefined);
        assert.equal(exec.timers, 0);
    });

    test('设备登记（ADR 0336「生成之后那一段」第 8 步）：同步交给登记时现取的设备控制；没有设备控制就什么都不做', () => {
        const parsed = { reply: '好呀', proposals: [{ action: 'ring', targets: [], params: {} }], rejected: [] };
        const committed: unknown[] = [];
        const seen: Action[] = [];
        let control: { commit: (p: typeof parsed) => void } | undefined;
        const exec = createExecutor({ transport: fakeTransport([]), observe: action => seen.push(action), devices: () => control });
        assert.equal(exec.run({ kind: 'device', parsed }), undefined, '还没起来：不做');
        control = { commit: p => { committed.push(p); } };
        exec.run({ kind: 'device', parsed });
        assert.deepEqual(committed, [parsed]);
        assert.deepEqual(seen, [{ kind: 'device', parsed }, { kind: 'device', parsed }]);
        control = { commit: () => { throw new Error('登记失败'); } };
        assert.throws(() => exec.run({ kind: 'device', parsed }), /登记失败/, '同步抛错，和原来直接调一样');
        assert.doesNotThrow(() => createExecutor({ transport: fakeTransport([]) }).run({ kind: 'device', parsed }));
    });
});
