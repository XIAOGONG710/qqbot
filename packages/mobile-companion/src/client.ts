import { randomBytes } from 'node:crypto';
import { helloEnvelope } from './gateway.ts';
import { MAX_CLOCK_SKEW_MS, validateAction, validateEnvelope, validateMessage, type ActionResult, type CompanionEnvelope, type CompanionError, type CompanionHello, type CompanionMessage, type PhoneActionRequest } from './protocol.ts';
import { validatePhotoReviewDecisionRequest, validatePhotoReviewListRequest, type PhotoReviewDecisionRequest, type PhotoReviewDecisionResult, type PhotoReviewListRequest, type PhotoReviewListResult } from './photo-review.ts';

export const MAX_CLIENT_PENDING = 32;
const MAX_TRACKED_IDS = 256;
const SESSION_ID_PATTERN = /^[A-Za-z0-9._:-]{6,128}$/;

export interface CompanionClientOptions {
    clientId: string;
    pairingCode: string;
    capabilities: readonly CompanionHello['capabilities'][number][];
    now?: () => number;
    nonce?: () => string;
}

/**
 * 可移植的客户端状态机：Android / Flutter 只需把生成的 envelope 交给网络层。
 * 它不持有 socket，也不把 token、媒体文件或系统权限放进协议对象。
 */
export class CompanionClient {
    private readonly clientId: string;
    private readonly pairingCode: string;
    private readonly capabilities: CompanionHello['capabilities'];
    private readonly now: () => number;
    private readonly nonce: () => string;
    private readonly pending = new Set<string>();
    private readonly usedRequestIds = new Set<string>();
    private readonly sentNonces = new Set<string>();
    private readonly receivedNonces = new Map<string, number>();
    private sessionId: string | undefined;

    constructor(options: CompanionClientOptions) {
        this.clientId = options.clientId;
        this.pairingCode = options.pairingCode;
        this.capabilities = [...options.capabilities];
        this.now = options.now ?? Date.now;
        this.nonce = options.nonce ?? (() => `client-${randomBytes(12).toString('hex')}`);
    }

    hello(requestId = this.newRequestId('hello')): CompanionEnvelope<CompanionHello> {
        this.reserveRequestId(requestId);
        const envelope = helloEnvelope({ clientId: this.clientId, pairingCode: this.pairingCode, capabilities: this.capabilities }, requestId, this.nextNonce(), new Date(this.now()).toISOString());
        validateEnvelope(envelope, this.now());
        return envelope;
    }

    sendMessage(message: CompanionMessage, requestId = this.newRequestId('message')): CompanionEnvelope<CompanionMessage> {
        const body = validateMessage(message);
        if (this.pending.size >= MAX_CLIENT_PENDING) throw new Error('待处理请求过多，请等待已有请求完成');
        this.reserveRequestId(requestId);
        const envelope = this.envelope('message.send', body, requestId);
        this.pending.add(requestId);
        return envelope;
    }

    requestAction(action: PhoneActionRequest, requestId = this.newRequestId('action')): CompanionEnvelope<PhoneActionRequest> {
        const body = validateAction(action);
        if (this.pending.size >= MAX_CLIENT_PENDING) throw new Error('待处理请求过多，请等待已有请求完成');
        this.reserveRequestId(requestId);
        const envelope = this.envelope('action.request', body, requestId);
        this.pending.add(requestId);
        return envelope;
    }

    listPhotoDrafts(request: PhotoReviewListRequest = {}, requestId = this.newRequestId('photo-list')): CompanionEnvelope<PhotoReviewListRequest> {
        const body = validatePhotoReviewListRequest(request);
        if (this.pending.size >= MAX_CLIENT_PENDING) throw new Error('待处理请求过多，请等待已有请求完成');
        this.reserveRequestId(requestId);
        const envelope = this.envelope('photo.review.list', body, requestId);
        this.pending.add(requestId);
        return envelope;
    }

    decidePhotoDraft(request: PhotoReviewDecisionRequest, requestId = this.newRequestId('photo-decision')): CompanionEnvelope<PhotoReviewDecisionRequest> {
        const body = validatePhotoReviewDecisionRequest(request);
        if (this.pending.size >= MAX_CLIENT_PENDING) throw new Error('待处理请求过多，请等待已有请求完成');
        this.reserveRequestId(requestId);
        const envelope = this.envelope('photo.review.decide', body, requestId);
        this.pending.add(requestId);
        return envelope;
    }

    accept(value: unknown): CompanionEnvelope<CompanionMessage | ActionResult | PhotoReviewListResult | PhotoReviewDecisionResult | CompanionError> {
        const now = this.now();
        const envelope = validateEnvelope(value, now);
        if (!['message.receive', 'action.result', 'photo.review.list.result', 'photo.review.decision', 'error'].includes(envelope.kind)) throw new Error('客户端不接受此类响应');
        const requestId = envelope.requestId.startsWith('resp-') ? envelope.requestId.slice(5) : envelope.requestId;
        if (!this.pending.has(requestId)) throw new Error('响应没有对应的请求');
        rememberReceived(this.receivedNonces, envelope.nonce, now);
        this.pending.delete(requestId);
        return envelope as CompanionEnvelope<CompanionMessage | ActionResult | PhotoReviewListResult | PhotoReviewDecisionResult | CompanionError>;
    }

    /** 接收宿主主动下发的白名单动作；它不占用客户端 pending requestId。 */
    acceptDownlink(value: unknown): CompanionEnvelope<PhoneActionRequest> {
        const now = this.now();
        const envelope = validateEnvelope(value, now);
        if (envelope.kind !== 'action.request') throw new Error('客户端只接受 action.request 下行包');
        rememberReceived(this.receivedNonces, envelope.nonce, now);
        return envelope as CompanionEnvelope<PhoneActionRequest>;
    }

    get pendingCount(): number {
        return this.pending.size;
    }

    /**
     * HTTP 传输层应把 hello 响应的 `x-companion-session` 保存到这里，
     * 并在后续请求中原样回传；WebSocket 由服务端按连接自动绑定，不需要设置。
     */
    get transportSessionId(): string | undefined {
        return this.sessionId;
    }

    setTransportSession(value: string): void {
        if (!SESSION_ID_PATTERN.test(value)) throw new Error('连接会话标识不合法');
        this.sessionId = value;
    }

    clearTransportSession(): void {
        this.sessionId = undefined;
    }

    /** 本地注销 / 切换设备时清空旧会话状态；不会把配对码写入磁盘。 */
    reset(): void {
        this.pending.clear();
        this.sentNonces.clear();
        this.receivedNonces.clear();
        this.usedRequestIds.clear();
        this.sessionId = undefined;
    }

    private envelope<T>(kind: CompanionEnvelope['kind'], body: T, requestId: string): CompanionEnvelope<T> {
        const envelope = { v: 1 as const, requestId, kind, sentAt: new Date(this.now()).toISOString(), nonce: this.nextNonce(), body } as CompanionEnvelope<T>;
        validateEnvelope(envelope, this.now());
        return envelope;
    }

    private nextNonce(): string {
        for (let attempt = 0; attempt < 4; attempt += 1) {
            const value = this.nonce();
            if (!this.sentNonces.has(value)) { remember(this.sentNonces, value); return value; }
        }
        throw new Error('nonce 生成器重复返回');
    }

    private newRequestId(prefix: string): string {
        return `${prefix}-${randomBytes(8).toString('hex')}`;
    }

    private reserveRequestId(requestId: string): void {
        if (this.usedRequestIds.has(requestId)) throw new Error('requestId 已经使用');
        remember(this.usedRequestIds, requestId);
    }
}

function remember(set: Set<string>, value: string): void {
    set.add(value);
    if (set.size > MAX_TRACKED_IDS) set.delete(set.values().next().value!);
}

function rememberReceived(nonces: Map<string, number>, value: string, now: number): void {
    // 只淘汰协议时钟窗口外的记录；按条数淘汰会让攻击者挤掉合法 nonce 后重放旧动作。
    for (const [nonce, acceptedAt] of nonces) {
        const age = now - acceptedAt;
        if (age > MAX_CLOCK_SKEW_MS) nonces.delete(nonce);
        else if (age < -MAX_CLOCK_SKEW_MS) throw new Error('响应防重放时钟异常，请重新连接');
    }
    if (nonces.has(value)) throw new Error('响应 nonce 已经使用');
    // 窗口内流量过高时失败关闭，避免降低防重放保障或让内存无限增长。
    if (nonces.size >= MAX_TRACKED_IDS) throw new Error('响应防重放窗口已满，请重新连接');
    nonces.set(value, now);
}
