import { createDshCompanionHandlers, type DshSharedConversation } from '@qqbot/mobile-companion/dsh-adapter';
import { CompanionGateway } from '@qqbot/mobile-companion/gateway';
import { MemoryPairingStore, type PairingTicket } from '@qqbot/mobile-companion/pairing';
import type { CompanionRuntimeHandlers } from '@qqbot/mobile-companion/runtime';
import { CompanionRuntime } from '@qqbot/mobile-companion/runtime';
import { MemoryCompanionMediaStore } from '@qqbot/mobile-companion/media';
import { PHONE_ACTION_CAPABILITIES, type ActionResult, type CompanionMessage, type PhoneActionCapability, type PhoneActionRequest } from '@qqbot/mobile-companion/protocol';
import { PHOTO_REVIEW_MAX_ITEMS, PHOTO_REVIEW_MAX_THUMBNAIL_BYTES, type PhotoDraftSummary, type PhotoReviewDecisionRequest, type PhotoReviewDecisionResult, type PhotoReviewListRequest, type PhotoReviewListResult } from '@qqbot/mobile-companion/photo-review';
import { withBufferedVoiceConversation } from '@qqbot/mobile-companion/voice-conversation';
import type { VoiceSessionStart } from '@qqbot/mobile-companion/voice-session';
import type { DshConversationTurn, DshLink, DshState, DshVoice } from './dsh-link.ts';
import { aiPhotoDraftFreshness, type AiPhotoDraftStore } from './vision/ai-photo-drafts.ts';

export interface MobileCompanionIntegration {
    pairing: MemoryPairingStore;
    gateway: CompanionGateway;
    runtime: CompanionRuntime;
    media: MemoryCompanionMediaStore;
    actionCapabilities: readonly PhoneActionCapability[];
    issuePairing(clientId: string, now?: number): PairingTicket;
    /** 解除全部待配对票据、当前会话、队列、设备本地上下文和媒体；宿主共享的跨端上下文不在此处删除。 */
    reset(): void;
    stop(): Promise<void> | undefined;
}

/** 让手机伴侣复用 QQ 侧同一条 DSH 连接、状态摘要和角色语气。 */
export function createMobileDshHandlers(options: {
    dsh: Pick<DshLink, 'advise'>;
    state?: (clientId: string) => DshState | undefined;
    voice?: (clientId: string) => DshVoice | undefined;
    describeMedia?: (message: CompanionMessage, clientId: string) => Promise<string | undefined>;
    onAction?: (request: PhoneActionRequest, clientId: string, requestId: string) => Promise<ActionResult>;
    maxTurns?: number;
    maxClients?: number;
    sharedConversation?: DshSharedConversation;
    now?: () => number;
    onActionResult?: (result: ActionResult, clientId: string) => Promise<void>;
    onPhotoReviewList?: (request: PhotoReviewListRequest, clientId: string) => Promise<PhotoReviewListResult>;
    onPhotoReviewDecision?: (request: PhotoReviewDecisionRequest, clientId: string, requestId: string) => Promise<PhotoReviewDecisionResult>;
    transcribeVoice?: (data: Uint8Array, mime: VoiceSessionStart['mime'], clientId: string) => Promise<string>;
}): CompanionRuntimeHandlers {
    const handlers = createDshCompanionHandlers<DshState, DshVoice>({
        advisor: {
            advise: (request: { question: string; state?: DshState; recentTurns?: readonly DshConversationTurn[]; voice?: DshVoice }) => options.dsh.advise(request),
        },
        ...(options.state ? { state: options.state } : {}),
        ...(options.voice ? { voice: options.voice } : {}),
        ...(options.describeMedia ? { describeMedia: options.describeMedia } : {}),
        ...(options.onAction ? { onAction: options.onAction } : {}),
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
        ...(options.maxClients === undefined ? {} : { maxClients: options.maxClients }),
        ...(options.sharedConversation ? { sharedConversation: options.sharedConversation } : {}),
        ...(options.now ? { now: options.now } : {}),
    });
    const combined = {
        ...handlers,
        // DSH 适配器只管消息和手机发起的动作；宿主下发动作的回执审计要挂在运行时这一层，
        // 之前混在适配器选项里被静默丢掉，手机回执一律报「宿主未接入手机动作回执」。
        ...(options.onActionResult ? { onActionResult: options.onActionResult } : {}),
        ...(options.onPhotoReviewList ? { onPhotoReviewList: options.onPhotoReviewList } : {}),
        ...(options.onPhotoReviewDecision ? { onPhotoReviewDecision: options.onPhotoReviewDecision } : {}),
    };
    return options.transcribeVoice
        ? withBufferedVoiceConversation(combined, { transcribe: options.transcribeVoice })
        : combined;
}

/**
 * 一次照片审核列表最多给几条做缩略图。缩略图和手机上传的图片 / 语音共用每设备媒体配额（默认 16 条，满了淘汰最早放的）：
 * 以前每条草稿都放一张（默认 20 条），最新几条的缩略图在返回之前就被挤掉，手机刚传、还没发出去的媒体也一起没了。
 */
export const PHOTO_REVIEW_THUMBNAILS = 8;

/**
 * 照片审核列表（ADR 0245）：最新在前，只给最新 {@link PHOTO_REVIEW_THUMBNAILS} 条做缩略图，其余照样列出、不带缩略图；
 * 放新的之前先收回这台设备上一次列表留下的缩略图，反复刷新也不占满配额。
 */
export function photoReviewLister(options: {
    drafts: Pick<AiPhotoDraftStore, 'list' | 'preview'>;
    media: Pick<MemoryCompanionMediaStore, 'put' | 'discard'>;
    now?: () => number;
}): { list(request: PhotoReviewListRequest, clientId: string): Promise<PhotoReviewListResult>; forget(): void } {
    const issued = new Map<string, string[]>();
    return {
        list: async (request, clientId) => {
            for (const mediaId of issued.get(clientId) ?? []) options.media.discard(clientId, mediaId);
            issued.delete(clientId);
            const thumbnails: string[] = [];
            const at = new Date(options.now?.() ?? Date.now());
            const matching = options.drafts.list(request.status);
            const items = matching.slice(-Math.min(request.limit ?? 20, PHOTO_REVIEW_MAX_ITEMS)).reverse().map((entry, index): PhotoDraftSummary => {
                let thumbnail: PhotoDraftSummary['thumbnail'];
                if (index < PHOTO_REVIEW_THUMBNAILS) try {
                    const preview = options.drafts.preview(entry.id);
                    if (preview.bytes.length <= PHOTO_REVIEW_MAX_THUMBNAIL_BYTES) {
                        const record = options.media.put({ clientId, mime: preview.type, data: Buffer.from(preview.bytes), bytes: preview.bytes.length });
                        thumbnails.push(record.mediaId);
                        thumbnail = { mediaId: record.mediaId, mime: preview.type, bytes: record.bytes };
                    }
                } catch { /* 文件异常时只不给预览；审核动作仍会再次失败关闭。 */ }
                return {
                    id: entry.id, kind: entry.kind, status: entry.status, caption: entry.caption,
                    createdAt: entry.createdAt, expiresAt: aiPhotoDraftFreshness(entry, at).expiresAt,
                    ...(entry.reviewedAt ? { reviewedAt: entry.reviewedAt } : {}),
                    ...(thumbnail ? { thumbnail } : {}),
                };
            });
            if (thumbnails.length) issued.set(clientId, thumbnails);
            return { items, total: matching.length };
        },
        forget: () => issued.clear(),
    };
}

/** 在 bot 进程内把手机伴侣真正接到 DSH；传输层仍由宿主选择 HTTPS 或 WebSocket。 */
export function createMobileCompanion(options: {
    dsh: Pick<DshLink, 'advise'>;
    state?: (clientId: string) => DshState | undefined;
    voice?: (clientId: string) => DshVoice | undefined;
    describeMedia?: (message: CompanionMessage, clientId: string) => Promise<string | undefined>;
    onAction?: (request: PhoneActionRequest, clientId: string, requestId: string) => Promise<ActionResult>;
    onActionResult?: (result: ActionResult, clientId: string) => Promise<void>;
    onPhotoReviewList?: (request: PhotoReviewListRequest, clientId: string) => Promise<PhotoReviewListResult>;
    /** 给了就由这里列照片草稿（缩略图放进本伴侣的媒体仓，见 photoReviewLister），不再用 onPhotoReviewList。 */
    photoDrafts?: Pick<AiPhotoDraftStore, 'list' | 'preview'>;
    onPhotoReviewDecision?: (request: PhotoReviewDecisionRequest, clientId: string, requestId: string) => Promise<PhotoReviewDecisionResult>;
    transcribeVoice?: (data: Uint8Array, mime: VoiceSessionStart['mime'], clientId: string) => Promise<string>;
    maxTurns?: number;
    maxClients?: number;
    sharedConversation?: DshSharedConversation;
    pairingTtlMs?: number;
    sessionIdleTtlMs?: number;
    now?: () => number;
}): MobileCompanionIntegration {
    const pairing = new MemoryPairingStore(options.pairingTtlMs);
    const gateway = new CompanionGateway(pairing, options.now, options.sessionIdleTtlMs === undefined ? {} : { sessionIdleTtlMs: options.sessionIdleTtlMs });
    const media = new MemoryCompanionMediaStore({ now: options.now });
    const lister = options.photoDrafts ? photoReviewLister({ drafts: options.photoDrafts, media, ...(options.now ? { now: options.now } : {}) }) : undefined;
    const runtime = new CompanionRuntime(gateway, createMobileDshHandlers(lister ? { ...options, onPhotoReviewList: lister.list } : options), options.now);
    const issuedClients = new Set<string>();
    let stopped = false;
    return {
        pairing,
        gateway,
        runtime,
        media,
        actionCapabilities: PHONE_ACTION_CAPABILITIES,
        issuePairing: (clientId, now = options.now?.() ?? Date.now()) => {
            if (stopped) throw new Error('手机伴侣已经停止');
            const ticket = pairing.issue(clientId, now);
            issuedClients.add(clientId);
            return ticket;
        },
        reset: () => {
            // 兼容尚未带 clear() 的旧伴侣包：已知票据逐张撤销，升级后则一次清空。
            const clear = (pairing as MemoryPairingStore & { clear?: () => number }).clear;
            if (clear) clear.call(pairing);
            else for (const clientId of issuedClients) pairing.revoke(clientId);
            issuedClients.clear();
            runtime.reset();
            media.clear();
            lister?.forget();
        },
        stop: () => {
            if (stopped) return runtime.stop();
            stopped = true;
            pairing.stop();
            media.stop();
            lister?.forget();
            return runtime.stop();
        },
    };
}
