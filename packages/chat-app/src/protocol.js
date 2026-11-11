// @ts-check
// ADR 0337 第 4 节：中继 ↔ 手机的帧。这里只做形状校验和拼帧，不碰 DOM、不碰网络。

export const MAX_FRAME_BYTES = 64 * 1024;
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_TEXT_CHARS = 4000;
export const HISTORY_PAGE = 50;
export const IMAGE_MIMES = Object.freeze(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export const AUDIO_MIMES = Object.freeze(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']);

const MEDIA_ID = /^[A-Za-z0-9._-]{1,128}$/;
const ERROR_CODES = new Set(['unauthorized', 'bad_request', 'too_large', 'rate_limited', 'not_delivered']);

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isObject = v => typeof v === 'object' && v !== null && !Array.isArray(v);
/** @param {unknown} v @returns {v is number} */
const isSeq = v => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
/** @param {unknown} v @returns {v is number} */
const isId = v => typeof v === 'number' && Number.isSafeInteger(v);
/** @param {unknown} v @returns {v is string} */
const isText = v => typeof v === 'string';

/** @param {unknown} value */
export function parsePart(value) {
    if (!isObject(value)) return undefined;
    switch (value.kind) {
        case 'text':
            return isText(value.text) ? { kind: /** @type {const} */ ('text'), text: value.text } : undefined;
        case 'face':
            if (!isId(value.id)) return undefined;
            return { kind: /** @type {const} */ ('face'), id: value.id, ...(isText(value.name) && value.name ? { name: value.name } : {}) };
        case 'image':
            if (!isText(value.mediaId) || !MEDIA_ID.test(value.mediaId)) return undefined;
            return {
                kind: /** @type {const} */ ('image'), mediaId: value.mediaId, mime: isText(value.mime) ? value.mime : 'image/jpeg',
                ...(isText(value.summary) && value.summary ? { summary: value.summary } : {}),
            };
        case 'voice':
            if (!isText(value.mediaId) || !MEDIA_ID.test(value.mediaId)) return undefined;
            return {
                kind: /** @type {const} */ ('voice'), mediaId: value.mediaId, mime: isText(value.mime) ? value.mime : 'audio/ogg',
                ...(typeof value.durationMs === 'number' && Number.isFinite(value.durationMs) && value.durationMs >= 0 ? { durationMs: value.durationMs } : {}),
            };
        case 'card':
            if (!isText(value.title)) return undefined;
            return { kind: /** @type {const} */ ('card'), title: value.title, ...(isText(value.url) && value.url ? { url: value.url } : {}) };
        case 'poke':
            return { kind: /** @type {const} */ ('poke') };
        default:
            return undefined;
    }
}

/** @param {unknown} value */
export function parseMessage(value) {
    if (!isObject(value)) return undefined;
    if (!isSeq(value.seq) || !isId(value.id)) return undefined;
    if (value.from !== 'her' && value.from !== 'me') return undefined;
    if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return undefined;
    if (!Array.isArray(value.parts)) return undefined;
    /** @type {import('./types.d.ts').Part[]} */
    const parts = [];
    for (const raw of value.parts) {
        const part = parsePart(raw);
        // 以后中继多出一种段，这一版先显示成占位文字，不整条丢掉
        parts.push(part ?? { kind: 'text', text: '[暂不支持的消息]' });
    }
    /** @type {import('./types.d.ts').Message} */
    const message = { seq: value.seq, id: value.id, from: value.from, via: value.via === 'qq' ? 'qq' : 'app', at: value.at, parts };
    if (isId(value.replyTo)) message.replyTo = value.replyTo;
    if (isText(value.clientId) && value.clientId) message.clientId = value.clientId;
    if (value.recalled === true) message.recalled = true;
    return message;
}

/** @param {unknown} value */
export function parseEvent(value) {
    if (!isObject(value)) return undefined;
    if (value.kind === 'recall' && isId(value.id)) return { kind: /** @type {const} */ ('recall'), id: value.id };
    if (value.kind === 'read' && isId(value.upTo)) return { kind: /** @type {const} */ ('read'), upTo: value.upTo };
    if (value.kind === 'reaction' && isId(value.id) && isId(value.emojiId)) return { kind: /** @type {const} */ ('reaction'), id: value.id, emojiId: value.emojiId };
    return undefined;
}

/** @param {unknown} raw @returns {import('./types.d.ts').ServerFrame | undefined} */
export function parseServerFrame(raw) {
    let value = raw;
    if (typeof raw === 'string') {
        if (raw.length > MAX_FRAME_BYTES * 2) return undefined;
        try { value = JSON.parse(raw); } catch { return undefined; }
    }
    if (!isObject(value)) return undefined;
    switch (value.type) {
        case 'ready': {
            if (!isSeq(value.seq)) return undefined;
            const self = isObject(value.self) && isText(value.self.name) ? value.self.name : '';
            return { type: 'ready', seq: value.seq, self: { name: self }, upstream: value.upstream === 'up' ? 'up' : 'down' };
        }
        case 'message': {
            const message = parseMessage(value.message);
            return message ? { type: 'message', message } : undefined;
        }
        case 'event': {
            const event = parseEvent(value.event);
            return event && isSeq(value.seq) ? { type: 'event', seq: value.seq, event } : undefined;
        }
        case 'ack':
            return isText(value.clientId) && isId(value.id) && isSeq(value.seq)
                ? { type: 'ack', clientId: value.clientId, id: value.id, seq: value.seq } : undefined;
        case 'typing':
            return { type: 'typing', on: value.on === true };
        case 'upstream':
            return value.state === 'up' || value.state === 'down' ? { type: 'upstream', state: value.state } : undefined;
        case 'pong':
            return { type: 'pong' };
        case 'error': {
            if (!isText(value.code) || !ERROR_CODES.has(value.code)) return undefined;
            return {
                type: 'error', code: /** @type {import('./types.d.ts').ErrorCode} */ (value.code),
                message: isText(value.message) ? value.message : '',
                ...(isText(value.clientId) && value.clientId ? { clientId: value.clientId } : {}),
            };
        }
        default:
            return undefined;
    }
}

/** @param {unknown} value */
export function parseHistory(value) {
    /** @type {import('./types.d.ts').Message[]} */
    const messages = [];
    /** @type {{ seq: number, event: import('./types.d.ts').LedgerEvent }[]} */
    const events = [];
    if (!isObject(value)) return { messages, events };
    if (Array.isArray(value.messages)) {
        for (const raw of value.messages) {
            const message = parseMessage(raw);
            if (message) messages.push(message);
        }
    }
    if (Array.isArray(value.events)) {
        for (const raw of value.events) {
            if (!isObject(raw)) continue;
            const event = parseEvent(isObject(raw.event) ? raw.event : raw);
            if (event) events.push({ seq: isSeq(raw.seq) ? raw.seq : 0, event });
        }
    }
    messages.sort((a, b) => a.seq - b.seq);
    events.sort((a, b) => a.seq - b.seq);
    return { messages, events };
}

/** @param {import('./types.d.ts').Credentials} credentials @param {number} since @returns {import('./types.d.ts').ClientFrame} */
export function helloFrame(credentials, since) {
    return { type: 'hello', deviceId: credentials.deviceId, token: credentials.token, since: isSeq(since) ? since : 0 };
}

/** @param {string} clientId @param {import('./types.d.ts').Part[]} parts @param {number} [replyTo] @returns {import('./types.d.ts').ClientFrame} */
export function sendFrame(clientId, parts, replyTo) {
    return { type: 'send', clientId, parts, ...(replyTo === undefined ? {} : { replyTo }) };
}

/** @param {number} id @returns {import('./types.d.ts').ClientFrame} */
export const recallFrame = id => ({ type: 'recall', id });
/** @returns {import('./types.d.ts').ClientFrame} */
export const pokeFrame = () => ({ type: 'poke' });
/** @returns {import('./types.d.ts').ClientFrame} */
export const pingFrame = () => ({ type: 'ping' });

/** UTF-8 字节数，不依赖 TextEncoder 以外的东西。 @param {import('./types.d.ts').ClientFrame} frame */
export function frameBytes(frame) {
    return new TextEncoder().encode(JSON.stringify(frame)).length;
}

/** @param {import('./types.d.ts').ClientFrame} frame */
export function encodeFrame(frame) {
    const text = JSON.stringify(frame);
    if (new TextEncoder().encode(text).length > MAX_FRAME_BYTES) throw new RangeError('这条消息太长了');
    return text;
}

/** @param {import('./types.d.ts').Credentials} credentials */
export const authorization = credentials => `Bearer ${credentials.deviceId}.${credentials.token}`;

/** @param {number} before @param {number} [limit] */
export function historyPath(before, limit = HISTORY_PAGE) {
    const size = Math.min(100, Math.max(1, Math.trunc(limit) || HISTORY_PAGE));
    return `/api/history?before=${encodeURIComponent(String(Math.max(0, Math.trunc(before))))}&limit=${size}`;
}

/** @param {string} mediaId */
export function mediaPath(mediaId) {
    if (!MEDIA_ID.test(mediaId)) throw new Error('媒体编号不合法');
    return `/api/media/${encodeURIComponent(mediaId)}`;
}

/** @param {string} mime */
export function uploadMime(mime) {
    const base = String(mime).split(';')[0]?.trim().toLowerCase() ?? '';
    const normalized = base === 'image/jpg' ? 'image/jpeg' : base === 'audio/x-wav' || base === 'audio/wave' ? 'audio/wav' : base === 'audio/mp3' ? 'audio/mpeg' : base;
    return IMAGE_MIMES.includes(normalized) || AUDIO_MIMES.includes(normalized) ? normalized : undefined;
}

/** @param {unknown} url */
export function safeHttpsUrl(url) {
    if (typeof url !== 'string' || url.length > 2048) return undefined;
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname ? parsed.href : undefined;
    } catch {
        return undefined;
    }
}

/** @param {unknown} value @returns {value is import('./types.d.ts').Credentials} */
export function isCredentials(value) {
    return isObject(value) && isText(value.deviceId) && value.deviceId.length > 0 && isText(value.token) && value.token.length > 0;
}
