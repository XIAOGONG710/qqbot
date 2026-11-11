// @ts-check
// 把对话状态排成要画的一行行：时间条、未读分界、提示行、气泡（带分组和发送状态）。纯函数。

import { dayIndex, formatStamp, previewText } from './format.js';

/** 相邻两条隔这么久就重新标时间 */
export const STAMP_GAP_MS = 5 * 60_000;
/** 同一个人在这么短时间内连发的算一组 */
export const GROUP_GAP_MS = 2 * 60_000;

/** @typedef {import('./timeline.d.ts').Row} Row */
/** @typedef {import('./timeline.d.ts').BubbleRow} BubbleRow */

/** @param {import('./types.d.ts').Part[]} parts */
const isPokeOnly = parts => parts.length === 1 && parts[0]?.kind === 'poke';

/**
 * @param {import('./types.d.ts').ConversationState} state
 * @param {{ now: number, unreadAfter?: number }} options
 * @returns {Row[]}
 */
export function buildTimeline(state, options) {
    const { now, unreadAfter } = options;
    /** @type {Row[]} */
    const rows = [];
    /** @type {Map<number, import('./types.d.ts').Message>} */
    const byId = new Map();
    for (const message of state.messages) byId.set(message.id, message);

    let lastHerSeq = 0;
    let lastMineSeq = 0;
    for (const message of state.messages) {
        if (state.recalled[String(message.id)] || message.recalled || isPokeOnly(message.parts)) continue;
        if (message.from === 'her') lastHerSeq = message.seq;
        else lastMineSeq = message.seq;
    }

    let previousAt = Number.NEGATIVE_INFINITY;
    let previousDay = Number.NaN;
    /** @type {BubbleRow | undefined} */
    let previousBubble;
    let unreadPlaced = unreadAfter === undefined;

    /** @param {number} at @param {string} key */
    const stamp = (at, key) => {
        const day = dayIndex(at);
        const newDay = day !== previousDay;
        if (newDay || at - previousAt >= STAMP_GAP_MS) {
            rows.push({ type: 'stamp', key: `t:${key}`, at, label: formatStamp(at, now), day: newDay });
            previousBubble = undefined;
        }
        previousAt = at;
        previousDay = day;
    };

    /** @param {BubbleRow} row */
    const pushBubble = row => {
        if (previousBubble && previousBubble.mine === row.mine && row.at - previousBubble.at < GROUP_GAP_MS) {
            previousBubble.last = false;
            row.first = false;
        }
        rows.push(row);
        previousBubble = row;
    };

    /** @param {number | undefined} replyTo @returns {BubbleRow['reply']} */
    const replyOf = replyTo => {
        if (replyTo === undefined) return undefined;
        const target = byId.get(replyTo);
        if (!target) return { id: replyTo, found: false, mine: false, text: '更早的一条消息' };
        const gone = target.recalled || state.recalled[String(target.id)];
        return { id: replyTo, found: !gone, mine: target.from === 'me', text: gone ? '消息已撤回' : previewText(target, 48) || '消息' };
    };

    for (const message of state.messages) {
        const key = message.clientId ? `c:${message.clientId}` : `s:${message.seq}`;
        if (!unreadPlaced && unreadAfter !== undefined && message.seq > unreadAfter && message.from === 'her') {
            rows.push({ type: 'unread', key: 'unread' });
            previousBubble = undefined;
            unreadPlaced = true;
        }
        stamp(message.at, key);
        const mine = message.from === 'me';
        if (message.recalled || state.recalled[String(message.id)]) {
            rows.push({ type: 'notice', key, seq: message.seq, id: message.id, text: mine ? '你撤回了一条消息' : '对方撤回了一条消息' });
            previousBubble = undefined;
            continue;
        }
        if (isPokeOnly(message.parts)) {
            rows.push({ type: 'notice', key, seq: message.seq, id: message.id, text: mine ? '你戳了戳她' : '她戳了戳你' });
            previousBubble = undefined;
            continue;
        }
        const read = mine && message.seq <= state.readSeq;
        /** @type {BubbleRow} */
        const row = {
            type: 'bubble', key, mine, seq: message.seq, id: message.id, at: message.at, parts: message.parts,
            first: true, last: true,
            status: mine ? (read ? 'read' : 'sent') : 'none',
            showStatus: mine && message.seq === lastMineSeq && lastMineSeq > lastHerSeq,
            reactions: state.reactions[String(message.id)] ?? [],
            viaQq: message.via === 'qq',
        };
        if (message.clientId) row.clientId = message.clientId;
        const reply = replyOf(message.replyTo);
        if (reply) row.reply = reply;
        pushBubble(row);
    }

    for (const pending of state.pending) {
        const key = `c:${pending.clientId}`;
        stamp(pending.at, key);
        /** @type {BubbleRow} */
        const row = {
            type: 'bubble', key, mine: true, clientId: pending.clientId, at: pending.at, parts: pending.parts,
            first: true, last: true, status: pending.status, showStatus: true, reactions: [], viaQq: false,
        };
        if (pending.error) row.error = pending.error;
        if (pending.upload) {
            row.progress = pending.upload.progress;
            row.localId = pending.upload.localId;
        }
        const reply = replyOf(pending.replyTo);
        if (reply) row.reply = reply;
        pushBubble(row);
    }
    return rows;
}

/** 这一行画出来之后有没有变：DOM 复用的依据。 @param {Row} row */
export function rowSignature(row) {
    return JSON.stringify(row);
}

/** 状态行的文字。 @param {BubbleRow} row */
export function statusText(row) {
    switch (row.status) {
        case 'uploading': return `上传中 ${Math.round((row.progress ?? 0) * 100)}%`;
        case 'sending': return '发送中…';
        case 'failed': return `${row.error || '发送失败'} · 点一下重试`;
        case 'read': return '已读';
        case 'sent': return '已送达';
        default: return '';
    }
}
