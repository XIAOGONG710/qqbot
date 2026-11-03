import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { OneBotClient } from '../src/platform/onebot.ts';

type Listener = (...args: any[]) => void;

class FakeWebSocket {
    static readonly OPEN = 1;
    static readonly instances: FakeWebSocket[] = [];
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

    send(_data: string): void {}
    close(): void { this.emit('close', { code: 1000 }); }
}

const originalWebSocket = globalThis.WebSocket;
afterEach(() => {
    Object.defineProperty(globalThis, 'WebSocket', { configurable: true, writable: true, value: originalWebSocket });
    FakeWebSocket.instances.length = 0;
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
