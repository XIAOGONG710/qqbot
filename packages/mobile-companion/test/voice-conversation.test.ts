import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withBufferedVoiceConversation } from '../src/voice-conversation.ts';

test('实时语音停止后走同一个文字对话入口，并在取消和重置时清除原始字节', async () => {
    const questions: string[] = [];
    const handler = withBufferedVoiceConversation({
        onMessage: async message => { questions.push(message.text ?? ''); return { kind: 'text', text: `收到：${message.text}` }; },
        onAction: async (_request, _client, requestId) => ({ requestId, ok: false, decision: 'deny' }),
    }, {
        transcribe: async (data, mime) => `${mime}:${Buffer.from(data).toString()}`,
    });
    await handler.onVoiceSessionStart!({ sessionId: 'voice-001', mime: 'audio/webm' }, 'phone-a');
    await handler.onVoiceSessionChunk!({ sessionId: 'voice-001', sequence: 0, data: '' }, new Uint8Array(Buffer.from('你')), 'phone-a');
    await handler.onVoiceSessionChunk!({ sessionId: 'voice-001', sequence: 1, data: '' }, new Uint8Array(Buffer.from('好')), 'phone-a');
    const reply = await handler.onVoiceSessionStop!({ sessionId: 'voice-001', lastSequence: 1 }, 6, 'phone-a');
    assert.deepEqual(reply, { kind: 'text', text: '收到：audio/webm:你好' });
    assert.deepEqual(questions, ['audio/webm:你好']);

    await handler.onVoiceSessionStart!({ sessionId: 'voice-002', mime: 'audio/ogg' }, 'phone-a');
    await handler.onVoiceSessionCancel!({ sessionId: 'voice-002', reason: 'user' }, 'phone-a');
    await assert.rejects(() => handler.onVoiceSessionStop!({ sessionId: 'voice-002', lastSequence: -1 }, 1, 'phone-a'), /不完整/);

    await handler.onVoiceSessionStart!({ sessionId: 'voice-003', mime: 'audio/wav' }, 'phone-a');
    handler.onReset?.('phone-a');
    await assert.rejects(() => handler.onVoiceSessionStop!({ sessionId: 'voice-003', lastSequence: -1 }, 1, 'phone-a'), /不完整/);
});
