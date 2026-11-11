// 中继的路由核心（ADR 0337 第 1–3 节）。这里没有套接字：上游、Koishi、App 都是注入的口子。
//
// - 她发给他的（send_private_msg 且 user_id 是他）按投递规则走 QQ 或 App，两种都记进消息账；
// - 他在 App 里发的拼成 message_private 事件推给 Koishi；
// - 其它动作在上游连着时原样透传，上游不在时只有第 1 节列的那几个由中继自己答，其余回失败。
import type { Ledger } from './ledger.ts';
import type { MediaFetcher, MediaStore } from './media.ts';
import { normalizeMessage, parseAppParts, partsToSegments, rawMessage, segmentsToParts } from './segments.ts';
import { isRecord } from './types.ts';
import type { Clock, DeliveryRule, ErrorCode, LedgerEvent, Log, Message, OneBotResponse, Segment, ServerFrame, UpstreamState } from './types.ts';

/** 中继自己发的消息 id 从这里往上编。NapCat 的 id 是 32 位整数（绝对值小于 2^31），撞不上 */
export const RELAY_ID_BASE = 10_000_000_000;
export const isRelayId = (id: number): boolean => id >= RELAY_ID_BASE;

export const ok = (data: unknown): OneBotResponse => ({ status: 'ok', retcode: 0, data, message: '', wording: '' });
export const failed = (retcode: number, message: string): OneBotResponse => ({ status: 'failed', retcode, data: null, message, wording: message });
/** 上游不在时透传动作的回答：和 NapCat 掉线一样是失败，不假装成功 */
export const upstreamOffline = (): OneBotResponse => failed(1404, 'upstream offline');
const isOk = (response: OneBotResponse): boolean => response.status === 'ok' && response.retcode === 0;

export interface CoreConfig {
    ownerId: number;
    ownerName: string;
    selfId: number;
    selfName: string;
    delivery: DeliveryRule;
}

export interface UpstreamPort {
    /** 和 NapCat 的 WS 连着 */
    connected(): boolean;
    /** 不抛错：没连着、超时都收成一条 failed 响应 */
    call(action: string, params: unknown): Promise<OneBotResponse>;
}

export interface CoreDeps {
    config: CoreConfig;
    ledger: Ledger;
    media: MediaStore;
    fetcher: MediaFetcher;
    now: Clock;
    upstream: UpstreamPort;
    koishi: { connected(): boolean; push(event: Record<string, unknown>): void };
    apps: { broadcast(frame: ServerFrame): void };
    /** Koishi 这一侧取媒体的本机地址 */
    localMediaUrl(mediaId: string): string;
    log: Log;
}

export interface RelayCore {
    /** Koishi 发来的一个动作 */
    handleAction(action: string, params: unknown): Promise<OneBotResponse>;
    /** 上游来的一个事件（透传由调用方做，这里只镜像进消息账、看心跳） */
    handleUpstreamEvent(event: unknown): void;
    /** 上游连上 / 断开后叫一声 */
    upstreamChanged(): void;
    /** App 发来的 send / recall / poke；返回只给这台设备的帧（ack 或 error） */
    appCommand(frame: Record<string, unknown>): Promise<ServerFrame[]>;
    /** App 看到的上游状态：连着并且 QQ 在线才算 up */
    upstreamState(): UpstreamState;
    /** 队列里的活都干完（测试和停机用） */
    idle(): Promise<void>;
}

export function createRelayCore(deps: CoreDeps): RelayCore {
    const { config, ledger, media, fetcher, now, upstream, koishi, apps, log } = deps;
    const segmentOptions = { media, localUrl: deps.localMediaUrl };
    let nextRelayId = (ledger.maxIdAtLeast(RELAY_ID_BASE) ?? RELAY_ID_BASE) + 1;
    /** NapCat 心跳里说 QQ 掉线了（WS 还连着）：发给他的话也改走 App */
    let qqOffline = false;
    let announced: UpstreamState | undefined;

    // 会动消息账的活排成一队：她连发几条、镜像要下载图片时，入账顺序和发生顺序一致
    let tail: Promise<void> = Promise.resolve();
    const enqueue = <T>(work: () => Promise<T> | T): Promise<T> => {
        const run = tail.then(work);
        tail = run.then(() => {}, () => {});
        return run;
    };

    const isOwner = (value: unknown): boolean => (typeof value === 'number' || typeof value === 'string') && value !== '' && Number(value) === config.ownerId;
    const routeUp = (): boolean => upstream.connected() && !qqOffline;
    const upstreamState = (): UpstreamState => routeUp() ? 'up' : 'down';
    /** 她发给他的这一条走不走 QQ */
    const toQQ = (): boolean => routeUp() && (config.delivery === 'both' || ledger.lastFromMe()?.via !== 'app');

    const announce = () => {
        const state = upstreamState();
        if (state === announced) return;
        announced = state;
        apps.broadcast({ type: 'upstream', state });
    };

    const emitEvent = (event: LedgerEvent) => {
        const entry = ledger.appendEvent(event, now());
        apps.broadcast({ type: 'event', seq: entry.seq, event: entry.event });
    };
    const emitMessage = (input: Omit<Message, 'seq' | 'recalled'>): Message => {
        const message = ledger.appendMessage(input);
        apps.broadcast({ type: 'message', message });
        return message;
    };
    const recall = (id: number) => {
        const message = ledger.byId(id);
        if (message && !message.recalled) emitEvent({ kind: 'recall', id });
    };

    /** 消息账里的一条 → OneBot 的消息对象（事件和 get_friend_msg_history / get_msg 共用） */
    const toOneBot = (message: Message): Record<string, unknown> => {
        const mine = message.from === 'her';
        const senderId = mine ? config.selfId : config.ownerId;
        const segments = partsToSegments(message.parts, message.replyTo, segmentOptions);
        return {
            self_id: config.selfId,
            user_id: senderId,
            time: Math.floor(message.at / 1000),
            message_id: message.id,
            message_seq: message.id,
            real_id: message.id,
            message_type: 'private',
            sub_type: 'friend',
            sender: { user_id: senderId, nickname: mine ? config.selfName : config.ownerName, card: '' },
            message: segments,
            raw_message: rawMessage(segments),
            font: 14,
            message_format: 'array',
            post_type: mine ? 'message_sent' : 'message',
            ...(mine ? { target_id: config.ownerId } : {}),
        };
    };
    const inHistory = (message: Message): boolean => !message.recalled && message.parts.some(part => part.kind !== 'poke');

    /** QQ 上已经发生的一条，镜像进消息账（via: 'qq'）。同一个 id 只记一次 */
    const mirror = (from: 'her' | 'me', id: number, at: number, segments: Segment[]): Promise<void> => enqueue(async () => {
        if (ledger.byId(id)) return;
        const converted = await segmentsToParts(segments, { media, fetcher, mode: 'lenient' });
        if (!converted.parts.length || ledger.byId(id)) return;
        emitMessage({ id, from, via: 'qq', at, parts: converted.parts, ...(converted.replyTo !== undefined ? { replyTo: converted.replyTo } : {}) });
    }).catch(() => log('一条 QQ 消息没能记进消息账'));

    /** 她的话送到 App：入账、广播。有一段 App 显示不了就整条失败 */
    const deliverToApp = (segments: Segment[]): Promise<OneBotResponse> => enqueue(async () => {
        let converted;
        try { converted = await segmentsToParts(segments, { media, fetcher, mode: 'strict' }); }
        catch (error) { return failed(1200, error instanceof Error ? error.message : 'unsupported message'); }
        if (!converted.parts.length) return failed(1200, 'empty message');
        const id = nextRelayId++;
        emitMessage({ id, from: 'her', via: 'app', at: now(), parts: converted.parts, ...(converted.replyTo !== undefined ? { replyTo: converted.replyTo } : {}) });
        log('她的一条消息发到了 App');
        return ok({ message_id: id });
    });

    async function sendToOwner(action: string, params: Record<string, unknown>): Promise<OneBotResponse> {
        const segments = normalizeMessage(params.message);
        if (toQQ()) {
            const response = await upstream.call(action, params);
            const id = isRecord(response.data) ? Number(response.data.message_id) : NaN;
            if (isOk(response) && Number.isSafeInteger(id)) {
                if (segments) void mirror('her', id, now(), segments);
                log('她的一条消息发到了 QQ');
                return response;
            }
            // both：QQ 没发出去就改发 App；last-active：他在 QQ 上，照实回失败
            if (config.delivery !== 'both') return response;
        }
        if (!segments?.length) return failed(1400, 'bad message');
        return deliverToApp(segments);
    }

    async function pokeOwner(action: string, params: Record<string, unknown>): Promise<OneBotResponse> {
        const record = (via: 'app' | 'qq') => enqueue(() => { emitMessage({ id: nextRelayId++, from: 'her', via, at: now(), parts: [{ kind: 'poke' }] }); });
        if (toQQ()) {
            const response = await upstream.call(action, params);
            if (isOk(response)) { await record('qq'); return response; }
            if (config.delivery !== 'both') return response;
        }
        await record('app');
        return ok(null);
    }

    async function deleteMessage(params: Record<string, unknown>): Promise<OneBotResponse> {
        const id = Number(params.message_id);
        if (isRelayId(id)) {
            return enqueue(() => {
                const message = ledger.byId(id);
                // 她只能撤回自己发的；戳一戳撤不回
                if (!message || message.from !== 'her' || message.parts.every(part => part.kind === 'poke')) return failed(1200, 'message not found');
                recall(id);
                return ok(null);
            });
        }
        const response = await upstream.call('delete_msg', params);
        if (isOk(response)) await enqueue(() => recall(id));
        return response;
    }

    async function reactToMessage(params: Record<string, unknown>): Promise<OneBotResponse> {
        const id = Number(params.message_id);
        const emojiId = Number(params.emoji_id);
        const record = () => enqueue(() => {
            if (ledger.byId(id) && Number.isSafeInteger(emojiId)) emitEvent({ kind: 'reaction', id, emojiId });
        });
        if (isRelayId(id)) {
            // App 协议里没有「取消回应」，取消照实回失败
            if (!ledger.byId(id) || !Number.isSafeInteger(emojiId) || params.set === false) return failed(1200, 'unsupported reaction');
            await record();
            return ok({ result: 0, errMsg: '' });
        }
        const response = await upstream.call('set_msg_emoji_like', params);
        const kernel = isRecord(response.data) ? response.data.result : undefined;
        if (isOk(response) && (kernel === undefined || kernel === 0) && params.set !== false) await record();
        return response;
    }

    function markRead(): void {
        const last = ledger.lastFromMe();
        if (last && ledger.lastReadUpTo() !== last.id) emitEvent({ kind: 'read', upTo: last.id });
    }

    function ownerHistory(params: Record<string, unknown>): OneBotResponse {
        const count = Math.min(Math.max(Math.trunc(Number(params.count ?? 20)) || 20, 1), 200);
        const seq = Number(params.message_seq);
        const end = Number.isSafeInteger(seq) && seq !== 0 && ledger.byId(seq) ? seq : undefined;
        // 多取一些再筛：撤回的、戳一戳不算聊天记录
        const messages = ledger.recentMessages(count * 2 + 20, end).filter(inHistory).slice(-count).map(toOneBot);
        return ok({ messages: params.reverseOrder === true ? messages.reverse() : messages });
    }

    /** 上游不在时中继自己答的那几个（ADR 第 1 节）；不在名单里的返回 undefined */
    function localAnswer(action: string, params: Record<string, unknown>): OneBotResponse | undefined {
        switch (action) {
            case 'get_login_info': return ok({ user_id: config.selfId, nickname: config.selfName });
            case 'get_status': return ok({ online: true, good: true, stat: {} });
            case 'get_version_info': return ok({ app_name: 'qqbot-chat-bridge', app_version: '0.0.0', protocol_version: 'v11' });
            case 'get_friend_list': return ok([{ user_id: config.ownerId, nickname: config.ownerName, remark: '' }]);
            case 'get_friend_msg_history': return isOwner(params.user_id) ? ownerHistory(params) : undefined;
            case 'can_send_image': case 'can_send_record': return ok({ yes: true });
            default: return undefined;
        }
    }

    async function handleAction(action: string, rawParams: unknown): Promise<OneBotResponse> {
        const params = isRecord(rawParams) ? rawParams : {};
        const owner = isOwner(params.user_id) && params.group_id === undefined;
        switch (action) {
            case 'send_private_msg':
                if (owner) return sendToOwner(action, params);
                break;
            case 'send_msg':
                if (owner && params.message_type !== 'group') return sendToOwner(action, params);
                break;
            case 'set_input_status':
                if (!owner) break;
                apps.broadcast({ type: 'typing', on: true });
                return toQQ() ? upstream.call(action, rawParams) : ok({ result: 0, errMsg: '' });
            case 'mark_private_msg_as_read':
                if (!owner) break;
                await enqueue(markRead);
                return upstream.connected() ? upstream.call(action, rawParams) : ok(null);
            case 'friend_poke': case 'send_poke':
                if (owner && (params.target_id === undefined || isOwner(params.target_id))) return pokeOwner(action, params);
                break;
            case 'delete_msg':
                if (isRelayId(Number(params.message_id)) || upstream.connected()) return deleteMessage(params);
                break;
            case 'set_msg_emoji_like':
                if (isRelayId(Number(params.message_id)) || upstream.connected()) return reactToMessage(params);
                break;
            case 'get_msg': {
                // 中继自己发的 id，NapCat 不认识：从消息账里答
                const id = Number(params.message_id);
                if (!isRelayId(id)) break;
                const message = ledger.byId(id);
                return message && inHistory(message) ? ok(toOneBot(message)) : failed(1200, 'message not found');
            }
        }
        if (upstream.connected()) return upstream.call(action, rawParams);
        return localAnswer(action, params) ?? upstreamOffline();
    }

    function handleUpstreamEvent(event: unknown): void {
        if (!isRecord(event)) return;
        const at = typeof event.time === 'number' && Number.isFinite(event.time) ? event.time * 1000 : now();
        if (event.post_type === 'meta_event') {
            if (event.meta_event_type === 'heartbeat' && isRecord(event.status)) {
                qqOffline = event.status.online === false;
                announce();
            }
            return;
        }
        if (event.group_id !== undefined) return;
        if ((event.post_type === 'message' || event.post_type === 'message_sent') && event.message_type === 'private') {
            const id = Number(event.message_id);
            const segments = normalizeMessage(event.message);
            if (!Number.isSafeInteger(id) || !segments) return;
            const fromHer = event.post_type === 'message_sent' || Number(event.user_id) === config.selfId;
            if (fromHer ? isOwner(event.target_id) : isOwner(event.user_id)) {
                void mirror(fromHer ? 'her' : 'me', id, at, segments);
                if (!fromHer) log('他在 QQ 上发来一条');
            }
            return;
        }
        if (event.post_type !== 'notice' || !isOwner(event.user_id)) return;
        if (event.notice_type === 'friend_recall') {
            const id = Number(event.message_id);
            if (Number.isSafeInteger(id)) void enqueue(() => recall(id));
        } else if (event.notice_type === 'notify' && event.sub_type === 'poke') {
            // 她戳他的那一下在动作成功时已经记过；这里只记他戳她
            const sender = event.sender_id === undefined ? event.user_id : event.sender_id;
            if (isOwner(sender) && Number(event.target_id) === config.selfId) {
                void enqueue(() => { emitMessage({ id: nextRelayId++, from: 'me', via: 'qq', at, parts: [{ kind: 'poke' }] }); });
            }
        }
    }

    const error = (code: ErrorCode, message: string, clientId?: string): ServerFrame[] =>
        [{ type: 'error', code, message, ...(clientId !== undefined ? { clientId } : {}) }];
    const NOT_DELIVERED = '她那边现在没连上，这条没有交给她';

    function appSend(frame: Record<string, unknown>): ServerFrame[] {
        const clientId = typeof frame.clientId === 'string' && frame.clientId.length >= 1 && frame.clientId.length <= 64 ? frame.clientId : undefined;
        if (clientId === undefined) return error('bad_request', 'clientId 要是 1 到 64 个字符');
        // 断线重发的同一条：已经入账就只再回一次 ack，不重复交给她
        const known = ledger.byClientId(clientId);
        if (known) return [{ type: 'ack', clientId, id: known.id, seq: known.seq }];
        const parsed = parseAppParts(frame.parts, media);
        if (!parsed.ok) return error('bad_request', parsed.message, clientId);
        let replyTo: number | undefined;
        if (frame.replyTo !== undefined) {
            if (typeof frame.replyTo !== 'number' || !ledger.byId(frame.replyTo)) return error('bad_request', '引用的那条不在记录里', clientId);
            replyTo = frame.replyTo;
        }
        if (!koishi.connected()) return error('not_delivered', NOT_DELIVERED, clientId);
        const message = emitMessage({ id: nextRelayId++, from: 'me', via: 'app', at: now(), parts: parsed.parts, ...(replyTo !== undefined ? { replyTo } : {}), clientId });
        koishi.push(toOneBot(message));
        log('他在 App 里发来一条');
        return [{ type: 'ack', clientId, id: message.id, seq: message.seq }];
    }

    function appRecall(frame: Record<string, unknown>): ServerFrame[] {
        const message = typeof frame.id === 'number' ? ledger.byId(frame.id) : undefined;
        // 只能撤回自己在 App 里发的；QQ 上发的那条中继撤不了
        if (!message || message.from !== 'me' || message.via !== 'app' || message.recalled || message.parts.every(part => part.kind === 'poke')) {
            return error('bad_request', '这条撤回不了');
        }
        if (!koishi.connected()) return error('not_delivered', NOT_DELIVERED);
        recall(message.id);
        koishi.push({ time: Math.floor(now() / 1000), self_id: config.selfId, post_type: 'notice', notice_type: 'friend_recall', user_id: config.ownerId, message_id: message.id });
        return [];
    }

    function appPoke(): ServerFrame[] {
        if (!koishi.connected()) return error('not_delivered', NOT_DELIVERED);
        emitMessage({ id: nextRelayId++, from: 'me', via: 'app', at: now(), parts: [{ kind: 'poke' }] });
        koishi.push({
            time: Math.floor(now() / 1000), self_id: config.selfId, post_type: 'notice', notice_type: 'notify', sub_type: 'poke',
            user_id: config.ownerId, sender_id: config.ownerId, target_id: config.selfId, raw_info: [],
        });
        return [];
    }

    return {
        handleAction,
        handleUpstreamEvent,
        upstreamChanged() {
            if (!upstream.connected()) qqOffline = false;
            announce();
        },
        appCommand: frame => enqueue(() => {
            switch (frame.type) {
                case 'send': return appSend(frame);
                case 'recall': return appRecall(frame);
                case 'poke': return appPoke();
                default: return error('bad_request', '不认识的帧');
            }
        }),
        upstreamState,
        idle: () => enqueue(() => {}),
    };
}
