// 主动消息的计划器（ADR 0011 决策 2、4、5、7）：一个联系人一个。按 proactive.ts 算下一次，等到点，再查一遍条件，交给回复器的 initiate。
// - 记录文件 <数据目录>/proactive/<QQ>-<档位>.json：每个候选到点后记一条（发了、试运行、没发及原因、出错），记过的不再排；
//   发之前先记（initiate 的 commit），之后崩溃、断线都不重发；只留 30 天。
// - 错过的不补：启动、重新算的时候已经过了 GRACE_MS 的候选记成「错过了，不补」。
// - 聊天记录变了（收到、补回）就 poke()：重新算（冷场的时刻跟着最后一条消息走）。
// - 等待用可替换的 waitUntil（bot 用真实定时器，模拟器用虚拟时钟）。
// - 待跟进的事（follow-ups.ts）也存在这个文件里：syncFollowUps() 从结束了的聊天片段里抽（调用方定时调），
//   问过（发了或试运行）就删，过了 FOLLOW_UP_DAYS 天没问到也删。
// - 记录文件先写临时文件再改名；读坏了挪开、从空记录开始（ADR 0013 决策 3）：过去超过 GRACE_MS 的候选记成「错过了，不补」，
//   刚发过的有「一小时内聊过」（睡前是 20 分钟）挡着，计划器不会因为一个坏文件起不来。

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from './config.ts';
import { aboutHer, expired, extractionPrompt, FOLLOW_UP_DAYS, mentions, parseExtraction, partText, type Extracted, type FollowUp } from './follow-ups.ts';
import type { StoredMessage } from './history.ts';
import { readJsonOr, writeJsonAtomic } from './json-file.ts';
import { ModelUnreachable } from './llm.ts';
import { EPISODE_GAP_MS, episodeTranscript, splitEpisodes } from './memory/episodes.ts';
import type { OpenAIMessage } from './prompt.ts';
import type { MacroNames } from './st/macros.ts';
import {
    blockReason, candidateLabel, candidatesOn, herDay, MAX_PROACTIVE_BUBBLES, occasionNote, PENDING_REASON, planFrom, recallTopic,
    type Candidate, type ImportantDay, type ProactiveInput, type ProactiveRecord, type ProactiveSettings,
} from './proactive.ts';
import type { InitiateOutcome, Responder } from './responder.ts';
import { formatDate, type Schedule } from './schedule.ts';

/** 记录留多少天 */
const KEEP_DAYS = 30;
const DAY_MS = 86_400_000;

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

    const state = load();
    let records = state.records;
    let followUps = state.followUps;
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

    function load(): { records: ProactiveRecord[]; followUps: FollowUp[]; extracted: Record<string, true | number> } {
        const data = readJsonOr<{ records?: ProactiveRecord[]; followUps?: FollowUp[]; extracted?: Record<string, true | number> }>(
            path, {}, message => deps.log(`主动：${message}`));
        return { records: data.records ?? [], followUps: data.followUps ?? [], extracted: data.extracted ?? {} };
    }

    function save(): void {
        const keepFrom = now() - KEEP_DAYS * DAY_MS;
        records = records.filter(r => Date.parse(r.at) >= keepFrom);
        // 抽过的片段只留最近的（片段 id 是 ep-<毫秒>）
        for (const id of Object.keys(extracted)) if (Number(id.slice(3)) < keepFrom) delete extracted[id];
        writeJsonAtomic(path, { records, followUps, extracted });
    }

    /** 删掉一件待跟进的事 */
    function forget(id: string, why: string): void {
        const item = followUps.find(f => f.id === id);
        if (!item) return;
        followUps = followUps.filter(f => f.id !== id);
        save();
        deps.log(`待跟进：${why}，忘掉「${item.what}」（${item.date} ${partText(item.time)}）`);
    }

    /** 问这件事的主动消息发出去了：问到了就忘；没问出口的留着下次再问，第二次还没问出口也忘了 */
    function asked(id: string, said: readonly string[], dryRun: boolean): void {
        const item = followUps.find(f => f.id === id);
        if (!item) return;
        if (mentions(item, said)) return forget(id, dryRun ? '试运行里问过了' : '问过了');
        if ((item.missed ?? 0) >= 1) return forget(id, '又没问出口');
        followUps = followUps.map(f => (f.id === id ? { ...f, missed: (f.missed ?? 0) + 1 } : f));
        save();
        deps.log(`待跟进：她没问出口「${item.what}」，留着下次再问`);
    }

    async function extractNow(): Promise<void> {
        if (!deps.extract) return;
        const history = deps.history.load(contact.qq);
        const closed = splitEpisodes(history).filter(e => now() - e.end.getTime() >= EPISODE_GAP_MS && extracted[e.id] !== true);
        let changed = false;
        for (const episode of closed) {
            if (stopped) return;
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
                    deps.log(`待跟进：「${item.what}」是冲着她的事，不记`);
                    continue;
                }
                if (expired(item, today) || followUps.some(f => f.what === item.what && f.date === item.date)) continue;
                followUps = [...followUps, item];
                changed = true;
                deps.log(`待跟进：记下「${item.what}」（${item.date} ${partText(item.time)}）`);
            }
            extracted[episode.id] = true;
            save();
        }
        if (changed) wake?.abort();
    }

    function record(candidate: Candidate, patch: Pick<ProactiveRecord, 'result'> & Partial<ProactiveRecord>): ProactiveRecord {
        const entry: ProactiveRecord = {
            id: candidate.id, occasion: candidate.occasion, plannedAt: new Date(candidate.at).toISOString(), at: new Date(now()).toISOString(), ...patch,
        };
        records = [...records.filter(r => r.id !== candidate.id), entry];
        save();
        return entry;
    }

    const input = (): ProactiveInput => ({
        qq: contact.qq, schedule: deps.schedule, settings: deps.settings, dates: deps.dates,
        history: deps.history.load(contact.qq), records, mode: deps.mode, followUps, ...(deps.skip ? { skip: deps.skip } : {}),
        ...(deps.asleep ? { asleep: deps.asleep } : {}),
    });

    function describe(candidate: Candidate): string {
        const day = formatDate(new Date(candidate.at)) === formatDate(new Date(now())) ? '今天' : '明天';
        return `${day} ${clock(candidate.at)} ${candidateLabel(candidate)}`;
    }

    async function fire(candidate: Candidate): Promise<void> {
        const current = input();
        const reason = blockReason(candidate, now(), current);
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
        const outcome: InitiateOutcome = await deps.responder.initiate({
            label: candidateLabel(candidate),
            note: occasionNote(candidate, contact.name),
            topic: recallTopic(candidate, contact.name),
            maxBubbles: MAX_PROACTIVE_BUBBLES,
            dryRun,
            // 先记后发
            commit: () => { committed = record(candidate, { result: dryRun ? 'dryRun' : 'sent' }); },
        });
        switch (outcome.result) {
            case 'sent':
                record(candidate, { result: 'sent', at: committed!.at, messageIds: outcome.messageIds });
                deps.log(`主动找他（${candidateLabel(candidate)}）${outcome.parts.length > 1 ? `（${outcome.parts.length} 条）` : ''}：${outcome.parts.join(' / ')}`);
                if (candidate.followUp) asked(candidate.followUp.item.id, outcome.parts, false);
                break;
            case 'dryRun':
                deps.log(`主动（试运行，没发）：${candidateLabel(candidate)}；今天第 ${usedToday()} 条；本来要说：${outcome.parts.join(' / ')}`);
                if (candidate.followUp) asked(candidate.followUp.item.id, outcome.parts, true);
                break;
            case 'skipped':
                record(candidate, { result: 'skipped', reason: outcome.reason });
                deps.log(`主动${tag}：${candidateLabel(candidate)}不发：${outcome.reason}`);
                break;
            case 'failed':
                record(candidate, { result: 'failed', reason: outcome.reason, ...(outcome.messageIds ? { messageIds: outcome.messageIds } : {}) });
                deps.log(`主动${tag}：${candidateLabel(candidate)}出错，不再试：${outcome.reason}`);
                break;
        }
    }

    function usedToday(): number {
        const day = formatDate(herDay(deps.schedule, new Date(now())));
        return records.filter(r => r.id.startsWith(`${day}:`) && r.occasion !== 'dates' && (r.result === 'sent' || r.result === 'dryRun')).length;
    }

    async function loop(): Promise<void> {
        while (!stopped) {
            const today = herDay(deps.schedule, new Date(now()));
            for (const item of followUps.filter(f => expired(f, today))) forget(item.id, `过了 ${FOLLOW_UP_DAYS} 天还没问到`);
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
                deps.log(`主动${tag}：${parts.join('；')}`);
            }
            // 没有要发的：等到下一天开始再算
            const day = herDay(deps.schedule, new Date(now()));
            const target = next?.at ?? new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, ...deps.schedule.sleep.split(':').map(Number) as [number, number], 1).getTime();
            wake = new AbortController();
            await waitUntil(target, wake.signal);
            const poked = wake.signal.aborted;
            wake = undefined;
            if (stopped) return;
            if (poked || !next || now() < next.at) continue;
            // 到点：按现在的聊天记录再算一遍（冷场的时刻可能往后挪了，或者让给了优先级更高的）
            const fresh = planFrom(now(), input()).upcoming.find(c => c.id === next!.id);
            if (!fresh || fresh.at > now()) continue;
            await fire(fresh);
        }
    }

    const running = loop().catch(error => deps.log(`主动：计划器出错，停了：${error instanceof Error ? error.message : String(error)}`));

    return {
        poke() {
            wake?.abort();
        },
        syncFollowUps() {
            extracting ??= extractNow().finally(() => { extracting = undefined; });
            return extracting;
        },
        stop() {
            stopped = true;
            wake?.abort();
        },
        status: () => ({
            mode: deps.mode,
            ...(next ? { next: { at: next.at, label: candidateLabel(next) } } : {}),
            ...(paused ? { paused } : {}),
            today: usedToday(),
        }),
        running,
    };
}
