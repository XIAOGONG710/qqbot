// @ts-check
// 对话状态：纯函数，每次返回新状态，不碰 DOM、网络和时钟（时间由调用方传进来）。

/** @typedef {import('./types.d.ts').ConversationState} State */
/** @typedef {import('./types.d.ts').Message} Message */
/** @typedef {import('./types.d.ts').PendingMessage} Pending */

// 中继只发 typing on:true，不发 off：靠她的下一条消息或这个时限收掉
export const TYPING_TTL_MS = 8000;

const ERROR_TEXT = {
    unauthorized: '这台设备的配对已失效',
    bad_request: '这条消息发不出去',
    too_large: '内容太大了',
    rate_limited: '发得太快了，等一下再试',
    not_delivered: '没能交到她那边',
};

/**
 * @param {Partial<import('./types.d.ts').PersistedMeta>} [meta]
 * @param {Message[]} [messages]
 * @param {Pending[]} [pending]
 * @returns {State}
 */
export function createState(meta = {}, messages = [], pending = []) {
    const sorted = dedupeSorted([...messages].sort((a, b) => a.seq - b.seq));
    const top = sorted.length ? /** @type {Message} */ (sorted[sorted.length - 1]).seq : 0;
    const recalled = { ...(meta.recalled ?? {}) };
    for (const message of sorted) if (message.recalled) recalled[String(message.id)] = true;
    const known = new Set(sorted.map(message => message.clientId).filter(Boolean));
    return {
        messages: sorted,
        // 上次没发完的：文件已经不在内存里的上传只能算失败，其余接着发
        pending: pending.filter(item => !known.has(item.clientId)).map(item => ({ ...item })),
        maxSeq: Math.max(meta.maxSeq ?? 0, top),
        readSeq: meta.readSeq ?? 0,
        recalled,
        reactions: { ...(meta.reactions ?? {}) },
        typing: false,
        typingAt: 0,
        upstream: 'unknown',
        selfName: meta.selfName ?? '',
        synced: false,
        historyDone: meta.historyDone ?? false,
        lastSeenSeq: meta.lastSeenSeq ?? 0,
    };
}

/** @param {Message[]} sorted */
function dedupeSorted(sorted) {
    /** @type {Message[]} */
    const out = [];
    for (const message of sorted) {
        const last = out[out.length - 1];
        if (last && last.seq === message.seq) out[out.length - 1] = message;
        else out.push(message);
    }
    return out;
}

/** @param {State} state @returns {import('./types.d.ts').PersistedMeta} */
export function toMeta(state) {
    return {
        maxSeq: state.maxSeq, readSeq: state.readSeq, recalled: state.recalled, reactions: state.reactions,
        selfName: state.selfName, lastSeenSeq: state.lastSeenSeq, historyDone: state.historyDone,
    };
}

/** 第一个 seq >= 目标的位置。 @param {Message[]} messages @param {number} seq */
function lowerBound(messages, seq) {
    let lo = 0;
    let hi = messages.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (/** @type {Message} */ (messages[mid]).seq < seq) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

/** @param {State} state @param {Message} message @returns {State} */
function insertMessage(state, message) {
    const messages = state.messages;
    const index = lowerBound(messages, message.seq);
    const existing = messages[index];
    let pending = state.pending;
    if (message.clientId) {
        const clientId = message.clientId;
        if (pending.some(item => item.clientId === clientId)) pending = pending.filter(item => item.clientId !== clientId);
        // 同一个 clientId 已经入账过（ack 和 message 都来了，或重发被中继去重后又补发）：只留一条
        if (!(existing && existing.seq === message.seq) && messages.some(item => item.clientId === clientId)) {
            return pending === state.pending ? bumpSeq(state, message.seq) : { ...bumpSeq(state, message.seq), pending };
        }
    }
    /** @type {Message[]} */
    let next;
    if (existing && existing.seq === message.seq) {
        next = messages.slice();
        next[index] = message;
    } else if (index === messages.length) {
        next = [...messages, message];
    } else {
        next = [...messages.slice(0, index), message, ...messages.slice(index)];
    }
    const recalled = message.recalled && !state.recalled[String(message.id)] ? { ...state.recalled, [String(message.id)]: /** @type {true} */ (true) } : state.recalled;
    return { ...state, messages: next, pending, recalled, maxSeq: Math.max(state.maxSeq, message.seq) };
}

/** @param {State} state @param {number} seq @returns {State} */
function bumpSeq(state, seq) {
    return seq > state.maxSeq ? { ...state, maxSeq: seq } : state;
}

/**
 * `read.upTo` 是消息 id（中继的 id 从 10_000_000_001 起，QQ 那边来的是 NapCat 的 id，都不能和 seq 比大小）：
 * 找到那条消息，已读位置就是它的 seq；那条不在内存里（太早）就不动。
 * @param {State} state @param {number} upTo
 */
function resolveReadSeq(state, upTo) {
    for (let i = state.messages.length - 1; i >= 0; i--) {
        const message = /** @type {Message} */ (state.messages[i]);
        if (message.id === upTo) return message.seq;
    }
    return 0;
}

/** @param {State} state @param {import('./types.d.ts').LedgerEvent} event @param {number} seq @returns {State} */
export function applyEvent(state, event, seq) {
    let next = bumpSeq(state, seq);
    if (event.kind === 'recall') {
        const key = String(event.id);
        if (!next.recalled[key]) next = { ...next, recalled: { ...next.recalled, [key]: true } };
    } else if (event.kind === 'read') {
        const readSeq = resolveReadSeq(next, event.upTo);
        if (readSeq > next.readSeq) next = { ...next, readSeq };
    } else if (event.kind === 'reaction') {
        const key = String(event.id);
        const current = next.reactions[key] ?? [];
        if (!current.includes(event.emojiId)) next = { ...next, reactions: { ...next.reactions, [key]: [...current, event.emojiId] } };
    }
    return next;
}

/**
 * @param {State} state
 * @param {import('./types.d.ts').ServerFrame} frame
 * @param {number} now
 * @returns {State}
 */
export function applyFrame(state, frame, now) {
    switch (frame.type) {
        case 'message': {
            let next = insertMessage(state, frame.message);
            if (frame.message.from === 'her' && next.typing) next = { ...next, typing: false };
            return next;
        }
        case 'event':
            return applyEvent(state, frame.event, frame.seq);
        case 'ack': {
            const pending = state.pending.find(item => item.clientId === frame.clientId);
            if (!pending) return bumpSeq(state, frame.seq);
            /** @type {Message} */
            const message = { seq: frame.seq, id: frame.id, from: 'me', via: 'app', at: pending.at, parts: pending.parts, clientId: pending.clientId };
            if (pending.replyTo !== undefined) message.replyTo = pending.replyTo;
            return insertMessage(state, message);
        }
        case 'typing':
            return state.typing === frame.on && !frame.on ? state : { ...state, typing: frame.on, typingAt: frame.on ? now : 0 };
        case 'upstream':
            return state.upstream === frame.state ? state : { ...state, upstream: frame.state };
        case 'ready': {
            const next = bumpSeq(state, frame.seq);
            return { ...next, synced: true, upstream: frame.upstream, selfName: frame.self.name || next.selfName };
        }
        case 'error':
            if (!frame.clientId) return state;
            return failPending(state, frame.clientId, ERROR_TEXT[frame.code] ?? '发送失败');
        default:
            return state;
    }
}

/** 连接断了：这次连接不再算补齐，「正在输入」也作废。 @param {State} state @returns {State} */
export function disconnected(state) {
    return state.synced || state.typing ? { ...state, synced: false, typing: false, typingAt: 0 } : state;
}

/** @param {State} state @param {number} now @returns {State} */
export function expireTyping(state, now) {
    return state.typing && now - state.typingAt >= TYPING_TTL_MS ? { ...state, typing: false, typingAt: 0 } : state;
}

/**
 * `/api/history` 翻回来的一页。
 * @param {State} state
 * @param {{ messages: Message[], events: { seq: number, event: import('./types.d.ts').LedgerEvent }[] }} page
 * @returns {State}
 */
export function applyHistory(state, page) {
    let next = state;
    const before = oldestSeq(state);
    for (const message of page.messages) next = insertMessage(next, message);
    for (const { seq, event } of page.events) next = applyEvent(next, event, seq);
    const after = oldestSeq(next);
    // 没翻出更早的消息就是到头了
    const done = page.messages.length === 0 || after === before || after <= 1;
    return done === next.historyDone ? next : { ...next, historyDone: done };
}

/** 本地（IndexedDB）里更早的一段接到前面，不改 historyDone。 @param {State} state @param {Message[]} messages @returns {State} */
export function prependLocal(state, messages) {
    let next = state;
    for (const message of messages) next = insertMessage(next, message);
    return next;
}

/** @param {State} state */
export function oldestSeq(state) {
    return state.messages.length ? /** @type {Message} */ (state.messages[0]).seq : 0;
}

/** @param {State} state @param {Pending} pending @returns {State} */
export function addPending(state, pending) {
    if (state.pending.some(item => item.clientId === pending.clientId)) return state;
    return { ...state, pending: [...state.pending, pending] };
}

/** @param {State} state @param {string} clientId @param {(item: Pending) => Pending} change @returns {State} */
function updatePending(state, clientId, change) {
    let touched = false;
    const pending = state.pending.map(item => {
        if (item.clientId !== clientId) return item;
        touched = true;
        return change(item);
    });
    return touched ? { ...state, pending } : state;
}

/** @param {State} state @param {string} clientId @param {number} progress @returns {State} */
export function uploadProgress(state, clientId, progress) {
    return updatePending(state, clientId, item => item.upload && item.status === 'uploading'
        ? { ...item, upload: { ...item.upload, progress: Math.min(1, Math.max(0, progress)) } } : item);
}

/** 上传完成：把 mediaId 填进那一段，进入待发。 @param {State} state @param {string} clientId @param {string} mediaId @returns {State} */
export function uploadDone(state, clientId, mediaId) {
    return updatePending(state, clientId, item => {
        if (!item.upload) return item;
        const kind = item.upload.kind;
        const parts = item.parts.map(part => (part.kind === kind && !part.mediaId ? { ...part, mediaId } : part));
        const { upload: _upload, error: _error, ...rest } = item;
        return { ...rest, parts, status: 'sending' };
    });
}

/** @param {State} state @param {string} clientId @param {string} error @returns {State} */
export function failPending(state, clientId, error) {
    return updatePending(state, clientId, item => ({ ...item, status: 'failed', error }));
}

/** 重试：clientId 不变，中继据此去重。 @param {State} state @param {string} clientId @returns {State} */
export function retryPending(state, clientId) {
    return updatePending(state, clientId, item => {
        if (item.status !== 'failed') return item;
        const { error: _error, ...rest } = item;
        return item.upload ? { ...rest, status: 'uploading', upload: { ...item.upload, progress: 0 } } : { ...rest, status: 'sending' };
    });
}

/** @param {State} state @param {string} clientId @returns {State} */
export function removePending(state, clientId) {
    return state.pending.some(item => item.clientId === clientId) ? { ...state, pending: state.pending.filter(item => item.clientId !== clientId) } : state;
}

/** 可以交给中继的：上传已完成、还没确认、没标失败。 @param {State} state */
export function sendable(state) {
    return state.pending.filter(item => item.status === 'sending' && !item.upload);
}

/** @param {State} state @param {number} seq @returns {State} */
export function markSeen(state, seq) {
    return seq > state.lastSeenSeq ? { ...state, lastSeenSeq: seq } : state;
}

/** 她发来、他还没看到的条数。 @param {State} state */
export function unreadCount(state) {
    let count = 0;
    for (let i = state.messages.length - 1; i >= 0; i--) {
        const message = /** @type {Message} */ (state.messages[i]);
        if (message.seq <= state.lastSeenSeq) break;
        if (message.from === 'her' && !isRecalled(state, message)) count++;
    }
    return count;
}

/** @param {State} state @param {Message} message */
export function isRecalled(state, message) {
    return message.recalled === true || state.recalled[String(message.id)] === true;
}

/** @param {State} state @param {number} id */
export function findById(state, id) {
    return state.messages.find(message => message.id === id);
}

/**
 * 补发有上限：重连后第一条补发的 seq 比本地最大 seq 大不止 1，说明中间漏了一段。
 * 本地更早的那些就不能再当连续的记录用了——丢掉，往上翻时从 `/api/history` 重新取。
 * @param {State} state @param {number} seq 这次补发的第一条 @returns {State}
 */
export function dropBefore(state, seq) {
    const index = lowerBound(state.messages, seq);
    if (index === 0 && !state.historyDone) return state;
    return { ...state, messages: state.messages.slice(index), historyDone: false };
}

/** 补发的第一条和本地之间有没有缺口。 @param {number} since hello 里报的 seq @param {number} firstSeq */
export function hasReplayGap(since, firstSeq) {
    return since > 0 && firstSeq > since + 1;
}

/** 内存里只留最近的一段（更早的还在本机数据库里，往上翻时再取）。 @param {State} state @param {number} keep @returns {State} */
export function trimOldest(state, keep) {
    if (state.messages.length <= keep) return state;
    return { ...state, messages: state.messages.slice(state.messages.length - keep) };
}
