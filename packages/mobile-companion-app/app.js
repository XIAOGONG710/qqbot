const $ = id => document.getElementById(id);
const state = { socket: undefined, transport: 'ws', clientId: '', pairingCode: '', session: '', pending: new Map(), receivedDownlinkNonces: new Set(), recorder: undefined, recordChunks: [], pollTimer: undefined, polling: false };
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
const setState = (text, on = false) => { $('state').textContent = text; $('state').className = `pill ${on ? 'on' : 'off'}`; };

function acceptDownlink(value) {
  if (!value || typeof value !== 'object' || value.v !== 1 || value.kind !== 'action.request' || typeof value.nonce !== 'string' || !value.nonce || !value.body || typeof value.body !== 'object') throw new Error('手机动作下行包不合法');
  if (state.receivedDownlinkNonces.has(value.nonce)) throw new Error('手机动作下行包重复');
  state.receivedDownlinkNonces.add(value.nonce);
  if (state.receivedDownlinkNonces.size > 256) state.receivedDownlinkNonces.delete(state.receivedDownlinkNonces.values().next().value);
  return value;
}

function handleIncoming(value) {
  if (!value) return;
  if (value.error) return system(value.error);
  if (value.kind === 'action.request') {
    try { void handleDownlink(acceptDownlink(value)); }
    catch (error) { system(error instanceof Error ? error.message : String(error)); }
    return;
  }
  if (value.kind === 'message.receive') {
    state.pending.delete(value.requestId.replace(/^resp-/, ''));
    return log('in', value.body);
  }
  if (value.kind === 'action.result') {
    state.pending.delete(value.requestId.replace(/^resp-/, ''));
    return system(value.body.ok ? `动作已处理：${value.body.decision}` : `动作未执行：${value.body.error ?? '被拒绝'}`);
  }
  if (value.kind === 'error') return system(value.body.message ?? '服务端错误');
  if (value.kind === undefined) system('配对成功');
}

async function sendActionResult(requestId, ok, decision, error) {
  const value = envelope('action.result', { requestId, ok, decision, ...(error ? { error } : {}) });
  if (state.transport === 'ws') {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) throw new Error('动作回执发送失败：连接已断开');
    state.socket.send(JSON.stringify(value));
    return;
  }
  const headers = { 'content-type': 'application/json' };
  if (state.session) headers['x-companion-session'] = state.session;
  const response = await fetch($('endpoint').value.trim(), { method: 'POST', headers, body: JSON.stringify(value) });
  state.session = response.headers.get('x-companion-session') ?? state.session;
  if (!response.ok) throw new Error(`动作回执失败（HTTP ${response.status}）`);
}

function stopActionPolling() {
  if (state.pollTimer) window.clearInterval(state.pollTimer);
  state.pollTimer = undefined;
}

async function pollActions() {
  if (state.transport !== 'http' || !state.session || state.polling) return;
  state.polling = true;
  try {
    const endpoint = $('endpoint').value.trim().replace(/\/$/, '') + '/actions';
    const response = await fetch(endpoint, { headers: { 'x-companion-session': state.session, accept: 'application/json' } });
    if (response.status === 401) { stopActionPolling(); system('HTTPS 会话已过期，请重新配对'); return; }
    if (!response.ok) throw new Error(`动作轮询失败（HTTP ${response.status}）`);
    const result = await response.json();
    for (const action of Array.isArray(result.actions) ? result.actions : []) handleIncoming(action);
  } catch (error) {
    system(error instanceof Error ? error.message : String(error));
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

async function handleDownlink(value) {
  const action = value.body;
  let ok = false;
  let decision = action.decision;
  let error;
  try {
    if (action.decision === 'confirm' && !window.confirm(`她请求手机动作：${action.action}\n${action.reason ?? '确认执行吗？'}`)) {
      decision = 'deny';
      error = '用户拒绝了手机动作';
    } else if (action.action === 'ring') {
      if (!navigator.vibrate) throw new Error('当前浏览器不支持振动');
      navigator.vibrate([200, 100, 200]);
      ok = true;
    } else if (action.action === 'notify') {
      if (!('Notification' in window)) throw new Error('当前浏览器不支持通知');
      if (Notification.permission !== 'granted') await Notification.requestPermission();
      if (Notification.permission !== 'granted') throw new Error('通知权限未授予');
      new Notification(String(action.params.title ?? '林梦瑶'), { body: String(action.params.text ?? '她有一条新消息') });
      ok = true;
    } else if (action.action === 'timer') {
      const seconds = Math.max(1, Math.min(24 * 60 * 60, Number(action.params.seconds ?? 60)));
      if (!Number.isFinite(seconds)) throw new Error('计时器参数不合法');
      window.setTimeout(() => { system(`计时器结束：${seconds} 秒`); if ('Notification' in window && Notification.permission === 'granted') new Notification('林梦瑶', { body: '计时器结束了' }); }, seconds * 1000);
      ok = true;
    } else if (action.action === 'open_link') {
      const url = String(action.params.url ?? '');
      if (!/^https:\/\//i.test(url)) throw new Error('只允许打开 HTTPS 链接');
      window.open(url, '_blank', 'noopener,noreferrer');
      ok = true;
    } else {
      throw new Error('当前 PWA 不执行此类手机动作');
    }
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    decision = 'deny';
  }
  system(ok ? `已执行手机动作：${action.action}` : `手机动作未执行：${error ?? '被拒绝'}`);
  try { await sendActionResult(value.requestId, ok, decision, error); }
  catch (cause) { system(cause instanceof Error ? cause.message : String(cause)); }
}

async function send(value) {
  if (value.kind !== 'hello') state.pending.set(value.requestId, value);
  if (state.transport === 'ws') {
    if (!state.socket || state.socket.readyState !== WebSocket.OPEN) throw new Error('尚未连接');
    state.socket.send(JSON.stringify(value));
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
  state.session = response.headers.get('x-companion-session') ?? state.session;
  const text = await response.text();
  let result;
  if (text) { try { result = JSON.parse(text); } catch { state.pending.delete(value.requestId); throw new Error('服务端返回了无法解析的内容'); } }
  if (!response.ok) { state.pending.delete(value.requestId); throw new Error(result?.error ?? `HTTP ${response.status}`); }
  if (result) handleIncoming(result);
  if (value.kind === 'hello') { setState('已连接', true); system('HTTPS 配对成功'); startActionPolling(); }
}

async function connect() {
  if (state.socket) state.socket.close();
  stopActionPolling();
  state.transport = $('transport').value;
  state.clientId = $('clientId').value.trim();
  state.pairingCode = $('pairingCode').value.trim();
  state.session = '';
  state.receivedDownlinkNonces.clear();
  if (!state.clientId || !state.pairingCode) return system('请填写设备 ID 和一次性配对码');
  const hello = envelope('hello', { clientId: state.clientId, pairingCode: state.pairingCode, capabilities: ['text', 'audio', 'image', 'sticker'] });
  state.pending.clear();
  setState('连接中…');
  if (state.transport === 'http') {
    try { await send(hello); } catch (error) { setState('连接失败'); system(error instanceof Error ? error.message : String(error)); }
    return;
  }
  const socket = new WebSocket($('endpoint').value.trim());
  state.socket = socket;
  socket.addEventListener('open', () => { void send(hello).then(() => { setState('已连接', true); system('已发送配对请求，等待她回复…'); }).catch(error => system(error instanceof Error ? error.message : String(error))); });
  socket.addEventListener('message', event => { let value; try { value = JSON.parse(event.data); } catch { return system('服务端返回了无法解析的内容'); } handleIncoming(value); });
  socket.addEventListener('close', () => { if (state.socket === socket) { state.socket = undefined; state.pending.clear(); state.receivedDownlinkNonces.clear(); stopActionPolling(); setState('已断开'); system('连接已断开，可重新生成配对码后重连'); } });
  socket.addEventListener('error', () => system('连接失败，请确认 Koishi server、路径和 HTTPS/WSS 设置'));
}

async function uploadFile(file) {
  if (state.transport !== 'http') throw new Error('本地文件上传需要选择 HTTPS 传输');
  if (!state.session) throw new Error('请先完成 HTTPS 配对');
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
    media = { mime: $('mediaMime').value.trim(), bytes: Number($('mediaBytes').value), ...(ref.startsWith('https://') ? { url: ref } : { mediaId: ref }) };
  }
  await send(envelope('message.send', { kind, media }));
  log('out', `[${kind}]`);
});

formSubmit('stickerForm', async () => {
  const stickerId = $('stickerId').value.trim();
  const mediaId = stickerId;
  await send(envelope('message.send', { kind: 'sticker', stickerId, media: { mediaId, mime: $('stickerMime').value.trim(), bytes: Number($('stickerBytes').value) } }));
  log('out', '[表情]');
});

formSubmit('actionForm', async () => {
  const action = $('action').value;
  const needs = ['ring', 'open_link', 'media_control', 'volume'].includes(action);
  if (needs && !$('confirmAction').checked) throw new Error('该动作需要先勾选确认');
  const params = JSON.parse($('actionParams').value || '{}');
  await send(envelope('action.request', { action, params, decision: needs ? 'confirm' : 'auto', reason: $('actionReason').value.trim() || undefined }));
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
setState('未连接');
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => undefined);
