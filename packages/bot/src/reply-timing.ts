// 回复时机（ADR 0007 决策 4–7）：没回的消息她什么时候看到、每条打字多久、收尾之后的附和不回。
// 档位的节奏系数（ADR 0013 决策 1）：冷场时多久看到、打字多久乘它，越疏越慢；正聊着照样马上看到。
// 看心情不回（ADR 0013 决策 4）：正聊着、对方这一串只是「哈哈」「嗯」这类反应，按概率不回；隔一分钟以上再来一条一定回。
// 他发了语音（ADR 0052）：看到之后一条条听完才回，听的时间加在看到的时刻上；在上课不听（看转出来的字，或者让他打字）。
// 都是纯函数，按聊天记录和时间算；随机的部分按消息 id 定下来，同一串消息重算多少次都一样（调度在 responder.ts，等待期间来新消息会重算）。

import { detectCrisis } from './crisis.ts';
import type { StoredMessage } from './history.ts';
import { listenMs, parseVoiceLine } from './media.ts';
import { KNOWN_FACE } from './qq-faces.ts';
import { stateAt, type Schedule } from './schedule.ts';

/** 她这么久之内发过消息算正聊着，不加冷场延迟 */
export const HOT_MS = 10 * 60_000;
/** 冷场时过多久看到 */
export const COLD_DELAY_MS: Range = [15_000, 60_000];
/** 起床后过多久看到夜里的消息 */
export const AFTER_WAKE_MS: Range = [0, 30 * 60_000];
/** 上课时还没到看手机的时候先下课了：下课后过多久看到 */
export const AFTER_CLASS_MS: Range = [30_000, 120_000];
/** 忙完（洗完澡）之后过多久看到手机（ADR 0031） */
export const AFTER_BUSY_MS: Range = [60_000, 180_000];
/** 男朋友档睡着时被吵醒：15 分钟内到了第 3 条，或者隔了 2 分钟以上又来一条（都在 15 分钟内） */
export const WAKE_UP_WINDOW_MS = 15 * 60_000;
export const WAKE_UP_COUNT = 3;
export const WAKE_UP_GAP_MS = 2 * 60_000;
/** 夜里的消息起床后照样回（bot 重启后的补回不受 3 小时的限制），超过这么久就不回了 */
export const NIGHT_CATCH_UP_MS = 12 * 3_600_000;
/** 档位节奏系数能取多少（卡上的 extensions.qqbot.pace，和转换器的 PACE_MIN / PACE_MAX 一致） */
export const PACE_RANGE: Range = [0.5, 3];
/** 看心情不回的概率：系数 1 时这么多，乘节奏系数，最多 MOODY_MAX_CHANCE */
export const MOODY_CHANCE = 0.15;
export const MOODY_MAX_CHANCE = 0.35;
/** 一串：从第一条起这么久之内的消息算一串（一起不回）；之后再来的一定回 */
export const MOODY_BURST_MS = 60_000;

type Range = readonly [min: number, max: number];

export interface Seen {
    /** 毫秒时间戳：到这时才看到；不晚于现在就是已经看到了 */
    at: number;
    /** 日志里说明为什么是这个时候 */
    reason: string;
    /** 睡着时被消息吵醒（这次生成的状态写迷迷糊糊） */
    woken?: boolean;
    /** 这次最多回几条（上课时） */
    maxBubbles?: number;
}

export interface TimingOptions {
    schedule: Schedule;
    /** 睡着时连着发能把她吵醒，一晚最多一次（男朋友档，决策 6） */
    wakeable: boolean;
    /** 档位的节奏系数，默认 1 */
    pace?: number;
    /** 这一刻在忙、看不了手机（ADR 0031：洗澡），忙到什么时候；不传就没有 */
    busy?: (now: number) => { until: number; reason: string } | undefined;
    /**
     * 她在聊天里说过「睡了」（ADR 0042，对谁说的都算）：从那一刻（since）起在睡，睡到 until；不传或没说过就按作息。
     * 吵醒的规则照旧（男朋友连着发），一晚从她说完那一刻算起
     */
    asleep?: (now: number) => { since: number; until: number } | undefined;
    /** 回复延迟的长尾（ADR 0105，配置 lagTail）：醒着、空着的时候，有一部分消息她在做别的，过一会儿才看到 */
    lagTail?: boolean;
}

/** 判断附和、收尾只要角色和内容（聊天记录、提示词里的消息都行） */
type Said = { role: 'user' | 'assistant'; content: string };

/** 她上次回复之后对方发的消息（没回的） */
export function unansweredMessages<T extends Said>(history: T[]): T[] {
    return history.slice(history.findLastIndex(m => m.role === 'assistant') + 1).filter(m => m.role === 'user');
}

/**
 * 这次要回的那一串：没回的消息去掉开头那几句收尾后的附和——那几句已经按「不回」处理过（决策 7），
 * 对方隔了很久才说下一句时，这一串从那句算起（什么时候看到、冷场延迟、时间块都按它）。只有附和时为空。
 */
export function pendingMessages<T extends Said>(history: T[]): T[] {
    const unanswered = unansweredMessages(history);
    if (!closedByHer(history)) return unanswered;
    const firstNew = unanswered.findIndex(m => !isAck(m.content));
    return firstNew < 0 ? [] : unanswered.slice(firstNew);
}

/** 没回的这一串她什么时候看到；没有没回的消息返回 undefined */
export function whenSeen(history: StoredMessage[], now: number, options: TimingOptions): Seen | undefined {
    const pending = pendingMessages(history);
    if (pending.length === 0) return undefined;
    const { schedule } = options;
    const first = Date.parse(pending[0]!.time);
    const seed = String(pending[0]!.messageId ?? pending[0]!.time);
    const state = stateAt(schedule, new Date(now));
    const { activity } = state;
    // 他说了想伤害自己的话（ADR 0068 决策 4）：睡觉、上课、洗澡都不等，马上看到——不让一个说想不开的人等到起床。
    // 用「安全」换掉一点「像人」；睡着的话被吵醒（沿用 0007 决策 6 的迷迷糊糊），所有档位都一样，不受「一晚最多吵醒一次」限制
    if (detectCrisis(pending.map(message => message.content).join('\n'))) {
        const asleep = activity.kind === 'sleep' || Boolean(options.asleep?.(now));
        return { at: now, reason: asleep ? '睡着了，被他说的不好的话吵醒' : '他说了想伤害自己的话，马上看到', ...(asleep ? { woken: true } : {}), maxBubbles: 3 };
    }
    // 她说过「睡了」（ADR 0042）：从说完那一刻起算睡着，不等作息上的入睡时刻
    const said = options.asleep?.(now);

    if (activity.kind === 'sleep' || said) {
        // 说完「睡了」的那几条本身不算她醒着回过（since 之后才算）
        const sleepStart = said ? said.since + 1 : atTime(new Date(now), schedule.sleep);
        const until = activity.kind === 'sleep' ? activity.until.getTime() : said!.until;
        if (options.wakeable && !history.some(m => m.role === 'assistant' && Date.parse(m.time) >= sleepStart)) {
            const nightly = pending.map(m => Date.parse(m.time)).filter(t => t >= sleepStart);
            const woke = wakeUpTime(nightly);
            if (woke !== undefined) return listened(pending, { at: woke, reason: '睡着了，被连着来的消息吵醒', woken: true, maxBubbles: 1 });
        }
        return listened(pending, { at: until + pick(seed, 'wake', AFTER_WAKE_MS), reason: said && activity.kind !== 'sleep' ? '说了睡了，在睡觉，起床后看到' : '在睡觉，起床后看到' });
    }

    if (activity.kind === 'class') {
        const { lesson } = activity;
        const kind = schedule.kinds[lesson.kind];
        if (kind.seeAfterMin) {
            const [min, max] = kind.seeAfterMin;
            const base = Math.max(first, lesson.start.getTime());
            const during = base + pick(seed, 'class', [min * 60_000, max * 60_000]);
            const after = lesson.end.getTime() + pick(seed, 'after-class', AFTER_CLASS_MS);
            return {
                at: Math.min(during, after),
                reason: `在上${kind.label ?? '课'}`,
                ...(kind.maxBubbles ? { maxBubbles: kind.maxBubbles } : {}),
            };
        }
    }

    // 在忙得看不了手机（ADR 0031：洗澡）：忙完一两分钟才看到，正聊着也一样
    const busy = options.busy?.(now);
    if (busy) return listened(pending, { at: Math.max(first, busy.until) + pick(seed, 'busy', AFTER_BUSY_MS), reason: busy.reason });

    // 空闲、课间、水课、体育：正聊着马上看到，冷场过一会儿
    const lastReply = history.findLast(m => m.role === 'assistant');
    const hot = Boolean(lastReply && first - Date.parse(lastReply.time) <= HOT_MS);
    // 分心的延迟（ADR 0105）：在她手里的这一刻之外再加一段，真人回消息的延迟是长尾的
    const lag = options.lagTail
        ? distractionMs(seed, {
            hot,
            rapid: Boolean(lastReply && first - Date.parse(lastReply.time) <= RAPID_MS),
            careful: pending.some(message => CARE_NOW.test(message.content)),
            hour: new Date(first).getHours(),
        })
        : undefined;
    const base = hot ? first : first + Math.round(pick(seed, 'cold', COLD_DELAY_MS) * (options.pace ?? 1));
    const reason = hot ? '正聊着' : '冷场，过一会儿才看到';
    if (lag) return listened(pending, { at: base + lag, reason: `${reason}；在做别的，${minutesText(lag)}才看到` });
    return listened(pending, { at: base, reason });
}

/** 一来一回很快的（她上一次回复离他这一串不到这么久）：手一直在手机上，不容易分心 */
export const RAPID_MS = 90_000;
/** 他在难受 / 不舒服 / 问她在不在：她会更快看到 */
const CARE_NOW = /难过|难受|不舒服|烦死|累死|哭|崩溃|生病|发烧|疼|在吗|在不在|人呢|喂[？?]?$/;

/**
 * 分心的延迟（ADR 0105，配置 lagTail）。真人回消息的延迟是长尾的：公开数据里 WhatsApp 111 个人的回复只有 57.8% 在 1 分钟内
 * （arXiv 1802.03393），她原来醒着空着时 100% 在十几秒内。这里按第一条没回的消息的 id 定下来（同一串重算多少次都一样）：
 * 一来一回很快时 10% 分心、正聊着 30%、冷场 45%（夜里 23 点以后手在手机上，打八折；他在难受 / 问她在不在，打四折且不超过 1 分钟）；
 * 分心了：55% 20–75 秒、28% 1.5–5 分钟、13% 5–20 分钟、4% 20–60 分钟。没分心就是 0。
 */
export function distractionMs(seed: string, context: { hot: boolean; rapid: boolean; careful: boolean; hour: number }): number | undefined {
    let chance = context.rapid ? 0.1 : context.hot ? 0.3 : 0.45;
    if (context.hour >= 23 || context.hour < 2) chance *= 0.8;
    if (context.careful) chance *= 0.4;
    if (unit(`${seed} lag`) >= chance) return undefined;
    const u = unit(`${seed} lag size`);
    const ms = u < 0.55 ? pick(seed, 'lag-a', [20_000, 75_000])
        : u < 0.83 ? pick(seed, 'lag-b', [90_000, 300_000])
            : u < 0.96 ? pick(seed, 'lag-c', [300_000, 1_200_000])
                : pick(seed, 'lag-d', [1_200_000, 3_600_000]);
    return context.careful ? Math.min(ms, 60_000) : ms;
}

function minutesText(ms: number): string {
    return ms < 90_000 ? `${Math.round(ms / 1000)} 秒后` : `${Math.round(ms / 60_000)} 分钟后`;
}

/** 这一串里的语音一条条听完（ADR 0052）：从看到的时刻起，每条从它到了之后开始听；没有语音原样返回 */
function listened(pending: StoredMessage[], seen: Seen): Seen {
    let at = seen.at;
    let total = 0;
    for (const message of pending) {
        const ms = listenMs(message.content);
        if (!ms) continue;
        at = Math.max(at, Date.parse(message.time)) + ms;
        total += ms;
    }
    return total ? { ...seen, at, reason: `${seen.reason}，听完语音（${Math.round(total / 1000)} 秒）` } : seen;
}

/** 睡着以后的消息时间（从早到晚）：第几条把她吵醒，返回那一条的时间 */
export function wakeUpTime(times: number[]): number | undefined {
    for (const [k, t] of times.entries()) {
        const recent = times.slice(0, k + 1).filter(x => t - x < WAKE_UP_WINDOW_MS);
        if (recent.length >= WAKE_UP_COUNT) return t;
        if (recent.some(x => t - x >= WAKE_UP_GAP_MS)) return t;
    }
    return undefined;
}

/**
 * 一条的打字时间（手机上）：0.6 秒起手 + 每字 0.18 秒，限制在 0.9–9 秒，±30% 抖动（按内容定，同一句每次一样），再乘档位的节奏系数。
 * 10-18 线上 339 次热聊回复：第一条离他最后一条的延迟中位 6.3 秒、p90 12.7 秒，回 ≤8 字 6.0 秒、回 ≥20 字 7.9 秒——不管回多长都差不多快（原来 0.8 秒 + 每字 0.1 秒、封顶 4 秒，再被生成时间盖住）
 */
export function typingMs(text: string, pace = 1): number {
    const base = Math.min(9000, Math.max(900, 600 + 180 * [...text].length));
    return Math.round(base * (0.7 + 0.6 * unit(text)) * pace);
}

/** 上线前的老样子（没开 rhythm 时用）：0.8 秒 + 每字 0.1 秒，限制在 1–4 秒，±20% 抖动，再乘档位的节奏系数；没有「看 + 想」 */
export function legacyTypingMs(text: string, pace = 1): number {
    const base = Math.min(4000, Math.max(1000, 800 + 100 * [...text].length));
    return Math.round(base * (0.8 + 0.4 * unit(text)) * pace);
}

/** 回复器用的打字 / 「看 + 想」时间（配置 rhythm）：开了是按字数的新节奏加「看 + 想」，不开是上线前的老样子（没有「看 + 想」） */
export function replyDelays(rhythm: boolean, pace = 1): { typingMs(text: string): number; thinkMs?(text: string): number } {
    return rhythm
        ? { typingMs: text => typingMs(text, pace), thinkMs: text => thinkMs(text, pace) }
        : { typingMs: text => legacyTypingMs(text, pace) };
}

/**
 * 看到消息之后、开始打字之前的「看 + 想」（只在回他的消息时有，主动找他时没有）：多半 0.8–3.5 秒（80%），有时 3.5–10 秒（15%），偶尔 10–28 秒（5%，看别的去了）；
 * 回三个字以内的更快（×0.6）。按内容定，同一句每次一样，再乘档位的节奏系数。第一条真正发出去的时刻 = 看到 + 看想 + 打字，生成花掉的时间算在里面
 */
export function thinkMs(text: string, pace = 1): number {
    const u = unit(`${text} think`);
    const base = u < 0.8 ? 800 + 2700 * (u / 0.8) : u < 0.95 ? 3500 + 6500 * ((u - 0.8) / 0.15) : 10_000 + 18_000 * ((u - 0.95) / 0.05);
    return Math.round(base * ([...text].length <= 3 ? 0.6 : 1) * pace);
}

// 收尾：她上一次说的话里有这些（晚安、去忙吧……）
const CLOSING = /晚安|睡吧|早点睡|去睡|先睡|去吧|去忙|先忙|忙吧|拜拜|回头聊|明天聊|明天见/;
// 附和：去掉表情占位符、标点、emoji 之后只剩这些
const ACK = /^(?:嗯+|恩+|好+|好的|好滴|好哒|哦+|噢+|喔+|ok+|行|收到|晚安+|安安|拜拜?|88|明天见)+$/i;

/** 她已经收尾，之后对方发的全是附和（决策 7）：不回 */
export function isAckAfterClosing(history: Said[]): boolean {
    return closedByHer(history) && unansweredMessages(history).length > 0 && pendingMessages(history).length === 0;
}

/** 她最后一次回复是收尾的话 */
function closedByHer(history: Said[]): boolean {
    const lastReply = history.findLastIndex(m => m.role === 'assistant');
    if (lastReply < 0) return false;
    // 她最后一次回复可能拆成了几条
    let start = lastReply;
    while (start > 0 && history[start - 1]!.role === 'assistant') start--;
    return CLOSING.test(history.slice(start, lastReply + 1).map(m => m.content).join('\n'));
}

export function isAck(text: string): boolean {
    // 语音、图片（ADR 0052）：转出了字的语音按他说的话算（「[语音 2秒：嗯嗯]」是附和，「[语音 5秒：我还有个事]」不是）；
    // 没转出来的语音、照片不知道里面是什么，不算附和，照样回（10-10 模拟器：前一晚道了晚安，第二天上课时来一条语音，被当成附和没回）
    const voice = parseVoiceLine(text);
    if (voice) return voice.text ? isAck(voice.text) : false;
    if (/^\s*\[图片[\]，：]/.test(text)) return false;
    const stripped = text.replace(/\[[^\]]*\]/g, '').replace(/[\p{P}\p{S}\p{Extended_Pictographic}\s～~]/gu, '');
    // 只有表情也算附和
    if (!stripped) return text.trim().length > 0;
    return ACK.test(stripped);
}

// 反应：去掉表情（QQ 小黄脸「[捂脸]」、[表情]、[动画表情]、emoji）和标点之后只剩这些。晚安、拜拜不在里面（要回）
const REACTION = /^(?:嗯+|恩+|好+|好的|好滴|好哒|哦+|噢+|喔+|ok+|行|收到|哈+|嘿+|嘻+|呵+|h+|233+|6+|笑死|草|绝了|确实|是的|对的?|对啊|对呀|可以|不错|好耶|牛)+$/i;

/**
 * 这条只是个反应（「哈哈」「嗯嗯」「确实」、表情），不回也说得过去。问句不算；图片、语音、视频、戳一戳都不算
 * （不知道里面是什么，照样回）；表情包按它的名字算（[是的] 算，[动画表情] 算）；
 * QQ 小黄脸按名字认（ADR 0051：「[捂脸]」单独一条照旧算），「[疑问]」「[问号脸]」和问号一样不算
 */
export function isReaction(text: string): boolean {
    if (/[?？]|\[(?:疑问|问号脸)\]/.test(text)) return false;
    const stripped = text.replace(KNOWN_FACE, '').replace(/[\p{P}\p{S}\p{Extended_Pictographic}\s～~]/gu, '');
    if (!stripped) return text.trim().length > 0;
    return REACTION.test(stripped);
}

/**
 * 看心情不回（ADR 0013 决策 4）：她正和对方聊着（这一串第一条离她上次回复不到 HOT_MS），这一串全是反应，
 * 而且都在第一条之后 MOODY_BURST_MS 之内；按第一条的 id 定下来，概率 MOODY_CHANCE × 节奏系数（最多 MOODY_MAX_CHANCE）。
 * 不回的这一串之后，隔一分钟以上再来的消息让这一串跨过 MOODY_BURST_MS，一定回（连带前面没回的一起看）。返回不回的原因。
 * chance 只给模拟器用（场景的 moodyChance：定成 1 看不回之后的样子）
 */
export function moodySkip(history: StoredMessage[], pace = 1, chance = Math.min(MOODY_MAX_CHANCE, MOODY_CHANCE * pace)): string | undefined {
    const pending = pendingMessages(history);
    const lastReply = history.findLast(m => m.role === 'assistant');
    if (pending.length === 0 || !lastReply) return undefined;
    const first = Date.parse(pending[0]!.time);
    if (first - Date.parse(lastReply.time) > HOT_MS) return undefined;
    if (Date.parse(pending.at(-1)!.time) - first > MOODY_BURST_MS) return undefined;
    if (!pending.every(m => isReaction(m.content))) return undefined;
    if (unit(`${pending[0]!.messageId ?? pending[0]!.time} moody`) >= chance) return undefined;
    return '看心情没回：这一串只是「哈哈」「嗯」这类反应（隔一分钟以上再来一条一定回）';
}

/** 第一条没回的消息是她睡着时发来的，现在还在 NIGHT_CATCH_UP_MS 之内：起床后照样回（bot 重启后的补回用） */
export function arrivedWhileAsleep(history: StoredMessage[], now: number, schedule: Schedule): boolean {
    const first = pendingMessages(history)[0];
    if (!first) return false;
    const time = Date.parse(first.time);
    return now - time <= NIGHT_CATCH_UP_MS && stateAt(schedule, new Date(time)).activity.kind === 'sleep';
}

/** 当天的 HH:MM */
function atTime(day: Date, time: string): number {
    const [h, m] = time.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();
}

/** 按种子在范围里取一个值（主动消息的时刻也用它，ADR 0011） */
export function pick(seed: string, purpose: string, [min, max]: Range): number {
    return Math.round(min + (max - min) * unit(`${seed} ${purpose}`));
}

/** 字符串 → [0, 1)（FNV-1a） */
function unit(text: string): number {
    let h = 0x811c9dc5;
    for (const ch of text) {
        h ^= ch.codePointAt(0)!;
        h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h / 2 ** 32;
}
