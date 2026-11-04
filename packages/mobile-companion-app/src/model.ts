import { CompanionClient } from '@qqbot/mobile-companion/client';
import { actionNeedsConfirmation } from '@qqbot/mobile-companion/action-policy';
import { validateMessage, type CompanionMessage, type MessageKind, type PhoneAction, type PhoneActionRequest } from '@qqbot/mobile-companion/protocol';

export interface CompanionAppOptions {
    clientId: string;
    pairingCode: string;
    now?: () => number;
    nonce?: () => string;
}

export interface ConversationItem {
    direction: 'in' | 'out' | 'system';
    message: CompanionMessage | string;
    at: number;
}

/** PWA / 原生 Android 都可以复用的 UI 状态层；不持有 socket，也不保存配对码。 */
export class CompanionAppModel {
    readonly client: CompanionClient;
    readonly conversation: ConversationItem[] = [];
    private readonly now: () => number;

    constructor(options: CompanionAppOptions) {
        this.client = new CompanionClient({
            clientId: options.clientId,
            pairingCode: options.pairingCode,
            capabilities: ['text', 'audio', 'image', 'sticker'],
            ...(options.now ? { now: options.now } : {}),
            ...(options.nonce ? { nonce: options.nonce } : {}),
        });
        this.now = options.now ?? Date.now;
    }

    hello() {
        return this.client.hello();
    }

    text(text: string) {
        return this.outgoing({ kind: 'text', text });
    }

    media(kind: Extract<MessageKind, 'audio' | 'image'>, media: CompanionMessage['media'], text?: string) {
        return this.outgoing({ kind, media, ...(text ? { text } : {}) });
    }

    sticker(stickerId: string, media: NonNullable<CompanionMessage['media']>, text?: string) {
        return this.outgoing({ kind: 'sticker', stickerId, media, ...(text ? { text } : {}) });
    }

    action(action: PhoneAction, params: Record<string, string | number>, reason = '', targetId?: string): { request: ReturnType<CompanionClient['requestAction']>; needsConfirmation: boolean } {
        const needsConfirmation = actionNeedsConfirmation(action);
        const request: PhoneActionRequest = { action, params, decision: needsConfirmation ? 'confirm' : 'auto', ...(targetId ? { targetId } : {}), ...(reason ? { reason } : {}) };
        return { request: this.client.requestAction(request), needsConfirmation };
    }

    accept(value: unknown) {
        const response = this.client.accept(value);
        if (response.kind === 'message.receive') this.conversation.push({ direction: 'in', message: response.body as CompanionMessage, at: this.now() });
        return response;
    }

    /** 接收宿主主动下发的白名单动作；具体确认 / 执行仍由 UI 层决定。 */
    acceptDownlink(value: unknown) {
        return this.client.acceptDownlink(value);
    }

    reset(): void {
        this.client.reset();
        this.conversation.length = 0;
    }

    private outgoing(message: CompanionMessage) {
        const body = validateMessage(message);
        const envelope = this.client.sendMessage(body);
        this.conversation.push({ direction: 'out', message: body, at: this.now() });
        return envelope;
    }
}
