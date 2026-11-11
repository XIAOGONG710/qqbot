// 面向手机 App 的 HTTP + WebSocket（同一个端口，ADR 0337 第 4 节）。
// - /ws：第一帧 hello 带凭据；补发 since 之后的，再发 ready；
// - /api/pair 不要凭据，其余 /api/* 都要 Authorization: Bearer <deviceId>.<token>；
// - 其它路径是 chat-app 的静态文件（App 的壳，里面没有私人数据，配对之前就得能打开，所以不要凭据）。
// 日志里不出现凭据、配对码和消息内容。
import { createReadStream, realpathSync, statSync } from 'node:fs';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import type { WebSocket } from 'ws';
import type { RelayCore } from './core.ts';
import type { DeviceStore } from './devices.ts';
import type { Ledger } from './ledger.ts';
import { MAX_MEDIA_BYTES, MediaError, allowedMime } from './media.ts';
import type { MediaStore } from './media.ts';
import { isRecord } from './types.ts';
import type { Clock, ErrorCode, Log, ServerFrame } from './types.ts';

export const MAX_FRAME_BYTES = 64 * 1024;
/** hello 之后一次最多补发这么多条（更早的用 /api/history 往前翻） */
export const REPLAY_MAX = 1000;
const HELLO_TIMEOUT_MS = 10_000;
const MAX_CONNECTIONS = 16;
const PAIR_BODY_MAX = 4 * 1024;

export interface AppServerOptions {
    port: number;
    host: string;
    staticDir: string;
    selfName: string;
    devices: DeviceStore;
    ledger: Ledger;
    media: MediaStore;
    core: RelayCore;
    log: Log;
    now?: Clock;
    /** 多久核对一次已连接设备有没有被撤销 */
    revokeSweepMs?: number;
}

export interface AppServer {
    readonly port: number;
    broadcast(frame: ServerFrame): void;
    stop(): Promise<void>;
}

/** 令牌桶：capacity 个起步，每秒补 refillPerSecond 个 */
export function tokenBucket(capacity: number, refillPerSecond: number, now: Clock): () => boolean {
    let tokens = capacity;
    let last = now();
    return () => {
        const current = now();
        tokens = Math.min(capacity, tokens + Math.max(0, current - last) / 1000 * refillPerSecond);
        last = current;
        if (tokens < 1) return false;
        tokens -= 1;
        return true;
    };
}

const STATIC_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
    '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
};
/** 包里不是给浏览器的东西：不发 */
const STATIC_DENIED = new Set(['package.json', 'package-lock.json', 'tsconfig.json', 'node_modules', 'test']);

/**
 * 请求路径 → 静态目录里的一个文件。越出目录、点文件、白名单外的类型一律返回 undefined。
 * 单独导出是为了测试。
 */
export function resolveStatic(root: string, rawPath: string): { path: string; type: string } | undefined {
    let decoded: string;
    try { decoded = decodeURIComponent(rawPath); } catch { return undefined; }
    if (decoded.includes('\0') || decoded.includes('\\') || !decoded.startsWith('/')) return undefined;
    const parts = decoded.split('/').filter(Boolean);
    if (parts.some(part => part.startsWith('.') || part.includes(':') || STATIC_DENIED.has(part))) return undefined;
    if (!parts.length || decoded.endsWith('/')) parts.push('index.html');
    const name = parts.at(-1)!;
    const type = STATIC_TYPES[extname(name).toLowerCase()];
    if (!type) return undefined;
    const base = resolve(root);
    const path = resolve(join(base, ...parts));
    if (!path.startsWith(base + sep)) return undefined;
    try {
        // 符号链接指到目录外面的也不给
        const real = realpathSync(path);
        const realBase = realpathSync(base);
        if (!real.startsWith(realBase + sep) || !statSync(real).isFile()) return undefined;
        return { path: real, type };
    } catch { return undefined; }
}

/** `Bearer <deviceId>.<token>` */
function bearer(req: IncomingMessage): { deviceId: string; token: string } | undefined {
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ')) return undefined;
    const value = header.slice('Bearer '.length).trim();
    const dot = value.indexOf('.');
    if (dot <= 0) return undefined;
    return { deviceId: value.slice(0, dot), token: value.slice(dot + 1) };
}

class HttpError extends Error {
    status: number;
    code: ErrorCode | 'not_found';
    constructor(status: number, code: ErrorCode | 'not_found', message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

/** 读请求体，超过 limit 就断 */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
    return new Promise((done, fail) => {
        if (Number(req.headers['content-length'] ?? 0) > limit) { fail(new HttpError(413, 'too_large', '太大了')); req.resume(); return; }
        const chunks: Buffer[] = [];
        let total = 0;
        req.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > limit) {
                fail(new HttpError(413, 'too_large', '太大了'));
                req.removeAllListeners('data');
                req.resume();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => done(Buffer.concat(chunks)));
        req.on('error', () => fail(new HttpError(400, 'bad_request', '请求没读完')));
    });
}

export async function startAppServer(options: AppServerOptions): Promise<AppServer> {
    const { devices, ledger, media, core, log } = options;
    const now = options.now ?? Date.now;
    /** 已经 hello 过的连接 */
    const clients = new Map<WebSocket, string>();
    const all = new Set<WebSocket>();
    const httpBuckets = new Map<string, { read: () => boolean; write: () => boolean }>();
    const pairBucket = tokenBucket(10, 10 / 60, now);

    const json = (res: ServerResponse, status: number, body: unknown) => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) });
        res.end(text);
    };

    /** 核对凭据并按设备限流；不过就抛 HttpError */
    const authorize = (req: IncomingMessage, kind: 'read' | 'write'): string => {
        const credentials = bearer(req);
        if (!credentials || !devices.verify(credentials.deviceId, credentials.token)) throw new HttpError(401, 'unauthorized', '凭据不对，重新配对');
        let buckets = httpBuckets.get(credentials.deviceId);
        if (!buckets) {
            buckets = { read: tokenBucket(200, 50, now), write: tokenBucket(30, 0.5, now) };
            httpBuckets.set(credentials.deviceId, buckets);
        }
        if (!buckets[kind]()) throw new HttpError(429, 'rate_limited', '太快了，等一下');
        return credentials.deviceId;
    };

    async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
        // 不让 //host/path 这种写法被当成别的主机
        const target = req.url ?? '/';
        const url = new URL(target.startsWith('/') ? `http://relay.invalid${target}` : 'http://relay.invalid/');
        const path = url.pathname;
        if (path.startsWith('/api/')) {
            res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
            if (path === '/api/pair' && req.method === 'POST') {
                if (!pairBucket()) throw new HttpError(429, 'rate_limited', '太快了，等一下');
                let body: unknown;
                try { body = JSON.parse((await readBody(req, PAIR_BODY_MAX)).toString('utf8')); } catch (error) {
                    if (error instanceof HttpError) throw error;
                    throw new HttpError(400, 'bad_request', '请求体不是 JSON');
                }
                if (!isRecord(body)) throw new HttpError(400, 'bad_request', '请求体不是对象');
                const result = devices.pair(body.code, body.deviceName);
                if (!result.ok) {
                    log('一次配对没有成功');
                    // 不告诉对方是码不对还是已经作废
                    throw new HttpError(result.reason === 'full' ? 400 : 401, result.reason === 'full' ? 'bad_request' : 'unauthorized',
                        result.reason === 'full' ? '设备太多了，先撤销一台' : '配对码不对或已失效，在电脑上重新生成一个');
                }
                log('一台新设备配对成功');
                json(res, 200, { deviceId: result.deviceId, token: result.token });
                return;
            }
            if (path === '/api/media' && req.method === 'POST') {
                authorize(req, 'write');
                const mime = allowedMime(req.headers['content-type']);
                if (!mime) { req.resume(); throw new HttpError(400, 'bad_request', '不收这种文件'); }
                const bytes = await readBody(req, MAX_MEDIA_BYTES);
                try {
                    json(res, 200, { mediaId: media.put(bytes, { mime }).id });
                } catch (error) {
                    if (error instanceof MediaError) throw new HttpError(error.code === 'too_large' ? 413 : 400, error.code === 'too_large' ? 'too_large' : 'bad_request', error.message);
                    throw error;
                }
                return;
            }
            const mediaMatch = /^\/api\/media\/([^/]+)$/.exec(path);
            if (mediaMatch && (req.method === 'GET' || req.method === 'HEAD')) {
                authorize(req, 'read');
                const info = media.get(mediaMatch[1]);
                if (!info) throw new HttpError(404, 'not_found', '没有这个媒体');
                res.writeHead(200, { 'Content-Type': info.mime, 'Content-Length': info.size });
                if (req.method === 'HEAD') { res.end(); return; }
                createReadStream(info.path).on('error', () => res.destroy()).pipe(res);
                return;
            }
            if (path === '/api/history' && req.method === 'GET') {
                authorize(req, 'read');
                const beforeRaw = url.searchParams.get('before');
                const limitRaw = url.searchParams.get('limit');
                const before = beforeRaw === null ? ledger.seq + 1 : Number(beforeRaw);
                const limit = limitRaw === null ? 50 : Number(limitRaw);
                if (!Number.isSafeInteger(before) || before < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
                    throw new HttpError(400, 'bad_request', 'before 要是非负整数，limit 要在 1 到 100 之间');
                }
                const page = ledger.before(before, limit);
                json(res, 200, { messages: page.messages, events: page.events.map(entry => ({ seq: entry.seq, event: entry.event })) });
                return;
            }
            throw new HttpError(404, 'not_found', '没有这个接口');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(404, 'not_found', '没有这个地址');
        const file = resolveStatic(options.staticDir, path);
        if (!file) throw new HttpError(404, 'not_found', '没有这个文件');
        // 壳要能随时更新：不让浏览器拿旧的 index.html / service worker 顶着
        res.setHeader('Cache-Control', /\.html$|(^|[\\/])sw\.js$/.test(file.path) ? 'no-store' : 'no-cache');
        res.writeHead(200, { 'Content-Type': file.type, 'Content-Length': statSync(file.path).size });
        if (req.method === 'HEAD') { res.end(); return; }
        createReadStream(file.path).on('error', () => res.destroy()).pipe(res);
    }

    const server = http.createServer((req, res) => {
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        res.setHeader('X-Frame-Options', 'DENY');
        handle(req, res).catch(error => {
            if (res.headersSent) { res.destroy(); return; }
            if (error instanceof HttpError) { json(res, error.status, { error: error.code, message: error.message }); return; }
            log('处理一个 HTTP 请求时出错');
            json(res, 500, { error: 'bad_request', message: '中继出错了' });
        });
    });
    server.requestTimeout = 120_000;
    server.headersTimeout = 20_000;

    // 协议上限是 64 KiB：超过的回一条 too_large；远超的由 ws 直接断开
    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES * 4 });
    server.on('upgrade', (req, socket, head) => {
        socket.on('error', () => {});
        const path = new URL(req.url ?? '/', 'http://relay.invalid').pathname;
        if (path !== '/ws' || all.size >= MAX_CONNECTIONS) {
            socket.end(`HTTP/1.1 ${path === '/ws' ? '503 Service Unavailable' : '404 Not Found'}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
            return;
        }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
    });

    const send = (socket: WebSocket, frame: ServerFrame) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    };

    wss.on('connection', (socket: WebSocket) => {
        all.add(socket);
        let alive = true;
        const bucket = tokenBucket(20, 2, now);
        const helloTimer = setTimeout(() => { if (!clients.has(socket)) socket.close(1008, 'hello timeout'); }, HELLO_TIMEOUT_MS);
        const heartbeat = setInterval(() => {
            if (!alive) { socket.terminate(); return; }
            alive = false;
            socket.ping();
        }, 30_000);
        socket.on('pong', () => { alive = true; });
        socket.on('error', () => {});
        socket.on('close', () => {
            clearTimeout(helloTimer);
            clearInterval(heartbeat);
            all.delete(socket);
            if (clients.delete(socket)) log(`一台设备断开（剩 ${clients.size}）`);
        });
        socket.on('message', (data, isBinary) => {
            alive = true;
            const raw = isBinary ? undefined : data.toString();
            if (raw === undefined) { send(socket, { type: 'error', code: 'bad_request', message: '只收 JSON 文本帧' }); return; }
            if (Buffer.byteLength(raw) > MAX_FRAME_BYTES) { send(socket, { type: 'error', code: 'too_large', message: '单帧不能超过 64 KiB' }); return; }
            let frame: unknown;
            try { frame = JSON.parse(raw); } catch { frame = undefined; }
            if (!isRecord(frame) || typeof frame.type !== 'string') { send(socket, { type: 'error', code: 'bad_request', message: '看不懂这一帧' }); return; }

            if (!clients.has(socket)) {
                // 第一帧必须是 hello；凭据不对就断
                if (frame.type !== 'hello' || !devices.verify(frame.deviceId, frame.token)) {
                    send(socket, { type: 'error', code: 'unauthorized', message: '凭据不对，重新配对' });
                    socket.close(1008, 'unauthorized');
                    return;
                }
                const since = typeof frame.since === 'number' && Number.isSafeInteger(frame.since) && frame.since >= 0 ? frame.since : 0;
                for (const entry of ledger.after(since, REPLAY_MAX)) {
                    send(socket, 'message' in entry ? { type: 'message', message: entry.message } : { type: 'event', seq: entry.event.seq, event: entry.event.event });
                }
                send(socket, { type: 'ready', seq: ledger.seq, self: { name: options.selfName }, upstream: core.upstreamState() });
                clients.set(socket, frame.deviceId as string);
                clearTimeout(helloTimer);
                log(`一台设备连上（当前 ${clients.size}）`);
                return;
            }

            if (frame.type === 'ping') { send(socket, { type: 'pong' }); return; }
            if (frame.type !== 'send' && frame.type !== 'recall' && frame.type !== 'poke') {
                send(socket, { type: 'error', code: 'bad_request', message: '不认识的帧' });
                return;
            }
            const clientId = frame.type === 'send' && typeof frame.clientId === 'string' && frame.clientId.length <= 64 ? frame.clientId : undefined;
            if (!bucket()) {
                send(socket, { type: 'error', code: 'rate_limited', message: '太快了，等一下', ...(clientId !== undefined ? { clientId } : {}) });
                return;
            }
            core.appCommand(frame).then(frames => { for (const reply of frames) send(socket, reply); }, () => {
                log('处理 App 的一帧时出错');
                send(socket, { type: 'error', code: 'not_delivered', message: '中继出错了，这条没有交给她', ...(clientId !== undefined ? { clientId } : {}) });
            });
        });
    });

    // 设备被撤销（另一个进程改了 devices.json）后，已经连着的那条也要断
    const sweep = setInterval(() => {
        const known = new Set(devices.list().map(device => device.id));
        for (const [socket, deviceId] of clients) {
            if (known.has(deviceId)) continue;
            send(socket, { type: 'error', code: 'unauthorized', message: '这台设备已被撤销' });
            socket.close(1008, 'revoked');
        }
        for (const deviceId of httpBuckets.keys()) if (!known.has(deviceId)) httpBuckets.delete(deviceId);
    }, options.revokeSweepMs ?? 5000);

    await new Promise<void>((done, fail) => {
        server.once('error', fail);
        server.listen(options.port, options.host, () => { server.off('error', fail); done(); });
    });

    return {
        port: (server.address() as AddressInfo).port,
        broadcast(frame) {
            const text = JSON.stringify(frame);
            for (const socket of clients.keys()) if (socket.readyState === socket.OPEN) socket.send(text);
        },
        async stop() {
            clearInterval(sweep);
            for (const socket of all) socket.terminate();
            wss.close();
            server.closeAllConnections();
            await new Promise<void>(done => server.close(() => done()));
        },
    };
}
