import { localDate } from '../local-date.ts';
// 她在 QQ 上「有个人在」的几处对外可见的小事（ADR 0083）：在线状态、给他的资料卡点赞、个性签名、QQ 空间说说。
// 都是 NapCat 的扩展动作（set_online_status / send_like / set_self_longnick / send_qzone_msg），都有各自的开关，默认关。
// 这个文件是纯规则 + 一个每分钟看一眼的小循环（createPresence）；「回复他的消息时」的两件事（已读、表情回应）在 responder 里。
// 时刻、概率都按日期哈希定（同一天每次一样，重启不重来），已经做过的记在 <dataDir>/presence/presence.json。

import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonOr, writeJsonAtomic } from '../memory/json-file.ts';
import { feedDigest, type QzoneFeed, type QzoneItem } from './qzone-feed.ts';
import { sampleLines, strangerDigest, type StrangerFeed } from './qzone-strangers.ts';
import { pick } from './reply-timing.ts';
import { logBody } from '../platform/sensitive.ts';
import { formatDate, herDay, stateAt, type Activity, type ExtraFreeActivity, type Schedule } from '../life/schedule.ts';

/** 关 / 只写草稿不发（签名、说说）/ 开 */
export const PRESENCE_MODES = ['off', 'dryRun', 'on'] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];

export const QZONE_VISIBILITIES = ['friends', 'public'] as const;
export type QzoneVisibility = (typeof QZONE_VISIBILITIES)[number];

// ───────── 在线状态 ─────────

export interface OnlineStatus {
    /** NapCat set_online_status 的 status：10 在线（我们只用这一个；30 离开、50 忙碌见下面的说明）（NapCat 文档里的码） */
    status: number;
    /** ext_status：QQ 自带的「在线状态」小标：1016 睡觉中、1018 学习中、1028 听歌中；0 没有 */
    ext: number;
    label: string;
}

export const ONLINE: OnlineStatus = { status: 10, ext: 0, label: '在线' };
/**
 * 睡着（或说过「睡了」）。不用 QQ 的「离开」（status 30）：「离开」会让 QQ 给每个来消息的人自动回一句预设的话，
 * 睡着的人不会那样回——10-20 实测，她睡着时他发消息收到了「自动回复」，换成这个状态之后就没有了。
 */
export const SLEEPING: OnlineStatus = { status: 10, ext: 1016, label: '睡觉中' };
/** 上课。不用「忙碌」（status 50）：它可能同样带自动回复，没单独测；「学习中」是 QQ 自带的状态，也更像在上课 */
export const STUDYING: OnlineStatus = { status: 10, ext: 1018, label: '学习中' };
export const LISTENING: OnlineStatus = { status: 10, ext: 1028, label: '听歌中' };

/** 她此刻在干什么 → 联系人列表上看到的状态：睡着（或说过「睡了」）「睡觉中」，上课「学习中」，在听歌就「听歌中」，其余在线 */
export function onlineStatusFor(activity: Activity, saidSleep: boolean): OnlineStatus {
    if (saidSleep || activity.kind === 'sleep') return SLEEPING;
    if (activity.kind === 'class') return STUDYING;
    if (activity.kind === 'free' && /听歌|听音乐|歌单/.test(activity.text)) return LISTENING;
    return ONLINE;
}

/** 作息上到睡觉的点之后，「睡觉中」晚多久才挂上（0–45 分钟，按日期哈希）：不然每天夜里整整同一分钟变成睡觉中，一看就是程序；她自己说了「睡了」的不等（名字里的 AWAY 是老叫法） */
export const AWAY_JITTER_MIN: [number, number] = [0, 45];

/** 睡下 / 醒来的状态变化，至少隔这么久才改一次 */
export const STATUS_MIN_GAP_MS = 10 * 60_000;

/**
 * 下课后这么久内「学习中」不改回「在线」：课间十五分钟一来一回，联系人列表上的状态一天要闪十几次，真人不会这样（60 天长跑测试发现的）。
 * 睡下的「睡觉中」不受这个限制（名字里的 BUSY 是老叫法）
 */
export const BUSY_HOLD_MS = 60 * 60_000;

/** 改在线状态失败了就越隔越久再试：10、20、40、80 分钟，之后每 2 小时；成功一次从头（一直失败不该每分钟敲一次 NapCat） */
const STATUS_RETRY_MAX_MS = 2 * 3_600_000;

// ───────── 资料卡点赞 ─────────

/** 一天点不点：约这个比例的日子（人也不是天天点） */
export const LIKE_CHANCE = 0.8;

/** 这一天（她的一天，YYYY-MM-DD）给 qq 点不点赞、几点（当天的分钟数）、点几下；不点返回 undefined */
export function likePlan(qq: number, day: string): { minutes: number; times: number } | undefined {
    const seed = `${qq} ${day}`;
    if (pick(seed, 'like', [0, 999]) >= LIKE_CHANCE * 1000) return undefined;
    return { minutes: pick(seed, 'like-at', [12 * 60, 21 * 60 + 30]), times: pick(seed, 'like-times', [1, 5]) };
}

// ───────── 个性签名 ─────────

/** 平时的签名（她的口吻，短；改成什么由日期哈希挑，不连着两次一样） */
export const SIGNATURES: readonly string[] = [
    '今天也在好好吃饭', '困', '土豆又胖了', '想去海边', '周末快点来',
    '路过的猫都很可爱', '慢慢来', '今天的云很好看', '想吃烤冷面', '没有灵感', '平静', '少熬夜', '又是想放假的一天',
    '食堂的面今天不错', '作业会自己写完的（不会）', '晚上吃点好的', '日子平平淡淡', '一切都会好的',
    '在攒钱', '不想动', '天气好就出去走走', '好好生活', '今天不想说话', '想拍点好看的东西',
    '好好吃饭好好睡觉', '想吃火锅', '想去旅行', '最近有点上头', '一切刚刚好',
];
// 签名一挂就是三五天，所以不放只在一个钟点成立的（「先睡了」「刚醒」「想睡觉」「喂猫中」）和只在某种天气成立的（「下雨天适合赖床」，雨天有雨天的那一组）

/** 节日当天的签名（没列的节日不改，比如清明、520、双十一） */
export const FESTIVAL_SIGNATURES: Readonly<Record<string, string>> = {
    元旦: '元旦快乐', 跨年夜: '跨年快乐', 除夕: '除夕快乐', 春节: '新年快乐', 元宵节: '元宵快乐', 情人节: '情人节快乐', 妇女节: '妇女节快乐',
    劳动节: '五一快乐', 儿童节: '儿童节快乐', 端午节: '端午安康', 七夕: '七夕快乐', 中秋节: '中秋快乐', 万圣节: '万圣节快乐', 平安夜: '平安夜快乐', 圣诞节: '圣诞快乐',
};

/** 下雨天加的 */
export const RAINY_SIGNATURES: readonly string[] = ['下雨了', '雨天不想出门', '下雨天适合发呆', '雨一直下'];

/** 签名只在白天换（10:00–23:00）：不然会一直在上一次的钟点换，夜里睡前的 1 点多也换，还常常凑成整点 */
export const SIGNATURE_HOURS: [number, number] = [10, 22];

/** 隔几天换一次：3–5 天，当天的几点也按上一次换的时刻哈希（10:00–22:59）；所以两次之间约 2.5–5.6 天 */
export function signatureDueAt(lastChangedAt: number): number {
    const days = pick(String(lastChangedAt), 'signature-gap', [3, 5]);
    const day = new Date(lastChangedAt);
    return localDate(day.getFullYear(), day.getMonth(), day.getDate() + days,
        pick(String(lastChangedAt), 'signature-hour', SIGNATURE_HOURS), pick(String(lastChangedAt), 'signature-minute', [0, 59])).getTime();
}

/** 这次换成什么：当天是节日就「<节日>快乐」；下雨天从雨天里挑；其余从平时的里挑，和上一条不一样 */
export function signatureFor(input: { day: string; festival?: string; rainy?: boolean; last?: string }): string {
    const wish = input.festival ? FESTIVAL_SIGNATURES[input.festival] : undefined;
    if (wish) return wish;
    const pool = [...SIGNATURES, ...(input.rainy ? RAINY_SIGNATURES : [])].filter(text => text !== input.last);
    return pool[pick(input.day, 'signature', [0, pool.length - 1])]!;
}

// ───────── 表情回应 ─────────

/** 给他那条消息点的表情回应（QQ 小黄脸的 id）：笑的点笑哭，亲密的点爱心，其余在赞和爱心之间按消息 id 定 */
export function reactionEmoji(text: string, messageId: number): number {
    if (/哈哈|hh|笑死|草|绷不住|xswl/i.test(text)) return 182;
    if (/爱你|想你|mua|亲亲|抱抱|宝宝|晚安/.test(text)) return 66;
    return pick(String(messageId), 'react', [0, 99]) < 70 ? 76 : 66;
}

// ───────── 主动戳他 ─────────

/** 一天戳不戳：约这个比例的日子（一周最多 3 下，隔至少 36 小时）；工作日晚上、周末下午到晚上，到点之后等聊天安静下来再戳，22:30 以后今天不戳了 */
export const POKE_OUT_CHANCE = 0.3;
export const POKE_OUT_MIN_GAP_MS = 36 * 3_600_000;
export const POKE_OUT_WEEK_MAX = 3;
export const POKE_OUT_LATEST = 22 * 60 + 30;

/** 这一天（她的一天）戳不戳、几点起；不戳返回 undefined */
export function pokeOutPlan(day: string, weekend: boolean): { minutes: number } | undefined {
    if (pick(day, 'poke-out', [0, 999]) >= POKE_OUT_CHANCE * 1000) return undefined;
    return { minutes: weekend ? pick(day, 'poke-out-at', [14 * 60, 21 * 60 + 30]) : pick(day, 'poke-out-at', [19 * 60, 21 * 60 + 30]) };
}

// ───────── QQ 空间说说 ─────────

/** 一天发不发：约这个比例的日子（一周两三条） */
export const QZONE_CHANCE = 0.36;
export const QZONE_MIN_GAP_MS = 20 * 3_600_000;
export const QZONE_WEEK_MAX = 3;
export const QZONE_MAX_CHARS = 60;

/** 这一天（她的一天）发不发、几点（当天的分钟数：工作日晚上，周末白天到晚上）；不发返回 undefined */
export function qzonePlan(day: string, weekend: boolean): { minutes: number } | undefined {
    if (pick(day, 'qzone', [0, 999]) >= QZONE_CHANCE * 1000) return undefined;
    return { minutes: weekend ? pick(day, 'qzone-at', [11 * 60, 22 * 60 + 30]) : pick(day, 'qzone-at', [17 * 60 + 30, 22 * 60 + 30]) };
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);

/** 放图的文件夹里还没用过的图（文件名排序，按日期哈希挑一张）；没有返回 undefined */
export function pickQzonePhoto(dir: string, used: readonly string[], day: string): string | undefined {
    if (!existsSync(dir)) return undefined;
    const files = readdirSync(dir).filter(name => IMAGE_EXTENSIONS.has(extname(name).toLowerCase()) && !used.includes(name)).sort();
    return files.length ? files[pick(day, 'qzone-photo', [0, files.length - 1])] : undefined;
}

const ASSISTANT_TALK = /我是(?:一个)?(?:AI|人工智能|助手)|作为(?:一个)?(?:AI|助手)|很高兴|当然可以|以下是|希望(?:对你|这)|如有需要/;

/**
 * 生成的说说过一遍：去掉首尾引号和换行，不合格返回 undefined——
 * 空的、超过 QZONE_MAX_CHARS 字、有网址 / @ / 长数字（电话、QQ 号）、带这一档的禁用词、助手腔、方括号（小黄脸在空间里不是那个意思）
 */
export function cleanQzoneText(raw: string, banned: readonly string[] = []): string | undefined {
    const text = raw.replace(/^["“”'‘’「」『』\s]+|["“”'‘’「」『』\s]+$/g, '').replace(/\s*[\r\n]+\s*/g, ' ').trim();
    if (!text || text.length > QZONE_MAX_CHARS) return undefined;
    if (/https?:|www\.|@|\d{6,}|[[\]【】]/.test(text)) return undefined;
    if (ASSISTANT_TALK.test(text)) return undefined;
    if (banned.some(word => word && text.includes(word))) return undefined;
    return text;
}

// ───────── 每分钟看一眼的小循环 ─────────

export interface PresenceTransport {
    /** 戳他一下（NapCat 的 friend_poke，要 packet 服务；ADR 0087） */
    pokeFriend?(userId: number): Promise<void>;
    setOnlineStatus?(status: number, ext: number): Promise<void>;
    sendLike?(userId: number, times: number): Promise<void>;
    setSignature?(text: string): Promise<void>;
    /** 发一条说说，返回说说的 id；ugcRight：1 所有人可见 4 好友可见（NapCat send_qzone_msg） */
    postQzone?(post: { content: string; images?: string[]; ugcRight: number }): Promise<string>;
    /** 读一页空间动态（ADR 0142，「空友爱看」那种流）；这台 NapCat 读不了就返回 undefined */
    readQzoneFeed?(count: number): Promise<QzoneFeed | undefined>;
    /** 看某个人（好友）的空间说说（ADR 0143，走她的登录态）；读不到返回 undefined */
    readUserQzone?(uin: number): Promise<QzoneItem[] | undefined>;
    /** 平台推的陌生人说说（ADR 0144，「空友爱看」那种推荐流）；读不到返回 undefined */
    readStrangerFeed?(): Promise<StrangerFeed | undefined>;
}

export interface QzoneRecord {
    at: number;
    text: string;
    photo?: string;
    /** 草稿（dryRun）没有 tid */
    tid?: string;
    mode: 'dryRun' | 'on';
}

interface PresenceFile {
    version: 1;
    status?: { label: string; at: number };
    likedDay?: string;
    signature?: { text: string; at: number; next: number; draft?: boolean };
    qzone: QzoneRecord[];
    qzoneAttemptDay?: string;
    /** 她刚翻过的空间动态（ADR 0142）：一行「看到什么」，6 小时内的会进提示词 */
    browse?: { at: number; action: string; count: number; note: string };
    browseAttemptAt?: number;
    /** 她刚看过的某个人（好友）的空间（ADR 0143），同样 6 小时内进提示词 */
    peek?: { at: number; uin: number; count: number; note: string };
    peekAttemptAt?: number;
    /** 已经「看到过」的好友说说 id（最近 30 条）：同一条不当新的再看一遍 */
    peekSeen?: string[];
    /** 读不到时的下次重试时刻（ADR 0145）；原来是「读不到就不再试」，一次断网就永久停用 */
    peekRetryAt?: number;
    /** 她刷到的陌生人说说（ADR 0144）：6 小时内的这一行进提示词；样本另存 strangers.jsonl */
    strangers?: { at: number; action: string; count: number; note: string };
    strangersAttemptAt?: number;
    photosUsed: string[];
    /** 她主动戳他的时刻（ADR 0087；旧文件没有这一项） */
    pokesOut?: number[];
    pokeOutAttemptDay?: string;
}

export interface PresenceOptions {
    /** 休眠中（ADR 0161）：这一次整个不做（在线状态、点赞、签名、说说、戳他都不动） */
    paused?: () => boolean;
    flags: { onlineStatus: boolean; profileLikes: boolean; signature: PresenceMode; qzone: PresenceMode; qzoneVisibility: QzoneVisibility; pokeOut?: boolean; qzoneBrowse?: PresenceMode; qzonePeek?: PresenceMode; qzoneStrangers?: PresenceMode };
    transport: PresenceTransport;
    schedule: Schedule;
    extraFree?: readonly ExtraFreeActivity[];
    /** 给谁点赞（男朋友档的联系人） */
    likeTargets: readonly number[];
    /** 可以看她空间的名单（ADR 0143：只放用户点名的人，名字用于提示词里说是谁的空间） */
    peekTargets?: readonly { qq: number; name: string }[];
    /** 她主动戳谁（男朋友档的联系人；ADR 0087） */
    pokeTargets?: readonly number[];
    /** 这会儿适不适合戳他：聊天安静了一阵、不是刚道过晚安、没在危机暂停里。app 按聊天记录判断 */
    canPokeOut?: (qq: number, now: number) => boolean;
    /** 戳完记进聊天记录（「[你戳了戳他]」） */
    recordPokeOut?: (qq: number, now: number) => void;
    /** 数据目录下的 presence/（状态文件、草稿、放图的 photos/） */
    dir: string;
    now: () => number;
    log: (message: string) => void;
    /** 她说过「睡了」、此刻算睡着 */
    saidSleep?: (now: number) => boolean;
    /** 当天是什么节日（签名用） */
    festival?: (day: Date) => string | undefined;
    /** 此刻下不下雨（签名用） */
    rainy?: (now: number) => boolean;
    /** 写一条说说：给了图就照着图写；写不出合格的返回 undefined。由 app 接模型（用最低隐私档的卡） */
    composeQzone?: (input: { now: number; photoFile?: string; recent: readonly string[] }) => Promise<{ text: string; withPhoto: boolean } | undefined>;
}

/** 「昨天晚上」「今天下午」「3 天前」 */
function agoText(at: number, now: number): string {
    const a = new Date(at);
    const b = new Date(now);
    const days = Math.round((localDate(b.getFullYear(), b.getMonth(), b.getDate()).getTime() - localDate(a.getFullYear(), a.getMonth(), a.getDate()).getTime()) / 86_400_000);
    const hour = a.getHours();
    const part = hour < 6 ? '凌晨' : hour < 12 ? '上午' : hour < 18 ? '下午' : '晚上';
    return days <= 0 ? `今天${part}` : days === 1 ? `昨天${part}` : `${days} 天前`;
}

/**
 * 她自己知道的、他点开资料卡 / 空间能看到的（提示词时间块里的一行）：现在的个性签名（真改了的，不含草稿），3 天内发的说说（真发了的）。
 * 没有就返回 undefined。有了这一行，他提起「我看到你那条说说」她接得住，也不会编一条没发过的
 */
export function describeSelf(input: { signature?: { text: string; draft?: boolean }; qzone: readonly QzoneRecord[]; browse?: { at: number; note: string }; peek?: { at: number; note: string }; strangers?: { at: number; note: string } }, now: number): string | undefined {
    const parts: string[] = [];
    if (input.signature?.text && !input.signature.draft) parts.push(`个性签名现在是「${input.signature.text}」`);
    const post = input.qzone.findLast(record => record.mode === 'on' && record.at <= now && now - record.at <= 3 * 86_400_000);
    if (post) parts.push(`${agoText(post.at, now)}发了一条说说「${post.text}」${post.photo ? '，配了一张图' : ''}`);
    const lines: string[] = [];
    if (parts.length) lines.push(`[你在 QQ 上的样子（他点开你的资料卡、空间能看到的；他问起或提到时照这个说，没写的别编）：${parts.join('；')}]`);
    // 她刷空间看到的是别人发的，和上面「他能看到的你」是两回事，分开一行，免得她把别人的话当成自己发的
    const seen: string[] = [];
    if (input.browse && input.browse.at <= now && now - input.browse.at <= 6 * 3_600_000) seen.push(input.browse.note);
    if (input.peek && input.peek.at <= now && now - input.peek.at <= 6 * 3_600_000) seen.push(input.peek.note);
    if (input.strangers && input.strangers.at <= now && now - input.strangers.at <= 6 * 3_600_000) seen.push(input.strangers.note);
    if (seen.length) lines.push(`[你刚才刷空间看到的（是别人发的，不是你发的；用不上就不提，没写的别编）：${seen.join('；')}]`);
    return lines.length ? lines.join('\n') : undefined;
}

export interface Presence {
    /** 提示词里的一行：她的签名、最近发的说说（describeSelf） */
    selfNote(now: number): string | undefined;
    /** 看一眼现在该不该做什么（测试直接调；循环每分钟调一次） */
    tick(): Promise<void>;
    start(): void;
    stop(): Promise<void> | undefined;
    /** NapCat 重新连上 / 重新登录之后：QQ 那边的状态可能已经被重置成「在线」，把现在该有的状态再设一遍 */
    reapply(): void;
}

const STATE_VERSION = 1;
const stateRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const text = (value: unknown, max = 10_000): value is string => typeof value === 'string' && value.length <= max;
const optional = (value: unknown, check: (candidate: unknown) => boolean): boolean => value === undefined || check(value);
const stringList = (value: unknown, maxItems: number, maxLength: number): value is string[] =>
    Array.isArray(value) && value.length <= maxItems && value.every(item => text(item, maxLength));
const numberList = (value: unknown, maxItems: number): value is number[] =>
    Array.isArray(value) && value.length <= maxItems && value.every(finite);
const attemptDay = (value: unknown): value is string => text(value, 32);

function validSignature(value: unknown): boolean {
    const record = stateRecord(value);
    return Boolean(record && text(record.text, 1_000) && finite(record.at) && finite(record.next)
        && optional(record.draft, (candidate): candidate is boolean => typeof candidate === 'boolean'));
}

function validQzoneRecord(value: unknown): boolean {
    const record = stateRecord(value);
    return Boolean(record && finite(record.at) && text(record.text, 1_000)
        && optional(record.photo, (candidate): candidate is string => text(candidate, 255))
        && optional(record.tid, (candidate): candidate is string => text(candidate, 1_000))
        && (record.mode === 'dryRun' || record.mode === 'on'));
}

function validSeen(value: unknown, kind: 'browse' | 'peek' | 'strangers'): boolean {
    const record = stateRecord(value);
    if (!record || !finite(record.at) || !Number.isSafeInteger(record.count) || (record.count as number) < 0 || !text(record.note, 20_000)) return false;
    if (kind === 'peek') return Number.isSafeInteger(record.uin) && (record.uin as number) > 0;
    return text(record.action, 1_000);
}

/**
 * presence.json is durable progress for externally visible actions, not a disposable cache.  A
 * partially-shaped value must not turn "already liked/posted/poked today" into "not done".
 * Unknown extra keys remain forward-compatible, but every field we consume is checked here.
 */
const validFile = (value: unknown): value is PresenceFile => {
    const record = stateRecord(value);
    if (!record || record.version !== STATE_VERSION) return false;
    if (!Array.isArray(record.qzone) || record.qzone.length > 1_000 || !record.qzone.every(validQzoneRecord)) return false;
    if (!stringList(record.photosUsed, 10_000, 255)) return false;
    if (!optional(record.status, candidate => {
        const status = stateRecord(candidate);
        return Boolean(status && text(status.label, 100) && finite(status.at));
    })) return false;
    if (!optional(record.likedDay, attemptDay) || !optional(record.signature, (candidate): candidate is PresenceFile['signature'] => validSignature(candidate))) return false;
    if (!optional(record.qzoneAttemptDay, attemptDay) || !optional(record.pokeOutAttemptDay, attemptDay)) return false;
    if (!optional(record.browse, (candidate): candidate is PresenceFile['browse'] => validSeen(candidate, 'browse'))
        || !optional(record.peek, (candidate): candidate is PresenceFile['peek'] => validSeen(candidate, 'peek'))
        || !optional(record.strangers, (candidate): candidate is PresenceFile['strangers'] => validSeen(candidate, 'strangers'))) return false;
    if (!optional(record.browseAttemptAt, finite) || !optional(record.peekAttemptAt, finite)
        || !optional(record.peekRetryAt, finite) || !optional(record.strangersAttemptAt, finite)) return false;
    if (!optional(record.peekSeen, (candidate): candidate is string[] => stringList(candidate, 1_000, 1_000))) return false;
    if (!optional(record.pokesOut, (candidate): candidate is number[] => numberList(candidate, 1_000))) return false;
    return true;
};

export const PRESENCE_TICK_MS = 60_000;

export function createPresence(options: PresenceOptions): Presence {
    const { flags, transport, schedule, dir, log } = options;
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'presence.json');
    const draftsPath = join(dir, 'drafts.md');
    const state = readJsonOr<PresenceFile>(statePath, { version: STATE_VERSION, qzone: [], photosUsed: [] }, log, {
        validate: validFile,
        invalid: 'throw',
        label: '存在感状态',
    });
    const save = () => writeJsonAtomic(statePath, state);
    const failed = new Set<string>();
    const fail = (what: string, error: unknown) => {
        // 同一件事连着失败只记第一次（每分钟一次会刷满日志）
        if (failed.has(what)) return;
        failed.add(what);
        log(`${what}失败（之后不再记，成功了会记一次）：${error instanceof Error ? error.message : String(error)}`);
    };
    const recovered = (what: string) => { if (failed.delete(what)) log(`${what}又成功了`); };
    const draft = (title: string, body: string) => appendFileSync(draftsPath, `## ${title}\n\n${body}\n\n`);
    let appliedThisRun: string | undefined;
    let lastClassAt: number | undefined;
    let awayWantedSince: number | undefined;
    let statusRetryAt = 0;
    let statusFailures = 0;
    let busy = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    let running: Promise<void> | undefined;
    let drain: Promise<void> | undefined;
    const cancellation = new AbortController();
    const STOPPED = Symbol('presence stopped');
    const check = () => { if (stopped) throw STOPPED; };
    const read = <T>(work: () => Promise<T>): Promise<T> => {
        check();
        return new Promise((resolve, reject) => {
            const cancel = () => reject(STOPPED);
            cancellation.signal.addEventListener('abort', cancel, { once: true });
            Promise.resolve().then(() => { check(); return work(); }).then(value => { check(); resolve(value); }, reject)
                .catch(reject).finally(() => cancellation.signal.removeEventListener('abort', cancel));
        });
    };

    async function online(t: number, state0: ReturnType<typeof stateAt>): Promise<void> {
        check();
        if (!flags.onlineStatus || !transport.setOnlineStatus) return;
        if (state0.activity.kind === 'class') lastClassAt = t;
        if (t < statusRetryAt) return;
        let want = onlineStatusFor(state0.activity, options.saidSleep?.(t) ?? false);
        const have = appliedThisRun;
        if (have === STUDYING.label && want.label !== STUDYING.label && want.label !== SLEEPING.label && lastClassAt !== undefined && t - lastClassAt < BUSY_HOLD_MS) want = STUDYING;
        if (want.label === SLEEPING.label) awayWantedSince ??= t; else awayWantedSince = undefined;
        if (want.label === have) return;
        // 到了作息上睡觉的点，「睡觉中」晚一会儿再挂（这次启动后第一次、她自己说了睡了的除外）
        if (want.label === SLEEPING.label && have !== undefined && !(options.saidSleep?.(t) ?? false) && awayWantedSince !== undefined
            && t - awayWantedSince < pick(formatDate(herDay(schedule, new Date(t))), 'away-jitter', AWAY_JITTER_MIN) * 60_000) return;
        // 刚改过不久就先不动（第一次——这次启动后还没设过——除外）
        if (have !== undefined && state.status && t - state.status.at < STATUS_MIN_GAP_MS) return;
        try {
            check();
            await transport.setOnlineStatus(want.status, want.ext);
            appliedThisRun = want.label;
            statusFailures = 0;
            state.status = { label: want.label, at: t };
            save();
            log(`在线状态：${want.label}`);
            recovered('改在线状态');
        } catch (error) {
            check();
            fail('改在线状态', error);
            statusRetryAt = t + Math.min(STATUS_MIN_GAP_MS * 2 ** statusFailures, STATUS_RETRY_MAX_MS);
            statusFailures++;
        }
    }

    async function likes(t: number, day: string, awake: boolean): Promise<void> {
        check();
        if (!flags.profileLikes || !transport.sendLike || !awake || state.likedDay === day) return;
        const date = new Date(t);
        const minutes = date.getHours() * 60 + date.getMinutes();
        let waiting = false;
        for (const qq of options.likeTargets) {
            check();
            const plan = likePlan(qq, day);
            if (!plan) continue;
            if (minutes < plan.minutes) { waiting = true; continue; }
            try {
                check();
                await transport.sendLike(qq, plan.times);
                log(`[${qq}] 给资料卡点了 ${plan.times} 个赞`);
                recovered('资料卡点赞');
            } catch (error) {
                check();
                fail('资料卡点赞', error);
            }
        }
        // 点没点成都记这一天做过了（不一整天每分钟重试）；还有没到点的就等
        if (!waiting) {
            state.likedDay = day;
            save();
        }
    }

    async function signature(t: number, day: string, awake: boolean): Promise<void> {
        check();
        if (flags.signature === 'off' || !awake) return;
        const hour = new Date(t).getHours();
        if (hour < SIGNATURE_HOURS[0] || hour > SIGNATURE_HOURS[1]) return;
        if (!state.signature) {
            // 第一次：一两个小时后改，不是一启动就改
            state.signature = { text: '', at: 0, next: t + pick(String(t), 'signature-first', [3_600_000, 7_200_000]) };
            save();
        }
        if (t < state.signature.next) return;
        const date = new Date(t);
        const festival = options.festival?.(herDay(schedule, date));
        const text = signatureFor({
            day, ...(festival ? { festival } : {}),
            ...(options.rainy?.(t) ? { rainy: true } : {}), last: state.signature.text,
        });
        if (flags.signature === 'dryRun') {
            draft(`${new Date(t).toLocaleString('zh-CN')} 个性签名（草稿，没改）`, text);
            state.signature = { text, at: t, next: signatureDueAt(t), draft: true };
            save();
            log(`个性签名（试运行，没改）：写了草稿「${logBody(text)}」`);
            return;
        }
        if (!transport.setSignature) return;
        try {
            check();
            await transport.setSignature(text);
            state.signature = { text, at: t, next: signatureDueAt(t) };
            save();
            log(`个性签名：改成「${logBody(text)}」`);
            recovered('改个性签名');
        } catch (error) {
            check();
            fail('改个性签名', error);
            state.signature = { ...state.signature, next: t + 6 * 3_600_000 };
            save();
        }
    }

    async function pokeOut(t: number, day: string, awake: boolean): Promise<void> {
        check();
        if (!flags.pokeOut || !transport.pokeFriend || !options.pokeTargets?.length || !awake || state.pokeOutAttemptDay === day) return;
        const date = new Date(t);
        const plan = pokeOutPlan(day, date.getDay() === 0 || date.getDay() === 6);
        const minutes = date.getHours() * 60 + date.getMinutes();
        if (!plan || minutes < plan.minutes) return;
        const done = state.pokesOut ?? [];
        const last = done.at(-1);
        if ((last && t - last < POKE_OUT_MIN_GAP_MS) || done.filter(at => t - at < 7 * 86_400_000).length >= POKE_OUT_WEEK_MAX) return;
        if (minutes > POKE_OUT_LATEST) {
            // 等了一晚上聊天都没安静下来 / 一直不合适：今天不戳了
            state.pokeOutAttemptDay = day;
            save();
            return;
        }
        const qq = options.pokeTargets.find(target => options.canPokeOut?.(target, t) ?? true);
        if (qq === undefined) return;
        state.pokeOutAttemptDay = day;
        save();
        try {
            check();
            await transport.pokeFriend(qq);
        } catch (error) {
            check();
            fail('主动戳他', error);
            return;
        }
        state.pokesOut = [...done, t].slice(-50);
        save();
        try { options.recordPokeOut?.(qq, t); } catch (error) { fail('记下戳了他', error); }
        log(`[${qq}] 戳了他一下`);
        recovered('主动戳他');
    }

    async function qzone(t: number, day: string, awake: boolean): Promise<void> {
        check();
        if (flags.qzone === 'off' || !awake || !options.composeQzone || state.qzoneAttemptDay === day) return;
        if (flags.qzone === 'on' && !transport.postQzone) return;
        const date = new Date(t);
        const plan = qzonePlan(day, date.getDay() === 0 || date.getDay() === 6);
        if (!plan || date.getHours() * 60 + date.getMinutes() < plan.minutes) return;
        const last = state.qzone.at(-1);
        const weekAgo = state.qzone.filter(record => t - record.at < 7 * 86_400_000).length;
        if ((last && t - last.at < QZONE_MIN_GAP_MS) || weekAgo >= QZONE_WEEK_MAX) return;
        // 今天的机会用掉了：生成失败也不一整天重试
        state.qzoneAttemptDay = day;
        save();
        const photoFile = pickQzonePhoto(join(dir, 'photos'), state.photosUsed, day);
        let composed: { text: string; withPhoto: boolean } | undefined;
        try {
            composed = await read(() => options.composeQzone!({ now: t, ...(photoFile ? { photoFile } : {}), recent: state.qzone.map(record => record.text) }));
        } catch (error) {
            check();
            fail('写说说', error);
            return;
        }
        if (!composed) {
            log('说说：这次没写出合格的，今天不发了');
            return;
        }
        const text = composed.text;
        // 配文是照着图写的才带图（没看成图就是纯文字，这时不把图发出去）
        const photo = composed.withPhoto ? photoFile : undefined;
        if (flags.qzone === 'dryRun') {
            state.qzone.push({ at: t, text, ...(photo ? { photo } : {}), mode: 'dryRun' });
            state.qzone = state.qzone.slice(-100);
            save();
            draft(`${new Date(t).toLocaleString('zh-CN')} 说说（草稿，没发）`, `${text}${photo ? `

（配图：${photo}）` : ''}`);
            log(`说说（试运行，没发）：写了草稿「${logBody(text)}」${photo ? `，配图 ${photo}` : ''}`);
            return;
        }
        try {
            check();
            const tid = await transport.postQzone!({
                content: text,
                ...(photo ? { images: [pathToFileURL(join(dir, 'photos', photo)).href] } : {}),
                ugcRight: flags.qzoneVisibility === 'public' ? 1 : 4,
            });
            state.qzone.push({ at: t, text, ...(photo ? { photo } : {}), tid, mode: 'on' });
            state.qzone = state.qzone.slice(-100);
            if (photo) state.photosUsed.push(photo);
            save();
            log(`说说：发了「${logBody(text)}」${photo ? `，配图 ${photo}` : ''}（${flags.qzoneVisibility === 'public' ? '所有人可见' : '好友可见'}）`);
            recovered('发说说');
        } catch (error) {
            check();
            fail('发说说', error);
        }
    }

    // 她自己翻空间动态（ADR 0142）：09:00–23:00 之间、醒着、两次之间至少隔 2.5 小时；读一页，摘成一行留给她。
    // 这台 NapCat 读不了（没有可用的动作）就只记一次，之后不再反复试。
    const BROWSE_MIN_GAP_MS = 2.5 * 3_600_000;
    let browseUnreadable = false;
    async function browse(t: number, awake: boolean): Promise<void> {
        check();
        if (flags.qzoneBrowse === undefined || flags.qzoneBrowse === 'off' || browseUnreadable) return;
        if (!awake || !transport.readQzoneFeed) return;
        const hour = new Date(t).getHours();
        if (hour < 9 || hour >= 23) return;
        if (state.browseAttemptAt !== undefined && t - state.browseAttemptAt < BROWSE_MIN_GAP_MS) return;
        state.browseAttemptAt = t;
        save();
        let feed: QzoneFeed | undefined;
        try {
            feed = await read(() => transport.readQzoneFeed!(8));
        } catch (error) {
            check();
            fail('翻空间', error);
            return;
        }
        if (!feed) {
            browseUnreadable = true;
            log('翻空间：这台 NapCat 读不了空间动态（候选动作都不通），开关留着，之后不再试');
            return;
        }
        recovered('翻空间');
        const note = feedDigest(feed);
        if (!note) return;
        if (flags.qzoneBrowse === 'dryRun') {
            draft(`${new Date(t).toLocaleString('zh-CN')} 翻了会儿空间（草稿，没记进提示词）`, note);
            log(`翻空间（试运行）：读到 ${feed.items.length} 条（${feed.action}），写了草稿`);
            return;
        }
        state.browse = { at: t, action: feed.action, count: feed.items.length, note };
        save();
        log(`翻空间：读到 ${feed.items.length} 条（${feed.action}）`);
    }

    // 看某个好友的空间（ADR 0143）：10:00–22:00、醒着、两次之间至少隔 4 小时；名单里的人按日期轮着看。
    // 读不到（登录态过期 / 不是好友 / 风控）只记一次，不假装看到；正文只进提示词，不进日志。
    // ADR 0145：读的是她自己的好友动态流（不进对方的空间、不留访客记录），再挑出名单里这个人发的；
    // 只当新鲜事看 3 天内、没看过的；读不到不再永久停用，6 小时后再试（这台虚拟机断过 17 小时的网）。
    const PEEK_MIN_GAP_MS = 4 * 3_600_000;
    const PEEK_RETRY_MS = 6 * 3_600_000;
    const PEEK_FRESH_MS = 3 * 86_400_000;
    const peekDrafted = new Set<string>();
    async function peek(t: number, awake: boolean): Promise<void> {
        check();
        if ((flags.qzonePeek ?? 'off') === 'off') return;
        const targets = options.peekTargets ?? [];
        if (!awake || !transport.readUserQzone || !targets.length) return;
        const hour = new Date(t).getHours();
        if (hour < 10 || hour >= 22) return;
        if (state.peekAttemptAt !== undefined && t - state.peekAttemptAt < PEEK_MIN_GAP_MS) return;
        if (state.peekRetryAt !== undefined && t < state.peekRetryAt) return;
        state.peekAttemptAt = t;
        save();
        const day = formatDate(herDay(schedule, new Date(t)));
        const target = targets[pick(day, 'peek-target', [0, targets.length - 1])];
        if (!target) return;
        let items: QzoneItem[] | undefined;
        try {
            items = await read(() => transport.readUserQzone!(target.qq));
        } catch (error) {
            check();
            fail('看好友空间', error);
            return;
        }
        if (!items) {
            state.peekRetryAt = t + PEEK_RETRY_MS;
            save();
            log('看好友空间：读不到（登录态 / 网络 / 风控 / 结构变了），6 小时后再试');
            return;
        }
        recovered('看好友空间');
        delete state.peekRetryAt;
        const seen = new Set(state.peekSeen ?? []);
        const fresh = items
            .filter(item => !seen.has(item.id) && (item.at === undefined || (item.at <= t && t - item.at <= PEEK_FRESH_MS)))
            .sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
            .slice(0, 2);
        if (!fresh.length) { save(); return; }
        const quotes = fresh.map(item => {
            const text = item.text.replace(/\s+/g, ' ').trim();
            return `${target.name}${item.at !== undefined ? agoText(item.at, t) : ''}发了「${text.length > 40 ? `${text.slice(0, 40)}…` : text}」`;
        });
        const note = `你刷了会儿 QQ 空间的好友动态，看到${quotes.join('；')}`;
        if (flags.qzonePeek === 'dryRun') {
            const fresh0 = fresh.filter(item => !peekDrafted.has(item.id));
            if (!fresh0.length) return;
            for (const item of fresh0) peekDrafted.add(item.id);
            draft(`${new Date(t).toLocaleString('zh-CN')} 刷到${target.name}的说说（草稿，没进提示词）`, note);
            log(`看好友空间（试运行）：${fresh.length} 条新的，写了草稿`);
            return;
        }
        state.peek = { at: t, uin: target.qq, count: fresh.length, note };
        state.peekSeen = [...fresh.map(item => item.id), ...(state.peekSeen ?? [])].slice(0, 30);
        save();
        log(`看好友空间：${fresh.length} 条新的`);
    }

    // 刷陌生人（ADR 0144）：09:00–23:00、醒着、两次之间至少 3 小时；只读，不点赞不评论。
    // 样本（只留正文、时间、图数，不留名字和号）追加到 presence/strangers.jsonl，给她以后观察人怎么说话用。
    const STRANGERS_GAP_MS = 3 * 3_600_000;
    const strangersPath = join(dir, 'strangers.jsonl');
    let strangersUnreadable = false;
    async function strangers(t: number, awake: boolean): Promise<void> {
        check();
        if ((flags.qzoneStrangers ?? 'off') === 'off' || strangersUnreadable) return;
        if (!awake || !transport.readStrangerFeed) return;
        const hour = new Date(t).getHours();
        if (hour < 9 || hour >= 23) return;
        if (state.strangersAttemptAt !== undefined && t - state.strangersAttemptAt < STRANGERS_GAP_MS) return;
        state.strangersAttemptAt = t;
        save();
        let feed: StrangerFeed | undefined;
        try {
            feed = await read(() => transport.readStrangerFeed!());
        } catch (error) {
            check();
            fail('刷陌生人', error);
            return;
        }
        if (!feed) {
            strangersUnreadable = true;
            log('刷陌生人：推荐流读不到（接口变了 / 登录态过期 / 风控），之后不再试');
            return;
        }
        recovered('刷陌生人');
        const note = strangerDigest(feed);
        if (!note) return;
        if (flags.qzoneStrangers === 'dryRun') {
            draft(`${new Date(t).toLocaleString('zh-CN')} 刷了会儿空间（陌生人，草稿）`, note);
            log(`刷陌生人（试运行）：${feed.items.length} 条（${feed.action}），写了草稿`);
            return;
        }
        state.strangers = { at: t, action: feed.action, count: feed.items.length, note };
        save();
        try {
            appendFileSync(strangersPath, sampleLines(feed, t).map(line => `${line}
`).join(''));
        } catch { /* 样本写不进去不影响提示词 */ }
        log(`刷陌生人：${feed.items.length} 条（${feed.action}）`);
    }

    async function runTick(): Promise<void> {
        check();
        if (busy || options.paused?.()) return;
        busy = true;
        try {
            const t = options.now();
            const date = new Date(t);
            const day = formatDate(herDay(schedule, date));
            const current = stateAt(schedule, date, options.extraFree ?? []);
            const sleeping = current.activity.kind === 'sleep' || (options.saidSleep?.(t) ?? false);
            const awake = !sleeping && current.activity.kind !== 'class';
            await online(t, current);
            await likes(t, day, awake);
            await signature(t, day, awake);
            await qzone(t, day, awake);
            await browse(t, awake);
            await peek(t, awake);
            await strangers(t, awake);
            await pokeOut(t, day, awake);
        } finally {
            busy = false;
        }
    }

    function tick(): Promise<void> {
        if (stopped || running) return Promise.resolve();
        running = Promise.resolve().then(runTick).catch(error => { if (error !== STOPPED) throw error; }).finally(() => { running = undefined; });
        return running;
    }

    return {
        tick,
        selfNote: now => describeSelf(state, now),
        reapply() {
            if (stopped) return;
            appliedThisRun = undefined;
            statusRetryAt = 0;
            if (timer) void tick();
        },
        start() {
            if (stopped || timer) return;
            void tick();
            timer = setInterval(() => void tick(), PRESENCE_TICK_MS);
            timer.unref?.();
        },
        stop() {
            if (stopped) return drain;
            stopped = true;
            if (timer) clearInterval(timer);
            timer = undefined;
            cancellation.abort();
            drain = running;
            return drain;
        },
    };
}
