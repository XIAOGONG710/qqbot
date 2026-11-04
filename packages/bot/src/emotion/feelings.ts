// 心境（ADR 0102，配置 herFeelings，默认关）：她会开心、难过、担心、烦，有来由、会累积、会慢慢散，也会表现出来（包括忍不住哭）。
// 为什么：原来她的“心情”只有两样——每天按日期抽一个底色（话痨 / 爱笑 / 黏人 / 安静，ADR 0015），和他刚说了什么引起的几轮余温（ADR 0028 / 0074）。
// 她那边发生的事（闺蜜病了、作业快到期了、买到相机）、他的态度（哄她、晾着她、说他不舒服）不会在她心里留下东西，隔几个钟头就没了。
// 这里和 0028 / 0074 / 0045 一样不存“她现在难过 N 分”这样的字段：每个“事”是一条带时刻的评估（appraisal），当下的感受 = 这些评估按各自的半衰期衰减后加起来，
// 同样的事实永远算出同一个结果，重启不丢、不会漂。评估只来自三类事实：她那边的事（世界）、聊天记录里他做了什么、作者写进 moments.json 的事。
// 不来自模型的随口一说：模型编出来的“难过”没有来由，会变成表演。
// 纯函数；提示词里怎么说、哪些轮次用，在 contact.ts。

import { warmSignal } from './affect.ts';
import type { StoredMessage } from '../memory/history.ts';
import { ignoredNow, IGNORED_GAP_MS, IGNORED_MAX_MS } from './grievance.ts';
import { endingText, goodNewsText, needsCareText } from '../language/intent.ts';
import { worldNews, type WorldNow } from '../world/world.ts';
import { NEWS_KINDS } from '../proactive/proactive.ts';
import { stateTimestamp } from '../memory/state-schema.ts';

type Said = Pick<StoredMessage, 'role' | 'content'> & { time?: string | undefined };

const HOUR = 3_600_000;

export const FEELING_KINDS = ['joy', 'relief', 'worry', 'sad', 'annoyed', 'tired'] as const;
export type FeelingKind = (typeof FEELING_KINDS)[number];
export const FEELING_NAME: Record<FeelingKind, string> = { joy: '开心', relief: '松了口气', worry: '担心', sad: '难过', annoyed: '烦', tired: '累' };

/** 默认半衰期（小时）：开心散得快，担心和难过留得久 */
const HALF_LIFE_H: Record<FeelingKind, number> = { joy: 5, relief: 3, worry: 8, sad: 8, annoyed: 4, tired: 5 };
/** 一条评估的起始分量：小事 0.8（不到“明显”）、一般 1.5（明显）、大事 2.6（很重） */
const AMPLITUDE = { 1: 0.8, 2: 1.5, 3: 2.6 } as const;
export type Strength = keyof typeof AMPLITUDE;
/** 当下分量到这几档：刚能察觉（小事，单独一件不会表现出来）、明显（写进提示词）、很重 */
export const FAINT = 0.6;
export const CLEAR = 1.2;
export const STRONG = 2.2;
/** 同一种感受加起来的上限（连着很多件事也不会无限大） */
const KIND_CAP = 3.4;
/** 过了这么多个半衰期就当散了 */
const HALF_LIVES_KEPT = 4;
/** 聊天记录往回看多久（他做的事引起的感受） */
const HISTORY_WINDOW_MS = 30 * HOUR;

export type Source = 'world' | 'him' | 'author';

export interface Appraisal {
    /** 稳定的标识：同一件事每次算出来一样 */
    id: string;
    /** 事情发生（了结）的时刻，毫秒 */
    at: number;
    kind: FeelingKind;
    strength: Strength;
    /** 一句事实，进提示词；不含他的原话 */
    cause: string;
    source: Source;
    /** 这件事和他有关（他的态度引起的）：提示词里不再说“不怪他” */
    aboutHim?: boolean;
    /** 覆盖默认半衰期（小时） */
    halfLifeH?: number;
}

/** 作者写下的事（runtime/bot/moments.json）：她生活里发生的、引起情绪的大事；不是我编的，是作者定的 */
export interface Moment {
    id: string;
    /** ISO，事情发生（她知道）的时刻 */
    at: string;
    kind: FeelingKind;
    strength: Strength;
    /** 一句话，她自己的口气里能说出来的事实，如“高数小测没考好” */
    cause: string;
    halfLifeH?: number;
}

export interface FeelingFacts {
    now: number;
    /** 她前一天的世界快照（到那天结束）：小测出分、被点名这类留到第二天还在的小事（ADR 0106） */
    previousWorld?: WorldNow;
    /** 男朋友档的聊天记录（带时间） */
    history: readonly Said[];
    /** 她今天的世界快照 */
    world?: WorldNow;
    /** 作者写下的事 */
    moments?: readonly Moment[];
    /** 别处算好的评估（她的追求做完一步、好几天没碰，ADR 0104） */
    extra?: readonly Appraisal[];
}

const atOf = (message: Said): number => Date.parse(message.time ?? '');
const hourBucket = (at: number): number => Math.floor(at / HOUR);

// ───────── 评估：把事实变成一条条带来由的“事” ─────────

/** 日常小事里带感受的（ADR 0106）：外卖晚了烦一点、晚霞拍了几张开心一点、小测分数出来了…… */
function eventAppraisals(world: WorldNow): Appraisal[] {
    return world.events.flatMap(event => (event.feel ? [{
        id: `world:ev:${event.id}`, at: event.at.getTime(), kind: event.feel.kind, strength: event.feel.strength, cause: event.text, source: 'world' as const,
        // 小测出分的难过 / 开心留得久一点
        ...(event.id.startsWith('quiz_score:') ? { halfLifeH: event.feel.kind === 'sad' || event.feel.kind === 'worry' ? 14 : 8 } : {}),
    }] : []));
}

/** 她那边的事：世界快照里能看到的（今天的），news 的几类 + 作业快到期 + 土豆 */
function worldAppraisals(world: WorldNow, now: number): Appraisal[] {
    const out: Appraisal[] = [];
    for (const news of worldNews(world, NEWS_KINDS)) {
        if (news.kind === 'camera') out.push({ id: `world:${news.id}`, at: news.at.getTime(), kind: 'joy', strength: 3, cause: news.what, source: 'world', halfLifeH: 14 });
        else if (news.kind === 'homework_done') out.push({ id: `world:${news.id}`, at: news.at.getTime(), kind: 'relief', strength: 2, cause: news.what, source: 'world' });
        else if (news.kind === 'friend_sick') out.push({ id: `world:${news.id}`, at: news.at.getTime(), kind: 'worry', strength: 1, cause: news.what, source: 'world' });
        else if (news.kind === 'friend_changed') out.push({ id: `world:${news.id}`, at: news.at.getTime(), kind: 'annoyed', strength: 1, cause: news.what, source: 'world' });
    }
    // 作业快到期了还没写完：18 小时内有点担心，6 小时内明显担心
    for (const homework of world.homework) {
        if (homework.done) continue;
        const due = homework.due.getTime();
        const name = homework.course ? `${homework.course}的作业` : '作业';
        if (due > now && due - now <= 18 * HOUR) out.push({ id: `world:hw18:${due}`, at: due - 18 * HOUR, kind: 'worry', strength: 1, cause: `${name}快到期了还没写完`, source: 'world', halfLifeH: 6 });
        if (due > now && due - now <= 6 * HOUR) out.push({ id: `world:hw6:${due}`, at: due - 6 * HOUR, kind: 'worry', strength: 2, cause: `${name}快到期了还没写完`, source: 'world', halfLifeH: 6 });
    }
    // 土豆：今天去喂了，见到 / 没见到
    const fed = world.cat && 'fed' in world.cat.today ? world.cat.today : undefined;
    if (world.cat && fed && fed.fed.getTime() <= now) {
        if (fed.seen === true) out.push({ id: `world:cat-seen:${world.day}`, at: fed.fed.getTime(), kind: 'joy', strength: 1, cause: `${world.cat.name}今天出来蹭你了`, source: 'world', halfLifeH: 3 });
        else if (fed.seen === false) out.push({ id: `world:cat-unseen:${world.day}`, at: fed.fed.getTime(), kind: 'worry', strength: 1, cause: `${world.cat.name}今天没出来`, source: 'world' });
    }
    return out;
}

/** 他做的事：哄她 / 想她、认真道歉、说他不舒服、有好事、她难过时晾了她很久、她发的话他一直没回 */
function historyAppraisals(history: readonly Said[], now: number): Appraisal[] {
    // 未来消息还没有改变等待/回应关系；无时间记录保留为未知，不能据此推断一直没回。
    history = history.filter(message => !(atOf(message) > now));
    const out: Appraisal[] = [];
    const seen = new Set<string>();
    const add = (appraisal: Appraisal) => { if (!seen.has(appraisal.id)) { seen.add(appraisal.id); out.push(appraisal); } };
    history.forEach((message, index) => {
        const at = atOf(message);
        if (!Number.isFinite(at) || at > now || now - at > HISTORY_WINDOW_MS) return;
        if (message.role !== 'user') return;
        const bucket = hourBucket(at);
        const warm = warmSignal(message.content);
        if (warm === 'affection') add({ id: `him:affection:${bucket}`, at, kind: 'joy', strength: 1, cause: '他说了想你 / 喜欢你', source: 'him', aboutHim: true, halfLifeH: 3 });
        else if (warm === 'comfort') add({ id: `him:comfort:${bucket}`, at, kind: 'relief', strength: 1, cause: '他在关心你、安慰你', source: 'him', aboutHim: true });
        else if (warm === 'repair') add({ id: `him:repair:${bucket}`, at, kind: 'relief', strength: 2, cause: '他在认真道歉、哄你', source: 'him', aboutHim: true, halfLifeH: 4 });
        // 他在哄她（“别难过”“抱抱”）不是他自己在难过：带了哄她 / 想她的话就不算他递情绪
        if (!warm && needsCareText(message.content)) add({ id: `him:down:${bucket}`, at, kind: 'worry', strength: 2, cause: '他说他难受 / 不舒服 / 累', source: 'him', aboutHim: true });
        if (goodNewsText(message.content)) add({ id: `him:good:${bucket}`, at, kind: 'joy', strength: 1, cause: '他有好消息', source: 'him', aboutHim: true, halfLifeH: 4 });
        // 她倾诉了几条，他隔了很久才回：他回来的那条消息的时刻（和 ADR 0074 的 ignoredNow 同一个判断）
        const before = history[index - 1];
        if (before?.role === 'assistant' && atOf(message) - atOf(before) >= IGNORED_GAP_MS && atOf(message) - atOf(before) <= IGNORED_MAX_MS
            && ignoredNow(history.slice(0, index + 1))) {
            add({ id: `him:ignored:${Math.floor(at / 60_000)}`, at, kind: 'sad', strength: 2, cause: '你难过的时候他隔了很久才回', source: 'him', aboutHim: true, halfLifeH: 5 });
        }
    });
    // 她发的话他一直没回：最后一条是她的，那串离现在 ≥ 4 小时，他前一句不是要走 / 去睡 / 去忙
    const last = history.at(-1);
    if (last?.role === 'assistant' && Number.isFinite(atOf(last))) {
        let start = history.length - 1;
        while (start > 0 && history[start - 1]!.role === 'assistant') start--;
        const hisLast = history[start - 1];
        const lastAt = atOf(last);
        const waitedUntil = lastAt + 4 * HOUR;
        if (hisLast && waitedUntil <= now && now - lastAt <= HISTORY_WINDOW_MS && !endingText(hisLast.content)) {
            add({ id: `him:silent:${Math.floor(lastAt / 60_000)}`, at: waitedUntil, kind: 'sad', strength: 1, cause: '你发的话他一直没回', source: 'him', aboutHim: true, halfLifeH: 6 });
        }
    }
    return out;
}

function momentAppraisals(moments: readonly Moment[]): Appraisal[] {
    return moments.flatMap(moment => {
        if (!validMoment(moment)) return [];
        const at = Date.parse(moment.at);
        return Number.isFinite(at) ? [{ id: `author:${moment.id}`, at, kind: moment.kind, strength: moment.strength, cause: moment.cause, source: 'author' as const, ...(moment.halfLifeH ? { halfLifeH: moment.halfLifeH } : {}) }] : [];
    });
}

/** 这一刻之前的所有评估（还没到的、散光了的不在这里过滤，feelingsAt 里算） */
export function appraisals(facts: FeelingFacts): Appraisal[] {
    return [
        ...(facts.world ? worldAppraisals(facts.world, facts.now) : []),
        ...(facts.world ? eventAppraisals(facts.world) : []),
        ...(facts.previousWorld ? eventAppraisals(facts.previousWorld) : []),
        ...historyAppraisals(facts.history, facts.now),
        ...momentAppraisals(facts.moments ?? []),
        ...(facts.extra ?? []),
    ];
}

// ───────── 当下的感受：评估按半衰期衰减后加起来 ─────────

export type Level = 'faint' | 'clear' | 'strong';

export interface Felt {
    kind: FeelingKind;
    weight: number;
    level: Level;
    /** 分量最大的那件事的来由（提示词里写的），和它的来源 */
    cause: string;
    source: Source;
    aboutHim: boolean;
}

const levelOf = (weight: number): Level => (weight >= STRONG ? 'strong' : weight >= CLEAR ? 'clear' : 'faint');

/** 某一刻她心里有哪些感受：分量从大到小，不到“刚能察觉”的不算 */
export function feelingsAt(list: readonly Appraisal[], now: number): Felt[] {
    if (!Number.isFinite(now)) return [];
    const byKind = new Map<FeelingKind, { weight: number; top: Appraisal; topWeight: number }>();
    for (const item of list) {
        if (!isObject(item) || typeof item.id !== 'string' || !item.id.trim() || !Number.isFinite(item.at)
            || !FEELING_KINDS.includes(item.kind) || ![1, 2, 3].includes(item.strength)
            || typeof item.cause !== 'string' || !item.cause.trim() || !['world', 'him', 'author'].includes(item.source)
            || (item.aboutHim !== undefined && typeof item.aboutHim !== 'boolean')) continue;
        if (item.at > now) continue;
        if (item.halfLifeH !== undefined && typeof item.halfLifeH !== 'number') continue;
        const halfLife = (item.halfLifeH ?? HALF_LIFE_H[item.kind]) * HOUR;
        if (!Number.isFinite(halfLife) || halfLife <= 0) continue;
        const age = now - item.at;
        if (age > halfLife * HALF_LIVES_KEPT) continue;
        const weight = AMPLITUDE[item.strength] * 0.5 ** (age / halfLife);
        const entry = byKind.get(item.kind);
        if (!entry) byKind.set(item.kind, { weight, top: item, topWeight: weight });
        else {
            entry.weight += weight;
            if (weight > entry.topWeight) { entry.top = item; entry.topWeight = weight; }
        }
    }
    return [...byKind]
        .map(([kind, { weight, top }]): Felt => {
            const capped = Math.min(KIND_CAP, weight);
            return { kind, weight: capped, level: levelOf(capped), cause: top.cause, source: top.source, aboutHim: Boolean(top.aboutHim) };
        })
        .filter(felt => felt.weight >= FAINT)
        .sort((a, b) => b.weight - a.weight);
}

/** 心里压着事的时候：回得短、不另起话题（让 contact.ts 的 low 用） */
export function feelsLow(felt: readonly Felt[]): boolean {
    const heavy = felt.some(item => (item.kind === 'sad' || item.kind === 'worry' || item.kind === 'tired' || item.kind === 'annoyed') && item.level !== 'faint');
    const gladStrong = felt.some(item => item.kind === 'joy' && item.level === 'strong');
    return heavy && !gladStrong;
}

// ───────── 说出来的尺度 ─────────

/** 她最近几条里已经说过这种感受了（3 小时内最后 6 条）：这一轮不再强调 */
const VOICED: Record<FeelingKind, RegExp> = {
    joy: /开心|高兴|太好了|激动|美滋滋|好耶/,
    relief: /松了口气|终于|可算|解脱/,
    worry: /担心|惦记|不放心|有点慌/,
    sad: /难过|想哭|哭了|哭|眼睛红|委屈|难受|不开心|低落|心里堵|\[大哭\]|\[快哭了\]|\[委屈\]/,
    annoyed: /烦|气死|无语|讨厌|火大/,
    tired: /累|困|没力气|懒得动/,
};

export function voicedKinds(history: readonly Said[], now: number): Set<FeelingKind> {
    const mine = history.filter(message => message.role === 'assistant' && now - atOf(message) >= 0 && now - atOf(message) <= 3 * HOUR).slice(-6);
    return new Set(FEELING_KINDS.filter(kind => mine.some(message => VOICED[kind].test(message.content))));
}

/** 她前面已经哭过 / 说想哭了（不再给“可以哭”的许可） */
export function criedRecently(history: readonly Said[], now: number): boolean {
    return history.filter(message => message.role === 'assistant' && now - atOf(message) >= 0 && now - atOf(message) <= 6 * HOUR).slice(-8)
        .some(message => /哭了|哭出来|掉眼泪|眼睛红|\[大哭\]|\[快哭了\]/.test(message.content));
}

/** 他这一轮在关心她、问她怎么了（她本来在忍，被一问就容易绷不住） */
export function asksAfterHer(text: string): boolean {
    return /怎么了|怎么啦|咋了|咋啦|你还好吗|还好吗|没事吧|不开心|不高兴|怎么回事|发生什么|出什么事|心情不好|你没事|抱抱|别难过|别哭|摸摸|心疼/.test(text);
}

interface Direction {
    /** “你…”：此刻心里是什么 */
    feel: string;
    /** 怎么露出来 */
    show: string;
}

/** 只给方向和边界，不给台词（ADR 0058：写出来的台词会被一字不差地抄） */
function direction(felt: Felt, userName: string, context: { melt: boolean; voiced: boolean; mayCry: boolean }): Direction | undefined {
    const cause = felt.cause;
    const strong = felt.level === 'strong';
    if (context.voiced && !(felt.kind === 'sad' && context.melt && context.mayCry)) {
        return { feel: `${FEELING_NAME[felt.kind]}（${cause}）`, show: '这件事你前面已经说过了，这一轮不用再提，带着这个状态接着聊就行' };
    }
    switch (felt.kind) {
        case 'joy':
            return strong
                ? { feel: `特别开心（${cause}）`, show: `藏不住：语气会飘，会连着说几句，想马上讲给${userName}听；别写成演出来的欢呼` }
                : { feel: `挺开心（${cause}）`, show: '语气轻快些，爱多说半句，有想分享的就分享；不用解释为什么开心' };
        case 'relief':
            return { feel: `松了口气（${cause}）`, show: '人是放松的，说话松松的，不用说出来' };
        case 'worry':
            return strong
                ? { feel: `很担心（${cause}）`, show: '有点心不在焉，忍不住想问一句；还是一两句，不说教、不反复问' }
                : { feel: `有点担心（${cause}）`, show: '不用主动讲，话题碰到或他问起才说，说一两句；惦记的可以问一句，别唠叨' };
        case 'sad': {
            const careful = felt.aboutHim ? '不翻旧账、不质问、不让他内疚' : '不怪他、不拿它压他';
            if (context.melt && context.mayCry) {
                return { feel: `心里难过（${cause}），一直在忍`, show: `${userName}这么一问你有点绷不住：可以先说“没事”，再露一点，忍不住就哭一下（说“哭了”“眼睛红了”，或带[快哭了]、[大哭]）；说完不用他解决，${careful}，不夸张` };
            }
            if (strong) {
                return { feel: `很难过（${cause}）`, show: context.mayCry
                    ? `话少，回得慢一点；撑不住时会哭（说“哭了”“眼睛红了”，或带[快哭了]、[大哭]），${userName}一关心更容易绷不住；不夸张、不演、不威胁、不要他保证什么，${careful}；他忙或要走就让他走`
                    : `话少，回得慢一点，人是低的；${careful}，不要他保证什么；他忙或要走就让他走` };
            }
            return { feel: `有点难过（${cause}）`, show: `回得淡一点、短一点；不主动提，嘴硬说“没事”也行，他认真问了就松口说半句；${careful}，不要他哄；他约你做什么，没心情就直说，不用硬撑着答应` };
        }
        case 'annoyed':
            return { feel: `有点烦（${cause}）`, show: `说话冲一点、没耐心；${userName}没惹你就别拿他出气；他约你做什么、让你帮什么，不想就直说，不用勉强` };
        case 'tired':
            return { feel: `累了（${cause}）`, show: '回得短，懒得展开；他要是约你做什么，没劲就直说今天不想动、想歇着，不用勉强答应' };
    }
}

/**
 * 时间块里的一行：此刻最明显的一两种感受和怎么露出来；没有就没有。
 * 最多两种（分量最大的，都要“明显”以上）；刚能察觉的（faint）不写。
 * melt：他这一轮在关心她（只对“难过”有用：她本来在忍，被一问就可以绷不住）；mayCry：前面没哭过
 */
export function describeFeelings(felt: readonly Felt[], userName: string, context: { melt: boolean; voiced: ReadonlySet<FeelingKind>; mayCry: boolean }): string | undefined {
    const shown = felt.filter(item => item.level !== 'faint').slice(0, 2);
    if (!shown.length) return undefined;
    const parts = shown.flatMap(item => {
        const part = direction(item, userName, { melt: context.melt, voiced: context.voiced.has(item.kind), mayCry: context.mayCry });
        return part ? [part] : [];
    });
    if (!parts.length) return undefined;
    return `[你此刻的心境（有来由的，不是演的）：${parts.map(part => `${part.feel}。${part.show}`).join('；另外，')}。不用解释自己的状态，也别每句都带情绪；事实以上面写的为准，没写的别编]`;
}

// ───────── 作者写下的事：runtime/bot/moments.json ─────────

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function validCause(value: unknown): value is string {
    if (typeof value !== 'string') return false;
    let count = 0;
    for (const _ of value) if (++count > 60) return false;
    let meaningful = 0;
    for (const _ of value.trim()) if (++meaningful >= 2) return true;
    return false;
}

export function validMoment(value: unknown): value is Moment {
    return isObject(value) && typeof value.id === 'string' && /^[\w-]{1,40}$/.test(value.id)
        && stateTimestamp(value.at)
        && FEELING_KINDS.includes(value.kind as FeelingKind)
        && (value.strength === 1 || value.strength === 2 || value.strength === 3)
        && validCause(value.cause)
        && (value.halfLifeH === undefined || (typeof value.halfLifeH === 'number' && value.halfLifeH > 0 && value.halfLifeH <= 72));
}

export function validMoments(value: unknown): value is { moments: Moment[] } {
    if (!isObject(value) || !Array.isArray(value.moments) || !value.moments.every(validMoment)) return false;
    return new Set(value.moments.map(moment => (moment as Moment).id)).size === value.moments.length;
}
