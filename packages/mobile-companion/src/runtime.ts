import { randomBytes } from 'node:crypto';
import { CompanionGateway } from './gateway.ts';
import { MAX_CLOCK_SKEW_MS, validateAction, validateActionResult, validateEnvelope, validateMessage, type ActionResult, type CompanionEnvelope, type CompanionError, type CompanionMessage, type PhoneActionRequest } from './protocol.ts';
import { validatePhotoReviewDecisionRequest, validatePhotoReviewDecisionResult, validatePhotoReviewListRequest, validatePhotoReviewListResult, type PhotoReviewDecisionRequest, type PhotoReviewDecisionResult, type PhotoReviewListRequest, type PhotoReviewListResult } from './photo-review.ts';
import { VoiceSessionGate, validateVoiceSessionCancel, validateVoiceSessionChunk, validateVoiceSessionStart, validateVoiceSessionStop, type VoiceSessionCancel, type VoiceSessionChunk, type VoiceSessionStart, type VoiceSessionStop } from './voice-session.ts';

export const MAX_QUEUED_PER_CLIENT = 32;
export const MAX_DOWNLINK_ACTIONS = 16;
export const DOWNLINK_ACTION_TTL_MS = 5 * 60_000;
export const UPLINK_REQUEST_TTL_MS = 5 * 60_000;
export const MAX_UPLINK_REQUESTS_PER_CLIENT = 64;

export type CompanionDownlinkListener = (clientId: string, envelope: CompanionEnvelope<PhoneActionRequest>) => void;

export interface CompanionRuntimeHandlers {
    onMessage: (message: CompanionMessage, clientId: string, signal?: AbortSignal) => Promise<CompanionMessage>;
    onAction: (request: PhoneActionRequest, clientId: string, requestId: string, signal?: AbortSignal) => Promise<ActionResult>;
    onActionResult?: (result: ActionResult, clientId: string, signal?: AbortSignal) => Promise<void>;
    /** 只返回安全摘要和短期缩略图 mediaId；宿主不能直接返回草稿索引对象。 */
    onPhotoReviewList?: (request: PhotoReviewListRequest, clientId: string) => Promise<PhotoReviewListResult>;
    /** 宿主在此回调内完成状态修改和审计；抛错时保留同 requestId 的重试能力。 */
    onPhotoReviewDecision?: (request: PhotoReviewDecisionRequest, clientId: string, requestId: string) => Promise<PhotoReviewDecisionResult>;
    onVoiceSessionStart?: (request: VoiceSessionStart, clientId: string) => Promise<void>;
    onVoiceSessionChunk?: (request: VoiceSessionChunk, bytes: Uint8Array, clientId: string) => Promise<void>;
    /** 停止录音后宿主可返回转写并生成的回复；没有回复时只确认收完。 */
    onVoiceSessionStop?: (request: VoiceSessionStop, totalBytes: number, clientId: string) => Promise<CompanionMessage | void>;
    onVoiceSessionCancel?: (request: VoiceSessionCancel, clientId: string) => Promise<void>;
    /** 配对撤销时清理宿主侧按设备保存的短期上下文。 */
    onReset?: (clientId?: string) => void;
}

export type CompanionRuntimeResult =
    | { accepted: false; error: string }
    | { accepted: true; response?: CompanionEnvelope };

export interface CompanionRuntimeStatus {
    pairedClientId?: string;
    connected: boolean;
    queued: number;
    maxQueuedPerClient: number;
}

interface PendingDownlinkResult {
    issuedAt: number;
    decision: PhoneActionRequest['decision'];
}

interface CompletedUplinkRequest {
    completedAt: number;
    fingerprint: string;
    result: CompanionRuntimeResult;
}

/**
 * 协议业务层：不监听端口、不执行动作，只把已通过网关的 envelope 分派给宿主。
 * 因此 QQ、WebSocket、HTTPS 和 Android UI 可以共享相同的消息/动作语义。
 */
export class CompanionRuntime {
    private readonly gateway: CompanionGateway;
    private readonly handlers: CompanionRuntimeHandlers;
    private readonly now: () => number;
    private readonly queues = new Map<string, Promise<void>>();
    private readonly queueDepth = new Map<string, number>();
    private readonly downlinks = new Map<string, CompanionEnvelope<PhoneActionRequest>[]>();
    private readonly pendingDownlinkResults = new Map<string, Map<string, PendingDownlinkResult>>();
    private readonly completedUplinkRequests = new Map<string, Map<string, CompletedUplinkRequest>>();
    private readonly downlinkListeners = new Set<CompanionDownlinkListener>();
    private readonly voiceSessions = new VoiceSessionGate();
    private readonly lifetime = new AbortController();
    private readonly operations = new Set<Promise<CompanionRuntimeResult>>();
    private stopped = false;
    private stopDrain: Promise<void> | undefined;
    private queueGeneration = 0;

    constructor(gateway: CompanionGateway, handlers: CompanionRuntimeHandlers, now: () => number = Date.now) {
        this.gateway = gateway;
        this.handlers = handlers;
        this.now = now;
    }

    status(): CompanionRuntimeStatus {
        return {
            ...(this.gateway.pairedClientId ? { pairedClientId: this.gateway.pairedClientId } : {}),
            connected: this.gateway.connected,
            queued: [...this.queueDepth.values()].reduce((sum, value) => sum + value, 0),
            maxQueuedPerClient: MAX_QUEUED_PER_CLIENT,
        };
    }

    createSession(): string {
        // 运输适配器可能在宿主停止后仍被旧 HTTP/WS 路由调用。
        // 仍返回一个不入库的随机标识，让 handle() 统一安全拒绝，不向路由回调抛同步异常。
        return `session-${randomBytes(18).toString('hex')}`;
    }

    releaseSession(sessionId: string): boolean {
        if (this.stopped) return false;
        return this.gateway.releaseSession(sessionId);
    }

    /**
     * 永久关闭当前运行时。纯读取处理器可通过 signal 立即退出；已经派发的动作则由
     * 宿主自然确认，返回的 drain 会在这些工作全部收尾后完成。
     */
    stop(): Promise<void> | undefined {
        if (this.stopped) return this.stopDrain;
        this.stopped = true;
        this.lifetime.abort(new Error('手机伴侣已经停止'));
        this.reset();
        this.downlinkListeners.clear();
        const pending = [...this.operations];
        if (!pending.length) return undefined;
        this.stopDrain = Promise.allSettled(pending).then(() => undefined);
        return this.stopDrain;
    }

    /** 撤销配对时同时清空所有尚未下发的手机动作，避免旧动作跨会话残留。 */
    reset(): void {
        this.gateway.reset();
        this.downlinks.clear();
        this.pendingDownlinkResults.clear();
        this.completedUplinkRequests.clear();
        // 撤销配对是一个硬边界：不再让旧设备的排队深度继续出现在状态页。
        // 已经进入宿主的旧请求仍会自然结束，但不会阻塞新配对后的队列。
        this.queueGeneration++;
        this.queues.clear();
        this.queueDepth.clear();
        this.voiceSessions.reset();
        this.handlers.onReset?.();
    }

    clientForSession(sessionId: string): string | undefined {
        if (this.stopped) return undefined;
        return this.gateway.clientForSession(sessionId);
    }

    /**
     * 由宿主显式调用，向已配对手机下发一个受协议校验的白名单动作。
     * 这里只排队和发送 envelope，不执行任何系统权限；手机端仍需按 decision 决定是否确认。
     */
    requestPhoneAction(clientId: string, request: PhoneActionRequest, requestId = `push-${randomBytes(8).toString('hex')}`): CompanionEnvelope<PhoneActionRequest> {
        if (this.stopped) throw new Error('手机伴侣已经停止');
        if (this.gateway.pairedClientId !== clientId) throw new Error('设备尚未配对');
        const body = validateAction(request);
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/.test(requestId)) throw new Error('动作 requestId 不合法');
        const { queue, pending } = this.pruneDownlinks(clientId);
        if (queue.length >= MAX_DOWNLINK_ACTIONS) throw new Error('手机动作待发送队列已满');
        if (pending.size >= MAX_DOWNLINK_ACTIONS) throw new Error('手机动作等待回执过多');
        if (pending.has(requestId)) throw new Error('动作 requestId 已存在');
        const issuedAt = this.now();
        const envelope: CompanionEnvelope<PhoneActionRequest> = {
            v: 1,
            requestId,
            kind: 'action.request',
            sentAt: new Date(issuedAt).toISOString(),
            nonce: `push-${randomBytes(12).toString('hex')}`,
            body,
        };
        queue.push(envelope);
        this.downlinks.set(clientId, queue);
        pending.set(requestId, { issuedAt, decision: body.decision });
        this.pendingDownlinkResults.set(clientId, pending);
        // 监听器只是实时推送优化；某个传输已经断开或宿主观察器抛错时，
        // 不能让动作创建对外失败，否则调用方可能重试并产生重复动作。
        for (const listener of this.downlinkListeners) {
            try { listener(clientId, envelope); } catch { /* 轮询仍可取出同一个下行动作 */ }
        }
        return envelope;
    }

    subscribeDownlinks(listener: CompanionDownlinkListener): () => void {
        if (this.stopped) return () => undefined;
        this.downlinkListeners.add(listener);
        return () => this.downlinkListeners.delete(listener);
    }

    takeDownlinks(clientId: string, limit = MAX_DOWNLINK_ACTIONS): CompanionEnvelope<PhoneActionRequest>[] {
        if (!Number.isInteger(limit) || limit < 1 || limit > MAX_DOWNLINK_ACTIONS) throw new Error('手机动作取出数量不合法');
        if (this.stopped) return [];
        const { queue } = this.pruneDownlinks(clientId);
        const result = queue.splice(0, limit);
        if (queue.length) this.downlinks.set(clientId, queue);
        else this.downlinks.delete(clientId);
        return result;
    }

    private pruneDownlinks(clientId: string): { queue: CompanionEnvelope<PhoneActionRequest>[]; pending: Map<string, PendingDownlinkResult> } {
        const now = this.now();
        const pending = this.pendingDownlinkResults.get(clientId) ?? new Map<string, PendingDownlinkResult>();
        for (const [requestId, item] of pending) {
            if (downlinkExpired(item, now)) pending.delete(requestId);
        }
        if (pending.size) this.pendingDownlinkResults.set(clientId, pending);
        else this.pendingDownlinkResults.delete(clientId);
        // pending 是动作回执的唯一凭据；过期动作不能再下发，否则手机回执必然被拒绝。
        const queue = (this.downlinks.get(clientId) ?? []).filter(envelope => pending.has(envelope.requestId));
        if (queue.length) this.downlinks.set(clientId, queue);
        else this.downlinks.delete(clientId);
        return { queue, pending };
    }

    async handle(value: unknown, sessionId = 'default'): Promise<CompanionRuntimeResult> {
        if (this.stopped) return { accepted: false, error: '手机伴侣已经停止' };
        // 背压是可重试状态，不能先让网关消耗 nonce，否则队列恢复后同一请求会被误判成重放。
        // 这里只预检协议允许的手机上行类型；无效包、伪造响应和未配对会话仍交给网关按原规则拒绝。
        try {
            const envelope = validateEnvelope(value, this.now());
            if (envelope.kind === 'message.send' || envelope.kind === 'action.request' || envelope.kind === 'action.result' || envelope.kind === 'photo.review.list' || envelope.kind === 'photo.review.decide' || envelope.kind.startsWith('voice.session.')) {
                const clientId = this.gateway.clientForSession(sessionId);
                if (clientId && (this.queueDepth.get(clientId) ?? 0) >= MAX_QUEUED_PER_CLIENT) {
                    return { accepted: false, error: '设备请求过多，请稍后重试' };
                }
            }
        } catch {
            // gateway.accept() 负责返回统一且可审计的校验错误。
        }
        const accepted = this.gateway.accept(value, sessionId);
        if (!accepted.ok) return { accepted: false, error: accepted.error };
        const operation = this.handleAccepted(value, accepted.clientId);
        this.operations.add(operation);
        try { return await operation; }
        finally { this.operations.delete(operation); }
    }

    private async handleAccepted(value: unknown, clientId: string): Promise<CompanionRuntimeResult> {
        const generation = this.queueGeneration;
        const depth = this.queueDepth.get(clientId) ?? 0;
        if (depth >= MAX_QUEUED_PER_CLIENT) return { accepted: false, error: '设备请求过多，请稍后重试' };
        this.queueDepth.set(clientId, depth + 1);
        const previous = this.queues.get(clientId) ?? Promise.resolve();
        let release!: () => void;
        const current = new Promise<void>(resolve => { release = resolve; });
        this.queues.set(clientId, current);
        await previous.catch(() => undefined);
        try {
            // 请求虽然已经通过认证，但仍可能在同设备队列里等待。解绑 / 关闭伴侣是硬边界：
            // reset 之后尚未开始的旧消息和动作不能再进入宿主处理器。
            if (generation !== this.queueGeneration) {
                return { accepted: false, error: '设备配对已失效，请重新配对' };
            }
            if (this.stopped) return { accepted: false, error: '手机伴侣已经停止' };
            const result = await this.dispatch(value, clientId);
            return this.stopped ? { accepted: false, error: '手机伴侣已经停止' } : result;
        } finally {
            release();
            // reset() 后旧请求仍可能完成；它不能触碰新配对建立的队列映射。
            if (generation === this.queueGeneration) {
                if (this.queues.get(clientId) === current) this.queues.delete(clientId);
                const remaining = (this.queueDepth.get(clientId) ?? 1) - 1;
                if (remaining > 0) this.queueDepth.set(clientId, remaining);
                else this.queueDepth.delete(clientId);
            }
        }
    }

    private async dispatch(value: unknown, clientId: string): Promise<CompanionRuntimeResult> {
        let requestId = 'runtime';
        let fingerprint: string | undefined;
        let rememberError = false;
        try {
            const envelope = validateEnvelope(value, this.now());
            requestId = envelope.requestId;
            if (!['hello', 'message.send', 'action.request', 'action.result', 'photo.review.list', 'photo.review.decide', 'voice.session.start', 'voice.session.chunk', 'voice.session.stop', 'voice.session.cancel'].includes(envelope.kind)) throw new Error('客户端不能发送此类响应包');
            const idempotent = envelope.kind === 'message.send' || envelope.kind === 'action.request' || envelope.kind === 'photo.review.list' || envelope.kind === 'photo.review.decide';
            fingerprint = idempotent ? canonicalRequest(envelope.kind, envelope.body) : undefined;
            if (fingerprint) {
                const cached = this.findCompletedUplink(clientId, envelope.requestId);
                if (cached) {
                    if (cached.fingerprint !== fingerprint) throw new Error('requestId 已被不同请求使用');
                    return replayResult(cached.result, envelope.requestId, this.now());
                }
                // 审核决定的宿主回调通常把状态变更和审计放在同一事务；临时失败不能被缓存，
                // 否则手机重试相同 requestId 时永远拿不到真正结果。
                rememberError = envelope.kind !== 'photo.review.decide';
            }
            let result: CompanionRuntimeResult;
            if (envelope.kind === 'message.send') {
                const responseBody = await this.handlers.onMessage(validateMessage(envelope.body), clientId, this.lifetime.signal);
                result = { accepted: true, response: responseEnvelope('message.receive', responseBody, envelope.requestId, this.now()) };
            } else if (envelope.kind === 'action.request') {
                const actionResult = await this.handlers.onAction(validateAction(envelope.body), clientId, envelope.requestId, this.lifetime.signal);
                result = { accepted: true, response: responseEnvelope('action.result', actionResult, envelope.requestId, this.now()) };
            } else if (envelope.kind === 'action.result') {
                if (!this.handlers.onActionResult) throw new Error('宿主未接入手机动作回执');
                const result = validateActionResult(envelope.body);
                const pending = this.pendingDownlinkResults.get(clientId);
                const issued = pending?.get(result.requestId);
                if (issued === undefined || downlinkExpired(issued, this.now())) {
                    if (issued) {
                        pending!.delete(result.requestId);
                        if (pending!.size === 0) this.pendingDownlinkResults.delete(clientId);
                    }
                    throw new Error('动作回执没有对应的宿主下发请求');
                }
                if (result.ok && result.decision === 'deny') throw new Error('动作回执不能在拒绝执行时报告成功');
                const expected = issued.decision;
                if (result.decision !== 'deny' && result.decision !== expected) throw new Error('动作回执确认级别与下发策略不一致');
                await this.handlers.onActionResult(result, clientId, this.lifetime.signal);
                // 宿主通常会在这里写审计记录。只有写入成功后才消费回执；临时失败时保留槽位，允许手机重试。
                pending!.delete(result.requestId);
                if (pending!.size === 0) this.pendingDownlinkResults.delete(clientId);
                return { accepted: true };
            } else if (envelope.kind === 'photo.review.list') {
                if (!this.handlers.onPhotoReviewList) throw new Error('宿主未接入照片审核列表');
                let raw: PhotoReviewListResult;
                try { raw = await this.handlers.onPhotoReviewList(validatePhotoReviewListRequest(envelope.body), clientId); }
                catch { throw new Error('照片审核列表暂时不可用'); }
                const responseBody = validatePhotoReviewListResult(raw);
                result = { accepted: true, response: responseEnvelope('photo.review.list.result', responseBody, envelope.requestId, this.now()) };
            } else if (envelope.kind === 'photo.review.decide') {
                if (!this.handlers.onPhotoReviewDecision) throw new Error('宿主未接入照片审核决定');
                const request = validatePhotoReviewDecisionRequest(envelope.body);
                let raw: PhotoReviewDecisionResult;
                try { raw = await this.handlers.onPhotoReviewDecision(request, clientId, envelope.requestId); }
                catch { throw new Error('照片审核暂时不可用，请稍后重试'); }
                const responseBody = validatePhotoReviewDecisionResult(raw);
                if (responseBody.draftId !== request.draftId) throw new Error('照片审核结果编号与请求不一致');
                const expected = request.decision === 'approve' ? 'approved' : 'rejected';
                if (responseBody.status !== expected) throw new Error('照片审核结果状态与请求不一致');
                result = { accepted: true, response: responseEnvelope('photo.review.decision', responseBody, envelope.requestId, this.now()) };
            } else if (envelope.kind === 'voice.session.start') {
                if (!this.handlers.onVoiceSessionStart) throw new Error('宿主未接入实时语音');
                const request = validateVoiceSessionStart(envelope.body);
                this.voiceSessions.start(clientId, request, this.now());
                try { await this.handlers.onVoiceSessionStart(request, clientId); }
                catch (error) { this.voiceSessions.cancel(clientId, { sessionId: request.sessionId, reason: 'network' }); throw error; }
                return { accepted: true };
            } else if (envelope.kind === 'voice.session.chunk') {
                if (!this.handlers.onVoiceSessionChunk) throw new Error('宿主未接入实时语音');
                const request = validateVoiceSessionChunk(envelope.body);
                this.voiceSessions.chunk(clientId, request, this.now());
                try { await this.handlers.onVoiceSessionChunk(request, new Uint8Array(Buffer.from(request.data, 'base64')), clientId); }
                catch (error) { this.voiceSessions.cancel(clientId, { sessionId: request.sessionId, reason: 'network' }); throw error; }
                return { accepted: true };
            } else if (envelope.kind === 'voice.session.stop') {
                if (!this.handlers.onVoiceSessionStop) throw new Error('宿主未接入实时语音');
                const request = validateVoiceSessionStop(envelope.body);
                const total = this.voiceSessions.stop(clientId, request);
                const reply = await this.handlers.onVoiceSessionStop(request, total, clientId);
                return reply ? { accepted: true, response: responseEnvelope('message.receive', validateMessage(reply), envelope.requestId, this.now()) } : { accepted: true };
            } else if (envelope.kind === 'voice.session.cancel') {
                const request = validateVoiceSessionCancel(envelope.body);
                this.voiceSessions.cancel(clientId, request);
                await this.handlers.onVoiceSessionCancel?.(request, clientId);
                return { accepted: true };
            } else {
                return { accepted: true };
            }
            if (fingerprint) this.rememberCompletedUplink(clientId, envelope.requestId, fingerprint, result);
            return result;
        } catch (error) {
            const result = { accepted: true, response: responseEnvelope('error', { code: 'runtime_error', message: safeError(error) }, requestId, this.now()) } as const;
            if (fingerprint && rememberError) this.rememberCompletedUplink(clientId, requestId, fingerprint, result);
            return result;
        }
    }

    private findCompletedUplink(clientId: string, requestId: string): CompletedUplinkRequest | undefined {
        const requests = this.completedUplinkRequests.get(clientId);
        if (!requests) return undefined;
        const now = this.now();
        for (const [id, item] of requests) {
            const age = now - item.completedAt;
            if (age >= UPLINK_REQUEST_TTL_MS || age < -MAX_CLOCK_SKEW_MS) requests.delete(id);
        }
        if (requests.size === 0) this.completedUplinkRequests.delete(clientId);
        return requests.get(requestId);
    }

    private rememberCompletedUplink(clientId: string, requestId: string, fingerprint: string, result: CompanionRuntimeResult): void {
        const requests = this.completedUplinkRequests.get(clientId) ?? new Map<string, CompletedUplinkRequest>();
        requests.set(requestId, { completedAt: this.now(), fingerprint, result });
        while (requests.size > MAX_UPLINK_REQUESTS_PER_CLIENT) requests.delete(requests.keys().next().value!);
        this.completedUplinkRequests.set(clientId, requests);
    }
}

function downlinkExpired(item: PendingDownlinkResult, now: number): boolean {
    const age = now - item.issuedAt;
    // 明显时钟回拨时丢弃旧回执凭据，避免动作长期占用容量或被延迟确认。
    return age >= DOWNLINK_ACTION_TTL_MS || age < -MAX_CLOCK_SKEW_MS;
}

function responseEnvelope<T extends CompanionEnvelope['body']>(kind: CompanionEnvelope['kind'], body: T, requestId: string, now: number): CompanionEnvelope<T> {
    return {
        v: 1,
        requestId: `resp-${requestId}`.slice(0, 128),
        kind,
        sentAt: new Date(now).toISOString(),
        nonce: `resp-${randomBytes(12).toString('hex')}`,
        body,
    };
}

function canonicalRequest(kind: CompanionEnvelope['kind'], body: unknown): string {
    const sort = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(sort);
        if (!value || typeof value !== 'object') return value;
        return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, sort(item)]));
    };
    return JSON.stringify([kind, sort(body)]) ?? '';
}

function replayResult(result: CompanionRuntimeResult, requestId: string, now: number): CompanionRuntimeResult {
    if (!result.accepted || !result.response) return result;
    return { accepted: true, response: responseEnvelope(result.response.kind, result.response.body, requestId, now) };
}

function safeError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.replace(/\s+/g, ' ').slice(0, 500) || '处理失败';
}

export type CompanionRuntimeError = CompanionError;
