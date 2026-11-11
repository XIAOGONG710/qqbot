// 开发用的假中继：只听 127.0.0.1，全在内存里，按 ADR 0337 第 4 节说话。
// 对面是一个合成角色，会回声、发图、发语音、打字、撤回、已读、表情回应、戳一戳。
//
//   node dev/mock-server.mjs [--port 8787] [--code 12345678] [--seed 120]
//
// 发这些字试不同的路径：图 / 语音 / 卡片 / 撤回 / 表情 / 赞 / 引用 / 断线 / 失败 / 慢 / 踢。
import { createServer } from 'node:http';
import { randomBytes, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { makePng, makeWav } from './png.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json',
};
const UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav']);
const MAX_MEDIA = 10 * 1024 * 1024;
const MAX_FRAME = 64 * 1024;
const PARTNER = '小满';

/**
 * @param {{ replayCap?: number, port?: number, code?: string, seed?: number, quiet?: boolean, replyDelayMs?: number, reusableCode?: boolean }} [options]
 */
export async function startMockServer(options = {}) {
    const quiet = options.quiet ?? false;
    const delay = options.replyDelayMs ?? 900;
    const replayCap = options.replayCap ?? 1000;
    const log = (...args) => { if (!quiet) console.log('[mock]', ...args); };

    /** 消息账：消息和事件共用一条 seq */
    const ledger = [];
    let seq = 0;
    // 和真中继一样：消息 id 超出 int32
    let nextId = 10_000_000_001;
    let upstream = 'up';
    const media = new Map();
    const devices = new Map();
    const acks = new Map();
    const sockets = new Set();
    const timers = new Set();
    let pair = { code: options.code ?? String(randomInt(0, 100_000_000)).padStart(8, '0'), expiresAt: Date.now() + 10 * 60_000, failures: 0, used: false };

    const later = (ms, fn) => {
        const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms);
        timers.add(timer);
    };
    const broadcast = frame => {
        const text = JSON.stringify(frame);
        for (const socket of sockets) if (socket.authed && socket.readyState === 1) socket.send(text);
    };
    const putMedia = (bytes, mime) => {
        const mediaId = randomBytes(9).toString('base64url');
        media.set(mediaId, { bytes, mime });
        return mediaId;
    };
    const addMessage = (from, parts, extra = {}, live = true) => {
        const message = { seq: ++seq, id: nextId++, from, via: 'app', at: Date.now(), parts, ...extra };
        ledger.push({ seq: message.seq, message });
        if (live) broadcast({ type: 'message', message });
        return message;
    };
    const addEvent = (event, live = true) => {
        const entry = { seq: ++seq, event };
        ledger.push(entry);
        if (event.kind === 'recall') {
            const target = ledger.find(item => item.message?.id === event.id);
            if (target) target.message.recalled = true;
        }
        if (live) broadcast({ type: 'event', seq: entry.seq, event });
        return entry;
    };
    const picture = hue => makePng(240, 320, (x, y) => {
        const t = y / 320;
        const wave = Math.sin((x + hue) / 28) * 14;
        return [Math.round(236 - t * 60 + wave), Math.round(170 + t * 20 + hue % 40), Math.round(140 + t * 70), 255];
    });

    // 之前几天的记录，翻页和时间条有东西可看
    const seedCount = options.seed ?? 120;
    const lines = ['起床了没', '嗯，刚醒', '今天降温，多穿点', '知道啦', '中午吃的什么', '食堂的面，一般', '晚上早点睡', '你也是', '到家了', '好，歇会儿吧'];
    const start = Date.now() - 4 * 24 * 60 * 60_000;
    for (let i = 0; i < seedCount; i++) {
        const from = i % 3 === 1 ? 'me' : 'her';
        const message = addMessage(from, [{ kind: 'text', text: lines[i % lines.length] }], { via: i % 11 === 5 ? 'qq' : 'app' }, false);
        message.at = start + Math.round((i / Math.max(1, seedCount)) * 4 * 24 * 60 * 60_000 * 0.98) + (i % 4) * 40_000;
    }
    if (seedCount > 0) {
        addMessage('her', [{ kind: 'image', mediaId: putMedia(picture(30), 'image/png'), mime: 'image/png', summary: '傍晚的天' }], {}, false).at = Date.now() - 50 * 60_000;
        addMessage('her', [{ kind: 'text', text: '刚拍的，好看吗' }, { kind: 'face', id: 21, name: '可爱' }], {}, false).at = Date.now() - 49 * 60_000;
        const mine = addMessage('me', [{ kind: 'text', text: '好看' }], {}, false);
        mine.at = Date.now() - 40 * 60_000;
        addEvent({ kind: 'read', upTo: mine.id }, false);
        addEvent({ kind: 'reaction', id: mine.id, emojiId: 66 }, false);
    }

    const partnerReply = message => {
        const text = message.parts.map(part => (part.kind === 'text' ? part.text : '')).join('');
        later(delay * 0.4, () => addEvent({ kind: 'read', upTo: message.id }));
        if (text.includes('断线')) {
            later(delay, () => { upstream = 'down'; broadcast({ type: 'upstream', state: 'down' }); });
            later(delay * 6, () => { upstream = 'up'; broadcast({ type: 'upstream', state: 'up' }); });
        }
        if (text.includes('踢')) { later(delay, () => { for (const socket of sockets) socket.terminate(); }); return; }
        later(delay * 0.7, () => broadcast({ type: 'typing', on: true }));
        later(delay * (text.includes('慢') ? 8 : 2), () => {
            if (text.includes('图')) addMessage('her', [{ kind: 'image', mediaId: putMedia(picture(randomInt(0, 200)), 'image/png'), mime: 'image/png', summary: '随手拍' }]);
            else if (text.includes('语音')) addMessage('her', [{ kind: 'voice', mediaId: putMedia(makeWav(3), 'audio/wav'), mime: 'audio/wav', durationMs: 3000 }]);
            else if (text.includes('卡片')) addMessage('her', [{ kind: 'card', title: '一篇想给你看的文章', url: 'https://example.com/article' }]);
            else if (text.includes('撤回')) {
                const oops = addMessage('her', [{ kind: 'text', text: '啊发错了' }]);
                later(delay * 2, () => addEvent({ kind: 'recall', id: oops.id }));
            } else if (text.includes('表情')) addMessage('her', [{ kind: 'face', id: 13, name: '呲牙' }, { kind: 'face', id: 9999, name: '新表情' }, { kind: 'text', text: ' 给你' }]);
            else if (text.includes('赞')) addEvent({ kind: 'reaction', id: message.id, emojiId: 76 });
            else if (text.includes('引用')) addMessage('her', [{ kind: 'text', text: '我说的是这句' }], { replyTo: message.id });
            else if (message.parts.some(part => part.kind === 'image')) addMessage('her', [{ kind: 'text', text: '看到啦' }]);
            else if (message.parts.some(part => part.kind === 'voice')) addMessage('her', [{ kind: 'text', text: '听到了' }]);
            else if (message.parts.some(part => part.kind === 'poke')) addMessage('her', [{ kind: 'poke' }]);
            else addMessage('her', [{ kind: 'text', text: `你说：${text.slice(0, 200)}` }]);
        });
    };

    const send = (res, status, body, headers = {}) => {
        const data = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
            'Content-Length': data.length, ...headers,
        });
        res.end(data);
    };
    const authed = req => {
        const match = /^Bearer ([^.\s]+)\.(\S+)$/.exec(req.headers.authorization ?? '');
        return Boolean(match && devices.get(match[1]) === match[2]);
    };
    const readBody = (req, limit) => new Promise((done, fail) => {
        const chunks = [];
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > limit) { fail(new Error('too_large')); req.destroy(); } else chunks.push(chunk);
        });
        req.on('end', () => done(Buffer.concat(chunks)));
        req.on('error', fail);
    });

    const server = createServer(async (req, res) => {
        try {
            const url = new URL(req.url ?? '/', 'http://127.0.0.1');
            if (url.pathname === '/api/pair' && req.method === 'POST') {
                let body;
                try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch { return send(res, 400, { error: 'bad_request' }); }
                if (pair.used || pair.failures >= 5) return send(res, 401, { error: 'unauthorized', message: '配对码无效' });
                if (Date.now() > pair.expiresAt) return send(res, 401, { error: 'unauthorized', message: '配对码无效' });
                if (body?.code !== pair.code || typeof body.deviceName !== 'string' || !body.deviceName) {
                    pair.failures++;
                    return send(res, 401, { error: 'unauthorized', message: '配对码无效' });
                }
                if (!options.reusableCode) pair.used = true;
                const deviceId = `dev-${randomBytes(6).toString('hex')}`;
                const token = randomBytes(32).toString('base64url');
                devices.set(deviceId, token);
                log(`配对成功：${body.deviceName}`);
                return send(res, 200, { deviceId, token });
            }
            if (url.pathname.startsWith('/api/')) {
                if (!authed(req)) return send(res, 401, { error: 'unauthorized' });
                if (url.pathname === '/api/media' && req.method === 'POST') {
                    const mime = String(req.headers['content-type'] ?? '').split(';')[0].trim();
                    if (!UPLOAD_TYPES.has(mime)) return send(res, 400, { error: 'bad_request' });
                    let bytes;
                    try { bytes = await readBody(req, MAX_MEDIA); } catch { return send(res, 413, { error: 'too_large' }); }
                    return send(res, 200, { mediaId: putMedia(bytes, mime) });
                }
                if (url.pathname.startsWith('/api/media/') && req.method === 'GET') {
                    const item = media.get(decodeURIComponent(url.pathname.slice('/api/media/'.length)));
                    if (!item) return send(res, 404, { error: 'not_found' });
                    return send(res, 200, item.bytes, { 'Content-Type': item.mime });
                }
                if (url.pathname === '/api/history' && req.method === 'GET') {
                    const before = Number(url.searchParams.get('before'));
                    const limit = Number(url.searchParams.get('limit'));
                    if (!Number.isInteger(before) || !Number.isInteger(limit) || limit < 1 || limit > 100) return send(res, 400, { error: 'bad_request' });
                    const older = ledger.filter(item => item.seq < before);
                    const messages = older.filter(item => item.message).slice(-limit).map(item => item.message);
                    const floor = messages[0]?.seq ?? 0;
                    const events = older.filter(item => item.event && item.seq > floor).map(item => ({ seq: item.seq, event: item.event }));
                    return send(res, 200, { messages, events });
                }
                return send(res, 404, { error: 'not_found' });
            }
            if (req.method !== 'GET') return send(res, 405, { error: 'method_not_allowed' });
            const relative = normalize(decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
            const file = join(ROOT, relative);
            if (!file.startsWith(ROOT + sep) || /[\\/](dev|test|node_modules)[\\/]/.test(file) || /[\\/](package|tsconfig)\.json$/.test(file)) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
            const type = TYPES[extname(file)];
            if (!type) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
            try {
                return send(res, 200, await readFile(file), { 'Content-Type': type, 'Cache-Control': 'no-cache' });
            } catch {
                return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
            }
        } catch (error) {
            log('请求出错', error instanceof Error ? error.message : error);
            if (!res.headersSent) send(res, 500, { error: 'internal' });
        }
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME * 2 });
    server.on('upgrade', (req, socket, head) => {
        if (new URL(req.url ?? '/', 'http://127.0.0.1').pathname !== '/ws') { socket.destroy(); return; }
        wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
    });
    wss.on('connection', ws => {
        sockets.add(ws);
        ws.authed = false;
        const reply = frame => { if (ws.readyState === 1) ws.send(JSON.stringify(frame)); };
        const helloTimer = setTimeout(() => { if (!ws.authed) ws.close(); }, 10_000);
        ws.on('close', () => { clearTimeout(helloTimer); sockets.delete(ws); });
        ws.on('message', (data, isBinary) => {
            if (isBinary) return reply({ type: 'error', code: 'bad_request', message: '只收文本帧' });
            if (data.length > MAX_FRAME) return reply({ type: 'error', code: 'too_large', message: '单帧超过 64 KiB' });
            let frame;
            try { frame = JSON.parse(data.toString('utf8')); } catch { return reply({ type: 'error', code: 'bad_request', message: '不是 JSON' }); }
            if (!ws.authed) {
                if (frame?.type !== 'hello' || devices.get(frame.deviceId) !== frame.token || !frame.token) {
                    reply({ type: 'error', code: 'unauthorized', message: '设备未配对或已撤销' });
                    return ws.close();
                }
                const since = Number.isInteger(frame.since) ? frame.since : 0;
                // 和真中继一样：补发只给最新的一段，更早的走 /api/history
                for (const item of ledger.filter(entry => entry.seq > since).slice(-replayCap)) {
                    reply(item.message ? { type: 'message', message: item.message } : { type: 'event', seq: item.seq, event: item.event });
                }
                ws.authed = true;
                return reply({ type: 'ready', seq, self: { name: PARTNER }, upstream });
            }
            switch (frame?.type) {
                case 'ping': return reply({ type: 'pong' });
                case 'send': {
                    if (typeof frame.clientId !== 'string' || !Array.isArray(frame.parts) || frame.parts.length === 0) {
                        return reply({ type: 'error', code: 'bad_request', message: '消息不完整', ...(typeof frame.clientId === 'string' ? { clientId: frame.clientId } : {}) });
                    }
                    const known = acks.get(frame.clientId);
                    if (known) return reply(known);
                    const text = frame.parts.map(part => (part.kind === 'text' ? part.text : '')).join('');
                    if (text.includes('失败')) return reply({ type: 'error', code: 'not_delivered', message: '没交到她那边', clientId: frame.clientId });
                    const message = addMessage('me', frame.parts, { clientId: frame.clientId, ...(Number.isInteger(frame.replyTo) ? { replyTo: frame.replyTo } : {}) }, false);
                    const ack = { type: 'ack', clientId: frame.clientId, id: message.id, seq: message.seq };
                    acks.set(frame.clientId, ack);
                    // 和真中继一样：先把 message 帧（带 clientId）广播给所有设备，再给发的那台 ack
                    broadcast({ type: 'message', message });
                    reply(ack);
                    return partnerReply(message);
                }
                case 'recall': {
                    const target = ledger.find(item => item.message?.id === frame.id && item.message.from === 'me' && item.message.via === 'app');
                    if (!target) return reply({ type: 'error', code: 'bad_request', message: '撤回不了这条' });
                    return void addEvent({ kind: 'recall', id: frame.id });
                }
                case 'poke':
                    return partnerReply(addMessage('me', [{ kind: 'poke' }]));
                default:
                    return reply({ type: 'error', code: 'bad_request', message: '不认识的帧' });
            }
        });
    });

    await new Promise((done, fail) => {
        server.once('error', fail);
        server.listen(options.port ?? 8787, '127.0.0.1', () => done(undefined));
    });
    const port = /** @type {import('node:net').AddressInfo} */ (server.address()).port;
    log(`http://127.0.0.1:${port}/  配对码 ${pair.code}（10 分钟有效）  对面是「${PARTNER}」`);

    return {
        port,
        url: `http://127.0.0.1:${port}`,
        code: pair.code,
        partner: PARTNER,
        get seq() { return seq; },
        ledger,
        /** 测试里让她主动说一句 */
        say: (parts, extra) => addMessage('her', parts, extra),
        event: event => addEvent(event),
        setUpstream: state => { upstream = state; broadcast({ type: 'upstream', state }); },
        dropConnections: () => { for (const socket of sockets) socket.terminate(); },
        newCode: () => {
            pair = { code: String(randomInt(0, 100_000_000)).padStart(8, '0'), expiresAt: Date.now() + 10 * 60_000, failures: 0, used: false };
            return pair.code;
        },
        expireCode: () => { pair.expiresAt = 0; },
        revokeAll: () => devices.clear(),
        close: async () => {
            for (const timer of timers) clearTimeout(timer);
            for (const socket of sockets) socket.terminate();
            wss.close();
            await new Promise(done => server.close(() => done(undefined)));
        },
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const arg = name => {
        const index = process.argv.indexOf(`--${name}`);
        return index > 0 ? process.argv[index + 1] : undefined;
    };
    await startMockServer({
        port: Number(arg('port') ?? 8787),
        ...(arg('code') ? { code: arg('code'), reusableCode: true } : {}),
        ...(arg('seed') ? { seed: Number(arg('seed')) } : {}),
    });
}
