export const MAX_VOICE_CHUNK_BYTES = 256 * 1024;
export const MAX_VOICE_SESSION_BYTES = 8 * 1024 * 1024;
export const MAX_VOICE_SESSION_MS = 2 * 60_000;

export interface VoiceSessionStart {
    sessionId: string;
    mime: 'audio/ogg' | 'audio/webm' | 'audio/wav' | 'audio/mp4';
    sampleRate?: number;
}
export interface VoiceSessionChunk { sessionId: string; sequence: number; data: string }
export interface VoiceSessionStop { sessionId: string; lastSequence: number }
export interface VoiceSessionCancel { sessionId: string; reason?: 'user' | 'interrupted' | 'network' }

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function validateVoiceSessionStart(value: unknown): VoiceSessionStart {
    if (!value || typeof value !== 'object') throw new Error('语音会话开始信息不合法');
    const input = value as Partial<VoiceSessionStart>;
    if (typeof input.sessionId !== 'string' || !ID.test(input.sessionId)) throw new Error('语音会话编号不合法');
    if (!['audio/ogg', 'audio/webm', 'audio/wav', 'audio/mp4'].includes(String(input.mime))) throw new Error('实时语音格式不支持');
    if (input.sampleRate !== undefined && (!Number.isInteger(input.sampleRate) || input.sampleRate < 8_000 || input.sampleRate > 96_000)) throw new Error('语音采样率不合法');
    return input as VoiceSessionStart;
}

export function validateVoiceSessionChunk(value: unknown): VoiceSessionChunk {
    if (!value || typeof value !== 'object') throw new Error('语音分片不合法');
    const input = value as Partial<VoiceSessionChunk>;
    if (typeof input.sessionId !== 'string' || !ID.test(input.sessionId)) throw new Error('语音会话编号不合法');
    if (!Number.isInteger(input.sequence) || input.sequence! < 0 || input.sequence! > 1_000_000) throw new Error('语音分片序号不合法');
    if (typeof input.data !== 'string' || !input.data || input.data.length > Math.ceil(MAX_VOICE_CHUNK_BYTES * 4 / 3) + 4 || !BASE64.test(input.data)) throw new Error('语音分片内容不合法');
    const bytes = Buffer.from(input.data, 'base64').byteLength;
    if (!bytes || bytes > MAX_VOICE_CHUNK_BYTES) throw new Error('语音分片过大');
    return input as VoiceSessionChunk;
}

export function validateVoiceSessionStop(value: unknown): VoiceSessionStop {
    if (!value || typeof value !== 'object') throw new Error('语音会话结束信息不合法');
    const input = value as Partial<VoiceSessionStop>;
    if (typeof input.sessionId !== 'string' || !ID.test(input.sessionId)) throw new Error('语音会话编号不合法');
    if (!Number.isInteger(input.lastSequence) || input.lastSequence! < -1 || input.lastSequence! > 1_000_000) throw new Error('语音会话结束序号不合法');
    return input as VoiceSessionStop;
}

export function validateVoiceSessionCancel(value: unknown): VoiceSessionCancel {
    if (!value || typeof value !== 'object') throw new Error('语音会话取消信息不合法');
    const input = value as Partial<VoiceSessionCancel>;
    if (typeof input.sessionId !== 'string' || !ID.test(input.sessionId)) throw new Error('语音会话编号不合法');
    if (input.reason !== undefined && !['user', 'interrupted', 'network'].includes(input.reason)) throw new Error('语音会话取消原因不合法');
    return input as VoiceSessionCancel;
}

interface ActiveVoiceSession { next: number; bytes: number; startedAt: number }

/** 服务端分片顺序闸；不做转写，也不赋予手机动作权限。 */
export class VoiceSessionGate {
    readonly #active = new Map<string, ActiveVoiceSession>();
    start(clientId: string, body: VoiceSessionStart, now = Date.now()): void {
        validateVoiceSessionStart(body);
        const key = `${clientId}\0${body.sessionId}`;
        if (this.#active.has(key)) throw new Error('语音会话已经开始');
        this.#active.set(key, { next: 0, bytes: 0, startedAt: now });
    }
    chunk(clientId: string, body: VoiceSessionChunk, now = Date.now()): number {
        validateVoiceSessionChunk(body);
        const key = `${clientId}\0${body.sessionId}`;
        const state = this.#active.get(key);
        if (!state) throw new Error('语音会话不存在');
        if (now - state.startedAt > MAX_VOICE_SESSION_MS) { this.#active.delete(key); throw new Error('语音会话已超时'); }
        if (body.sequence !== state.next) throw new Error('语音分片顺序不连续');
        const bytes = Buffer.from(body.data, 'base64').byteLength;
        if (state.bytes + bytes > MAX_VOICE_SESSION_BYTES) { this.#active.delete(key); throw new Error('语音会话过大'); }
        state.next++;
        state.bytes += bytes;
        return bytes;
    }
    stop(clientId: string, body: VoiceSessionStop): number {
        validateVoiceSessionStop(body);
        const key = `${clientId}\0${body.sessionId}`;
        const state = this.#active.get(key);
        if (!state) throw new Error('语音会话不存在');
        if (body.lastSequence !== state.next - 1) throw new Error('语音会话缺少分片');
        this.#active.delete(key);
        return state.bytes;
    }
    cancel(clientId: string, body: VoiceSessionCancel): boolean {
        validateVoiceSessionCancel(body);
        return this.#active.delete(`${clientId}\0${body.sessionId}`);
    }
    reset(): void { this.#active.clear(); }
}
