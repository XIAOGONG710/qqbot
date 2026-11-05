// 跨渠道统一的近期时间线（ADR 0159，配置 timeline，默认关）。
// 来自 10-25 用户给的清单：「统一近期时间线：你在 B 站回复评论后，另一个聊天窗口可能毫不知情。不同工具、窗口和实例应共享可访问的事件记录，
// 记下时间、操作与实际结果。」
// 现状：QQ 聊天自己有聊天记录；QQ 空间说说和签名她本来就知道（presence.ts 的 describeSelf 放进了提示词）；
// 但她在 B 站评论 / 回复 / 发私信、替他操作设备、查资料、设定被改、休眠，这些在 QQ 聊天里她完全不知道——他问「你刚才在 B 站干嘛了」她会编。
// 做法：这些渠道做完一件事就往这里记一行（时间、渠道、一句话、结果），QQ 聊天的提示词里放最近 24 小时里 QQ 以外的几条。
// 只记「做了什么、结果如何」的一句话，不记评论、私信、网页的原文；一句话里的标题截到 24 字。

import { appendFileSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateObject, stateTimestamp } from './state-schema.ts';

export const CHANNELS = ['bilibili', 'qzone', 'device', 'web', 'identity', 'dormancy', 'people', 'tastes', 'desktop'] as const;
export type Channel = (typeof CHANNELS)[number];

export interface TimelineEntry {
    /** 跨文件收件箱可提供稳定 ID；相同 ID 只记一次。 */
    id?: string;
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
const TIMELINE_ID_RE = /^[A-Za-z0-9:_-]{8,200}$/;

export const clip = (text: string, max: number): string => {
    if (typeof text !== 'string' || !Number.isSafeInteger(max) || max < 1) throw new Error('时间线文本或长度无效');
    const chars: string[] = []; let space = false;
    const add = (char: string) => { chars.push(char); return chars.length > max; };
    for (const char of text) {
        if (/\s/u.test(char)) { if (chars.length) space = true; continue; }
        if ((space && add(' ')) || add(char)) return `${chars.slice(0, max - 1).join('')}…`;
        space = false;
    }
    return chars.join('');
};

function validTimeline(value: unknown): value is TimelineEntry {
    return stateObject(value) && stateTimestamp(value.at) && CHANNELS.includes(value.channel as Channel)
        && typeof value.kind === 'string' && Boolean(value.kind.trim()) && typeof value.summary === 'string' && Boolean(value.summary.trim())
        && (value.id === undefined || (typeof value.id === 'string' && TIMELINE_ID_RE.test(value.id)))
        && (value.ok === undefined || typeof value.ok === 'boolean');
}

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
        if (entry.id !== undefined && !TIMELINE_ID_RE.test(entry.id)) throw new RangeError('时间线事件 ID 不合法');
        if (entry.id && this.read().some(item => item.id === entry.id)) return;
        const line: TimelineEntry = {
            at: (entry.at ?? this.#now()).toISOString(), channel: entry.channel, kind: entry.kind,
            summary: clip(entry.summary, SUMMARY_MAX), ...(entry.id ? { id: entry.id } : {}), ...(entry.ok === false ? { ok: false } : {}),
        };
        if (!validTimeline(line) || (entry.ok !== undefined && typeof entry.ok !== 'boolean')) throw new Error('时间线记录无效');
        mkdirSync(dirname(this.#path), { recursive: true });
        let previous = '';
        try { previous = readFileSync(this.#path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('时间线读取失败；未写入'); }
        const payload = `${previous && !previous.endsWith('\n') ? '\n' : ''}${JSON.stringify(line)}\n`;
        try { appendFileSync(this.#path, payload); }
        catch { let committed = false; try { committed = readFileSync(this.#path, 'utf8') === previous + payload; } catch { /* 未确认写入。 */ } if (!committed) throw new Error('时间线写入失败'); }
        // 裁剪是派生维护；已追加的事实不能因维护失败而被调用方重放。
        const temporary = `${this.#path}.tmp-${randomUUID()}`;
        try {
            const lines = readFileSync(this.#path, 'utf8').split('\n').filter(Boolean);
            if (lines.length > TRIM_AT) { writeFileSync(temporary, `${lines.slice(-KEEP).join('\n')}\n`, { flag: 'wx' }); renameSync(temporary, this.#path); }
        } catch { /* 下次写入时再裁剪，保留已确认的追加。 */ }
        finally { try { unlinkSync(temporary); } catch { /* 不覆盖追加结果。 */ } }
    }

    read(): TimelineEntry[] {
        let text: string;
        try { text = readFileSync(this.#path, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw new Error('时间线读取失败'); }
        const out: TimelineEntry[] = [];
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            try {
                const value: unknown = JSON.parse(line);
                if (validTimeline(value)) out.push({ ...value, summary: clip(value.summary, SUMMARY_MAX) });
            } catch { /* 坏行跳过 */ }
        }
        return out;
    }

    recent(now: Date, hours = 24, limit = 5): TimelineEntry[] {
        if (!Number.isFinite(now.getTime())) return [];
        if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isFinite(hours) || hours <= 0 || !Number.isFinite(hours * 3_600_000)) throw new RangeError('时间线窗口无效');
        if (!limit) return [];
        const since = now.getTime() - hours * 3_600_000;
        return this.read().filter(e => Date.parse(e.at) >= since && Date.parse(e.at) <= now.getTime() + 60_000)
            .sort((a, b) => Date.parse(a.at) - Date.parse(b.at)).slice(-limit);
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
        try { timeline.record({ at: new Date(entry.at), channel: 'device', kind: entry.action, summary: `在${where}${Object.hasOwn(LABEL, entry.action) ? LABEL[entry.action] : entry.action}`, ok: entry.decision === 'executed' }); } catch { /* 派生时间线失败不能改变已执行的设备结果。 */ }
    };
}

/** 包一层 B 站账号：评论 / 回复 / 私信 / 看字幕做完（或没做成）记一行；其余原样转发 */
export function timelineAccount<T extends BiliAccount>(account: T, timeline: Timeline, options: { acceptRead?: () => boolean } = {}): T {
    const safe = (entry: Omit<TimelineEntry, 'at'>) => { try { timeline.record(entry); } catch { /* 时间线出错不影响 B 站动作 */ } };
    const canRecord = (read: boolean) => { try { return !read || options.acceptRead?.() !== false; } catch { return false; } };
    const wrap = <A extends unknown[], R>(fn: (...args: A) => Promise<R>, describe: (...args: A) => { kind: string; summary: string; failed: string }, read = false) =>
        async (...args: A): Promise<R> => {
            let d: ReturnType<typeof describe> | undefined;
            try { d = describe(...args); } catch { /* 不可信显示元数据不应阻止主操作。 */ }
            try {
                const result = await fn(...args);
                if (d && canRecord(read)) safe({ channel: 'bilibili', kind: d.kind, summary: d.summary });
                return result;
            } catch (error) {
                if (d && canRecord(read)) safe({ channel: 'bilibili', kind: d.kind, summary: d.failed, ok: false });
                throw error;
            }
        };
    return new Proxy(account, {
        get(target, prop) {
            const value = Reflect.get(target, prop, target) as unknown;
            if (prop === 'postComment') return wrap(target.postComment.bind(target), input => ({ kind: 'comment', summary: `在 B 站视频 ${input.bvid} 下评论了`, failed: `想在 B 站视频 ${input.bvid} 下评论，没成` }));
            if (prop === 'postReply') return wrap(target.postReply.bind(target), input => ({ kind: 'reply', summary: `在 B 站评论区回复了 ${clip(input.to.name, 12)}`, failed: `想在 B 站回复 ${clip(input.to.name, 12)}，没成` }));
            if (prop === 'sendDm') return wrap(target.sendDm.bind(target), (_input: { uid: number; text: string }) => ({ kind: 'dm', summary: '在 B 站发了一条私信', failed: '想在 B 站发私信，没成' }));
            if (prop === 'subtitle') return wrap(target.subtitle.bind(target), video => ({ kind: 'watch', summary: `在 B 站看了一条视频（${video.bvid}）`, failed: `想看 B 站视频 ${video.bvid}，没成` }), true);
            return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
    });
}
