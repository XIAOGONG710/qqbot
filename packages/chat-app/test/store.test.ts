import assert from 'node:assert/strict';
import test from 'node:test';
import {
    addPending, applyFrame, applyHistory, createState, disconnected, dropBefore, hasReplayGap, expireTyping, failPending, findById, isRecalled, markSeen, oldestSeq,
    prependLocal, removePending, retryPending, sendable, toMeta, trimOldest, unreadCount, uploadDone, uploadProgress, TYPING_TTL_MS,
} from '../src/store.js';
import type { ConversationState, Message, Part, PendingMessage, ServerFrame } from '../src/types.d.ts';

const T0 = 1_750_000_000_000;
const text = (value: string): Part[] => [{ kind: 'text', text: value }];
const msg = (seq: number, from: 'her' | 'me', value = `m${seq}`, extra: Partial<Message> = {}): Message =>
    ({ seq, id: 1000 + seq, from, via: 'app', at: T0 + seq * 1000, parts: text(value), ...extra });
const feed = (state: ConversationState, ...frames: ServerFrame[]) => frames.reduce((s, frame) => applyFrame(s, frame, T0), state);
const message = (m: Message): ServerFrame => ({ type: 'message', message: m });
const pending = (clientId: string, value = 'hi', extra: Partial<PendingMessage> = {}): PendingMessage =>
    ({ clientId, at: T0 + 99_000, parts: text(value), status: 'sending', ...extra });

test('消息按 seq 排序，乱序到达也一样', () => {
    const state = feed(createState(), message(msg(3, 'her')), message(msg(1, 'her')), message(msg(2, 'me')));
    assert.deepEqual(state.messages.map(m => m.seq), [1, 2, 3]);
    assert.equal(state.maxSeq, 3);
});

test('同一个 seq 再来一次不会多出一条（重连补发重叠）', () => {
    const once = feed(createState(), message(msg(1, 'her')), message(msg(2, 'her')));
    const twice = feed(once, message(msg(2, 'her')), message(msg(1, 'her')));
    assert.equal(twice.messages.length, 2);
    assert.equal(twice.maxSeq, 2);
});

test('ack 把本地气泡换成入账的那条：保留内容、时间和引用，带上 id 和 seq', () => {
    let state = addPending(feed(createState(), message(msg(1, 'her'))), pending('c1', '在吗', { replyTo: 1001 }));
    assert.equal(state.pending.length, 1);
    state = feed(state, { type: 'ack', clientId: 'c1', id: 5000, seq: 2 });
    assert.equal(state.pending.length, 0);
    assert.deepEqual(state.messages[1], { seq: 2, id: 5000, from: 'me', via: 'app', at: T0 + 99_000, parts: text('在吗'), clientId: 'c1', replyTo: 1001 });
    assert.equal(state.maxSeq, 2);
});

test('ack 和带 clientId 的 message 都来（哪个先都行）只留一条', () => {
    const echoed = msg(2, 'me', '在吗', { clientId: 'c1', id: 5000 });
    const ackFirst = feed(addPending(createState(), pending('c1', '在吗')), { type: 'ack', clientId: 'c1', id: 5000, seq: 2 }, message(echoed));
    assert.equal(ackFirst.messages.length, 1);
    assert.equal(ackFirst.pending.length, 0);
    const messageFirst = feed(addPending(createState(), pending('c1', '在吗')), message(echoed), { type: 'ack', clientId: 'c1', id: 5000, seq: 2 });
    assert.equal(messageFirst.messages.length, 1);
    assert.equal(messageFirst.pending.length, 0);
    assert.equal(messageFirst.messages[0]?.at, echoed.at);
});

test('同一个 clientId 以不同 seq 再出现（中继没去重）也不画两条', () => {
    const state = feed(createState(), message(msg(2, 'me', 'x', { clientId: 'c1' })), message(msg(5, 'me', 'x', { clientId: 'c1' })));
    assert.deepEqual(state.messages.map(m => m.seq), [2]);
    assert.equal(state.maxSeq, 5, 'since 仍然往前走，不会反复补发');
});

test('同一个 clientId 不会加两次本地气泡', () => {
    const state = addPending(addPending(createState(), pending('c1')), pending('c1'));
    assert.equal(state.pending.length, 1);
});

test('发送失败、重试、删除', () => {
    let state = addPending(createState(), pending('c1'));
    state = feed(state, { type: 'error', code: 'not_delivered', message: 'x', clientId: 'c1' });
    assert.equal(state.pending[0]?.status, 'failed');
    assert.equal(state.pending[0]?.error, '没能交到她那边');
    assert.deepEqual(sendable(state), []);
    state = retryPending(state, 'c1');
    assert.equal(state.pending[0]?.status, 'sending');
    assert.equal(state.pending[0]?.error, undefined);
    assert.equal(state.pending[0]?.clientId, 'c1', '重试用同一个 clientId');
    assert.equal(sendable(state).length, 1);
    state = removePending(state, 'c1');
    assert.equal(state.pending.length, 0);
});

test('不带 clientId 的 error 不动任何气泡', () => {
    const before = addPending(createState(), pending('c1'));
    assert.equal(feed(before, { type: 'error', code: 'rate_limited', message: 'x' }), before);
});

test('图片：上传中不可发，进度更新，传完填上 mediaId 才进发件箱；失败重试从上传开始', () => {
    const upload: PendingMessage = {
        clientId: 'c2', at: T0, status: 'uploading', parts: [{ kind: 'image', mediaId: '', mime: 'image/jpeg' }],
        upload: { localId: 'l1', kind: 'image', mime: 'image/jpeg', progress: 0 },
    };
    let state = addPending(createState(), upload);
    assert.deepEqual(sendable(state), []);
    state = uploadProgress(state, 'c2', 0.4);
    assert.equal(state.pending[0]?.upload?.progress, 0.4);
    state = uploadProgress(state, 'c2', 7);
    assert.equal(state.pending[0]?.upload?.progress, 1);
    const failed = failPending(state, 'c2', '上传失败');
    assert.equal(retryPending(failed, 'c2').pending[0]?.status, 'uploading');
    assert.equal(retryPending(failed, 'c2').pending[0]?.upload?.progress, 0);
    state = uploadDone(state, 'c2', 'media-9');
    assert.deepEqual(state.pending[0], { clientId: 'c2', at: T0, status: 'sending', parts: [{ kind: 'image', mediaId: 'media-9', mime: 'image/jpeg' }] });
    assert.equal(sendable(state).length, 1);
});

test('撤回：事件先到、消息后到也算撤回；补发的消息自带 recalled 也认', () => {
    let state = feed(createState(), { type: 'event', seq: 9, event: { kind: 'recall', id: 1003 } });
    state = prependLocal(state, [msg(3, 'her')]);
    assert.equal(isRecalled(state, state.messages[0] as Message), true);
    assert.equal(state.maxSeq, 9);
    const resumed = feed(createState(), message(msg(4, 'her', 'x', { recalled: true })));
    assert.equal(resumed.recalled['1004'], true);
});

test('已读：upTo 按消息 id 找到那条的 seq；只往前不往回', () => {
    let state = feed(createState(), message(msg(1, 'me')), message(msg(2, 'me')), message(msg(3, 'me')));
    state = feed(state, { type: 'event', seq: 4, event: { kind: 'read', upTo: 1002 } });
    assert.equal(state.readSeq, 2);
    state = feed(state, { type: 'event', seq: 5, event: { kind: 'read', upTo: 1001 } });
    assert.equal(state.readSeq, 2);
    state = feed(state, { type: 'event', seq: 6, event: { kind: 'read', upTo: 1003 } });
    assert.equal(state.readSeq, 3);
});

test('已读：upTo 是消息 id，不当 seq 用；id 超出 int32 也照常；那条不在内存里就不动', () => {
    const big = 10_000_000_007;
    let state = feed(createState(), message(msg(1, 'me')), message(msg(2, 'me', 'x', { id: big })), message(msg(3, 'me')));
    state = feed(state, { type: 'event', seq: 4, event: { kind: 'read', upTo: 2 } });
    assert.equal(state.readSeq, 0, '2 是 seq 不是 id');
    state = feed(state, { type: 'event', seq: 5, event: { kind: 'read', upTo: big } });
    assert.equal(state.readSeq, 2);
    assert.equal(feed(state, { type: 'event', seq: 6, event: { kind: 'read', upTo: 987_654 } }).readSeq, 2);
});

test('补发有缺口：丢掉本地更早的记录，历史重新算没到头', () => {
    assert.equal(hasReplayGap(40, 41), false);
    assert.equal(hasReplayGap(40, 500), true);
    assert.equal(hasReplayGap(0, 500), false, '新设备第一次同步不算缺口');
    const state = { ...feed(createState(), message(msg(38, 'her')), message(msg(39, 'me')), message(msg(40, 'her'))), historyDone: true };
    const dropped = dropBefore(state, 500);
    assert.deepEqual(dropped.messages, []);
    assert.equal(dropped.historyDone, false);
    assert.equal(dropped.maxSeq, 40);
    assert.deepEqual(dropBefore(state, 40).messages.map(m => m.seq), [40]);
});

test('表情回应：累加、不重复、消息没加载也先记着', () => {
    let state = feed(createState(),
        { type: 'event', seq: 2, event: { kind: 'reaction', id: 1001, emojiId: 76 } },
        { type: 'event', seq: 3, event: { kind: 'reaction', id: 1001, emojiId: 76 } },
        { type: 'event', seq: 4, event: { kind: 'reaction', id: 1001, emojiId: 66 } });
    assert.deepEqual(state.reactions['1001'], [76, 66]);
    state = prependLocal(state, [msg(1, 'me')]);
    assert.deepEqual(state.reactions['1001'], [76, 66]);
});

test('正在输入：她的消息一到就停；断线清掉；太久没更新自动过期', () => {
    let state = feed(createState(), { type: 'typing', on: true });
    assert.equal(state.typing, true);
    assert.equal(feed(state, message(msg(1, 'her'))).typing, false);
    assert.equal(feed(state, message(msg(1, 'me'))).typing, true);
    assert.equal(disconnected(state).typing, false);
    assert.equal(expireTyping(state, T0 + TYPING_TTL_MS - 1).typing, true);
    assert.equal(expireTyping(state, T0 + TYPING_TTL_MS).typing, false);
    state = feed(state, { type: 'typing', on: false });
    assert.equal(state.typing, false);
});

test('ready：记下她的名字、上游状态和 seq；断线后不再算补齐，名字留着', () => {
    let state = feed(createState(), { type: 'ready', seq: 42, self: { name: '小满' }, upstream: 'down' });
    assert.deepEqual([state.synced, state.selfName, state.upstream, state.maxSeq], [true, '小满', 'down', 42]);
    state = feed(state, { type: 'upstream', state: 'up' });
    assert.equal(state.upstream, 'up');
    state = disconnected(state);
    assert.deepEqual([state.synced, state.selfName], [false, '小满']);
    assert.equal(feed(state, { type: 'ready', seq: 40, self: { name: '' }, upstream: 'up' }).maxSeq, 42, 'seq 不回退');
});

test('历史：接到前面，事件一起应用；翻不出更早的就是到头', () => {
    let state = feed(createState(), message(msg(10, 'her')), message(msg(11, 'me')));
    state = applyHistory(state, { messages: [msg(8, 'her'), msg(9, 'me')], events: [{ seq: 12, event: { kind: 'recall', id: 1008 } }] });
    assert.deepEqual(state.messages.map(m => m.seq), [8, 9, 10, 11]);
    assert.equal(state.recalled['1008'], true);
    assert.equal(state.historyDone, false);
    assert.equal(oldestSeq(state), 8);
    assert.equal(applyHistory(state, { messages: [], events: [] }).historyDone, true);
    assert.equal(applyHistory(state, { messages: [msg(1, 'her')], events: [] }).historyDone, true, '翻到 seq 1');
});

test('未读数：只数她发的、他没看过的、没撤回的', () => {
    let state = feed(createState(), message(msg(1, 'her')), message(msg(2, 'me')), message(msg(3, 'her')), message(msg(4, 'her')));
    assert.equal(unreadCount(state), 3);
    state = markSeen(state, 2);
    assert.equal(unreadCount(state), 2);
    state = feed(state, { type: 'event', seq: 5, event: { kind: 'recall', id: 1004 } });
    assert.equal(unreadCount(state), 1);
    assert.equal(markSeen(state, 1).lastSeenSeq, 2, '不回退');
});

test('存取：meta 往返之后状态一致；启动时丢掉已入账的本地气泡', () => {
    let state = feed(createState(), message(msg(1, 'her')), message(msg(2, 'me', 'x', { clientId: 'c1' })),
        { type: 'event', seq: 3, event: { kind: 'read', upTo: 1002 } }, { type: 'ready', seq: 3, self: { name: '小满' }, upstream: 'up' });
    state = markSeen(state, 2);
    const reopened = createState(JSON.parse(JSON.stringify(toMeta(state))), state.messages, [pending('c1'), pending('c7')]);
    assert.deepEqual(reopened.messages, state.messages);
    assert.deepEqual([reopened.maxSeq, reopened.readSeq, reopened.selfName, reopened.lastSeenSeq], [3, 2, '小满', 2]);
    assert.deepEqual(reopened.pending.map(p => p.clientId), ['c7']);
    assert.equal(reopened.synced, false);
    assert.equal(reopened.upstream, 'unknown');
});

test('内存里只留最近一段；按 id 找消息', () => {
    const state = feed(createState(), ...Array.from({ length: 10 }, (_, i) => message(msg(i + 1, 'her'))));
    const trimmed = trimOldest(state, 4);
    assert.deepEqual(trimmed.messages.map(m => m.seq), [7, 8, 9, 10]);
    assert.equal(trimmed.maxSeq, 10);
    assert.equal(trimOldest(state, 50), state);
    assert.equal(findById(state, 1003)?.seq, 3);
    assert.equal(findById(state, 1), undefined);
});

test('状态不可变：应用一帧不改旧状态', () => {
    const before = feed(createState(), message(msg(1, 'her')));
    const snapshot = JSON.stringify(before);
    feed(addPending(before, pending('c1')), message(msg(2, 'her')), { type: 'ack', clientId: 'c1', id: 9, seq: 3 }, { type: 'event', seq: 4, event: { kind: 'recall', id: 1001 } });
    assert.equal(JSON.stringify(before), snapshot);
});
