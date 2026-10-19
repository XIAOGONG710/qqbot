// OneBot 11 WebSocket 客户端（连 NapCat 的“WebSocket 服务端”网络配置）。
//
// 协议细节对照 vendor/NapCatQQ/packages/napcat-onebot：
//   - 连根路径 /：同一条连接既收事件又调 API（/api 只调 API，不推事件）。network/websocket-server.ts
//   - token：Authorization: Bearer <token>（或 ?access_token=），错了会回 retcode 1403 后断开。同上 authorize()
//   - 调用：{action, params, echo} → {status, retcode, data, message, echo}。action/OneBotAction.ts
//   - 私聊消息事件：post_type "message"、message_type "private"；直接私聊 sub_type 恒为 "friend"，
//     群临时会话为 "group"。api/msg.ts
// 用 Node 自带的 WebSocket（undici），它支持非标准的 headers 选项。

import { faceText, textToSegments } from './qq-faces.ts';
import { FORWARD_TEXT, fileText, shareText } from './shares.ts';

export interface Segment {
    type: string;
    data: Record<string, unknown>;
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

export type OneBotEvent = MessageEvent | { post_type: string; [key: string]: unknown };

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

export class OneBotClient {
    #options: OneBotOptions;
    #ws: WebSocket | null = null;
    #pending = new Map<string, { resolve: (data: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    #nextEcho = 1;
    #retryDelay = 1000;
    #stopped = false;

    constructor(options: OneBotOptions) {
        this.#options = options;
    }

    start(): void {
        this.#stopped = false;
        this.#connect();
    }

    stop(): void {
        this.#stopped = true;
        this.#ws?.close();
    }

    #connect(): void {
        const { url, token, log } = this.#options;
        const headers: Record<string, string> = token ? { Authorization: `Bearer ${token}` } : {};
        const ws = new WebSocket(url, { headers });
        this.#ws = ws;

        ws.addEventListener('open', () => {
            this.#retryDelay = 1000;
            log(`OneBot 已连接 ${url}`);
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
            setTimeout(() => this.#connect(), this.#retryDelay);
            this.#retryDelay = Math.min(this.#retryDelay * 2, 30_000);
        });
    }

    #onMessage(text: string): void {
        let payload: Record<string, unknown>;
        try {
            payload = JSON.parse(text);
        } catch {
            this.#options.log(`OneBot 收到无法解析的数据：${text.slice(0, 200)}`);
            return;
        }
        if ('post_type' in payload) {
            this.#options.onEvent(payload as OneBotEvent);
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
            ws.send(JSON.stringify({ action, params, echo }));
        });
    }

    /** 发一条私聊：文字里白名单的小黄脸（「[捂脸]」）发成 face 段，和文字拼成一条（ADR 0051） */
    async sendPrivateText(userId: number, text: string): Promise<number> {
        const data = await this.call<{ message_id: number }>('send_private_msg', {
            user_id: userId,
            message: textToSegments(text),
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

export function isPrivateFriendMessage(event: OneBotEvent): event is MessageEvent {
    return event.post_type === 'message' && event.message_type === 'private' && event.sub_type === 'friend';
}

/** 把消息段转成给模型看的纯文本；非文字的段用占位符（听过、看过的语音和图片在这之前已经换成一段文字，media.ts，ADR 0052） */
export function segmentsToText(message: Segment[] | string): string {
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
            case 'reply': return '';
            case 'record': return '[语音]';
            case 'video': return '[视频]';
            case 'file': return fileText(data.file);
            // 分享卡片、转发的聊天记录（ADR 0080）：以前一律是「[json]」「[forward]」，她看不懂
            case 'json': return shareText(data.data);
            case 'forward': return FORWARD_TEXT;
            default: return `[${segment.type}]`;
        }
    }).join('');
}
