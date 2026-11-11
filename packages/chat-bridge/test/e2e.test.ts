// 端到端：真的把中继起在 127.0.0.1 的临时端口上，上游是进程内的假 NapCat，Koishi 和手机都是进程内的 ws 客户端。
// 不连任何真实服务；号码和名字都是虚构的。
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { WebSocket, WebSocketServer } from 'ws';
import type { RelayConfig } from '../src/config.ts';
import { RELAY_ID_BASE } from '../src/core.ts';
import { startRelay } from '../src/relay.ts';
import type { Relay } from '../src/relay.ts';
import type { DeliveryRule, ServerFrame } from '../src/types.ts';
import { HER, OWNER, PNG, WAV, WEBM, tempDir, until } from './helpers.ts';

const TOKEN = 'synthetic-onebot-token';
type Json = Record<string, unknown>;

/** 假 NapCat：记下收到的动作，按 handler 回；能推事件、能整个关掉 */
async function fakeNapCat(t: TestContext) {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => server.once('listening', resolve));
    const received: { action: string; params: unknown }[] = [];
    const authorizations: (string | undefined)[] = [];
    let socket: WebSocket | undefined;
    let nextId = 700;
    const napcat = {
        url: `ws://127.0.0.1:${(server.address() as AddressInfo).port}`,
        received, authorizations,
        handler: (action: string, _params: unknown): Json => {
            if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: HER, nickname: '上游里的昵称' }, message: '', wording: '' };
            if (action === 'send_private_msg') return { status: 'ok', retcode: 0, data: { message_id: nextId++ }, message: '', wording: '' };
            if (action === 'no_such_action') return { status: 'failed', retcode: 1404, data: null, message: 'no such action', wording: '不支持', stream: 'normal-action' };
            return { status: 'ok', retcode: 0, data: null, message: '', wording: '' };
        },
        connected: () => socket?.readyState === WebSocket.OPEN,
        event(event: Json) { socket!.send(JSON.stringify(event)); },
        async close() {
            for (const client of server.clients) client.terminate();
            await new Promise<void>(resolve => server.close(() => resolve()));
        },
    };
    server.on('connection', (ws, req) => {
        socket = ws;
        authorizations.push(req.headers.authorization);
        ws.on('message', raw => {
            const { action, params, echo } = JSON.parse(raw.toString()) as { action: string; params: unknown; echo: unknown };
            received.push({ action, params });
            const reply = napcat.handler(action, params);
            // 返回 silent 表示这个动作不回（测超时）
            if (!reply.silent) ws.send(JSON.stringify({ ...reply, echo }));
        });
    });
    t.after(() => napcat.close());
    return napcat;
}

/** 假 Koishi：和 adapter-onebot 一样，带 Bearer 连上来，动作带数字 echo */
async function fakeKoishi(t: TestContext, port: number, token: string | null = TOKEN) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
    const events: Json[] = [];
    const waiting = new Map<number, (response: Json) => void>();
    let echo = 0;
    socket.on('message', raw => {
        const parsed = JSON.parse(raw.toString()) as Json;
        if ('post_type' in parsed) { events.push(parsed); return; }
        waiting.get(parsed.echo as number)?.(parsed);
        waiting.delete(parsed.echo as number);
    });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    t.after(() => socket.terminate());
    return {
        events, socket,
        call(action: string, params?: unknown): Promise<Json> {
            const id = ++echo;
            return new Promise(resolve => {
                waiting.set(id, resolve);
                socket.send(JSON.stringify({ action, params, echo: id }));
            });
        },
    };
}

/** 假手机：连 /ws，收到的帧都记下来 */
async function appSocket(t: TestContext, port: number) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const frames: ServerFrame[] = [];
    let closed = false;
    socket.on('message', raw => { frames.push(JSON.parse(raw.toString()) as ServerFrame); });
    socket.on('close', () => { closed = true; });
    await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    t.after(() => socket.terminate());
    return {
        frames, socket,
        closed: () => closed,
        send(frame: unknown) { socket.send(typeof frame === 'string' ? frame : JSON.stringify(frame)); },
        /** 等到第 n 个这种帧 */
        async wait<T extends ServerFrame['type']>(type: T, count = 1): Promise<Extract<ServerFrame, { type: T }>> {
            await until(() => frames.filter(frame => frame.type === type).length >= count, `第 ${count} 个 ${type} 帧`);
            return frames.filter(frame => frame.type === type)[count - 1] as Extract<ServerFrame, { type: T }>;
        },
    };
}

async function startAll(t: TestContext, options: { upstream?: boolean; delivery?: DeliveryRule; token?: string | null; now?: () => number } = {}) {
    const dir = tempDir(t);
    const staticDir = join(dir, 'static');
    mkdirSync(join(staticDir, 'assets'), { recursive: true });
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>synthetic app</title>');
    writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("synthetic")');
    writeFileSync(join(staticDir, 'package.json'), '{}');
    writeFileSync(join(dir, 'outside.html'), 'outside the static dir');
    const napcat = options.upstream === false ? undefined : await fakeNapCat(t);
    const config: RelayConfig = {
        ownerId: OWNER, ownerName: '阿明', selfId: HER, selfName: '小瑶',
        ...(napcat ? { upstreamUrl: napcat.url } : {}),
        onebotPort: 0, appPort: 0, host: '127.0.0.1', delivery: options.delivery ?? 'last-active',
        dataDir: join(dir, 'data'), staticDir,
    };
    const logs: string[] = [];
    const token = options.token === null ? undefined : options.token ?? TOKEN;
    const relay: Relay = await startRelay({
        config, log: line => { logs.push(line); }, upstreamBackoffMs: [30], upstreamTimeoutMs: 1000, revokeSweepMs: 20,
        ...(token ? { token } : {}),
        ...(options.now ? { now: options.now } : {}),
    });
    t.after(() => relay.stop());
    if (napcat) await until(() => relay.core.upstreamState() === 'up', '上游连上');
    const base = `http://127.0.0.1:${relay.appPort}`;
    const pair = async (name = '测试手机') => {
        const response = await fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: relay.devices.startPairing(), deviceName: name }) });
        assert.equal(response.status, 200);
        const body = await response.json() as { deviceId: string; token: string };
        return { ...body, authorization: `Bearer ${body.deviceId}.${body.token}` };
    };
    return { relay, napcat, base, pair, logs, dir, config };
}

test('没有 App 连接时是纯透传：事件和动作响应与直连 NapCat 逐字段相同', async t => {
    const { relay, napcat } = await startAll(t);
    assert.ok(napcat);
    const koishi = await fakeKoishi(t, relay.onebotPort);
    assert.deepEqual(napcat.authorizations, [`Bearer ${TOKEN}`], '连上游也带同一个 token');

    const events: Json[] = [
        { time: 1800000000, self_id: HER, post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true }, interval: 30000 },
        { time: 1800000001, self_id: HER, post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 41, user_id: OWNER, message: [{ type: 'text', data: { text: '在吗' } }], raw_message: '在吗', font: 14, sender: { user_id: OWNER, nickname: '阿明', card: '' }, message_format: 'array', extra: { nested: [1, 2, { deep: null }] } },
        { time: 1800000002, self_id: HER, post_type: 'message', message_type: 'group', sub_type: 'normal', message_id: 42, group_id: 40004, user_id: 30003, message: [{ type: 'at', data: { qq: String(HER) } }], raw_message: `[CQ:at,qq=${HER}]`, font: 14, sender: { user_id: 30003, nickname: '路人', role: 'member' } },
        { time: 1800000003, self_id: HER, post_type: 'notice', notice_type: 'friend_recall', user_id: OWNER, message_id: 41 },
        { time: 1800000004, self_id: HER, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: OWNER, sender_id: OWNER, target_id: HER, raw_info: [{ col: '1' }] },
        { time: 1800000005, self_id: HER, post_type: 'request', request_type: 'friend', user_id: 30003, comment: '加个好友', flag: 'flag-1' },
    ];
    for (const event of events) napcat.event(event);
    await until(() => koishi.events.length >= events.length + 1, '事件都到了');
    // 第一条是中继自己报的 lifecycle（NapCat 连上时也会报一条），后面的和上游发的一模一样
    assert.equal(koishi.events[0]?.meta_event_type, 'lifecycle');
    assert.deepEqual(koishi.events.slice(1), events);

    const actions: [string, unknown][] = [
        ['get_login_info', {}],
        ['send_private_msg', { user_id: OWNER, message: [{ type: 'text', data: { text: '在' } }] }],
        ['send_private_msg', { user_id: 30003, message: [{ type: 'text', data: { text: '你好' } }] }],
        ['send_group_msg', { group_id: 40004, message: [{ type: 'text', data: { text: '群里' } }] }],
        ['set_input_status', { user_id: String(OWNER), event_type: 1 }],
        ['mark_private_msg_as_read', { user_id: String(OWNER) }],
        ['friend_poke', { user_id: String(OWNER) }],
        ['delete_msg', { message_id: 700 }],
        ['set_msg_emoji_like', { message_id: 41, emoji_id: '76', set: true }],
        ['get_friend_msg_history', { user_id: String(OWNER), message_seq: undefined, count: 20 }],
        ['get_msg', { message_id: 41 }],
        ['set_online_status', { status: 10, ext_status: 0, battery_status: 0 }],
        ['no_such_action', { anything: [1, 'two', { three: 3 }] }],
    ];
    let expectedId = 700;
    for (const [action, params] of actions) {
        const before: number = napcat.received.length;
        const direct: Json = action === 'send_private_msg'
            ? { status: 'ok', retcode: 0, data: { message_id: expectedId++ }, message: '', wording: '' }
            : napcat.handler(action, params);
        const response = await koishi.call(action, params);
        const { echo, ...rest } = response;
        assert.equal(typeof echo, 'number', `${action}：echo 是 Koishi 自己的那个`);
        assert.deepEqual(rest, direct, `${action}：响应和 NapCat 回的一样`);
        assert.deepEqual(napcat.received.slice(before), [{ action, params: JSON.parse(JSON.stringify(params)) }], `${action}：NapCat 收到的参数没变`);
    }
});

test('配对 → App 发消息 → 她回文字 / 图片 / 撤回 / 正在输入 / 已读 / 戳一戳 → 上游断了照样收得到', async t => {
    const { relay, napcat, base, pair, logs, dir } = await startAll(t);
    assert.ok(napcat);
    const koishi = await fakeKoishi(t, relay.onebotPort);
    const device = await pair();
    const app = await appSocket(t, relay.appPort);
    app.send({ type: 'hello', deviceId: device.deviceId, token: device.token, since: 0 });
    assert.deepEqual(await app.wait('ready'), { type: 'ready', seq: 0, self: { name: '小瑶' }, upstream: 'up' });

    // ── 他在 App 里发一句 ──
    app.send({ type: 'send', clientId: 'client-1', parts: [{ kind: 'text', text: '在吗' }] });
    const ack = await app.wait('ack');
    const firstId = RELAY_ID_BASE + 1;
    assert.deepEqual(ack, { type: 'ack', clientId: 'client-1', id: firstId, seq: 1 });
    await until(() => koishi.events.length >= 2, 'Koishi 收到事件');
    const received = koishi.events[1]!;
    assert.equal(Math.abs((received.time as number) * 1000 - Date.now()) < 5000, true);
    assert.deepEqual(received, {
        self_id: HER, user_id: OWNER, time: received.time, message_id: firstId, message_seq: firstId, real_id: firstId,
        message_type: 'private', sub_type: 'friend', sender: { user_id: OWNER, nickname: '阿明', card: '' },
        message: [{ type: 'text', data: { text: '在吗' } }], raw_message: '在吗', font: 14, message_format: 'array', post_type: 'message',
    });
    const echoed = await app.wait('message');
    assert.deepEqual(echoed.message, { seq: 1, id: firstId, from: 'me', via: 'app', at: echoed.message.at, parts: [{ kind: 'text', text: '在吗' }], clientId: 'client-1' });
    assert.deepEqual(napcat.received, [], '这一切不经过 QQ');

    // ── 她：正在输入、已读、回一句（引用他那条）──
    assert.equal((await koishi.call('set_input_status', { user_id: String(OWNER), event_type: 1 })).status, 'ok');
    assert.deepEqual(await app.wait('typing'), { type: 'typing', on: true });
    assert.equal((await koishi.call('mark_private_msg_as_read', { user_id: String(OWNER) })).status, 'ok');
    assert.deepEqual(await app.wait('event'), { type: 'event', seq: 2, event: { kind: 'read', upTo: firstId } });

    const sent = await koishi.call('send_private_msg', { user_id: OWNER, message: [{ type: 'reply', data: { id: firstId } }, { type: 'text', data: { text: '在呢' } }, { type: 'face', data: { id: '178' } }] });
    const secondId = RELAY_ID_BASE + 2;
    assert.deepEqual(sent, { status: 'ok', retcode: 0, data: { message_id: secondId }, message: '', wording: '', echo: sent.echo });
    const reply = await app.wait('message', 2);
    assert.deepEqual(reply.message, { seq: 3, id: secondId, from: 'her', via: 'app', at: reply.message.at, parts: [{ kind: 'text', text: '在呢' }, { kind: 'face', id: 178 }], replyTo: firstId });

    // ── 她发一张图（本机文件）和一条语音，App 带凭据取 ──
    const photo = join(dir, 'photo.png');
    writeFileSync(photo, PNG);
    const voice = join(dir, 'voice.wav');
    writeFileSync(voice, WAV);
    assert.equal((await koishi.call('send_private_msg', { user_id: OWNER, message: [{ type: 'image', data: { file: photo, summary: '[照片]', sub_type: 1 } }] })).status, 'ok');
    assert.equal((await koishi.call('send_private_msg', { user_id: OWNER, message: [{ type: 'record', data: { file: `file:///${voice.split('\\').join('/')}` } }] })).status, 'ok');
    const imagePart = (await app.wait('message', 3)).message.parts[0];
    const voicePart = (await app.wait('message', 4)).message.parts[0];
    assert.ok(imagePart?.kind === 'image' && voicePart?.kind === 'voice');
    assert.deepEqual({ mime: imagePart.mime, summary: imagePart.summary }, { mime: 'image/png', summary: '[照片]' });
    const fetched = await fetch(`${base}/api/media/${imagePart.mediaId}`, { headers: { Authorization: device.authorization } });
    assert.equal(fetched.status, 200);
    assert.equal(fetched.headers.get('content-type'), 'image/png');
    assert.equal(fetched.headers.get('cache-control'), 'no-store');
    assert.equal(fetched.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(Buffer.from(await fetched.arrayBuffer()), PNG);
    const heard = await fetch(`${base}/api/media/${voicePart.mediaId}`, { headers: { Authorization: device.authorization } });
    assert.equal(heard.headers.get('content-type'), 'audio/wav');
    assert.deepEqual(Buffer.from(await heard.arrayBuffer()), WAV);

    // ── 她撤回刚才那句、给他那条点个表情、戳他一下 ──
    assert.equal((await koishi.call('delete_msg', { message_id: secondId })).status, 'ok');
    assert.deepEqual(await app.wait('event', 2), { type: 'event', seq: 6, event: { kind: 'recall', id: secondId } });
    assert.equal((await koishi.call('set_msg_emoji_like', { message_id: firstId, emoji_id: '76', set: true })).status, 'ok');
    assert.deepEqual(await app.wait('event', 3), { type: 'event', seq: 7, event: { kind: 'reaction', id: firstId, emojiId: 76 } });
    assert.equal((await koishi.call('friend_poke', { user_id: String(OWNER) })).status, 'ok');
    const poke = await app.wait('message', 5);
    assert.deepEqual(poke.message, { seq: 8, id: RELAY_ID_BASE + 5, from: 'her', via: 'app', at: poke.message.at, parts: [{ kind: 'poke' }] });
    assert.deepEqual((napcat.received as { action: string }[]).map(call => call.action), ['mark_private_msg_as_read'], '只有已读也告诉了 QQ，其余都没碰 QQ');

    // ── 他上传一张图和一段语音再发出去；她那边的事件带本机 URL，取得到 ──
    const upload = async (bytes: Buffer, type: string) => {
        const response = await fetch(`${base}/api/media`, { method: 'POST', headers: { Authorization: device.authorization, 'Content-Type': type }, body: new Uint8Array(bytes) });
        assert.equal(response.status, 200);
        return (await response.json() as { mediaId: string }).mediaId;
    };
    const uploadedImage = await upload(PNG, 'image/png');
    const uploadedVoice = await upload(WEBM, 'audio/webm;codecs=opus');
    app.send({ type: 'send', clientId: 'client-2', parts: [{ kind: 'image', mediaId: uploadedImage, mime: 'image/png' }], replyTo: firstId });
    app.send({ type: 'send', clientId: 'client-3', parts: [{ kind: 'voice', mediaId: uploadedVoice, mime: 'audio/webm', durationMs: 2100 }] });
    await app.wait('ack', 3);
    await until(() => koishi.events.length >= 4, 'Koishi 收到图片和语音');
    const imageEvent = koishi.events[2]!.message as { type: string; data: Record<string, string> }[];
    assert.deepEqual(imageEvent.map(segment => segment.type), ['reply', 'image']);
    assert.equal(imageEvent[0]!.data.id, String(firstId));
    const localUrl = imageEvent[1]!.data.url!;
    assert.equal(localUrl, `http://127.0.0.1:${relay.onebotPort}/media/${uploadedImage}`);
    const local = await fetch(localUrl);
    assert.equal(local.status, 200);
    assert.deepEqual(Buffer.from(await local.arrayBuffer()), PNG);
    const voiceEvent = koishi.events[3]!.message as { type: string; data: Record<string, string> }[];
    assert.equal(voiceEvent[0]!.type, 'record');
    assert.equal(voiceEvent[0]!.data.url, `http://127.0.0.1:${relay.onebotPort}/media/${uploadedVoice}`);

    // ── 他撤回自己那句、戳她 ──
    app.send({ type: 'recall', id: firstId });
    app.send({ type: 'poke' });
    await until(() => koishi.events.length >= 6, 'Koishi 收到撤回和戳一戳');
    const recallNotice = koishi.events[4]!;
    assert.deepEqual(recallNotice, { time: recallNotice.time, self_id: HER, post_type: 'notice', notice_type: 'friend_recall', user_id: OWNER, message_id: firstId });
    const pokeNotice = koishi.events[5]!;
    assert.deepEqual(pokeNotice, { time: pokeNotice.time, self_id: HER, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: OWNER, sender_id: OWNER, target_id: HER, raw_info: [] });

    // ── 上游断了：App 收到 down，她的话照样到，别的动作照实失败 ──
    await napcat.close();
    assert.deepEqual(await app.wait('upstream'), { type: 'upstream', state: 'down' });
    const messagesBefore = app.frames.filter(frame => frame.type === 'message').length;
    const offline = await koishi.call('send_private_msg', { user_id: OWNER, message: [{ type: 'text', data: { text: 'QQ 断了，我还在' } }] });
    assert.equal(offline.status, 'ok');
    const still = await app.wait('message', messagesBefore + 1);
    assert.deepEqual(still.message.parts, [{ kind: 'text', text: 'QQ 断了，我还在' }]);
    assert.equal(still.message.via, 'app');

    for (const [action, params] of [
        ['send_private_msg', { user_id: 30003, message: [{ type: 'text', data: { text: '给别人' } }] }],
        ['send_group_msg', { group_id: 40004, message: [{ type: 'text', data: { text: '群里' } }] }],
        ['send_like', { user_id: String(OWNER), times: 1 }],
        ['set_online_status', { status: 10 }],
    ] as const) {
        const response = await koishi.call(action, params);
        assert.equal(response.status, 'failed', action);
        assert.notEqual(response.retcode, 0, action);
        assert.equal(response.data, null, action);
    }
    assert.deepEqual((await koishi.call('get_login_info', {})).data, { user_id: HER, nickname: '小瑶' });
    const history = (await koishi.call('get_friend_msg_history', { user_id: String(OWNER), count: 50 })).data as { messages: { message_id: number; user_id: number; raw_message: string }[] };
    assert.equal(history.messages.some(message => message.user_id === OWNER && message.message_id === RELAY_ID_BASE + 6), true, '他在 App 里发的图在她能看到的记录里');
    assert.equal(history.messages.at(-1)?.raw_message, 'QQ 断了，我还在');
    assert.equal(history.messages.some(message => message.message_id === firstId || message.message_id === secondId), false, '撤回的不在');

    // ── 换一台手机重连：since 之后的先补齐，再 ready ──
    const again = await appSocket(t, relay.appPort);
    again.send({ type: 'hello', deviceId: device.deviceId, token: device.token, since: 8 });
    const ready = await again.wait('ready');
    assert.equal(ready.upstream, 'down');
    assert.equal(ready.seq, relay.ledger.seq);
    const replayed = again.frames.slice(0, -1);
    assert.equal(again.frames.at(-1)?.type, 'ready');
    assert.deepEqual(replayed.map(frame => frame.type === 'message' ? frame.message.seq : frame.type === 'event' ? frame.seq : -1), [9, 10, 11, 12, 13]);

    // ── 往前翻 ──
    const page = await (await fetch(`${base}/api/history?before=4&limit=2`, { headers: { Authorization: device.authorization } })).json() as { messages: { seq: number; recalled?: true }[]; events: { seq: number }[] };
    assert.deepEqual(page.messages.map(message => message.seq), [1, 3]);
    assert.deepEqual(page.messages.map(message => message.recalled), [true, true]);
    assert.deepEqual(page.events, [{ seq: 2, event: { kind: 'read', upTo: firstId } }]);

    // ── 日志里没有内容、凭据、配对码 ──
    const everything = logs.join('\n');
    for (const secret of ['在吗', '在呢', 'QQ 断了', device.token, TOKEN]) assert.equal(everything.includes(secret), false, secret);
    assert.equal(/\b\d{8}\b/.test(everything), false, '日志里没有 8 位数字');
});

test('他在 QQ 上说话：镜像进账标 via qq，App 实时看到；她的回复跟回 QQ；上游断线后自动重连', async t => {
    const { relay, napcat, pair } = await startAll(t);
    assert.ok(napcat);
    const koishi = await fakeKoishi(t, relay.onebotPort);
    const device = await pair();
    const app = await appSocket(t, relay.appPort);
    app.send({ type: 'hello', deviceId: device.deviceId, token: device.token, since: 0 });
    await app.wait('ready');

    napcat.event({ time: 1800000001, self_id: HER, post_type: 'message', message_type: 'private', sub_type: 'friend', message_id: 41, user_id: OWNER, message: [{ type: 'text', data: { text: '我在 QQ 上' } }], raw_message: '我在 QQ 上', font: 14, sender: { user_id: OWNER, nickname: '阿明' } });
    assert.deepEqual((await app.wait('message')).message, { seq: 1, id: 41, from: 'me', via: 'qq', at: 1800000001000, parts: [{ kind: 'text', text: '我在 QQ 上' }] });

    const sent = await koishi.call('send_private_msg', { user_id: OWNER, message: [{ type: 'text', data: { text: '看到了' } }] });
    assert.deepEqual(sent.data, { message_id: 700 });
    assert.deepEqual(napcat.received.map(call => call.action), ['send_private_msg']);
    const mirrored = (await app.wait('message', 2)).message;
    assert.deepEqual({ ...mirrored, at: 0 }, { seq: 2, id: 700, from: 'her', via: 'qq', at: 0, parts: [{ kind: 'text', text: '看到了' }] });

    // NapCat 还连着，但心跳说 QQ 掉线了，再恢复
    const frames = app.frames.length;
    napcat.event({ time: 1, self_id: HER, post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: false, good: false }, interval: 30000 });
    await until(() => app.frames.length > frames, 'upstream down');
    assert.deepEqual(app.frames.at(-1), { type: 'upstream', state: 'down' });
    napcat.event({ time: 2, self_id: HER, post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true }, interval: 30000 });
    await until(() => app.frames.at(-1)?.type === 'upstream' && relay.core.upstreamState() === 'up', 'upstream up');
});

test('上游没起来也能用，起来之后自动连上', async t => {
    const dir = tempDir(t);
    mkdirSync(join(dir, 'static'));
    // 先占一个端口再放掉，得到一个现在没人听的地址
    const probe = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await new Promise<void>(resolve => probe.once('listening', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));

    const relay = await startRelay({
        config: { ownerId: OWNER, ownerName: '阿明', selfId: HER, selfName: '小瑶', upstreamUrl: `ws://127.0.0.1:${port}`, onebotPort: 0, appPort: 0, host: '127.0.0.1', delivery: 'last-active', dataDir: join(dir, 'data'), staticDir: join(dir, 'static') },
        log: () => {}, upstreamBackoffMs: [20],
    });
    t.after(() => relay.stop());
    const koishi = await fakeKoishi(t, relay.onebotPort, null);
    assert.equal(relay.core.upstreamState(), 'down');
    assert.deepEqual((await koishi.call('get_login_info')).data, { user_id: HER, nickname: '小瑶' });
    assert.equal((await koishi.call('send_private_msg', { user_id: OWNER, message: '纯文字也行' })).status, 'ok');
    assert.deepEqual(relay.ledger.byId(RELAY_ID_BASE + 1)?.parts, [{ kind: 'text', text: '纯文字也行' }]);

    const late = new WebSocketServer({ host: '127.0.0.1', port });
    t.after(() => { for (const client of late.clients) client.terminate(); late.close(); });
    late.on('connection', ws => ws.on('message', raw => {
        const { echo } = JSON.parse(raw.toString()) as { echo: unknown };
        ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { from: 'late upstream' }, echo }));
    }));
    await until(() => relay.core.upstreamState() === 'up', '重连上');
    assert.deepEqual((await koishi.call('get_login_info')).data, { from: 'late upstream' });
});

test('上游迟迟不回：超时后照实失败，不挂住 Koishi', async t => {
    const { relay, napcat } = await startAll(t);
    assert.ok(napcat);
    const koishi = await fakeKoishi(t, relay.onebotPort);
    const original = napcat.handler;
    let swallowed = 0;
    napcat.handler = (action, params) => {
        if (action === 'slow_action') { swallowed++; return { silent: true }; }
        return original(action, params);
    };
    const relayed = await koishi.call('slow_action', {});
    assert.equal(swallowed, 1);
    assert.equal(relayed.status, 'failed');
    assert.notEqual(relayed.retcode, 0);
    assert.equal((await koishi.call('get_status', {})).status, 'ok', '后面的动作不受影响');
});

test('Koishi 这一侧：设了 token 就必须带对；本机媒体地址不认外来的 id', async t => {
    const { relay } = await startAll(t, { upstream: false });
    await assert.rejects(fakeKoishi(t, relay.onebotPort, 'wrong-token'), /401/);
    await assert.rejects(fakeKoishi(t, relay.onebotPort, null), /401/);
    const koishi = await fakeKoishi(t, relay.onebotPort);
    assert.equal((await koishi.call('get_status')).status, 'ok');

    for (const path of ['/media/AAAAAAAAAAAAAAAAAAAAAA', '/media/..%2Fdevices.json', '/media/', '/', '/api/history']) {
        assert.equal((await fetch(`http://127.0.0.1:${relay.onebotPort}${path}`)).status, 404, path);
    }
    // 没有 echo 的动作也有回答；不是 JSON 的不理
    koishi.socket.send('not json');
    koishi.socket.send(JSON.stringify({ params: {}, echo: 'no-action' }));
    const raw = await new Promise<string>(resolve => koishi.socket.once('message', data => resolve(data.toString())));
    assert.equal((JSON.parse(raw) as Json).status, 'failed');
});

test('App 这一侧的每条路都要凭据', async t => {
    const { relay, base, pair } = await startAll(t, { upstream: false });
    const device = await pair();
    const other = await pair('另一台');
    const stored = (await (await fetch(`${base}/api/media`, { method: 'POST', headers: { Authorization: device.authorization, 'Content-Type': 'image/png' }, body: new Uint8Array(PNG) })).json() as { mediaId: string }).mediaId;

    const attempts: [string, RequestInit][] = [
        [`/api/media/${stored}`, {}],
        [`/api/media/${stored}`, { headers: { Authorization: `Bearer ${device.deviceId}.${other.token}` } }],
        [`/api/media/${stored}`, { headers: { Authorization: `Bearer ${device.token}` } }],
        [`/api/media/${stored}`, { headers: { Authorization: `Basic ${Buffer.from(`${device.deviceId}:${device.token}`).toString('base64')}` } }],
        [`/api/media/${stored}?token=${device.token}&deviceId=${device.deviceId}`, {}],
        ['/api/history?before=10&limit=10', {}],
        ['/api/history', { headers: { Authorization: 'Bearer .' } }],
        ['/api/media', { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(PNG) }],
    ];
    for (const [path, init] of attempts) {
        const response = await fetch(`${base}${path}`, init);
        assert.equal(response.status, 401, path);
        assert.deepEqual(Object.keys(await response.json() as object), ['error', 'message']);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
    }
    assert.equal((await fetch(`${base}/api/media/${stored}`, { headers: { Authorization: other.authorization } })).status, 200, '另一台已配对的设备可以取');
    assert.equal((await fetch(`${base}/api/nothing`, { headers: { Authorization: device.authorization } })).status, 404);
    assert.equal((await fetch(`${base}/api/pair`)).status, 404, 'pair 只收 POST');

    // WebSocket：第一帧不是 hello、凭据不对，都回 unauthorized 并断开，之前什么都收不到
    for (const first of [
        { type: 'send', clientId: 'c', parts: [{ kind: 'text', text: '没打招呼' }] },
        { type: 'hello', deviceId: device.deviceId, token: other.token, since: 0 },
        { type: 'hello', deviceId: device.deviceId, since: 0 },
        { type: 'hello', deviceId: 'nobody', token: device.token, since: 0 },
    ]) {
        const socket = await appSocket(t, relay.appPort);
        socket.send(first);
        await until(() => socket.closed(), '被断开');
        assert.deepEqual(socket.frames, [{ type: 'error', code: 'unauthorized', message: '凭据不对，重新配对' }]);
    }
    assert.equal(relay.ledger.seq, 0);
    // 不在 /ws 上的升级请求不接
    await assert.rejects(new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${relay.appPort}/api/history`);
        socket.once('open', resolve);
        socket.once('error', reject);
    }), /404/);
});

test('配对接口：错码回 401，不说原因；连错 5 次后对的也不行；码只能用一次', async t => {
    let time = 1_800_000_000_000;
    const { relay, base } = await startAll(t, { upstream: false, now: () => time });
    const post = (body: unknown) => fetch(`${base}/api/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) });
    assert.equal((await post({ code: '00000000', deviceName: 'x' })).status, 401, '没有发过码');
    assert.equal((await post('not json')).status, 400);
    assert.equal((await post('[]')).status, 400);
    assert.equal((await post({ code: 'x'.repeat(5000) })).status, 413);

    const code = relay.devices.startPairing();
    const wrong = code === '11111111' ? '22222222' : '11111111';
    const bodies = new Set<string>();
    for (let attempt = 0; attempt < 5; attempt++) {
        const response = await post({ code: wrong, deviceName: 'x' });
        assert.equal(response.status, 401);
        bodies.add(await response.text());
    }
    const afterLock = await post({ code, deviceName: 'x' });
    assert.equal(afterLock.status, 401);
    bodies.add(await afterLock.text());
    assert.equal(bodies.size, 1, '码不对和码已作废的回答一样');
    assert.equal(relay.devices.list().length, 0);

    // 配对接口自己也限流（每分钟 10 次）：等一分钟再来
    assert.equal((await post({ code, deviceName: 'x' })).status, 429);
    time += 60_000;
    const fresh = relay.devices.startPairing();
    const paired = await post({ code: fresh, deviceName: '手机' });
    assert.equal(paired.status, 200);
    assert.equal(paired.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(await paired.json() as object).sort(), ['deviceId', 'token']);
    assert.equal((await post({ code: fresh, deviceName: '手机' })).status, 401);
    assert.equal(relay.devices.list().length, 1);
});

test('上传：类型白名单、内容要对得上、10 MiB 上限', async t => {
    const { base, pair } = await startAll(t, { upstream: false });
    const device = await pair();
    const upload = (bytes: Uint8Array, type: string | undefined) => fetch(`${base}/api/media`, { method: 'POST', headers: { Authorization: device.authorization, ...(type ? { 'Content-Type': type } : {}) }, body: bytes });
    const code = async (response: Response) => `${response.status}:${(await response.json() as { error: string }).error}`;
    assert.equal(await code(await upload(new Uint8Array(PNG), 'image/svg+xml')), '400:bad_request');
    assert.equal(await code(await upload(new Uint8Array(PNG), 'text/html')), '400:bad_request');
    assert.equal(await code(await upload(new Uint8Array(PNG), 'application/octet-stream')), '400:bad_request');
    assert.equal(await code(await upload(new Uint8Array(PNG), 'image/jpeg')), '400:bad_request', '说是 jpeg 其实是 png');
    assert.equal(await code(await upload(new Uint8Array(Buffer.from('<script>alert(1)</script>')), 'image/png')), '400:bad_request');
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    assert.equal(await code(await upload(big, 'image/png')), '413:too_large');
    const exact = new Uint8Array(10 * 1024 * 1024);
    exact.set(PNG);
    assert.equal((await upload(exact, 'image/png')).status, 200);
});

test('静态文件：index.html 不缓存、nosniff、不开 CORS、出不了目录', async t => {
    const { base } = await startAll(t, { upstream: false });
    const index = await fetch(`${base}/`, { headers: { Origin: 'https://elsewhere.example' } });
    assert.equal(index.status, 200);
    assert.equal(await index.text(), '<!doctype html><title>synthetic app</title>');
    assert.equal(index.headers.get('cache-control'), 'no-store');
    assert.equal(index.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8');
    for (const header of ['access-control-allow-origin', 'access-control-allow-credentials', 'access-control-allow-headers']) assert.equal(index.headers.get(header), null);

    const script = await fetch(`${base}/assets/app.js`);
    assert.equal(script.status, 200);
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(script.headers.get('x-content-type-options'), 'nosniff');

    const preflight = await fetch(`${base}/api/history`, { method: 'OPTIONS', headers: { Origin: 'https://elsewhere.example', 'Access-Control-Request-Method': 'GET' } });
    assert.equal(preflight.headers.get('access-control-allow-origin'), null);
    assert.notEqual(preflight.status, 200);

    // fetch 会把 ../ 规整掉，所以用原始请求
    const { request } = await import('node:http');
    const raw = (path: string) => new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: Number(new URL(base).port), path, method: 'GET' }, res => { res.resume(); resolve(res.statusCode ?? 0); });
        req.on('error', reject);
        req.end();
    });
    for (const path of [
        '/../outside.html', '/..%2Foutside.html', '/%2e%2e/outside.html', '/assets/../../outside.html', '/assets/..%5C..%5Coutside.html',
        '/..\\outside.html', '/%00', '/package.json', '/.env', '/assets/', '/missing.html', '/assets/app.js%00.html', '//outside.html', '/C:/Windows/win.ini',
    ]) {
        assert.equal(await raw(path), 404, path);
    }
    assert.equal(await raw('/index.html'), 200);
    assert.equal((await fetch(`${base}/`, { method: 'POST' })).status, 404);
});

test('WebSocket：ping/pong、64 KiB 上限、坏帧、限流', async t => {
    const { relay, pair } = await startAll(t, { upstream: false });
    await fakeKoishi(t, relay.onebotPort);
    const device = await pair();
    const app = await appSocket(t, relay.appPort);
    app.send({ type: 'hello', deviceId: device.deviceId, token: device.token, since: 0 });
    await app.wait('ready');

    app.send({ type: 'ping' });
    assert.deepEqual(await app.wait('pong'), { type: 'pong' });

    app.send({ type: 'send', clientId: 'big', parts: [{ kind: 'text', text: 'x'.repeat(64 * 1024) }] });
    assert.equal((await app.wait('error')).code, 'too_large');
    app.send('not json');
    assert.equal((await app.wait('error', 2)).code, 'bad_request');
    app.send({ type: 'run', command: 'whoami' });
    assert.equal((await app.wait('error', 3)).code, 'bad_request');
    app.socket.send(Buffer.from([1, 2, 3]));
    assert.equal((await app.wait('error', 4)).code, 'bad_request');
    assert.equal(relay.ledger.seq, 0);

    // 一口气发 40 条：前面的入账，超出的回 rate_limited（带 clientId），连接不断
    for (let index = 0; index < 40; index++) app.send({ type: 'send', clientId: `burst-${index}`, parts: [{ kind: 'text', text: 'a' }] });
    await until(() => app.frames.filter(frame => frame.type === 'ack' || (frame.type === 'error' && frame.code === 'rate_limited')).length >= 40, '40 条都有回答');
    const acks = app.frames.filter(frame => frame.type === 'ack').length;
    const limited = app.frames.filter(frame => frame.type === 'error' && frame.code === 'rate_limited');
    assert.ok(acks >= 20 && acks < 40, `入账 ${acks} 条`);
    assert.equal(acks + limited.length, 40);
    assert.equal(limited.every(frame => frame.type === 'error' && frame.clientId?.startsWith('burst-')), true);
    assert.equal(relay.ledger.seq, acks);
    app.send({ type: 'ping' });
    await app.wait('pong', 2);
});

test('撤销设备：凭据马上失效，已经连着的那条几秒内被断开', async t => {
    const { relay, base, pair } = await startAll(t, { upstream: false });
    const device = await pair();
    const app = await appSocket(t, relay.appPort);
    app.send({ type: 'hello', deviceId: device.deviceId, token: device.token, since: 0 });
    await app.wait('ready');
    assert.equal(relay.devices.revoke(device.deviceId), true);
    assert.equal((await fetch(`${base}/api/history`, { headers: { Authorization: device.authorization } })).status, 401);
    await until(() => app.closed(), '被断开');
    assert.deepEqual(app.frames.at(-1), { type: 'error', code: 'unauthorized', message: '这台设备已被撤销' });
});

test('Koishi 没连着时 App 发消息：not_delivered，不入账；重启后账还在', async t => {
    const { relay, pair, config } = await startAll(t, { upstream: false });
    const device = await pair();
    const app = await appSocket(t, relay.appPort);
    app.send({ type: 'hello', deviceId: device.deviceId, token: device.token, since: 0 });
    await app.wait('ready');
    app.send({ type: 'send', clientId: 'lost', parts: [{ kind: 'text', text: '有人吗' }] });
    assert.deepEqual(await app.wait('error'), { type: 'error', code: 'not_delivered', message: '她那边现在没连上，这条没有交给她', clientId: 'lost' });
    assert.equal(relay.ledger.seq, 0);

    const koishi = await fakeKoishi(t, relay.onebotPort);
    app.send({ type: 'send', clientId: 'lost', parts: [{ kind: 'text', text: '有人吗' }] });
    await app.wait('ack');
    await until(() => koishi.events.length >= 2, '这次交到了');

    await relay.stop();
    const reopened = await startRelay({ config, log: () => {}, token: TOKEN });
    t.after(() => reopened.stop());
    assert.equal(reopened.ledger.byClientId('lost')?.seq, 1);
    assert.equal(reopened.devices.verify(device.deviceId, device.token), true);
});
