// 她在 QQ 上「有个人在」的几处对外可见的小事（ADR 0083）：在线状态、给他的资料卡点赞、个性签名、QQ 空间说说。
// 都是 NapCat 的扩展动作（set_online_status / send_like / set_self_longnick / send_qzone_msg），都有各自的开关，默认关。
// 这个文件是纯规则 + 一个每分钟看一眼的小循环（createPresence）；「回复他的消息时」的两件事（已读、表情回应）在 responder 里。
// 时刻、概率都按日期哈希定（同一天每次一样，重启不重来），已经做过的记在 <dataDir>/presence/presence.json。

import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { pick } from './reply-timing.ts';
import { formatDate, herDay, stateAt, type Activity, type ExtraFreeActivity, type Schedule } from './schedule.ts';

/** 关 / 只写草稿不发（签名、说说）/ 开 */
export const PRESENCE_MODES = ['off', 'dryRun', 'on'] as const;
export type PresenceMode = (typeof PRESENCE_MODES)[number];

export const QZONE_VISIBILITIES = ['friends', 'public'] as const;
export type QzoneVisibility = (typeof QZONE_VISIBILITIES)[number];

// ───────── 在线状态 ─────────

export interface OnlineStatus {
    /** NapCat set_online_status 的 status：10 在线 30 离开 50 忙碌（NapCat 文档里的码） */
    status: number;
    /** ext_status：1028 听歌中；0 没有 */
    ext: number;
    label: string;
}

export const ONLINE: OnlineStatus = { status: 10, ext: 0, label: '在线' };
export const AWAY: OnlineStatus = { status: 30, ext: 0, label: '离开' };
export const BUSY: OnlineStatus = { status: 50, ext: 0, label: '忙碌' };
export const LISTENING: OnlineStatus = { status: 10, ext: 1028, label: '听歌中' };

/** 她此刻在干什么 → 联系人列表上看到的状态：睡着（或说过「睡了」）离开，上课忙碌，在听歌就「听歌中」，其余在线 */
export function onlineStatusFor(activity: Activity, saidSleep: boolean): OnlineStatus {
    if (saidSleep || activity.kind === 'sleep') return AWAY;
    if (activity.kind === 'class') return BUSY;
    if (activity.kind === 'free' && /听歌|听音乐|歌单/.test(activity.text)) return LISTENING;
    return ONLINE;
}

/** 状态变了也至少隔这么久才改一次（课间、几分钟的活动不来回闪） */
export const STATUS_MIN_GAP_MS = 10 * 60_000;

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
    '今天也在好好吃饭', '困', '土豆又胖了', '想去海边', '周末快点来', '相机预算攒中', '先睡了', '下雨天适合赖床',
    '路过的猫都很可爱', '慢慢来', '今天的云很好看', '想吃烤冷面', '没有灵感', '平静', '少熬夜', '又是想放假的一天',
    '食堂的面今天不错', '作业会自己写完的（不会）', '喂猫中', '刚醒', '想睡觉', '晚上吃点好的', '日子平平淡淡', '一切都会好的',
    '在攒钱', '不想动', '天气好就出去走走', '好好生活', '今天不想说话', '想拍点好看的东西',
];

/** 节日当天的签名（没列的节日不改，比如清明、520、双十一） */
export const FESTIVAL_SIGNATURES: Readonly<Record<string, string>> = {
    元旦: '元旦快乐', 跨年夜: '跨年快乐', 除夕: '除夕快乐', 春节: '新年快乐', 元宵节: '元宵快乐', 情人节: '情人节快乐', 妇女节: '妇女节快乐',
    劳动节: '五一快乐', 儿童节: '儿童节快乐', 端午节: '端午安康', 七夕: '七夕快乐', 中秋节: '中秋快乐', 万圣节: '万圣节快乐', 平安夜: '平安夜快乐', 圣诞节: '圣诞快乐',
};

/** 下雨天加的 */
export const RAINY_SIGNATURES: readonly string[] = ['下雨了', '雨天不想出门', '下雨天适合发呆', '雨一直下'];

/** 隔几天换一次：3–5 天，按上一次换的日期哈希 */
export function signatureDueAt(lastChangedAt: number): number {
    const days = pick(String(lastChangedAt), 'signature-gap', [3, 5]);
    return lastChangedAt + days * 86_400_000;
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
    setOnlineStatus?(status: number, ext: number): Promise<void>;
    sendLike?(userId: number, times: number): Promise<void>;
    setSignature?(text: string): Promise<void>;
    /** 发一条说说，返回说说的 id；ugcRight：1 所有人可见 4 好友可见（NapCat send_qzone_msg） */
    postQzone?(post: { content: string; images?: string[]; ugcRight: number }): Promise<string>;
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
    photosUsed: string[];
}

export interface PresenceOptions {
    flags: { onlineStatus: boolean; profileLikes: boolean; signature: PresenceMode; qzone: PresenceMode; qzoneVisibility: QzoneVisibility };
    transport: PresenceTransport;
    schedule: Schedule;
    extraFree?: readonly ExtraFreeActivity[];
    /** 给谁点赞（男朋友档的联系人） */
    likeTargets: readonly number[];
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

export interface Presence {
    /** 看一眼现在该不该做什么（测试直接调；循环每分钟调一次） */
    tick(): Promise<void>;
    start(): void;
    stop(): void;
}

const STATE_VERSION = 1;
const validFile = (value: unknown): value is PresenceFile =>
    typeof value === 'object' && value !== null && (value as PresenceFile).version === STATE_VERSION
    && Array.isArray((value as PresenceFile).qzone) && Array.isArray((value as PresenceFile).photosUsed);

export const PRESENCE_TICK_MS = 60_000;

export function createPresence(options: PresenceOptions): Presence {
    const { flags, transport, schedule, dir, log } = options;
    mkdirSync(dir, { recursive: true });
    const statePath = join(dir, 'presence.json');
    const draftsPath = join(dir, 'drafts.md');
    const state = readJsonOr<PresenceFile>(statePath, { version: STATE_VERSION, qzone: [], photosUsed: [] }, log, { validate: validFile, label: '存在感状态' });
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
    let busy = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function online(t: number, state0: ReturnType<typeof stateAt>): Promise<void> {
        if (!flags.onlineStatus || !transport.setOnlineStatus) return;
        const want = onlineStatusFor(state0.activity, options.saidSleep?.(t) ?? false);
        const have = appliedThisRun;
        if (want.label === have) return;
        // 刚改过不久就先不动（第一次——这次启动后还没设过——除外）
        if (have !== undefined && state.status && t - state.status.at < STATUS_MIN_GAP_MS) return;
        try {
            await transport.setOnlineStatus(want.status, want.ext);
            appliedThisRun = want.label;
            state.status = { label: want.label, at: t };
            save();
            log(`在线状态：${want.label}`);
            recovered('改在线状态');
        } catch (error) {
            fail('改在线状态', error);
        }
    }

    async function likes(t: number, day: string, awake: boolean): Promise<void> {
        if (!flags.profileLikes || !transport.sendLike || !awake || state.likedDay === day) return;
        const date = new Date(t);
        const minutes = date.getHours() * 60 + date.getMinutes();
        let waiting = false;
        for (const qq of options.likeTargets) {
            const plan = likePlan(qq, day);
            if (!plan) continue;
            if (minutes < plan.minutes) { waiting = true; continue; }
            try {
                await transport.sendLike(qq, plan.times);
                log(`[${qq}] 给资料卡点了 ${plan.times} 个赞`);
                recovered('资料卡点赞');
            } catch (error) {
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
        if (flags.signature === 'off' || !awake) return;
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
            log(`个性签名（试运行，没改）：写了草稿「${text}」`);
            return;
        }
        if (!transport.setSignature) return;
        try {
            await transport.setSignature(text);
            state.signature = { text, at: t, next: signatureDueAt(t) };
            save();
            log(`个性签名：改成「${text}」`);
            recovered('改个性签名');
        } catch (error) {
            fail('改个性签名', error);
            state.signature = { ...state.signature, next: t + 6 * 3_600_000 };
            save();
        }
    }

    async function qzone(t: number, day: string, awake: boolean): Promise<void> {
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
            composed = await options.composeQzone({ now: t, ...(photoFile ? { photoFile } : {}), recent: state.qzone.map(record => record.text) });
        } catch (error) {
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
            log(`说说（试运行，没发）：写了草稿「${text}」${photo ? `，配图 ${photo}` : ''}`);
            return;
        }
        try {
            const tid = await transport.postQzone!({
                content: text,
                ...(photo ? { images: [pathToFileURL(join(dir, 'photos', photo)).href] } : {}),
                ugcRight: flags.qzoneVisibility === 'public' ? 1 : 4,
            });
            state.qzone.push({ at: t, text, ...(photo ? { photo } : {}), tid, mode: 'on' });
            state.qzone = state.qzone.slice(-100);
            if (photo) state.photosUsed.push(photo);
            save();
            log(`说说：发了「${text}」${photo ? `，配图 ${photo}` : ''}（${flags.qzoneVisibility === 'public' ? '所有人可见' : '好友可见'}）`);
            recovered('发说说');
        } catch (error) {
            fail('发说说', error);
        }
    }

    async function tick(): Promise<void> {
        if (busy) return;
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
        } finally {
            busy = false;
        }
    }

    return {
        tick,
        start() {
            if (timer) return;
            void tick();
            timer = setInterval(() => void tick(), PRESENCE_TICK_MS);
            timer.unref?.();
        },
        stop() {
            if (timer) clearInterval(timer);
            timer = undefined;
        },
    };
}
