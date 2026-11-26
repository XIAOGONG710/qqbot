import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { CompanionGateway, helloEnvelope } from '../src/gateway.ts';
import { MemoryPairingStore } from '../src/pairing.ts';
import { CompanionRuntime } from '../src/runtime.ts';
import { attachCompanionWebSocket } from '../src/websocket.ts';

function fakeSocket() {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const closed: Array<[number | undefined, string | undefined]> = [];
    return {
        listeners, closed,
        socket: {
            on: (event: 'message' | 'close' | 'error', listener: (...args: unknown[]) => void) => { listeners.set(event, listener); },
            send: (_data: string) => undefined,
            close: (code?: number, reason?: string) => { closed.push([code, reason]); },
        },
    };
}

test('WebSocket 连上后迟迟不配对会被断开；配对成功的连接不受影响', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
        const now = 60_000;
        const pairing = new MemoryPairingStore(60_000);
        const ticket = pairing.issue('android-ws-timeout', now);
        const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
            onMessage: async () => ({ kind: 'text', text: 'ok' }),
            onAction: async (_request, _client, requestId) => ({ requestId, ok: false, decision: 'deny' }),
        }, () => now);

        const idle = fakeSocket();
        attachCompanionWebSocket(idle.socket, runtime, { helloTimeoutMs: 5_000 });
        const paired = fakeSocket();
        attachCompanionWebSocket(paired.socket, runtime, { helloTimeoutMs: 5_000 });
        paired.listeners.get('message')?.(JSON.stringify(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-wst-hello', 'nonce-wst-hello', new Date(now).toISOString())));
        for (let index = 0; index < 5; index++) await Promise.resolve();
        await new Promise(resolve => setImmediate(resolve));

        mock.timers.tick(4_999);
        assert.deepEqual(idle.closed, []);
        mock.timers.tick(1);
        assert.deepEqual(idle.closed, [[1008, 'hello_timeout']]);
        assert.deepEqual(paired.closed, []);
        assert.equal(runtime.status().connected, true);
        assert.throws(() => attachCompanionWebSocket(fakeSocket().socket, runtime, { helloTimeoutMs: 10 }), /配对等待时间/);
    } finally {
        mock.timers.reset();
    }
});
