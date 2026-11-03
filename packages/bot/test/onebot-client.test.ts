import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { OneBotClient } from '../src/platform/onebot.ts';

type Listener = (...args: any[]) => void;

class FakeWebSocket {
    static readonly OPEN = 1;
    static readonly instances: FakeWebSocket[] = [];
    static sendError: Error | undefined;
    readyState = 0;
    readonly listeners = new Map<string, Listener[]>();

    constructor(_url: string, _options?: unknown) {
        FakeWebSocket.instances.push(this);
    }

    addEventListener(name: string, listener: Listener): void {
        const listeners = this.listeners.get(name) ?? [];
        listeners.push(listener);
        this.listeners.set(name, listeners);
    }

    emit(name: string, event: unknown = {}): void {
        for (const listener of this.listeners.get(name) ?? []) listener(event);
    }

    send(_data: string): void {
        if (FakeWebSocket.sendError) throw FakeWebSocket.sendError;
    }
    close(): void { this.emit('close', { code: 1000 }); }
}

const originalWebSocket = globalThis.WebSocket;
afterEach(() => {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: originalWebSocket });
    FakeWebSocket.instances.length = 0;
    FakeWebSocket.sendError = undefined;
});

test('OneBot start 幂等，stop 会取消断线后已经排好的重连', async () => {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FakeWebSocket });
    const client = new OneBotClient({ url: 'ws://127.0.0.1:3001/', onEvent: () => {}, log: () => {} });
    client.start();
    client.start();
    assert.equal(FakeWebSocket.instances.length, 1, '重复 start 不能创建第二条连接');
    FakeWebSocket.instances[0]!.emit('close', { code: 1006 });
    client.stop();
    await new Promise(resolve => setTimeout(resolve, 1_100));
    assert.equal(FakeWebSocket.instances.length, 1, 'stop 后不能由旧的重连定时器重新连接');
});

test('OneBot 发送阶段恰好断线时立即失败，不把调用留到超时', async () => {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: FakeWebSocket });
    const client = new OneBotClient({ url: 'ws://127.0.0.1:3001/', onEvent: () => {}, log: () => {}, timeoutMs: 30_000 });
    client.start();
    const socket = FakeWebSocket.instances[0]!;
    socket.readyState = FakeWebSocket.OPEN;
    socket.emit('open');
    FakeWebSocket.sendError = new Error('socket closed');
    await assert.rejects(client.call('get_login_info', {}), /get_login_info 发送失败/);
    client.stop();
});
