import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createResponder, type InitiateRequest, type ResponderDeps } from '../src/social/responder.ts';
import type { StoredMessage } from '../src/memory/history.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
function gate<T>() { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; }
async function until(check: () => boolean) { const end = Date.now() + 2000; while (!check()) { if (Date.now() > end) assert.fail('合成等待超时'); await new Promise(resolve => setTimeout(resolve, 2)); } }
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function bounded(task: Promise<unknown>) { let timer: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([task.then(() => true, () => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 200); })]); } finally { clearTimeout(timer); } }
function fixture(patch: Partial<ResponderDeps> = {}) {
    const stored: StoredMessage[] = []; const sent: string[] = [];
    const responder = createResponder({
        userId: 10001, now: () => NOW,
        history: { load: () => [...stored], append: (_peer, message) => { stored.push({ ...message }); } },
        buildPrompt: () => ({ messages: [], activatedWorldInfo: [] }), generate: async () => '合成第一句\n合成第二句', clean: text => text,
        send: async (_peer, text) => { sent.push(text); return 900 + sent.length; }, log() {}, sleep: async () => {}, ...patch,
    });
    return { responder, stored, sent };
}
const assistant = (f: ReturnType<typeof fixture>) => f.stored.filter(message => message.role === 'assistant');
const request = (): InitiateRequest => ({ label: '合成主动', note: '合成', topic: '合成', maxBubbles: 2, dryRun: false, commit() {} });

test('普通发送已派发后stop返回drain，等待ACK及历史一次落下且不发第二气泡', async () => {
    const ack = gate<number>(); let sends = 0;
    const f = fixture({ send: async () => { sends++; return ack.promise; } });
    try {
        f.responder.receive('合成请求', 1, new Date(NOW)); await until(() => sends === 1);
        const drain = f.responder.stop(); assert.ok(drain instanceof Promise); assert.equal(f.responder.stop(), drain);
        assert.equal(await bounded(Promise.race([drain, new Promise(() => {})])), false);
        assert.equal(assistant(f).length, 0);
        ack.release(901); await drain; assert.deepEqual(assistant(f).map(message => [message.messageId, message.content]), [[901, '合成第一句']]);
        await f.responder.whenIdle(); assert.equal(sends, 1);
    } finally { ack.release(901); f.responder.stop(); await f.responder.whenIdle(); }
});

test('纯生成未派发send时stop同步返回，迟到生成不能派发或写助手历史', async () => {
    const generated = gate<string>(); let entered = false, reviewed = 0;
    const f = fixture({ generate: async () => { entered = true; return generated.promise; }, review: async text => { reviewed++; return text; } });
    try {
        f.responder.receive('合成请求', 1, new Date(NOW)); await until(() => entered);
        assert.equal(f.responder.stop(), undefined); assert.equal(assistant(f).length, 0);
        generated.release('合成迟到回复'); await f.responder.whenIdle(); assert.equal(f.sent.length, 0); assert.equal(assistant(f).length, 0); assert.equal(reviewed, 0);
    } finally { generated.release('清理'); f.responder.stop(); await f.responder.whenIdle(); }
});

test('默认安静窗口定时器归属回复器，stop会实际清除而不是等满窗口', async () => {
    const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout;
    let quietTimer: ReturnType<typeof setTimeout> | undefined, quietCleared = false;
    globalThis.setTimeout = ((callback: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
        const timer = originalSet(callback, ms, ...args);
        if (ms === 4000) quietTimer = timer;
        return timer;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((timer: Parameters<typeof clearTimeout>[0]) => {
        if (timer === quietTimer) quietCleared = true;
        return originalClear(timer);
    }) as typeof clearTimeout;
    const f = fixture({ sleep: undefined, now: Date.now, settle: { quietMs: 4000, maxMs: 4000 } });
    try {
        f.responder.receive('合成请求', 1, new Date()); await until(() => quietTimer !== undefined);
        assert.equal(f.responder.stop(), undefined, '纯本地等待不应制造mutation drain');
        await f.responder.whenIdle();
        assert.equal(quietCleared, true);
        assert.equal((quietTimer as unknown as { _destroyed?: boolean })._destroyed, true);
        assert.deepEqual(f.sent, []); assert.equal(assistant(f).length, 0);
    } finally {
        f.responder.stop(); await f.responder.whenIdle();
        globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear;
    }
});

test('ACK后的历史写入EIO不变成发送失败；已发布读回可确认，未发布只记安全诊断不重发', async () => {
    for (const phase of ['before', 'after', 'same-old-ack'] as const) {
        const published = phase === 'after';
        const ack = gate<number>(); let sends = 0; const rows: StoredMessage[] = [], logs: string[] = [];
        if (phase === 'same-old-ack') rows.push({ role: 'assistant', time: new Date(NOW).toISOString(), messageId: 941, content: '合成第一句' });
        const f = fixture({ send: async () => { sends++; return ack.promise; }, log: text => logs.push(text),
            history: { load: () => [...rows], append: (_peer, message) => { if (published) rows.push(message); throw Object.assign(new Error('SYNTHETIC_PRIVATE_HISTORY_PATH'), { code: 'EIO' }); } } });
        const task = f.responder.initiate(request());
        try {
            await until(() => sends === 1); const drain = f.responder.stop(); assert.ok(drain instanceof Promise);
            ack.release(941); await drain; const result = await task;
            assert.equal(result.result, 'sent'); if (result.result === 'sent') assert.deepEqual(result.messageIds, [941]);
            assert.equal(sends, 1); assert.equal(rows.length, phase === 'before' ? 0 : 1);
            if (!published) assert.ok(logs.some(text => /已经确认/.test(text) && /未确认/.test(text) && /不重发/.test(text)));
            else assert.ok(!logs.some(text => /本地历史追加未确认/.test(text)));
            assert.doesNotMatch(logs.join('\n'), /SYNTHETIC_PRIVATE_HISTORY_PATH/);
        } finally { ack.release(941); f.responder.stop(); await task; }
    }
});

test('副索引转换回调触发stop或抛错，仍覆盖在ACK事务内并记录实际发送', async () => {
    let observed: Promise<void> | undefined; const logs: string[] = [];
    const f = fixture({ generate: async () => '合成回复', log: text => logs.push(text), historyContent: () => { observed = f.responder.stop(); throw new Error('SYNTHETIC_PRIVATE_INDEX'); } });
    try {
        const result = await f.responder.initiate(request()); assert.equal(result.result, 'sent'); assert.ok(observed instanceof Promise);
        await observed; assert.deepEqual(assistant(f).map(message => message.content), ['合成回复']);
        assert.doesNotMatch(logs.join('\n'), /SYNTHETIC_PRIVATE_INDEX/);
    } finally { f.responder.stop(); await f.responder.whenIdle(); }
});

test('已经派发的错字delete等ACK收尾，stop后不能派发correct', async () => {
    const deleted = gate<void>(); let deleting = false;
    const f = fixture({ generate: async () => '合成正确内容', decorate: parts => ({ parts, recall: { index: 0, wrong: '合成错误内容', fix: '*合成正确内容', afterMs: 0 } }),
        recallOwn: async () => { deleting = true; await deleted.promise; } });
    try {
        f.responder.receive('合成请求', 1, new Date(NOW)); await until(() => deleting);
        const drain = f.responder.stop(); assert.ok(drain instanceof Promise);
        assert.equal(await bounded(drain), false); deleted.release(); await drain; await f.responder.whenIdle();
        assert.deepEqual(f.sent, ['合成错误内容']); assert.equal(assistant(f).length, 0, '已经成功撤回的错字不当作仍可见回复');
    } finally { deleted.release(); f.responder.stop(); await f.responder.whenIdle(); }
});

test('主动发送ACK边界也等待历史转换与追加，stop不丢ACK或发送后续', async () => {
    const ack = gate<number>(); let sends = 0, converted = 0;
    const f = fixture({ send: async () => { sends++; return ack.promise; }, historyContent: (text, id) => { converted++; assert.equal(id, 911); return `已确认：${text}`; } });
    const task = f.responder.initiate(request());
    try {
        await until(() => sends === 1); const drain = f.responder.stop(); assert.ok(drain instanceof Promise); assert.equal(converted, 0);
        ack.release(911); await drain;
        assert.equal(converted, 1); assert.deepEqual(assistant(f).map(message => message.content), ['已确认：合成第一句']);
        const result = await task; assert.equal(result.result, 'sent'); assert.equal(sends, 1);
    } finally { ack.release(911); f.responder.stop(); await task; }
});

test('错字首条等待ACK时停止，记录实际wrong，不再派发delete或correct', async () => {
    const ack = gate<number>(); let sends = 0, deletes = 0;
    const f = fixture({ generate: async () => '合成正确内容', decorate: parts => ({ parts, recall: { index: 0, wrong: '合成错误内容', fix: '*合成正确内容', afterMs: 5000 } }),
        recallOwn: async () => { deletes++; }, send: async (_peer, text) => { f.sent.push(text); sends++; return ack.promise; } });
    try {
        f.responder.receive('合成请求', 1, new Date(NOW)); await until(() => sends === 1);
        const drain = f.responder.stop(); ack.release(921); await drain; await f.responder.whenIdle();
        assert.equal(deletes, 0); assert.equal(sends, 1); assert.deepEqual(assistant(f).map(message => [message.messageId, message.content]), [[921, '合成错误内容']]);
    } finally { ack.release(921); f.responder.stop(); await f.responder.whenIdle(); }
});

test('错字ACK后在不合作的撤回延迟中停止，drain立即收束并保留wrong', async () => {
    const wait = gate<void>(); let sleeping = false, deletes = 0;
    const f = fixture({ generate: async () => '合成正确内容', decorate: parts => ({ parts, recall: { index: 0, wrong: '合成错误内容', fix: '*合成正确内容', afterMs: 5000 } }),
        recallOwn: async () => { deletes++; }, sleep: async () => { sleeping = true; return wait.promise; } });
    try {
        f.responder.receive('合成请求', 1, new Date(NOW)); await until(() => sleeping);
        const drain = f.responder.stop(); assert.ok(drain instanceof Promise); assert.equal(await bounded(drain), true);
        assert.equal(deletes, 0); assert.equal(f.sent.length, 1); assert.equal(assistant(f)[0]?.content, '合成错误内容');
    } finally { wait.release(); f.responder.stop(); await f.responder.whenIdle(); }
});

test('注入send同步触发stop也必须看得到已派发事务，ACK后才结束drain', async () => {
    const ack = gate<number>(); let observed: Promise<void> | undefined, entered = false;
    const f = fixture({ generate: async () => '合成回复', send: async () => { entered = true; observed = f.responder.stop(); return ack.promise; } });
    try {
        f.responder.receive('合成请求', 1, new Date(NOW)); await until(() => entered);
        assert.ok(observed instanceof Promise); ack.release(931); await observed;
        assert.deepEqual(assistant(f).map(message => message.messageId), [931]);
    } finally { ack.release(931); f.responder.stop(); await f.responder.whenIdle(); }
});
