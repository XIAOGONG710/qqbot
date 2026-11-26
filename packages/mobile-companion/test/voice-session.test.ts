import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEnvelope } from '../src/protocol.ts';
import { MAX_VOICE_CHUNK_BYTES, MAX_VOICE_SESSION_BYTES, MAX_VOICE_SESSION_MS, VoiceSessionGate } from '../src/voice-session.ts';
import { withBufferedVoiceConversation } from '../src/voice-conversation.ts';
import { createDshCompanionHandlers } from '../src/dsh-adapter.ts';
import { CompanionGateway, helloEnvelope } from '../src/gateway.ts';
import { MemoryPairingStore } from '../src/pairing.ts';
import { CompanionRuntime } from '../src/runtime.ts';

test('实时语音分片必须有序，可中断且有总量边界', () => {
    const gate = new VoiceSessionGate();
    const start = { sessionId: 'voice-001', mime: 'audio/webm' as const, sampleRate: 48_000 };
    gate.start('android-a', start, 1_000);
    assert.equal(gate.chunk('android-a', { sessionId: start.sessionId, sequence: 0, data: Buffer.from('one').toString('base64') }, 1_001), 3);
    assert.throws(() => gate.chunk('android-a', { sessionId: start.sessionId, sequence: 2, data: Buffer.from('gap').toString('base64') }, 1_002), /顺序/);
    assert.equal(gate.stop('android-a', { sessionId: start.sessionId, lastSequence: 0 }), 3);
    assert.throws(() => gate.stop('android-a', { sessionId: start.sessionId, lastSequence: 0 }), /不存在/);
});

test('协议包接受语音开始与取消，但拒绝非法分片', () => {
    const base = { v: 1, requestId: 'request-001', sentAt: new Date(10_000).toISOString(), nonce: 'nonce-001' };
    assert.equal(validateEnvelope({ ...base, kind: 'voice.session.start', body: { sessionId: 'voice-001', mime: 'audio/ogg' } }, 10_000).kind, 'voice.session.start');
    assert.throws(() => validateEnvelope({ ...base, kind: 'voice.session.chunk', body: { sessionId: 'voice-001', sequence: 0, data: '***' } }, 10_000), /分片/);
});

test('运行时把实时分片交给宿主，停止后返回同一对话的回复', async () => {
    const now = 20_000;
    const pairing = new MemoryPairingStore(60_000);
    const ticket = pairing.issue('android-voice', now);
    const gateway = new CompanionGateway(pairing, () => now);
    const received: string[] = [];
    const runtime = new CompanionRuntime(gateway, {
        onMessage: async () => ({ kind: 'text', text: '普通回复' }),
        onAction: async (_request, _client, requestId) => ({ requestId, ok: false, decision: 'deny' }),
        onVoiceSessionStart: async request => { received.push(`start:${request.mime}`); },
        onVoiceSessionChunk: async (_request, bytes) => { received.push(Buffer.from(bytes).toString()); },
        onVoiceSessionStop: async (_request, total) => ({ kind: 'text', text: `听到了 ${total} 字节` }),
    }, () => now);
    await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text', 'audio'] }, 'req-voice-hello', 'nonce-voice-hello', new Date(now).toISOString()));
    const base = { v: 1, sentAt: new Date(now).toISOString() };
    assert.equal((await runtime.handle({ ...base, requestId: 'req-voice-start', nonce: 'nonce-voice-start', kind: 'voice.session.start', body: { sessionId: 'voice-001', mime: 'audio/webm' } })).accepted, true);
    assert.equal((await runtime.handle({ ...base, requestId: 'req-voice-chunk', nonce: 'nonce-voice-chunk', kind: 'voice.session.chunk', body: { sessionId: 'voice-001', sequence: 0, data: Buffer.from('voice').toString('base64') } })).accepted, true);
    const stopped = await runtime.handle({ ...base, requestId: 'req-voice-stop', nonce: 'nonce-voice-stop', kind: 'voice.session.stop', body: { sessionId: 'voice-001', lastSequence: 0 } });
    assert.deepEqual(received, ['start:audio/webm', 'voice']);
    assert.equal(stopped.accepted && stopped.response?.kind, 'message.receive');
    if (stopped.accepted) assert.equal((stopped.response?.body as { text?: string }).text, '听到了 5 字节');
});

test('没有声明音频能力的设备不能打开实时语音', async () => {
    const now = 30_000;
    const pairing = new MemoryPairingStore(60_000);
    const ticket = pairing.issue('android-text-only', now);
    const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
        onMessage: async () => ({ kind: 'text', text: 'ok' }),
        onAction: async (_request, _client, requestId) => ({ requestId, ok: false, decision: 'deny' }),
        onVoiceSessionStart: async () => {},
    }, () => now);
    await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text'] }, 'req-text-hello', 'nonce-text-hello', new Date(now).toISOString()));
    const result = await runtime.handle({ v: 1, requestId: 'req-text-voice', nonce: 'nonce-text-voice', sentAt: new Date(now).toISOString(), kind: 'voice.session.start', body: { sessionId: 'voice-001', mime: 'audio/webm' } });
    assert.equal(result.accepted, false);
    if (!result.accepted) assert.match(result.error, /audio/);
});

test('同一设备同时打开的实时语音有上限；开了不收尾的会话按时长清掉，宿主的音频缓冲一起丢', async () => {
    let now = 40_000;
    const pairing = new MemoryPairingStore(60_000);
    const ticket = pairing.issue('android-voice-cap', now);
    const buffered = new Set<string>();
    const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), {
        onMessage: async () => ({ kind: 'text', text: 'ok' }),
        onAction: async (_request, _client, requestId) => ({ requestId, ok: false, decision: 'deny' }),
        onVoiceSessionStart: async request => { buffered.add(request.sessionId); },
        onVoiceSessionChunk: async () => {},
        onVoiceSessionCancel: async request => { buffered.delete(request.sessionId); },
    }, () => now);
    await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text', 'audio'] }, 'req-cap-hello', 'nonce-cap-hello', new Date(now).toISOString()));
    let counter = 0;
    const send = (kind: string, body: unknown) => { counter++; return runtime.handle({ v: 1, requestId: `req-cap-${counter}`, nonce: `nonce-cap-${counter}`, sentAt: new Date(now).toISOString(), kind, body }); };
    const failed = (result: Awaited<ReturnType<typeof send>>) => result.accepted && result.response?.kind === 'error';

    assert.equal(failed(await send('voice.session.start', { sessionId: 'voice-a1', mime: 'audio/webm' })), false);
    assert.equal(failed(await send('voice.session.start', { sessionId: 'voice-a2', mime: 'audio/webm' })), false);
    const third = await send('voice.session.start', { sessionId: 'voice-a3', mime: 'audio/webm' });
    assert.equal(failed(third), true, '第三段同时打开的会话被拒绝');
    if (third.accepted) assert.match(String((third.response?.body as { message?: string }).message), /过多/);
    assert.deepEqual([...buffered].sort(), ['voice-a1', 'voice-a2']);

    // 两段都没收尾，超过单段时长之后再开一段：旧的两段从闸门和宿主缓冲里一起清掉
    now += MAX_VOICE_SESSION_MS + 1;
    assert.equal(failed(await send('voice.session.start', { sessionId: 'voice-a4', mime: 'audio/webm' })), false);
    assert.deepEqual([...buffered], ['voice-a4']);

    // 分片时发现超时：闸门丢掉会话，宿主缓冲也丢
    now += MAX_VOICE_SESSION_MS + 1;
    assert.equal(failed(await send('voice.session.chunk', { sessionId: 'voice-a4', sequence: 0, data: Buffer.from('late').toString('base64') })), true);
    assert.deepEqual([...buffered], []);
});

test('实时语音分片超过单段总量时会话作废，分片中断后可取消', () => {
    const gate = new VoiceSessionGate();
    gate.start('android-a', { sessionId: 'voice-big', mime: 'audio/ogg' }, 1_000);
    const chunk = Buffer.alloc(MAX_VOICE_CHUNK_BYTES, 1).toString('base64');
    const fit = MAX_VOICE_SESSION_BYTES / MAX_VOICE_CHUNK_BYTES;
    for (let sequence = 0; sequence < fit; sequence++) gate.chunk('android-a', { sessionId: 'voice-big', sequence, data: chunk }, 1_001);
    assert.throws(() => gate.chunk('android-a', { sessionId: 'voice-big', sequence: fit, data: chunk }, 1_002), /过大/);
    assert.equal(gate.has('android-a', 'voice-big'), false);
    gate.start('android-a', { sessionId: 'voice-cut', mime: 'audio/ogg' }, 2_000);
    assert.equal(gate.cancel('android-a', { sessionId: 'voice-cut', reason: 'interrupted' }), true);
    assert.throws(() => gate.chunk('android-a', { sessionId: 'voice-cut', sequence: 0, data: chunk }, 2_001), /不存在/);
});

test('转写期间伴侣停止：这段语音不再交给模型，也不写进共享上下文', async () => {
    const now = 50_000;
    const pairing = new MemoryPairingStore(60_000);
    const ticket = pairing.issue('android-voice-stop', now);
    let finishTranscribe!: (text: string) => void;
    const advised: string[] = [];
    const committed: string[] = [];
    const handlers = withBufferedVoiceConversation(createDshCompanionHandlers({
        advisor: { advise: async request => { advised.push(request.question); return '嗯'; } },
        sharedConversation: { recent: () => [], commit: (_client, question) => { committed.push(question); } },
    }), { transcribe: () => new Promise<string>(resolve => { finishTranscribe = resolve; }) });
    const runtime = new CompanionRuntime(new CompanionGateway(pairing, () => now), handlers, () => now);
    await runtime.handle(helloEnvelope({ clientId: ticket.clientId, pairingCode: ticket.pairingCode, capabilities: ['text', 'audio'] }, 'req-vs-hello', 'nonce-vs-hello', new Date(now).toISOString()));
    const base = { v: 1, sentAt: new Date(now).toISOString() };
    await runtime.handle({ ...base, requestId: 'req-vs-start', nonce: 'nonce-vs-start', kind: 'voice.session.start', body: { sessionId: 'voice-s1', mime: 'audio/webm' } });
    await runtime.handle({ ...base, requestId: 'req-vs-chunk', nonce: 'nonce-vs-chunk', kind: 'voice.session.chunk', body: { sessionId: 'voice-s1', sequence: 0, data: Buffer.from('voice').toString('base64') } });
    const stopping = runtime.handle({ ...base, requestId: 'req-vs-stop', nonce: 'nonce-vs-stop', kind: 'voice.session.stop', body: { sessionId: 'voice-s1', lastSequence: 0 } });
    await new Promise(resolve => setTimeout(resolve, 0));
    const drained = runtime.stop();
    finishTranscribe('停了之后才转写完的话');
    assert.equal((await stopping).accepted, false);
    await drained;
    assert.deepEqual(advised, []);
    assert.deepEqual(committed, []);
});
