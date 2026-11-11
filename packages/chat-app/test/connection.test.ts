import assert from 'node:assert/strict';
import test from 'node:test';
import { backoffDelay, Connection, DEFAULTS, type ConnectionStatus, type SocketLike } from '../src/connection.js';
import { Outbox } from '../src/outbox.js';
import type { ClientFrame, PendingMessage, ServerFrame } from '../src/types.d.ts';

class FakeSocket implements SocketLike {
    sent: ClientFrame[] = [];
    closed = false;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: unknown) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    send(data: string) {
        if (this.closed) throw new Error('closed');
        this.sent.push(JSON.parse(data));
    }
    close() { this.closed = true; }
    open() { this.onopen?.({}); }
    receive(frame: unknown) { this.onmessage?.({ data: typeof frame === 'string' ? frame : JSON.stringify(frame) }); }
    drop() { this.onclose?.({}); }
}

/** 假时钟：定时器按到期时间触发 */
function harness(options: { since?: () => number; random?: number } = {}) {
    let now = 1_000_000;
    let nextTimer = 1;
    const timers = new Map<number, { at: number; fn: () => void }>();
    const sockets: FakeSocket[] = [];
    const frames: ServerFrame[] = [];
    const statuses: ConnectionStatus[] = [];
    const connection = new Connection({
        open: () => {
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        hello: () => ({ credentials: { deviceId: 'dev-1', token: 'secret-token' }, since: options.since?.() ?? 0 }),
        onFrame: frame => frames.push(frame),
        onStatus: info => statuses.push(info.status),
        setTimer: (fn, ms) => {
            const id = nextTimer++;
            timers.set(id, { at: now + ms, fn });
            return id;
        },
        clearTimer: handle => { timers.delete(handle as number); },
        now: () => now,
        random: () => options.random ?? 1,
    });
    const advance = (ms: number) => {
        const end = now + ms;
        for (;;) {
            const due = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
            if (!due) break;
            timers.delete(due[0]);
            now = due[1].at;
            due[1].fn();
        }
        now = end;
    };
    const last = () => sockets[sockets.length - 1] as FakeSocket;
    const ready = (seq = 0) => {
        last().open();
        last().receive({ type: 'ready', seq, self: { name: '小满' }, upstream: 'up' });
    };
    return { connection, sockets, frames, statuses, advance, last, ready, timers };
}

test('退避：指数增长、封顶、抖动在 0.5–1 倍之间', () => {
    assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 30].map(n => backoffDelay(n, 1)), [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000]);
    assert.deepEqual([0, 1, 5].map(n => backoffDelay(n, 0)), [500, 1000, 15_000]);
    assert.equal(backoffDelay(2, 0.5), 3000);
    assert.equal(backoffDelay(3, 1, { baseDelayMs: 100, maxDelayMs: 500 }), 500);
});

test('连上先发 hello（带凭据和 since），ready 之前不能发别的', () => {
    const h = harness({ since: () => 42 });
    h.connection.start();
    assert.equal(h.connection.status, 'connecting');
    assert.deepEqual(h.last().sent, []);
    h.last().open();
    assert.deepEqual(h.last().sent, [{ type: 'hello', deviceId: 'dev-1', token: 'secret-token', since: 42 }]);
    assert.equal(h.connection.status, 'syncing');
    assert.equal(h.connection.send({ type: 'poke' }), false);
    h.last().receive({ type: 'message', message: { seq: 43, id: 1, from: 'her', via: 'app', at: 1, parts: [] } });
    assert.equal(h.connection.status, 'syncing');
    h.last().receive({ type: 'ready', seq: 43, self: { name: '小满' }, upstream: 'up' });
    assert.equal(h.connection.status, 'ready');
    assert.equal(h.connection.send({ type: 'poke' }), true);
    assert.deepEqual(h.frames.map(frame => frame.type), ['message', 'ready']);
    assert.deepEqual(h.statuses, ['connecting', 'syncing', 'ready']);
});

test('断了按退避重连，每次 hello 都取最新的 since；连上后退避清零', () => {
    let since = 0;
    const h = harness({ since: () => since });
    h.connection.start();
    h.ready();
    since = 57;
    h.last().drop();
    assert.equal(h.connection.status, 'waiting');
    assert.equal(h.sockets.length, 1);
    h.advance(999);
    assert.equal(h.sockets.length, 1);
    h.advance(1);
    assert.equal(h.sockets.length, 2);
    h.last().drop();
    h.advance(1999);
    assert.equal(h.sockets.length, 2, '第二次等 2 秒');
    h.advance(1);
    assert.equal(h.sockets.length, 3);
    h.last().open();
    assert.deepEqual(h.last().sent[0], { type: 'hello', deviceId: 'dev-1', token: 'secret-token', since: 57 });
    h.last().receive({ type: 'ready', seq: 57, self: { name: '小满' }, upstream: 'up' });
    h.last().drop();
    h.advance(1000);
    assert.equal(h.sockets.length, 4, 'ready 之后退避从头算');
});

test('旧 socket 迟到的回调不算数', () => {
    const h = harness();
    h.connection.start();
    const first = h.last();
    const onmessage = first.onmessage;
    h.ready();
    first.drop();
    h.advance(1000);
    onmessage?.({ data: JSON.stringify({ type: 'typing', on: true }) });
    assert.equal(h.frames.some(frame => frame.type === 'typing'), false);
    assert.equal(first.closed, true);
});

test('心跳：空闲 25 秒发 ping，pong 回来继续；10 秒没任何回音算假死并重连', () => {
    const h = harness();
    h.connection.start();
    h.ready();
    const socket = h.last();
    h.advance(DEFAULTS.pingIntervalMs);
    assert.deepEqual(socket.sent.map(frame => frame.type), ['hello', 'ping']);
    socket.receive({ type: 'pong' });
    assert.equal(h.frames.some(frame => (frame.type as string) === 'pong'), false, 'pong 不往上交');
    h.advance(DEFAULTS.pingIntervalMs);
    assert.deepEqual(socket.sent.map(frame => frame.type), ['hello', 'ping', 'ping']);
    assert.equal(h.connection.status, 'ready');
    h.advance(DEFAULTS.pongTimeoutMs);
    assert.equal(socket.closed, true);
    assert.equal(h.connection.status, 'waiting');
    h.advance(1000);
    assert.equal(h.sockets.length, 2);
});

test('ping 之后来的任何一帧都算活着', () => {
    const h = harness();
    h.connection.start();
    h.ready();
    h.advance(DEFAULTS.pingIntervalMs);
    h.last().receive({ type: 'typing', on: true });
    h.advance(DEFAULTS.pongTimeoutMs + 1);
    assert.equal(h.connection.status, 'ready');
});

test('hello 之后一直没回音：超时重连；补发途中每来一帧都续时', () => {
    const h = harness();
    h.connection.start();
    h.last().open();
    h.advance(DEFAULTS.helloTimeoutMs - 1);
    h.last().receive({ type: 'message', message: { seq: 1, id: 1, from: 'her', via: 'app', at: 1, parts: [] } });
    h.advance(DEFAULTS.helloTimeoutMs - 1);
    assert.equal(h.connection.status, 'syncing');
    h.advance(1);
    assert.equal(h.connection.status, 'waiting');
});

test('unauthorized：停下来不再重连，把这一帧交上去', () => {
    const h = harness();
    h.connection.start();
    h.last().open();
    h.last().receive({ type: 'error', code: 'unauthorized', message: '设备已撤销' });
    assert.equal(h.connection.status, 'unauthorized');
    assert.equal(h.last().closed, true);
    h.advance(120_000);
    assert.equal(h.sockets.length, 1);
    assert.deepEqual(h.frames.map(frame => frame.type), ['error']);
});

test('kick：等重连时立刻连；连着时马上探活', () => {
    const h = harness();
    h.connection.start();
    h.ready();
    h.connection.kick();
    assert.deepEqual(h.last().sent.map(frame => frame.type), ['hello', 'ping']);
    h.last().drop();
    h.last();
    h.connection.kick();
    assert.equal(h.sockets.length, 2);
    assert.equal(h.connection.status, 'connecting');
});

test('stop 之后不重连、不再回调', () => {
    const h = harness();
    h.connection.start();
    h.ready();
    const socket = h.last();
    h.connection.stop();
    assert.equal(socket.closed, true);
    assert.equal(h.connection.status, 'idle');
    h.advance(600_000);
    assert.equal(h.sockets.length, 1);
    assert.equal(h.timers.size, 0);
});

test('打不开 socket（open 抛错）也按退避重试', () => {
    let fail = true;
    const sockets: FakeSocket[] = [];
    const pending: (() => void)[] = [];
    const connection = new Connection({
        open: () => {
            if (fail) throw new Error('offline');
            const socket = new FakeSocket();
            sockets.push(socket);
            return socket;
        },
        hello: () => ({ credentials: { deviceId: 'd', token: 't' }, since: 0 }),
        onFrame: () => {},
        setTimer: fn => pending.push(fn),
        clearTimer: () => {},
        random: () => 0,
    });
    connection.start();
    assert.equal(connection.status, 'waiting');
    fail = false;
    pending.shift()?.();
    assert.equal(sockets.length, 1);
});

test('凭据不出现在 socket 的打开参数里（open 不带参数）', () => {
    const h = harness();
    h.connection.start();
    assert.equal(h.sockets.length, 1);
    assert.equal(JSON.stringify(h.statuses).includes('secret-token'), false);
});

const pend = (clientId: string, extra: Partial<PendingMessage> = {}): PendingMessage =>
    ({ clientId, at: 1, parts: [{ kind: 'text', text: clientId }], status: 'sending', ...extra });

test('发件箱：每条连接上每个 clientId 只发一次；换了连接用同一个 clientId 全部重发', () => {
    const sent: ClientFrame[] = [];
    const outbox = new Outbox({ send: frame => { sent.push(frame); return true; } });
    assert.deepEqual(outbox.flush([pend('a'), pend('b', { replyTo: 9 })], 1, 0).sent, ['a', 'b']);
    assert.deepEqual(outbox.flush([pend('a'), pend('b'), pend('c')], 1, 10).sent, ['c']);
    assert.deepEqual(sent[1], { type: 'send', clientId: 'b', parts: [{ kind: 'text', text: 'b' }], replyTo: 9 });
    // a 已确认，b、c 没等到 ack 连接就断了
    assert.deepEqual(outbox.flush([pend('b'), pend('c')], 2, 20).sent, ['b', 'c']);
    assert.deepEqual(sent.map(frame => (frame.type === 'send' ? frame.clientId : '')), ['a', 'b', 'c', 'b', 'c']);
});

test('发件箱：连接不在时什么都不记，下次再发；顺序不变', () => {
    let online = false;
    const sent: string[] = [];
    const outbox = new Outbox({ send: frame => { if (online && frame.type === 'send') sent.push(frame.clientId); return online; } });
    assert.deepEqual(outbox.flush([pend('a'), pend('b')], 1, 0).sent, []);
    online = true;
    assert.deepEqual(outbox.flush([pend('a'), pend('b')], 1, 0).sent, ['a', 'b']);
    assert.deepEqual(sent, ['a', 'b']);
});

test('发件箱：太大的那条单独报出来，不挡后面的；ack 超时能查到，忘掉之后不再报', () => {
    const outbox = new Outbox({
        send: frame => {
            if (frame.type === 'send' && frame.clientId === 'big') throw new RangeError('too big');
            return true;
        },
        ackTimeoutMs: 100,
    });
    assert.deepEqual(outbox.flush([pend('big'), pend('ok')], 1, 0), { sent: ['ok'], tooLarge: ['big'] });
    assert.deepEqual(outbox.expired(99), []);
    assert.deepEqual(outbox.expired(100), ['ok']);
    outbox.forget('ok');
    assert.deepEqual(outbox.expired(500), []);
    outbox.flush([pend('x')], 1, 0);
    outbox.reset();
    assert.deepEqual(outbox.expired(10_000), []);
});

test('发件箱接在真的状态机上：断线前没确认的，重连 ready 后重发', () => {
    const h = harness();
    const outbox = new Outbox({ send: frame => h.connection.send(frame) });
    h.connection.start();
    const queue = [pend('a')];
    assert.deepEqual(outbox.flush(queue, h.connection.generation, 0).sent, [], '还没 ready');
    h.ready();
    assert.deepEqual(outbox.flush(queue, h.connection.generation, 0).sent, ['a']);
    h.last().drop();
    outbox.reset();
    h.advance(1000);
    h.ready();
    assert.deepEqual(outbox.flush(queue, h.connection.generation, 0).sent, ['a']);
    assert.deepEqual(h.last().sent.map(frame => frame.type), ['hello', 'send']);
});
