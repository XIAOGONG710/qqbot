// 跨渠道统一的近期时间线（ADR 0159，配置 timeline，默认关）。
// 来自 10-25 用户给的清单：「统一近期时间线：你在 B 站回复评论后，另一个聊天窗口可能毫不知情。不同工具、窗口和实例应共享可访问的事件记录，
// 记下时间、操作与实际结果。」
// 现状：QQ 聊天自己有聊天记录；QQ 空间说说和签名她本来就知道（presence.ts 的 describeSelf 放进了提示词）；
// 但她在 B 站评论 / 回复 / 发私信、替他操作设备、查资料、设定被改、休眠，这些在 QQ 聊天里她完全不知道——他问「你刚才在 B 站干嘛了」她会编。
// 做法：这些渠道做完一件事就往这里记一行（时间、渠道、一句话、结果），QQ 聊天的提示词里放最近 24 小时里 QQ 以外的几条。
// 只记「做了什么、结果如何」的一句话，不记评论、私信、网页的原文；一句话里的标题截到 24 字。

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export const CHANNELS = ['bilibili', 'qzone', 'device', 'web', 'identity', 'dormancy', 'people', 'tastes'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface TimelineEntry {
    /** ISO 时间 */
    at: string;
    channel: Channel;
    /** 做了什么，如 comment / reply / dm / watch / action / search / read / change / sleep / wake */
    kind: string;
    /** 一句话（已经截好）；不含原文 */
    summary: string;
    /** 做成了没有；没写 = 成功 */
    ok?: boolean;
}

/** 一行最多这么多字 */
export const SUMMARY_MAX = 80;
/** 文件超过这么多行就留最近的这么多（文本很小，几千行也只有几百 KB） */
const KEEP = 1500;
const TRIM_AT = 2000;

export const clip = (text: string, max: number): string => {
    const flat = text.replace(/\s+/g, ' ').trim();
    return [...flat].length > max ? `${[...flat].slice(0, max - 1).join('')}…` : flat;
};

const two = (n: number) => String(n).padStart(2, '0');
const hm = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;

/** 「今天 22:08」「昨天 20:10」「前天 …」 */
export function whenText(at: Date, now: Date): string {
    const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const diff = Math.round((day(now) - day(at)) / 86_400_000);
    return `${diff <= 0 ? '今天' : diff === 1 ? '昨天' : diff === 2 ? '前天' : `${at.getMonth() + 1}-${at.getDate()}`} ${hm(at)}`;
}

export class Timeline {
    readonly #path: string;
    readonly #now: () => Date;

    constructor(path: string, now: () => Date = () => new Date()) {
        this.#path = path;
        this.#now = now;
    }

    record(entry: Omit<TimelineEntry, 'at'> & { at?: Date }): void {
        const line: TimelineEntry = {
            at: (entry.at ?? this.#now()).toISOString(), channel: entry.channel, kind: entry.kind,
            summary: clip(entry.summary, SUMMARY_MAX), ...(entry.ok === false ? { ok: false } : {}),
        };
        mkdirSync(dirname(this.#path), { recursive: true });
        appendFileSync(this.#path, `${JSON.stringify(line)}\n`);
        const text = readFileSync(this.#path, 'utf8');
        const lines = text.split('\n').filter(Boolean);
        if (lines.length > TRIM_AT) writeFileSync(this.#path, `${lines.slice(-KEEP).join('\n')}\n`);
    }

    read(): TimelineEntry[] {
        if (!existsSync(this.#path)) return [];
        const out: TimelineEntry[] = [];
        for (const line of readFileSync(this.#path, 'utf8').split('\n')) {
            if (!line.trim()) continue;
            try {
                const value = JSON.parse(line) as TimelineEntry;
                if (value && typeof value.at === 'string' && typeof value.summary === 'string' && (CHANNELS as readonly string[]).includes(value.channel)) out.push(value);
            } catch { /* 坏行跳过 */ }
        }
        return out;
    }

    recent(now: Date, hours = 24, limit = 5): TimelineEntry[] {
        const since = now.getTime() - hours * 3_600_000;
        return this.read().filter(e => Date.parse(e.at) >= since && Date.parse(e.at) <= now.getTime() + 60_000).slice(-limit);
    }

    /** 放进聊天提示词的一段；这段时间里 QQ 以外没做过什么就是 undefined */
    promptLine(now: Date, hours = 24, limit = 5): string | undefined {
        const items = this.recent(now, hours, limit);
        if (!items.length) return undefined;
        const parts = items.map(e => `${whenText(new Date(e.at), now)} ${e.summary}${e.ok === false ? '（没做成）' : ''}`);
        return `[你最近在 QQ 聊天以外做过的事（这是你自己的经历，聊天里没说过）：${parts.join('；')}。他问到才说，自然带过，别念清单；只说这里写了的事本身，没写的细节（内容、原因、两件事之间的联系、你的感受）别编，他追问你就说记不太清；没记在这里的就是没做过]`;
    }
}

// ───────── 各渠道的接线 ─────────

import type { BiliAccount } from '.././bilibili/bilibili-account.ts';
import type { AuditEntry } from '../platform/device-actions.ts';

/** 设备控制的审计记录 → 时间线：只记真的执行了 / 没做成的，待批准、被拒、限流之类不算「做过」 */
export function timelineFromDevice(timeline: Timeline): (entry: AuditEntry) => void {
    const LABEL: Record<string, string> = {
        notify: '弹了一条通知', timer: '设了一个定时提醒', media: '控制了音乐', volume: '调了音量', open_url: '替他打开了一个网页',
        open_app: '替他打开了一个应用', ring: '让他的手机响了', lock: '锁了他的电脑', sleep: '让他的电脑休眠', capture_screen: '看了一眼他的屏幕', capture_camera: '用他电脑的摄像头拍了一张',
    };
    return entry => {
        if (entry.decision !== 'executed' && entry.decision !== 'failed') return;
        const where = entry.target === 'phone' ? '他的手机上' : '他的电脑上';
        timeline.record({ channel: 'device', kind: entry.action, summary: `在${where}${LABEL[entry.action] ?? entry.action}`, ok: entry.decision === 'executed' });
    };
}

/** 包一层 B 站账号：评论 / 回复 / 私信 / 看字幕做完（或没做成）记一行；其余原样转发 */
export function timelineAccount<T extends BiliAccount>(account: T, timeline: Timeline): T {
    const safe = (entry: Omit<TimelineEntry, 'at'>) => { try { timeline.record(entry); } catch { /* 时间线出错不影响 B 站动作 */ } };
    const wrap = <A extends unknown[], R>(fn: (...args: A) => Promise<R>, describe: (...args: A) => { kind: string; summary: string; failed: string }) =>
        async (...args: A): Promise<R> => {
            const d = describe(...args);
            try {
                const result = await fn(...args);
                safe({ channel: 'bilibili', kind: d.kind, summary: d.summary });
                return result;
            } catch (error) {
                safe({ channel: 'bilibili', kind: d.kind, summary: d.failed, ok: false });
                throw error;
            }
        };
    return new Proxy(account, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target) as unknown;
            if (prop === 'postComment') return wrap(target.postComment.bind(target), input => ({ kind: 'comment', summary: `在 B 站视频 ${input.bvid} 下评论了`, failed: `想在 B 站视频 ${input.bvid} 下评论，没成` }));
            if (prop === 'postReply') return wrap(target.postReply.bind(target), input => ({ kind: 'reply', summary: `在 B 站评论区回复了 ${clip(input.to.name, 12)}`, failed: `想在 B 站回复 ${clip(input.to.name, 12)}，没成` }));
            if (prop === 'sendDm') return wrap(target.sendDm.bind(target), (_input: { uid: number; text: string }) => ({ kind: 'dm', summary: '在 B 站发了一条私信', failed: '想在 B 站发私信，没成' }));
            if (prop === 'subtitle') return wrap(target.subtitle.bind(target), video => ({ kind: 'watch', summary: `在 B 站看了一条视频（${video.bvid}）`, failed: `想看 B 站视频 ${video.bvid}，没成` }));
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
    });
}
