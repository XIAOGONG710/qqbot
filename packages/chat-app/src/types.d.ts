/** ADR 0337 第 4 节的线上形状，以及 App 自己的本地状态。 */

export type Part =
    | { kind: 'text'; text: string }
    | { kind: 'face'; id: number; name?: string }
    | { kind: 'image'; mediaId: string; mime: string; summary?: string }
    | { kind: 'voice'; mediaId: string; mime: string; durationMs?: number }
    | { kind: 'card'; title: string; url?: string }
    | { kind: 'poke' };

export interface Message {
    seq: number;
    id: number;
    from: 'her' | 'me';
    via: 'app' | 'qq';
    at: number;
    parts: Part[];
    replyTo?: number;
    clientId?: string;
    recalled?: true;
}

export type LedgerEvent =
    | { kind: 'recall'; id: number }
    | { kind: 'read'; upTo: number }
    | { kind: 'reaction'; id: number; emojiId: number };

export type UpstreamState = 'up' | 'down';
export type ErrorCode = 'unauthorized' | 'bad_request' | 'too_large' | 'rate_limited' | 'not_delivered';

export type ServerFrame =
    | { type: 'ready'; seq: number; self: { name: string }; upstream: UpstreamState }
    | { type: 'message'; message: Message }
    | { type: 'event'; seq: number; event: LedgerEvent }
    | { type: 'ack'; clientId: string; id: number; seq: number }
    | { type: 'typing'; on: boolean }
    | { type: 'upstream'; state: UpstreamState }
    | { type: 'pong' }
    | { type: 'error'; code: ErrorCode; message: string; clientId?: string };

export type ClientFrame =
    | { type: 'hello'; deviceId: string; token: string; since: number }
    | { type: 'send'; clientId: string; parts: Part[]; replyTo?: number }
    | { type: 'recall'; id: number }
    | { type: 'poke' }
    | { type: 'ping' };

export interface Credentials {
    deviceId: string;
    token: string;
}

/** 还没上传完的图片 / 语音：文件本身由界面层按 localId 保管，状态里只有描述。 */
export interface PendingUpload {
    localId: string;
    kind: 'image' | 'voice';
    mime: string;
    /** 0..1 */
    progress: number;
}

export type PendingStatus = 'uploading' | 'sending' | 'failed';

/** 本地先画出来、还没被中继确认的那条。 */
export interface PendingMessage {
    clientId: string;
    at: number;
    parts: Part[];
    replyTo?: number;
    status: PendingStatus;
    /** 失败原因（给人看的中文） */
    error?: string;
    upload?: PendingUpload;
}

export interface ConversationState {
    /** 已入账的消息，按 seq 升序，seq 不重复 */
    messages: Message[];
    pending: PendingMessage[];
    /** 见过的最大 seq（消息和事件共用），断线重连时当作 since */
    maxSeq: number;
    /** 她已读到的位置（seq） */
    readSeq: number;
    /** 被撤回的消息 id */
    recalled: Record<string, true>;
    /** 消息 id → 表情回应 */
    reactions: Record<string, number[]>;
    typing: boolean;
    typingAt: number;
    upstream: UpstreamState | 'unknown';
    selfName: string;
    /** 这次连接已经补齐（收到过 ready） */
    synced: boolean;
    /** 往前已经翻到头 */
    historyDone: boolean;
    /** 他看到过的最大 seq，用来画「以下是新消息」 */
    lastSeenSeq: number;
}

/** 可以存进 IndexedDB 的那部分（不含消息本体和连接状态）。 */
export interface PersistedMeta {
    maxSeq: number;
    readSeq: number;
    recalled: Record<string, true>;
    reactions: Record<string, number[]>;
    selfName: string;
    lastSeenSeq: number;
    historyDone: boolean;
}
