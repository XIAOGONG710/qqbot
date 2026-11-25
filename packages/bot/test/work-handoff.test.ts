import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { WORK_FAILED_LINE, workHandoff, type WorkHandoffDeps } from '../src/platform/work-handoff.ts';

// 把活交给 dsh、干完发回去（ADR 0336 第 6 步把 app.ts 里的两份合成一份时补的测试：没干成那条路原来没有测试）
const NOW = new Date('2026-11-19T12:00:00.000Z');
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

function setup(run: WorkHandoffDeps['runWork']) {
    const sent: { qq: number; text: string }[] = [];
    const appended: { qq: number; message: Record<string, unknown> }[] = [];
    const logs: string[] = [];
    const remembered: string[] = [];
    globalThis.fetch = (async (url: string | URL) => { remembered.push(String(url)); return new Response('{}'); }) as typeof fetch;
    let nextId = 500;
    const history = {
        load: () => [
            { time: NOW.toISOString(), role: 'user', content: '帮我看下日志' },
            { time: NOW.toISOString(), role: 'assistant', content: '好' },
        ],
        append: (qq: number, message: Record<string, unknown>) => { appended.push({ qq, message }); },
    } as unknown as WorkHandoffDeps['history'];
    const work = workHandoff({
        runWork: run,
        transport: { sendPrivateText: async (qq: number, text: string) => { sent.push({ qq, text }); return nextId++; } } as WorkHandoffDeps['transport'],
        history,
        clockNow: () => NOW,
        log: message => { logs.push(message); },
    });
    return { work, sent, appended, logs, remembered };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

describe('交给 dsh 干活', () => {
    test('干完：结果发回去、进聊天记录，不带近期私聊也不把回复当事实入长期记忆', async () => {
        const contexts: (string | undefined)[] = [];
        const { work, sent, appended, logs, remembered } = setup(async (_task, options) => { contexts.push(options?.context); return '看完了，没报错'; });
        work.handOff(1001, '看日志', '工作桥出错');
        for (let i = 0; i < 5; i++) await settle();
        assert.deepEqual(contexts, [undefined]);
        assert.deepEqual(sent, [{ qq: 1001, text: '看完了，没报错' }]);
        assert.deepEqual(appended, [{ qq: 1001, message: { time: NOW.toISOString(), role: 'assistant', content: '看完了，没报错', messageId: 500 } }]);
        assert.deepEqual(remembered, []);
        assert.deepEqual(logs, []);
    });

    test('没干成：日志记标签和原因，回他一句，这句也进聊天记录', async () => {
        const { work, sent, appended, logs, remembered } = setup(async () => { throw new Error('dsh 没起来'); });
        work.handOff(1001, '看日志', '她判断要动电脑、没干成');
        for (let i = 0; i < 5; i++) await settle();
        assert.deepEqual(logs, ['[1001] 她判断要动电脑、没干成：dsh 没起来']);
        assert.deepEqual(sent, [{ qq: 1001, text: WORK_FAILED_LINE }]);
        assert.deepEqual(appended, [{ qq: 1001, message: { time: NOW.toISOString(), role: 'assistant', content: WORK_FAILED_LINE, messageId: 500 } }]);
        assert.deepEqual(remembered, []);
    });
});
