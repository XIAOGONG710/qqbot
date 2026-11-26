import type { CompanionRuntime } from './runtime.ts';

export interface CompanionWebSocketLike {
    on(event: 'message' | 'close' | 'error', listener: (...args: unknown[]) => void): unknown;
    send(data: string): void;
    close?(code?: number, reason?: string): void;
}
export interface CompanionWebSocketOptions {
    /** 单帧上限；默认与 HTTP body 上限一致。 */
    maxMessageBytes?: number;
    /** 连上之后多久还没完成配对就断开；未配对的连接不能一直占着下行监听。默认 30 秒。 */
    helloTimeoutMs?: number;
}

/**
 * 把任意兼容 ws 的连接接到 CompanionRuntime。
 * 不创建监听器、不设置 CORS，也不改变网关的配对 / nonce / 队列策略。
 */
export function attachCompanionWebSocket(socket: CompanionWebSocketLike, runtime: CompanionRuntime, options: CompanionWebSocketOptions = {}): void {
    const maxMessageBytes = options.maxMessageBytes ?? 1_000_000;
    if (!Number.isInteger(maxMessageBytes) || maxMessageBytes < 1024 || maxMessageBytes > 8 * 1024 * 1024) throw new Error('WebSocket 单帧上限不合法');
    const helloTimeoutMs = options.helloTimeoutMs ?? 30_000;
    if (!Number.isInteger(helloTimeoutMs) || helloTimeoutMs < 1_000 || helloTimeoutMs > 10 * 60_000) throw new Error('WebSocket 配对等待时间不合法');
    let closed = false;
    let paired = false;
    const sessionId = runtime.createSession();
    const sendDownlinks = (clientId: string): void => {
        if (closed || runtime.clientForSession(sessionId) !== clientId) return;
        for (const envelope of runtime.takeDownlinks(clientId)) {
            try { socket.send(JSON.stringify(envelope)); } catch { reject(1011, 'downlink_send_failed'); return; }
        }
    };
    const unsubscribeDownlinks = runtime.subscribeDownlinks((clientId) => sendDownlinks(clientId));
    const helloTimer = setTimeout(() => { if (!paired) reject(1008, 'hello_timeout'); }, helloTimeoutMs);
    helloTimer.unref?.();
    const reject = (code: number, reason: string): void => {
        if (closed) return;
        clearTimeout(helloTimer);
        runtime.releaseSession(sessionId);
        unsubscribeDownlinks();
        closed = true;
        try { socket.send(JSON.stringify({ error: reason.slice(0, 500) })); } catch { /* 连接已经关闭 */ }
        socket.close?.(code, reason.slice(0, 123));
    };
    const release = (): void => {
        if (closed) return;
        clearTimeout(helloTimer);
        closed = true;
        runtime.releaseSession(sessionId);
        unsubscribeDownlinks();
    };
    socket.on('close', release);
    socket.on('error', release);
    socket.on('message', (data, isBinary) => {
        if (closed) return;
        if (isBinary === true) return reject(1003, 'message_must_be_text');
        const text = toText(data);
        if (text === undefined) return reject(1003, 'message_must_be_text');
        if (Buffer.byteLength(text, 'utf8') > maxMessageBytes) return reject(1009, 'message_too_large');
        let value: unknown;
        try { value = JSON.parse(text); }
        catch { return reject(1003, 'invalid_json'); }
        void runtime.handle(value, sessionId).then(result => {
            if (closed) return;
            if (!result.accepted) return reject(1008, result.error);
            // 网关只在配对成功后才会接受包：第一次 accepted 就说明这条连接已经配对
            if (!paired) { paired = true; clearTimeout(helloTimer); }
            if (result.response) socket.send(JSON.stringify(result.response));
            sendDownlinks(runtime.clientForSession(sessionId) ?? '');
        }).catch(() => reject(1011, 'runtime_error'));
    });
}

function toText(data: unknown): string | undefined {
    if (typeof data === 'string') return data;
    if (Buffer.isBuffer(data)) return data.toString('utf8');
    if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
    return undefined;
}
