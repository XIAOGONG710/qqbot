import { resolveRegisteredLink } from './action-links.js';
import { PhotoReviewViewModel } from './photo-review-view.js';
import { rememberDownlinkNonce } from './replay-window.js';

const $ = id => document.getElementById(id);
const state = { socket: undefined, transport: 'ws', clientId: '', pairingCode: '', session: '', connectionGeneration: 0, pending: new Map(), receivedDownlinkNonces: new Map(), recorder: undefined, recordChunks: [], pollTimer: undefined, polling: false, pendingTimer: undefined, connecting: false, connected: false, helloSent: false, activityAt: 0, photoReview: new PhotoReviewViewModel(), photoObjectUrls: new Map(), photoRenderGeneration: 0 };
const id = prefix => `${prefix}-${crypto.randomUUID().replaceAll('-', '')}`;
const nonce = prefix => `${prefix}-${crypto.randomUUID().replaceAll('-', '')}`;
const now = () => new Date().toISOString();
const envelope = (kind, body) => ({ v: 1, requestId: id(kind.replace('.', '-')), kind, sentAt: now(), nonce: nonce('pwa'), body });

const log = (direction, value) => {
  const row = document.createElement('div');
  row.className = `bubble ${direction}`;
  row.textContent = typeof value === 'string' ? value : value.text ?? `[${value.kind}]`;
  $('conversation').append(row);
  $('conversation').scrollTop = $('conversation').scrollHeight;
};
const system = text => log('system', text);
const setState = (text, on = false) => { const changed = state.connected !== on; state.connected = on; $('state').textContent = text; $('state').className = `pill ${on ? 'on' : 'off'}`; $('state').title = state.activityAt ? `最近活动：${new Date(state.activityAt).toLocaleTimeString()}` : ''; if (changed) renderPhotoReview(); };
const setBusy = busy => { state.connecting = busy; $('connect').disabled = busy; $('connect').textContent = busy ? '连接中…' : '配对并连接'; };
const touch = () => { state.activityAt = Date.now(); setState($('state').textContent, $('state').classList.contains('on')); };
const pendingId = value => value?.requestId?.replace(/^resp-/, '');
const expirePending = () => { const cutoff = Date.now() - 45_000; for (const [requestId, entry] of state.pending) if (entry.sentAt < cutoff) { state.pending.delete(requestId); system('请求等待超时，请检查连接后重试'); } };
const startPendingWatch = () => { if (!state.pendingTimer) state.pendingTimer = window.setInterval(expirePending, 5000); };
const actionDefaults = Object.freeze({ notify: 'auto', timer: 'auto', ring: 'confirm', open_link: 'confirm', media_control: 'confirm', volume: 'confirm' });
const safeId = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const isCurrentConnection = (generation, socket, session) => state.connectionGeneration === generation
  && (socket === undefined || state.socket === socket)
  && (session === undefined || state.session === session);

function acceptDownlink(value) {
  if (!value || typeof value !== 'object' || value.v !== 1 || value.kind !== 'action.request' || !safeId.test(value.requestId) || !safeId.test(value.nonce) || !value.body || typeof value.body !== 'object') throw new Error('手机动作下行包不合法');
  const sentAt = Date.parse(String(value.sentAt));
  if (!Number.isFinite(sentAt) || Math.abs(Date.now() - sentAt) > 5 * 60_000) throw new Error('手机动作下行包时间异常');
  const action = value.body;
  if (typeof action.action !== 'string' || !Object.hasOwn(actionDefaults, action.action)) throw new Error('手机动作或确认级别不合法');
  const expected = actionDefaults[action.action];
  if (!['auto', 'confirm', 'deny'].includes(action.decision)) throw new Error('手机动作或确认级别不合法');
  if (expected === 'confirm' && action.decision === 'auto') throw new Error('敏感手机动作不能自动执行');
  if (action.targetId !== undefined && (typeof action.targetId !== 'string' || !safeId.test(action.targetId))) throw new Error('手机动作目标不合法');
  if (action.reason !== undefined && (typeof action.reason !== 'string' || [...action.reason].length > 500)) throw new Error('手机动作理由不合法');
  if (!action.params || typeof action.params !== 'object' || Array.isArray(action.params) || Object.keys(action.params).length > 32) throw new Error('手机动作参数不合法');
  for (const [key, item] of Object.entries(action.params)) {
    if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('手机动作参数名不合法');
    if (typeof item === 'string' ? [...item].length > 512 : typeof item !== 'number' || !Number.isFinite(item)) throw new Error('手机动作参数值不合法');
  }
  if (action.action === 'open_link') resolveRegisteredLink(action.targetId, window.location.href);
  rememberDownlinkNonce(state.receivedDownlinkNonces, value.nonce, Date.now());
  return value;
}

function handleIncoming(value, generation = state.connectionGeneration) {
  if (!value || !isCurrentConnection(generation)) return;
  touch();
  if (value.error) { state.pending.delete(pendingId(value)); return system(value.error); }
  if (value.kind === 'action.request') {
    try { void handleDownlink(acceptDownlink(value), generation); }
    catch (error) { system(error instanceof Error ? error.message : String(error)); }
    return;
  }
  if (value.kind === 'message.receive') {
    state.pending.delete(pendingId(value));
    return log('in', value.body);
  }
  if (value.kind === 'action.result') {
    state.pending.delete(pendingId(value));
    return system(value.body.ok ? `动作已处理：${value.body.decision}` : `动作未执行：${value.body.error ?? '被拒绝'}`);
  }
  if (value.kind === 'photo.review.list.result') {
    state.pending.delete(pendingId(value));
    try { state.photoReview.replace(value.body); }
    catch { state.photoReview.fail(); }
    renderPhotoReview();
    return;
  }
  if (value.kind === 'photo.review.decision') {
    state.pending.delete(pendingId(value));
    try { state.photoReview.applyDecision(value.body); }
    catch { state.photoReview.fail(); }
    if ($('photoConfirm').open) $('photoConfirm').close();
    renderPhotoReview();
    return;
  }
  if (value.kind === 'error') {
    const pending = state.pending.get(pendingId(value));
    state.pending.delete(pendingId(value));
    if (pending?.value?.kind === 'photo.review.list' || pending?.value?.kind === 'photo.review.decide') {
      state.photoReview.fail();
      renderPhotoReview();
      return system('照片审核操作未完成，请稍后重试');
    }
    return system(value.body.message ?? '服务端错误');
  }
  if (value.kind === undefined) system('配对成功');
}

async function sendActionResult(requestId, ok, decision, error, generation) {
  if (!isCurrentConnection(generation)) return;
  const value = envelope('action.result', { requestId, ok, decision, ...(error ? { error } : {}) });
  if (state.transport === 'ws') {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) throw new Error('动作回执发送失败：连接已断开');
    state.socket.send(JSON.stringify(value));
    return;
  }
  const headers = { 'content-type': 'application/json' };
  const session = state.session;
  if (session) headers['x-companion-session'] = session;
  const response = await fetch($('endpoint').value.trim(), { method: 'POST', headers, body: JSON.stringify(value) });
  if (!isCurrentConnection(generation, undefined, session)) return;
  state.session = response.headers.get('x-companion-session') ?? state.session;
  if (!response.ok) throw new Error(`动作回执失败（HTTP ${response.status}）`);
}

function stopActionPolling() {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = undefined;
}

async function pollActions() {
  if (state.transport !== 'http' || !state.session || state.polling) return;
  const generation = state.connectionGeneration;
  const session = state.session;
  state.polling = true;
  try {
    const endpoint = $('endpoint').value.trim().replace(/\/$/, '') + '/actions';
    const response = await fetch(endpoint, { headers: { 'x-companion-session': session, accept: 'application/json' } });
    if (!isCurrentConnection(generation, undefined, session)) return;
    if (response.status === 401) {
      state.connectionGeneration++;
      state.session = '';
      state.pending.clear();
      state.receivedDownlinkNonces.clear();
      state.photoReview.reset();
      stopActionPolling();
      setState('会话已过期');
      system('HTTPS 会话已过期，请重新配对');
      return;
    }
    if (!response.ok) throw new Error(`动作轮询失败（HTTP ${response.status}）`);
    const result = await response.json();
    if (!isCurrentConnection(generation, undefined, session)) return;
    for (const action of Array.isArray(result.actions) ? result.actions : []) handleIncoming(action, generation);
  } catch (error) {
    if (isCurrentConnection(generation, undefined, session)) system(error instanceof Error ? error.message : String(error));
  } finally {
    state.polling = false;
  }
}

function startActionPolling() {
  stopActionPolling();
  if (state.transport !== 'http') return;
  state.pollTimer = window.setInterval(() => void pollActions(), 1500);
  void pollActions();
}

async function handleDownlink(value, generation) {
  if (!isCurrentConnection(generation)) return;
  const action = value.body;
  const linkTarget = action.action === 'open_link' ? resolveRegisteredLink(action.targetId, window.location.href) : undefined;
  let ok = false;
  let decision = action.decision;
  let error;
  try {
    if (action.decision === 'deny') {
      throw new Error('手机动作已被策略拒绝');
    } else if (action.decision === 'confirm' && !window.confirm(`她请求手机动作：${action.action}${linkTarget ? `\n目标：${linkTarget}` : ''}\n${action.reason ?? '确认执行吗？'}`)) {
      decision = 'deny';
      error = '用户拒绝了手机动作';
    } else if (action.action === 'ring') {
      if (!navigator.vibrate) throw new Error('当前浏览器不支持振动');
      navigator.vibrate([200, 100, 200]);
      ok = true;
    } else if (action.action === 'notify') {
      if (!('Notification' in window)) throw new Error('当前浏览器不支持通知');
      if (Notification.permission !== 'granted') await Notification.requestPermission();
      if (!isCurrentConnection(generation)) return;
      if (Notification.permission !== 'granted') throw new Error('通知权限未授予');
      new Notification(String(action.params.title ?? '林梦瑶'), { body: String(action.params.text ?? '她有一条新消息') });
      ok = true;
    } else if (action.action === 'timer') {
      const seconds = Math.max(1, Math.min(24 * 60 * 60, Number(action.params.seconds ?? 60)));
      if (!Number.isFinite(seconds)) throw new Error('计时器参数不合法');
      window.setTimeout(() => { system(`计时器结束：${seconds} 秒`); if ('Notification' in window && Notification.permission === 'granted') new Notification('林梦瑶', { body: '计时器结束了' }); }, seconds * 1000);
      ok = true;
    } else if (action.action === 'open_link') {
      window.open(linkTarget, '_blank', 'noopener,noreferrer');
      ok = true;
    } else {
      throw new Error('当前 PWA 不执行此类手机动作');
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    decision = 'deny';
  }
  if (!isCurrentConnection(generation)) return;
  system(ok ? `已执行手机动作：${action.action}` : `手机动作未执行：${error ?? '被拒绝'}`);
  try { await sendActionResult(value.requestId, ok, decision, error, generation); }
  catch (cause) { if (isCurrentConnection(generation)) system(cause instanceof Error ? cause.message : String(cause)); }
}

async function send(value, generation = state.connectionGeneration) {
  if (!isCurrentConnection(generation)) return;
  if (value.kind !== 'hello') { state.pending.set(value.requestId, { value, sentAt: Date.now() }); startPendingWatch(); }
  touch();
  if (state.transport === 'ws') {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) { state.pending.delete(value.requestId); throw new Error('尚未连接'); }
    try { state.socket.send(JSON.stringify(value)); } catch (error) { state.pending.delete(value.requestId); throw error; }
    return;
  }
  const headers = { 'content-type': 'application/json' };
  if (state.session) headers['x-companion-session'] = state.session;
  let response;
  try {
    response = await fetch($('endpoint').value.trim(), { method: 'POST', headers, body: JSON.stringify(value) });
  } catch (error) {
    state.pending.delete(value.requestId);
    throw error;
  }
  if (!isCurrentConnection(generation)) return;
  state.session = response.headers.get('x-companion-session') ?? state.session;
  const text = await response.text();
  let result;
  if (text) { try { result = JSON.parse(text); } catch { state.pending.delete(value.requestId); throw new Error('服务端返回了无法解析的内容'); } }
  if (!response.ok) { state.pending.delete(value.requestId); throw new Error(result?.error ?? `HTTP ${response.status}`); }
  if (result) handleIncoming(result, generation);
}

async function connect() {
  if (state.connecting) return;
  const generation = ++state.connectionGeneration;
  const previousSocket = state.socket;
  state.socket = undefined;
  if (previousSocket) previousSocket.close();
  stopActionPolling();
  state.transport = $('transport').value;
  state.clientId = $('clientId').value.trim();
  state.pairingCode = $('pairingCode').value.trim();
  state.session = '';
  state.helloSent = false;
  state.receivedDownlinkNonces.clear();
  state.photoReview.reset();
  if (!state.clientId || !state.pairingCode) return system('请填写设备 ID 和一次性配对码');
  const hello = envelope('hello', { clientId: state.clientId, pairingCode: state.pairingCode, capabilities: ['text', 'audio', 'image', 'sticker'] });
  state.pending.clear();
  setBusy(true);
  setState('连接中…');
  if (state.transport === 'http') {
    try { await send(hello, generation); if (isCurrentConnection(generation)) { setState('已连接', true); system('HTTPS 配对成功'); startActionPolling(); } }
    catch (error) { if (isCurrentConnection(generation)) { setState('连接失败'); system(error instanceof Error ? error.message : String(error)); } }
    finally { if (isCurrentConnection(generation)) setBusy(false); }
    return;
  }
  let socket;
  try { socket = new WebSocket($('endpoint').value.trim()); }
  catch (error) { setBusy(false); setState('地址无效'); return system(error instanceof Error ? error.message : String(error)); }
  state.socket = socket;
  socket.addEventListener('open', () => { if (!isCurrentConnection(generation, socket)) return; state.helloSent = true; void send(hello, generation).then(() => { if (isCurrentConnection(generation, socket)) { setState('已连接', true); system('已发送配对请求，等待她回复…'); } }).catch(error => { if (isCurrentConnection(generation, socket)) system(error instanceof Error ? error.message : String(error)); }).finally(() => { if (isCurrentConnection(generation, socket)) setBusy(false); }); });
  socket.addEventListener('message', event => { if (!isCurrentConnection(generation, socket)) return; let value; try { value = JSON.parse(event.data); } catch { return system('服务端返回了无法解析的内容'); } handleIncoming(value, generation); });
  socket.addEventListener('close', () => { if (isCurrentConnection(generation, socket)) { state.connectionGeneration++; state.socket = undefined; state.pending.clear(); state.receivedDownlinkNonces.clear(); state.photoReview.reset(); stopActionPolling(); setBusy(false); setState('已断开'); system(state.helloSent ? '连接已断开：一次性配对码不能复用，请在 QQ 重新获取配对码后再连接' : '连接尚未完成，可稍后重试'); } });
  socket.addEventListener('error', () => { if (isCurrentConnection(generation, socket)) system('连接失败，请确认 Koishi server、路径和 HTTPS/WSS 设置'); });
}

async function uploadFile(file) {
  if (state.transport !== 'http') throw new Error('本地文件上传需要选择 HTTPS 传输');
  if (!state.session) throw new Error('请先完成 HTTPS 配对');
  if (file.size < 1 || file.size > 8 * 1024 * 1024) throw new Error('媒体大小必须在 1B 到 8MB 之间');
  if (!(file.type.startsWith('audio/') || file.type.startsWith('image/'))) throw new Error('只允许音频或图片');
  const headers = { 'x-companion-session': state.session, 'x-companion-mime': file.type || $('mediaMime').value.trim() };
  const response = await fetch($('mediaEndpoint').value.trim(), { method: 'POST', headers, body: file });
  const text = await response.text();
  let result;
  if (text) { try { result = JSON.parse(text); } catch { throw new Error('媒体服务返回了无法解析的内容'); } }
  if (!response.ok) throw new Error(result?.error ?? `媒体上传失败（HTTP ${response.status}）`);
  return result;
}

async function toggleRecording() {
  if (state.recorder) {
    state.recorder.stop();
    return;
  }
  if (state.transport !== 'http') throw new Error('麦克风录音需要选择 HTTPS 传输');
  if (!state.session) throw new Error('请先完成 HTTPS 配对');
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('当前浏览器不支持麦克风录音');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const preferred = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(type => MediaRecorder.isTypeSupported(type));
  const recorder = preferred ? new MediaRecorder(stream, { mimeType: preferred }) : new MediaRecorder(stream);
  state.recordChunks = [];
  state.recorder = recorder;
  $('recordAudio').textContent = '停止录音并发送';
  $('recordState').textContent = '正在录音…点击停止后自动发送';
  recorder.addEventListener('dataavailable', event => { if (event.data.size > 0) state.recordChunks.push(event.data); });
  recorder.addEventListener('stop', () => {
    stream.getTracks().forEach(track => track.stop());
    state.recorder = undefined;
    $('recordAudio').textContent = '开始录音';
    $('recordState').textContent = '正在上传录音…';
    const mime = recorder.mimeType || preferred || 'audio/webm';
    const blob = new Blob(state.recordChunks, { type: mime });
    state.recordChunks = [];
    Promise.resolve().then(async () => {
      if (blob.size < 1) throw new Error('没有录到声音');
      const uploaded = await uploadFile(new File([blob], `recording-${Date.now()}.audio`, { type: mime }));
      await send(envelope('message.send', { kind: 'audio', media: uploaded }));
      log('out', '[语音录音]');
    }).catch(error => system(error instanceof Error ? error.message : String(error))).finally(() => { $('recordState').textContent = '麦克风录音仅在 HTTPS 模式可用'; });
  }, { once: true });
  recorder.start();
}

function renderPhotoReview() {
  revokePhotoThumbnails();
  const renderGeneration = ++state.photoRenderGeneration;
  const view = state.photoReview.view();
  $('photoRefresh').disabled = !state.connected || view.busy;
  $('photoRefresh').textContent = view.phase === 'loading' ? '正在刷新…' : '刷新';
  $('photoFilter').disabled = view.busy;
  $('photoFilter').value = view.filter;
  $('photoNotice').hidden = !view.notice;
  $('photoNotice').textContent = view.notice ?? '';
  const list = $('photoReviewList');
  list.replaceChildren();
  if (!state.connected && view.phase === 'idle') {
    const empty = document.createElement('p');
    empty.className = 'photo-empty';
    empty.textContent = '连接后可查看生活照草稿';
    list.append(empty);
    return;
  }
  if (!view.items.length) {
    const empty = document.createElement('p');
    empty.className = 'photo-empty';
    empty.textContent = view.emptyText;
    list.append(empty);
    return;
  }
  for (const item of view.items) {
    const card = document.createElement('article');
    card.className = 'photo-item';
    const thumbnail = document.createElement('div');
    thumbnail.className = 'photo-thumb';
    thumbnail.textContent = item.hasThumbnail ? (!state.connected ? '重新连接后查看缩略图' : state.transport === 'http' ? '正在读取缩略图…' : '切换到 HTTPS 查看缩略图') : '暂无缩略图';
    const copy = document.createElement('div');
    copy.className = 'photo-copy';
    const meta = document.createElement('div');
    meta.className = 'photo-meta';
    const kind = document.createElement('span');
    kind.textContent = item.kindLabel;
    const status = document.createElement('span');
    status.className = 'photo-status';
    status.textContent = item.statusLabel;
    const at = document.createElement('span');
    at.textContent = item.timeLabel;
    meta.append(kind, status, at);
    if (item.expiryLabel) {
      const expiry = document.createElement('span');
      expiry.textContent = item.expiryLabel;
      meta.append(expiry);
    }
    const caption = document.createElement('p');
    caption.className = 'photo-caption';
    caption.textContent = item.caption;
    copy.append(meta, caption);
    if (item.canApprove || item.canReject) {
      const actions = document.createElement('div');
      actions.className = 'photo-actions';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.textContent = '通过';
      approve.disabled = view.busy || !state.connected || !item.canApprove;
      approve.addEventListener('click', () => openPhotoDecision(item.key, 'approve'));
      const reject = document.createElement('button');
      reject.type = 'button';
      reject.className = 'reject';
      reject.textContent = '拒绝';
      reject.disabled = view.busy || !state.connected || !item.canReject;
      reject.addEventListener('click', () => openPhotoDecision(item.key, 'reject'));
      actions.append(approve, reject);
      copy.append(actions);
    }
    card.append(thumbnail, copy);
    list.append(card);
    if (item.hasThumbnail && state.connected && state.transport === 'http') void loadPhotoThumbnail(item.key, thumbnail, renderGeneration);
  }
}

function revokePhotoThumbnails() {
  for (const url of state.photoObjectUrls.values()) URL.revokeObjectURL(url);
  state.photoObjectUrls.clear();
}

async function loadPhotoThumbnail(key, container, renderGeneration) {
  const thumbnail = state.photoReview.thumbnailFor(key);
  const session = state.session;
  const connectionGeneration = state.connectionGeneration;
  if (!thumbnail || !session || state.transport !== 'http') { container.textContent = '缩略图暂不可用'; return; }
  try {
    const response = await fetch($('mediaEndpoint').value.trim(), {
      method: 'GET',
      headers: { 'x-companion-session': session, 'x-companion-media-id': thumbnail.mediaId, accept: thumbnail.mime },
      cache: 'no-store',
    });
    if (!isCurrentConnection(connectionGeneration, undefined, session) || renderGeneration !== state.photoRenderGeneration) return;
    if (!response.ok) throw new Error('thumbnail_unavailable');
    const mime = String(response.headers.get('content-type') ?? '').split(';', 1)[0].toLowerCase();
    if (mime !== thumbnail.mime || !['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new Error('thumbnail_type_mismatch');
    const blob = await response.blob();
    if (!isCurrentConnection(connectionGeneration, undefined, session) || renderGeneration !== state.photoRenderGeneration) return;
    if (blob.size < 1 || blob.size > 1024 * 1024) throw new Error('thumbnail_size_invalid');
    const url = URL.createObjectURL(blob);
    if (renderGeneration !== state.photoRenderGeneration) { URL.revokeObjectURL(url); return; }
    state.photoObjectUrls.set(key, url);
    const image = document.createElement('img');
    image.alt = '生活照草稿缩略图';
    image.loading = 'lazy';
    image.src = url;
    container.replaceChildren(image);
  } catch {
    if (renderGeneration === state.photoRenderGeneration) container.textContent = '缩略图已过期或不可用';
  }
}

function openPhotoDecision(key, decision) {
  try {
    state.photoReview.requestDecision(key, decision);
    const confirmation = state.photoReview.view().confirmation;
    if (!confirmation) throw new Error('照片确认信息不可用');
    $('photoConfirmTitle').textContent = confirmation.title;
    $('photoConfirmMessage').textContent = confirmation.message;
    $('photoConfirmAction').textContent = confirmation.confirmLabel;
    $('photoConfirmAction').className = confirmation.tone === 'danger' ? 'reject' : '';
    $('photoConfirm').showModal();
    renderPhotoReview();
  } catch (error) {
    system(error instanceof Error ? error.message : String(error));
  }
}

async function refreshPhotoReview() {
  if (!state.connected) throw new Error('请先配对并连接');
  const body = state.photoReview.beginRefresh($('photoFilter').value);
  renderPhotoReview();
  try { await send(envelope('photo.review.list', body)); }
  catch (error) { state.photoReview.fail(); renderPhotoReview(); throw error; }
}

async function confirmPhotoDecision() {
  if (!state.connected) throw new Error('请先配对并连接');
  const body = state.photoReview.confirmDecision();
  $('photoConfirm').close();
  renderPhotoReview();
  try { await send(envelope('photo.review.decide', body)); }
  catch (error) { state.photoReview.fail(); renderPhotoReview(); throw error; }
}

function formSubmit(form, fn) {
  $(form).addEventListener('submit', event => {
    event.preventDefault();
    Promise.resolve().then(fn).catch(error => system(error instanceof Error ? error.message : String(error)));
  });
}

formSubmit('textForm', async () => {
  const text = $('text').value.trim();
  if (!text) return;
  await send(envelope('message.send', { kind: 'text', text }));
  log('out', text);
  $('text').value = '';
});

formSubmit('mediaForm', async () => {
  const kind = $('mediaKind').value;
  const file = $('mediaFile').files?.[0];
  let media;
  if (file) {
    if (kind === 'audio' && !file.type.startsWith('audio/')) throw new Error('语音类型必须选择音频文件');
    if (kind === 'image' && !file.type.startsWith('image/')) throw new Error('图片类型必须选择图片文件');
    const uploaded = await uploadFile(file);
    media = { ...uploaded };
  } else {
    const ref = $('mediaRef').value.trim();
    if (!ref) throw new Error('请选择文件，或填写 HTTPS URL / mediaId');
    if (!/^https:\/\//i.test(ref) && !/^[a-f0-9]{16,128}$/i.test(ref)) throw new Error('引用只允许 HTTPS URL 或媒体 ID');
    const bytes = Number($('mediaBytes').value);
    if (!Number.isInteger(bytes) || bytes < 1 || bytes > 8 * 1024 * 1024) throw new Error('字节数必须在 1B 到 8MB 之间');
    media = { mime: $('mediaMime').value.trim(), bytes, ...(ref.startsWith('https://') ? { url: ref } : { mediaId: ref }) };
  }
  await send(envelope('message.send', { kind, media }));
  log('out', `[${kind}]`);
});

formSubmit('stickerForm', async () => {
  const stickerId = $('stickerId').value.trim();
  if (!/^[a-f0-9]{16,128}$/i.test(stickerId)) throw new Error('表情必须使用服务端 catalog ID');
  const mediaId = stickerId;
  await send(envelope('message.send', { kind: 'sticker', stickerId, media: { mediaId, mime: $('stickerMime').value.trim(), bytes: Number($('stickerBytes').value) } }));
  log('out', '[表情]');
});

formSubmit('actionForm', async () => {
  const action = $('action').value;
  const needs = ['ring', 'open_link', 'media_control', 'volume'].includes(action);
  if (needs && !$('confirmAction').checked) throw new Error('该动作需要先勾选确认');
  const params = JSON.parse($('actionParams').value || '{}');
  const targetId = action === 'open_link' ? 'companion-home' : undefined;
  await send(envelope('action.request', { action, params, decision: needs ? 'confirm' : 'auto', ...(targetId ? { targetId } : {}), reason: $('actionReason').value.trim() || undefined }));
  system(`已请求动作：${action}`);
});

$('transport').addEventListener('change', () => {
  stopActionPolling();
  const http = $('transport').value === 'http';
  $('mediaEndpointRow').hidden = !http;
  $('endpoint').value = http ? 'http://127.0.0.1:5140/qqbot/companion/http' : 'ws://127.0.0.1:5140/qqbot/companion';
  $('mediaEndpoint').value = 'http://127.0.0.1:5140/qqbot/companion/http/media';
  $('recordState').textContent = http ? '点击开始录音，停止后自动发送' : '麦克风录音仅在 HTTPS 模式可用';
});
$('recordAudio').addEventListener('click', () => void toggleRecording().catch(error => system(error instanceof Error ? error.message : String(error))));
$('connect').addEventListener('click', () => void connect());
$('photoRefresh').addEventListener('click', () => void refreshPhotoReview().catch(error => system(error instanceof Error ? error.message : String(error))));
$('photoFilter').addEventListener('change', () => { if (state.connected) void refreshPhotoReview().catch(error => system(error instanceof Error ? error.message : String(error))); });
$('photoCancel').addEventListener('click', () => { state.photoReview.cancelDecision(); $('photoConfirm').close(); renderPhotoReview(); });
$('photoConfirmAction').addEventListener('click', () => void confirmPhotoDecision().catch(error => system(error instanceof Error ? error.message : String(error))));
$('photoConfirm').addEventListener('cancel', event => { event.preventDefault(); state.photoReview.cancelDecision(); $('photoConfirm').close(); renderPhotoReview(); });
window.addEventListener('online', () => { if (!state.socket && $('pairingCode').value.trim()) system('网络已恢复，可以重新连接'); });
window.addEventListener('offline', () => { stopActionPolling(); setState('设备离线'); system('网络已断开，消息不会自动发送'); });
setState('未连接');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
