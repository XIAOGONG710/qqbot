// 手机这一头（Android，ADR 0148）：用 ntfy 推送。手机上装 ntfy 应用、订阅一个只有他知道的随机话题，通知就直接弹出来，不用别的自动化软件：
//   notify → 一条普通通知；timer → ntfy 自带的延时发送（delay，最长 3 天，这里最长 24 小时）；ring → 最高优先级的通知（手机上要在 ntfy 里给「紧急」频道开声音 / 免打扰例外）。
// 只出站（虚拟机 → ntfy 服务器），手机也只出站（订阅），谁都不用开入站端口。通知文字会经过 ntfy 服务器（默认是 ntfy.sh）：
// 话题名当密码用（随机、够长），想更稳就自己架 ntfy，把 baseUrl 换掉。
//
// 这里只做发布，不做别的：手机上能被远程做的事，就是「弹一条通知」，别的（拍照、读短信、装软件）这条通道天生做不到。

import type { DispatchJob, DispatchResult } from './device-actions.ts';

export interface PhoneOptions {
    baseUrl: string;
    topic: string;
    /** ntfy 的访问令牌（自架或开了认证时用）；不写就匿名发布 */
    token?: string;
    /** 测试注入；默认全局 fetch */
    request?: (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
    timeoutMs?: number;
}

export const PHONE_TITLE = '林梦瑶';

/** ntfy 的延时写法：秒数 → 「600s」 */
const delayOf = (seconds: number) => `${Math.round(seconds)}s`;

export function phoneMessage(job: DispatchJob): { message: string; title: string; priority: number; delay?: string; tags?: string[] } | undefined {
    switch (job.action) {
        case 'notify':
            return { title: PHONE_TITLE, message: String(job.params.text ?? ''), priority: 3 };
        case 'timer':
            return { title: PHONE_TITLE, message: `${String(job.params.label ?? '到时间了')}（定时提醒）`, priority: 4, delay: delayOf(Number(job.params.seconds)), tags: ['alarm_clock'] };
        case 'ring':
            return { title: PHONE_TITLE, message: '找手机：我在这儿～', priority: 5, tags: ['rotating_light'] };
        default:
            return undefined;
    }
}

export function createPhonePublisher(options: PhoneOptions): (job: DispatchJob) => Promise<DispatchResult> {
    const doRequest = options.request ?? ((url, init) => fetch(url, init));
    const base = options.baseUrl.replace(/\/+$/, '');
    return async job => {
        const body = phoneMessage(job);
        if (!body) return { ok: false, error: '手机这一头做不了这个' };
        try {
            const response = await doRequest(base, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}) },
                body: JSON.stringify({ topic: options.topic, ...body }),
                signal: AbortSignal.timeout(options.timeoutMs ?? 8000),
            });
            return response.ok ? { ok: true } : { ok: false, error: `推送服务返回 ${response.status}` };
        } catch (error) {
            return { ok: false, error: error instanceof Error ? error.message.slice(0, 80) : '推送没发出去' };
        }
    };
}
