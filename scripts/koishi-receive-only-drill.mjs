// Default: synthetic handshake and incoming message. --live reads only NapCat login status.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { napcatReconnect } from '../packages/koishi-plugin-qqbot/src/index.ts';
import { createNapCatReader } from '../dsh-plugins/dsh-qqbot-services/chat.js';

const require = createRequire(import.meta.url);
const { App } = require('koishi');
const live = process.argv.includes('--live');
const account = live ? await createNapCatReader({ token: process.env.QQBOT_ONEBOT_TOKEN })('get_login_info', {}) : { user_id: 20001, nickname: 'Synthetic' };
const selfId = String(account?.user_id ?? '');
assert.match(selfId, /^[1-9]\d+$/);
const token = randomBytes(24).toString('hex');
const server = new WebSocketServer({
    host: '127.0.0.1', port: 0, verifyClient: ({ req }) => req.headers.authorization === `Bearer ${token}`,
});
await once(server, 'listening');
const endpoint = `ws://127.0.0.1:${server.address().port}`;
const app = new App();
const counts = { connections: 0, loginReads: 0, received: 0, blockedOutbound: 0, retryStarts: 0 };
server.on('connection', socket => {
    counts.connections++;
    const upstream = live ? new WebSocket('ws://127.0.0.1:3001/', {
        headers: process.env.QQBOT_ONEBOT_TOKEN ? { Authorization: `Bearer ${process.env.QQBOT_ONEBOT_TOKEN}` } : {},
    }) : undefined;
    const ready = upstream ? once(upstream, 'open').then(() => true, () => false) : Promise.resolve(true);
    if (upstream) {
        upstream.on('error', () => socket.close());
        upstream.on('close', () => socket.close());
        socket.on('close', () => upstream.terminate());
    }
    let loginReply;
    upstream?.on('message', raw => {
        let response;
        try { response = JSON.parse(raw.toString()); } catch { return; }
        // Unsolicited events and unrelated responses never enter the isolated Koishi.
        if (response?.post_type || response?.echo !== 'isolated-login' || !loginReply) return;
        const respond = loginReply;
        loginReply = undefined;
        if (response.retcode !== 0 || String(response.data?.user_id) !== selfId) respond(null, 1);
        else respond(response.data);
    });
    socket.on('message', async raw => {
        const { action, echo } = JSON.parse(raw.toString());
        const reply = (data, retcode = 0) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ status: retcode ? 'failed' : 'ok', retcode, data, echo }));
        };
        if (action === 'get_login_info') {
            counts.loginReads++;
            // Only this constant read action can reach NapCat. No raw frame or incoming QQ event is relayed.
            if (!upstream) return reply(account);
            if (!await ready || upstream.readyState !== WebSocket.OPEN || loginReply) return reply(null, 1);
            loginReply = reply;
            upstream.send(JSON.stringify({ action: 'get_login_info', params: {}, echo: 'isolated-login' }));
        } else if (action === 'get_guild_service_profile') {
            reply({ tiny_id: '0' });
        } else {
            counts.blockedOutbound++;
            reply(null, 403);
        }
    });
});
const reconnect = napcatReconnect((callback, delay) => app.setTimeout(callback, delay), async sid => {
    const bot = app.bots.find(candidate => candidate.sid === sid);
    if (bot?.status !== 0) return false;
    counts.retryStarts++;
    await bot.start();
    return app.bots.find(candidate => candidate.sid === sid)?.status === 0;
}, () => undefined);
app.on('login-updated', ({ bot }) => {
    if (bot.platform !== 'onebot') return;
    if (bot.status === 1) reconnect.online(bot.sid);
    else if (bot.status === 0) reconnect.offline(bot.sid);
});
app.on('message', () => { counts.received++; });
app.plugin(require('@koishijs/plugin-http').default);
const adapter = app.plugin(require('koishi-plugin-adapter-onebot').OneBotBot, {
    protocol: 'ws', endpoint, selfId, token, responseTimeout: 1500,
});
async function waitFor(predicate, label) {
    const end = Date.now() + 18_000;
    while (!predicate()) {
        if (Date.now() >= end) throw new Error(label);
        await sleep(50);
    }
}
try {
    await app.start();
    const online = () => app.bots.find(bot => bot.platform === 'onebot')?.status === 1;
    await waitFor(online, 'Koishi did not connect');
    if (!live) {
        const socket = [...server.clients][0];
        socket.send(JSON.stringify({
            post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 1, self_id: Number(selfId),
            user_id: 20002, sender: { user_id: 20002, nickname: 'Fixture' }, time: Math.floor(Date.now() / 1000),
            message: [{ type: 'text', data: { text: 'synthetic inbound' } }],
        }));
        await waitFor(() => counts.received === 1, 'synthetic input was not received');
    }
    for (const socket of server.clients) socket.close();
    await waitFor(() => !online(), 'disconnect was not observed');
    await waitFor(() => counts.connections >= 2 && online(), 'Koishi did not reconnect');
    assert.equal(counts.blockedOutbound, 0);
    const verifiedCounts = { ...counts };
    if (!live) {
        // Exercise the barrier separately from Koishi's zero-outbound run.
        const negative = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` } });
        try {
            await once(negative, 'open');
            negative.send(JSON.stringify({ action: 'send_private_msg', echo: 99, params: {} }));
            const [response] = await once(negative, 'message');
            assert.equal(JSON.parse(response.toString()).retcode, 403);
            assert.equal(counts.blockedOutbound, 1);
        } finally { negative.terminate(); }
    }
    console.log(JSON.stringify({ mode: live ? 'local-napcat-read-only' : 'synthetic',
        koishi: require('koishi/package.json').version, adapter: require('koishi-plugin-adapter-onebot/package.json').version,
        checkout: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), ...verifiedCounts,
        ...(live ? {} : { injectedSendRejected: true }) }));
} finally {
    reconnect.dispose();
    adapter.dispose();
    await app.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
}
