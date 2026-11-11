import type { ConversationState, LedgerEvent, Message, PendingMessage, PersistedMeta, ServerFrame } from './types.d.ts';

export const TYPING_TTL_MS: number;

export function createState(meta?: Partial<PersistedMeta>, messages?: Message[], pending?: PendingMessage[]): ConversationState;
export function toMeta(state: ConversationState): PersistedMeta;

/** 应用中继发来的一帧。消息按 seq 排序、按 seq 和 clientId 去重；ack 把本地气泡换成入账的那条。 */
export function applyFrame(state: ConversationState, frame: ServerFrame, now: number): ConversationState;
export function applyEvent(state: ConversationState, event: LedgerEvent, seq: number): ConversationState;
export function applyHistory(state: ConversationState, page: { messages: Message[]; events: { seq: number; event: LedgerEvent }[] }): ConversationState;
export function prependLocal(state: ConversationState, messages: Message[]): ConversationState;
export function disconnected(state: ConversationState): ConversationState;
export function expireTyping(state: ConversationState, now: number): ConversationState;

export function addPending(state: ConversationState, pending: PendingMessage): ConversationState;
export function uploadProgress(state: ConversationState, clientId: string, progress: number): ConversationState;
export function uploadDone(state: ConversationState, clientId: string, mediaId: string): ConversationState;
export function failPending(state: ConversationState, clientId: string, error: string): ConversationState;
export function retryPending(state: ConversationState, clientId: string): ConversationState;
export function removePending(state: ConversationState, clientId: string): ConversationState;
export function sendable(state: ConversationState): PendingMessage[];

export function markSeen(state: ConversationState, seq: number): ConversationState;
export function unreadCount(state: ConversationState): number;
export function isRecalled(state: ConversationState, message: Message): boolean;
export function findById(state: ConversationState, id: number): Message | undefined;
export function oldestSeq(state: ConversationState): number;
/** 补发有缺口时丢掉本地更早的记录（之后从 /api/history 重新取） */
export function dropBefore(state: ConversationState, seq: number): ConversationState;
export function hasReplayGap(since: number, firstSeq: number): boolean;
export function trimOldest(state: ConversationState, keep: number): ConversationState;
