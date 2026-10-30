// 微信 → 她的一条消息（OneBot 11 形状），以及她能发出的几个动作。
// 做法：桥接进程假装是 NapCat（OneBot 11 的 WS 服务端），Koishi 的 adapter-onebot 连上来——
// 下面这台机器人一行代码都不用改，联系人 id 还是数字（wxid 已经映射成稳定数字，wechat-id.ts）。
//
// 这里只放纯函数：事件怎么拼、动作怎么路由。真正的 WS 服务和 WCF 客户端在 scripts/wechat-bridge.mjs。
import type { Segment } from './onebot.ts';

export interface WechatMessage {
    /** 微信原始 id（wxid / 群 id），只用来记映射，不进事件 */
    wxid: string;
    /** wechat-id.ts 算出来的稳定数字 */
    numericId: number;
    text: string;
    /** 毫秒 */
    at: number;
    /** 微信消息 id（字符串也行，映射成数字给 OneBot 用） */
    messageId: number;
    self: { numericId: number; name: string };
}

/** 私聊消息事件（OneBot 11 message_private） */
export function privateMessageEvent(message: WechatMessage): Record<string, unknown> {
    return {
        post_type: 'message',
        message_type: 'private',
        sub_type: 'friend',
        time: Math.floor(message.at / 1000),
        self_id: message.self.numericId,
        message_id: message.messageId,
        user_id: message.numericId,
        raw_message: message.text,
        font: 0,
        sender: { user_id: message.numericId, nickname: '', sex: 'unknown', age: 0 },
        message: [{ type: 'text', data: { text: message.text } }],
    };
}

/** 她发出去的一段（QQ 的 face 段微信没有，只发文字；表情包图片这条先不发） */
export function toWechatText(segments: readonly Segment[]): string {
    return segments
        .filter(segment => segment.type === 'text')
        .map(segment => String(segment.data?.text ?? ''))
        .join('')
        .trim();
}

export interface ActionDeps {
    /** 现在能不能发（桥接进程有没有连上微信客户端） */
    ready: () => boolean;
    /** 数字 id → wxid */
    wxidOf: (numericId: number) => string | undefined;
    sendText: (wxid: string, text: string) => Promise<number | undefined>;
}

export interface ActionOutcome {
    status: 'ok' | 'failed' | 'not-ready' | 'unknown';
    data?: Record<string, unknown>;
    retcode?: number;
    message?: string;
}

/**
 * OneBot 动作 → 微信动作。只支持她真的用得上的几个：
 * 发文字、问她自己的登录信息、能发什么（图片不支持）。
 */
export async function routeAction(action: string, params: Record<string, unknown>, deps: ActionDeps): Promise<ActionOutcome> {
    if (action === 'send_private_msg') {
        if (!deps.ready()) return { status: 'not-ready', retcode: 102, message: '微信还没连上' };
        const userId = Number(params.user_id);
        const wxid = deps.wxidOf(userId);
        if (!wxid) return { status: 'failed', retcode: 100, message: `不认识这个联系人（${userId}）` };
        const text = toWechatText((params.message as Segment[]) ?? []);
        if (!text) return { status: 'failed', retcode: 100, message: '没有可发的文字' };
        const id = await deps.sendText(wxid, text);
        return id === undefined ? { status: 'failed', retcode: 100, message: '微信那边没发出去' } : { status: 'ok', data: { message_id: id } };
    }
    if (action === 'can_send_image' || action === 'can_send_record') return { status: 'ok', data: { yes: false } };
    if (action === 'get_status') return { status: 'ok', data: { online: deps.ready(), good: deps.ready() } };
    if (action === 'get_version_info') return { status: 'ok', data: { app_name: 'wechat-bridge', app_version: '0.1', protocol_version: 'v11' } };
    return { status: 'unknown', retcode: 1404, message: `不认识的动作 ${action}` };
}
