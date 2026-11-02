// 陌生人私聊（名单外的好友，unlistedFriends；ADR 0209，用户 2026-11-02）。
// 用户定的：她是 AI 这件事写在**个性签名**里，聊天里不主动说；被认真问到必须承认（承认版卡，ADR 0067，这条不归她决定）。
// 她本人（scripts/ask-her.mjs）：「不认识的人加我……要是就一句"在吗"那种，我基本不回」「我这人懒得跟陌生人扯」。
// 这里是几条代码里的规矩，不靠模型自觉：
//   1. 签名里没写明是 AI 之前，不回陌生人（启动时检查、补上「（AI）」；签名改不了就一直不回）；
//   2. 每天的上限：每个陌生人、一天几个陌生人、一天一共几条（在 10 分钟的限流 UNLISTED_RATE_LIMIT 之外）；
//   3. 只说了「在吗」「你好」这种的，先不回，记着；等对方说了点什么再回；
//   4. 看得出是未成年人（说自己初中、高中、未成年、十几岁）：照实说一句自己是 AI、不适合陪未成年人聊天，之后不再回这个号
//      （《人工智能拟人化互动服务管理暂行办法》第十四条：不得向未成年人提供虚拟伴侣；ADR 0067 背景）。
// 状态存 <数据目录>/strangers.json：哪天、每人几条、一共几条、哪些号是未成年人、签名哪天写明的。

import { join } from 'node:path';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';

export const STRANGER_DAILY = { perContact: 40, contacts: 10, total: 200 } as const;
/** 签名里写明是 AI 的那个记号 */
export const AI_MARK = '（AI）';
/** QQ 个性签名的长度上限（按字数截） */
const SIGNATURE_MAX = 80;
/** 看出是未成年人时她说的那一句（固定的，不交给模型） */
export const MINOR_NOTICE = '跟你说实话，我是个 AI，不太适合陪未成年人聊天。好好学习，有事多找身边的人呀。';

/** 签名里已经写明是 AI 了吗 */
export function hasAiMark(text: string): boolean {
    return /\bAI\b|ＡＩ|人工智能/i.test(text);
}

/** 给签名补上「（AI）」；已经写明的不动；太长先截正文 */
export function markSignature(text: string): string {
    const body = text.replace(/\s+/g, ' ').trim();
    if (hasAiMark(body)) return body;
    const room = SIGNATURE_MAX - [...AI_MARK].length;
    const clipped = [...body].length > room ? [...body].slice(0, room).join('') : body;
    return `${clipped}${AI_MARK}`;
}

/**
 * 看得出是未成年人吗：说自己在读初中 / 高中 / 小学、未成年、十几岁（17 岁及以下）。宁可错认成年人（她就不回了），也不放过说了自己未成年的。
 * 只认说自己的（「我」开头或者没有主语的自我介绍），「我弟上初中」不算
 */
export function minorHint(text: string): boolean {
    const t = text.replace(/\s+/g, '');
    if (/未成年|没成年|还没满十八|没满18/.test(t)) return true;
    if (/(?:^|[，,。！!？?])(?:我|本人)?(?:今年|现在)?(?:才|刚)?(?:1[0-7]|[七八九]|十[一二三四五六七]?)岁/.test(t)) return true;
    if (/(?:^|[，,。！!？?])(?:我|本人)?(?:是|在|读|上)?(?:初[一二三]|高[一二三])(?:的|学生|了|啊|呀|，|,|$)/.test(t)) return true;
    if (/(?:^|[，,。！!？?])(?:我|本人)(?:是|还是)?(?:个)?(?:初中生|高中生|小学生)/.test(t)) return true;
    return false;
}

/** 只是打招呼（在吗、你好、hi、？），没有内容 */
const GREETING = /^(?:在吗|在不在|在么|在嘛|你好|您好|哈喽|hello|hi|嗨|hey|你在吗|在不|在|哈咯|嘿|[?？.。!！~～]+)[?？.。!！~～\s]*$/i;
export function greetingOnly(texts: readonly string[]): boolean {
    const parts = texts.map(text => text.trim()).filter(Boolean);
    return parts.length > 0 && parts.every(text => GREETING.test(text));
}

interface StrangerFile {
    day: string;
    counts: Record<string, number>;
    total: number;
    minors: number[];
    /** 签名写明是 AI 的时刻（毫秒） */
    signedAt?: number;
}

export type StrangerDecision = { allowed: true } | { allowed: false; reason: string };

export interface StrangerGuard {
    /** 签名已经写明是 AI 了 */
    signed(): boolean;
    markSigned(at: number): void;
    isMinor(qq: number): boolean;
    markMinor(qq: number): void;
    /** 回这个陌生人一次：超了每天的上限就不回（原因写日志） */
    take(qq: number, now: number): StrangerDecision;
}

const dayOf = (now: number) => {
    const d = new Date(now);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function strangerGuard(dataDir: string, log: (message: string) => void = () => {}): StrangerGuard {
    const path = join(dataDir, 'strangers.json');
    const state = readJsonOr<StrangerFile>(path, { day: '', counts: {}, total: 0, minors: [] }, message => log(`陌生人：${message}`));
    state.counts ??= {};
    state.minors ??= [];
    const save = () => writeJsonAtomic(path, state);
    return {
        signed: () => typeof state.signedAt === 'number',
        markSigned(at) { state.signedAt = at; save(); },
        isMinor: qq => state.minors.includes(qq),
        markMinor(qq) { if (!state.minors.includes(qq)) { state.minors = [...state.minors, qq]; save(); } },
        take(qq, now) {
            const day = dayOf(now);
            if (state.day !== day) { state.day = day; state.counts = {}; state.total = 0; }
            const key = String(qq);
            const mine = state.counts[key] ?? 0;
            if (mine === 0 && Object.keys(state.counts).length >= STRANGER_DAILY.contacts) return { allowed: false, reason: `今天已经回了 ${STRANGER_DAILY.contacts} 个陌生人` };
            if (mine >= STRANGER_DAILY.perContact) return { allowed: false, reason: `今天已经回了这个人 ${STRANGER_DAILY.perContact} 次` };
            if (state.total >= STRANGER_DAILY.total) return { allowed: false, reason: `今天一共已经回了陌生人 ${STRANGER_DAILY.total} 次` };
            state.counts[key] = mine + 1;
            state.total += 1;
            save();
            return { allowed: true };
        },
    };
}
