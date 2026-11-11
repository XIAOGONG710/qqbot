// ADR 0337 第 4 节的线上形状（中继 ↔ 手机），以及 OneBot 这一侧用到的最小形状。

export type Part =
    | { kind: 'text'; text: string }
    | { kind: 'face'; id: number; name?: string }
    | { kind: 'image'; mediaId: string; mime: string; summary?: string }
    | { kind: 'voice'; mediaId: string; mime: string; durationMs?: number }
    | { kind: 'card'; title: string; url?: string }
    | { kind: 'poke' };

export interface Message {
    /** 消息账里的序号，单调递增；消息和事件共用一条序列 */
    seq: number;
    /** OneBot 消息 id */
    id: number;
    from: 'her' | 'me';
    via: 'app' | 'qq';
    /** 毫秒 */
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

/** OneBot 11 消息段 */
export interface Segment {
    type: string;
    data: Record<string, unknown>;
}

/** OneBot 11 动作的响应（不含 echo；echo 由收发两头各自加回去） */
export interface OneBotResponse {
    status: string;
    retcode: number;
    data: unknown;
    [key: string]: unknown;
}

export type DeliveryRule = 'last-active' | 'both';
export type Clock = () => number;
export type Log = (line: string) => void;

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
