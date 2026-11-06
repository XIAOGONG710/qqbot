import { createDshCompanionHandlers, type DshSharedConversation } from '@qqbot/mobile-companion/dsh-adapter';
import { CompanionGateway } from '@qqbot/mobile-companion/gateway';
import { MemoryPairingStore, type PairingTicket } from '@qqbot/mobile-companion/pairing';
import type { CompanionRuntimeHandlers } from '@qqbot/mobile-companion/runtime';
import { CompanionRuntime } from '@qqbot/mobile-companion/runtime';
import { MemoryCompanionMediaStore } from '@qqbot/mobile-companion/media';
import { PHONE_ACTION_CAPABILITIES, type ActionResult, type CompanionMessage, type PhoneActionCapability, type PhoneActionRequest } from '@qqbot/mobile-companion/protocol';
import type { PhotoReviewDecisionRequest, PhotoReviewDecisionResult, PhotoReviewListRequest, PhotoReviewListResult } from '@qqbot/mobile-companion/photo-review';
import { withBufferedVoiceConversation } from '@qqbot/mobile-companion/voice-conversation';
import type { VoiceSessionStart } from '@qqbot/mobile-companion/voice-session';
import type { DshConversationTurn, DshLink, DshState, DshVoice } from './dsh-link.ts';

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
        ...(options.onActionResult ? { onActionResult: options.onActionResult } : {}),
        ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
        ...(options.maxClients === undefined ? {} : { maxClients: options.maxClients }),
        ...(options.sharedConversation ? { sharedConversation: options.sharedConversation } : {}),
        ...(options.now ? { now: options.now } : {}),
    });
    const combined = {
        ...handlers,
        ...(options.onPhotoReviewList ? { onPhotoReviewList: options.onPhotoReviewList } : {}),
        ...(options.onPhotoReviewDecision ? { onPhotoReviewDecision: options.onPhotoReviewDecision } : {}),
    };
    return options.transcribeVoice
        ? withBufferedVoiceConversation(combined, { transcribe: options.transcribeVoice })
        : combined;
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
    const runtime = new CompanionRuntime(gateway, createMobileDshHandlers(options), options.now);
    const media = new MemoryCompanionMediaStore({ now: options.now });
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
        },
        stop: () => {
            if (stopped) return runtime.stop();
            stopped = true;
            pairing.stop();
            media.stop();
            return runtime.stop();
        },
    };
}
