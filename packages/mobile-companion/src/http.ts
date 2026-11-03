import type { IncomingMessage, ServerResponse } from 'node:http';
import type { CompanionRuntime } from './runtime.ts';

export interface CompanionHttpOptions {
    path?: string;
    maxBodyBytes?: number;
}

/**
 * 严格的 JSON POST 适配器：由宿主决定是否放在 HTTPS / loopback 上。
 * 适配器不监听端口、不设置 CORS，也不绕过 CompanionRuntime 的配对和 nonce 校验。
 */
export function createCompanionHttpHandler(runtime: CompanionRuntime, options: CompanionHttpOptions = {}) {
    const path = options.path ?? '/companion/v1/envelope';
    const maxBodyBytes = options.maxBodyBytes ?? 1_000_000;
    if (!/^\/[A-Za-z0-9/_-]{1,120}$/.test(path)) throw new Error('HTTP 路径不合法');
    if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1024 || maxBodyBytes > 8 * 1024 * 1024) throw new Error('HTTP body 上限不合法');

    return (request: IncomingMessage, response: ServerResponse): void => {
        const requestedSession = request.headers['x-companion-session'];
        const [requestPath = ''] = (request.url ?? '').split('?', 1);
        if (requestPath !== path) return writeJson(response, 404, { error: 'not_found' });
        if (request.method !== 'POST') {
            response.setHeader('Allow', 'POST');
            return writeJson(response, 405, { error: 'method_not_allowed' });
        }
        if (Array.isArray(requestedSession)) return writeJson(response, 400, { error: 'duplicate_session_header' });
        const sessionId = requestedSession ? requestedSession : runtime.createSession();
        const [contentTypeHeader = ''] = String(request.headers['content-type'] ?? '').split(';', 1);
        const contentType = contentTypeHeader.trim().toLowerCase();
        if (contentType !== 'application/json') return writeJson(response, 415, { error: 'content_type_must_be_json' });

        let size = 0;
        const chunks: Buffer[] = [];
        let ended = false;
        const rejectTooLarge = () => {
            if (ended) return;
            ended = true;
            // 不移除宿主可能挂在同一个 IncomingMessage 上的监听器；继续 drain，避免连接半开。
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
        request.on('error', () => {
            if (!ended) { ended = true; writeJson(response, 400, { error: 'request_body_error' }); }
        });
        request.on('end', () => {
            if (ended) return;
            ended = true;
            let body: unknown;
            try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
            catch { writeJson(response, 400, { error: 'invalid_json' }); return; }
            void runtime.handle(body, sessionId).then(result => {
                if (!result.accepted) return writeJson(response, 400, { error: result.error });
                response.setHeader('x-companion-session', sessionId);
                if (!result.response) { response.statusCode = 204; response.end(); return; }
                writeJson(response, 200, result.response);
            }).catch(() => writeJson(response, 500, { error: 'runtime_error' }));
        });
    };
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
    if (response.headersSent) return;
    response.statusCode = status;
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.end(JSON.stringify(value));
}
