import { join } from 'node:path';
import type { Executor } from '../executor/executor.ts';
import { humanValuesFromAnchor } from '../human-values.ts';
import { asleepSince } from '../life/bedtime.ts';
import { bodyAt } from '../life/body.ts';
import type { DesktopProactiveHooks } from '../life/desktop-now.ts';
import { freshGuess, type guessesReader } from '../life/her-guesses.ts';
import { saveHerPlan, windowAt } from '../life/her-plans.ts';
import { needsAt, type loadNeedsAnchor } from '../life/needs.ts';
import type { promiseKeeper } from '../life/promises.ts';
import { regulationAt } from '../life/regulation.ts';
import type { Schedule } from '../life/schedule.ts';
import { feedFactEntry, feedPath, loadFeed } from '../bilibili/feed-browsing.ts';
import { forExtraction } from '../language/llm.ts';
import { togetherNow } from '../language/together.ts';
import { watchedFacts, type Watched } from '../language/watching.ts';
import type { Dormancy } from '../memory/dormancy.ts';
import type { currentTierHistory } from '../memory/tier-record.ts';
import type { CrisisState } from '../emotion/crisis-state.ts';
import type { AppConfig, Contact } from '../platform/config.ts';
import { replySkip, type ContactPipelineOptions, type TierCard } from '../platform/contact.ts';
import type { Log } from '../platform/log.ts';
import type { WebLookup } from '../platform/web.ts';
import type { Responder } from '../social/responder.ts';
import type { readAgencyShadow } from '../world/agency-shadow.ts';
import type { settlingWorld } from '../world/action-queue.ts';
import type { weatherFetcher } from '../world/weather.ts';
import type { worldState } from '../world/world.ts';
import { readAdultSite } from './adult-sites.ts';
import { proactiveAgency } from './agency.ts';
import { newsKindsOf, withAsk, withBack, withCurious, withInner, withInvite, withReach, withRoom, withSmallNews } from './proactive.ts';
import { createProactivePlanner, newsFrom, reschedulesFrom, type Planner } from './proactive-planner.ts';

// 主动消息的计划器（ADR 0011 起）：第一次补回完才建，名单里有作息、卡上开了主动的人各一个；
// 叠哪些设定（主动找他、内心、邀约、提问、猫和吃的照片、回来、房间、好奇、小新闻……）、给它哪些真事（天气、她那边的事、约好的事、B 站看过的）都在这里按配置接。
// 原来在 app.ts 里（startPlanners），ADR 0336 第 6 步原样搬到这里（`plannerHost(deps)`），函数体逐字不动，只有「看过的」改成现取；
// 计划器表由这里持有，App 拿它去戳、同步待跟进、看状态，停法仍由 App 登记（lifetime.own('planners')）。
export interface PlannerHostDeps {
    config: AppConfig;
    log: Log;
    exec: Pick<Executor, 'llm' | 'now'>;
    clockNow: () => Date;
    cardFor: (tier: string) => TierCard;
    /** 名单里有作息、卡上开了主动的人 */
    proactiveContacts: readonly Contact[];
    deviceOwner: Contact | undefined;
    responders: ReadonlyMap<number, Responder>;
    history: ReturnType<typeof currentTierHistory>;
    worldCard: TierCard['character'] | undefined;
    ledgerWorld: ReturnType<typeof worldState> | undefined;
    sharedWorld: ReturnType<typeof settlingWorld> | undefined;
    needsAnchor: ReturnType<typeof loadNeedsAnchor> | undefined;
    agencyShadow: ReturnType<typeof readAgencyShadow> | undefined;
    weather: ReturnType<typeof weatherFetcher> | undefined;
    web: WebLookup | undefined;
    herGuessesNow: ReturnType<typeof guessesReader> | undefined;
    promises: ReturnType<typeof promiseKeeper> | undefined;
    dormancy: Dormancy | undefined;
    crisisState: Pick<CrisisState, 'pausedAt'>;
    bedtimes: (schedule: Schedule, now: number) => readonly number[];
    /** 她在 B 站看过的（App 持有，会更新） */
    watchedEntries: () => readonly Watched[];
    /** 测试 / 模拟器换掉的时钟和等待 */
    pipeline: Partial<Pick<ContactPipelineOptions, 'now' | 'waitUntil'>> | undefined;
    /**
     * 桌面上的时间（ADR 0347 第 3 层，开关 desktopDay，方案 §2.2-2）：App 只在 desktopDay 和 crossRecent 都开着时给（life/desktop-now.ts 的 desktopProactiveHooks）。
     * 只接给 deviceOwner 那一位男朋友档（桌面记录是他的）；不给 = 和原来逐字一样
     */
    desktop?: DesktopProactiveHooks;
}

export interface PlannerHost {
    /** 每个联系人一个；还没建时是空的 */
    planners: Map<number, Planner>;
    /** 建计划器（已经建过、主动关着就不建） */
    start(): void;
}

export function plannerHost(deps: PlannerHostDeps): PlannerHost {
    const { config, log, exec, clockNow, cardFor, proactiveContacts, deviceOwner, responders, history, worldCard, ledgerWorld, sharedWorld, needsAnchor, agencyShadow, weather, web, herGuessesNow, promises, dormancy, crisisState, bedtimes, watchedEntries, pipeline, desktop } = deps;
    const planners = new Map<number, Planner>();
    function startPlanners(): void {
        if (planners.size || config.proactive === 'off') return;
        for (const contact of proactiveContacts) {
            const { character } = cardFor(contact.tier);
            // 主动开着（这里已经过了 proactive === 'off' 那一关）就带上这几个时机（开关合并：原 proactiveReach、proactiveInvite、proactiveAsk、comeBack、proactiveRoom、smallNews）
            const plannerSettings = [withReach, config.innerLife && withInner, withInvite, withAsk, withBack, withRoom, contact.tier === 'boyfriend' && config.curious && withCurious, contact.tier === 'boyfriend' && config.everydayLife && withSmallNews]
                .reduce((settings, overlay) => (overlay ? overlay(settings) : settings), character.proactive!);
            planners.set(contact.qq, createProactivePlanner({
                contact,
                schedule: character.schedule!,
                settings: plannerSettings,
                ...(config.together && contact.tier === 'boyfriend' ? { together: (at: number) => Boolean(togetherNow(history.load(contact.qq), at)) } : {}),
                // 他正在电脑前 / 刚在电脑上聊过（ADR 0347 第 3 层 desktopDay）：只给他（deviceOwner，男朋友档）
                ...(desktop && contact.tier === 'boyfriend' && contact.qq === deviceOwner?.qq ? desktop : {}),
                ...(config.innerLife ? { inner: true } : {}),
                ...(config.innerLife && contact.qq === deviceOwner?.qq && config.adultSiteUrls?.length && needsAnchor ? {
                    adultSiteVisit: {
                        satisfaction: at => humanValuesFromAnchor({
                            at, anchor: needsAnchor, tier: contact.tier,
                            history: history.load(contact.qq).slice(-24), events: ledgerWorld?.events() ?? [],
                        }).satisfaction,
                        visit: async signal => {
                            const urls = config.adultSiteUrls!;
                            const url = new URL(urls[Math.floor(Math.random() * urls.length)]!);
                            return readAdultSite(url, { fetch, signal });
                        },
                    },
                } : {}),
                // 她自己想弄明白一件事（ADR 0180）：内心冒出来的「想查：关键词」真去查一次，查到的进聊天提示词
                ...(config.innerLife && web ? { look: (query: string) => web.look(query) } : {}),
                // 她自己决定今天想干什么（ADR 0182）：写进这一天的打算，状态行和「你今天的打算」都用它
                // 看他的反应（ADR 0212）：只男朋友档；她那边的人名归「朋友和室友」那一类
                ...(contact.tier === 'boyfriend' ? { reactions: { names: (character.herWorld?.people ?? []).map(person => person.name) } } : {}),
                // 她猜的事刚有了结果（ADR 0213）：一个人想事情时想这一件
                ...(herGuessesNow && config.innerLife && contact.tier === 'boyfriend' ? { guessFacts: () => freshGuess(herGuessesNow(), clockNow().getTime()) } : {}),
                ...(config.innerLife ? {
                    planToday: (todo: string, at: Date) => {
                        saveHerPlan(config.dataDir, { date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`, window: windowAt(at), text: todo, at: at.toISOString() });
                    },
                } : {}),
                // 最近在 B 站看过 / 今天刷到过（ADR 0130 / 0168）：内心想事情时多一个真事可讲；看过的优先
                ...(config.innerLife && contact.tier === 'boyfriend' && config.watching ? {
                    watchedFacts: () => {
                        const when = new Date(exec.now());
                        const watched = config.watching ? watchedFacts(watchedEntries(), when) : undefined;
                        if (watched) return watched;
                        return config.bilibili !== 'off' ? feedFactEntry(loadFeed(feedPath(config.dataDir), log), when) : undefined;
                    },
                } : {}),
                dates: character.dates,
                mode: config.proactive,
                history,
                responder: responders.get(contact.qq)!,
                dir: join(config.dataDir, 'proactive'),
                log: message => log(`[${contact.qq}] ${message}`),
                names: { user: contact.name, char: character.name },
                skip: replySkip(character, config.moody),
                ...(agencyShadow && needsAnchor && ledgerWorld && worldCard ? {
                    agency: (candidate, at, context) => {
                        const bodyNow = worldCard.herWorld?.body ? bodyAt(worldCard.herWorld.body, worldCard.schedule!, at) : undefined;
                        const result = proactiveAgency(candidate, regulationAt(needsAt(needsAnchor, ledgerWorld.events(), at), bodyNow), at, context);
                        if (result.drive && result.decision && result.opportunity) agencyShadow.recordExpression(result.drive, result.decision, result.opportunity, result.activity);
                        return result;
                    },
                    recordActivities: (drive, activities) => { agencyShadow.recordActivities(drive, activities); },
                } : {}),
                // 他最近说过想伤害自己的话：普通主动消息暂停 48 小时（ADR 0068）
                crisisPaused: now => crisisState.pausedAt(contact.qq, now),
                // 她跟谁说过「睡了」就不主动找人了（ADR 0042）
                asleep: now => Boolean(dormancy?.isDormant()) || Boolean(asleepSince(character.schedule!, bedtimes(character.schedule!, now), new Date(now))),
                // 下雨了主动找他（ADR 0050）：她那边这一刻的天气，只有开了真实天气才有
                ...(weather && sharedWorld && worldCard ? {
                    weather: (now: number) => {
                        const seen = sharedWorld.at(worldCard.herWorld!, worldCard.schedule!, new Date(now));
                        return seen ? { day: seen.day, ...(seen.weather ? { weather: seen.weather } : {}) } : undefined;
                    },
                } : {}),
                // 她那边的事（ADR 0057）：看到明天这一刻为止的世界，挑了结在她的今天、明天的
                // 事件类按这个联系人的卡开（ADR 0064）；课名、生理期细节跟着世界那张卡，所以开了类的只能是看得到这些的档位（现在只有男朋友档）
                ...(sharedWorld && worldCard ? {
                    news: newsFrom(now => sharedWorld.at(worldCard.herWorld!, worldCard.schedule!, now), worldCard.schedule!, {
                        kinds: newsKindsOf(plannerSettings),
                        ...(worldCard.herWorld!.body ? { bodyAt: (time: Date) => bodyAt(worldCard.herWorld!.body!, worldCard.schedule!, time) } : {}),
                    }),
                } : {}),
                // 约好之后她这边出了事、想改约（ADR 0066）：约来自她答应的事（开了长期记忆才有），障碍来自作息、世界、身体
                ...(sharedWorld && worldCard && promises ? {
                    reschedule: reschedulesFrom({
                        qq: contact.qq,
                        appointments: promises.appointmentsBetween,
                        facts: {
                            schedule: worldCard.schedule!,
                            worldAt: time => sharedWorld.at(worldCard.herWorld!, worldCard.schedule!, time),
                            appointments: promises.appointmentsBetween,
                            ...(worldCard.herWorld!.body ? { bodyAt: (time: Date) => bodyAt(worldCard.herWorld!.body!, worldCard.schedule!, time) } : {}),
                        },
                    }),
                } : {}),
                // 待跟进的事：用同一个模型配置抽（测试替换的 generate 也用在这里）
                extract: messages => (exec.llm({ purpose: 'background', config: forExtraction(config.llm), messages }, log)),
                ...(pipeline?.now ? { now: pipeline.now } : {}),
                ...(pipeline?.waitUntil ? { waitUntil: pipeline.waitUntil } : {}),
            }));
        }
        // 之后每 MEMORY_SYNC_MS 同步一次待跟进：由 follow-ups 模块声明（ADR 0336 第 6 步，连上之后开；有计划器才开）
    }

    return { planners, start: startPlanners };
}
