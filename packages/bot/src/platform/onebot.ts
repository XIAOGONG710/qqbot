// OneBot 11 WebSocket 客户端（连 NapCat 的“WebSocket 服务端”网络配置）。
//
// 协议细节对照 vendor/NapCatQQ/packages/napcat-onebot：
//   - 连根路径 /：同一条连接既收事件又调 API（/api 只调 API，不推事件）。network/websocket-server.ts
//   - token：Authorization: Bearer <token>（或 ?access_token=），错了会回 retcode 1403 后断开。同上 authorize()
//   - 调用：{action, params, echo} → {status, retcode, data, message, echo}。action/OneBotAction.ts
//   - 私聊消息事件：post_type "message"、message_type "private"；直接私聊 sub_type 恒为 "friend"，
//     群临时会话为 "group"。api/msg.ts
// 用 Node 自带的 WebSocket（undici），它支持非标准的 headers 选项。

import { faceText, textToSegments } from '.././language/qq-faces.ts';
import { logBody } from './sensitive.ts';
import { FORWARD_TEXT, fileText, shareText } from '.././proactive/shares.ts';

export interface Segment {
    type: string;
    data: Record<string, unknown>;
}

/** 引用回复段（OneBot 11 的 reply）：放在消息最前面，id 是被引用那条的 message_id（ADR 0136） */
export function replySegment(messageId: number): Segment {
    return { type: 'reply', data: { id: String(messageId) } };
}

export interface MessageEvent {
    post_type: 'message';
    message_type: 'private' | 'group';
    sub_type: string;
    self_id: number;
    user_id: number;
    message_id: number;
    time: number;
    message: Segment[] | string;
    raw_message: string;
    sender: { user_id: number; nickname?: string };
}

/** 群消息（ADR 0210）：sender.card 是群名片（没设就空），nickname 是 QQ 昵称 */
export interface GroupMessageEvent {
    post_type: 'message';
    message_type: 'group';
    sub_type: string;
    self_id: number;
    user_id: number;
    group_id: number;
    message_id: number;
    time: number;
    message: Segment[] | string;
    raw_message: string;
    sender: { user_id: number; nickname?: string; card?: string; role?: string };
}

export type OneBotEvent = MessageEvent | GroupMessageEvent | { post_type: string; [key: string]: unknown };

interface ApiResponse {
    status: 'ok' | 'failed';
    retcode: number;
    data: unknown;
    message?: string;
    wording?: string;
    echo?: string;
}

export interface OneBotOptions {
    url: string;
    token?: string;
    onEvent: (event: OneBotEvent) => void;
    log: (message: string) => void;
    /** API 调用超时，毫秒 */
    timeoutMs?: number;
}

/**
 * NapCat 有几个动作（表情回应、正在输入）把 QQ 内核的失败放在返回值的 result 里，外层照样回 status ok / retcode 0。
 * result 不是 0 就当失败。10-20 实测：私聊里 set_msg_emoji_like 外层 ok，data 是 {result: 65011, errMsg: '操作失败，请稍后再试哦'}，
 * 之前的探针和机器人都只看外层，一直以为点成功了。
 */
export function assertKernelOk(action: string, data: unknown): void {
    if (!data || typeof data !== 'object' || !('result' in data)) return;
    const { result, errMsg } = data as { result: unknown; errMsg?: unknown };
    if (typeof result === 'number' && result !== 0) {
        throw new Error(`${action} 被 QQ 拒绝（result ${result}${typeof errMsg === 'string' && errMsg ? `：${errMsg}` : ''}）`);
    }
}

/** 日志只保留连接位置；兼容 URL 里的 access_token 时不能把凭据写进日志。 */
function endpointForLog(value: string): string {
    try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        url.search = '';
        url.hash = '';
        return url.toString();
    } catch {
        return '[地址无效]';
    }
}

export class OneBotClient {
    #options: OneBotOptions;
    #ws: WebSocket | null = null;
    #pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    #nextEcho = 1;
    #retryDelay = 1000;
    #retryTimer: NodeJS.Timeout | null = null;
    #stopped = true;

    constructor(options: OneBotOptions) {
        this.#options = options;
    }

    start(): void {
        if (!this.#stopped) return;
        this.#stopped = false;
        this.#connect();
    }

    stop(): void {
        this.#stopped = true;
        if (this.#retryTimer) {
            clearTimeout(this.#retryTimer);
            this.#retryTimer = null;
        }
        this.#ws?.close();
    }

    #connect(): void {
        if (this.#stopped || this.#ws) return;
        const { url, token, log } = this.#options;
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const ws = new WebSocket(url, { headers });
        this.#ws = ws;

        ws.addEventListener('open', () => {
            this.#retryDelay = 1000;
            log(`OneBot 已连接 ${endpointForLog(url)}`);
        });
        ws.addEventListener('message', event => this.#onMessage(String(event.data)));
        ws.addEventListener('error', () => { /* close 事件里统一处理 */ });
        ws.addEventListener('close', event => {
            this.#ws = null;
            for (const [echo, call] of this.#pending) {
                clearTimeout(call.timer);
                call.reject(new Error('OneBot 连接已断开'));
                this.#pending.delete(echo);
            }
            if (this.#stopped) return;
            log(`OneBot 连接断开（code ${event.code}），${this.#retryDelay / 1000} 秒后重连`);
            this.#retryTimer = setTimeout(() => {
                this.#retryTimer = null;
                this.#connect();
            }, this.#retryDelay);
            this.#retryDelay = Math.min(this.#retryDelay * 2, 30_000);
        });
    }

    #onMessage(text: string): void {
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            this.#options.log(`OneBot 收到无法解析的数据：${logBody(text.slice(0, 200))}`);
            return;
        }
        // JSON.parse 也会接受 null、数字、字符串和数组；这些都不是 OneBot 事件或 API 响应。
        // 在它们上面直接使用 `in` 会抛 TypeError，穿透 WebSocket message 回调并影响后续收发。
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            this.#options.log('OneBot 收到格式不合法的数据（顶层不是对象）');
            return;
        }
        const payload = parsed as Record<string, unknown>;
        if ('post_type' in payload) {
            try {
                this.#options.onEvent(payload as OneBotEvent);
            } catch (error) {
                // 单条坏事件不能穿透 WebSocket 回调拖垮后续收发；也不记录异常正文，避免夹带聊天内容。
                this.#options.log(`OneBot 事件处理失败（${error instanceof Error ? error.name : '未知错误'}）`);
            }
            return;
        }
        const response = payload as unknown as ApiResponse;
        if (response.retcode === 1403) this.#options.log('OneBot token 验证失败，检查 QQBOT_ONEBOT_TOKEN');
        const call = response.echo ? this.#pending.get(response.echo) : undefined;
        if (!call) return;
        this.#pending.delete(response.echo!);
        clearTimeout(call.timer);
        if (response.status === 'ok' && response.retcode === 0) call.resolve(response.data);
        else call.reject(new Error(`OneBot 调用失败 retcode ${response.retcode}：${response.wording || response.message || ''}`));
    }

    call<T>(action: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
        const ws = this.#ws;
        if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('OneBot 未连接'));
        if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException('已取消', 'AbortError'));
        const echo = String(this.#nextEcho++);
        return new Promise<T>((resolve, reject) => {
            const finish = () => signal?.removeEventListener('abort', cancel);
            const cancel = () => {
                const pending = this.#pending.get(echo);
                if (!pending) return;
                this.#pending.delete(echo);
                clearTimeout(pending.timer);
                finish();
                reject(signal?.reason ?? new DOMException('已取消', 'AbortError'));
            };
            const timer = setTimeout(() => {
                this.#pending.delete(echo);
                finish();
                reject(new Error(`OneBot 调用 ${action} 超时`));
            }, this.#options.timeoutMs ?? 30_000);
            this.#pending.set(echo, {
                resolve: data => { finish(); resolve(data as T); },
                reject: error => { finish(); reject(error); },
                timer,
            });
            signal?.addEventListener('abort', cancel, { once: true });
            try {
                ws.send(JSON.stringify({ action, params, echo }));
            } catch {
                // readyState 检查与实际发送之间仍可能恰好断线；同步发送失败要立刻清掉 pending，
                // 不能让调用方再等完整个 API 超时。
                const pending = this.#pending.get(echo);
                if (!pending) return;
                this.#pending.delete(echo);
                clearTimeout(pending.timer);
                pending.reject(new Error(`OneBot 调用 ${action} 发送失败`));
            }
        });
    }

    /** 发一条私聊：文字里白名单的小黄脸（「[捂脸]」）发成 face 段，和文字拼成一条（ADR 0051）；replyTo 给了就是引用回复那条消息（ADR 0136） */
    /** 发群消息（ADR 0210）；replyTo 给了就引用那一条 */
    async sendGroupText(groupId: number, text: string, replyTo?: number): Promise<number> {
        const data = await this.call<{ message_id: number }>('send_group_msg', {
            group_id: groupId,
            message: replyTo === undefined ? textToSegments(text) : [replySegment(replyTo), ...textToSegments(text)],
        });
        return data.message_id;
    }

    async sendPrivateText(userId: number, text: string, replyTo?: number): Promise<number> {
        const data = await this.call<{ message_id: number }>('send_private_msg', {
            user_id: userId,
            message: replyTo === undefined ? textToSegments(text) : [replySegment(replyTo), ...textToSegments(text)],
        });
        return data.message_id;
    }

    /** 让对方那边显示「正在输入…」（NapCat 的 set_input_status，event_type 1；ADR 0077）。显示几秒就消，要一直显示得隔几秒再发一次 */
    async setInputStatus(userId: number, eventType = 1): Promise<void> {
        assertKernelOk('set_input_status', await this.call('set_input_status', { user_id: String(userId), event_type: eventType }));
    }

    /** 发一条语音（2026-11-01）：file 是本机的 wav，NapCat 自己转成 QQ 语音条 */
    async sendPrivateVoice(userId: number, file: string): Promise<number> {
        const data = await this.call<{ message_id: number }>('send_private_msg', {
            user_id: userId,
            message: [{ type: 'record', data: { file: `file:///${file.split('\\').join('/')}` } }],
        });
        return data.message_id;
    }

    /** 发一张已经落到本机的图片表情（ADR 0063）。 */
    async sendPrivateImage(userId: number, file: string, summary: string): Promise<number> {
        const data = await this.call<{ message_id: number }>('send_private_msg', {
            user_id: userId,
            message: [{ type: 'image', data: { file, summary, sub_type: 1 } }],
        });
        return data.message_id;
    }
}

/**
 * 私聊的戳一戳（NapCat 的 notice/notify/poke，OB11FriendPokeEvent）：user_id 是这段私聊的对方（不论谁戳的），
 * sender_id 是戳的人，target_id 是被戳的人；所以「他戳了小号」是 target_id === self_id（ADR 0079）
 */
export interface PokeEvent {
    post_type: 'notice';
    notice_type: 'notify';
    sub_type: 'poke';
    self_id: number;
    user_id: number;
    target_id: number;
    time: number;
    [key: string]: unknown;
}

/** 别人私聊戳了小号（不是群里的、不是小号自己戳别人） */
export function isPokeAtMe(event: OneBotEvent): event is PokeEvent {
    return event.post_type === 'notice' && event.notice_type === 'notify' && event.sub_type === 'poke'
        && !event.group_id
        && typeof event.user_id === 'number' && typeof event.self_id === 'number' && typeof event.time === 'number'
        && event.target_id === event.self_id && event.user_id !== event.self_id;
}

/** 好友撤回消息（NapCat 的 notice/friend_recall）：user_id 是这段私聊的对方，message_id 是被撤回的那条（他的或她的）；ADR 0082 */
export interface RecallEvent {
    post_type: 'notice';
    notice_type: 'friend_recall';
    self_id: number;
    user_id: number;
    message_id: number;
    [key: string]: unknown;
}

export function isFriendRecall(event: OneBotEvent): event is RecallEvent {
    return event.post_type === 'notice' && event.notice_type === 'friend_recall'
        && typeof event.user_id === 'number' && typeof event.message_id === 'number' && Number.isSafeInteger(event.message_id);
}

/** 群里别人发的消息（不含她自己发的、匿名的）（ADR 0210） */
export function isGroupMessage(event: OneBotEvent): event is GroupMessageEvent {
    const e = event as Record<string, unknown>;
    return e.post_type === 'message' && e.message_type === 'group' && validMessagePayload(e)
        && typeof e.group_id === 'number' && Number.isSafeInteger(e.group_id) && e.group_id > 0
        && e.user_id !== e.self_id && e.sub_type !== 'anonymous';
}

export function isPrivateFriendMessage(event: OneBotEvent): event is MessageEvent {
    const e = event as Record<string, unknown>;
    return e.post_type === 'message' && e.message_type === 'private' && e.sub_type === 'friend'
        && validMessagePayload(e);
}

function validMessagePayload(event: Record<string, unknown>): boolean {
    const sender = event.sender;
    return typeof event.self_id === 'number' && Number.isSafeInteger(event.self_id) && event.self_id > 0
        && typeof event.user_id === 'number' && Number.isSafeInteger(event.user_id) && event.user_id > 0
        && typeof event.message_id === 'number' && Number.isSafeInteger(event.message_id) && event.message_id >= 0
        && typeof event.time === 'number' && Number.isSafeInteger(event.time) && event.time >= 0
        && typeof event.raw_message === 'string'
        && validOneBotMessage(event.message)
        && Boolean(sender) && typeof sender === 'object' && !Array.isArray(sender)
        && typeof (sender as Record<string, unknown>).user_id === 'number'
        && (sender as Record<string, unknown>).user_id === event.user_id;
}

function validOneBotMessage(message: unknown): boolean {
    if (typeof message === 'string') return true;
    return Array.isArray(message) && message.every(segment => {
        if (!segment || typeof segment !== 'object' || Array.isArray(segment)) return false;
        const value = segment as Record<string, unknown>;
        return typeof value.type === 'string' && Boolean(value.data)
            && typeof value.data === 'object' && !Array.isArray(value.data);
    });
}

/** 聊天记录里的一条（引用回复时按消息 id 找到被引用的那一条，ADR 0081） */
export interface QuotedMessage {
    role: 'user' | 'assistant';
    content: string;
}

export type QuoteLookup = (messageId: number) => QuotedMessage | undefined;

const MAX_QUOTE = 40;
/** 引用了、但找不到是哪一条时写的（不写「看不到」：真人在 QQ 上总看得见被引用的那句，她照念出来就不像人） */
export const QUOTE_UNKNOWN = '[引用了一条之前的消息]';

/** 一条消息里引用回复段指向的消息 id（NapCat 的 reply 段，id 可能是数字或字符串） */
export function quotedIds(message: Segment[] | string): number[] {
    if (typeof message === 'string') return [];
    return message.filter(segment => segment.type === 'reply').map(segment => Number(segment.data?.id)).filter(id => Number.isSafeInteger(id));
}

/**
 * 引用回复段 → 「[引用你说的：「我周三有早八」]」。被引用的那一条自己开头的引用不再套进来，换行压成空格，超过 MAX_QUOTE 个字截短。
 * 给了查找、却找不到被引用的那一条（记录里没有、问 NapCat 也没拿到）：写一句「[引用了一条之前的消息]」——
 * 原来什么都不写，11-02 线上他引用她那句自我介绍问「你这是说谁呢」，她只看到这一句，当成在问她刚说的「对你这脾气摸清了」，答「说你呢」（模拟 5/6 答错）。
 * 没给查找（只要纯文字的地方）照旧什么都不写
 */
function quoteText(id: unknown, lookup: QuoteLookup | undefined): string {
    if (!lookup) return '';
    const number = Number(id);
    const quoted = Number.isSafeInteger(number) ? lookup(number) : undefined;
    if (!quoted) return QUOTE_UNKNOWN;
    const text = quoted.content.replace(/^\[引用.*?」\]/, '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return `[引用${quoted.role === 'assistant' ? '你说的' : '他之前说的'}：「${text.length > MAX_QUOTE ? `${text.slice(0, MAX_QUOTE)}…` : text}」]`;
}

/** 把消息段转成给模型看的纯文本；非文字的段用占位符（听过、看过的语音和图片在这之前已经换成一段文字，media.ts，ADR 0052）。quoted 给了就把引用回复的那句话写进去 */
export function segmentsToText(message: Segment[] | string, quoted?: QuoteLookup, forwarded?: ForwardLookup): string {
    if (typeof message === 'string') return message;
    return message.map(segment => {
        const data = segment.data ?? {};
        switch (segment.type) {
            case 'text': return String(data.text ?? '');
            // 表情包、商城表情的 summary 是名字，如“[动画表情]”“[是的]”
            case 'image': return typeof data.summary === 'string' && data.summary ? data.summary : '[图片]';
            // QQ 小黄脸按 id 换成名字「[捂脸]」，表里没有的照旧「[表情]」（ADR 0051）
            case 'face': return faceText(data.id);
            case 'at': return `@${String(data.qq ?? '')} `;
            case 'reply': return quoteText(data.id, quoted);
            case 'record': return '[语音]';
            case 'video': return '[视频]';
            case 'file': return fileText(data.file);
            // 分享卡片、转发的聊天记录（ADR 0080）：以前一律是「[json]」「[forward]」，她看不懂
            case 'json': return shareText(data.data);
            case 'forward': return forwardText(data, forwarded);
            default: return otherSegmentText(segment.type, data);
        }
    }).join('');
}

/**
 * 合并转发里是谁说了什么（11-02「检查类似的问题」）：原来只写「[转发的聊天记录]」，里面一个字都没有——他转一段别人的聊天问「你看这人说的啥」，
 * 她和引用丢了时一样只能猜，最容易把别人说的当成他说的。forward 段的 data（NapCat 可能直接带 content，也可能只有 id、要另问 get_forward_msg）
 * 交给调用方：它知道这段私聊的两个人是谁，拼好一句话；返回 undefined 就照旧只写「[转发的聊天记录]」
 */
export type ForwardLookup = (data: Record<string, unknown>) => string | undefined;

function forwardText(data: Record<string, unknown>, forwarded: ForwardLookup | undefined): string {
    return forwarded?.(data) ?? FORWARD_TEXT;
}

/** 转发里最多放几条、每条几个字、整段几个字 */
const FORWARD_LINES = 8;
const FORWARD_LINE_CHARS = 40;
const FORWARD_TOTAL_CHARS = 360;

/**
 * 转发里的消息 → 「[转发的聊天记录（共 12 条，下面是前 8 条）：小王：今晚吃啥／他：随便／……]」。
 * 每条是 NapCat 的 node 段（data.user_id / nickname / message 或 content）或者一条 OneBot 消息（sender.user_id / nickname，message）。
 * 说话人交给 who：他就写「他」、她自己就写「你」、别人写昵称——**不把别人的话写成他的**。里面再套的转发只写「[转发的聊天记录]」
 */
export function renderForward(items: readonly unknown[], who: (userId: number | undefined, nickname: string) => string): string | undefined {
    const rec = (value: unknown) => (typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined);
    const lines: string[] = [];
    for (const item of items) {
        const outer = rec(item);
        if (!outer) continue;
        const node = rec(outer.data) ?? outer;
        const sender = rec(node.sender);
        const rawId = Number(node.user_id ?? sender?.user_id);
        const nickname = String(node.nickname ?? sender?.card ?? sender?.nickname ?? '').replace(/[\r\n\t[\]【】：:]+/g, ' ').trim().slice(0, 16);
        const segments = node.message ?? node.content;
        const text = (typeof segments === 'string' ? segments : Array.isArray(segments) ? segmentsToText(segments as Segment[]) : '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const name = who(Number.isSafeInteger(rawId) ? rawId : undefined, nickname) || '别人';
        lines.push(`${name}：${text.length > FORWARD_LINE_CHARS ? `${text.slice(0, FORWARD_LINE_CHARS)}…` : text}`);
    }
    if (!lines.length) return undefined;
    let body = '';
    let shown = 0;
    for (const line of lines.slice(0, FORWARD_LINES)) {
        if (body && body.length + line.length + 1 > FORWARD_TOTAL_CHARS) break;
        body += `${body ? '／' : ''}${line}`;
        shown++;
    }
    const head = shown < lines.length ? `共 ${lines.length} 条，下面是前 ${shown} 条` : `共 ${lines.length} 条`;
    return `[转发的聊天记录（${head}）：${body}]`;
}

/**
 * 别的消息段（11-02「检查类似的问题」）：原来一律写成英文类型名「[dice]」「[rps]」「[mface]」「[location]」，她看不懂，
 * 和引用丢了一样只能猜。能写成人话的写成人话；真认不出来的写「[一条特殊消息]」，不写英文
 */
export function otherSegmentText(type: string, data: Record<string, unknown>): string {
    const str = (value: unknown, max = 40) => {
        if (typeof value !== 'string' && typeof value !== 'number') return '';
        const text = String(value).replace(/[\r\n\t]+/g, ' ').replace(/[[\]【】]/g, '').replace(/\s+/g, ' ').trim();
        return text.length > max ? `${text.slice(0, max)}…` : text;
    };
    switch (type) {
        case 'mface': return str(data.summary) ? `[${str(data.summary).replace(/^\[|\]$/g, '')}]` : '[商城表情]';
        case 'dice': { const n = str(data.result); return /^[1-6]$/.test(n) ? `[掷骰子：${n} 点]` : '[掷骰子]'; }
        case 'rps': return '[猜拳]';
        case 'poke': return '[戳一戳]';
        case 'shake': return '[窗口抖动]';
        case 'location': { const where = [str(data.title), str(data.content)].filter(Boolean).join(' '); return where ? `[位置：${where}]` : '[位置]'; }
        case 'contact': return data.type === 'group' ? '[推荐了一个群]' : '[推荐了一个QQ好友]';
        case 'markdown': { const text = str(data.content, 200); return text ? text.replace(/[#*_`>]+/g, '').trim() : '[一条特殊消息]'; }
        case 'music': return '[分享音乐]';
        case 'xml': case 'light_app': case 'ark': return '[分享]';
        default: return '[一条特殊消息]';
    }
}
