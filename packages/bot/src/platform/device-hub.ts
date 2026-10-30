// 设备取件中心（ADR 0148）：宿主机（他的电脑）上的小程序主动来这里领任务、交结果——宿主机不用开任何入站端口。
//
// 为什么反过来：虚拟机连不上宿主机（防火墙把入站挡了，10-25 实测）；而「宿主机来取」让宿主机上的白名单永远有最终决定权，
// 就算这边被攻破，也只能往队列里放白名单内的动作，设备那一头还会再校验一遍。
//
// 协议（全部要 Authorization: Bearer <令牌>，令牌比较用恒定时间）：
//   GET  /poll?wait=N   领一个任务：有就马上回 200 {id, action, params}；没有就挂着最多 N 秒（上限 25），到点回 204。同一时刻只认一个取件者
//   POST /result        交结果：{id, ok, error?, mime?, imageBase64?}；图片只收 PNG / JPEG（检查文件头和大小）
// 别的路径、方法一律 404 / 405。没人取件（60 秒内没来过）时，提交的任务马上失败，不排队。

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { DispatchResult, Params } from './device-actions.ts';

export interface HubOptions {
    host: string;
    port: number;
    token: string;
    log: (message: string) => void;
    now?: () => number;
    /** 认证失败：10 分钟内累计到 5 次就调一次（调用方去熔断） */
    onTamper?: (failures: number) => void;
    /** 取件的最长等待（毫秒），默认 25 秒；测试调小 */
    pollWaitMaxMs?: number;
    /** 图片最大字节数，默认 6 MB */
    maxImageBytes?: number;
    /** 手机端伴侣 app 推上来的屏幕帧存这里（不传就不开这个入口） */
    phoneFramesDir?: string;
}

export interface DeviceHub {
    start(): Promise<void>;
    stop(): Promise<void>;
    /** 提交一个任务并等结果；没人取件、没人领、超时都返回 ok:false */
    submit(job: { action: string; params: Params }, timeoutMs?: number): Promise<DispatchResult>;
    /** 60 秒内有取件者来过 */
    online(): boolean;
    /** 实际监听的端口（传 0 时由系统分配） */
    port(): number;
}

interface Waiting {
    id: string;
    action: string;
    params: Params;
    resolve: (result: DispatchResult) => void;
    timer: ReturnType<typeof setTimeout>;
    delivered: boolean;
}

const ONLINE_MS = 60_000;
const PICKUP_MS = 20_000;
export const DEFAULT_SUBMIT_TIMEOUT_MS = 30_000;
const MAX_BODY = 8 * 1024 * 1024;

const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPEG = [0xff, 0xd8, 0xff];
const startsWith = (bytes: Uint8Array, magic: readonly number[]) => magic.every((byte, i) => bytes[i] === byte);

export function createDeviceHub(options: HubOptions): DeviceHub {
    const now = options.now ?? Date.now;
    const maxImage = options.maxImageBytes ?? 6 * 1024 * 1024;
    const expected = Buffer.from(options.token);
    const pollMax = options.pollWaitMaxMs ?? 25_000;
    const queue: Waiting[] = [];
    const inFlight = new Map<string, Waiting>();
    let parked: { res: ServerResponse; timer: ReturnType<typeof setTimeout> } | undefined;
    let lastPollAt = 0;
    const authFailures: number[] = [];
    let server: Server | undefined;

    const authorized = (req: IncomingMessage): boolean => {
        const header = req.headers.authorization ?? '';
        const given = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '');
        return given.length === expected.length && timingSafeEqual(given, expected);
    };
    const finish = (waiting: Waiting, result: DispatchResult) => { clearTimeout(waiting.timer); inFlight.delete(waiting.id); resolveSafe(waiting, result); };
    const resolveSafe = (waiting: Waiting, result: DispatchResult) => { try { waiting.resolve(result); } catch { /* 调用方已经不等了 */ } };
    const json = (res: ServerResponse, status: number, body?: unknown) => {
        res.writeHead(status, body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(body === undefined ? undefined : JSON.stringify(body));
    };

    function deliver(res: ServerResponse): boolean {
        const next = queue.shift();
        if (!next) return false;
        next.delivered = true;
        clearTimeout(next.timer);
        next.timer = setTimeout(() => finish(next, { ok: false, error: '电脑那头没交回结果' }), DEFAULT_SUBMIT_TIMEOUT_MS);
        inFlight.set(next.id, next);
        json(res, 200, { id: next.id, action: next.action, params: next.params });
        return true;
    }

    function handlePoll(req: IncomingMessage, res: ServerResponse, url: URL): void {
        lastPollAt = now();
        if (parked) { clearTimeout(parked.timer); json(parked.res, 204); parked = undefined; } // 只认最新的一个取件者
        if (deliver(res)) return;
        const wait = Math.min(Math.max(Number(url.searchParams.get('wait') ?? 0) * 1000 || 0, 0), pollMax);
        if (wait === 0) { json(res, 204); return; }
        const timer = setTimeout(() => { if (parked?.res === res) parked = undefined; json(res, 204); }, wait);
        parked = { res, timer };
        res.on('close', () => { if (parked?.res === res) { clearTimeout(timer); parked = undefined; } });
    }

    async function readBody(req: IncomingMessage): Promise<string | undefined> {
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
            size += (chunk as Buffer).length;
            if (size > MAX_BODY) return undefined;
            chunks.push(chunk as Buffer);
        }
        return Buffer.concat(chunks).toString('utf8');
    }

    async function handleResult(req: IncomingMessage, res: ServerResponse): Promise<void> {
        const text = await readBody(req);
        if (text === undefined) { json(res, 413, { error: '太大' }); return; }
        let body: { id?: unknown; ok?: unknown; error?: unknown; mime?: unknown; imageBase64?: unknown };
        try { body = JSON.parse(text); } catch { json(res, 400, { error: '不是 JSON' }); return; }
        const waiting = typeof body.id === 'string' ? inFlight.get(body.id) : undefined;
        if (!waiting) { json(res, 404, { error: '没有这个任务（可能已经超时）' }); return; }
        if (body.ok !== true) {
            finish(waiting, { ok: false, error: typeof body.error === 'string' ? body.error.slice(0, 120) : '没成' });
            json(res, 200, { ok: true });
            return;
        }
        if (body.imageBase64 === undefined) { finish(waiting, { ok: true }); json(res, 200, { ok: true }); return; }
        const mime = body.mime === 'image/jpeg' ? 'image/jpeg' : body.mime === 'image/png' ? 'image/png' : undefined;
        const bytes = typeof body.imageBase64 === 'string' && /^[A-Za-z0-9+/=\r\n]+$/.test(body.imageBase64) ? Buffer.from(body.imageBase64, 'base64') : undefined;
        if (!mime || !bytes || bytes.length === 0 || bytes.length > maxImage || !startsWith(bytes, mime === 'image/png' ? PNG : JPEG)) {
            finish(waiting, { ok: false, error: '回来的图片不合格（只收 PNG / JPEG，且不能太大）' });
            json(res, 422, { error: '图片不合格' });
            return;
        }
        finish(waiting, { ok: true, dataUrl: `data:${mime};base64,${bytes.toString('base64')}` });
        json(res, 200, { ok: true });
    }

    /**
     * 手机屏幕帧（2026-10-30「手机端伴侣 app」）：app 主动推上来，存成 latest.jpg / latest.png + latest.json。
     * 只认令牌、只收 JPEG / PNG、只留最后一帧（不攒历史，免得手机画面在磁盘上越积越多）。
     */
    async function handlePhoneFrame(req: IncomingMessage, res: ServerResponse): Promise<void> {
        if (!options.phoneFramesDir) { json(res, 404, { error: '没有这个入口' }); return; }
        const text = await readBody(req);
        if (text === undefined) { json(res, 413, { error: '太大' }); return; }
        let body: { mime?: unknown; imageBase64?: unknown; at?: unknown };
        try { body = JSON.parse(text); } catch { json(res, 400, { error: '不是 JSON' }); return; }
        const mime = body.mime === 'image/jpeg' ? 'image/jpeg' : body.mime === 'image/png' ? 'image/png' : undefined;
        const base64 = typeof body.imageBase64 === 'string' && /^[A-Za-z0-9+/=\s]+$/.test(body.imageBase64) ? Buffer.from(body.imageBase64, 'base64') : undefined;
        if (!mime || !base64 || !base64.length || base64.length > maxImage || !startsWith(base64, mime === 'image/png' ? PNG : JPEG)) {
            json(res, 422, { error: '这一帧不合格（只收 PNG / JPEG）' });
            return;
        }
        try {
            mkdirSync(options.phoneFramesDir, { recursive: true });
            const file = join(options.phoneFramesDir, mime === 'image/png' ? 'latest.png' : 'latest.jpg');
            writeFileSync(file, base64);
            writeFileSync(join(options.phoneFramesDir, 'latest.json'), JSON.stringify({ mime, at: typeof body.at === 'number' ? body.at : now(), bytes: base64.length }));
            json(res, 200, { ok: true });
        } catch {
            json(res, 500, { error: '存不下' });
        }
    }

    const handler = (req: IncomingMessage, res: ServerResponse): void => {
        const url = new URL(req.url ?? '/', 'http://hub.local');
        if (!authorized(req)) {
            const t = now();
            authFailures.push(t);
            while (authFailures.length && authFailures[0]! <= t - 600_000) authFailures.shift();
            if (authFailures.length === 5) options.onTamper?.(authFailures.length);
            json(res, 401, { error: '令牌不对' });
            return;
        }
        if (req.method === 'GET' && url.pathname === '/poll') { handlePoll(req, res, url); return; }
        if (req.method === 'POST' && url.pathname === '/frame') { handlePhoneFrame(req, res).catch(() => { try { json(res, 500, { error: '出错了' }); } catch { /* 连接已断 */ } }); return; }
        if (req.method === 'POST' && url.pathname === '/result') { handleResult(req, res).catch(() => { try { json(res, 500, { error: '出错了' }); } catch { /* 连接已断 */ } }); return; }
        json(res, url.pathname === '/poll' || url.pathname === '/result' || url.pathname === '/frame' ? 405 : 404, { error: '没有这个入口' });
    };

    return {
        start() {
            return new Promise((resolve, reject) => {
                server = createServer(handler);
                server.once('error', reject);
                server.listen(options.port, options.host, () => { server!.off('error', reject); options.log(`设备取件中心：监听 ${options.host}:${(server!.address() as { port: number }).port}`); resolve(); });
            });
        },
        stop() {
            for (const waiting of [...queue, ...inFlight.values()]) finish(waiting, { ok: false, error: '取件中心关了' });
            queue.length = 0;
            if (parked) { clearTimeout(parked.timer); json(parked.res, 204); parked = undefined; }
            return new Promise(resolve => { if (!server) { resolve(); return; } server.closeAllConnections(); server.close(() => resolve()); });
        },
        submit(job, timeoutMs = DEFAULT_SUBMIT_TIMEOUT_MS) {
            if (now() - lastPollAt > ONLINE_MS) return Promise.resolve({ ok: false, error: '电脑那头没上线' });
            return new Promise<DispatchResult>(resolve => {
                const waiting: Waiting = {
                    id: randomBytes(8).toString('hex'), action: job.action, params: job.params, resolve, delivered: false,
                    timer: setTimeout(() => { const at = queue.indexOf(waiting); if (at >= 0) queue.splice(at, 1); finish(waiting, { ok: false, error: '电脑那头没来领' }); }, Math.min(timeoutMs, PICKUP_MS)),
                };
                if (parked) {
                    const { res, timer } = parked;
                    parked = undefined;
                    clearTimeout(timer);
                    waiting.delivered = true;
                    clearTimeout(waiting.timer);
                    waiting.timer = setTimeout(() => finish(waiting, { ok: false, error: '电脑那头没交回结果' }), timeoutMs);
                    inFlight.set(waiting.id, waiting);
                    json(res, 200, { id: waiting.id, action: waiting.action, params: waiting.params });
                    return;
                }
                queue.push(waiting);
            });
        },
        online: () => now() - lastPollAt <= ONLINE_MS,
        port: () => (server?.address() as { port: number } | null)?.port ?? options.port,
    };
}
