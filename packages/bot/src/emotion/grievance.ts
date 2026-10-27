// 有起因的小别扭与和好（ADR 0074，选项 D2；用户 2026-10-15 说「直接做 D2」）。
// 起因只有一个具体的事件：他隔了 ≥ 3 天才来，而这几天她发给他的话一直没回。她回来的头一两轮淡一点、点一句，他一解释 / 道歉 / 哄，她就软下来。
// 和 ADR 0028 一样不落盘：每一轮都从聊天记录里的时间戳和原话重算，重启、隔几天之后得到的是同一个结果；没有「她生气了」这样的字段。
// 一次最多动一档：只有「小别扭」一档，没有升级、没有冷战；不在他难过 / 生病、说收尾、要她哄、说了想念或道歉的时候出现。

import { warmSignal } from './affect.ts';
import type { StoredMessage } from '.././history.ts';

type Said = Pick<StoredMessage, 'role' | 'content'> & { time?: string | undefined };

/** 消息的时间（毫秒）；没有时间的消息是 NaN，所有比较都不成立，等于不算 */
const at = (message: Said) => Date.parse(message.time ?? '');

/** 他两条消息之间隔这么久才算「隔了很多天」 */
export const GRIEVANCE_GAP_MS = 72 * 3_600_000;
/** 他回来以后，她最多别扭这么多轮（之后不管有没有哄都散了：人不会一直别扭） */
export const GRIEVANCE_ROUNDS = 2;
/** 他回来后这么久之内才算同一次（隔了一晚上再来，不接着上一次的别扭） */
export const GRIEVANCE_WINDOW_MS = 3 * 3_600_000;

export type GrievanceStage = 'sulk' | 'makeup';
/** 起因：away = 他隔了好几天才来（原来的）；ignored = 她倾诉了几条，他隔了很久才回（10-20 用户说「应该要生气，责怪对方玩游戏不理自己」） */
export type GrievanceCause = 'away' | 'ignored';

export interface Grievance {
    stage: GrievanceStage;
    /** 他隔了几整天才来 */
    days: number;
    /** 他回来以后她已经完整回过几轮（别扭的第几轮） */
    round: number;
    /** 不写就是 away */
    cause?: GrievanceCause;
}

// 他先说过要消失几天：不是被晾着，不别扭
const NOTICE = /这几天.{0,6}(?:忙|不在|出差|考试|没空|没法|不方便)|(?:忙|消失)(?:几天|一阵|一周)|考试周|要出差|出差(?:去|了)|回老家|没网|下周.{0,4}(?:忙|考试|出差|不在)|期末/;
// 他解释了为什么这几天没动静：也算修补
const EXPLAIN = /这几天(?:太|特别|真的|一直)?忙|最近(?:太|特别|真的|一直)?忙|忙(?:死|疯|晕|懵)了|没顾上|没看手机|手机(?:没电|坏了|丢了|摔了)|赶(?:论文|作业|项目|报告|ddl)|考试周|出差|住院|生病了|发烧|没网|断网/;
const EXTRA_REPAIR = /不好意思|怪我|我的错|错了错了/;

/** 他这句话是不是在道歉 / 解释 / 哄 / 说想念——任何一样都算修补 */
export function isRepairText(text: string): boolean {
    return warmSignal(text) !== undefined || EXPLAIN.test(text) || EXTRA_REPAIR.test(text);
}

const DAY_MS = 86_400_000;
/** 她连着发的话，相隔这么久就算两串 */
const BURST_GAP_MS = 20 * 60_000;

/**
 * 这段间隔里她发出去、没人回的有几串：第一串是对他最后一句话的回复，不算；之后另起一串（她主动发的）才是发了没人回。
 */
function unansweredBursts(between: readonly Said[]): number {
    let bursts = 0;
    let last = -Infinity;
    for (const message of between) {
        if (message.role !== 'assistant') continue;
        const time = at(message);
        if (!(time - last <= BURST_GAP_MS)) bursts++;
        last = time;
    }
    return Math.max(0, bursts - 1);
}

/**
 * 这一轮她该不该有一点小别扭 / 该不该和好；history 是这个人的聊天记录（包含他这一轮已经发来的、她还没回的话）。
 * 主动找他时（没有待回的话）返回 undefined。
 */
export function grievanceNow(history: readonly Said[]): Grievance | undefined {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const turnStart = lastReply + 1;
    if (turnStart >= history.length) return undefined;
    const users: number[] = [];
    history.forEach((message, index) => { if (message.role === 'user') users.push(index); });

    // 最近一次「隔了很多天」的回来：他的两条消息之间 ≥ 3 天，而且这几天里她发过话（发了没人回）
    let back = -1;
    let gap = 0;
    for (let k = users.length - 1; k >= 1; k--) {
        const before = history[users[k - 1]!]!;
        const after = history[users[k]!]!;
        const span = at(after) - at(before);
        if (!(span >= GRIEVANCE_GAP_MS)) continue;
        const leftHanging = unansweredBursts(history.slice(users[k - 1]! + 1, users[k]!)) > 0;
        // 只看最近的那一次大间隔：它不成立，更早的就更不相干
        if (!leftHanging) return undefined;
        const notified = users.slice(Math.max(0, k - 3), k).some(index => NOTICE.test(history[index]!.content));
        if (notified) return undefined;
        back = users[k]!;
        gap = span;
        break;
    }
    if (back < 0) return undefined;

    // 隔了一阵再来的，不接着上一次的别扭
    const latest = history.at(-1)!;
    if (!(at(latest) - at(history[back]!) <= GRIEVANCE_WINDOW_MS)) return undefined;

    // 3 天 23 小时说「4 天」，3 天零几小时说「3 天」
    const days = Math.round(gap / DAY_MS);
    const mine = users.filter(index => index >= back);
    const repairs = mine.filter(index => isRepairText(history[index]!.content));
    let rounds = 0;
    let inReply = false;
    for (let i = back + 1; i < history.length; i++) {
        if (history[i]!.role === 'assistant') {
            if (!inReply) rounds++;
            inReply = true;
        } else {
            inReply = false;
        }
    }

    if (back >= turnStart) {
        // 他这一串里带着道歉 / 解释 / 哄：不别扭（余温交给 ADR 0028）
        return repairs.length ? undefined : { stage: 'sulk', days, round: 0 };
    }
    const repairedNow = repairs.some(index => index >= turnStart);
    const repairedBefore = repairs.some(index => index < turnStart);
    if (repairedNow) return repairedBefore ? undefined : { stage: 'makeup', days, round: rounds };
    if (repairedBefore) return undefined;
    return rounds < GRIEVANCE_ROUNDS ? { stage: 'sulk', days, round: rounds } : undefined;
}

/** 他隔了这么久才回她前面发的话，才算「被晾着」（再短是正常回得慢） */
export const IGNORED_GAP_MS = 45 * 60_000;
/** 隔得再久（超过这么久）就不是「刚才被晾着」了：睡一觉再回、第二天才看到，不在这一档里算 */
export const IGNORED_MAX_MS = 6 * 3_600_000;
/** 她那一串话里至少有一句是在说自己的感受：难过、烦、委屈、被骂、累。「人呢」「睡了没」这类打招呼不算——她睡前主动发的那条没人回，不能被当成被晾着 */
const FEELING = /烦|难受|难过|委屈|不开心|不高兴|郁闷|崩溃|气死|累死|心累|心情不好|被(?:老师|老板|导师|领导|教授)?(?:骂|批评|说了|训)|哭了|想哭/;

/** 他已经在道歉或安慰她了（不含「没看手机」这类解释） */
const APOLOGY_OR_COMFORT = /对不起|抱歉|不好意思|我错了|错了错了|怪我|我的错|别生气|别气|不气|哄你|哄哄|抱抱|摸摸|乖|心疼|辛苦了|别难过|别烦/;

/**
 * 她倾诉了几条（难过 / 烦的时候），他隔了 45 分钟到 6 小时才回，回来时还没哄她：这一轮她可以直接说他一两句。
 * 和 grievanceNow 一样不落盘，每一轮从聊天记录的时间戳和原话重算；只在他回来后她的第一次回复触发（回过之后就没有了）。
 */
export function ignoredNow(history: readonly Said[]): Grievance | undefined {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    const turnStart = lastReply + 1;
    if (lastReply < 0 || turnStart >= history.length) return undefined;
    const first = history[turnStart]!;
    if (first.role !== 'user') return undefined;
    const gap = at(first) - at(history[lastReply]!);
    if (!(gap >= IGNORED_GAP_MS && gap <= IGNORED_MAX_MS)) return undefined;
    // 她连着发出去、没人回的一串
    let start = lastReply;
    while (start > 0 && history[start - 1]!.role === 'assistant') start--;
    const stretch = history.slice(start, lastReply + 1);
    if (stretch.length < 2) return undefined;
    if (!(at(first) - at(stretch[0]!) <= IGNORED_MAX_MS)) return undefined;
    if (!stretch.some(message => FEELING.test(message.content))) return undefined;
    // 他回来的这一串里已经在道歉 / 哄：交给「先嘴硬再软」的通用态度，不再另加别扭。
    // 只认道歉和安慰，不认「没看手机」「在忙」这类解释——解释多半是借口（10-20 留出题 h01：他说「刚才跟人开黑没看手机」，
    // 被 isRepairText 当成已经在解释，她没发火还答歪了）；真有正当理由（手机没电、在医院）模型读他的话自然会软下来
    const comingBack = history.slice(turnStart).filter(message => message.role === 'user');
    if (comingBack.some(message => APOLOGY_OR_COMFORT.test(message.content))) return undefined;
    return { stage: 'sulk', days: 0, round: 0, cause: 'ignored' };
}

/** 意图行里的标记：contact.ts 认这两个词来限条数；出口检查也按它放宽（和 CRISIS_MARK 同一个办法） */
export const SULK_MARK = '小别扭';
export const MAKEUP_MARK = '气顺了';

/**
 * 只给方向和边界，不给台词（ADR 0058：写出来的台词会被一字不差地抄）。
 * 第一轮淡一点、点一句；第二轮自然回暖；他一哄就软下来。
 */
export function describeGrievance(grievance: Grievance): string {
    if (grievance.stage === 'makeup') {
        return `[这一轮你想：他在道歉、解释或者哄你，你${MAKEUP_MARK}：软下来，明显是原谅他了，接他解释的那件事（他说忙什么就关心什么）；嘴硬最多半句，他给的理由你就信，不拿它酸他，也不说他把别的看得比你重要；不再翻这件事，不要求他保证什么，也不要太郑重或煽情，接着像平常一样聊]`;
    }
    if (grievance.cause === 'ignored') {
        return `[这一轮你想：你前面发了几条（你烦 / 难过的时候），他到现在才看到你前面发的，还没哄你。你心里有点委屈和火——这一轮可以直接说他一两句，怪他不理你（他去忙别的、打游戏了）；口气是${SULK_MARK}式的委屈带点冲，不是真吵架。不翻旧账、不冷战、不长篇大论、不质问到底、不让他内疚；同一件事只提这一次。他认错、解释或者哄你，就自然软下来，嘴上还可以再硬半句]`;
    }
    const lasted = grievance.days >= 2 ? ` ${grievance.days} 天` : '好几天';
    if (grievance.round === 0) {
        return `[这一轮你想：他已经${lasted}没来找你了，你之前发给他的也一直没回。你心里有一点${SULK_MARK}——不是真生气，更不是冷战：这一轮回得比平时淡一点、短一点，带一句有来由的小抱怨（点到他这些天没动静就够），不翻旧账、不质问、不说教、不让他内疚，同一件事只提这一次。他问什么还是照常答；他要是解释了、道歉了或者哄你，就自然软下来]`;
    }
    return `[这一轮你想：他回来有一阵了，你那点${SULK_MARK}还没完全散，但别越来越冷：这一轮自然回暖一些，不再提他这些天没来的事，除非他自己提]`;
}
