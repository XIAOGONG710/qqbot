import type { ClientFrame, PendingMessage } from './types.d.ts';

export const ACK_TIMEOUT_MS: number;

export interface OutboxOptions {
    /** 通常是 `connection.send`：发出返回 true，连接不在返回 false，帧太大抛 RangeError */
    send(frame: ClientFrame): boolean;
    ackTimeoutMs?: number;
}

export class Outbox {
    constructor(options: OutboxOptions);
    flush(sendable: PendingMessage[], generation: number, now: number): { sent: string[]; tooLarge: string[] };
    expired(now: number): string[];
    forget(clientId: string): void;
    reset(): void;
}
