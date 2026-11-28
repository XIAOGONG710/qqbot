// Default: synthetic handshake and incoming message. --live reads only NapCat login status.
// --quality loads the project plugin with a fake OneBot and a temporary data directory.
// QQBOT_DRILL_DSH_BIN and QQBOT_DRILL_DESKTOP_EXE add the installed DSH execution and desktop host.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket, WebSocketServer } from 'ws';
import { apply, Config, napcatReconnect } from '../packages/koishi-plugin-qqbot/src/index.ts';
import { createNapCatReader } from '../dsh-plugins/dsh-qqbot-services/chat.js';
import { setWorkMode } from '../packages/bot/src/platform/work-mode.ts';
import { focusCheckpoint } from '../dsh-plugins/dsh-linmengyao-memory/focus-checkpoints.mjs';
import { verifyDesktopMemory } from './dsh-desktop-memory-drill.mjs';

const require = createRequire(import.meta.url);
const { App } = require('koishi');
const live = process.argv.includes('--live');
const quality = process.argv.includes('--quality');
assert.ok(!(quality && live), 'Quality drill requires a fake OneBot');
const work = quality && process.env.QQBOT_DRILL_DSH_BIN;
const desktop = quality && process.env.QQBOT_DRILL_DESKTOP_EXE;
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
const qualityDir = quality ? mkdtempSync(join(tmpdir(), 'qqbot-quality-')) : undefined;
let modelCalls = 0;
let sendCalls = 0;
let modelServer;
let resident;
let receiptProxy;
const workReplies = [];
let workArmed = false;
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
        const { action, echo, params } = JSON.parse(raw.toString());
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
        } else if (workArmed && action === 'send_private_msg') {
            sendCalls++;
            workReplies.push(JSON.stringify(params?.message));
            reply({ message_id: 100 });
        } else {
            if (action.startsWith('send_')) sendCalls++;
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
if (qualityDir) {
    modelServer = createServer((req, res) => {
        if (req.method !== 'POST' || req.url !== '/v1/chat/completions') { res.writeHead(404).end(); return; }
        req.resume();
        modelCalls++;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ choices: [{ message: { content: '我这就给你打电话。PRIVATE-DRILL-SENTINEL' }, finish_reason: 'stop' }] }));
    }).listen(0, '127.0.0.1');
    await once(modelServer, 'listening');
    const modelUrl = `http://127.0.0.1:${modelServer.address().port}/v1`;
    process.env.QQBOT_LLM_API_KEY = 'synthetic-fixture';
    process.env.QQBOT_LLM_BASE_URL = modelUrl;
    delete process.env.QQBOT_LLM_FALLBACK_BASE_URL;
    delete process.env.QQBOT_LLM_FALLBACK_API_KEY;
    process.env.QQBOT_DECISION_AUDIT = '1';
    process.env.QQBOT_SOUL_DIR = join(qualityDir, 'soul');
    if (work) process.env.QQBOT_FOCUS_WORK = '1';
    const character = join(qualityDir, 'character');
    cpSync(resolve('packages/bot/test/fixtures/synthetic-character'), character, { recursive: true });
    app.plugin({ apply, Config }, {
        dataDir: qualityDir,
        characterCard: join(character, 'st', 'synthetic-{tier}.json'),
        contacts: [{ qq: 20002, name: 'Fixture', tier: 'boyfriend' }],
        llm: { baseUrl: modelUrl, model: 'synthetic' },
        proactive: 'off', realWorld: false, schedule: false, recalls: true, memory: { enabled: false },
    });
}
const adapter = app.plugin(require('koishi-plugin-adapter-onebot').OneBotBot, {
    protocol: 'ws', endpoint, selfId, token, responseTimeout: 1500,
});
async function waitFor(predicate, label) {
    const end = Date.now() + (quality ? 45_000 : 18_000);
    while (!await predicate()) {
        if (Date.now() >= end) throw new Error(label);
        await sleep(50);
    }
}
async function stopResident() {
    if (!resident || resident.exitCode !== null || resident.signalCode !== null) return;
    const exited = once(resident, 'exit');
    resident.kill();
    await exited;
}
async function verifyWork(socket) {
    const soul = process.env.QQBOT_SOUL_DIR;
    const ledger = join(soul, 'focus-checkpoints.json');
    const taskId = 'dsh-synthetic-receipt';
    process.env.HER_DIR = join(qualityDir, 'resident');
    mkdirSync(soul, { recursive: true });
    focusCheckpoint(ledger, { taskId, action: 'start', operationId: 'fixture-start', next: '核对合成配置' });
    focusCheckpoint(ledger, { taskId, action: 'wait', operationId: 'fixture-wait', next: '核对合成配置' });
    const temporary = createServer().listen(0, '127.0.0.1');
    await once(temporary, 'listening');
    const port = temporary.address().port;
    await new Promise(done => temporary.close(done));
    const bin = join(qualityDir, 'dsh-fixture.mjs');
    const calls = join(qualityDir, 'execution-count');
    writeFileSync(bin, `import net from 'node:net';
import { appendFileSync } from 'node:fs';
net.Socket.prototype.connect = () => { throw Error('unexpected drill socket'); };
globalThis.fetch = async input => {
    const url = new URL(input.url ?? input);
    if (url.hostname !== '127.0.0.1' || !url.pathname.endsWith('/chat/completions')) throw Error('unexpected drill fetch');
    const base = { id: 'synthetic', object: 'chat.completion.chunk', model: 'deepseek-v4-flash', created: 1 };
    const chunks = [{ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Synthetic DSH work result' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
    return new Response(chunks.map(chunk => 'data: ' + JSON.stringify(chunk) + '\\n\\n').join('') + 'data: [DONE]\\n\\n',
        { headers: { 'content-type': 'text/event-stream' } });
};
appendFileSync(${JSON.stringify(calls)}, 'run\\n');
const { runCli } = await import(${JSON.stringify(pathToFileURL(resolve(work)).href)});
await runCli();`);
    const start = async () => {
        resident = spawn(process.execPath, [resolve('scripts/her-resident.mjs')], {
            cwd: qualityDir, stdio: 'ignore', windowsHide: true, env: {
                ...process.env, HER_PORT: String(port), HER_CWD: qualityDir, DSH_HOME: join(qualityDir, 'dsh'),
                HER_PROFILE: 'headless', HER_PERMISSION_MODE: 'read-only', DSH_BIN: bin,
                DEEPSEEK_API_KEY: 'synthetic-fixture', DEEPSEEK_BASE_URL: 'http://127.0.0.1:1',
            },
        });
        await waitFor(async () => {
            try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; }
            catch { return false; }
        }, 'Isolated resident did not start');
    };
    let dropped = 0;
    receiptProxy = createServer((req, res) => {
        const upstream = request({ host: '127.0.0.1', port, path: '/task', method: 'POST',
            headers: { ...req.headers, host: `127.0.0.1:${port}` } }, reply => {
            reply.resume();
            reply.on('end', () => { dropped++; res.destroy(); });
        });
        upstream.on('error', () => res.destroy());
        req.pipe(upstream);
    }).listen(0, '127.0.0.1');
    await once(receiptProxy, 'listening');
    process.env.HER_RESIDENT_URL = `http://127.0.0.1:${receiptProxy.address().port}`;
    await start();
    setWorkMode(qualityDir, 20002, 'work');
    const submit = id => {
        const content = `继续任务 ${taskId}`;
        socket.send(JSON.stringify({ post_type: 'message', message_type: 'private', sub_type: 'friend',
            message_id: id, self_id: Number(selfId), user_id: 20002, sender: { user_id: 20002 },
            time: Math.floor(Date.now() / 1000), raw_message: content, message: [{ type: 'text', data: { text: content } }] }));
    };
    workArmed = true;
    submit(2);
    await waitFor(() => workReplies.length === 1, 'Koishi did not acknowledge the lost work receipt');
    assert.match(workReplies[0], /回复内容待核对/);
    assert.equal(focusCheckpoint(ledger, { taskId, action: 'read' }).status, 'finished');
    await stopResident();
    await start();
    submit(2);
    submit(3);
    await waitFor(() => counts.received >= 4, 'Koishi did not receive the replay and the new resume request');
    await sleep(500);
    assert.equal(readFileSync(calls, 'utf8'), 'run\n');
    assert.equal(dropped, 1);
    assert.equal(workReplies.length, 1);
    setWorkMode(qualityDir, 20002, 'chat');
    workArmed = false;
}
try {
    await app.start();
    const online = () => app.bots.find(bot => bot.platform === 'onebot')?.status === 1;
    await waitFor(online, 'Koishi did not connect');
    if (!live) {
        const socket = [...server.clients][0];
        const input = quality ? '合成测试，请回答简单的问题。 PRIVATE-RECALL-SENTINEL' : 'synthetic inbound';
        socket.send(JSON.stringify({
            post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 1, self_id: Number(selfId),
            user_id: 20002, sender: { user_id: 20002, nickname: 'Fixture' }, time: Math.floor(Date.now() / 1000),
            raw_message: input, message: [{ type: 'text', data: { text: input } }],
        }));
        await waitFor(() => counts.received === 1, 'synthetic input was not received');
        if (qualityDir) {
            const audit = () => {
                try {
                    const logs = join(qualityDir, 'logs');
                    return readdirSync(logs).filter(name => name.startsWith('decision-audit-'))
                        .map(name => readFileSync(join(logs, name), 'utf8')).join('\n');
                } catch { return ''; }
            };
            await waitFor(() => modelCalls > 0 && /"phase":"quality","outcome":"blocked".*"unsupported-action"/.test(audit()), 'Quality audit did not record a rejection');
            assert.equal(sendCalls, 0);
            assert.doesNotMatch(audit(), /PRIVATE-DRILL-SENTINEL|PRIVATE-RECALL-SENTINEL|20002/);
            const ownerBankFile = join(qualityDir, 'memory', 'owner-bank.json');
            const recalledFile = join(qualityDir, 'chats', '20002.recalled.json');
            const manifest = { ownerBank: 'synthetic-owner', commonBank: 'synthetic-common', legacyBank: 'synthetic',
                chatFile: join(qualityDir, 'chats', '20002.jsonl'), recalledFile };
            mkdirSync(join(qualityDir, 'memory'), { recursive: true });
            const freshDesktopRead = () => execFileSync(process.execPath, ['--input-type=module', '-e',
                `import { qqRecentBlock } from ${JSON.stringify(pathToFileURL(resolve('dsh-plugins/dsh-linmengyao-memory/index.js')).href)}; process.stdout.write(qqRecentBlock({ prefix: 'synthetic', ownerBankFile: process.argv[1] }));`, ownerBankFile],
            { encoding: 'utf8' });
            writeFileSync(ownerBankFile, JSON.stringify(manifest));
            assert.match(freshDesktopRead(), /PRIVATE-RECALL-SENTINEL/);
            const recall = async () => {
                socket.send(JSON.stringify({ post_type: 'notice', notice_type: 'friend_recall',
                    self_id: Number(selfId), user_id: 20002, message_id: 1, time: Math.floor(Date.now() / 1000) }));
                await waitFor(() => {
                    try { return JSON.parse(readFileSync(recalledFile, 'utf8')).messages.some(row => row.messageId === 1); }
                    catch { return false; }
                }, 'Koishi did not persist the synthetic recall');
            };
            if (desktop) {
                await verifyDesktopMemory({ exe: resolve(desktop), root: qualityDir, ownerBankFile, manifest, recall });
                writeFileSync(ownerBankFile, JSON.stringify(manifest));
            } else await recall();
            const afterRecall = freshDesktopRead();
            assert.match(afterRecall, /撤回了一条消息/);
            assert.doesNotMatch(afterRecall, /PRIVATE-RECALL-SENTINEL/);
            writeFileSync(ownerBankFile, JSON.stringify({ ...manifest, ownerBank: 'synthetic-other', chatFile: undefined, recalledFile: undefined }));
            assert.equal(freshDesktopRead(), '');
            if (work) await verifyWork(socket);
        }
    }
    for (const socket of server.clients) socket.close();
    await waitFor(() => !online(), 'disconnect was not observed');
    await waitFor(() => counts.connections >= 2 && online(), 'Koishi did not reconnect');
    if (!quality) assert.equal(counts.blockedOutbound, 0);
    if (quality) assert.equal(sendCalls, workReplies.length, 'Koishi attempted to send after the quality rejection');
    const verifiedCounts = { ...counts };
    if (!live) {
        // Exercise the barrier separately from Koishi's zero-outbound run.
        const negative = new WebSocket(endpoint, { headers: { Authorization: `Bearer ${token}` } });
        try {
            await once(negative, 'open');
            negative.send(JSON.stringify({ action: 'send_private_msg', echo: 99, params: {} }));
            const [response] = await once(negative, 'message');
            assert.equal(JSON.parse(response.toString()).retcode, 403);
            assert.equal(counts.blockedOutbound, verifiedCounts.blockedOutbound + 1);
        } finally { negative.terminate(); }
    }
    console.log(JSON.stringify({ mode: live ? 'local-napcat-read-only' : 'synthetic',
        koishi: require('koishi/package.json').version, adapter: require('koishi-plugin-adapter-onebot/package.json').version,
        checkout: execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), ...verifiedCounts,
        ...(quality ? { qualityModelCalls: modelCalls, qualitySendCalls: sendCalls - 1 - workReplies.length,
            recallProjectionPassed: true, ...(desktop ? { desktopReopenPassed: true } : {}),
            ...(work ? { workExecutions: 1, droppedWorkReceipts: 1 } : {}) } : {}),
        ...(live ? {} : { injectedSendRejected: true }) }));
} finally {
    reconnect.dispose();
    adapter.dispose();
    await app.stop();
    for (const socket of server.clients) socket.terminate();
    await new Promise(resolve => server.close(resolve));
    await stopResident();
    if (receiptProxy) await new Promise(resolve => receiptProxy.close(resolve));
    if (modelServer) await new Promise(resolve => modelServer.close(resolve));
    if (qualityDir) rmSync(qualityDir, { recursive: true, force: true });
}
