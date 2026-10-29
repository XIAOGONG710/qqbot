// 主动消息的计划器（ADR 0011 决策 2、4、5、7）：一个联系人一个。按 proactive.ts 算下一次，等到点，再查一遍条件，交给回复器的 initiate。
// - 记录文件 <数据目录>/proactive/<QQ>-<档位>.json：每个候选到点后记一条（发了、试运行、没发及原因、出错），记过的不再排；
//   发之前先记（initiate 的 commit），之后崩溃、断线都不重发；只留 30 天。
//   例外：生成时没连上模型的记成 failed + retryAt，过 UNREACHABLE_RETRY_MS 再试，一共 UNREACHABLE_MAX_TRIES 次。
// - 错过的不补：启动、重新算的时候已经过了 GRACE_MS 的候选记成「错过了，不补」。
// - 聊天记录变了（收到、补回）就 poke()：重新算（冷场的时刻跟着最后一条消息走）。
// - 等待用可替换的 waitUntil（bot 用真实定时器，模拟器用虚拟时钟）。
// - 待跟进的事（follow-ups.ts）也存在这个文件里：syncFollowUps() 从结束了的聊天片段里抽（调用方定时调），
//   问过（发了或试运行）就删，过了 FOLLOW_UP_DAYS 天没问到也删。
// - 状态使用 v1 schema，损坏时保留原文件并暂停该联系人的主动消息/抽取，不清空去重事实，也不拖垮聊天（ADR 0070）。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from '../platform/config.ts';
import { logBody } from '../platform/sensitive.ts';
import { detectCrisis } from '.././emotion/crisis.ts';
import { aboutHer, expired, extractionPrompt, FOLLOW_UP_DAYS, mentions, parseExtraction, partText, tripAlreadyOver, type Extracted, type FollowUp } from './follow-ups.ts';
import type { StoredMessage } from '../memory/history.ts';
import { writeJsonAtomic } from '../memory/json-file.ts';
import { createTransientGate, describeError, isTransientIoError } from '../memory/transient-io.ts';
import { readProactiveState, validProactiveState, type ProactiveState } from './proactive-state.ts';
import { ModelUnreachable } from '../language/llm.ts';
import { EPISODE_GAP_MS, episodeTranscript, splitEpisodes } from '.././memory/episodes.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import type { MacroNames } from '.././st/macros.ts';
import {
    blockReason, candidateLabel, candidatesOn, counts, CRISIS_PAUSE_REASON, DEFAULT_NEWS_KINDS, herDay, MAX_PROACTIVE_BUBBLES, newsKindsOf, occasionNote, PENDING_REASON, planFrom, recallTopic, untoldNews,
    UNREACHABLE_MAX_TRIES, UNREACHABLE_RETRY_MS, type Candidate, type ImportantDay, type NewsItem, type NewsKind, type ProactiveInput, type RescheduleItem, type ProactiveRecord, type ProactiveSettings,
} from './proactive.ts';
import type { BodyNow } from '../life/body.ts';
import { newObstacles, obstaclesBetween, OBSTACLE_KINDS, type ObstacleFacts, type ObstacleKind } from '.././world/obstacles.ts';
import { MEET_LEAD_MINUTES, type Appointment } from '../life/promises.ts';
import { PromiseStateUnavailable } from '../life/promise-state.ts';
import type { InitiateOutcome, Responder } from '.././social/responder.ts';
import type { DayWeather } from '.././world/weather.ts';
import { unwellNews, worldNews, type WorldNews, type WorldNow } from '.././world/world.ts';
import { formatDate, stateAt, wakeOn, type Schedule } from '../life/schedule.ts';
import { pendingMessages, pick } from '.././social/reply-timing.ts';
import {
    innerLine as innerLineOf, learnedLine, LEARNED_KEPT, parseThought, pendingIntents, THINK_AFTER_CHAT_MS, THINK_AFTER_WAKE_MS, THINK_INTERVAL_MIN, THINK_MAX_PER_DAY, THINK_MIN_GAP_MS, THINK_RETRY_MS, thinkNote, THOUGHTS_KEPT, type InnerState,
} from './inner.ts';

/** 记录留多少天 */
const KEEP_DAYS = 30;
/** 有真实天气时计划器最多睡多久就重算（ADR 0050） */
export const RAIN_REPLAN_MS = 30 * 60_000;
/**
 * 开了 proactiveReach（ADR 0100）时计划器最多睡多久就重算：她回完一句话之后没有人 poke 它（poke 只在收到他的消息时），
 * “聊着聊着他没再回”这种候选要靠定期重算才排得上
 */
export const REACH_REPLAN_MS = 10 * 60_000;
/** 状态文件暂时写不进时，多久补写一次 */
export const DIRTY_RETRY_MS = 60_000;

/** 这一刻在下吗：这个钟头或上一个钟头下过（实况） */
export function rainingAt(weather: DayWeather | undefined, at: Date): boolean {
    const hour = at.getHours();
    return Boolean(weather?.real && weather.rainHours?.some(h => h === hour || h === hour - 1));
}

/**
 * 今天的雨（ADR 0050）：在下的，按这场雨开始的钟头；还没下的，按预报第一个下雨的钟头；下过又停了的不算（不追着说早上那场雨）。只认真实天气
 */
export function rainOf(seen: { day: string; weather?: DayWeather } | undefined, at: Date): { day: string; start: number; forecast: boolean } | undefined {
    const weather = seen?.weather;
    if (!seen || !weather?.real) return undefined;
    const [y, m, d] = seen.day.split('-').map(Number);
    const hourOf = (h: number) => new Date(y!, m! - 1, d, h).getTime();
    if (rainingAt(weather, at)) {
        let start = weather.rainHours!.includes(at.getHours()) ? at.getHours() : at.getHours() - 1;
        while (weather.rainHours!.includes(start - 1)) start--;
        return { day: seen.day, start: hourOf(start), forecast: false };
    }
    return weather.laterHour !== undefined ? { day: seen.day, start: hourOf(weather.laterHour), forecast: true } : undefined;
}
const DAY_MS = 86_400_000;

/**
 * 她那边的事（ADR 0057、0064）：挑了结在她的今天、明天的那几件；app.ts 和模拟器共用。
 * 看三个快照：她今天、明天的最后一刻（作业写完了的当晚是看得到的：交作业的课一过，作业就不在世界快照里了），再加明天这一刻（相机，0057 原来的看法）；
 * 同一件事以先看到的为准。kinds 开了哪几类（没写 = 只有相机）；bodyAt 给了才有「不舒服」
 */
export function newsFrom(
    worldAt: (now: Date) => WorldNow | undefined, schedule: Schedule,
    options: { kinds?: readonly NewsKind[]; bodyAt?: (time: Date) => BodyNow } = {},
): (now: number) => NewsItem[] {
    const kinds = options.kinds ?? DEFAULT_NEWS_KINDS;
    return now => {
        const days = [now, now + DAY_MS].map(time => herDay(schedule, new Date(time)));
        const dayTexts = new Set(days.map(formatDate));
        const evening = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 23, 59);
        const found: WorldNews[] = [];
        for (const seen of [...days.map(day => worldAt(evening(day))), worldAt(new Date(now + DAY_MS))]) {
            if (seen) found.push(...worldNews(seen, kinds));
        }
        if (kinds.includes('unwell') && options.bodyAt) for (const day of days) found.push(...unwellNews(day, schedule, options.bodyAt));
        const seenIds = new Set<string>();
        return found
            .filter(item => !seenIds.has(item.id) && seenIds.add(item.id))
            .map(item => ({ id: item.id, kind: item.kind, day: formatDate(herDay(schedule, item.at)), at: item.at.getTime(), what: item.what, ...(item.dish ? { dish: item.dish } : {}), ...(item.feel ? { feel: item.feel } : {}) }))
            .filter(item => dayTexts.has(item.day));
    };
}

/** 同一类「不舒服」的改约至少隔这么多天才再来一次（ADR 0066 确认记录 1：每个周期最多一次，别和月经周期绑得太紧） */
export const UNWELL_RESCHEDULE_GAP_DAYS = 20;

/**
 * 约好之后她这边出了事、想改约的（ADR 0066 决策 3）：今天、明天开始的约，约的时候没有、现在有的障碍（obstacles.ts 的 newObstacles），
 * 每件约只取最要紧的一条；只给这个联系人的约，已经开始的不算。app.ts 和模拟器共用
 */
export function reschedulesFrom(options: {
    qq: number; facts: ObstacleFacts; appointments: (from: Date, to: Date) => readonly Appointment[];
}): (now: number) => RescheduleItem[] {
    return now => {
        const found: RescheduleItem[] = [];
        for (const meeting of options.appointments(new Date(now), new Date(now + 2 * DAY_MS))) {
            const { promise } = meeting;
            if (meeting.contact.qq !== options.qq || !promise.meet || meeting.start.getTime() <= now) continue;
            const window = obstaclesBetween(new Date(meeting.start.getTime() - MEET_LEAD_MINUTES * 60_000), meeting.end, options.facts, promise.id);
            const first = newObstacles(window, promise).sort((a, b) => OBSTACLE_KINDS.indexOf(a.kind) - OBSTACLE_KINDS.indexOf(b.kind))[0];
            if (!first) continue;
            const day = herDay(options.facts.schedule, meeting.start);
            found.push({
                id: promise.id, day: formatDate(day), at: wakeOn(options.facts.schedule, day).getTime(), start: meeting.start.getTime(),
                what: promise.what, time: promise.meet.time, ...(promise.meet.where ? { where: promise.meet.where } : {}),
                obstacle: { kind: first.kind, id: first.id, text: first.text },
            });
        }
        return found;
    };
}

/** 「不舒服」的改约每个周期最多一次（ADR 0066 确认记录 1）：前 UNWELL_RESCHEDULE_GAP_DAYS 天里已经为不舒服改过约（发了或试运行）的，这一件不再算 */
export function allowedReschedules(items: readonly RescheduleItem[], records: readonly ProactiveRecord[], now: number): RescheduleItem[] {
    return items.filter(item => item.obstacle.kind !== 'unwell'
        || !records.some(r => r.occasion === 'reschedule' && r.obstacle === 'unwell' && counts(r) && now - Date.parse(r.at) < UNWELL_RESCHEDULE_GAP_DAYS * DAY_MS));
}

export interface PlannerDeps {
    contact: Contact;
    schedule: Schedule;
    settings: ProactiveSettings;
    dates: readonly ImportantDay[];
    mode: 'dryRun' | 'on';
    /** 这一档的聊天记录（换档前的已经去掉） */
    history: { load(qq: number): StoredMessage[] };
    /** catchUp、status：有没回的消息、回复器又闲着（回复失败后放弃了）时，到了主动的时机先再回一次 */
    responder: Pick<Responder, 'initiate'> & Partial<Pick<Responder, 'catchUp' | 'status'>>;
    /** 记录文件所在的目录（<数据目录>/proactive） */
    dir: string;
    log: (message: string) => void;
    now?: () => number;
    /** 等到某个时刻；signal 中止时马上返回 */
    waitUntil?: (at: number, signal: AbortSignal) => Promise<void>;
    /** 抽待跟进的事用的模型调用；不传就不抽 */
    extract?: (messages: OpenAIMessage[]) => Promise<string>;
    /** 转写和抽取提示词里的称呼 */
    names: MacroNames;
    /** 回复器的「这一串不回」（contact.ts 的 replySkip）：看心情没回的那串不挡主动消息 */
    skip?: (history: StoredMessage[]) => string | undefined;
    /** 她在聊天里跟谁说过「睡了」、还没到起床（ADR 0042）：不主动 */
    asleep?: (now: number) => boolean;
    /** 她这一刻那边的天气（ADR 0050）：只认真实天气（real），按这个排「下雨」；有它时计划器最多睡 RAIN_REPLAN_MS 就重算（预报会变） */
    weather?: (now: number) => { day: string; weather?: DayWeather } | undefined;
    /** 她那边的事（ADR 0057）：她的今天、明天会了结的那几件 */
    news?: (now: number) => NewsItem[];
    /** 约好之后她这边出了事、想改约的（ADR 0066，reschedulesFrom） */
    reschedule?: (now: number) => RescheduleItem[];
    /** 货架里有这一类照片、这会儿也允许发（ADR 0110）；不给 = 不发“拍了张照片”那一类 */
    photoReady?: (kind: 'cat' | 'food', now: number, dish?: string) => boolean;
    /** 她最近在 B 站看过的东西（ADR 0130，配置 watching）：想事情时多一个“你怎么想”的题目；没有就 undefined */
    watchedFacts?: () => { id: string; text: string } | undefined;
    /** 此刻是不是正和他一起玩（ADR 0111）：是就不插别的主动消息 */
    together?: (now: number) => boolean;
    /** 随口说件事 / 约他 / 问他意见按他平时在线的钟头排（ADR 0117） */
    hisHours?: boolean;
    /** 现在是不是在危机信号的暂停期里（ADR 0068，crisis-state.ts）：普通主动消息不发，待跟进和重要的日子照旧 */
    crisisPaused?: (now: number) => boolean;
    /** 内心（ADR 0101，配置 innerLife）：每隔一阵她自己想一想，念头存在状态文件里；想告诉他 / 想问他的变成“心里惦记”的主动消息 */
    inner?: boolean;
    /**
     * 她自己想弄明白一件事（ADR 0180，配置 webLookup 开着）：念头里写了「想查：关键词」就调它真去查，
     * 返回摘出来的几条事实；没查成返回 undefined（她照实说不知道）
     */
    look?: (query: string) => Promise<string[] | undefined>;
}

export interface PlannerStatus {
    mode: 'dryRun' | 'on';
    /** 下一次：几点、什么时机 */
    next?: { at: number; label: string };
    /** 先不排的原因（她主动发的他还没回） */
    paused?: string;
    /** 她的今天已经主动了几条（试运行的也算） */
    today: number;
}

export interface Planner {
    /** 聊天记录变了：重新算下一次 */
    poke(): void;
    /** 从结束了的聊天片段里抽待跟进的事（同一时间只跑一个） */
    syncFollowUps(): Promise<void>;
    stop(): void;
    status(): PlannerStatus;
    /**
     * 他发「/主动」：让她现在就主动找他一次（ADR 0156）。不看“他还没回上一条”“夜里了”“一小时内聊过”“每天条数”这些闸，
     * 只守两条：他最近说过想伤害自己的话时不发；他有没回的消息时不发（回复就好）。返回 undefined = 已经交给回复器去发了；否则是一句不发的原因
     */
    fireNow(): Promise<string | undefined>;
    /** 她最近几个钟头心里在想什么，放进聊天提示词的一行（ADR 0101）；没开 innerLife、没有念头就没有 */
    innerLine(): string | undefined;
    /** 跑完当前这一轮（测试用） */
    readonly running: Promise<void>;
}

function waitUntilReal(at: number, signal: AbortSignal): Promise<void> {
    return new Promise(resolve => {
        const done = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        // setTimeout 最长约 24.8 天
        const timer = setTimeout(done, Math.min(Math.max(0, at - Date.now()), 2 ** 31 - 1));
        signal.addEventListener('abort', done);
        if (signal.aborted) done();
    });
}

const clock = (ms: number) => new Date(ms).toTimeString().slice(0, 5);

export function createProactivePlanner(deps: PlannerDeps): Planner {
    const now = deps.now ?? Date.now;
    const waitUntil = deps.waitUntil ?? waitUntilReal;
    const { contact } = deps;
    const path = join(deps.dir, `${contact.qq}-${contact.tier}.json`);
    mkdirSync(deps.dir, { recursive: true });
    const tag = deps.mode === 'dryRun' ? '（试运行）' : '';

    let state: ProactiveState;
    try { state = readProactiveState(path); }
    catch (error) {
        const reason = '主动消息状态读取或校验失败，已暂停；请修复后重新创建计划器';
        deps.log(`主动：${reason}；原文件未重建（原因：${describeError(error)}）`);
        return {
            poke() {}, stop() {}, fireNow: async () => reason, syncFollowUps: async () => {}, running: Promise.resolve(), innerLine: () => undefined,
            status: () => ({ mode: deps.mode, paused: reason, today: 0 }),
        };
    }
    let records = state.records;
    let followUps = state.followUps;
    /** 她的内心（ADR 0101）：念头和上一次想的时刻 */
    let inner: InnerState = state.inner ?? { thoughts: [] };
    /** 没想成（正在回消息、没连上模型）的下一次再试 */
    let thinkRetryAt: number | undefined;
    /** 片段 id → 抽过了（true），或者抽失败了几次 */
    const extracted = state.extracted;
    let extracting: Promise<void> | undefined;
    const startedAt = now();
    let stopped = false;
    let wake: AbortController | undefined;
    let next: Candidate | undefined;
    let paused: string | undefined;
    /** 还没到点的候选最近一次为什么没排上 */
    const notPlanned = new Map<string, string>();
    let loggedNext: string | undefined;

    /** 状态文件暂时写不进的宽限（transient-io.ts）：内存里的状态照旧生效，磁盘上是上一版，每分钟补写；持续超过宽限期才暂停 */
    const gate = createTransientGate();
    let dirty = false;

    function halt(reason?: unknown): void {
        stopped = true;
        next = undefined;
        paused = '主动消息状态处理失败，已暂停；请修复后重新创建计划器';
        wake?.abort();
        // 原因只写错误码 / 错误类型，不写 message（10-19 22:08 的暂停日志没写原因，事后查不出是什么触发的）
        deps.log(`主动：${paused}；未清空原状态${reason === undefined ? '' : `（原因：${describeError(reason)}）`}`);
    }

    function save(): void {
        if (stopped) throw new Error('主动消息已暂停，不再写入状态');
        try {
            const keepFrom = now() - KEEP_DAYS * DAY_MS;
            records = records.filter(r => Date.parse(r.at) >= keepFrom);
            // 抽过的片段只留最近的（片段 id 是 ep-<毫秒>）
            for (const id of Object.keys(extracted)) if (Number(id.slice(3)) < keepFrom) delete extracted[id];
            const next: ProactiveState = { version: 1, records, followUps, extracted, ...(inner.thoughts.length || inner.lastThinkAt || inner.reflected?.length ? { inner } : {}) };
            if (!validProactiveState(next)) throw new Error('拒绝写入不符合 schema 的主动消息状态');
            writeJsonAtomic(path, next);
            dirty = false;
            if (gate.ok('write')) deps.log('主动：状态文件写得进去了，恢复正常');
        } catch (error) {
            if (isTransientIoError(error) && gate.fail('write', now()) === 'retry') {
                dirty = true;
                if (gate.shouldLog('write', now())) deps.log(`主动：状态文件暂时写不进（${describeError(error)}），先用内存里的，每分钟补写一次；持续 5 分钟写不进才暂停`);
                return;
            }
            halt(error);
            throw new Error('主动消息状态写入失败，已暂停');
        }
    }

    /** 补写上次没写进去的状态；还在宽限期里就静静等下一次，拖过了 save() 自己会暂停 */
    function flushIfDirty(): void {
        if (!dirty || stopped) return;
        try { save(); } catch { /* save() 已经记过日志并暂停 */ }
    }

    /** 删掉一件待跟进的事 */
    function forget(id: string, why: string): void {
        const item = followUps.find(f => f.id === id);
        if (!item) return;
        followUps = followUps.filter(f => f.id !== id);
        save();
        deps.log(`待跟进：${why}，忘掉「${logBody(item.what)}」（${item.date} ${partText(item.time)}）`);
    }

    /** 问这件事的主动消息发出去了：问到了就忘；没问出口的留着下次再问，第二次还没问出口也忘了 */
    function asked(id: string, said: readonly string[], dryRun: boolean): void {
        const item = followUps.find(f => f.id === id);
        if (!item) return;
        if (mentions(item, said)) return forget(id, dryRun ? '试运行里问过了' : '问过了');
        if ((item.missed ?? 0) >= 1) return forget(id, '又没问出口');
        followUps = followUps.map(f => (f.id === id ? { ...f, missed: (f.missed ?? 0) + 1 } : f));
        save();
        deps.log(`待跟进：她没问出口「${logBody(item.what)}」，留着下次再问`);
    }

    async function extractNow(): Promise<void> {
        if (!deps.extract) return;
        const history = deps.history.load(contact.qq);
        const closed = splitEpisodes(history).filter(e => now() - e.end.getTime() >= EPISODE_GAP_MS && extracted[e.id] !== true);
        let changed = false;
        for (const episode of closed) {
            if (stopped) return;
            // 危机相关的片段不抽成待跟进，也不让她主动提起（ADR 0068 决策 8）
            if (episode.messages.some(m => m.role === 'user' && detectCrisis(m.content))) {
                extracted[episode.id] = true;
                save();
                continue;
            }
            // 只有她说话的片段（没人回的主动消息）不用抽
            if (!episode.messages.some(m => m.role === 'user')) {
                extracted[episode.id] = true;
                save();
                continue;
            }
            let result: Extracted;
            try {
                result = parseExtraction(await deps.extract(extractionPrompt(episodeTranscript(episode, deps.names), followUps, deps.names)));
            } catch (error) {
                if (error instanceof ModelUnreachable) {
                    // 没连上模型（断网、DNS）不算这一段的失败次数；后面的片段也连不上，这一轮先停
                    deps.log(`待跟进：片段 ${episode.id} 没连上模型，等网络好了再抽：${error.message}`);
                    break;
                }
                const tries = (typeof extracted[episode.id] === 'number' ? extracted[episode.id] as number : 0) + 1;
                // 模型回了、但连着 3 次都不对就放弃这一段（别一直调模型）
                extracted[episode.id] = tries >= 3 ? true : tries;
                save();
                deps.log(`待跟进：片段 ${episode.id} 抽取失败（第 ${tries} 次${tries >= 3 ? '，不再抽' : '，下次再抽'}）：${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
            if (stopped) return;
            for (const id of result.resolved) {
                if (followUps.some(f => f.id === id)) {
                    forget(id, '他已经说了结果');
                    changed = true;
                }
            }
            const today = herDay(deps.schedule, new Date(now()));
            for (const [i, add] of result.add.entries()) {
                const item: FollowUp = { id: `f-${episode.start.getTime()}-${i + 1}`, ...add, episode: episode.id };
                if (aboutHer(item.what, deps.names.char)) {
                    deps.log(`待跟进：「${logBody(item.what)}」是冲着她的事，不记`);
                    continue;
                }
                if (expired(item, today) || followUps.some(f => f.what === item.what && f.date === item.date)) continue;
                followUps = [...followUps, item];
                changed = true;
                deps.log(`待跟进：记下「${logBody(item.what)}」（${item.date} ${partText(item.time)}）`);
            }
            extracted[episode.id] = true;
            save();
        }
        if (changed) wake?.abort();
    }

    function record(candidate: Candidate, patch: Pick<ProactiveRecord, 'result'> & Partial<ProactiveRecord>): ProactiveRecord {
        const entry: ProactiveRecord = {
            id: candidate.id, occasion: candidate.occasion, plannedAt: new Date(candidate.at).toISOString(), at: new Date(now()).toISOString(), ...patch,
            ...(candidate.reschedule ? { obstacle: candidate.reschedule.obstacle.kind } : {}),
        };
        records = [...records.filter(r => r.id !== candidate.id), entry];
        save();
        return entry;
    }

    /** 约定来源暂时读不到（承诺状态文件在宽限期里）：这一轮不排改约，别让异常一路冒到 loop 把整个主动消息停掉 */
    let reschedulesUnavailable = false;
    const reschedulesNow = (): RescheduleItem[] => {
        try {
            const items = allowedReschedules(deps.reschedule!(now()), records, now());
            if (reschedulesUnavailable) deps.log(`主动${tag}：约定来源又读得到了，恢复排改约`);
            reschedulesUnavailable = false;
            return items;
        } catch (error) {
            if (!(error instanceof PromiseStateUnavailable)) throw error;
            if (!reschedulesUnavailable) deps.log(`主动${tag}：约定来源暂时读不到，这段时间不排改约，别的主动消息照旧`);
            reschedulesUnavailable = true;
            return [];
        }
    };

    const input = (): ProactiveInput => {
        const rain = deps.weather ? rainOf(deps.weather(now()), new Date(now())) : undefined;
        return {
            qq: contact.qq, schedule: deps.schedule, settings: deps.settings, dates: deps.dates,
            history: deps.history.load(contact.qq), records, mode: deps.mode, followUps, ...(deps.skip ? { skip: deps.skip } : {}),
            ...(deps.asleep ? { asleep: deps.asleep } : {}),
            ...(deps.crisisPaused?.(now()) ? { crisisPaused: true } : {}),
            ...(deps.inner ? { inner: pendingIntents(inner.thoughts, now()) } : {}),
            ...(rain ? { rain } : {}),
            // 只认卡上开了的事件类（ADR 0064 决策 6）：没开的类即使调用方给了也不排
            ...(deps.news ? { news: deps.news(now()).filter(item => newsKindsOf(deps.settings).includes(item.kind)) } : {}),
            ...(deps.reschedule ? { reschedules: reschedulesNow() } : {}),
            ...(deps.photoReady ? { photoReady: deps.photoReady } : {}),
            ...(deps.together ? { together: deps.together } : {}),
            ...(deps.hisHours ? { hisHours: true } : {}),
            ...(deps.weather ? { rainingNow: (at: number) => rainingAt(deps.weather!(at)?.weather, new Date(at)) } : {}),
        };
    };

    function describe(candidate: Candidate): string {
        const day = formatDate(new Date(candidate.at)) === formatDate(new Date(now())) ? '今天' : '明天';
        return `${day} ${clock(candidate.at)} ${candidateLabel(candidate)}`;
    }

    /** 手动让她现在找他（fireNow）时只看这两条：危机暂停、他有没回的消息 */
    function manualBlock(current: ProactiveInput): string | undefined {
        if (current.crisisPaused) return CRISIS_PAUSE_REASON;
        if (pendingMessages([...current.history]).length && !current.skip?.([...current.history])) return PENDING_REASON;
        return undefined;
    }

    async function fire(candidate: Candidate, manual = false): Promise<void> {
        const current = input();
        const reason = manual ? manualBlock(current) : blockReason(candidate, now(), current);
        if (reason) {
            record(candidate, { result: 'skipped', reason });
            deps.log(`主动${tag}：${candidateLabel(candidate)}不发：${reason}`);
            // 回复失败放弃了的（多半是断网）：不然她要等他下一条才说话，主动又一直被这条挡住
            if (reason === PENDING_REASON && deps.responder.catchUp && deps.responder.status?.().phase === 'idle') {
                deps.log(`主动${tag}：没回的消息还没回，先再回一次`);
                deps.responder.catchUp();
            }
            return;
        }
        let committed: ProactiveRecord | undefined;
        const dryRun = deps.mode === 'dryRun';
        // 她那边的事没说成（ADR 0057 调整）：这一条顺带说
        const untold = untoldNews(candidate, now(), current);
        if (untold.length) deps.log(`主动${tag}：${candidateLabel(candidate)}顺带说没说成的事：${untold.map(n => n.what).join('、')}`);
        const outcome: InitiateOutcome = await deps.responder.initiate({
            label: candidateLabel(candidate),
            note: occasionNote(candidate, contact.name, untold),
            topic: recallTopic(candidate, contact.name),
            maxBubbles: MAX_PROACTIVE_BUBBLES,
            ...(candidate.occasion === 'reach' || candidate.occasion === 'invite' || candidate.occasion === 'ask' ? { canDecline: true } : {}),
            ...(candidate.news?.kind === 'cat_photo' ? { photo: 'cat' as const } : {}),
            ...(candidate.news?.kind === 'food_photo' && candidate.news.dish ? { photo: 'food' as const, photoDish: candidate.news.dish } : {}),
            dryRun,
            // 先记后发
            commit: () => { committed = record(candidate, { result: dryRun ? 'dryRun' : 'sent' }); },
        });
        switch (outcome.result) {
            case 'sent':
                record(candidate, { result: 'sent', at: committed!.at, messageIds: outcome.messageIds });
                deps.log(`主动找他（${candidateLabel(candidate)}）${outcome.parts.length > 1 ? `（${outcome.parts.length} 条）` : ''}：${logBody(outcome.parts.join(' / '))}`);
                if (candidate.followUp) asked(candidate.followUp.item.id, outcome.parts, false);
                // 心里惦记的念头说出去了：记成说过（聊天提示词里不再当“心里的小心思”放，也不会再变成主动消息）
                if (candidate.inner) {
                    inner = { ...inner, thoughts: inner.thoughts.map(t => (t.id === candidate.inner!.id ? { ...t, told: true as const } : t)) };
                    save();
                }
                break;
            case 'dryRun':
                deps.log(`主动（试运行，没发）：${candidateLabel(candidate)}；今天第 ${usedToday()} 条；本来要说：${logBody(outcome.parts.join(' / '))}`);
                if (candidate.followUp) asked(candidate.followUp.item.id, outcome.parts, true);
                break;
            case 'skipped':
                record(candidate, { result: 'skipped', reason: outcome.reason });
                deps.log(`主动${tag}：${candidateLabel(candidate)}不发：${outcome.reason}`);
                break;
            case 'failed': {
                // 没连上模型（断网、DNS）：过一会儿再试，同一天最多 UNREACHABLE_MAX_TRIES 次；别的错不再试
                const tries = (records.find(r => r.id === candidate.id)?.tries ?? 0) + 1;
                if (outcome.unreachable && !outcome.messageIds && tries < UNREACHABLE_MAX_TRIES) {
                    const retryAt = now() + UNREACHABLE_RETRY_MS;
                    record(candidate, { result: 'failed', reason: outcome.reason, retryAt: new Date(retryAt).toISOString(), tries });
                    deps.log(`主动${tag}：${candidateLabel(candidate)}没连上模型（第 ${tries} 次），${clock(retryAt)} 再试：${outcome.reason}`);
                    break;
                }
                record(candidate, {
                    result: 'failed', reason: outcome.reason, ...(outcome.unreachable ? { tries } : {}),
                    ...(outcome.messageIds ? { messageIds: outcome.messageIds } : {}),
                });
                deps.log(`主动${tag}：${candidateLabel(candidate)}出错，不再试${outcome.unreachable ? `（没连上模型 ${tries} 次）` : ''}：${outcome.reason}`);
                if (outcome.messageIds?.length) deps.log(`主动${tag}：${candidateLabel(candidate)}只发出去了 ${outcome.messageIds.length} 条，后面的没发出去：按已发算（ADR 0011 核对 10-12 的取舍：宁可不重复），这件事不会再补说；要补得他问起或下次聊到`);
                break;
            }
        }
    }

    // ---------- 内心（ADR 0101）----------

    const MIN = 60_000;
    /** 睡着（作息上 / 说过睡了）的时刻不想 */
    const thinkAsleep = (time: number) => stateAt(deps.schedule, new Date(time)).activity.kind === 'sleep' || Boolean(deps.asleep?.(time));
    const dayAfter = (day: Date) => new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);

    /** 下一次什么时候想：上一次之后隔 90–150 分钟（按上一次的时刻取种子）；聊完一段（他说过话、之后 20 分钟没人说话）就早一点；睡着的推到起床后；一天最多 THINK_MAX_PER_DAY 次 */
    function nextThinkAt(): number {
        const last = inner.lastThinkAt ? Date.parse(inner.lastThinkAt) : undefined;
        const today = herDay(deps.schedule, new Date(now()));
        let at = last === undefined
            ? wakeOn(deps.schedule, today).getTime() + THINK_AFTER_WAKE_MS
            : last + pick(`${contact.qq} ${last}`, 'think', [THINK_INTERVAL_MIN[0] * MIN, THINK_INTERVAL_MIN[1] * MIN]);
        if (last !== undefined) {
            const chat = deps.history.load(contact.qq);
            const lastMessage = chat.at(-1);
            if (lastMessage && Date.parse(lastMessage.time) > last && chat.some(m => m.role === 'user' && Date.parse(m.time) > last)) {
                at = Math.min(at, Math.max(Date.parse(lastMessage.time) + THINK_AFTER_CHAT_MS, last + THINK_MIN_GAP_MS));
            }
        }
        if (thinkRetryAt !== undefined) at = Math.max(at, thinkRetryAt);
        const day = herDay(deps.schedule, new Date(at));
        const dayText = formatDate(day);
        const todayCount = inner.thoughts.filter(t => formatDate(herDay(deps.schedule, new Date(t.at))) === dayText).length;
        if (todayCount >= THINK_MAX_PER_DAY) at = wakeOn(deps.schedule, dayAfter(day)).getTime() + THINK_AFTER_WAKE_MS;
        if (thinkAsleep(at)) {
            const d = herDay(deps.schedule, new Date(at));
            let wakeAt = wakeOn(deps.schedule, d).getTime() + THINK_AFTER_WAKE_MS;
            if (wakeAt <= at) wakeAt = wakeOn(deps.schedule, dayAfter(d)).getTime() + THINK_AFTER_WAKE_MS;
            at = wakeAt;
        }
        return at;
    }

    const GOES_LABEL = { tell: '想告诉他', ask: '想问他', keep: '自己想想' } as const;

    /** 想一次：借回复器的主动通道生成（带着她的时间、状态、心情、世界、记忆和最近的聊天），不发送；留下的念头存进状态文件 */
    async function think(): Promise<void> {
        const started = now();
        // 写成了对他说话（出现“你”）就再来一次，最多两次；别的不合格（重复、太短）不重来
        let parsed: ReturnType<typeof parseThought> | undefined;
        // 她最近看过的视频（ADR 0130）：还没专门想过的，这一次就想这一件；想过的只是多一个可选的题目
        const watched = deps.watchedFacts?.();
        const forceWatch = Boolean(watched && !inner.reflected?.includes(watched.id));
        for (const retry of [false, true]) {
            const outcome = await deps.responder.initiate({
                label: '内心', note: thinkNote(inner.thoughts.slice(-3), contact.name, inner.thoughts.length, retry, watched?.text, forceWatch),
                topic: `${contact.name}最近在忙什么、我自己最近惦记什么、担心什么、期待什么`,
                maxBubbles: 1, dryRun: false, think: true, commit: () => undefined,
            });
            if (stopped) return;
            if (outcome.result !== 'thought') {
                thinkRetryAt = now() + (outcome.result === 'failed' ? UNREACHABLE_RETRY_MS : THINK_RETRY_MS);
                deps.log(`内心${tag}：没想成，${clock(thinkRetryAt)} 再试：${outcome.result === 'skipped' || outcome.result === 'failed' ? outcome.reason : ''}`);
                return;
            }
            parsed = parseThought(outcome.text, inner.thoughts.slice(-8), started, contact.name);
            if (!('rejected' in parsed) || (parsed.rejected !== '对他说话' && parsed.rejected !== '书面腔')) break;
            deps.log(`内心${tag}：写成了${parsed.rejected === '书面腔' ? '书面腔' : '对他说话'}，${retry ? '不留' : '再想一次'}`);
        }
        thinkRetryAt = undefined;
        inner = { ...inner, lastThinkAt: new Date(started).toISOString() };
        if (!parsed || 'rejected' in parsed) {
            const rejected = parsed && 'rejected' in parsed ? parsed.rejected : '没有结果';
            save();
            deps.log(`内心${tag}：想了，但不留（${rejected}）`);
            return;
        }
        inner = { ...inner, thoughts: [...inner.thoughts, parsed.thought].slice(-THOUGHTS_KEPT), ...(forceWatch && watched ? { reflected: [...(inner.reflected ?? []), watched.id].slice(-30) } : {}) };
        // 她自己想弄明白的事（ADR 0180）：念头里写了「想查：关键词」就真去查一次，查到的存起来，下次聊天里能带到
        if (parsed.wants && deps.look) {
            const facts = await deps.look(parsed.wants).catch(() => undefined);
            if (facts?.length) {
                const learned = { id: `lk-${started}`, at: new Date(started).toISOString(), query: parsed.wants, facts };
                inner = { ...inner, learned: [...(inner.learned ?? []), learned].slice(-LEARNED_KEPT) };
                deps.log(`内心${tag}：想知道「${logBody(parsed.wants)}」，查到了 ${facts.length} 条`);
            } else {
                deps.log(`内心${tag}：想知道「${logBody(parsed.wants)}」，没查到`);
            }
        }
        save();
        deps.log(`内心${tag}：${logBody(parsed.thought.text)}（${GOES_LABEL[parsed.thought.goes]}）`);
    }

    function usedToday(): number {
        const day = formatDate(herDay(deps.schedule, new Date(now())));
        // 和额度用同一个口径（counts）：发了一半就出错的也算一条（原来状态页写 1 条、真正卡额度的是 2 条；DSH 10-15 复核 0064 问题 3）
        return records.filter(r => r.id.startsWith(`${day}:`) && r.occasion !== 'dates' && counts(r)).length;
    }

    async function loop(): Promise<void> {
        while (!stopped) {
            flushIfDirty();
            if (stopped) return;
            const today = herDay(deps.schedule, new Date(now()));
            for (const item of followUps.filter(f => expired(f, today))) forget(item.id, `过了 ${FOLLOW_UP_DAYS} 天还没问到`);
            const his = deps.history.load(contact.qq).filter(m => m.role === 'user');
            for (const item of followUps.filter(f => tripAlreadyOver(f, his))) forget(item.id, '行程过去了，他后来又来聊过，不用再问');
            const current = input();
            const plan = planFrom(now(), current);
            for (const candidate of plan.missed) {
                // 计划器在跑的时候过去的：用它过去之前最后一次没排上的原因；启动之前过去的：bot 没在跑，错过了
                const reason = candidate.at < startedAt ? '错过了，不补' : notPlanned.get(candidate.id) ?? '没排上';
                record(candidate, { result: 'skipped', reason });
                deps.log(`主动${tag}：${candidateLabel(candidate)}计划在 ${clock(candidate.at)}，${reason}`);
            }
            // 还没到点的候选这一次为什么没排上（到点过去之后记进记录）
            const upcomingIds = new Set(plan.upcoming.map(c => c.id));
            for (const candidate of candidatesOn(today, current)) {
                if (candidate.at <= now() || upcomingIds.has(candidate.id)) continue;
                if (plan.yielded.some(c => c.id === candidate.id)) notPlanned.set(candidate.id, '今天的条数留给了别的时机');
                else if (plan.paused) notPlanned.set(candidate.id, '上一条主动消息他还没回');
                else notPlanned.delete(candidate.id);
            }
            next = plan.upcoming[0];
            paused = plan.paused;
            const key = `${next ? `${next.id} ${next.at}` : ''} ${paused ?? ''}`;
            if (key !== loggedNext) {
                loggedNext = key;
                const parts = [...(paused ? [paused] : []), next ? `下一次 ${describe(next)}` : '今明两天没有要发的了'];
                deps.log(`主动${tag}：${logBody(parts.join('；'))}`);
            }
            // 没有要发的：等到下一天开始再算
            const day = herDay(deps.schedule, new Date(now()));
            const untilTomorrow = next?.at ?? new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, ...deps.schedule.sleep.split(':').map(Number) as [number, number], 1).getTime();
            // 有真实天气时最多睡这么久就重算：预报会变，雨可能提前、推后（ADR 0050）
            const withWeather = deps.weather ? Math.min(untilTomorrow, now() + RAIN_REPLAN_MS) : untilTomorrow;
            const planned = deps.settings.reach ? Math.min(withWeather, now() + REACH_REPLAN_MS) : withWeather;
            // 有没写进去的状态时，最多睡一分钟就起来补写（持续 5 分钟写不进 save() 会暂停）
            const thinkAt = deps.inner ? nextThinkAt() : undefined;
            const withThink = thinkAt === undefined ? planned : Math.min(planned, thinkAt);
            const target = dirty ? Math.min(withThink, now() + DIRTY_RETRY_MS) : withThink;
            wake = new AbortController();
            await waitUntil(target, wake.signal);
            const poked = wake.signal.aborted;
            wake = undefined;
            if (stopped) return;
            // 该想了：想完重新算（念头可能变成要说的话）
            if (thinkAt !== undefined && now() >= thinkAt) {
                await think();
                continue;
            }
            if (poked || !next || now() < next.at) continue;
            // 到点：按现在的聊天记录再算一遍（冷场的时刻可能往后挪了，或者让给了优先级更高的）
            const fresh = planFrom(now(), input()).upcoming.find(c => c.id === next!.id);
            if (!fresh || fresh.at > now()) continue;
            await fire(fresh);
        }
    }

    const running = loop().catch(error => { if (!stopped) halt(error); });

    return {
        poke() {
            wake?.abort();
        },
        async fireNow() {
            if (stopped) return '主动消息已经停了';
            const reason = manualBlock(input());
            if (reason) {
                deps.log(`主动${tag}：他让她现在找他，但不发：${reason}`);
                return reason;
            }
            const day = formatDate(herDay(deps.schedule, new Date(now())));
            const candidate: Candidate = { id: `${day}:share:manual-${now()}`, occasion: 'share', day, at: now(), reason: '他让她现在找他' };
            deps.log(`主动${tag}：他让她现在找他`);
            await fire(candidate, true);
            return undefined;
        },
        syncFollowUps() {
            if (stopped) return Promise.resolve();
            extracting ??= extractNow().catch(error => { if (!stopped) halt(error); }).finally(() => { extracting = undefined; });
            return extracting;
        },
        stop() {
            stopped = true;
            wake?.abort();
        },
        innerLine: () => (deps.inner
            ? [innerLineOf(inner.thoughts, now()), learnedLine(inner.learned, now())].filter(Boolean).join('\n') || undefined
            : undefined),
        status: () => ({
            mode: deps.mode,
            ...(next ? { next: { at: next.at, label: candidateLabel(next) } } : {}),
            ...(paused ? { paused } : {}),
            today: usedToday(),
        }),
        running,
    };
}
