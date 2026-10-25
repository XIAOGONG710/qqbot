// 告警直接发到用户自己的 QQ（用她的号，不经过模型）：外网断了 / 恢复了，服务守护（scripts/services-watchdog.mjs）调用。
// 为什么走 QQ：10-14 到 10-18 几次断网，NapCat 到 QQ 的连接一直活着（每小时的服务器时间同步照常），而心跳守望只往本机写 ALERT.txt，没人看。
// 这条路不需要模型、不需要外网 DNS，只要 NapCat 的 WebSocket（本机 3001）还在。机器整个停了（NapCat 也没了）它发不出，那种要另外的办法。
// 默认关：没有 <数据目录>/alert.json 或 enabled 不是 true 就什么都不发。发给谁、开不开都是用户定的（alert.json 的 qq）。
// 发的是纯文字、以「【运维提醒】」开头，一眼看得出不是她在说话；不进她的聊天记录（她不知道自己发过），用户回了她也只会当普通聊天。

import { readFileSync } from 'node:fs';

/** 运维提醒的开头：补回漏掉的消息时（backfill.ts）认这个，不把它当成她说的话记进聊天记录 */
export const OPS_NOTICE_PREFIX = '【运维提醒】';

export interface AlertConfig {
    /** 发给谁（QQ 号；要是她号的好友，QQ 才让发私聊） */
    qq: number;
    /** 外网断了 / 恢复了要不要发（默认发） */
    network: boolean;
    /**
     * 断网时也要通知的人（QQ 号，要是她号的好友）：能动虚拟机 / 宿主机的人（用户 10-26：「以后断网的话用她的号发送简短的通知给鸽鸽，他是可以修改虚拟机的」）。
     * 只收外网断了 / 恢复的两条简短的（不带她的聊天细节），不收别的告警；最多 3 个，去重，不含 qq 本人
     */
    helpers: readonly number[];
}

const MAX_HELPERS = 3;

/** 读 alert.json；没有、坏了、没开都当没有（永远不抛，守护不能因为这个出错） */
export function readAlertConfig(path: string): AlertConfig | undefined {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
        if (value.enabled !== true) return undefined;
        if (!Number.isSafeInteger(value.qq) || (value.qq as number) <= 0) return undefined;
        const qq = value.qq as number;
        const helpers = Array.isArray(value.helpers) ? [...new Set(value.helpers.filter((n): n is number => Number.isSafeInteger(n) && n > 0 && n !== qq))].slice(0, MAX_HELPERS) : [];
        return { qq, network: value.network !== false, helpers };
    } catch {
        return undefined;
    }
}

/** 够用的 WebSocket 形状（Node 自带的就是；测试里换成假的） */
export interface SocketLike {
    addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: (event: { data?: unknown }) => void): void;
    send(data: string): void;
    close(): void;
}

export interface SendAlertOptions {
    /** NapCat 的 OneBot WebSocket，如 ws://127.0.0.1:3001/ */
    url: string;
    token?: string;
    qq: number;
    text: string;
    /** 整个过程的超时，毫秒 */
    timeoutMs?: number;
    /** 测试用：换掉真的 WebSocket */
    open?: (url: string, headers: Record<string, string>) => SocketLike;
}

export type AlertResult = { ok: true; messageId: number } | { ok: false; reason: string };

const ECHO = 'qqbot-alert';

/** 连一次、发一条、等回执、断开。NapCat 的 WebSocket 服务端允许多个客户端同时连，Koishi 那条不受影响；这里收到的事件一律忽略 */
export function sendAlert(options: SendAlertOptions): Promise<AlertResult> {
    const { url, token, qq, text } = options;
    const open = options.open ?? ((u: string, headers: Record<string, string>) => new WebSocket(u, { headers } as never) as unknown as SocketLike);
    return new Promise<AlertResult>(resolve => {
        let done = false;
        let socket: SocketLike | undefined;
        const finish = (result: AlertResult) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { socket?.close(); } catch { /* 已经断了 */ }
            resolve(result);
        };
        const timer = setTimeout(() => finish({ ok: false, reason: 'NapCat 没在时限内回应' }), options.timeoutMs ?? 15_000);
        try {
            socket = open(url, token ? { Authorization: `Bearer ${token}` } : {});
        } catch (error) {
            finish({ ok: false, reason: `连不上 NapCat：${error instanceof Error ? error.message : String(error)}` });
            return;
        }
        socket.addEventListener('open', () => {
            socket!.send(JSON.stringify({ action: 'send_private_msg', params: { user_id: qq, message: [{ type: 'text', data: { text } }] }, echo: ECHO }));
        });
        socket.addEventListener('message', event => {
            let payload: { echo?: string; status?: string; retcode?: number; data?: { message_id?: number }; wording?: string; message?: string };
            try { payload = JSON.parse(String(event.data)); } catch { return; }
            if (payload.echo !== ECHO) return; // 别的事件：忽略
            if (payload.status === 'ok' && payload.retcode === 0 && typeof payload.data?.message_id === 'number') finish({ ok: true, messageId: payload.data.message_id });
            else finish({ ok: false, reason: `NapCat 回了 retcode ${payload.retcode}：${payload.wording || payload.message || ''}` });
        });
        socket.addEventListener('error', () => finish({ ok: false, reason: '连 NapCat 出错' }));
        socket.addEventListener('close', () => finish({ ok: false, reason: 'NapCat 的连接在回执之前断了' }));
    });
}

/** 外网断了超过阈值时的一条（minutes：已经断了多久） */
export function networkDownText(minutes: number, host: string): string {
    return `${OPS_NOTICE_PREFIX}${minutes} 分钟解析不了 ${host}：她连不上模型，现在回不了话、主动消息也发不出。机器人和 NapCat 还在跑。多半是宿主机或虚拟机的网络问题。恢复了我会再说一声。`;
}

/** 外网恢复时的一条 */
export function networkUpText(minutes: number): string {
    return `${OPS_NOTICE_PREFIX}外网恢复了（断了大约 ${minutes} 分钟），她又能回话了。`;
}

/**
 * 给能动虚拟机的人（鸽鸽，网络运维，知情）的一条（ADR 0165）：用她自己的口吻，只说断网这件事，不求什么、不带细节。
 * 断网时模型也连不上，所以这里是固定的一句，不是现写的；没有「【运维提醒】」前缀——这是她自己对他说的话，
 * 补回漏掉的消息时会记进和他的聊天记录里，之后她知道自己说过。
 */
export function networkDownHelperText(): string {
    return '鸽鸽，我这边断网了，连不上外网，现在回不了消息。';
}

export interface AlertDelivery {
    to: 'user' | 'helper';
    ok: boolean;
    /** 没发出去的原因（不含 QQ 号） */
    reason?: string;
}

/**
 * 外网断了 / 恢复了：先发给用户；断了的那一次再发给 helpers（各自独立，一个发不出去不影响另一个；恢复时不打扰 helpers）。
 * 没开外网提醒就什么都不发。send 由调用方给（守护脚本传 sendAlert，测试传假的）；永远不抛。
 */
export async function dispatchNetworkAlert(
    config: AlertConfig,
    kind: 'down' | 'up',
    minutes: number,
    host: string,
    send: (qq: number, text: string) => Promise<AlertResult>,
): Promise<AlertDelivery[]> {
    if (!config.network) return [];
    const out: AlertDelivery[] = [];
    const targets: { to: AlertDelivery['to']; qq: number; text: string }[] = [
        { to: 'user', qq: config.qq, text: kind === 'down' ? networkDownText(minutes, host) : networkUpText(minutes) },
        ...(kind === 'down' ? config.helpers.map(qq => ({ to: 'helper' as const, qq, text: networkDownHelperText() })) : []),
    ];
    for (const target of targets) {
        try {
            const result = await send(target.qq, target.text);
            out.push(result.ok ? { to: target.to, ok: true } : { to: target.to, ok: false, reason: result.reason });
        } catch (error) {
            out.push({ to: target.to, ok: false, reason: error instanceof Error ? error.message : String(error) });
        }
    }
    return out;
}
