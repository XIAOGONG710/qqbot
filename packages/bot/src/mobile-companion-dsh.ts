import { createDshCompanionHandlers } from '@qqbot/mobile-companion/dsh-adapter';
import { CompanionGateway } from '@qqbot/mobile-companion/gateway';
import { MemoryPairingStore, type PairingTicket } from '@qqbot/mobile-companion/pairing';
import type { CompanionRuntimeHandlers } from '@qqbot/mobile-companion/runtime';
import { CompanionRuntime } from '@qqbot/mobile-companion/runtime';
import { MemoryCompanionMediaStore } from '@qqbot/mobile-companion/media';
import { PHONE_ACTION_CAPABILITIES, type ActionResult, type CompanionMessage, type PhoneActionCapability, type PhoneActionRequest } from '@qqbot/mobile-companion/protocol';
import type { DshConversationTurn, DshLink, DshState, DshVoice } from './dsh-link.ts';

export interface MobileCompanionIntegration {
    pairing: MemoryPairingStore;
    gateway: CompanionGateway;
    runtime: CompanionRuntime;
    media: MemoryCompanionMediaStore;
    actionCapabilities: readonly PhoneActionCapability[];
    issuePairing(clientId: string, now?: number): PairingTicket;
    /** 解除全部待配对票据、当前会话、队列、短期上下文和媒体。 */
    reset(): void;
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
    onActionResult?: (result: ActionResult, clientId: string) => Promise<void>;
}): CompanionRuntimeHandlers {
    return createDshCompanionHandlers<DshState, DshVoice>({
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
    });
}

/** 在 bot 进程内把手机伴侣真正接到 DSH；传输层仍由宿主选择 HTTPS 或 WebSocket。 */
export function createMobileCompanion(options: {
    dsh: Pick<DshLink, 'advise'>;
    state?: (clientId: string) => DshState | undefined;
    voice?: (clientId: string) => DshVoice | undefined;
    describeMedia?: (message: CompanionMessage, clientId: string) => Promise<string | undefined>;
    onAction?: (request: PhoneActionRequest, clientId: string, requestId: string) => Promise<ActionResult>;
    onActionResult?: (result: ActionResult, clientId: string) => Promise<void>;
    maxTurns?: number;
    maxClients?: number;
    pairingTtlMs?: number;
    sessionIdleTtlMs?: number;
    now?: () => number;
}): MobileCompanionIntegration {
    const pairing = new MemoryPairingStore(options.pairingTtlMs);
    const gateway = new CompanionGateway(pairing, options.now, options.sessionIdleTtlMs === undefined ? {} : { sessionIdleTtlMs: options.sessionIdleTtlMs });
    const runtime = new CompanionRuntime(gateway, createMobileDshHandlers(options), options.now);
    const media = new MemoryCompanionMediaStore({ now: options.now });
    const issuedClients = new Set<string>();
    return {
        pairing,
        gateway,
        runtime,
        media,
        actionCapabilities: PHONE_ACTION_CAPABILITIES,
        issuePairing: (clientId, now = options.now?.() ?? Date.now()) => {
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
    };
}
