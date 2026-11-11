// 上游：连到 NapCat 的 OneBot 11 正向 WS（中继是客户端）。可选；断了按退避重连。
import { WebSocket } from 'ws';
import { failed, upstreamOffline } from './core.ts';
import type { UpstreamPort } from './core.ts';
import { isRecord } from './types.ts';
import type { Log, OneBotResponse } from './types.ts';

export interface UpstreamOptions {
    url: string;
    /** 和 Koishi 这一侧同一个 QQBOT_ONEBOT_TOKEN；不进日志 */
    token?: string;
    /** 事件：raw 是 NapCat 发来的原文（透传用），event 是解析后的对象 */
    onEvent(raw: string, event: Record<string, unknown>): void;
    onState(connected: boolean): void;
    log: Log;
    /** 等一个动作响应的时间 */
    timeoutMs?: number;
    /** 重连间隔，一次比一次长，用完停在最后一个 */
    backoffMs?: readonly number[];
}

export interface Upstream extends UpstreamPort {
    stop(): void;
}

const MAX_PAYLOAD = 64 * 1024 * 1024;

export function connectUpstream(options: UpstreamOptions): Upstream {
    const timeoutMs = options.timeoutMs ?? 30_000;
    const backoff = options.backoffMs?.length ? options.backoffMs : [1000, 2000, 5000, 10_000, 30_000];
    const pending = new Map<string, { resolve(response: OneBotResponse): void; timer: NodeJS.Timeout }>();
    let socket: WebSocket | undefined;
    let open = false;
    let stopped = false;
    let attempts = 0;
    let counter = 0;
    let retry: NodeJS.Timeout | undefined;

    const settleAll = () => {
        for (const [echo, entry] of pending) {
            clearTimeout(entry.timer);
            entry.resolve(upstreamOffline());
            pending.delete(echo);
        }
    };

    const connect = () => {
        if (stopped) return;
        const current = new WebSocket(options.url, {
            maxPayload: MAX_PAYLOAD,
            handshakeTimeout: 10_000,
            ...(options.token ? { headers: { Authorization: `Bearer ${options.token}` } } : {}),
        });
        socket = current;
        current.on('open', () => {
            open = true;
            attempts = 0;
            options.log('上游已连上');
            options.onState(true);
        });
        current.on('message', (data, isBinary) => {
            if (isBinary) return;
            const raw = data.toString();
            let parsed: unknown;
            try { parsed = JSON.parse(raw); } catch { return; }
            if (!isRecord(parsed)) return;
            if ('post_type' in parsed) { options.onEvent(raw, parsed); return; }
            const entry = typeof parsed.echo === 'string' ? pending.get(parsed.echo) : undefined;
            if (!entry) return;
            pending.delete(parsed.echo as string);
            clearTimeout(entry.timer);
            const { echo: _echo, ...response } = parsed;
            // 原样交回去（透传不改任何字段），只去掉中继自己的 echo
            entry.resolve(response as OneBotResponse);
        });
        // 没有 error 监听的话连接失败会让进程崩掉；细节不进日志（地址里可能带凭据）
        current.on('error', () => {});
        current.on('close', () => {
            if (socket !== current) return;
            const was = open;
            open = false;
            socket = undefined;
            settleAll();
            if (was) {
                options.log('上游断开');
                options.onState(false);
            }
            if (stopped) return;
            const delay = backoff[Math.min(attempts, backoff.length - 1)]!;
            attempts++;
            retry = setTimeout(connect, delay);
        });
    };
    connect();

    return {
        connected: () => open,
        call(action, params) {
            const current = socket;
            if (!open || !current) return Promise.resolve(upstreamOffline());
            // 自己编 echo：几个 Koishi 连接各自的 echo 可能相同；回给 Koishi 时由服务端换回它原来的
            const echo = `relay:${++counter}`;
            return new Promise<OneBotResponse>(resolve => {
                const timer = setTimeout(() => {
                    pending.delete(echo);
                    resolve(failed(1404, 'upstream timeout'));
                }, timeoutMs);
                pending.set(echo, { resolve, timer });
                current.send(JSON.stringify({ action, params, echo }), error => {
                    if (!error || !pending.delete(echo)) return;
                    clearTimeout(timer);
                    resolve(upstreamOffline());
                });
            });
        },
        stop() {
            stopped = true;
            clearTimeout(retry);
            const current = socket;
            if (current) {
                // 握手还没完成时 close() 会抛错，用 terminate
                if (current.readyState === WebSocket.OPEN) current.close();
                else current.terminate();
            }
            if (open) {
                open = false;
                options.onState(false);
            }
            settleAll();
        },
    };
}

/** 没配上游：永远不在 */
export const noUpstream: Upstream = {
    connected: () => false,
    call: () => Promise.resolve(upstreamOffline()),
    stop() {},
};
