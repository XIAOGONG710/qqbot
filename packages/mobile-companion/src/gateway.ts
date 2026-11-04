import { MAX_CLOCK_SKEW_MS, validateEnvelope, validateHello, validateMessage, type CompanionEnvelope, type CompanionHello, type MessageKind } from './protocol.ts';

const MAX_NONCES_PER_SESSION = 4_096;

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
    private capabilities = new Set<MessageKind>();
    private readonly nonces = new Map<string, number>();
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
        // 状态页本身也必须反映空闲 TTL；不能等下一次媒体上传或 envelope 才把“已连接”改掉。
        this.expireIdleSession(this.now());
        return Boolean(this.clientId && this.sessionId);
    }

    clientForSession(sessionId: string): string | undefined {
        if (this.sessionId !== sessionId) return undefined;
        const now = this.now();
        // HTTP 媒体上传不会经过 accept()，所以查询会话归属时也必须执行同一份空闲 TTL 检查。
        if (this.sessionExpired(now)) {
            this.expireSession();
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
        this.capabilities.clear();
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
                this.assertNonceAvailable(envelope.nonce, now);
                if (!this.pairing.consume(hello.clientId, hello.pairingCode, now)) throw new Error('配对码无效、过期或已使用');
                this.clientId = hello.clientId;
                this.sessionId = sessionId;
                this.capabilities = new Set(hello.capabilities);
                this.lastSeenAt = now;
                this.nonces.set(envelope.nonce, now);
                return { ok: true, clientId: hello.clientId, kind: envelope.kind };
            }
            if (!this.clientId) throw new Error('设备尚未配对');
            if (this.sessionExpired(now)) {
                this.expireSession();
                throw new Error('连接会话已过期，请重新配对');
            }
            if (this.sessionId !== sessionId) throw new Error('连接尚未完成配对');
            if (envelope.kind === 'message.send') {
                const message = validateMessage(envelope.body);
                if (!this.capabilities.has(message.kind)) throw new Error(`设备未声明 ${message.kind} 消息能力`);
            }
            this.assertNonceAvailable(envelope.nonce, now);
            this.nonces.set(envelope.nonce, now);
            this.lastSeenAt = now;
            return { ok: true, clientId: this.clientId, kind: envelope.kind };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
    }

    private expireIdleSession(now: number): void {
        if (this.sessionExpired(now)) this.expireSession();
    }

    private sessionExpired(now: number): boolean {
        if (!this.sessionId || !this.lastSeenAt) return false;
        const age = now - this.lastSeenAt;
        // 小幅校时沿用协议允许的偏差；明显回拨则失败关闭，避免会话寿命被无限延长。
        return age >= this.sessionIdleTtlMs || age < -MAX_CLOCK_SKEW_MS;
    }

    private expireSession(): void {
        this.sessionId = undefined;
        this.lastSeenAt = 0;
        this.nonces.clear();
    }

    private assertNonceAvailable(nonce: string, now: number): void {
        // nonce 必须覆盖完整的协议时钟偏差窗口；按条数淘汰会让高频设备在窗口内重新接受旧请求。
        for (const [seenNonce, acceptedAt] of this.nonces) {
            if (now - acceptedAt > MAX_CLOCK_SKEW_MS) this.nonces.delete(seenNonce);
        }
        if (this.nonces.has(nonce)) throw new Error('nonce 已经使用');
        // 攻击流量也不能让防重放表无限增长。满载时失败关闭，等待旧记录自然过期或重新配对。
        if (this.nonces.size >= MAX_NONCES_PER_SESSION) throw new Error('nonce 防重放窗口已满，请稍后重试或重新配对');
    }
}

export function helloEnvelope(body: CompanionHello, requestId: string, nonce: string, sentAt = new Date().toISOString()): CompanionEnvelope<CompanionHello> {
    return { v: 1, requestId, kind: 'hello', sentAt, nonce, body };
}
