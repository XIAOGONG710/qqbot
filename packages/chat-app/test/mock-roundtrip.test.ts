// 真的 WebSocket + HTTP，对着开发用的假中继（dev/mock-server.mjs）把协议走一遍。
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startMockServer, type MockServer } from '../dev/mock-server.mjs';
import { Connection, type SocketLike } from '../src/connection.js';
import { Outbox } from '../src/outbox.js';
import { buildPairRequest, readPairResponse } from '../src/pairing.js';
import { authorization, historyPath, mediaPath, parseHistory, pokeFrame, recallFrame } from '../src/protocol.js';
import { addPending, applyFrame, applyHistory, createState, disconnected, isRecalled, oldestSeq, sendable } from '../src/store.js';
import type { ConversationState, Credentials } from '../src/types.d.ts';

let server: MockServer;
let credentials: Credentials;

before(async () => {
    server = await startMockServer({ port: 0, seed: 30, quiet: true, replyDelayMs: 20 });
});
after(async () => { await server.close(); });

async function pair(code: string, deviceName = '测试手机') {
    const request = buildPairRequest(code, deviceName);
    assert.ok(request.ok);
    const response = await fetch(`${server.url}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body) });
    return readPairResponse(response.status, await response.json().catch(() => undefined));
}

/** 一个不带界面的客户端：状态机 + 发件箱 + 对话状态 */
function client(creds: Credentials, initial: ConversationState = createState()) {
    let state = initial;
    const waiters: { test: (s: ConversationState) => boolean; done: () => void }[] = [];
    const set = (next: ConversationState) => {
        state = next;
        for (const waiter of [...waiters]) if (waiter.test(state)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.done(); }
    };
    const urls: string[] = [];
    const connection: Connection = new Connection({
        open: () => {
            const url = `${server.url.replace('http', 'ws')}/ws`;
            urls.push(url);
            return new WebSocket(url) as unknown as SocketLike;
        },
        hello: () => ({ credentials: creds, since: state.maxSeq }),
        onFrame: frame => {
            if (frame.type === 'ack' || frame.type === 'error') { if ('clientId' in frame && frame.clientId) outbox.forget(frame.clientId); }
            set(applyFrame(state, frame, Date.now()));
            if (frame.type === 'ready') flush();
        },
        onStatus: info => { if (info.status !== 'ready' && info.status !== 'syncing') { outbox.reset(); set(disconnected(state)); } },
        config: { baseDelayMs: 20, maxDelayMs: 50 },
    });
    const outbox = new Outbox({ send: frame => connection.send(frame) });
    const flush = () => { outbox.flush(sendable(state), connection.generation, Date.now()); };
    return {
        connection, urls,
        get state() { return state; },
        send(clientId: string, text: string, replyTo?: number) {
            set(addPending(state, { clientId, at: Date.now(), parts: [{ kind: 'text', text }], status: 'sending', ...(replyTo === undefined ? {} : { replyTo }) }));
            flush();
        },
        apply: set,
        until(check: (s: ConversationState) => boolean, label: string) {
            if (check(state)) return Promise.resolve();
            return new Promise<void>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error(`等不到：${label}`)), 4000);
                waiters.push({ test: check, done: () => { clearTimeout(timer); resolve(); } });
            });
        },
    };
}

test('配对：错的码被拒，对的码拿到凭据，用过即废', async () => {
    const wrong = await pair('00000000');
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.reason, 'invalid');
    const right = await pair(server.code);
    assert.ok(right.ok);
    credentials = right.credentials;
    assert.ok(credentials.deviceId && credentials.token.length >= 43);
    const again = await pair(server.code);
    assert.equal(again.ok, false);
});

test('配对：过期的码、连错 5 次的码', async () => {
    const expired = server.newCode();
    server.expireCode();
    const late = await pair(expired);
    assert.equal(late.ok, false);
    if (!late.ok) assert.equal(late.reason, 'invalid', '中继不说是哪一种');
    server.newCode();
    for (let i = 0; i < 5; i++) await pair('11111111');
    const locked = await pair('11111111');
    assert.equal(locked.ok, false);
    if (!locked.ok) assert.equal(locked.reason, 'invalid');
});

test('没有凭据的 HTTP 请求一律 401；凭据不在 URL 里', async () => {
    assert.equal((await fetch(`${server.url}${historyPath(10)}`)).status, 401);
    assert.equal((await fetch(`${server.url}/api/media`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array([1]) })).status, 401);
    assert.equal(historyPath(10).includes(credentials.token), false);
});

test('hello → 补发 → ready；发一条 → ack 对上本地气泡 → 已读 → 她正在输入 → 她回话', async () => {
    const c = client(credentials);
    c.connection.start();
    await c.until(s => s.synced, 'ready');
    assert.equal(c.state.selfName, server.partner);
    assert.equal(c.state.upstream, 'up');
    assert.equal(c.state.maxSeq, server.seq);
    assert.ok(c.state.messages.length >= 30);
    assert.ok(c.urls.every(url => !url.includes(credentials.token) && !url.includes(credentials.deviceId)));

    c.send('c-hello', '在吗');
    assert.equal(c.state.pending.length, 1);
    await c.until(s => s.pending.length === 0, 'ack');
    const mine = c.state.messages.find(m => m.clientId === 'c-hello');
    assert.ok(mine && mine.from === 'me' && mine.seq > 0);
    await c.until(s => s.readSeq >= mine.seq, '已读');
    await c.until(s => s.typing, '正在输入');
    await c.until(s => s.messages.some(m => m.from === 'her' && m.seq > mine.seq), '她的回话');
    assert.equal(c.state.typing, false);
    assert.equal(c.state.messages.filter(m => m.clientId === 'c-hello').length, 1);
    c.connection.stop();
});

test('断线重连：用 since 只补漏掉的；没确认的那条用同一个 clientId 重发，中继不记两遍', async () => {
    const c = client(credentials);
    c.connection.start();
    await c.until(s => s.synced, 'ready');
    const before = c.state.messages.length;
    server.dropConnections();
    await c.until(s => !s.synced, '断开');
    const missed = server.say([{ kind: 'text', text: '你不在的时候说的' }]);
    c.send('c-offline', '断线时写的');
    assert.equal(c.state.pending.length, 1);
    await c.until(s => s.synced && s.pending.length === 0, '重连并发出');
    assert.ok(c.state.messages.some(m => m.id === missed.id));
    assert.equal(c.state.messages.filter(m => m.clientId === 'c-offline').length, 1);
    assert.equal(server.ledger.filter(item => item.message?.clientId === 'c-offline').length, 1);
    // 同一个 clientId 再发一次（比如 ack 丢了）：中继回同一个 ack
    const settled = c.state.messages.find(m => m.clientId === 'c-offline');
    c.connection.send({ type: 'send', clientId: 'c-offline', parts: [{ kind: 'text', text: '断线时写的' }] });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(server.ledger.filter(item => item.message?.clientId === 'c-offline').length, 1);
    assert.equal(c.state.messages.find(m => m.clientId === 'c-offline')?.seq, settled?.seq);
    assert.ok(c.state.messages.length > before);
    assert.deepEqual(c.state.messages.map(m => m.seq), [...c.state.messages.map(m => m.seq)].sort((a, b) => a - b));
    c.connection.stop();
});

test('撤回自己的、她撤回、表情回应、戳一戳、上游断开、发送失败', async () => {
    const c = client(credentials);
    c.connection.start();
    await c.until(s => s.synced, 'ready');

    c.send('c-recall', '这条要撤回');
    await c.until(s => s.messages.some(m => m.clientId === 'c-recall'), 'ack');
    const mine = c.state.messages.find(m => m.clientId === 'c-recall');
    assert.ok(mine);
    assert.equal(c.connection.send(recallFrame(mine.id)), true);
    await c.until(s => isRecalled(s, mine), '自己撤回');

    c.send('c-her-recall', '你撤回一条试试');
    await c.until(s => s.messages.some(m => m.from === 'her' && isRecalled(s, m)), '她撤回');

    c.send('c-like', '给我点个赞');
    await c.until(s => s.messages.some(m => m.clientId === 'c-like'), 'ack');
    const liked = c.state.messages.find(m => m.clientId === 'c-like');
    await c.until(s => (s.reactions[String(liked?.id)] ?? []).includes(76), '表情回应');

    assert.equal(c.connection.send(pokeFrame()), true);
    await c.until(s => s.messages.some(m => m.from === 'me' && m.parts[0]?.kind === 'poke') && s.messages.some(m => m.from === 'her' && m.parts[0]?.kind === 'poke'), '戳一戳');

    server.setUpstream('down');
    await c.until(s => s.upstream === 'down', '上游断开');
    server.setUpstream('up');
    await c.until(s => s.upstream === 'up', '上游恢复');

    c.send('c-fail', '这条会失败');
    await c.until(s => s.pending.some(p => p.clientId === 'c-fail' && p.status === 'failed'), '发送失败');
    assert.equal(c.state.pending.find(p => p.clientId === 'c-fail')?.error, '没能交到她那边');
    c.connection.stop();
});

test('媒体：带 Authorization 上传拿到 mediaId，再取回来是同一份；类型不对被拒', async () => {
    const headers = { Authorization: authorization(credentials) };
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
    const upload = await fetch(`${server.url}/api/media`, { method: 'POST', headers: { ...headers, 'Content-Type': 'image/png' }, body: bytes });
    assert.equal(upload.status, 200);
    const { mediaId } = await upload.json() as { mediaId: string };
    const download = await fetch(`${server.url}${mediaPath(mediaId)}`, { headers });
    assert.equal(download.headers.get('content-type'), 'image/png');
    assert.equal(download.headers.get('cache-control'), 'no-store');
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
    assert.equal((await fetch(`${server.url}${mediaPath(mediaId)}`)).status, 401);
    assert.equal((await fetch(`${server.url}/api/media`, { method: 'POST', headers: { ...headers, 'Content-Type': 'video/mp4' }, body: bytes })).status, 400);

    const c = client(credentials);
    c.connection.start();
    await c.until(s => s.synced, 'ready');
    c.apply(addPending(c.state, { clientId: 'c-img', at: Date.now(), status: 'sending', parts: [{ kind: 'image', mediaId, mime: 'image/png' }] }));
    c.connection.send({ type: 'send', clientId: 'c-img', parts: [{ kind: 'image', mediaId, mime: 'image/png' }] });
    await c.until(s => s.messages.some(m => m.clientId === 'c-img'), '图片消息入账');
    c.send('c-want', '发张图');
    await c.until(s => s.messages.some(m => m.from === 'her' && m.parts[0]?.kind === 'image' && m.seq > (s.messages.find(x => x.clientId === 'c-want')?.seq ?? Infinity)), '她发图');
    c.connection.stop();
});

test('历史：从最老的一条往前翻，翻到头为止，顺序和账上一致', async () => {
    const headers = { Authorization: authorization(credentials) };
    const all = server.ledger.filter(item => item.message).map(item => item.seq);
    let state = createState({}, server.ledger.filter(item => item.message).slice(-5).map(item => item.message!));
    for (let i = 0; i < 20 && !state.historyDone; i++) {
        const response = await fetch(`${server.url}${historyPath(oldestSeq(state), 25)}`, { headers });
        assert.equal(response.status, 200);
        state = applyHistory(state, parseHistory(await response.json()));
    }
    assert.equal(state.historyDone, true);
    assert.deepEqual(state.messages.map(m => m.seq), all);
    assert.equal((await fetch(`${server.url}/api/history?before=10&limit=500`, { headers })).status, 400);
});

test('设备被撤销：unauthorized，不再重连', async () => {
    const fresh = await pair(server.newCode(), '要被撤销的');
    assert.ok(fresh.ok);
    server.revokeAll();
    const c = client(fresh.credentials);
    c.connection.start();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(c.connection.status, 'unauthorized');
    assert.equal(c.state.synced, false);
    c.connection.stop();
});

test('静态文件：首页带 CSP，dev / test 目录不对外', async () => {
    const index = await fetch(`${server.url}/`);
    assert.equal(index.status, 200);
    assert.match(await index.text(), /Content-Security-Policy/);
    assert.equal((await fetch(`${server.url}/src/store.js`)).status, 200);
    assert.equal((await fetch(`${server.url}/dev/mock-server.mjs`)).status, 404);
    assert.equal((await fetch(`${server.url}/test/store.test.ts`)).status, 404);
    assert.equal((await fetch(`${server.url}/..%2f..%2fpackage.json`)).status, 404);
});
