// 主动消息的计划器（ADR 0011 决策 2、4、5、7）：一个联系人一个。按 proactive.ts 算下一次，等到点，再查一遍条件，交给回复器的 initiate。
// - 记录文件 <数据目录>/proactive/<QQ>-<档位>.json：每个候选到点后记一条（发了、试运行、没发及原因、出错），记过的不再排；
//   发之前先记（initiate 的 commit），之后崩溃、断线都不重发；只留 30 天。
// - 错过的不补：启动、重新算的时候已经过了 GRACE_MS 的候选记成「错过了，不补」。
// - 聊天记录变了（收到、补回）就 poke()：重新算（冷场的时刻跟着最后一条消息走）。
// - 等待用可替换的 waitUntil（bot 用真实定时器，模拟器用虚拟时钟）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Contact } from './config.ts';
import type { StoredMessage } from './history.ts';
import {
    blockReason, candidateLabel, herDay, MAX_PROACTIVE_BUBBLES, occasionNote, planFrom,
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
    responder: Pick<Responder, 'initiate'>;
    /** 记录文件所在的目录（<数据目录>/proactive） */
    dir: string;
    log: (message: string) => void;
    now?: () => number;
    /** 等到某个时刻；signal 中止时马上返回 */
    waitUntil?: (at: number, signal: AbortSignal) => Promise<void>;
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

    let records = load();
    const startedAt = now();
    let stopped = false;
    let wake: AbortController | undefined;
    let next: Candidate | undefined;
    let paused: string | undefined;
    let loggedNext: string | undefined;

    function load(): ProactiveRecord[] {
        if (!existsSync(path)) return [];
        return (JSON.parse(readFileSync(path, 'utf8')) as { records?: ProactiveRecord[] }).records ?? [];
    }

    function save(): void {
        const keepFrom = now() - KEEP_DAYS * DAY_MS;
        records = records.filter(r => Date.parse(r.at) >= keepFrom);
        writeFileSync(path, JSON.stringify({ records }, null, 2) + '\n');
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
        history: deps.history.load(contact.qq), records, mode: deps.mode,
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
            return;
        }
        let committed: ProactiveRecord | undefined;
        const dryRun = deps.mode === 'dryRun';
        const outcome: InitiateOutcome = await deps.responder.initiate({
            label: candidateLabel(candidate),
            note: occasionNote(candidate, contact.name),
            maxBubbles: MAX_PROACTIVE_BUBBLES,
            dryRun,
            // 先记后发
            commit: () => { committed = record(candidate, { result: dryRun ? 'dryRun' : 'sent' }); },
        });
        switch (outcome.result) {
            case 'sent':
                record(candidate, { result: 'sent', at: committed!.at, messageIds: outcome.messageIds });
                deps.log(`主动找他（${candidateLabel(candidate)}）${outcome.parts.length > 1 ? `（${outcome.parts.length} 条）` : ''}：${outcome.parts.join(' / ')}`);
                break;
            case 'dryRun':
                deps.log(`主动（试运行，没发）：${candidateLabel(candidate)}；今天第 ${usedToday()} 条；本来要说：${outcome.parts.join(' / ')}`);
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
            const plan = planFrom(now(), input());
            for (const candidate of plan.missed) {
                // 计划器在跑的时候过去的：那时没排上（等他回、条数留给了优先级更高的）；启动之前过去的：bot 没在跑，错过了
                const reason = candidate.at < startedAt ? '错过了，不补' : plan.paused ? '上一条主动消息他还没回' : '今天的条数留给了别的时机';
                record(candidate, { result: 'skipped', reason });
                deps.log(`主动${tag}：${candidateLabel(candidate)}计划在 ${clock(candidate.at)}，${reason}`);
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
