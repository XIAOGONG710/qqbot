// 界面层：把纯逻辑（src/）接到 DOM、WebSocket、IndexedDB 上。
// 凭据只放在这台设备的 localStorage，只出现在 WS 的 hello 帧和 Authorization 头里，不进任何 URL。

import { Connection } from './src/connection.js';
import { copyText, formatDuration, previewText } from './src/format.js';
import { Outbox } from './src/outbox.js';
import { buildPairRequest, defaultDeviceName, displayCode, readPairResponse } from './src/pairing.js';
import { authorization, historyPath, isCredentials, parseHistory, pokeFrame, recallFrame, HISTORY_PAGE } from './src/protocol.js';
import {
    addPending, applyFrame, applyHistory, createState, disconnected, expireTyping, failPending, markSeen, oldestSeq, prependLocal,
    dropBefore, hasReplayGap, removePending, retryPending, sendable, toMeta, trimOldest, unreadCount, uploadDone, uploadProgress,
} from './src/store.js';
import { buildTimeline, rowSignature } from './src/timeline.js';
import { openDb } from './ui/db.js';
import { $, h, icon, storage, uuid } from './ui/dom.js';
import { createMedia, prepareImage } from './ui/media.js';
import { createRecorder, recordingSupported, MAX_RECORD_MS } from './ui/recorder.js';
import { createRenderer } from './ui/render.js';

const KEYS = { credentials: 'chat-app:credentials', settings: 'chat-app:settings', draft: 'chat-app:draft' };
const INITIAL_LOAD = 80;
const MEMORY_MAX = 600;
const MEMORY_KEEP = 300;
const PIN_SLACK_PX = 72;
const TRAY_MAX = 9;
const HOLD_MS = 450;
const TEXT_SIZES = [['s', '小'], ['m', '标准'], ['l', '大'], ['xl', '特大']];

/** @type {import('./src/types.d.ts').Credentials | undefined} */
let credentials = (() => {
    const stored = storage.get(KEYS.credentials);
    return isCredentials(stored) ? { deviceId: stored.deviceId, token: stored.token } : undefined;
})();
const settings = { notify: false, preview: true, vibrate: true, textSize: 'm', ...(storage.get(KEYS.settings) ?? {}) };

/** @type {Awaited<ReturnType<typeof openDb>>} */ let db;
/** @type {ReturnType<typeof createMedia>} */ let media;
/** @type {ReturnType<typeof createRenderer>} */ let renderer;
/** @type {Connection | undefined} */ let connection;
/** @type {Outbox} */ let outbox;
let state = createState();
/** @type {import('./src/connection.d.ts').ConnectionStatus} */ let connStatus = 'idle';
/** @type {number | undefined} */ let unreadAfter;
/** @type {import('./src/timeline.d.ts').Row[]} */ let rows = [];
/** key → 画出来的那一行 @type {Map<string, { el: HTMLElement, sig: string, structure: string }>} */
const nodes = new Map();
/** @type {import('./src/types.d.ts').ServerFrame[]} */ let frameQueue = [];
let frameTimer = 0;
let paintQueued = false;
let pinned = true;
let loadingOlder = false;
/** 本机数据库里也没有更早的了 */
let localOlderDone = false;
let olderCooldownUntil = 0;
let metaTimer = 0;
let hiddenUnread = 0;
/** @type {{ id: number, mine: boolean, text: string } | undefined} */ let replyingTo;
/** @type {{ id: string, blob: Blob, mime: string, url: string }[]} */ let tray = [];
/** 正在上传的：clientId → 取消 @type {Map<string, () => void>} */
const uploads = new Map();
let chatEntered = false;
/** 这条连接 hello 时报的 since；等第一条补发来了核对有没有缺口 @type {number | undefined} */
let helloSince;

const scroller = $('scroller');
const list = $('list');
const input = /** @type {HTMLTextAreaElement} */ ($('input'));

// ---------------------------------------------------------------- 小东西

let toastTimer = 0;
/** @param {string} text */
function toast(text) {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { el.classList.remove('show'); el.hidden = true; }, 2600);
}

// 浮层（设置、菜单、看图）接到返回键上：打开时压一条历史，返回就关
/** @type {(() => void)[]} */
const overlays = [];
/** @param {() => void} close */
function pushOverlay(close) {
    overlays.push(close);
    try { history.pushState({ overlay: overlays.length }, ''); } catch { /* 有的壳不让动历史 */ }
}
function closeOverlay() {
    if (!overlays.length) return;
    if (history.state && history.state.overlay) history.back();
    else overlays.pop()?.();
}
window.addEventListener('popstate', () => { overlays.pop()?.(); });
window.addEventListener('keydown', event => { if (event.key === 'Escape' && overlays.length) { event.preventDefault(); closeOverlay(); } });

function applySettings() {
    document.documentElement.dataset.textSize = TEXT_SIZES.some(([key]) => key === settings.textSize) ? settings.textSize : 'm';
}
function saveSettings() {
    storage.set(KEYS.settings, settings);
    applySettings();
}

// ---------------------------------------------------------------- 配对

/** @param {string} [message] */
function showPair(message) {
    chatEntered = false;
    $('chat').hidden = true;
    $('pair').hidden = false;
    document.title = '配对';
    const name = /** @type {HTMLInputElement} */ ($('pairName'));
    if (!name.value) name.value = defaultDeviceName(navigator.userAgent);
    setPairError(message);
    /** @type {HTMLInputElement} */ ($('pairCode')).value = '';
}

/** @param {string} [message] @param {'code' | 'deviceName'} [field] */
function setPairError(message, field) {
    const el = $('pairError');
    el.hidden = !message;
    el.textContent = message ?? '';
    $('pairCode').toggleAttribute('aria-invalid', field === 'code');
    $('pairName').toggleAttribute('aria-invalid', field === 'deviceName');
}

async function submitPair() {
    const code = /** @type {HTMLInputElement} */ ($('pairCode'));
    const name = /** @type {HTMLInputElement} */ ($('pairName'));
    const button = /** @type {HTMLButtonElement} */ ($('pairSubmit'));
    const request = buildPairRequest(code.value, name.value);
    if (!request.ok) {
        setPairError(request.message, request.field);
        (request.field === 'code' ? code : name).focus();
        return;
    }
    setPairError();
    button.disabled = true;
    button.textContent = '正在配对…';
    try {
        const response = await fetch('/api/pair', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request.body), cache: 'no-store', credentials: 'omit',
        });
        const body = await response.json().catch(() => undefined);
        const result = readPairResponse(response.status, body);
        if (!result.ok) {
            setPairError(result.message, 'code');
            code.select();
            return;
        }
        if (!storage.set(KEYS.credentials, result.credentials)) {
            setPairError('这台设备存不了配对信息（可能开着无痕模式）。换成普通模式再配一次');
            return;
        }
        credentials = result.credentials;
        code.value = '';
        await enterChat();
    } catch {
        setPairError('连不上中继。看看网络，或者电脑上的中继有没有在跑');
    } finally {
        button.disabled = false;
        button.textContent = '配对';
    }
}

// ---------------------------------------------------------------- 状态

/** @param {import('./src/types.d.ts').PendingMessage} a @param {import('./src/types.d.ts').PendingMessage} b */
const samePersisted = (a, b) => a.status === b.status && a.parts === b.parts && a.error === b.error;

/** 所有状态变化都走这里：落盘、重画、发件箱。 @param {import('./src/types.d.ts').ConversationState} next */
function setState(next) {
    const prev = state;
    if (next === prev) return;
    state = next;
    if (next.pending !== prev.pending) {
        const before = new Map(prev.pending.map(item => [item.clientId, item]));
        for (const item of next.pending) {
            const old = before.get(item.clientId);
            before.delete(item.clientId);
            if (!old || !samePersisted(old, item)) void db.putPending(item).catch(() => {});
        }
        for (const clientId of before.keys()) void db.deletePending(clientId).catch(() => {});
        flushOutbox();
    }
    if (next.maxSeq !== prev.maxSeq || next.readSeq !== prev.readSeq || next.recalled !== prev.recalled || next.reactions !== prev.reactions
        || next.selfName !== prev.selfName || next.lastSeenSeq !== prev.lastSeenSeq || next.historyDone !== prev.historyDone) scheduleMeta();
    if (next.selfName !== prev.selfName || next.typing !== prev.typing || next.upstream !== prev.upstream || next.synced !== prev.synced) renderHeader();
    schedulePaint();
}

function scheduleMeta() {
    if (metaTimer) return;
    metaTimer = window.setTimeout(saveMetaNow, 400);
}
function saveMetaNow() {
    clearTimeout(metaTimer);
    metaTimer = 0;
    if (db && chatEntered) void db.saveMeta(toMeta(state)).catch(() => {});
}

function flushFrames() {
    clearTimeout(frameTimer);
    frameTimer = 0;
    if (!frameQueue.length) return;
    const frames = frameQueue;
    frameQueue = [];
    /** @type {import('./src/types.d.ts').Message[]} */ const store = [];
    /** @type {import('./src/types.d.ts').Message[]} */ const fromHer = [];
    const firstSync = state.maxSeq === 0;
    let next = state;
    let becameReady = false;
    for (const frame of frames) {
        if (helloSince !== undefined && (frame.type === 'message' || frame.type === 'event' || frame.type === 'ready')) {
            const firstSeq = frame.type === 'message' ? frame.message.seq : frame.type === 'event' ? frame.seq : 0;
            // 补发只给最新的 1000 条：中间漏了一段，本地更早的不再连续，丢掉，往上翻时走 /api/history
            if (firstSeq && hasReplayGap(helloSince, firstSeq)) {
                next = dropBefore(next, firstSeq);
                void db.deleteMessagesBefore(firstSeq).catch(() => {});
            }
            helloSince = undefined;
        }
        const before = next;
        next = applyFrame(next, frame, Date.now());
        if (frame.type === 'message') {
            if (next.messages !== before.messages) {
                store.push(frame.message);
                if (frame.message.from === 'her' && frame.message.seq > before.maxSeq && !frame.message.recalled) fromHer.push(frame.message);
            }
        } else if (frame.type === 'ack') {
            outbox.forget(frame.clientId);
            const settled = next.messages !== before.messages ? next.messages.find(message => message.clientId === frame.clientId) : undefined;
            if (settled) store.push(settled);
        } else if (frame.type === 'error') {
            if (frame.clientId) outbox.forget(frame.clientId);
            else if (frame.code === 'rate_limited') toast('操作太快了，等一下再试');
            else if (frame.code === 'bad_request') toast('这个操作没成功');
            else if (frame.code === 'not_delivered') toast('没能交到她那边');
        } else if (frame.type === 'ready') {
            becameReady = true;
        }
    }
    if (store.length) void db.putMessages(store).catch(() => {});
    if (pinned && next.messages.length > MEMORY_MAX) {
        next = trimOldest(next, MEMORY_KEEP);
        localOlderDone = false;
    }
    setState(next);
    if (becameReady) flushOutbox();
    if (fromHer.length && !firstSync) announce(fromHer);
}

function flushOutbox() {
    if (!connection || connection.status !== 'ready') return;
    const queue = sendable(state);
    if (!queue.length) return;
    const { tooLarge } = outbox.flush(queue, connection.generation, Date.now());
    if (tooLarge.length) {
        let next = state;
        for (const clientId of tooLarge) next = failPending(next, clientId, '这条消息太长了');
        setState(next);
    }
}

function startConnection() {
    connection?.stop();
    outbox = new Outbox({ send: frame => Boolean(connection?.send(frame)) });
    const mine = new Connection({
        open: () => new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`),
        hello: () => {
            flushFrames();
            helloSince = state.maxSeq;
            return { credentials: /** @type {import('./src/types.d.ts').Credentials} */ (credentials), since: state.maxSeq };
        },
        onFrame: frame => {
            if (connection !== mine) return;
            frameQueue.push(frame);
            if (!frameTimer) frameTimer = window.setTimeout(flushFrames, 0);
        },
        onStatus: info => {
            if (connection !== mine) return;
            connStatus = info.status;
            if (info.status !== 'ready' && info.status !== 'syncing') {
                flushFrames();
                outbox.reset();
                setState(disconnected(state));
            }
            renderHeader();
            if (info.status === 'unauthorized') handleUnauthorized();
        },
    });
    connection = mine;
    mine.start();
}

function handleUnauthorized() {
    if (!credentials) return;
    credentials = undefined;
    storage.remove(KEYS.credentials);
    connection?.stop();
    connection = undefined;
    while (overlays.length) overlays.pop()?.();
    saveMetaNow();
    showPair('这台设备的配对已经失效了，需要重新配对。聊天记录还在。');
}

async function enterChat() {
    db ??= await openDb();
    media ??= createMedia({ db, credentials: () => credentials, onUnauthorized: () => window.setTimeout(handleUnauthorized, 0) });
    renderer ??= createRenderer({
        media, scroller, selfName: () => state.selfName,
        onOpenImage: openViewer, onJump: jumpTo, onRetry: retry, toast,
        onMediaLoaded: () => { if (pinned) scrollToBottom(); },
    });
    const initial = await db.loadInitial(INITIAL_LOAD).catch(() => ({ meta: undefined, messages: [], pending: [] }));
    for (const entry of nodes.values()) { renderer.dispose(entry.el); entry.el.remove(); }
    nodes.clear();
    state = createState(initial.meta ?? {}, initial.messages, initial.pending);
    localOlderDone = false;
    unreadAfter = unreadCount(state) > 0 ? state.lastSeenSeq : undefined;
    chatEntered = true;
    $('pair').hidden = true;
    $('chat').hidden = false;
    renderHeader();
    pinned = true;
    paint();
    const divider = list.querySelector('.row.unread');
    if (divider) {
        divider.scrollIntoView({ block: 'center' });
        pinned = atBottom();
    }
    updateToBottom();
    input.value = typeof storage.get(KEYS.draft) === 'string' ? storage.get(KEYS.draft) : '';
    growInput();
    startConnection();
    // 上次没传完的接着传
    for (const item of state.pending) if (item.status === 'uploading' && item.upload) void startUpload(item.clientId);
}

// ---------------------------------------------------------------- 画

function renderHeader() {
    const name = state.selfName;
    $('peerName').textContent = name || '…';
    $('avatar').textContent = name ? /** @type {string} */ ([...name][0]) : '';
    if (chatEntered) document.title = hiddenUnread > 0 ? `(${hiddenUnread}) ${name || '新消息'}` : name || '聊天';
    const status = $('peerStatus');
    let text;
    let tone = 'idle';
    if (connStatus === 'ready') { text = state.typing ? '对方正在输入…' : '在线'; tone = state.typing ? 'typing' : 'ok'; }
    else if (connStatus === 'syncing') text = '正在同步…';
    else if (connStatus === 'connecting') text = '连接中…';
    else if (navigator.onLine === false) { text = '没有网络，连上后会自动补齐'; tone = 'off'; }
    else { text = '未连接，正在重试…'; tone = 'off'; }
    status.textContent = text;
    status.dataset.tone = tone;
    const chip = $('upstreamChip');
    chip.hidden = state.upstream === 'unknown' || connStatus !== 'ready';
    chip.dataset.state = state.upstream;
    chip.setAttribute('aria-label', state.upstream === 'up' ? 'QQ 通道正常' : 'QQ 通道断开');
    chip.title = chip.getAttribute('aria-label') ?? '';
}

function schedulePaint() {
    if (paintQueued || !chatEntered) return;
    paintQueued = true;
    // 后台标签页里 rAF 不跑，回到前台时再画
    if (document.hidden) return;
    requestAnimationFrame(paint);
}

const atBottom = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= PIN_SLACK_PX;
function scrollToBottom(smooth = false) {
    pinned = true;
    scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth && !matchMedia('(prefers-reduced-motion: reduce)').matches ? 'smooth' : 'auto' });
}

function paint() {
    paintQueued = false;
    if (!chatEntered) return;
    const stick = pinned;
    // 不在底部：记住眼前第一行的位置，画完挪回去（往上翻出旧消息时画面不跳）
    // 时间条可能在重画时消失（前面接上了更早的消息），所以多记几行，用第一行还在的
    /** @type {{ el: HTMLElement, top: number }[]} */
    const anchors = [];
    if (!stick) {
        const edge = scroller.getBoundingClientRect().top;
        for (const el of list.children) {
            const rect = el.getBoundingClientRect();
            if (rect.bottom <= edge) continue;
            anchors.push({ el: /** @type {HTMLElement} */ (el), top: rect.top });
            if (anchors.length >= 6) break;
        }
    }

    rows = buildTimeline(state, { now: Date.now(), ...(unreadAfter === undefined ? {} : { unreadAfter }) });
    const live = new Set();
    /** @type {ChildNode | null} */
    let cursor = list.firstChild;
    for (const row of rows) {
        live.add(row.key);
        const sig = rowSignature(row);
        let entry = nodes.get(row.key);
        if (!entry) {
            const el = renderer.create(row);
            el.classList.add('enter');
            entry = { el, sig: '', structure: renderer.structure(row) };
            nodes.set(row.key, entry);
        }
        if (entry.sig !== sig) {
            const structure = renderer.structure(row);
            if (structure !== entry.structure) {
                const el = renderer.create(row);
                if (entry.el === cursor) cursor = el;
                if (entry.el.isConnected) entry.el.replaceWith(el);
                renderer.dispose(entry.el);
                entry.el = el;
                entry.structure = structure;
            }
            renderer.patch(entry.el, row);
            entry.sig = sig;
        }
        if (entry.el === cursor) cursor = cursor.nextSibling;
        else list.insertBefore(entry.el, cursor);
    }
    for (const [key, entry] of nodes) {
        if (live.has(key)) continue;
        renderer.dispose(entry.el);
        entry.el.remove();
        nodes.delete(key);
    }

    $('typing').hidden = !state.typing;
    const note = $('topNote');
    note.textContent = loadingOlder ? '正在翻更早的消息…'
        : state.messages.length === 0 && state.pending.length === 0 ? (state.synced ? '还没有消息。说点什么吧。' : '')
            : oldestSeq(state) <= 1 || (state.historyDone && localOlderDone) ? '没有更早的消息了' : '';

    if (stick) scrollToBottom();
    else {
        const anchor = anchors.find(item => item.el.isConnected);
        if (anchor) scroller.scrollTop += anchor.el.getBoundingClientRect().top - anchor.top;
    }
    updateToBottom();
    seeIfAtBottom();
}

function seeIfAtBottom() {
    if (document.hidden || !pinned || !state.messages.length) return;
    const top = /** @type {import('./src/types.d.ts').Message} */ (state.messages[state.messages.length - 1]).seq;
    if (top > state.lastSeenSeq) setState(markSeen(state, top));
}

function updateToBottom() {
    const button = $('toBottom');
    button.hidden = pinned;
    const count = pinned ? 0 : unreadCount(state);
    const badge = $('toBottomCount');
    badge.hidden = count === 0;
    badge.textContent = count > 99 ? '99+' : String(count);
    button.setAttribute('aria-label', count ? `回到最新消息，有 ${count} 条新消息` : '回到最新消息');
}

async function loadOlder() {
    if (loadingOlder || !chatEntered || !state.messages.length || Date.now() < olderCooldownUntil) return;
    const before = oldestSeq(state);
    if (before <= 1) return;
    loadingOlder = true;
    let progressed = false;
    schedulePaint();
    try {
        const local = await db.messagesBefore(before, HISTORY_PAGE).catch(() => []);
        if (local.length) {
            setState(prependLocal(state, local));
            progressed = true;
        } else if (state.historyDone) {
            localOlderDone = true;
        } else if (credentials) {
            const response = await fetch(historyPath(before), { headers: { Authorization: authorization(credentials) }, cache: 'no-store', credentials: 'omit' });
            if (response.status === 401) { handleUnauthorized(); return; }
            if (!response.ok) throw new Error(String(response.status));
            const page = parseHistory(await response.json());
            if (page.messages.length) void db.putMessages(page.messages).catch(() => {});
            setState(applyHistory(state, page));
            progressed = page.messages.length > 0;
        }
    } catch {
        // 离线或中继不在：过一会儿滚动时再试
        olderCooldownUntil = Date.now() + 5000;
    } finally {
        loadingOlder = false;
        schedulePaint();
        // 画完还停在顶上（一页不够高）就接着取
        if (progressed) window.setTimeout(() => { if (scroller.scrollTop < 600) void loadOlder(); }, 120);
    }
}

/** @param {number} id */
function jumpTo(id) {
    const el = /** @type {HTMLElement | null} */ (list.querySelector(`[data-id="${CSS.escape(String(id))}"]`));
    if (!el) return toast('那条在更早的记录里，往上翻翻');
    pinned = false;
    el.scrollIntoView({ block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
}

// ---------------------------------------------------------------- 通知

/** @param {import('./src/types.d.ts').Message[]} messages */
function announce(messages) {
    if (!document.hidden) return;
    hiddenUnread += messages.length;
    renderHeader();
    if (settings.vibrate) { try { navigator.vibrate?.([70, 50, 70]); } catch { /* 不支持 */ } }
    if (!settings.notify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const last = /** @type {import('./src/types.d.ts').Message} */ (messages[messages.length - 1]);
    const title = state.selfName || '新消息';
    const body = settings.preview ? `${hiddenUnread > 1 ? `[${hiddenUnread} 条] ` : ''}${previewText(last, 80)}` : `发来 ${hiddenUnread} 条新消息`;
    const options = { body, tag: 'chat', renotify: true, icon: './icons/icon-192.png', badge: './icons/badge-96.png' };
    // Android 上只能经 Service Worker 发通知；桌面两种都行
    const viaWorker = navigator.serviceWorker?.getRegistration().then(registration => {
        if (!registration) throw new Error('no worker');
        return registration.showNotification(title, options);
    });
    (viaWorker ?? Promise.reject(new Error('no worker'))).catch(() => {
        try {
            const notification = new Notification(title, options);
            notification.onclick = () => { window.focus(); notification.close(); };
        } catch { /* 这个环境发不了通知 */ }
    });
}

function clearAnnouncements() {
    hiddenUnread = 0;
    renderHeader();
    navigator.serviceWorker?.getRegistration().then(registration => registration?.getNotifications({ tag: 'chat' }))
        .then(found => found?.forEach(notification => notification.close())).catch(() => {});
}

// ---------------------------------------------------------------- 发

function growInput() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 148)}px`;
    const ready = input.value.trim().length > 0 || tray.length > 0;
    $('sendBtn').hidden = !ready;
    $('micBtn').hidden = ready;
}

/** @param {import('./src/types.d.ts').PendingMessage} item */
function queue(item) {
    if (replyingTo) {
        item.replyTo = replyingTo.id;
        setReply(undefined);
    }
    unreadAfter = undefined;
    pinned = true;
    setState(addPending(state, item));
}

function sendComposer() {
    const text = input.value;
    const images = tray;
    if (!text.trim() && !images.length) return;
    tray = [];
    renderTray();
    for (const image of images) {
        URL.revokeObjectURL(image.url);
        void sendMedia('image', image.blob, image.mime, undefined, image.id);
    }
    if (text.trim()) queue({ clientId: uuid(), at: Date.now(), parts: [{ kind: 'text', text }], status: 'sending' });
    input.value = '';
    storage.remove(KEYS.draft);
    growInput();
    closePlus();
}

/**
 * @param {'image' | 'voice'} kind @param {Blob} blob @param {string} mime @param {number} [durationMs] @param {string} [localId]
 */
async function sendMedia(kind, blob, mime, durationMs, localId = uuid()) {
    const clientId = uuid();
    await media.putLocal(localId, blob);
    queue({
        clientId, at: Date.now(), status: 'uploading',
        parts: [kind === 'image' ? { kind, mediaId: '', mime } : { kind, mediaId: '', mime, ...(durationMs ? { durationMs } : {}) }],
        upload: { localId, kind, mime, progress: 0 },
    });
    await startUpload(clientId);
}

/** @param {string} clientId */
async function startUpload(clientId) {
    const item = state.pending.find(pending => pending.clientId === clientId);
    if (!item?.upload || uploads.has(clientId)) return;
    const { localId, mime } = item.upload;
    try {
        const blob = await media.blob(`local:${localId}`);
        const task = media.upload(blob, mime, fraction => setState(uploadProgress(state, clientId, fraction)));
        uploads.set(clientId, task.abort);
        const mediaId = await task.promise;
        await media.adopt(localId, mediaId);
        setState(uploadDone(state, clientId, mediaId));
    } catch (error) {
        const message = error instanceof Error && error.message ? error.message : '上传失败';
        if (message !== '已取消') setState(failPending(state, clientId, message === '本地文件不在了' ? '文件不在了，重新选一次' : message));
    } finally {
        uploads.delete(clientId);
    }
}

/** @param {string} clientId */
function retry(clientId) {
    const next = retryPending(state, clientId);
    if (next === state) return;
    outbox.forget(clientId);
    setState(next);
    const item = next.pending.find(pending => pending.clientId === clientId);
    if (item?.upload) void startUpload(clientId);
    else flushOutbox();
    if (connStatus !== 'ready') toast('还没连上，连上后会自动发出去');
}

/** @param {string} clientId */
function discard(clientId) {
    const item = state.pending.find(pending => pending.clientId === clientId);
    if (!item) return;
    uploads.get(clientId)?.();
    outbox.forget(clientId);
    if (item.upload) void media.dropLocal(item.upload.localId);
    setState(removePending(state, clientId));
}

/** @param {typeof replyingTo} target */
function setReply(target) {
    replyingTo = target;
    $('replyBar').hidden = !target;
    if (target) {
        $('replyWho').textContent = target.mine ? '回复自己' : `回复 ${state.selfName || '对方'}`;
        $('replyText').textContent = target.text;
        input.focus();
    }
}

function renderTray() {
    const el = $('tray');
    el.hidden = tray.length === 0;
    el.replaceChildren(...tray.map(item => h('div', { class: 'tray-item' },
        h('img', { src: item.url, alt: '待发送的图片' }),
        h('button', {
            class: 'tray-remove', type: 'button', 'aria-label': '不发这张',
            onclick: () => { URL.revokeObjectURL(item.url); tray = tray.filter(other => other !== item); renderTray(); },
        }, icon('close', 14)))));
    growInput();
}

/** @param {Iterable<File>} files */
async function addImages(files) {
    for (const file of files) {
        if (tray.length >= TRAY_MAX) { toast(`一次最多 ${TRAY_MAX} 张`); break; }
        try {
            const { blob, mime } = await prepareImage(file);
            tray.push({ id: uuid(), blob, mime, url: URL.createObjectURL(blob) });
        } catch (error) {
            toast(error instanceof Error ? error.message : '这张图发不了');
        }
    }
    renderTray();
}

function closePlus() {
    $('plusMenu').hidden = true;
    $('plusBtn').setAttribute('aria-expanded', 'false');
}

// ---------------------------------------------------------------- 语音

const recorder = createRecorder({ onLimit: () => { toast(`最长 ${MAX_RECORD_MS / 1000} 秒，已自动发送`); void finishRecording(true); } });
let recordTick = 0;
/** 按住说话的那一次按下 @type {{ at: number, y: number, released: boolean, cancel: boolean } | undefined} */
let hold;

function showRecording(on, hint = '正在录音') {
    $('recordBar').hidden = !on;
    $('inputRow').hidden = on;
    $('recordHint').textContent = hint;
    clearInterval(recordTick);
    if (on) {
        const tick = () => { $('recordTime').textContent = formatDuration(Math.max(1000, recorder.elapsed)); };
        tick();
        recordTick = window.setInterval(tick, 250);
    }
}

async function beginRecording() {
    if (recorder.active) return;
    renderer?.stopVoice();
    closePlus();
    try {
        await recorder.start();
    } catch (error) {
        hold = undefined;
        toast(error instanceof Error ? error.message : '录不了音');
        return;
    }
    if (!recorder.active) return;
    if (hold && !hold.released) {
        showRecording(true, '松开发送，上滑取消');
    } else if (hold && hold.released && Date.now() - hold.at >= HOLD_MS) {
        // 按住了但权限弹窗挡着，松手时还没开始录
        hold = undefined;
        recorder.cancel();
    } else {
        hold = undefined;
        showRecording(true, '正在录音，点右边发送');
    }
}

/** @param {boolean} send */
async function finishRecording(send) {
    hold = undefined;
    if (!recorder.active) { showRecording(false); return; }
    if (!send) {
        recorder.cancel();
        showRecording(false);
        return;
    }
    const result = await recorder.stop();
    showRecording(false);
    if (!result) return toast('说话时间太短了');
    await sendMedia('voice', result.blob, result.mime, result.durationMs);
}

// ---------------------------------------------------------------- 看图

/** @type {string | undefined} */ let viewerKey;
/** @param {string} key @param {string} alt */
function openViewer(key, alt) {
    if (viewerKey) return;
    viewerKey = key;
    const img = /** @type {HTMLImageElement} */ ($('viewerImg'));
    img.alt = alt;
    $('viewer').hidden = false;
    pushOverlay(() => {
        $('viewer').hidden = true;
        img.removeAttribute('src');
        if (viewerKey) media.release(viewerKey);
        viewerKey = undefined;
    });
    media.acquire(key).then(url => { if (viewerKey === key) img.src = url; }).catch(() => { toast('图片没取到'); });
    $('viewerClose').focus();
}

// ---------------------------------------------------------------- 底部弹层

/** @param {string} label @param {(Node | null | false)[]} children */
function openSheet(label, children) {
    const sheet = $('sheet');
    sheet.setAttribute('aria-label', label);
    sheet.replaceChildren(h('div', { class: 'sheet-grip', 'aria-hidden': 'true' }), ...children.filter(Boolean));
    const opener = /** @type {HTMLElement | null} */ (document.activeElement);
    $('sheetWrap').hidden = false;
    sheet.scrollTop = 0;
    sheet.focus();
    pushOverlay(() => {
        $('sheetWrap').hidden = true;
        sheet.replaceChildren();
        if (opener?.isConnected && opener !== input) opener.focus();
    });
}

/** @param {string} text @param {() => void} run @param {{ danger?: boolean, note?: string }} [options] */
const action = (text, run, options = {}) => h('button', {
    class: `sheet-action${options.danger ? ' danger' : ''}`, type: 'button',
    // 先关弹层（等返回键那一下走完）再做事，不然历史记录会乱
    onclick: () => { closeOverlay(); window.setTimeout(run, 60); },
}, h('span', { text }), options.note ? h('small', { text: options.note }) : null);

/** @param {string} title @param {string} body @param {string} confirmText @param {() => void} run */
function confirmSheet(title, body, confirmText, run) {
    openSheet(title, [
        h('h2', { class: 'sheet-title', text: title }),
        h('p', { class: 'sheet-text', text: body }),
        action(confirmText, run, { danger: true }),
        action('算了', () => {}),
    ]);
}

/** @param {string} text */
async function copy(text) {
    try {
        await navigator.clipboard.writeText(text);
        toast('已复制');
    } catch {
        const area = h('textarea', { class: 'sr-only', readonly: true });
        /** @type {HTMLTextAreaElement} */ (area).value = text;
        document.body.append(area);
        /** @type {HTMLTextAreaElement} */ (area).select();
        const ok = document.execCommand('copy');
        area.remove();
        toast(ok ? '已复制' : '复制不了');
    }
}

/** @param {string} key */
function openMessageMenu(key) {
    const row = rows.find(item => item.key === key);
    if (!row || row.type !== 'bubble' || !$('sheetWrap').hidden) return;
    const text = copyText(row);
    const preview = previewText(row, 70);
    const settled = row.id !== undefined && (row.status === 'none' || row.status === 'sent' || row.status === 'read');
    const clientId = row.clientId;
    openSheet('消息操作', [
        h('p', { class: 'sheet-preview', text: preview }),
        settled && action('回复', () => setReply({ id: /** @type {number} */ (row.id), mine: row.mine, text: preview })),
        text && action('复制', () => void copy(text)),
        settled && row.mine && !row.viaQq && action('撤回', () => {
            if (!connection?.send(recallFrame(/** @type {number} */ (row.id)))) toast('还没连上，等一下再撤回');
        }, { danger: true }),
        row.status === 'failed' && clientId && action('重新发送', () => retry(clientId)),
        (row.status === 'failed' || row.status === 'uploading') && clientId && action(row.status === 'failed' ? '删除' : '取消发送', () => discard(clientId), { danger: true }),
        action('取消', () => {}),
    ]);
}

/** @param {string} label @param {string} hint @param {boolean} checked @param {(on: boolean) => void | Promise<void>} change */
function toggleRow(label, hint, checked, change) {
    const box = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', class: 'switch', role: 'switch' }));
    box.checked = checked;
    box.addEventListener('change', () => void change(box.checked));
    return h('label', { class: 'setting' }, h('span', { class: 'setting-text' }, h('span', { text: label }), hint ? h('small', { text: hint }) : null), box);
}

function openSettings() {
    const canNotify = typeof Notification !== 'undefined';
    const denied = canNotify && Notification.permission === 'denied';
    const sizes = h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': '字号' }, ...TEXT_SIZES.map(([key, label]) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(settings.textSize === key), class: 'segment', text: label,
        onclick: event => {
            settings.textSize = key;
            saveSettings();
            for (const other of /** @type {HTMLElement} */ (event.currentTarget).parentElement?.children ?? []) other.setAttribute('aria-checked', String(other === event.currentTarget));
            if (pinned) scrollToBottom();
        },
    })));
    openSheet('设置', [
        h('h2', { class: 'sheet-title', text: '设置' }),
        h('h3', { class: 'sheet-section', text: '新消息' }),
        toggleRow('通知', !canNotify ? '这个环境发不了系统通知，只有振动' : denied ? '通知权限被关了，要到系统设置里打开' : '页面在后台时提醒。App 完全关掉后收不到，打开会补齐',
            settings.notify && canNotify && Notification.permission === 'granted', async on => {
                if (on && canNotify && Notification.permission !== 'granted') {
                    const result = await Notification.requestPermission().catch(() => 'denied');
                    if (result !== 'granted') toast('没拿到通知权限');
                }
                settings.notify = on && canNotify && Notification.permission === 'granted';
                saveSettings();
            }),
        toggleRow('通知里显示内容', '关掉后只显示「发来新消息」', settings.preview, on => { settings.preview = on; saveSettings(); }),
        toggleRow('振动', '', settings.vibrate, on => { settings.vibrate = on; saveSettings(); }),
        h('h3', { class: 'sheet-section', text: '字号' }),
        sizes,
        h('h3', { class: 'sheet-section', text: '这台设备' }),
        h('p', { class: 'sheet-text', text: `${db?.persistent ? '聊天记录存在这台设备上，离线也能看。' : '这个环境存不了聊天记录，每次打开都要重新同步。'}${credentials ? `设备编号 ${credentials.deviceId.slice(0, 14)}` : ''}` }),
        action('清空本机缓存', () => confirmSheet('清空本机缓存', '删掉这台设备上存的聊天记录和图片，然后从中继重新同步。中继那边的记录不受影响。', '清空', () => void clearCache()), { note: '记录会从中继重新同步' }),
        action('解除配对', () => confirmSheet('解除配对', '这台设备会忘掉配对信息和本机的聊天记录。要再用需要重新配对；彻底作废这台设备，还要在电脑上撤销它。', '解除配对', () => void unpair()), { danger: true }),
        action('关闭', () => {}),
    ]);
}

async function clearCache() {
    connection?.stop();
    for (const abort of uploads.values()) abort();
    await db.clear().catch(() => {});
    media.reset();
    for (const entry of nodes.values()) { renderer.dispose(entry.el); entry.el.remove(); }
    nodes.clear();
    state = createState({ selfName: state.selfName });
    unreadAfter = undefined;
    pinned = true;
    paint();
    startConnection();
    toast('已清空，正在重新同步');
}

async function unpair() {
    connection?.stop();
    connection = undefined;
    for (const abort of uploads.values()) abort();
    credentials = undefined;
    storage.remove(KEYS.credentials);
    storage.remove(KEYS.draft);
    await db.clear().catch(() => {});
    media.reset();
    for (const entry of nodes.values()) { renderer.dispose(entry.el); entry.el.remove(); }
    nodes.clear();
    state = createState();
    showPair();
}

// ---------------------------------------------------------------- 接线

function wire() {
    // 配对
    const code = /** @type {HTMLInputElement} */ ($('pairCode'));
    code.addEventListener('input', () => { code.value = displayCode(code.value); setPairError(); });
    $('pairForm').addEventListener('submit', event => { event.preventDefault(); void submitPair(); });

    // 顶栏
    $('openSettings').addEventListener('click', openSettings);
    $('upstreamChip').addEventListener('click', () => toast(state.upstream === 'up' ? 'QQ 那边连着：你最近在哪边说话，她就回到哪边' : 'QQ 那边现在连不上，她的话都会发到这里'));

    // 滚动
    scroller.addEventListener('scroll', () => {
        const was = pinned;
        pinned = atBottom();
        if (pinned !== was || !pinned) updateToBottom();
        if (pinned) seeIfAtBottom();
        if (scroller.scrollTop < 600) void loadOlder();
        cancelPress();
    }, { passive: true });
    $('toBottom').addEventListener('click', () => { unreadAfter = undefined; scrollToBottom(true); schedulePaint(); });

    // 输入
    input.addEventListener('input', () => { growInput(); storage.set(KEYS.draft, input.value); });
    input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && matchMedia('(hover: hover) and (pointer: fine)').matches) {
            event.preventDefault();
            sendComposer();
        }
    });
    input.addEventListener('focus', () => { closePlus(); if (pinned) window.setTimeout(() => { if (pinned) scrollToBottom(); }, 250); });
    input.addEventListener('paste', event => {
        const files = [...(event.clipboardData?.files ?? [])].filter(file => file.type.startsWith('image/'));
        if (files.length) { event.preventDefault(); void addImages(files); }
    });
    const send = $('sendBtn');
    // 点发送时不让输入框失焦，键盘不收
    send.addEventListener('pointerdown', event => event.preventDefault());
    send.addEventListener('click', sendComposer);
    $('replyCancel').addEventListener('click', () => setReply(undefined));

    // 加号
    $('plusBtn').addEventListener('click', () => {
        const open = $('plusMenu').hidden;
        $('plusMenu').hidden = !open;
        $('plusBtn').setAttribute('aria-expanded', String(open));
    });
    for (const [button, picker] of [['pickGalleryBtn', 'pickGallery'], ['pickCameraBtn', 'pickCamera']]) {
        const file = /** @type {HTMLInputElement} */ ($(picker));
        $(button).addEventListener('click', () => { closePlus(); file.click(); });
        file.addEventListener('change', () => { const files = [...(file.files ?? [])]; file.value = ''; void addImages(files); });
    }
    $('pokeBtn').addEventListener('click', () => {
        closePlus();
        if (connection?.send(pokeFrame())) { try { navigator.vibrate?.(15); } catch { /* 不支持 */ } } else toast('还没连上，等一下再戳');
    });

    // 语音
    const mic = $('micBtn');
    if (!recordingSupported()) mic.classList.add('unavailable');
    mic.addEventListener('pointerdown', event => {
        if (event.button !== 0 || recorder.active) return;
        hold = { at: Date.now(), y: event.clientY, released: false, cancel: false };
        try { mic.setPointerCapture(event.pointerId); } catch { /* 不支持 */ }
        void beginRecording();
    });
    mic.addEventListener('pointermove', event => {
        if (!hold || hold.released) return;
        hold.cancel = hold.y - event.clientY > 70;
        if (recorder.active) $('recordHint').textContent = hold.cancel ? '松开取消' : '松开发送，上滑取消';
    });
    const release = () => {
        if (!hold || hold.released) return;
        hold.released = true;
        if (!recorder.active) return;
        if (Date.now() - hold.at < HOLD_MS) {
            hold = undefined;
            showRecording(true, '正在录音，点右边发送');
        } else {
            void finishRecording(!hold.cancel);
        }
    };
    mic.addEventListener('pointerup', release);
    mic.addEventListener('pointercancel', () => { if (hold && !hold.released) { hold.cancel = true; release(); } });
    mic.addEventListener('keydown', event => { if ((event.key === 'Enter' || event.key === ' ') && !recorder.active) { event.preventDefault(); hold = undefined; void beginRecording(); } });
    mic.addEventListener('contextmenu', event => event.preventDefault());
    $('recordCancel').addEventListener('click', () => void finishRecording(false));
    $('recordSend').addEventListener('click', () => void finishRecording(true));

    // 长按 / 右键气泡
    list.addEventListener('pointerdown', event => {
        const bubble = /** @type {HTMLElement | null} */ (/** @type {HTMLElement} */ (event.target).closest('.bubble'));
        if (!bubble || event.button !== 0) return;
        const key = /** @type {HTMLElement} */ (bubble.closest('.row')).dataset.key ?? '';
        press = { x: event.clientX, y: event.clientY, timer: window.setTimeout(() => {
            press = undefined;
            suppressClick = true;
            window.setTimeout(() => { suppressClick = false; }, 600);
            try { navigator.vibrate?.(12); } catch { /* 不支持 */ }
            openMessageMenu(key);
        }, 480) };
    });
    list.addEventListener('pointermove', event => { if (press && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 10) cancelPress(); });
    for (const type of ['pointerup', 'pointercancel', 'pointerleave']) list.addEventListener(type, cancelPress);
    list.addEventListener('click', event => { if (suppressClick) { event.preventDefault(); event.stopPropagation(); } }, true);
    list.addEventListener('contextmenu', event => {
        const bubble = /** @type {HTMLElement} */ (event.target).closest('.bubble');
        if (!bubble) return;
        event.preventDefault();
        cancelPress();
        openMessageMenu(/** @type {HTMLElement} */ (bubble.closest('.row')).dataset.key ?? '');
    });
    list.addEventListener('keydown', event => {
        const target = /** @type {HTMLElement} */ (event.target);
        if (event.key === 'Enter' && target.classList.contains('bubble')) openMessageMenu(/** @type {HTMLElement} */ (target.closest('.row')).dataset.key ?? '');
    });

    // 看图、弹层
    $('viewerClose').addEventListener('click', closeOverlay);
    $('viewerImg').addEventListener('click', closeOverlay);
    $('viewer').addEventListener('click', event => { if (event.target === $('viewer')) closeOverlay(); });
    $('viewerSave').addEventListener('click', () => {
        const src = /** @type {HTMLImageElement} */ ($('viewerImg')).src;
        if (!src) return;
        const link = h('a', { href: src, download: `photo-${Date.now()}` });
        document.body.append(link);
        link.click();
        link.remove();
    });
    $('sheetBackdrop').addEventListener('click', closeOverlay);

    // 前后台、网络、键盘
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            if (pinned) unreadAfter = state.lastSeenSeq;
            saveMetaNow();
            if (recorder.active) void finishRecording(false);
            return;
        }
        if (!chatEntered) return;
        connection?.kick();
        clearAnnouncements();
        paintQueued = false;
        schedulePaint();
    });
    window.addEventListener('online', () => { connection?.kick(); renderHeader(); });
    window.addEventListener('offline', renderHeader);
    window.addEventListener('pagehide', saveMetaNow);
    const viewport = window.visualViewport;
    const fit = () => {
        if (viewport) document.documentElement.style.setProperty('--app-h', `${Math.round(viewport.height)}px`);
        if (pinned && chatEntered) scrollToBottom();
    };
    // 输入区会长高（多行、引用条、图片托盘）：回到底部按钮和提示跟着挪
    new ResizeObserver(() => {
        document.documentElement.style.setProperty('--composer-h', `${$('composer').offsetHeight}px`);
        if (pinned && chatEntered) scrollToBottom();
    }).observe($('composer'));
    viewport?.addEventListener('resize', fit);
    window.addEventListener('resize', fit);
    fit();

    // 发出去等不到确认的、太久没动静的「正在输入」
    window.setInterval(() => {
        if (!chatEntered) return;
        let next = expireTyping(state, Date.now());
        for (const clientId of outbox?.expired(Date.now()) ?? []) {
            outbox.forget(clientId);
            next = failPending(next, clientId, '发送超时');
        }
        setState(next);
    }, 1500);
}

/** @type {{ x: number, y: number, timer: number } | undefined} */ let press;
let suppressClick = false;
function cancelPress() {
    if (!press) return;
    clearTimeout(press.timer);
    press = undefined;
}

async function boot() {
    applySettings();
    wire();
    if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('./sw.js').catch(() => {});
    if (credentials) await enterChat();
    else showPair();
}

void boot();
