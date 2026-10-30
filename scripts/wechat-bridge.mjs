// 微信桥（2026-10-30）：让她用自己的微信号跟别人聊。
//
// 它假装成 NapCat：在本机开一个 OneBot 11 的 WebSocket 服务端，Koishi 的 adapter-onebot 连上来，
// 于是 packages/bot 一行不用改——联系人 id 还是数字（wxid 用 wechat-id.ts 映射成稳定数字）。
//
// 微信那头交给 WeChatFerry（Windows 客户端注入）：
//   · 收：WCF 把消息回调到本进程的 HTTP（POST /wcf），转成 OneBot 事件推给所有 WS 连接；
//   · 发：Koishi 发来 send_private_msg → 调 WCF 的 HTTP 接口发出去。
// 没装 WCF / 没登录时整个桥也能起来（ready=false），只是发不出去、也收不到——方便先验证 Koishi 这一侧。
//
// 用法：
//   node scripts/wechat-bridge.mjs                # 默认 ws://127.0.0.1:3100 回调 http://127.0.0.1:3101
//   DRY=1 node scripts/wechat-bridge.mjs          # 不真发，只打印要发什么
// 环境变量：WX_WS_PORT / WX_HTTP_PORT / WCF_BASE / SELF_WXID / SELF_NAME / DRY
import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { wechatId, rememberWechat } from '../packages/bot/src/platform/wechat-id.ts';
import { privateMessageEvent, routeAction } from '../packages/bot/src/platform/wechat-bridge.ts';

const WS_PORT = Number(process.env.WX_WS_PORT ?? 3100);
const HTTP_PORT = Number(process.env.WX_HTTP_PORT ?? 3101);
const WCF_BASE = process.env.WCF_BASE ?? 'http://127.0.0.1:10086';
const SELF_WXID = process.env.SELF_WXID ?? '';
const SELF_NAME = process.env.SELF_NAME ?? '林梦瑶';
const DRY = process.env.DRY === '1';
const DATA = process.env.WX_DATA ?? 'runtime/bot-shadow';
const DIR_FILE = join(DATA, 'wechat-directory.json');

mkdirSync(DATA, { recursive: true });
let directory = {};
try { directory = JSON.parse(readFileSync(DIR_FILE, 'utf8')); } catch { /* 第一次跑没有 */ }
const saveDirectory = () => { try { writeFileSync(DIR_FILE, JSON.stringify(directory, null, 1)); } catch { /* 写不了不挡收发 */ } };

const log = (line) => console.log(new Date().toISOString(), line);
const selfId = wechatId(SELF_WXID);
let ready = false;

/** 数字 id → wxid */
const wxidOf = (id) => directory[String(id)];

/** wxid → 数字 id；第一次见就登记，撞号就报错不合并 */
function idOf(wxid) {
    const result = rememberWechat(directory, wxid);
    if (!result) return undefined;
    if (result.conflict) {
        log(`撞号：${wxid} 想用 ${result.id}，但那是 ${directory[String(result.id)]} 的——这条消息丢弃`);
        return undefined;
    }
    saveDirectory();
    return result.id;
}

/** 真发：WCF 的 HTTP 接口（send_text_msg）。DRY 只打印 */
async function sendText(wxid, text) {
    if (DRY) { log(`[dry] 要发给 ${wxid}：${text}`); return Math.floor(Math.random() * 1e6); }
    try {
        const response = await fetch(`${WCF_BASE}/api/send_text_msg`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ wxid, msg: text }),
            signal: AbortSignal.timeout(8000),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) { log(`微信没发出去：${response.status} ${JSON.stringify(body).slice(0, 120)}`); return undefined; }
        ready = true;
        return Number(body?.message_id ?? Date.now() % 2 ** 31);
    } catch (error) {
        log(`微信没发出去：${error instanceof Error ? error.message : String(error)}`);
        return undefined;
    }
}

// ── OneBot 11 WebSocket 服务端 ──
const wss = new WebSocketServer({ port: WS_PORT });
const clients = new Set();
wss.on('connection', (socket) => {
    clients.add(socket);
    log(`Koishi 连上来了（当前 ${clients.size} 个）`);
    socket.on('close', () => { clients.delete(socket); log(`一个连接断开（剩 ${clients.size}）`); });
    socket.on('message', async (raw) => {
        let payload;
        try { payload = JSON.parse(String(raw)); } catch { return; }
        if (payload.action === 'get_login_info') {
            socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: selfId ?? 0, nickname: SELF_NAME } }));
            return;
        }
        const outcome = await routeAction(payload.action, payload.params ?? {}, { ready: () => ready, wxidOf, sendText });
        const reply = { status: outcome.status === 'ok' ? 'ok' : 'failed', retcode: outcome.retcode ?? 0, data: outcome.data ?? null, ...(outcome.message ? { message: outcome.message } : {}) };
        if (payload.echo !== undefined) reply.echo = payload.echo;
        socket.send(JSON.stringify(reply));
    });
});

/** 把一条微信消息推给所有 Koishi 连接 */
function push(event) {
    const text = JSON.stringify(event);
    for (const socket of clients) socket.send(text);
}

// ── WCF 的回调入口（收消息、登录状态）──
const server = http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/wcf') { res.writeHead(404).end('not found'); return; }
    let body = '';
    req.on('data', chunk => { body += chunk; if (body.length > 256 * 1024) req.destroy(); });
    req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"ok":true}');
        let payload;
        try { payload = JSON.parse(body); } catch { return; }
        // WCF 的几种形状：{type:1,...} 登录成功；{type:0/49,...} 消息
        if (payload.type === 1 || payload.event === 'login') { ready = true; log('微信已登录（WCF 回调）'); return; }
        if (payload.event === 'logout') { ready = false; log('微信登出'); return; }
        const text = String(payload.content ?? payload.text ?? '').trim();
        const from = String(payload.wxid ?? payload.from ?? '').trim();
        if (!text || !from || from === SELF_WXID) return;
        const numericId = idOf(from);
        if (numericId === undefined || selfId === undefined) return;
        push(privateMessageEvent({
            wxid: from, numericId, text, at: Date.now(),
            messageId: Number(payload.id) || Date.now() % 2 ** 31,
            self: { numericId: selfId, name: SELF_NAME },
        }));
        log(`收到 ${from} 的消息，已推给 Koishi`);
    });
});
server.listen(HTTP_PORT, '127.0.0.1', () => log(`WCF 回调入口 http://127.0.0.1:${HTTP_PORT}/wcf`));

log(`微信桥起来了：OneBot ws://127.0.0.1:${WS_PORT}，self=${SELF_WXID || '(未设置 SELF_WXID)'}，WCF=${WCF_BASE}${DRY ? '，DRY 模式' : ''}`);
log('把 Koishi 的 adapter-onebot 指向 ws://127.0.0.1:' + WS_PORT + '，selfId 用她自己的微信数字 id');
