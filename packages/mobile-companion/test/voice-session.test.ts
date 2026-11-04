import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEnvelope } from '../src/protocol.ts';
import { VoiceSessionGate } from '../src/voice-session.ts';
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
