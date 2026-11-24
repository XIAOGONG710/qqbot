import { join } from 'node:path';
import type { Executor } from '../executor/executor.ts';
import { forExtraction } from '../language/llm.ts';
import { fetchLists, gatherEvidence, loadMemes, refreshDue, refreshMemes } from '../language/memes.ts';
import { loadWatched, watchOne, type Watched } from '../language/watching.ts';
import { asleepSince } from '../life/bedtime.ts';
import { readingActivities } from '../life/her-days.ts';
import { herPlanActivities } from '../life/her-plans.ts';
import { stateAt, type Schedule } from '../life/schedule.ts';
import type { AppConfig } from '../platform/config.ts';
import type { TierCard } from '../platform/contact.ts';
import type { Log } from '../platform/log.ts';
import type { PassiveReads } from '../platform/passive-reads.ts';
import type { ImageDescriber } from '../vision/media.ts';
import { fetchHotComments, type BiliFetch } from './bilibili.ts';
import type { BiliAccount } from './bilibili-account.ts';
import { fetchDanmaku, fetchStoryboard, fetchView } from './bilibili-view.ts';
import { feedOnce } from './feed-browsing.ts';

// 她在 B 站的三件只读的事（补回之后由模块按时叫）：自己看一个视频（ADR 0130）、刷一小会儿推荐（ADR 0168）、学网络热梗（ADR 0129）。
// 都走 App 的被动读取（停的时候一起取消、等收完）。原来在 app.ts 里（watchJob / feedJob / refreshMemeJob），ADR 0336 第 6 步原样搬到这里，
// 函数体逐字不动；「停没停」改成现取，看完视频更新的「看过的」交回 App（`setWatched`，计划器和提示词都读它）。
export interface PassiveJobsDeps {
    config: AppConfig;
    stopped: () => boolean;
    log: Log;
    exec: Pick<Executor, 'now' | 'llm' | 'files'>;
    passive: PassiveReads;
    /** 她的 B 站号；没开时没有 */
    bilibiliAccountSource: () => (() => Promise<BiliAccount | undefined>) | undefined;
    /** 测试注入的假 fetch；没有就用真的 */
    bilibiliFetch: BiliFetch | undefined;
    vision: ImageDescriber | undefined;
    worldCard: TierCard['character'] | undefined;
    bedtimes: (schedule: Schedule, now: number) => readonly number[];
    watchedFile: string;
    setWatched: (entries: readonly Watched[]) => void;
    memesFile: string;
}

export interface PassiveJobs {
    watchJob(): Promise<void>;
    feedJob(): Promise<void>;
    refreshMemeJob(): Promise<void>;
}

export function passiveJobs(deps: PassiveJobsDeps): PassiveJobs {
    const { config, stopped, log, exec, passive, bilibiliAccountSource, bilibiliFetch, vision, worldCard, bedtimes, watchedFile, setWatched, memesFile } = deps;
    const { lifetime: passiveLifetime, read: passiveRead, fetch: passiveFetch, sleep: passiveSleep, own: ownPassiveRead } = passive;
    let watchingRunning = false;
    let memesRunning = false;
    // 她自己看一个视频（ADR 0130）：每天一次，14 点以后；30 分钟看一眼该不该看；要她的 B 站号
    const watchJob = (): Promise<void> => {
        if (!config.watching || stopped() || watchingRunning) return Promise.resolve();
        const source = bilibiliAccountSource();
        if (!source) return Promise.resolve();
        const nowDate = new Date(exec.now());
        if (nowDate.getHours() < 14) return Promise.resolve();
        watchingRunning = true;
        return ownPassiveRead(async () => {
        try {
            const account = await passiveRead(source);
            if (!account) return;
            const signal = passiveLifetime.signal, scoped: Log = message => { if (!stopped() && !signal.aborted) log(message); };
            const biliFetch = passiveFetch(bilibiliFetch ?? ((url, init) => fetch(url, init)));
            // view / 弹幕 的 fetch 形状不强制 signal，补一个
            const viewFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) =>
                biliFetch(url, { headers: init.headers, signal: init.signal ?? new AbortController().signal });
            await watchOne({
                path: watchedFile, now: () => nowDate, log: scoped, signal,
                search: keyword => account.search(keyword, undefined, signal), subtitle: video => account.subtitle(video, signal), hotComments: aid => fetchHotComments(biliFetch, aid, 3),
                // 章节 + 弹幕高能（ADR 0168）：只读公开接口，读不到不影响「看过」
                view: async video => { try { return await fetchView(viewFetch, video.bvid); } catch { return undefined; } },
                danmaku: async cid => fetchDanmaku(viewFetch, cid),
                storyboard: async (bvid, cid) => (await fetchStoryboard(viewFetch, bvid, cid))?.urls ?? [],
                ...(vision ? { describeImage: async (url: string) => { try { return await vision.describe({ url, signal }); } catch { return undefined; } } } : {}),
                sleep: passiveSleep,
            });
            if (!stopped() && !signal.aborted) setWatched(loadWatched(watchedFile, scoped).entries);
        } catch (error) {
            if (!stopped()) log(`她看视频：这一轮出错（${error instanceof Error ? error.message : String(error)}）`);
        }
        }, () => { watchingRunning = false; });
    };
    // 她每天刷一小会儿 B 站推荐（ADR 0168）：14 点后一天一次；30 分钟看一眼该不该刷；只读、只记账
    let feedRunning = false;
    const feedJob = (): Promise<void> => {
        const mode = config.watching ? config.bilibili ?? 'off' : 'off';
        if (!mode || mode === 'off' || stopped() || feedRunning) return Promise.resolve();
        const rawFetch = passiveFetch(bilibiliFetch ?? ((url, init) => fetch(url, init)));
        // feed 模块的 fetch 形状不强制 signal（只读、单次请求），这里补一个
        const biliFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) =>
            rawFetch(url, { headers: init.headers, signal: init.signal ?? new AbortController().signal });
        const nowDate = new Date(exec.now());
        const schedule = worldCard?.schedule;
        const extraFree = config.herDays && worldCard ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, new Date(), log)] : [];
        feedRunning = true;
        return ownPassiveRead(async () => {
        try {
            await feedOnce({
                mode, path: join(config.dataDir, 'watching', 'feed.json'),
                now: () => nowDate, fetch: biliFetch, signal: passiveLifetime.signal, log: message => { if (!stopped()) log(message); },
                draft: (title, body) => {
                    if (stopped() || passiveLifetime.signal.aborted) return;
                    exec.files.mkdir(join(config.dataDir, 'presence'));
                    exec.files.append(join(config.dataDir, 'presence', 'drafts.md'), `## ${title}

${body}

`);
                },
                ...(schedule ? {
                    awake: (date: Date) => {
                        const kind = stateAt(schedule, date, extraFree).activity.kind;
                        return (kind === 'free' || kind === 'between') && !asleepSince(schedule, bedtimes(schedule, date.getTime()), date);
                    },
                } : {}),
            });
        } catch (error) {
            if (!stopped()) log(`刷 B 站：这一轮出错（${error instanceof Error ? error.message : String(error)}）`);
        }
        }, () => { feedRunning = false; });
    };

    // 网络热梗（ADR 0129）：每 12 小时一次（30 分钟看一眼该不该刷）；要她的 B 站号，没有就不学，只用库里已有的
    const refreshMemeJob = (): Promise<void> => {
        if (!config.memes || stopped() || memesRunning) return Promise.resolve();
        const source = bilibiliAccountSource();
        if (!source) return Promise.resolve();
        const nowDate = new Date(exec.now());
        try {
            if (stopped() || !refreshDue(loadMemes(memesFile, log), nowDate)) return Promise.resolve();
        } catch (error) {
            if (!stopped()) log(`网络热梗：本轮保留原库并跳过刷新（${error instanceof Error ? error.message : String(error)}）`);
            return Promise.resolve();
        }
        memesRunning = true;
        return ownPassiveRead(async () => {
        const signal = passiveLifetime.signal, scoped: Log = message => { if (!stopped() && !signal.aborted) log(message); };
        try {
            const account = await passiveRead(source);
            if (!account) { scoped('网络热梗：她的 B 站号这会儿打不开，下次再学'); return; }
            const biliFetch = passiveFetch(bilibiliFetch ?? ((url, init) => fetch(url, init)));
            await refreshMemes({
                path: memesFile, now: () => nowDate, log: scoped, signal,
                fetchLists: () => fetchLists((url, init) => fetch(url, init) as never, scoped, signal),
                ask: prompt => (exec.llm({ purpose: 'background', config: forExtraction(config.llm), messages: [{ role: 'user', content: prompt }] }, scoped)),
                gather: term => gatherEvidence(term, {
                    signal, search: keyword => account.search(keyword, undefined, signal), subtitle: video => account.subtitle(video, signal), hotComments: aid => fetchHotComments(biliFetch, aid, 3),
                    sleep: passiveSleep,
                }),
            });
        } catch (error) {
            scoped(`网络热梗：这一轮出错（${error instanceof Error ? error.message : String(error)}）`);
        }
        }, () => { memesRunning = false; });
    };
    return { watchJob, feedJob, refreshMemeJob };
}
