import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TestContext } from 'node:test';
import { RELAY_ID_BASE, createRelayCore, failed, ok } from '../src/core.ts';
import { createLedger, memoryLedgerStorage } from '../src/ledger.ts';
import { createMediaStore } from '../src/media.ts';
import type { DeliveryRule, OneBotResponse, ServerFrame } from '../src/types.ts';
import { HER, OWNER, PNG, tempDir } from './helpers.ts';

const T0 = 1_800_000_000_000;
const text = (value: string) => [{ type: 'text', data: { text: value } }];

function setup(t: TestContext, options: { delivery?: DeliveryRule; upstream?: boolean; koishi?: boolean; log?: string } = {}) {
    const storage = memoryLedgerStorage(options.log);
    const ledger = createLedger(storage);
    const media = createMediaStore({ dir: tempDir(t) });
    const state = { upstream: options.upstream ?? true, koishi: options.koishi ?? true, time: T0, nextQQId: 500 };
    const calls: { action: string; params: unknown }[] = [];
    const pushed: Record<string, unknown>[] = [];
    const frames: ServerFrame[] = [];
    const logs: string[] = [];
    let respond = (action: string, _params: unknown): OneBotResponse =>
        action === 'send_private_msg' ? ok({ message_id: state.nextQQId++ }) : ok(null);
    const core = createRelayCore({
        config: { ownerId: OWNER, ownerName: '阿明', selfId: HER, selfName: '小瑶', delivery: options.delivery ?? 'last-active' },
        ledger, media,
        fetcher: async () => PNG,
        now: () => state.time,
        upstream: {
            connected: () => state.upstream,
            call: async (action, params) => {
                if (!state.upstream) return failed(1404, 'upstream offline');
                calls.push({ action, params });
                return respond(action, params);
            },
        },
        koishi: { connected: () => state.koishi, push: event => { pushed.push(event); } },
        apps: { broadcast: frame => { frames.push(frame); } },
        localMediaUrl: id => `http://127.0.0.1:1/media/${id}`,
        log: line => { logs.push(line); },
    });
    return { core, ledger, media, storage, state, calls, pushed, frames, logs, setRespond(next: typeof respond) { respond = next; } };
}

const appSend = (clientId: string, value = '在吗') => ({ type: 'send', clientId, parts: [{ kind: 'text', text: value }] });

test('没有 App 用过、上游在：她发给他的话原样走 QQ，并镜像进消息账', async t => {
    const h = setup(t);
    const params = { user_id: OWNER, message: text('早') };
    const response = await h.core.handleAction('send_private_msg', params);
    await h.core.idle();
    assert.deepEqual(response, ok({ message_id: 500 }));
    assert.deepEqual(h.calls, [{ action: 'send_private_msg', params }]);
    assert.deepEqual(h.frames, [{ type: 'message', message: { seq: 1, id: 500, from: 'her', via: 'qq', at: T0, parts: [{ kind: 'text', text: '早' }] } }]);
});

test('他最近在 App 里说话：她的话发到 App，不碰 QQ；id 在中继自己的那一段', async t => {
    const h = setup(t);
    assert.deepEqual(await h.core.appCommand(appSend('c1')), [{ type: 'ack', clientId: 'c1', id: RELAY_ID_BASE + 1, seq: 1 }]);
    const response = await h.core.handleAction('send_private_msg', { user_id: String(OWNER), message: text('在呢') });
    assert.deepEqual(response, ok({ message_id: RELAY_ID_BASE + 2 }));
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.frames.at(-1), { type: 'message', message: { seq: 2, id: RELAY_ID_BASE + 2, from: 'her', via: 'app', at: T0, parts: [{ kind: 'text', text: '在呢' }] } });
});

test('他又回到 QQ 上说话：她的话跟回 QQ', async t => {
    const h = setup(t);
    await h.core.appCommand(appSend('c1'));
    h.core.handleUpstreamEvent({ post_type: 'message', message_type: 'private', sub_type: 'friend', time: T0 / 1000, self_id: HER, user_id: OWNER, message_id: 41, message: text('我在 QQ 上'), raw_message: '我在 QQ 上' });
    await h.core.idle();
    assert.deepEqual(h.ledger.byId(41), { seq: 2, id: 41, from: 'me', via: 'qq', at: T0, parts: [{ kind: 'text', text: '我在 QQ 上' }] });
    await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('看到了') });
    assert.deepEqual(h.calls.map(call => call.action), ['send_private_msg']);
});

test('上游不在：一律发到 App，哪怕他最近是在 QQ 上说的', async t => {
    const h = setup(t);
    h.core.handleUpstreamEvent({ post_type: 'message', message_type: 'private', time: 1, self_id: HER, user_id: OWNER, message_id: 41, message: text('a') });
    await h.core.idle();
    h.state.upstream = false;
    const response = await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('QQ 断了我也在') });
    assert.equal(response.status, 'ok');
    assert.equal((response.data as { message_id: number }).message_id, RELAY_ID_BASE + 1);
    assert.equal(h.ledger.byId(RELAY_ID_BASE + 1)?.via, 'app');
});

test('NapCat 还连着但心跳说 QQ 掉线：她的话改走 App，App 看到 upstream down', async t => {
    const h = setup(t);
    h.core.upstreamChanged();
    assert.deepEqual(h.frames, [{ type: 'upstream', state: 'up' }]);
    h.core.handleUpstreamEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: false, good: false } });
    assert.deepEqual(h.frames.at(-1), { type: 'upstream', state: 'down' });
    assert.equal(h.core.upstreamState(), 'down');
    await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('在') });
    assert.deepEqual(h.calls, []);
    // 别的动作照样透传给 NapCat，让它自己回失败
    await h.core.handleAction('send_private_msg', { user_id: 30003, message: text('在') });
    assert.equal(h.calls.length, 1);
    h.core.handleUpstreamEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: true } });
    assert.deepEqual(h.frames.at(-1), { type: 'upstream', state: 'up' });
});

test('last-active：他在 QQ 上而 QQ 发送失败，照实回失败，不偷偷改发 App', async t => {
    const h = setup(t);
    h.setRespond(() => failed(1200, 'send failed'));
    const response = await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('a') });
    assert.deepEqual(response, failed(1200, 'send failed'));
    assert.equal(h.ledger.seq, 0);
});

test('both：上游在就发 QQ（App 看到镜像）；QQ 失败改发 App；上游不在发 App', async t => {
    const h = setup(t, { delivery: 'both' });
    await h.core.appCommand(appSend('c1'));
    assert.deepEqual(await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('两边') }), ok({ message_id: 500 }));
    await h.core.idle();
    assert.equal(h.ledger.byId(500)?.via, 'qq');

    h.setRespond(() => failed(1200, 'send failed'));
    const fallback = await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('QQ 发不出') });
    assert.deepEqual(fallback, ok({ message_id: RELAY_ID_BASE + 2 }));

    h.state.upstream = false;
    assert.deepEqual(await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('断了') }), ok({ message_id: RELAY_ID_BASE + 3 }));
});

test('发给别人的、发到群里的：上游在原样透传，上游不在照实失败', async t => {
    const h = setup(t);
    await h.core.appCommand(appSend('c1'));
    h.setRespond((action, params) => ok({ echoed: action, params }));
    for (const [action, params] of [
        ['send_private_msg', { user_id: 30003, message: text('给别人') }],
        ['send_group_msg', { group_id: 40004, message: text('群里') }],
        ['send_msg', { message_type: 'group', group_id: 40004, user_id: OWNER, message: text('群里') }],
        ['get_stranger_info', { user_id: OWNER }],
        ['send_like', { user_id: String(OWNER), times: 1 }],
        ['set_online_status', { status: 10 }],
        ['get_friend_msg_history', { user_id: String(OWNER), count: 20 }],
        ['get_login_info', undefined],
    ] as const) {
        assert.deepEqual(await h.core.handleAction(action, params), ok({ echoed: action, params }), action);
    }
    assert.equal(h.calls.length, 8);
    assert.equal(h.ledger.seq, 1);

    h.state.upstream = false;
    for (const action of ['send_group_msg', 'get_stranger_info', 'send_like', 'set_online_status', 'get_group_list', 'send_qzone_msg', 'get_cookies', 'fetch_ptt_text', 'ocr_image']) {
        const response = await h.core.handleAction(action, { user_id: 30003, group_id: 40004 });
        assert.equal(response.status, 'failed', action);
        assert.notEqual(response.retcode, 0, action);
    }
    const other = await h.core.handleAction('send_private_msg', { user_id: 30003, message: text('给别人') });
    assert.equal(other.status, 'failed');
});

test('上游不在时中继自己答的只有名单上那几个', async t => {
    const h = setup(t, { upstream: false });
    assert.deepEqual(await h.core.handleAction('get_login_info', {}), ok({ user_id: HER, nickname: '小瑶' }));
    assert.deepEqual(await h.core.handleAction('get_friend_list', {}), ok([{ user_id: OWNER, nickname: '阿明', remark: '' }]));
    assert.deepEqual(await h.core.handleAction('can_send_image', {}), ok({ yes: true }));
    assert.deepEqual(await h.core.handleAction('can_send_record', {}), ok({ yes: true }));
    assert.equal((await h.core.handleAction('get_status', {})).status, 'ok');
    assert.equal(((await h.core.handleAction('get_version_info', {})).data as { protocol_version: string }).protocol_version, 'v11');
    assert.equal((await h.core.handleAction('get_friend_msg_history', { user_id: 30003 })).status, 'failed');
    assert.equal((await h.core.handleAction('get_group_msg_history', { group_id: 40004 })).status, 'failed');
    assert.equal((await h.core.handleAction('get_msg', { message_id: 41 })).status, 'failed');
    assert.equal((await h.core.handleAction('delete_msg', { message_id: 41 })).status, 'failed');
});

test('上游不在时他的聊天记录从消息账里拼成 OneBot 形状（含他在 App 里发的）', async t => {
    const h = setup(t, { upstream: false });
    await h.core.appCommand(appSend('c1', '第一句'));
    h.state.time += 5000;
    await h.core.handleAction('send_private_msg', { user_id: OWNER, message: [{ type: 'reply', data: { id: String(RELAY_ID_BASE + 1) } }, ...text('第二句')] });
    await h.core.handleAction('friend_poke', { user_id: String(OWNER) });
    await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('撤回的') });
    await h.core.handleAction('delete_msg', { message_id: RELAY_ID_BASE + 4 });

    const response = await h.core.handleAction('get_friend_msg_history', { user_id: String(OWNER), count: 20 });
    assert.deepEqual(response, ok({
        messages: [
            {
                self_id: HER, user_id: OWNER, time: T0 / 1000, message_id: RELAY_ID_BASE + 1, message_seq: RELAY_ID_BASE + 1, real_id: RELAY_ID_BASE + 1,
                message_type: 'private', sub_type: 'friend', sender: { user_id: OWNER, nickname: '阿明', card: '' },
                message: text('第一句'), raw_message: '第一句', font: 14, message_format: 'array', post_type: 'message',
            },
            {
                self_id: HER, user_id: HER, time: T0 / 1000 + 5, message_id: RELAY_ID_BASE + 2, message_seq: RELAY_ID_BASE + 2, real_id: RELAY_ID_BASE + 2,
                message_type: 'private', sub_type: 'friend', sender: { user_id: HER, nickname: '小瑶', card: '' },
                message: [{ type: 'reply', data: { id: String(RELAY_ID_BASE + 1) } }, ...text('第二句')],
                raw_message: `[CQ:reply,id=${RELAY_ID_BASE + 1}]第二句`, font: 14, message_format: 'array', post_type: 'message_sent', target_id: OWNER,
            },
        ],
    }));
    const one = await h.core.handleAction('get_friend_msg_history', { user_id: OWNER, count: 1 });
    assert.deepEqual((one.data as { messages: { message_id: number }[] }).messages.map(m => m.message_id), [RELAY_ID_BASE + 2]);
});

test('他在 App 里发的 → message_private 事件；没连 Koishi 就 not_delivered，不入账', async t => {
    const h = setup(t, { koishi: false });
    assert.deepEqual(await h.core.appCommand(appSend('c1')), [{ type: 'error', code: 'not_delivered', message: '她那边现在没连上，这条没有交给她', clientId: 'c1' }]);
    assert.equal(h.ledger.seq, 0);
    assert.deepEqual(h.pushed, []);

    h.state.koishi = true;
    const image = h.media.put(PNG);
    const frames = await h.core.appCommand({ type: 'send', clientId: 'c2', parts: [{ kind: 'text', text: '看[图]' }, { kind: 'image', mediaId: image.id, mime: 'image/png' }] });
    const id = RELAY_ID_BASE + 1;
    assert.deepEqual(frames, [{ type: 'ack', clientId: 'c2', id, seq: 1 }]);
    const segments = [
        { type: 'text', data: { text: '看[图]' } },
        { type: 'image', data: { file: `${image.id}.png`, url: `http://127.0.0.1:1/media/${image.id}`, file_size: String(PNG.length), sub_type: 0 } },
    ];
    assert.deepEqual(h.pushed, [{
        self_id: HER, user_id: OWNER, time: T0 / 1000, message_id: id, message_seq: id, real_id: id,
        message_type: 'private', sub_type: 'friend', sender: { user_id: OWNER, nickname: '阿明', card: '' },
        message: segments, raw_message: `看&#91;图&#93;[CQ:image,file=${image.id}.png,url=http://127.0.0.1:1/media/${image.id},file_size=${PNG.length},sub_type=0]`,
        font: 14, message_format: 'array', post_type: 'message',
    }]);
    assert.deepEqual(h.frames.at(-1), { type: 'message', message: { seq: 1, id, from: 'me', via: 'app', at: T0, parts: [{ kind: 'text', text: '看[图]' }, { kind: 'image', mediaId: image.id, mime: 'image/png' }], clientId: 'c2' } });
});

test('同一个 clientId 重发：只回 ack，不重复交给她', async t => {
    const h = setup(t);
    const first = await h.core.appCommand(appSend('c1'));
    const again = await h.core.appCommand(appSend('c1', '内容变了也不算新的'));
    assert.deepEqual(again, first);
    assert.equal(h.pushed.length, 1);
    assert.equal(h.ledger.seq, 1);
});

test('App 的坏帧：bad_request，带回 clientId', async t => {
    const h = setup(t);
    const code = async (frame: Record<string, unknown>) => {
        const [reply] = await h.core.appCommand(frame);
        return reply?.type === 'error' ? `${reply.code}:${reply.clientId ?? ''}` : 'accepted';
    };
    assert.equal(await code({ type: 'send', parts: [{ kind: 'text', text: 'a' }] }), 'bad_request:');
    assert.equal(await code({ type: 'send', clientId: 'x'.repeat(65), parts: [{ kind: 'text', text: 'a' }] }), 'bad_request:');
    assert.equal(await code({ type: 'send', clientId: 'c1', parts: [] }), 'bad_request:c1');
    assert.equal(await code({ type: 'send', clientId: 'c1', parts: [{ kind: 'card', title: 'x' }] }), 'bad_request:c1');
    assert.equal(await code({ type: 'send', clientId: 'c1', parts: [{ kind: 'text', text: 'a' }], replyTo: 999 }), 'bad_request:c1');
    assert.equal(await code({ type: 'send', clientId: 'c1', parts: [{ kind: 'text', text: 'a' }], replyTo: '1' }), 'bad_request:c1');
    assert.equal(await code({ type: 'recall', id: 999 }), 'bad_request:');
    assert.equal(await code({ type: 'shell', command: 'x' }), 'bad_request:');
    assert.equal(h.ledger.seq, 0);
    assert.deepEqual(h.pushed, []);
});

test('App 引用一条已有的消息：事件里带 reply 段', async t => {
    const h = setup(t);
    h.core.handleUpstreamEvent({ post_type: 'message', message_type: 'private', time: 1, self_id: HER, user_id: OWNER, message_id: 41, message: text('a') });
    await h.core.idle();
    await h.core.appCommand({ ...appSend('c1', '说这个'), replyTo: 41 });
    assert.deepEqual((h.pushed[0] as { message: unknown }).message, [{ type: 'reply', data: { id: '41' } }, ...text('说这个')]);
    assert.equal(h.ledger.byClientId('c1')?.replyTo, 41);
});

test('App 撤回自己的一条 → friend_recall 通知；别人的、QQ 上的、撤过的都不行', async t => {
    const h = setup(t);
    await h.core.appCommand(appSend('c1'));
    await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('她的') });
    h.core.handleUpstreamEvent({ post_type: 'message', message_type: 'private', time: 1, self_id: HER, user_id: OWNER, message_id: 41, message: text('QQ 上的') });
    await h.core.idle();
    h.pushed.length = 0;

    assert.deepEqual(await h.core.appCommand({ type: 'recall', id: RELAY_ID_BASE + 1 }), []);
    assert.deepEqual(h.pushed, [{ time: T0 / 1000, self_id: HER, post_type: 'notice', notice_type: 'friend_recall', user_id: OWNER, message_id: RELAY_ID_BASE + 1 }]);
    assert.deepEqual(h.frames.at(-1), { type: 'event', seq: 4, event: { kind: 'recall', id: RELAY_ID_BASE + 1 } });
    assert.equal(h.ledger.byId(RELAY_ID_BASE + 1)?.recalled, true);

    for (const id of [RELAY_ID_BASE + 1, RELAY_ID_BASE + 2, 41]) {
        const [reply] = await h.core.appCommand({ type: 'recall', id });
        assert.equal(reply?.type === 'error' && reply.code, 'bad_request', String(id));
    }
    assert.equal(h.pushed.length, 1);
});

test('App 戳她 → notify/poke 通知，账里记一条戳一戳', async t => {
    const h = setup(t);
    assert.deepEqual(await h.core.appCommand({ type: 'poke' }), []);
    assert.deepEqual(h.pushed, [{ time: T0 / 1000, self_id: HER, post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: OWNER, sender_id: OWNER, target_id: HER, raw_info: [] }]);
    assert.deepEqual(h.frames, [{ type: 'message', message: { seq: 1, id: RELAY_ID_BASE + 1, from: 'me', via: 'app', at: T0, parts: [{ kind: 'poke' }] } }]);
});

test('她撤回：中继发的那条在账里标撤回；QQ 的那条交给上游，成功后也标', async t => {
    const h = setup(t);
    await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('QQ 上的') });   // 500，via qq
    await h.core.appCommand(appSend('c1'));
    await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('App 上的') });  // 中继 id
    const relayId = RELAY_ID_BASE + 2;
    h.calls.length = 0;

    assert.deepEqual(await h.core.handleAction('delete_msg', { message_id: relayId }), ok(null));
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.frames.at(-1), { type: 'event', seq: 4, event: { kind: 'recall', id: relayId } });
    // 再撤一次不重复记
    assert.deepEqual(await h.core.handleAction('delete_msg', { message_id: relayId }), ok(null));
    assert.equal(h.ledger.seq, 4);

    assert.deepEqual(await h.core.handleAction('delete_msg', { message_id: 500 }), ok(null));
    assert.deepEqual(h.calls, [{ action: 'delete_msg', params: { message_id: 500 } }]);
    assert.equal(h.ledger.byId(500)?.recalled, true);
    // NapCat 随后还会报一条 friend_recall：不重复记
    h.core.handleUpstreamEvent({ post_type: 'notice', notice_type: 'friend_recall', user_id: OWNER, message_id: 500, time: 1 });
    await h.core.idle();
    assert.equal(h.ledger.seq, 5);

    // 她撤不了他发的，也撤不了不存在的
    assert.equal((await h.core.handleAction('delete_msg', { message_id: RELAY_ID_BASE + 1 })).status, 'failed');
    assert.equal((await h.core.handleAction('delete_msg', { message_id: RELAY_ID_BASE + 99 })).status, 'failed');
});

test('QQ 上撤回失败：账里不标撤回', async t => {
    const h = setup(t);
    await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('a') });
    h.setRespond(() => failed(1200, 'too late'));
    assert.equal((await h.core.handleAction('delete_msg', { message_id: 500 })).status, 'failed');
    assert.equal(h.ledger.byId(500)?.recalled, undefined);
});

test('正在输入：App 收到 typing，不落账；走 QQ 时也交给上游', async t => {
    const h = setup(t);
    await h.core.handleAction('set_input_status', { user_id: String(OWNER), event_type: 1 });
    assert.deepEqual(h.frames, [{ type: 'typing', on: true }]);
    assert.deepEqual(h.calls.map(call => call.action), ['set_input_status']);
    assert.equal(h.ledger.seq, 0);

    await h.core.appCommand(appSend('c1'));
    h.calls.length = 0;
    assert.deepEqual(await h.core.handleAction('set_input_status', { user_id: String(OWNER), event_type: 1 }), ok({ result: 0, errMsg: '' }));
    assert.deepEqual(h.calls, []);
    await h.core.handleAction('set_input_status', { user_id: '30003', event_type: 1 });
    assert.equal(h.frames.filter(frame => frame.type === 'typing').length, 2);
});

test('已读：读到他最新的那条；同一位置不重复记', async t => {
    const h = setup(t, { upstream: false });
    assert.deepEqual(await h.core.handleAction('mark_private_msg_as_read', { user_id: String(OWNER) }), ok(null));
    assert.equal(h.ledger.seq, 0, '他还没说过话，没有可读的');
    await h.core.appCommand(appSend('c1'));
    await h.core.handleAction('mark_private_msg_as_read', { user_id: String(OWNER) });
    await h.core.handleAction('mark_private_msg_as_read', { user_id: String(OWNER) });
    assert.deepEqual(h.frames.filter(frame => frame.type === 'event'), [{ type: 'event', seq: 2, event: { kind: 'read', upTo: RELAY_ID_BASE + 1 } }]);
    await h.core.handleAction('mark_private_msg_as_read', { user_id: '30003' });
    assert.equal(h.ledger.seq, 2);
});

test('她戳他：走 App 时记一条戳一戳；走 QQ 时交给上游并镜像', async t => {
    const h = setup(t);
    await h.core.handleAction('friend_poke', { user_id: String(OWNER) });
    assert.deepEqual(h.calls.map(call => call.action), ['friend_poke']);
    assert.deepEqual(h.ledger.byId(RELAY_ID_BASE + 1), { seq: 1, id: RELAY_ID_BASE + 1, from: 'her', via: 'qq', at: T0, parts: [{ kind: 'poke' }] });
    // NapCat 报回来的她自己的那一下不重复记；他戳她的要记
    h.core.handleUpstreamEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: OWNER, sender_id: HER, target_id: OWNER, time: 1 });
    h.core.handleUpstreamEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', user_id: OWNER, sender_id: OWNER, target_id: HER, time: T0 / 1000 });
    h.core.handleUpstreamEvent({ post_type: 'notice', notice_type: 'notify', sub_type: 'poke', group_id: 40004, user_id: OWNER, sender_id: OWNER, target_id: HER, time: 1 });
    await h.core.idle();
    assert.equal(h.ledger.seq, 2);
    assert.deepEqual(h.ledger.byId(RELAY_ID_BASE + 2), { seq: 2, id: RELAY_ID_BASE + 2, from: 'me', via: 'qq', at: T0, parts: [{ kind: 'poke' }] });

    await h.core.appCommand(appSend('c1'));
    h.calls.length = 0;
    assert.deepEqual(await h.core.handleAction('friend_poke', { user_id: String(OWNER) }), ok(null));
    assert.deepEqual(h.calls, []);
    assert.equal(h.ledger.byId(RELAY_ID_BASE + 4)?.via, 'app');
    await h.core.handleAction('friend_poke', { user_id: '30003' });
    // 上面的 deepEqual(h.calls, []) 把类型收窄成了 never[]
    assert.deepEqual((h.calls as { action: string }[]).map(call => call.action), ['friend_poke']);
});

test('表情回应：中继的消息在账里记一条；QQ 的交给上游，内核说失败就不记', async t => {
    const h = setup(t);
    await h.core.appCommand(appSend('c1'));
    const relayId = RELAY_ID_BASE + 1;
    assert.deepEqual(await h.core.handleAction('set_msg_emoji_like', { message_id: relayId, emoji_id: '76', set: true }), ok({ result: 0, errMsg: '' }));
    assert.deepEqual(h.frames.at(-1), { type: 'event', seq: 2, event: { kind: 'reaction', id: relayId, emojiId: 76 } });
    assert.deepEqual(h.calls, []);
    assert.equal((await h.core.handleAction('set_msg_emoji_like', { message_id: relayId, emoji_id: '76', set: false })).status, 'failed');
    assert.equal((await h.core.handleAction('set_msg_emoji_like', { message_id: RELAY_ID_BASE + 50, emoji_id: '76', set: true })).status, 'failed');

    h.core.handleUpstreamEvent({ post_type: 'message', message_type: 'private', time: 1, self_id: HER, user_id: OWNER, message_id: 41, message: text('a') });
    await h.core.idle();
    h.setRespond(() => ok({ result: 65011, errMsg: '操作失败' }));
    await h.core.handleAction('set_msg_emoji_like', { message_id: 41, emoji_id: '76', set: true });
    assert.equal(h.ledger.seq, 3);
    h.setRespond(() => ok({ result: 0, errMsg: '' }));
    await h.core.handleAction('set_msg_emoji_like', { message_id: 41, emoji_id: '76', set: true });
    assert.deepEqual(h.frames.at(-1), { type: 'event', seq: 4, event: { kind: 'reaction', id: 41, emojiId: 76 } });
});

test('get_msg：中继自己的 id 从账里答，别的交给上游', async t => {
    const h = setup(t);
    await h.core.appCommand(appSend('c1', '那句话'));
    const response = await h.core.handleAction('get_msg', { message_id: RELAY_ID_BASE + 1 });
    assert.equal((response.data as { raw_message: string; user_id: number }).raw_message, '那句话');
    assert.equal((response.data as { user_id: number }).user_id, OWNER);
    assert.deepEqual(h.calls, []);
    assert.equal((await h.core.handleAction('get_msg', { message_id: RELAY_ID_BASE + 7 })).status, 'failed');
    await h.core.handleAction('get_msg', { message_id: 41 });
    assert.deepEqual(h.calls, [{ action: 'get_msg', params: { message_id: 41 } }]);
});

test('发往 App 的那条有一段显示不了：整条失败，不入账', async t => {
    const h = setup(t, { upstream: false });
    const response = await h.core.handleAction('send_private_msg', { user_id: OWNER, message: [...text('看视频'), { type: 'video', data: { file: 'x.mp4' } }] });
    assert.equal(response.status, 'failed');
    assert.equal((await h.core.handleAction('send_private_msg', { user_id: OWNER, message: [] })).status, 'failed');
    assert.equal((await h.core.handleAction('send_private_msg', { user_id: OWNER })).status, 'failed');
    assert.equal(h.ledger.seq, 0);
    assert.deepEqual(h.frames, []);
});

test('镜像只管他这一个人；同一个 id 只记一次；别的事件不进账', async t => {
    const h = setup(t);
    const event = { post_type: 'message', message_type: 'private', sub_type: 'friend', time: 1, self_id: HER, user_id: OWNER, message_id: 41, message: text('a') };
    h.core.handleUpstreamEvent(event);
    h.core.handleUpstreamEvent(event);
    h.core.handleUpstreamEvent({ ...event, user_id: 30003, message_id: 42 });
    h.core.handleUpstreamEvent({ ...event, message_type: 'group', group_id: 40004, message_id: 43 });
    h.core.handleUpstreamEvent({ post_type: 'message_sent', message_type: 'private', time: 2, self_id: HER, user_id: HER, target_id: OWNER, message_id: 44, message: text('她在别处发的') });
    h.core.handleUpstreamEvent({ post_type: 'message_sent', message_type: 'private', time: 2, self_id: HER, user_id: HER, target_id: 30003, message_id: 45, message: text('给别人') });
    h.core.handleUpstreamEvent({ post_type: 'notice', notice_type: 'friend_recall', user_id: 30003, message_id: 41 });
    h.core.handleUpstreamEvent('garbage');
    await h.core.idle();
    assert.deepEqual(h.ledger.after(0, 10).map(entry => 'message' in entry ? [entry.message.id, entry.message.from] : 'event'), [[41, 'me'], [44, 'her']]);
});

test('重启后中继的 id 接着往上编，投递方向也从账里接上', async t => {
    const first = setup(t);
    await first.core.appCommand(appSend('c1'));
    await first.core.handleAction('send_private_msg', { user_id: OWNER, message: text('a') });

    const second = setup(t, { log: first.storage.text() });
    const response = await second.core.handleAction('send_private_msg', { user_id: OWNER, message: text('b') });
    assert.deepEqual(response, ok({ message_id: RELAY_ID_BASE + 3 }));
    assert.deepEqual(second.calls, []);
});

test('日志里没有消息内容', async t => {
    const h = setup(t);
    await h.core.appCommand(appSend('c1', '绝密的一句话'));
    await h.core.handleAction('send_private_msg', { user_id: OWNER, message: text('另一句绝密') });
    h.core.handleUpstreamEvent({ post_type: 'message', message_type: 'private', time: 1, self_id: HER, user_id: OWNER, message_id: 41, message: text('第三句绝密') });
    await h.core.idle();
    assert.ok(h.logs.length >= 3);
    assert.equal(h.logs.some(line => line.includes('绝密')), false);
});
