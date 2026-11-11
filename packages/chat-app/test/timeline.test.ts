import assert from 'node:assert/strict';
import test from 'node:test';
import { copyText, faceDisplay, reactionDisplay, formatDuration, formatStamp, previewText } from '../src/format.js';
import { addPending, applyFrame, createState, markSeen } from '../src/store.js';
import { buildTimeline, rowSignature, statusText, type BubbleRow, type Row } from '../src/timeline.js';
import type { ConversationState, Message, Part, ServerFrame } from '../src/types.d.ts';

/** 本地时间 2026-03-10 12:00，测试不依赖时区 */
const NOON = new Date(2026, 2, 10, 12, 0, 0).getTime();
const MIN = 60_000;
const text = (value: string): Part[] => [{ kind: 'text', text: value }];
const msg = (seq: number, from: 'her' | 'me', at: number, extra: Partial<Message> = {}): Message =>
    ({ seq, id: 1000 + seq, from, via: 'app', at, parts: text(`m${seq}`), ...extra });
const build = (...frames: (Message | ServerFrame)[]): ConversationState =>
    frames.reduce((s, f) => applyFrame(s, 'type' in f ? f : { type: 'message', message: f }, NOON), createState());
const bubbles = (rows: Row[]) => rows.filter((row): row is BubbleRow => row.type === 'bubble');
const shape = (rows: Row[]) => rows.map(row => (row.type === 'bubble' ? `${row.mine ? 'me' : 'her'}${row.first ? '[' : ''}${row.last ? ']' : ''}` : row.type === 'stamp' ? `stamp:${row.label}` : row.type === 'notice' ? `notice:${row.text}` : row.type));

test('时间条：新的一天、隔 5 分钟以上才标；标了之后重新分组', () => {
    const state = build(
        msg(1, 'her', NOON - 26 * 60 * MIN),
        msg(2, 'her', NOON - 26 * 60 * MIN + 30_000),
        msg(3, 'me', NOON - 10 * MIN),
        msg(4, 'me', NOON - 10 * MIN + 20_000),
        msg(5, 'me', NOON - 4 * MIN),
        msg(6, 'her', NOON - 3 * MIN),
    );
    assert.deepEqual(shape(buildTimeline(state, { now: NOON })), [
        'stamp:昨天 10:00', 'her[', 'her]',
        'stamp:11:50', 'me[', 'me]',
        'stamp:11:56', 'me[]', 'her[]',
    ]);
});

test('时间文字：今天 / 昨天 / 前天 / 星期 / 同年 / 跨年', () => {
    const day = 24 * 60 * MIN;
    assert.equal(formatStamp(NOON - 5 * MIN, NOON), '11:55');
    assert.equal(formatStamp(NOON - day, NOON), '昨天 12:00');
    assert.equal(formatStamp(NOON - 2 * day, NOON), '前天 12:00');
    assert.equal(formatStamp(NOON - 4 * day, NOON), '星期五 12:00');
    assert.equal(formatStamp(new Date(2026, 0, 3, 8, 5).getTime(), NOON), '1月3日 08:05');
    assert.equal(formatStamp(new Date(2025, 10, 3, 21, 3).getTime(), NOON), '2025年11月3日 21:03');
    assert.equal(formatStamp(new Date(2026, 2, 9, 23, 59).getTime(), new Date(2026, 2, 10, 0, 1).getTime()), '昨天 23:59', '按日历日算，不按 24 小时');
});

test('分组：同一个人 2 分钟内连发才连成一组', () => {
    const state = build(msg(1, 'her', NOON), msg(2, 'her', NOON + 1 * MIN), msg(3, 'her', NOON + 4 * MIN), msg(4, 'me', NOON + 4 * MIN + 1000));
    assert.deepEqual(shape(buildTimeline(state, { now: NOON + 5 * MIN })).slice(1), ['her[', 'her]', 'her[]', 'me[]']);
});

test('撤回和戳一戳是居中的提示行，并打断分组', () => {
    const state = build(
        msg(1, 'her', NOON), msg(2, 'her', NOON + 1000), msg(3, 'her', NOON + 2000),
        msg(4, 'me', NOON + 3000, { recalled: true }),
        msg(5, 'her', NOON + 4000, { parts: [{ kind: 'poke' }] }),
        msg(6, 'me', NOON + 5000, { parts: [{ kind: 'poke' }] }),
        { type: 'event', seq: 7, event: { kind: 'recall', id: 1002 } },
    );
    assert.deepEqual(shape(buildTimeline(state, { now: NOON })), [
        'stamp:12:00', 'her[]', 'notice:对方撤回了一条消息', 'her[]', 'notice:你撤回了一条消息', 'notice:她戳了戳你', 'notice:你戳了戳她',
    ]);
});

test('已读 / 已送达只标在最后一条自己的消息上，她回了之后就不标了', () => {
    let state = build(msg(1, 'me', NOON), msg(2, 'me', NOON + 1000));
    let mine = bubbles(buildTimeline(state, { now: NOON }));
    assert.deepEqual(mine.map(row => [row.status, row.showStatus]), [['sent', false], ['sent', true]]);
    assert.equal(statusText(mine[1] as BubbleRow), '已送达');
    state = applyFrame(state, { type: 'event', seq: 3, event: { kind: 'read', upTo: 1002 } }, NOON);
    mine = bubbles(buildTimeline(state, { now: NOON }));
    assert.deepEqual(mine.map(row => row.status), ['read', 'read']);
    assert.equal(statusText(mine[1] as BubbleRow), '已读');
    state = applyFrame(state, { type: 'message', message: msg(4, 'her', NOON + 2000) }, NOON);
    assert.equal(bubbles(buildTimeline(state, { now: NOON })).some(row => row.showStatus), false);
});

test('本地气泡排在最后，带状态；ack 之后行的 key 不变（气泡不闪）', () => {
    let state = build(msg(1, 'her', NOON));
    state = addPending(state, { clientId: 'c1', at: NOON + 1000, parts: text('在吗'), status: 'sending' });
    state = addPending(state, {
        clientId: 'c2', at: NOON + 2000, parts: [{ kind: 'image', mediaId: '', mime: 'image/jpeg' }], status: 'uploading',
        upload: { localId: 'l1', kind: 'image', mime: 'image/jpeg', progress: 0.37 },
    });
    state = addPending(state, { clientId: 'c3', at: NOON + 3000, parts: text('x'), status: 'failed', error: '没能交到她那边' });
    const rows = bubbles(buildTimeline(state, { now: NOON }));
    assert.deepEqual(rows.map(row => row.status), ['none', 'sending', 'uploading', 'failed']);
    assert.deepEqual(rows.slice(1).map(statusText), ['发送中…', '上传中 37%', '没能交到她那边 · 点一下重试']);
    assert.equal(rows[2]?.localId, 'l1');
    const before = rows[1]?.key;
    state = applyFrame(state, { type: 'ack', clientId: 'c1', id: 9000, seq: 2 }, NOON);
    const after = bubbles(buildTimeline(state, { now: NOON })).find(row => row.id === 9000);
    assert.equal(after?.key, before);
    assert.equal(after?.status, 'sent');
});

test('未读分界画在她的第一条未读前面；都看过了就不画', () => {
    const state = markSeen(build(msg(1, 'her', NOON), msg(2, 'me', NOON + 1000), msg(3, 'me', NOON + 2000), msg(4, 'her', NOON + 3000), msg(5, 'her', NOON + 4000)), 2);
    const rows = buildTimeline(state, { now: NOON, unreadAfter: state.lastSeenSeq });
    assert.deepEqual(shape(rows), ['stamp:12:00', 'her[]', 'me[', 'me]', 'unread', 'her[', 'her]']);
    assert.equal(buildTimeline(state, { now: NOON, unreadAfter: 5 }).some(row => row.type === 'unread'), false);
    assert.equal(buildTimeline(state, { now: NOON }).some(row => row.type === 'unread'), false);
});

test('引用：找得到显示摘要，被撤回 / 没加载各有说法', () => {
    const state = build(
        msg(1, 'her', NOON, { parts: [{ kind: 'text', text: '今天\n好冷' }, { kind: 'face', id: 14 }] }),
        msg(2, 'me', NOON + 1000, { replyTo: 1001 }),
        msg(3, 'her', NOON + 2000, { replyTo: 1002 }),
        msg(4, 'me', NOON + 3000, { replyTo: 555 }),
        msg(5, 'her', NOON + 4000, { recalled: true }),
        msg(6, 'me', NOON + 5000, { replyTo: 1005 }),
    );
    const replies = bubbles(buildTimeline(state, { now: NOON })).map(row => row.reply);
    assert.deepEqual(replies, [
        undefined,
        { id: 1001, found: true, mine: false, text: '今天 好冷🙂' },
        { id: 1002, found: true, mine: true, text: 'm2' },
        { id: 555, found: false, mine: false, text: '更早的一条消息' },
        { id: 1005, found: false, mine: false, text: '消息已撤回' },
    ]);
});

test('表情回应和 QQ 来源带在行上；行签名在内容变化时才变', () => {
    let state = build(msg(1, 'me', NOON, { via: 'qq' }));
    const before = buildTimeline(state, { now: NOON })[1] as BubbleRow;
    assert.equal(before.viaQq, true);
    assert.equal(rowSignature(before), rowSignature(buildTimeline(state, { now: NOON + 1000 })[1] as Row));
    state = applyFrame(state, { type: 'event', seq: 2, event: { kind: 'reaction', id: 1001, emojiId: 76 } }, NOON);
    const after = buildTimeline(state, { now: NOON })[1] as BubbleRow;
    assert.deepEqual(after.reactions, [76]);
    assert.notEqual(rowSignature(before), rowSignature(after));
});

test('QQ 表情：常见的映射成 emoji，其余显示 [名字]；回应里的 Unicode 码位直接显示', () => {
    assert.deepEqual(faceDisplay(76), { text: '👍', label: '赞', emoji: true });
    assert.deepEqual(faceDisplay(9999, '新表情'), { text: '[新表情]', label: '新表情', emoji: false });
    assert.deepEqual(faceDisplay(5000), { text: '[表情]', label: '表情', emoji: false });
    assert.equal(reactionDisplay(128077).text, '👍');
    assert.equal(reactionDisplay(76).text, '👍');
    assert.equal(reactionDisplay(5000).text, '[表情]');
});

test('摘要、复制和时长', () => {
    const parts: Part[] = [{ kind: 'text', text: '看这个 ' }, { kind: 'image', mediaId: 'm', mime: 'image/png' }, { kind: 'card', title: '文章', url: 'https://example.com/a' }];
    assert.equal(previewText({ parts }), '看这个 [图片][卡片] 文章');
    assert.equal(previewText({ parts: text('一二三四五六') }, 4), '一二三四…');
    assert.equal(copyText({ parts }), '看这个 文章 https://example.com/a');
    assert.equal(previewText({ parts: [{ kind: 'voice', mediaId: 'm', mime: 'audio/ogg' }] }), '[语音]');
    assert.equal(formatDuration(3200), '0:03');
    assert.equal(formatDuration(65_000), '1:05');
    assert.equal(formatDuration(200), '0:01');
    assert.equal(formatDuration(undefined), '');
});
