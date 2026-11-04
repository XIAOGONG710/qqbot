import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionMediaStore } from './media.ts';
import type { CompanionRuntime } from './runtime.ts';
import { isAllowedMediaMime } from './protocol.ts';

const MEDIA_ID = /^[a-f0-9]{16,128}$/i;
const REVIEW_IMAGE_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export interface CompanionMediaHttpOptions {
    path?: string;
    maxBodyBytes?: number;
}

/** 严格的短期媒体适配器：上传和图片读取都必须带已配对 session，不写磁盘、不开放 CORS。 */
export function createCompanionMediaHandler(runtime: CompanionRuntime, store: CompanionMediaStore, options: CompanionMediaHttpOptions = {}) {
    const path = options.path ?? '/companion/v1/media';
    const maxBodyBytes = options.maxBodyBytes ?? 8 * 1024 * 1024;
    if (!/^\/[A-Za-z0-9/_-]{1,120}$/.test(path)) throw new Error('媒体 HTTP 路径不合法');
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 8 * 1024 * 1024) throw new Error('媒体 HTTP body 上限不合法');

    return (request: IncomingMessage, response: ServerResponse): void => {
        const [requestPath = ''] = (request.url ?? '').split('?', 1);
        if (requestPath !== path) return writeJson(response, 404, { error: 'not_found' });
        const session = request.headers['x-companion-session'];
        const sessionId = typeof session === 'string' ? session : '';
        const clientId = runtime.clientForSession(sessionId);
        if (!clientId) return writeJson(response, 401, { error: 'session_required' });
        if (request.method === 'GET') {
            const rawMediaId = request.headers['x-companion-media-id'];
            const mediaId = typeof rawMediaId === 'string' ? rawMediaId : '';
            if (!MEDIA_ID.test(mediaId)) return writeJson(response, 404, { error: 'media_not_found' });
            const record = store.get(clientId, mediaId);
            if (!record || !REVIEW_IMAGE_MIMES.has(record.mime)) return writeJson(response, 404, { error: 'media_not_found' });
            if (runtime.clientForSession(sessionId) !== clientId) return writeJson(response, 401, { error: 'session_expired' });
            response.statusCode = 200;
            response.setHeader('Content-Type', record.mime);
            response.setHeader('Content-Length', record.bytes);
            response.setHeader('Cache-Control', 'private, no-store, max-age=0');
            response.setHeader('X-Content-Type-Options', 'nosniff');
            response.end(Buffer.from(record.data));
            return;
        }
        if (request.method !== 'POST') { response.setHeader('Allow', 'GET, POST'); return writeJson(response, 405, { error: 'method_not_allowed' }); }
        const mime = String(request.headers['x-companion-mime'] ?? request.headers['content-type'] ?? '').split(';', 1)[0]!.trim().toLowerCase();
        if (!isAllowedMediaMime(mime)) return writeJson(response, 415, { error: 'media_type_not_allowed' });
        const metadata = readMetadata(request.headers);
        if (!metadata.ok) return writeJson(response, 400, { error: metadata.error });

        let size = 0;
        const chunks: Buffer[] = [];
        let ended = false;
        const rejectTooLarge = () => {
            if (ended) return;
            ended = true;
            request.resume();
            writeJson(response, 413, { error: 'body_too_large' });
        };
        request.on('data', chunk => {
            if (ended) return;
            const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += buffer.length;
            if (size > maxBodyBytes) return rejectTooLarge();
            chunks.push(buffer);
        });
        request.on('error', () => { if (!ended) { ended = true; writeJson(response, 400, { error: 'request_body_error' }); } });
        request.on('end', () => {
            if (ended) return;
            ended = true;
            try {
                if (runtime.clientForSession(sessionId) !== clientId) return writeJson(response, 401, { error: 'session_expired' });
                const record = store.put({ clientId, mime, data: Buffer.concat(chunks), bytes: size, ...metadata.value });
                writeJson(response, 201, { mediaId: record.mediaId, mime: record.mime, bytes: record.bytes, expiresAt: record.expiresAt, ...(record.durationMs === undefined ? {} : { durationMs: record.durationMs }), ...(record.width === undefined ? {} : { width: record.width }), ...(record.height === undefined ? {} : { height: record.height }) });
            } catch (error) { writeJson(response, 400, { error: error instanceof Error ? error.message : String(error) }); }
        });
    };
}

function readMetadata(headers: IncomingMessage['headers']): { ok: true; value: { durationMs?: number; width?: number; height?: number } } | { ok: false; error: string } {
    const values: { durationMs?: number; width?: number; height?: number } = {};
    for (const [key, label, min, max] of [['x-companion-duration-ms', 'durationMs', 0, 2 * 60 * 60_000], ['x-companion-width', 'width', 1, 8192], ['x-companion-height', 'height', 1, 8192]] as const) {
        const raw = headers[key];
        if (raw === undefined) continue;
        const value = Number(raw);
        if (!Number.isInteger(value) || value < min || value > max) return { ok: false, error: `${label}_invalid` };
        values[label] = value;
    }
    return { ok: true, value: values };
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) return;
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.end(JSON.stringify(value));
}
