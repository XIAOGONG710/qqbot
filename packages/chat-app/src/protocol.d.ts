import type { ClientFrame, Credentials, LedgerEvent, Message, Part, ServerFrame } from './types.d.ts';

export const MAX_FRAME_BYTES: number;
export const MAX_MEDIA_BYTES: number;
export const MAX_TEXT_CHARS: number;
export const HISTORY_PAGE: number;
export const IMAGE_MIMES: readonly string[];
export const AUDIO_MIMES: readonly string[];

/** 校验并收拢成协议里的形状；不认识或不完整的返回 undefined。 */
export function parsePart(value: unknown): Part | undefined;
export function parseMessage(value: unknown): Message | undefined;
export function parseEvent(value: unknown): LedgerEvent | undefined;
/** 解析中继发来的一帧（JSON 文本或已解析的对象）。 */
export function parseServerFrame(raw: unknown): ServerFrame | undefined;
/** `/api/history` 的响应：events 同时接受 `{seq,event}` 和摊平的 `{seq,kind,…}`。 */
export function parseHistory(value: unknown): { messages: Message[]; events: { seq: number; event: LedgerEvent }[] };

export function helloFrame(credentials: Credentials, since: number): ClientFrame;
export function sendFrame(clientId: string, parts: Part[], replyTo?: number): ClientFrame;
export function recallFrame(id: number): ClientFrame;
export function pokeFrame(): ClientFrame;
export function pingFrame(): ClientFrame;
/** 序列化；超过单帧上限时抛 RangeError。 */
export function encodeFrame(frame: ClientFrame): string;
export function frameBytes(frame: ClientFrame): number;

/** `Bearer <deviceId>.<token>` */
export function authorization(credentials: Credentials): string;
export function historyPath(before: number, limit?: number): string;
export function mediaPath(mediaId: string): string;
/** 去掉 `;codecs=…`，并确认是协议允许上传的类型；不允许返回 undefined。 */
export function uploadMime(mime: string): string | undefined;
/** 只有 https 链接可以点。 */
export function safeHttpsUrl(url: unknown): string | undefined;
export function isCredentials(value: unknown): value is Credentials;
