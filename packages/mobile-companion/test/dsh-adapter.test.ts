import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDshCompanionHandlers, type DshCompanionRequest, type DshConversationTurn, type DshSharedConversation } from '../src/dsh-adapter.ts';
import type { ActionResult, CompanionMessage, MediaRef, PhoneActionRequest } from '../src/protocol.ts';

const advisor = { advise: async () => '答复' };

const textMessage = (text: string): CompanionMessage => ({ kind: 'text', text });
const action: PhoneActionRequest = { action: 'notify', params: { text: '提醒' }, decision: 'auto' };

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(r => { resolve = r; });
    return { promise, resolve };
}

test('构造参数校验：上下文长度和设备上限越界或非整数都拒绝', () => {
    for (const maxTurns of [1, 41, 1.5, Number.NaN]) {
        assert.throws(() => createDshCompanionHandlers({ advisor, maxTurns }), /上下文长度不合法/);
    }
    for (const maxClients of [0, 1025, 1.5, Number.NaN]) {
        assert.throws(() => createDshCompanionHandlers({ advisor, maxClients }), /设备上下文上限不合法/);
    }
    assert.doesNotThrow(() => createDshCompanionHandlers({ advisor, maxTurns: 2, maxClients: 1 }));
    assert.doesNotThrow(() => createDshCompanionHandlers({ advisor, maxTurns: 40, maxClients: 1024 }));
});

test('文字消息映射：问题去空白，state / voice / media 按设备传入，回复去空白', async () => {
    const seen: DshCompanionRequest[] = [];
    const handlers = createDshCompanionHandlers({
        advisor: { advise: async request => { seen.push(request); return `  答：${request.question}  `; } },
        state: clientId => ({ name: `状态-${clientId}` }),
        voice: clientId => ({ tone: clientId }),
    });
    const media: MediaRef = { mediaId: 'media-1', mime: 'image/png', bytes: 12 };
    assert.deepEqual(await handlers.onMessage({ kind: 'image', text: '  看图  ', media }, 'android-a'), { kind: 'text', text: '答：看图' });
    assert.equal(seen[0]?.question, '看图');
    assert.deepEqual(seen[0]?.state, { name: '状态-android-a' });
    assert.deepEqual(seen[0]?.voice, { tone: 'android-a' });
    assert.deepEqual(seen[0]?.media, media);
    assert.equal('recentTurns' in seen[0]!, false, '首轮没有历史时不传 recentTurns');
});

test('模型空回复时被兜底文案替换', async () => {
    const handlers = createDshCompanionHandlers({ advisor: { advise: async () => '  \n  ' } });
    assert.deepEqual(await handlers.onMessage(textMessage('你还在吗'), 'android-a'), {
        kind: 'text', text: '我刚才没整理好，你再问我一次。',
    });
});

test('无文字消息：有 describeMedia 取摘要并截到 4000 字，没有则用占位问题', async () => {
    const asked: string[] = [];
    const media: MediaRef = { url: 'https://example.invalid/a.png', mime: 'image/png', bytes: 10 };
    const handlers = createDshCompanionHandlers({
        advisor: { advise: async request => { asked.push(request.question); return '看到了'; } },
        describeMedia: async (message, clientId) => {
            assert.equal(message.kind, 'image');
            assert.equal(clientId, 'android-b');
            return `  图：${'图'.repeat(5000)}  `;
        },
    });
    assert.deepEqual(await handlers.onMessage({ kind: 'image', text: '   ', media }, 'android-b'), { kind: 'text', text: '看到了' });
    assert.equal(asked[0], `图：${'图'.repeat(3998)}`);
    assert.equal(asked[0]?.length, 4000);
    assert.equal(asked[0]?.includes(' '), false, '摘要首尾空白已去掉');

    const plainAsked: string[] = [];
    const plain = createDshCompanionHandlers({ advisor: { advise: async request => { plainAsked.push(request.question); return '好'; } } });
    await plain.onMessage({ kind: 'audio', media: { mediaId: 'm2', mime: 'audio/ogg', bytes: 8 } }, 'android-c');
    assert.deepEqual(plainAsked, ['[收到audio消息]']);
});

test('本地上下文按 maxTurns 滚动，最近对话才作为 recentTurns 交给模型', async () => {
    const seen: (readonly DshConversationTurn[] | undefined)[] = [];
    let n = 0;
    const handlers = createDshCompanionHandlers({
        advisor: { advise: async request => { seen.push(request.recentTurns); return `答${++n}`; } },
        maxTurns: 2,
    });
    await handlers.onMessage(textMessage('第一句'), 'c1');
    await handlers.onMessage(textMessage('第二句'), 'c1');
    await handlers.onMessage(textMessage('第三句'), 'c1');
    assert.deepEqual(seen, [
        undefined,
        [{ role: 'user', content: '第一句' }, { role: 'assistant', content: '答1' }],
        [{ role: 'user', content: '第二句' }, { role: 'assistant', content: '答2' }],
    ]);
});

test('recentTurns 最多给 6 条，即使 maxTurns 设得更大', async () => {
    const seen: (readonly DshConversationTurn[] | undefined)[] = [];
    const handlers = createDshCompanionHandlers({
        advisor: { advise: async request => { seen.push(request.recentTurns); return '好'; } },
        maxTurns: 12,
    });
    for (let i = 1; i <= 8; i++) await handlers.onMessage(textMessage(`第${i}句`), 'c1');
    assert.equal(seen[7]?.length, 6);
    assert.deepEqual(seen[7]?.map(turn => turn.content), ['第5句', '好', '第6句', '好', '第7句', '好']);
});

test('共享上下文：用 recent 取代本地历史，只在成功轮提交 question / reply / 两个时间戳', async () => {
    const committed: { clientId: string; question: string; reply: string; askedAt: number; repliedAt: number }[] = [];
    let received: readonly DshConversationTurn[] | undefined;
    const sharedConversation: DshSharedConversation = {
        recent: clientId => {
            assert.equal(clientId, 'c1');
            return [{ role: 'user', content: '上一句共享' }];
        },
        commit: (clientId, question, reply, askedAt, repliedAt) => {
            committed.push({ clientId, question, reply, askedAt, repliedAt });
        },
    };
    let clock = 1000;
    const handlers = createDshCompanionHandlers({
        advisor: { advise: async request => { received = request.recentTurns; return '共享答复'; } },
        sharedConversation,
        now: () => clock++,
    });
    assert.deepEqual(await handlers.onMessage(textMessage('  新问题  '), 'c1'), { kind: 'text', text: '共享答复' });
    assert.deepEqual(received, [{ role: 'user', content: '上一句共享' }]);
    assert.deepEqual(committed, [{ clientId: 'c1', question: '新问题', reply: '共享答复', askedAt: 1000, repliedAt: 1001 }]);
});

test('设备动作：没有宿主回调一律拒绝，有回调则原样委托并带回结果', async () => {
    const fallback = createDshCompanionHandlers({ advisor });
    assert.deepEqual(await fallback.onAction(action, 'c1', 'req-1'), {
        requestId: 'req-1', ok: false, decision: 'deny', error: '手机动作需要宿主设备策略确认',
    });

    const calls: unknown[][] = [];
    const delegated = createDshCompanionHandlers({
        advisor,
        onAction: async (request, clientId, requestId) => {
            calls.push([request, clientId, requestId]);
            return { requestId, ok: true, decision: 'auto' };
        },
    });
    const result: ActionResult = await delegated.onAction(action, 'c2', 'req-2');
    assert.deepEqual(result, { requestId: 'req-2', ok: true, decision: 'auto' });
    assert.deepEqual(calls, [[action, 'c2', 'req-2']]);
});

test('配对撤销发生在模型等待期间：迟到结果不提交上下文，也不回给旧设备', async () => {
    const pending = deferred<string>();
    const committed: string[] = [];
    const handlers = createDshCompanionHandlers({
        advisor: { advise: () => pending.promise },
        sharedConversation: { recent: () => [], commit: (_clientId, question) => { committed.push(question); } },
    });
    const inFlight = handlers.onMessage(textMessage('待回答'), 'c1');
    handlers.onReset!('c1');
    pending.resolve('迟到的答复');
    assert.deepEqual(await inFlight, { kind: 'text', text: '这台设备的配对已失效，请重新配对。' });
    assert.deepEqual(committed, []);
});

test('取消信号在发送前或模型等待中中断本轮', async () => {
    const before = new AbortController();
    before.abort(new Error('已停止'));
    const handlers = createDshCompanionHandlers({ advisor });
    await assert.rejects(handlers.onMessage(textMessage('你好'), 'c1', before.signal), /已停止/);

    const pending = deferred<string>();
    const waiting = new AbortController();
    const slow = createDshCompanionHandlers({ advisor: { advise: () => pending.promise } });
    const inFlight = slow.onMessage(textMessage('你好'), 'c1', waiting.signal);
    waiting.abort(new Error('中途停'));
    await assert.rejects(inFlight, /中途停/);
    pending.resolve('太迟了');
});

test('maxClients 淘汰最早设备，未被淘汰的设备仍带着自己的上下文', async () => {
    const evicted: string[] = [];
    const capped = createDshCompanionHandlers({
        advisor: { advise: async request => { evicted.push(request.recentTurns?.map(turn => turn.content).join('|') ?? ''); return '好'; } },
        maxClients: 1,
    });
    await capped.onMessage(textMessage('甲的第一句'), 'client-A');
    await capped.onMessage(textMessage('乙的第一句'), 'client-B');
    await capped.onMessage(textMessage('甲的第二句'), 'client-A');
    assert.deepEqual(evicted, ['', '', ''], 'A 被 B 挤掉后，A 的下一轮不再看到自己的历史');

    const kept: string[] = [];
    const roomy = createDshCompanionHandlers({
        advisor: { advise: async request => { kept.push(request.recentTurns?.map(turn => turn.content).join('|') ?? ''); return '好'; } },
        maxClients: 2,
    });
    await roomy.onMessage(textMessage('甲的第一句'), 'client-A');
    await roomy.onMessage(textMessage('乙的第一句'), 'client-B');
    await roomy.onMessage(textMessage('甲的第二句'), 'client-A');
    assert.deepEqual(kept, ['', '', '甲的第一句|好']);
});
