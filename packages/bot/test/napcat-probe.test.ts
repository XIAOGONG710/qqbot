import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { WebSocketServer } from 'ws';
import { connect, ONLINE_SEQUENCE, parseArgs, runProbe, serverFromConfig, shapeOf, type ActionResponse, type Connection } from '../../../scripts/napcat-probe.ts';

const SELF = 20000;
const USER = 10001;
const ok = (data: unknown = null): ActionResponse => ({ status: 'ok', retcode: 0, data });
const failed = (retcode: number, message: string): ActionResponse => ({ status: 'failed', retcode, message });

/** 假 NapCat：按动作名回话，记下每次调用；events() 往监听者推事件 */
function fakeNapcat(responses: Record<string, ActionResponse | ((params: Record<string, unknown>) => ActionResponse)> = {}) {
    const calls: { action: string; params: Record<string, unknown> }[] = [];
    const listeners = new Set<(event: Record<string, unknown>) => void>();
    const connection: Connection = {
        async call(action, params = {}) {
            calls.push({ action, params });
            const response = responses[action];
            return typeof response === 'function' ? response(params) : response ?? ok();
        },
        onEvent(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        close() {},
    };
    return { connection, calls, push: (event: Record<string, unknown>) => { for (const listener of listeners) listener(event); } };
}

const noSleep = () => Promise.resolve();
const message = (extra: Record<string, unknown> = {}) => ({
    post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: USER, message_id: 777, time: 1_800_000_000,
    message: [{ type: 'text', data: { text: '你好呀' } }], ...extra,
});
const poke = { post_type: 'notice', notice_type: 'notify', sub_type: 'poke', self_id: SELF, user_id: USER, sender_id: USER, target_id: SELF, time: 1_800_000_000 };

/** 跑 events 步骤：等一会儿，让测试在窗口里推事件 */
async function withEvents(fake: ReturnType<typeof fakeNapcat>, script: () => Promise<void> | void, extra: Partial<Parameters<typeof runProbe>[0]> = {}) {
    const lines: string[] = [];
    const running = runProbe({ connection: fake.connection, user: USER, steps: ['login', 'events'], say: line => lines.push(line), sleep: () => new Promise(resolve => setTimeout(resolve, 60)), eventsMs: 60, ...extra });
    await new Promise(resolve => setTimeout(resolve, 10));
    await script();
    return { results: await running, lines };
}

describe('NapCat 探针（ADR 0085）', () => {
    test('默认步骤：按顺序调用，参数就是机器人真正发的那几个；在线状态改回在线', async () => {
        const fake = fakeNapcat({ get_login_info: ok({ user_id: SELF, nickname: '她' }) });
        const lines: string[] = [];
        const results = await runProbe({ connection: fake.connection, user: USER, steps: ['login', 'packet', 'online', 'like', 'poke', 'typing'], say: line => lines.push(line), sleep: noSleep });
        assert.deepEqual(fake.calls.map(call => call.action), [
            'get_login_info', 'nc_get_packet_status',
            ...ONLINE_SEQUENCE.map(() => 'set_online_status'), 'send_like', 'friend_poke', 'set_input_status',
        ]);
        assert.deepEqual(fake.calls.filter(call => call.action === 'set_online_status').map(call => [call.params.status, call.params.ext_status]), [[10, 0], [10, 1016], [10, 1018], [10, 1028], [10, 0]]);
        assert.deepEqual(fake.calls.find(call => call.action === 'send_like')?.params, { user_id: String(USER), times: 1 });
        assert.deepEqual(fake.calls.find(call => call.action === 'friend_poke')?.params, { user_id: String(USER) });
        assert.deepEqual(fake.calls.find(call => call.action === 'set_input_status')?.params, { user_id: String(USER), event_type: 1 });
        assert.ok(results.every(result => result.ok), JSON.stringify(results.filter(result => !result.ok)));
        assert.match(lines.join('\n'), new RegExp(`${SELF}（她）`));
    });

    test('packet 不可用：记下 NapCat 的原话，戳也失败；别的步骤照跑', async () => {
        const fake = fakeNapcat({
            nc_get_packet_status: failed(1200, 'packetBackend不可用，请参照文档'),
            friend_poke: failed(1200, 'packetBackend发包能力不可用'),
        });
        const results = await runProbe({ connection: fake.connection, user: USER, steps: ['packet', 'like', 'poke'], sleep: noSleep });
        assert.deepEqual(results.map(result => [result.step, result.ok]), [['packet', false], ['like', true], ['poke', false]]);
        assert.match(results[0]!.detail, /retcode 1200：packetBackend不可用/);
    });

    test('events：你发消息 → 点表情回应 + 标已读（只第一条）；id 超过 32 位会被指出；撤回认得、并说明撤的就是刚收到的那条', async () => {
        const fake = fakeNapcat({ get_login_info: ok({ user_id: SELF, nickname: '她' }) });
        const { results } = await withEvents(fake, async () => {
            fake.push(message());
            fake.push(message({ message_id: 2 ** 40 + 5 }));
            fake.push({ post_type: 'notice', notice_type: 'friend_recall', self_id: SELF, user_id: USER, message_id: 777, time: 1_800_000_001 });
            await new Promise(resolve => setTimeout(resolve, 20));
        });
        const calls = fake.calls.map(call => call.action);
        assert.equal(calls.filter(action => action === 'set_msg_emoji_like').length, 1);
        assert.equal(calls.filter(action => action === 'mark_private_msg_as_read').length, 1);
        assert.deepEqual(fake.calls.find(call => call.action === 'set_msg_emoji_like')?.params, { message_id: 777, emoji_id: '76', set: true });
        assert.deepEqual(fake.calls.find(call => call.action === 'mark_private_msg_as_read')?.params, { user_id: String(USER) });
        const bits = results.filter(result => result.name.startsWith('消息 id 是 32 位'));
        assert.deepEqual(bits.map(result => result.ok), [true, false], '777 是，2**40+5 不是');
        const recall = results.find(result => result.name.startsWith('撤回'));
        assert.equal(recall?.ok, true);
        assert.match(recall!.detail, /撤回的 id 就是刚收到的那条/);
    });

    test('events：引用回复 → get_msg 查被引用的那条，转成「[引用你说的：…]」；查不到则记失败', async () => {
        const fake = fakeNapcat({
            get_login_info: ok({ user_id: SELF, nickname: '她' }),
            get_msg: params => params.message_id === 41 ? ok({ sender: { user_id: SELF }, message: [{ type: 'text', data: { text: '我周三有早八' } }] }) : failed(1200, '消息不存在'),
        });
        const { results } = await withEvents(fake, async () => {
            fake.push(message({ message_id: 100, message: [{ type: 'reply', data: { id: '41' } }, { type: 'text', data: { text: '早八好惨' } }] }));
            fake.push(message({ message_id: 101, message: [{ type: 'reply', data: { id: '99' } }, { type: 'text', data: { text: '嗯' } }] }));
            await new Promise(resolve => setTimeout(resolve, 20));
        });
        const quotes = results.filter(result => result.name.startsWith('引用回复'));
        assert.equal(quotes[0]?.ok, true);
        assert.match(quotes[0]!.detail, /发送者是她.*带「\[引用…\]」/);
        assert.equal(quotes[1]?.ok, false);
        assert.match(quotes[1]!.detail, /消息不存在/);
    });

    test('events：你戳她 → 机器人认得；她自己戳你的回声不算机器人认得的，但不记成失败；其他通知只打印形状', async () => {
        const fake = fakeNapcat({ get_login_info: ok({ user_id: SELF, nickname: '她' }) });
        const { results, lines } = await withEvents(fake, async () => {
            fake.push(poke);
            fake.push({ ...poke, sender_id: SELF, target_id: USER });
            fake.push({ post_type: 'notice', notice_type: 'notify', sub_type: 'profile_like', self_id: SELF, user_id: USER, times: 1 });
            await new Promise(resolve => setTimeout(resolve, 20));
        });
        const pokes = results.filter(result => result.name.includes('戳'));
        assert.equal(pokes.length, 2);
        assert.match(pokes[0]!.name, /机器人认得（isPokeAtMe）/);
        assert.equal(pokes[0]!.ok, true);
        assert.match(pokes[1]!.name, /不算/);
        assert.equal(pokes[1]!.ok, true, '她自己戳的回声不是问题');
        assert.ok(lines.some(line => line.includes('profile_like')));
        assert.ok(lines.some(line => line.includes('没试到') && line.includes('撤回')), '没做的动作提示一下，但不算失败');
    });

    test('events：别人的消息、自己的回声、心跳都不碰；正文不进输出', async () => {
        const fake = fakeNapcat({ get_login_info: ok({ user_id: SELF, nickname: '她' }) });
        const { results, lines } = await withEvents(fake, async () => {
            fake.push(message({ user_id: 99999 }));
            fake.push(message({ user_id: SELF }));
            fake.push({ post_type: 'notice', notice_type: 'friend_recall', self_id: SELF, user_id: USER, message_id: 5, nickname: '秘密昵称abc', time: 1 });
            await new Promise(resolve => setTimeout(resolve, 20));
        });
        assert.equal(fake.calls.filter(call => call.action === 'set_msg_emoji_like').length, 0);
        assert.ok(!results.some(result => result.name.startsWith('收到你的私聊')));
        assert.ok(!JSON.stringify([results, lines]).includes('秘密昵称'));
        assert.ok(!JSON.stringify([results, lines]).includes('你好呀'));
    });

    test('撤回自己发的消息（selfrecall，要明确写进 steps）：发一条、过几秒用 delete_msg 撤回同一个 id；自己撤回的通知只描述形状；默认步骤里没有它', async () => {
        const fake = fakeNapcat({ send_private_msg: ok({ message_id: 4242 }) });
        const before = await runProbe({ connection: fake.connection, user: USER, sleep: noSleep });
        assert.ok(!fake.calls.some(call => call.action === 'send_private_msg'), '默认不发任何消息');
        assert.ok(before.every(result => result.step !== 'selfrecall'));
        const lines: string[] = [];
        const running = runProbe({ connection: fake.connection, user: USER, steps: ['selfrecall'], say: line => lines.push(line), sleep: () => new Promise(resolve => setTimeout(resolve, 20)) });
        await new Promise(resolve => setTimeout(resolve, 5));
        fake.push({ post_type: 'notice', notice_type: 'friend_recall', self_id: SELF, user_id: USER, message_id: 4242, time: 1_800_000_000 });
        const results = await running;
        const sentIndex = fake.calls.findIndex(call => call.action === 'send_private_msg');
        const deleteIndex = fake.calls.findIndex(call => call.action === 'delete_msg');
        assert.ok(sentIndex >= 0 && deleteIndex > sentIndex);
        assert.deepEqual(fake.calls[deleteIndex]!.params, { message_id: 4242 });
        assert.deepEqual(fake.calls[sentIndex]!.params.user_id, String(USER));
        assert.ok(results.every(result => result.ok), JSON.stringify(results));
        assert.ok(results.some(result => result.name === '自己撤回的通知' && result.detail.includes('机器人认得')));

        const refused = fakeNapcat({ send_private_msg: ok({ message_id: 7 }), delete_msg: failed(1200, '超过两分钟') });
        const failedRun = await runProbe({ connection: refused.connection, user: USER, steps: ['selfrecall'], sleep: noSleep });
        assert.deepEqual(failedRun.map(result => result.ok), [true, false]);
        assert.match(failedRun[1]!.detail, /超过两分钟/);
    });

    test('签名：读 → 改 → 读回来核对 → 改回；读不到原来的就不改', async () => {
        let current = '原来的签名';
        const fake = fakeNapcat({
            get_login_info: ok({ user_id: SELF, nickname: '她' }),
            get_stranger_info: () => ok({ long_nick: current }),
            set_self_longnick: params => { current = String(params.longNick); return ok(); },
        });
        const results = await runProbe({ connection: fake.connection, user: USER, steps: ['login', 'signature'], signature: '试一下', sleep: noSleep });
        assert.deepEqual(fake.calls.filter(call => call.action === 'set_self_longnick').map(call => call.params.longNick), ['试一下', '原来的签名']);
        assert.equal(current, '原来的签名');
        assert.ok(results.filter(result => result.step === 'signature').every(result => result.ok));

        const blind = fakeNapcat({ get_login_info: ok({ user_id: SELF, nickname: '她' }), get_stranger_info: failed(1200, '查不到') });
        const refused = await runProbe({ connection: blind.connection, user: USER, steps: ['login', 'signature'], signature: '试一下', sleep: noSleep });
        assert.equal(blind.calls.filter(call => call.action === 'set_self_longnick').length, 0, '读不到原来的，就不敢改');
        assert.equal(refused.at(-1)?.ok, false);
    });

    test('说说：只发「仅自己可见」（64），拿到 tid 立刻删；不给 --qzone 不碰', async () => {
        const fake = fakeNapcat({ send_qzone_msg: ok({ tid: 'abc123' }) });
        await runProbe({ connection: fake.connection, user: USER, steps: ['qzone'], sleep: noSleep });
        assert.equal(fake.calls.length, 0);
        const results = await runProbe({ connection: fake.connection, user: USER, steps: ['qzone'], qzone: true, sleep: noSleep });
        assert.deepEqual(fake.calls.map(call => [call.action, call.params.ugc_right ?? call.params.tid]), [['send_qzone_msg', 64], ['delete_qzone_msg', 'abc123']]);
        assert.ok(results.every(result => result.ok));
    });

    test('shapeOf：数字和短枚举留着，正文、昵称、链接换成字数', () => {
        const shaped = shapeOf({ post_type: 'message', message_id: 7, sender: { user_id: 1, nickname: 'abc' }, message: [{ type: 'text', data: { text: 'hello' } }, { type: 'image', data: { url: 'https://x/y.png', file: 'f.png' } }] });
        assert.deepEqual(shaped, {
            post_type: 'message', message_id: 7, sender: { user_id: 1, nickname: '<字符串 3 字>' },
            message: [{ type: 'text', data: { text: '<字符串 5 字>' } }, { type: 'image', data: { url: '<字符串 15 字>', file: '<字符串 5 字>' } }],
        });
    });

    test('参数和配置：认得出的步骤；坏的参数报错；从 onebot11.json 取地址和 token', () => {
        assert.deepEqual(parseArgs(['--user', '10001', '--steps', 'login,poke', '--qzone', '--events-seconds', '30']), { user: 10001, steps: ['login', 'poke'], qzone: true, eventsSeconds: 30 });
        assert.throws(() => parseArgs(['--steps', 'login,fly']), /不认识的步骤：fly/);
        assert.throws(() => parseArgs(['--nope']), /不认识的参数/);
        assert.throws(() => parseArgs(['--user']), /后面要有值/);
        const server = serverFromConfig(JSON.stringify({ network: { websocketServers: [{ name: 'other', enable: true, host: '0.0.0.0', port: 1, token: 'x' }, { name: 'qqbot', enable: true, host: '0.0.0.0', port: 3001, token: 't' }] } }));
        assert.deepEqual(server, { url: 'ws://127.0.0.1:3001/', token: 't' });
        assert.throws(() => serverFromConfig(JSON.stringify({ network: { websocketServers: [{ name: 'qqbot', enable: false, port: 3001 }] } })), /没有启用/);
    });

    test('connect：按 echo 对上回话；事件推给监听者（心跳不推）；对方断了，没回的请求立刻失败', async () => {
        const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
        try {
            await new Promise(resolve => server.once('listening', resolve));
            const { port } = server.address() as { port: number };
            server.on('connection', socket => {
                socket.on('message', raw => {
                    const request = JSON.parse(String(raw)) as { action: string; echo: string };
                    if (request.action === 'hang') { socket.close(); return; }
                    socket.send(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'heartbeat' }));
                    socket.send(JSON.stringify({ post_type: 'notice', notice_type: 'friend_recall', message_id: 3 }));
                    socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { echoed: request.action }, echo: request.echo }));
                });
            });
            const connection = await connect(`ws://127.0.0.1:${port}/`);
            const events: Record<string, unknown>[] = [];
            connection.onEvent(event => events.push(event));
            const response = await connection.call('get_login_info', {});
            assert.deepEqual(response.data, { echoed: 'get_login_info' });
            assert.deepEqual(events, [{ post_type: 'notice', notice_type: 'friend_recall', message_id: 3 }]);
            const cut = await connection.call('hang', {});
            assert.equal(cut.status, 'failed');
            assert.match(cut.message ?? '', /连接断了/);
            connection.close();
        } finally {
            server.close();
        }
    });
});

describe('NapCat 探针：外层 ok 但内核拒绝（data.result 非 0）算失败', () => {
    test('typing：set_input_status 外层 ok、result 65011 → 这一项失败，并写明是内核拒绝', async () => {
        const fake = fakeNapcat({ set_input_status: ok({ result: 65011, errMsg: '操作失败，请稍后再试哦' }) });
        const results = await runProbe({ connection: fake.connection, user: USER, steps: ['typing'], sleep: noSleep });
        assert.equal(results[0]!.ok, false);
        assert.match(results[0]!.detail, /QQ 内核拒绝了.*65011.*操作失败/);
    });

    test('typing：内核回 result 0（errMsg success）照旧成功', async () => {
        const fake = fakeNapcat({ set_input_status: ok({ result: 0, errMsg: 'success' }) });
        const results = await runProbe({ connection: fake.connection, user: USER, steps: ['typing'], sleep: noSleep });
        assert.equal(results[0]!.ok, true);
    });

    test('events：表情回应被内核拒绝 → 记成失败，不再被外层的 ok 骗（10-20 私聊实测 65011）', async () => {
        const fake = fakeNapcat({
            get_login_info: ok({ user_id: SELF, nickname: '她' }),
            set_msg_emoji_like: ok({ result: 65011, errMsg: '操作失败，请稍后再试哦' }),
        });
        const { results } = await withEvents(fake, async () => {
            fake.push(message());
            await new Promise(resolve => setTimeout(resolve, 20));
        });
        const reaction = results.find(result => result.name.includes('表情回应'));
        assert.ok(reaction, '有表情回应这一项');
        assert.equal(reaction.ok, false);
        assert.match(reaction.detail, /QQ 内核拒绝了/);
    });
});

describe('voice 步骤（ADR 0140）', () => {
    test('给了音频就发一条 record 段；没给音频记失败、不调接口；NapCat 报错记失败', async () => {
        const fake = fakeNapcat();
        const sent = await runProbe({ connection: fake.connection, user: USER, steps: ['voice'], voiceFile: 'D:/x/a.wav', say: () => undefined, sleep: noSleep });
        assert.deepEqual(sent.map(r => [r.step, r.ok]), [['voice', true]]);
        assert.deepEqual(fake.calls, [{ action: 'send_private_msg', params: { user_id: String(USER), message: [{ type: 'record', data: { file: 'D:/x/a.wav' } }] } }]);

        const none = fakeNapcat();
        const skipped = await runProbe({ connection: none.connection, user: USER, steps: ['voice'], say: () => undefined, sleep: noSleep });
        assert.equal(skipped[0]!.ok, false);
        assert.deepEqual(none.calls, []);

        const broken = fakeNapcat({ send_private_msg: failed(200, '语音转换失败') });
        const failedSend = await runProbe({ connection: broken.connection, user: USER, steps: ['voice'], voiceFile: 'a.wav', say: () => undefined, sleep: noSleep });
        assert.equal(failedSend[0]!.ok, false);
        assert.match(failedSend[0]!.detail, /语音转换失败/);
    });

    test('参数：--steps voice、--voice-dir、--voice-text 认得；voice 不在默认步骤里', () => {
        const args = parseArgs(['--user', '1', '--steps', 'voice', '--voice-dir', 'D:/v', '--voice-text', '你好']);
        assert.deepEqual([args.steps, args.voiceDir, args.voiceText], [['voice'], 'D:/v', '你好']);
    });
});
