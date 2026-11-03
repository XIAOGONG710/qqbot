import { validateEnvelope, validateHello, type CompanionEnvelope, type CompanionHello } from './protocol.ts';

export interface PairingVerifier {
    /** 消费一次性配对码；成功后该码不得再次使用。 */
    consume(clientId: string, pairingCode: string, now: number): boolean;
}

export interface CompanionGatewayOptions {
    /** HTTPS 没有 close 事件，超过该时间未收到包就允许同一设备重新建会话。 */
    sessionIdleTtlMs?: number;
}

export type GatewayAccept =
    | { ok: true; clientId: string; kind: CompanionEnvelope['kind'] }
    | { ok: false; error: string };

/**
 * 传输无关的会话闸门：WebSocket、HTTPS 和 Android UI 都复用同一套配对 / replay 防护。
 * 它不执行动作，只决定协议包是否可以进入后续业务层。
 */
export class CompanionGateway {
    private clientId: string | undefined;
    private sessionId: string | undefined;
    private readonly nonces = new Set<string>();
    private readonly now: () => number;
    private readonly pairing: PairingVerifier;
    private readonly sessionIdleTtlMs: number;
    private lastSeenAt = 0;

    constructor(pairing: PairingVerifier, now: () => number = Date.now, options: CompanionGatewayOptions = {}) {
        this.pairing = pairing;
        this.now = now;
        const ttl = options.sessionIdleTtlMs ?? 30 * 60_000;
        if (!Number.isInteger(ttl) || ttl < 60_000 || ttl > 7 * 24 * 60 * 60_000) throw new Error('连接会话空闲 TTL 必须在 1 分钟到 7 天之间');
        this.sessionIdleTtlMs = ttl;
    }

    get pairedClientId(): string | undefined {
        return this.clientId;
    }

    get connected(): boolean {
        return Boolean(this.clientId && this.sessionId);
    }

    clientForSession(sessionId: string): string | undefined {
        if (this.sessionId !== sessionId) return undefined;
        const now = this.now();
        // HTTP 媒体上传不会经过 accept()，所以查询会话归属时也必须执行同一份空闲 TTL 检查。
        if (this.lastSeenAt && now - this.lastSeenAt >= this.sessionIdleTtlMs) {
            this.sessionId = undefined;
            this.lastSeenAt = 0;
            this.nonces.clear();
            return undefined;
        }
        // HTTPS 的动作轮询 / 媒体上传没有 envelope 可供 accept() 更新活跃时间；
        // 通过同一 session 的成功访问本身就是活动，避免正常轮询 30 分钟后被误踢。
        this.lastSeenAt = now;
        return this.clientId;
    }

    /** 撤销当前会话；宿主关闭伴侣开关或更换设备时调用。 */
    reset(): void {
        this.clientId = undefined;
        this.sessionId = undefined;
        this.lastSeenAt = 0;
        this.nonces.clear();
    }

    /** 释放已断开的传输连接，但保留设备身份，允许用新的配对码重新建立连接。 */
    releaseSession(sessionId: string): boolean {
        if (this.sessionId !== sessionId) return false;
        this.sessionId = undefined;
        this.lastSeenAt = 0;
        this.nonces.clear();
        return true;
    }

    accept(value: unknown, sessionId = 'default'): GatewayAccept {
        const now = this.now();
        try {
            if (!/^[A-Za-z0-9._:-]{6,128}$/.test(sessionId)) throw new Error('连接会话标识不合法');
            const envelope = validateEnvelope(value, now);
            if (envelope.kind === 'hello') {
                const hello = validateHello(envelope.body);
                if (this.clientId && this.clientId !== hello.clientId) throw new Error('会话已经绑定另一台设备');
                this.expireIdleSession(now);
                if (this.sessionId && this.sessionId !== sessionId) throw new Error('会话已经绑定另一条连接');
                if (this.nonces.has(envelope.nonce)) throw new Error('nonce 已经使用');
                if (!this.pairing.consume(hello.clientId, hello.pairingCode, now)) throw new Error('配对码无效、过期或已使用');
                this.clientId = hello.clientId;
                this.sessionId = sessionId;
                this.lastSeenAt = now;
                this.nonces.add(envelope.nonce);
                return { ok: true, clientId: hello.clientId, kind: envelope.kind };
            }
            if (!this.clientId) throw new Error('设备尚未配对');
            if (this.lastSeenAt && now - this.lastSeenAt >= this.sessionIdleTtlMs) throw new Error('连接会话已过期，请重新配对');
            if (this.sessionId !== sessionId) throw new Error('连接尚未完成配对');
            if (this.nonces.has(envelope.nonce)) throw new Error('nonce 已经使用');
            this.nonces.add(envelope.nonce);
            this.lastSeenAt = now;
            // 只保留最近一小段 nonce，避免长连接运行数日后内存无限增长。
            if (this.nonces.size > 256) this.nonces.delete(this.nonces.values().next().value!);
            return { ok: true, clientId: this.clientId, kind: envelope.kind };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    private expireIdleSession(now: number): void {
        if (this.sessionId && this.lastSeenAt && now - this.lastSeenAt >= this.sessionIdleTtlMs) {
            this.sessionId = undefined;
            this.lastSeenAt = 0;
            this.nonces.clear();
        }
    }
}

export function helloEnvelope(body: CompanionHello, requestId: string, nonce: string, sentAt = new Date().toISOString()): CompanionEnvelope<CompanionHello> {
    return { v: 1, requestId, kind: 'hello', sentAt, nonce, body };
}
