import type { ClientFrame, Credentials, ServerFrame } from './types.d.ts';

export interface SocketLike {
    send(data: string): void;
    close(): void;
    onopen: ((event: any) => void) | null;
    onmessage: ((event: { data: unknown }) => void) | null;
    onclose: ((event: any) => void) | null;
    onerror: ((event: any) => void) | null;
}

/**
 * idle 没启动 · connecting 正在连 · syncing 已发 hello、在补齐 · ready 可收发 ·
 * waiting 等下一次重连 · unauthorized 凭据被拒，不再重连
 */
export type ConnectionStatus = 'idle' | 'connecting' | 'syncing' | 'ready' | 'waiting' | 'unauthorized';

export interface ConnectionConfig {
    baseDelayMs: number;
    maxDelayMs: number;
    pingIntervalMs: number;
    pongTimeoutMs: number;
    helloTimeoutMs: number;
}

export interface StatusInfo {
    status: ConnectionStatus;
    attempt: number;
    retryAt: number;
    generation: number;
}

export interface ConnectionOptions {
    /** 开一条新的 socket（浏览器里是 `new WebSocket('/ws')`，URL 里不带凭据） */
    open(): SocketLike;
    /** 每次连上时取：凭据和手机已有的最大 seq */
    hello(): { credentials: Credentials; since: number };
    onFrame(frame: ServerFrame, generation: number): void;
    onStatus?(info: StatusInfo): void;
    setTimer?(fn: () => void, ms: number): unknown;
    clearTimer?(handle: unknown): void;
    now?(): number;
    random?(): number;
    config?: Partial<ConnectionConfig>;
}

export const DEFAULTS: Readonly<ConnectionConfig>;
export function backoffDelay(attempt: number, random: number, config?: Partial<ConnectionConfig>): number;

export class Connection {
    constructor(options: ConnectionOptions);
    status: ConnectionStatus;
    generation: number;
    attempt: number;
    retryAt: number;
    start(): void;
    stop(): void;
    /** 网络恢复或回到前台时调用 */
    kick(): void;
    /** ready 时发出并返回 true；否则 false。帧超过 64 KiB 抛 RangeError。 */
    send(frame: ClientFrame): boolean;
}
