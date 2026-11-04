import type { CompanionMessage } from './protocol.ts';
import type { CompanionRuntimeHandlers } from './runtime.ts';
import type { VoiceSessionCancel, VoiceSessionChunk, VoiceSessionStart, VoiceSessionStop } from './voice-session.ts';

interface BufferedVoiceSession {
    mime: VoiceSessionStart['mime'];
    chunks: Uint8Array[];
    bytes: number;
}

const keyOf = (clientId: string, sessionId: string) => `${clientId}\0${sessionId}`;

/**
 * 把已经通过协议顺序闸的语音分片接回普通对话入口。
 * 原始音频只在内存中保留到 stop/cancel/reset，不写盘，也不绕过同一条 DSH 上下文。
 */
export function withBufferedVoiceConversation(base: CompanionRuntimeHandlers, options: {
    transcribe(data: Uint8Array, mime: VoiceSessionStart['mime'], clientId: string): Promise<string>;
}): CompanionRuntimeHandlers {
    const sessions = new Map<string, BufferedVoiceSession>();
    const clearClient = (clientId?: string) => {
        if (!clientId) sessions.clear();
        else for (const key of sessions.keys()) if (key.startsWith(`${clientId}\0`)) sessions.delete(key);
    };
    return {
        ...base,
        async onVoiceSessionStart(request: VoiceSessionStart, clientId: string): Promise<void> {
            sessions.set(keyOf(clientId, request.sessionId), { mime: request.mime, chunks: [], bytes: 0 });
        },
        async onVoiceSessionChunk(request: VoiceSessionChunk, bytes: Uint8Array, clientId: string): Promise<void> {
            const session = sessions.get(keyOf(clientId, request.sessionId));
            if (!session) throw new Error('语音缓冲不存在');
            // 复制分片，避免传输实现复用底层 ArrayBuffer 后篡改尚未转写的内容。
            const copy = new Uint8Array(bytes);
            session.chunks.push(copy);
            session.bytes += copy.byteLength;
        },
        async onVoiceSessionStop(request: VoiceSessionStop, totalBytes: number, clientId: string): Promise<CompanionMessage> {
            const key = keyOf(clientId, request.sessionId);
            const session = sessions.get(key);
            sessions.delete(key);
            if (!session || session.bytes !== totalBytes || totalBytes < 1) throw new Error('语音缓冲不完整');
            const joined = new Uint8Array(totalBytes);
            let offset = 0;
            for (const chunk of session.chunks) { joined.set(chunk, offset); offset += chunk.byteLength; }
            const transcript = (await options.transcribe(joined, session.mime, clientId)).trim();
            if (!transcript) throw new Error('没有听清这段语音');
            return base.onMessage({ kind: 'text', text: transcript.slice(0, 4_000) }, clientId);
        },
        async onVoiceSessionCancel(request: VoiceSessionCancel, clientId: string): Promise<void> {
            sessions.delete(keyOf(clientId, request.sessionId));
        },
        onReset(clientId?: string): void {
            clearClient(clientId);
            base.onReset?.(clientId);
        },
    };
}
