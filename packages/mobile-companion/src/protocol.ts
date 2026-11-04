/**
 * Android-first 手机伴侣协议（ADR 0224）。
 *
 * 这是传输无关的契约：Android 可以用 WebSocket / HTTPS，QQ 和本地设备服务
 * 仍然复用现有的安全边界。协议只描述对话媒体和受控设备动作，不提供 shell。
 */

import { validatePhotoReviewDecisionRequest, validatePhotoReviewDecisionResult, validatePhotoReviewListRequest, validatePhotoReviewListResult } from './photo-review.ts';

export const PROTOCOL_VERSION = 1;
export const MAX_TEXT_CHARS = 4000;
export const MAX_MEDIA_BYTES = 8 * 1024 * 1024;
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
export const MAX_ACTION_PARAMS = 32;
export const MAX_ACTION_PARAM_CHARS = 512;

export type MessageKind = 'text' | 'audio' | 'image' | 'sticker';

export interface MediaRef {
    /** 只允许 https 或已经建立会话的短期 media id；不接受 file:// / 任意本地路径。 */
    url?: string;
    mediaId?: string;
    mime: string;
    bytes: number;
    durationMs?: number;
    width?: number;
    height?: number;
}

export interface CompanionMessage {
    kind: MessageKind;
    text?: string;
    media?: MediaRef;
    /** 图片表情只允许由服务端返回的 catalog id 发送。 */
    stickerId?: string;
}

export type PhoneAction = 'notify' | 'timer' | 'ring' | 'open_link' | 'media_control' | 'volume';
export type ActionDecision = 'auto' | 'confirm' | 'deny';

/** 能力清单是协议、宿主审计和控制台展示共用的唯一动作描述。 */
export interface PhoneActionCapability {
    action: PhoneAction;
    defaultDecision: Exclude<ActionDecision, 'deny'>;
    requiresConfirmation: boolean;
    reversible: boolean;
    description: string;
}

export const PHONE_ACTION_CAPABILITIES: readonly PhoneActionCapability[] = [
    { action: 'notify', defaultDecision: 'auto', requiresConfirmation: false, reversible: true, description: '显示一条通知' },
    { action: 'timer', defaultDecision: 'auto', requiresConfirmation: false, reversible: true, description: '创建一个计时器' },
    { action: 'ring', defaultDecision: 'confirm', requiresConfirmation: true, reversible: true, description: '让手机响铃一小段时间' },
    { action: 'open_link', defaultDecision: 'confirm', requiresConfirmation: true, reversible: true, description: '打开白名单里的 HTTPS 链接' },
    { action: 'media_control', defaultDecision: 'confirm', requiresConfirmation: true, reversible: true, description: '控制正在播放的媒体' },
    { action: 'volume', defaultDecision: 'confirm', requiresConfirmation: true, reversible: true, description: '调整媒体音量' },
];

export interface PhoneActionRequest {
    action: PhoneAction;
    /** 由服务端白名单生成；客户端不能自行拼接任意 URL / 命令。 */
    targetId?: string;
    params: Record<string, string | number>;
    decision: ActionDecision;
    reason?: string;
}

export interface CompanionEnvelope<T = unknown> {
    v: typeof PROTOCOL_VERSION;
    requestId: string;
    kind: 'hello' | 'message.send' | 'message.receive' | 'action.request' | 'action.result'
        | 'photo.review.list' | 'photo.review.list.result' | 'photo.review.decide' | 'photo.review.decision'
        | 'error';
    sentAt: string;
    nonce: string;
    body: T;
}

/** 首次配对时由网关生成、通过二维码 / 一次性链接交给手机的短期凭证。 */
export interface CompanionHello {
    clientId: string;
    pairingCode: string;
    capabilities: readonly MessageKind[];
}

export interface ActionResult {
    requestId: string;
    ok: boolean;
    decision: ActionDecision;
    error?: string;
}

export interface CompanionError {
    code: string;
    message: string;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
const MIME = /^[\w.+-]+\/[\w.+-]+$/;
export const ALLOWED_MEDIA_MIMES = [
    'image/jpeg', 'image/png', 'image/webp', 'image/gif',
    'audio/ogg', 'audio/mpeg', 'audio/wav', 'audio/webm', 'audio/mp4',
] as const;
const ALLOWED_MEDIA_MIME_SET = new Set<string>(ALLOWED_MEDIA_MIMES);

export function isAllowedMediaMime(value: string): boolean {
    return ALLOWED_MEDIA_MIME_SET.has(value.trim().toLowerCase());
}
const MEDIA_ID = /^[a-f0-9]{16,128}$/i;
const PAIRING_CODE = /^[A-Z0-9][A-Z0-9-]{7,63}$/;
const ALLOWED_ACTIONS = new Set<PhoneAction>(PHONE_ACTION_CAPABILITIES.map(capability => capability.action));

export function isPhoneAction(value: unknown): value is PhoneAction {
    return typeof value === 'string' && ALLOWED_ACTIONS.has(value as PhoneAction);
}

export function validateMessage(value: unknown): CompanionMessage {
    if (!value || typeof value !== 'object') throw new Error('消息不是对象');
    const input = value as Partial<CompanionMessage>;
    if (!['text', 'audio', 'image', 'sticker'].includes(String(input.kind))) throw new Error('不支持的消息类型');
    if (input.text !== undefined && (typeof input.text !== 'string' || [...input.text].length > MAX_TEXT_CHARS)) throw new Error('文字过长');
    if (input.kind === 'text' && !input.text?.trim()) throw new Error('文字消息不能为空');
    if (input.kind === 'sticker' && (!input.stickerId || !MEDIA_ID.test(input.stickerId))) throw new Error('表情包必须使用服务端 catalog id');
    if (input.kind !== 'text') {
        const media = validateMedia(input.media);
        const mime = media.mime.toLowerCase();
        if (input.kind === 'audio' && !mime.startsWith('audio/')) throw new Error('语音消息必须使用 audio MIME');
        if ((input.kind === 'image' || input.kind === 'sticker') && !mime.startsWith('image/')) throw new Error('图片消息必须使用 image MIME');
    }
    return input as CompanionMessage;
}

export function validateMedia(value: unknown): MediaRef {
    if (!value || typeof value !== 'object') throw new Error('媒体消息缺少 media');
    const media = value as Partial<MediaRef>;
    if (!MIME.test(String(media.mime)) || !isAllowedMediaMime(String(media.mime))) throw new Error('媒体类型不在允许列表');
    if (!Number.isInteger(media.bytes) || media.bytes! < 1 || media.bytes! > MAX_MEDIA_BYTES) throw new Error('媒体大小超出限制');
    if (Boolean(media.url) === Boolean(media.mediaId)) throw new Error('媒体引用必须在 https URL 和 mediaId 之间二选一');
    if (media.url) {
        if (!/^https:\/\//i.test(media.url) || media.url.length > 2048) throw new Error('媒体 URL 只允许 https');
        try {
            const url = new URL(media.url);
            // URL 中的账号密码会在日志、代理或错误信息里意外暴露凭据。
            if (url.username || url.password) throw new Error('媒体 URL 不允许携带账号密码');
        } catch (error) {
            if (error instanceof Error && error.message === '媒体 URL 不允许携带账号密码') throw error;
            throw new Error('媒体 URL 只允许 https');
        }
    }
    if (media.mediaId && !MEDIA_ID.test(media.mediaId)) throw new Error('mediaId 不合法');
    if (media.durationMs !== undefined && (!Number.isInteger(media.durationMs) || media.durationMs < 0 || media.durationMs > 2 * 60 * 60_000)) throw new Error('媒体时长不合法');
    if (media.width !== undefined && (!Number.isInteger(media.width) || media.width < 1 || media.width > 8192)) throw new Error('媒体宽度不合法');
    if (media.height !== undefined && (!Number.isInteger(media.height) || media.height < 1 || media.height > 8192)) throw new Error('媒体高度不合法');
    return media as MediaRef;
}

export function validateAction(value: unknown): PhoneActionRequest {
    if (!value || typeof value !== 'object') throw new Error('动作不是对象');
    const action = value as Partial<PhoneActionRequest>;
    if (!isPhoneAction(action.action)) throw new Error('手机动作不在白名单');
    if (!action.params || typeof action.params !== 'object' || Array.isArray(action.params)) throw new Error('动作参数不合法');
    const params = action.params as Record<string, unknown>;
    const keys = Object.keys(params);
    if (keys.length > MAX_ACTION_PARAMS) throw new Error('动作参数过多');
    for (const key of keys) {
        if (!/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(key)) throw new Error('动作参数名不合法');
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') throw new Error('动作参数名不合法');
        const item = params[key];
        if (typeof item === 'string') {
            if ([...item].length > MAX_ACTION_PARAM_CHARS) throw new Error('动作参数过长');
        } else if (typeof item === 'number') {
            if (!Number.isFinite(item)) throw new Error('动作参数数字不合法');
        } else {
            throw new Error('动作参数值不合法');
        }
    }
    if (action.targetId !== undefined && (typeof action.targetId !== 'string' || !ID.test(action.targetId))) throw new Error('targetId 不合法');
    if (action.action === 'open_link' && action.targetId === undefined) throw new Error('打开链接必须使用已登记的 targetId');
    if (action.action === 'open_link' && Object.hasOwn(params, 'url')) throw new Error('打开链接不能直接携带 URL');
    if (action.reason !== undefined && (typeof action.reason !== 'string' || [...action.reason].length > 500)) throw new Error('动作理由不合法');
    if (!['auto', 'confirm', 'deny'].includes(String(action.decision))) throw new Error('动作决策不合法');
    const defaultDecision = PHONE_ACTION_CAPABILITIES.find(capability => capability.action === action.action)!.defaultDecision;
    if (defaultDecision === 'confirm' && action.decision === 'auto') throw new Error('敏感动作不能降级为自动执行');
    return action as PhoneActionRequest;
}

export function validateEnvelope(value: unknown, now = Date.now()): CompanionEnvelope {
    if (!value || typeof value !== 'object') throw new Error('协议包不是对象');
    const envelope = value as Partial<CompanionEnvelope>;
    if (envelope.v !== PROTOCOL_VERSION || typeof envelope.requestId !== 'string' || !ID.test(envelope.requestId)) throw new Error('协议版本或 requestId 不合法');
    if (typeof envelope.nonce !== 'string' || !ID.test(envelope.nonce)) throw new Error('nonce 不合法');
    const sentAt = Date.parse(String(envelope.sentAt));
    if (!Number.isFinite(sentAt) || Math.abs(now - sentAt) > MAX_CLOCK_SKEW_MS) throw new Error('请求时间超出允许偏差');
    if (!['hello', 'message.send', 'message.receive', 'action.request', 'action.result', 'photo.review.list', 'photo.review.list.result', 'photo.review.decide', 'photo.review.decision', 'error'].includes(String(envelope.kind))) throw new Error('未知协议消息');
    switch (envelope.kind) {
        case 'hello': validateHello(envelope.body); break;
        case 'message.send':
        case 'message.receive': validateMessage(envelope.body); break;
        case 'action.request': validateAction(envelope.body); break;
        case 'action.result': validateActionResult(envelope.body); break;
        case 'photo.review.list': validatePhotoReviewListRequest(envelope.body); break;
        case 'photo.review.list.result': validatePhotoReviewListResult(envelope.body); break;
        case 'photo.review.decide': validatePhotoReviewDecisionRequest(envelope.body); break;
        case 'photo.review.decision': validatePhotoReviewDecisionResult(envelope.body); break;
        case 'error': validateError(envelope.body); break;
    }
    return envelope as CompanionEnvelope;
}

export function validateActionResult(value: unknown): ActionResult {
    if (!value || typeof value !== 'object') throw new Error('动作结果不是对象');
    const result = value as Partial<ActionResult>;
    if (typeof result.requestId !== 'string' || !ID.test(result.requestId)) throw new Error('动作结果 requestId 不合法');
    if (typeof result.ok !== 'boolean') throw new Error('动作结果 ok 不合法');
    if (!['auto', 'confirm', 'deny'].includes(String(result.decision))) throw new Error('动作结果决策不合法');
    if (result.error !== undefined && (typeof result.error !== 'string' || [...result.error].length > 500)) throw new Error('动作结果错误信息不合法');
    return result as ActionResult;
}

export function validateError(value: unknown): CompanionError {
    if (!value || typeof value !== 'object') throw new Error('错误信息不是对象');
    const error = value as Partial<CompanionError>;
    if (typeof error.code !== 'string' || !ID.test(error.code)) throw new Error('错误码不合法');
    if (typeof error.message !== 'string' || !error.message.trim() || [...error.message].length > 500) throw new Error('错误信息不合法');
    return error as CompanionError;
}

export function validateHello(value: unknown): CompanionHello {
    if (!value || typeof value !== 'object') throw new Error('配对信息不是对象');
    const hello = value as Partial<CompanionHello>;
    if (typeof hello.clientId !== 'string' || !ID.test(hello.clientId)) throw new Error('clientId 不合法');
    if (typeof hello.pairingCode !== 'string' || !PAIRING_CODE.test(hello.pairingCode)) throw new Error('配对码不合法');
    if (!Array.isArray(hello.capabilities) || hello.capabilities.length === 0 || hello.capabilities.length > 4 || hello.capabilities.some(item => !['text', 'audio', 'image', 'sticker'].includes(String(item))) || new Set(hello.capabilities).size !== hello.capabilities.length) {
        throw new Error('能力列表不合法');
    }
    return { clientId: hello.clientId, pairingCode: hello.pairingCode, capabilities: hello.capabilities as MessageKind[] };
}

/** 客户端展示用的安全摘要：不把 token、URL 查询串或本地路径写入日志。 */
export function auditLabel(kind: CompanionEnvelope['kind'], body: unknown): string {
    if (kind === 'message.send' || kind === 'message.receive') {
        const message = validateMessage(body);
        return `message:${message.kind}`;
    }
    if (kind === 'action.request') return `action:${validateAction(body).action}`;
    if (kind === 'photo.review.list') return 'photo-review:list';
    if (kind === 'photo.review.decide') return `photo-review:${validatePhotoReviewDecisionRequest(body).decision}`;
    return kind;
}
