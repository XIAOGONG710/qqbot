import type { ConversationState, Part, PendingStatus } from './types.d.ts';

export const STAMP_GAP_MS: number;
export const GROUP_GAP_MS: number;

export interface StampRow { type: 'stamp'; key: string; at: number; label: string; /** 这一条开始了新的一天 */ day: boolean }
export interface UnreadRow { type: 'unread'; key: 'unread' }
export interface NoticeRow { type: 'notice'; key: string; text: string; seq?: number; id?: number }
export interface BubbleRow {
    type: 'bubble';
    key: string;
    mine: boolean;
    seq?: number;
    id?: number;
    clientId?: string;
    at: number;
    parts: Part[];
    /** 一组连发里的第一条 / 最后一条 */
    first: boolean;
    last: boolean;
    status: 'none' | 'sent' | 'read' | PendingStatus;
    showStatus: boolean;
    error?: string;
    progress?: number;
    localId?: string;
    reactions: number[];
    reply?: { id: number; found: boolean; mine: boolean; text: string };
    viaQq: boolean;
}
export type Row = StampRow | UnreadRow | NoticeRow | BubbleRow;

export function buildTimeline(state: ConversationState, options: { now: number; unreadAfter?: number }): Row[];
export function rowSignature(row: Row): string;
export function statusText(row: BubbleRow): string;
