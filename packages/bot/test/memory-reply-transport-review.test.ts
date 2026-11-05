import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openAccount, type BiliRequest, type BiliAccount } from '../src/bilibili/bilibili-account.ts';
import { replyComposer } from '../src/bilibili/bilibili-comment.ts';

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const step = () => new Promise<void>(done => setImmediate(done));
const character = { name: '合成角色', description: '合成资料', personality: '平静', banned: [] };
const input = { title: '合成标题', mine: '这只猫真有意思', theirs: '真的很好玩呀', fromUser: true, recent: [] };

for (const method of ['fetchReplies', 'systemNoticeUnread', 'systemNotices'] as const) test(`${method}真实账号纯读取body取消，不等不合作响应且复用账号`, async () => {
    const held = deferred<string>(), entered = deferred<void>(); let hold = true, signal: AbortSignal | undefined;
    const request: BiliRequest = async (url, init) => {
        if (url.includes('/nav')) return { ok: true, status: 200, text: async () => JSON.stringify({ code: 0, data: { isLogin: true, mid: 123 } }) };
        signal = init.signal;
        return { ok: true, status: 200, text: async () => { if (hold) { entered.resolve(); return held.promise; } return JSON.stringify({ code: 0, data: { items: [], sys_msg: 0 } }); } };
    };
    const account = await openAccount(request, { sessdata: 'synthetic', biliJct: 'synthetic', dedeUserId: '123', buvid3: 'synthetic', savedAt: '2026-11-05T00:00:00Z' }) as BiliAccount;
    const control = new AbortController(), reason = Error('synthetic cancellation');
    const work = account[method](control.signal); await entered.promise; control.abort(reason);
    await assert.rejects(work, error => error === reason); assert.equal(signal?.aborted, true);
    held.resolve(JSON.stringify({ code: 0, data: {} })); hold = false; await step();
    assert.deepEqual(await account[method](), method === 'systemNoticeUnread' ? 0 : []);
});

for (const value of ['x', '正常合成回复']) test(`回复写手取消后不重试或交付晚正文：${value}`, async () => {
    const held = deferred<string>(); let calls = 0; const logs: string[] = [], control = new AbortController();
    const compose = replyComposer({ character, generate: async (_messages, signal) => { assert.equal(signal, control.signal); calls++; return held.promise; }, log: text => logs.push(text) });
    const work = compose(input, control.signal); control.abort(Error('synthetic stop')); held.resolve(value);
    await assert.rejects(work, /synthetic stop/); assert.equal(calls, 1); assert.deepEqual(logs, []);
});
test('回复写手预取消零派发，未取消仍保原过滤重试策略', async () => {
    let calls = 0; const control = new AbortController(); control.abort(Error('synthetic pre-stop'));
    const compose = replyComposer({ character, generate: async () => ++calls === 1 ? 'x' : '合成正常回复', log() {} });
    await assert.rejects(compose(input, control.signal), /pre-stop/); assert.equal(calls, 0);
    assert.equal(await compose(input), '合成正常回复'); assert.equal(calls, 2);
});
