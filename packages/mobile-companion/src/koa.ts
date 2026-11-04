import type { IncomingMessage } from 'node:http';
import type { CompanionMediaStore } from './media.ts';
import type { CompanionRuntime } from './runtime.ts';
import { isAllowedMediaMime } from './protocol.ts';

const MEDIA_ID = /^[a-f0-9]{16,128}$/i;
const REVIEW_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface CompanionKoaContextLike {
    path: string;
    method: string;
    req: IncomingMessage;
    request: { body?: unknown; headers: IncomingMessage['headers'] };
    status: number;
    body?: unknown;
    set(name: string, value: string): void;
}

export interface CompanionKoaRouteOptions {
    path?: string;
    maxBodyBytes?: number;
}

/** 适配 Koishi 已有 server 端口的 JSON envelope 路由；不会监听新端口。 */
export function createCompanionKoaEnvelopeHandler(runtime: CompanionRuntime, options: CompanionKoaRouteOptions = {}) {
    const path = options.path ?? '/qqbot/companion/http';
    const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
    validatePath(path, 'HTTPS 路径');
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 8 * 1024 * 1024) throw new Error('HTTPS envelope body 上限不合法');
    return async (ctx: CompanionKoaContextLike): Promise<void> => {
        if (ctx.path !== path) return fail(ctx, 404, 'not_found');
        if (ctx.method !== 'POST') { ctx.set('Allow', 'POST'); return fail(ctx, 405, 'method_not_allowed'); }
        let serialized: string | undefined;
        try { serialized = JSON.stringify(ctx.request.body); } catch { return fail(ctx, 400, 'invalid_json'); }
        if (typeof serialized !== 'string') return fail(ctx, 400, 'invalid_json');
        if (Buffer.byteLength(serialized, 'utf8') > maxBodyBytes) return fail(ctx, 413, 'body_too_large');
        const session = header(ctx.request.headers, 'x-companion-session');
        const sessionId = session || runtime.createSession();
        const result = await runtime.handle(ctx.request.body, sessionId);
        if (!result.accepted) return fail(ctx, 400, result.error);
        ctx.set('x-companion-session', sessionId);
        if (!result.response) { ctx.status = 204; ctx.body = undefined; return; }
        ctx.status = 200;
        ctx.set('Content-Type', 'application/json; charset=utf-8');
        ctx.body = result.response;
    };
}

/** 适配 Koishi 已有 server 端口的媒体路由；GET 仅返回本设备的短期安全图片。 */
export function createCompanionKoaMediaHandler(runtime: CompanionRuntime, store: CompanionMediaStore, options: CompanionKoaRouteOptions = {}) {
    const path = options.path ?? '/qqbot/companion/http/media';
    const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
    validatePath(path, '媒体 HTTPS 路径');
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 8 * 1024 * 1024) throw new Error('媒体 HTTPS body 上限不合法');
    return async (ctx: CompanionKoaContextLike): Promise<void> => {
        if (ctx.path !== path) return fail(ctx, 404, 'not_found');
        const sessionId = header(ctx.request.headers, 'x-companion-session');
        const clientId = runtime.clientForSession(sessionId);
        if (!clientId) return fail(ctx, 401, 'session_required');
        if (ctx.method === 'GET') {
            const mediaId = header(ctx.request.headers, 'x-companion-media-id');
            if (!MEDIA_ID.test(mediaId)) return fail(ctx, 404, 'media_not_found');
            const record = store.get(clientId, mediaId);
            if (!record || !REVIEW_IMAGE_MIMES.has(record.mime)) return fail(ctx, 404, 'media_not_found');
            if (runtime.clientForSession(sessionId) !== clientId) return fail(ctx, 401, 'session_expired');
            ctx.status = 200;
            ctx.set('Content-Type', record.mime);
            ctx.set('Content-Length', String(record.bytes));
            ctx.set('Cache-Control', 'private, no-store, max-age=0');
            ctx.set('X-Content-Type-Options', 'nosniff');
            ctx.body = Buffer.from(record.data);
            return;
        }
        if (ctx.method !== 'POST') { ctx.set('Allow', 'GET, POST'); return fail(ctx, 405, 'method_not_allowed'); }
        const mime = (header(ctx.request.headers, 'x-companion-mime') || header(ctx.request.headers, 'content-type')).split(';', 1)[0]!.trim().toLowerCase();
        if (!isAllowedMediaMime(mime)) return fail(ctx, 415, 'media_type_not_allowed');
        const metadata = readMetadata(ctx.request.headers);
        if (!metadata.ok) return fail(ctx, 400, metadata.error);
        try {
            const data = await readBody(ctx.req, maxBodyBytes);
            if (runtime.clientForSession(sessionId) !== clientId) return fail(ctx, 401, 'session_expired');
            const record = store.put({ clientId, mime, data, bytes: data.length, ...metadata.value });
            ctx.status = 201;
            ctx.set('Content-Type', 'application/json; charset=utf-8');
            ctx.set('X-Content-Type-Options', 'nosniff');
            ctx.body = { mediaId: record.mediaId, mime: record.mime, bytes: record.bytes, expiresAt: record.expiresAt, ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }), ...(record.width === undefined ? {} : { width: record.width }), ...(record.height === undefined ? {} : { height: record.height }) };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            fail(ctx, message === 'body_too_large' ? 413 : 400, message);
        }
    };
}

/** 适配 HTTPS 客户端轮询宿主下发的手机动作；仍要求已配对 session。 */
export function createCompanionKoaActionPollHandler(runtime: CompanionRuntime, options: CompanionKoaRouteOptions = {}) {
    const path = options.path ?? '/qqbot/companion/http/actions';
    validatePath(path, '动作轮询路径');
    return async (ctx: CompanionKoaContextLike): Promise<void> => {
        if (ctx.path !== path) return fail(ctx, 404, 'not_found');
        if (ctx.method !== 'GET') { ctx.set('Allow', 'GET'); return fail(ctx, 405, 'method_not_allowed'); }
        const sessionId = header(ctx.request.headers, 'x-companion-session');
        const clientId = runtime.clientForSession(sessionId);
        if (!clientId) return fail(ctx, 401, 'session_required');
        ctx.status = 200;
        ctx.set('Content-Type', 'application/json; charset=utf-8');
        ctx.set('Cache-Control', 'no-store');
        ctx.body = { actions: runtime.takeDownlinks(clientId) };
    };
}

async function readBody(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > maxBytes) { request.resume(); throw new Error('body_too_large'); }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks);
}

function header(headers: IncomingMessage['headers'], name: string): string {
    const value = headers[name];
    return Array.isArray(value) ? (value.length === 1 ? value[0] ?? '' : '') : value ?? '';
}

function readMetadata(headers: IncomingMessage['headers']): { ok: true; value: { durationMs?: number; width?: number; height?: number } } | { ok: false; error: string } {
    const values: { durationMs?: number; width?: number; height?: number } = {};
    for (const [key, label, min, max] of [['x-companion-duration-ms', 'durationMs', 0, 2 * 60 * 60_000], ['x-companion-width', 'width', 1, 8192], ['x-companion-height', 'height', 1, 8192]] as const) {
        const raw = header(headers, key);
        if (!raw) continue;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < min || value > max) return { ok: false, error: `${label}_invalid` };
        values[label] = value;
    }
    return { ok: true, value: values };
}

function validatePath(path: string, label: string): void {
    if (!/^\/[A-Za-z0-9/_-]{1,120}$/.test(path)) throw new Error(`${label}不合法`);
}

function fail(ctx: CompanionKoaContextLike, status: number, error: string): void {
    ctx.status = status;
    ctx.set('Content-Type', 'application/json; charset=utf-8');
    ctx.set('X-Content-Type-Options', 'nosniff');
    ctx.body = { error };
}
