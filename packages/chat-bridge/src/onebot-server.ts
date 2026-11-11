// 面向 Koishi 的 OneBot 11 正向 WS 服务端（中继在 Koishi 眼里就是 NapCat）。
// 同一个端口上还有一个只给本机用的 GET /media/<id>：事件里 image / record 段的 url 指到这里。
import { createHash, timingSafeEqual } from 'node:crypto';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import { failed } from './core.ts';
import type { MediaStore } from './media.ts';
import { isRecord } from './types.ts';
import type { Log, OneBotResponse } from './types.ts';

export interface OneBotServerOptions {
    port: number;
    /** 设了就要求 Authorization: Bearer <token> */
    token?: string;
    selfId: number;
    media: MediaStore;
    onAction(action: string, params: unknown): Promise<OneBotResponse>;
    log: Log;
    now?: () => number;
}

export interface OneBotServer {
    readonly port: number;
    connected(): boolean;
    /** 推一个事件给所有 Koishi 连接 */
    push(event: Record<string, unknown>): void;
    /** 原文透传（上游来的事件一个字节不改） */
    pushRaw(text: string): void;
    stop(): Promise<void>;
}

const MAX_PAYLOAD = 64 * 1024 * 1024;
const isLoopback = (address: string | undefined): boolean => address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

/** 恒定时间比较：先各自做摘要，长度不同也不提前退出 */
export function sameSecret(a: string, b: string): boolean {
    const digest = (text: string) => createHash('sha256').update(text, 'utf8').digest();
    return timingSafeEqual(digest(a), digest(b));
}

export async function startOneBotServer(options: OneBotServerOptions): Promise<OneBotServer> {
    const { token, media, log } = options;
    const now = options.now ?? Date.now;
    const sockets = new Set<WebSocket>();

    const server = http.createServer((req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        const match = req.method === 'GET' ? /^\/media\/([A-Za-z0-9_-]+)$/.exec(req.url ?? '') : null;
        // 只给本机（Koishi 里的她）取；经过代理转进来的请求不认
        const local = isLoopback(req.socket.remoteAddress) && req.headers['x-forwarded-for'] === undefined && req.headers.forwarded === undefined;
        const info = match && local ? media.get(match[1]) : undefined;
        if (!info) { res.writeHead(404).end(); return; }
        res.writeHead(200, { 'Content-Type': info.mime, 'Content-Length': info.size });
        createReadStream(info.path).on('error', () => res.destroy()).pipe(res);
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
    server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => {});
        const header = req.headers.authorization ?? '';
        const offered = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
        if (token && !sameSecret(offered, token)) {
            socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
            log('一个 OneBot 连接凭据不对，已拒绝');
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });

    wss.on('connection', (socket: WebSocket) => {
        sockets.add(socket);
        log(`Koishi 连上来了（当前 ${sockets.size} 个）`);
        socket.on('error', () => {});
        socket.on('close', () => { sockets.delete(socket); log(`一个 Koishi 连接断开（剩 ${sockets.size}）`); });
        socket.on('message', (data, isBinary) => {
            if (isBinary) return;
            let payload: unknown;
            try { payload = JSON.parse(data.toString()); } catch { return; }
            if (!isRecord(payload)) return;
            const echo = payload.echo;
            const reply = (response: OneBotResponse) => {
                if (socket.readyState !== socket.OPEN) return;
                socket.send(JSON.stringify(echo === undefined ? response : { ...response, echo }));
            };
            if (typeof payload.action !== 'string' || !payload.action) { reply(failed(1404, 'unknown action')); return; }
            options.onAction(payload.action, payload.params).then(reply, () => {
                log('处理一个动作时出错');
                reply(failed(1200, 'relay error'));
            });
        });
        // 和 NapCat 一样，连上先报一条生命周期事件
        socket.send(JSON.stringify({ time: Math.floor(now() / 1000), self_id: options.selfId, post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' }));
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        // Koishi 和中继在同一台机器上：这个口永远只开在本机
        server.listen(options.port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });

    const pushRaw = (text: string) => {
        for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(text);
    };

    return {
        port: (server.address() as AddressInfo).port,
        connected: () => [...sockets].some(socket => socket.readyState === socket.OPEN),
        push: event => pushRaw(JSON.stringify(event)),
        pushRaw,
        async stop() {
            for (const socket of sockets) socket.terminate();
            wss.close();
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
}
