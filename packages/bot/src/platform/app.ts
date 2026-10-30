// 一个 bot 的编排：名单里每人一个回复器（contact.ts），名单外的好友按 unlisted 档（可关），连上 NapCat 时补回漏掉的消息再 catchUp，
// 定时写长期记忆，记下换档，同一个数据目录只跑一个。群聊、群临时会话由入口过滤掉，不进这里。
// 主动消息（ADR 0011）：配置 proactive 不是 off、作息开着、卡上写了 proactive 的名单联系人，各一个计划器（proactive-planner.ts）；
// 第一次补回完才开始排（之前的聊天记录不全），聊天记录变了就让它重新算。
// 她自己的日子（ADR 0015）：启动时、她的每一天第一次生成时写一行当天的心情和进度；状态页的「今天」也在这里算。
// 收发由入口传进来（ADR 0008）：独立入口 main.ts 是自写的 OneBot 客户端（onebot.ts），Koishi 插件是 adapter-onebot；
// 两边给的都是 NapCat 的原始 OneBot 数据，所以转文字（segmentsToText）、补回（findMissed）只有一份。
// 他发的语音、图片（ADR 0052）：入口给了 NapCat 的语音转文字、OCR（AppOptions.media）就先听一听、看一看再进聊天记录（media.ts），
// 每人的消息按收到的顺序一条条进；读的时候不卡别人，读不出来、超时照旧「[语音]」「[图片]」。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canGiveFeedback, cardKey, CONTACT_TIERS, deliberateLlm, UNLISTED_TIER, type AppConfig, type Contact, type Tier } from './config.ts';
import { loadOthers } from '.././social/others.ts';
import { createAccount, friendRequestVerdict } from '.././social/account.ts';
import { chatCompletion, forExtraction } from '.././language/llm.ts';
import { Acquaintances, acquaintancesAccount } from '.././life/acquaintances.ts';
import { Dormancy, proposeNote, wakeNote } from '.././memory/dormancy.ts';
import { Identity, realGit } from '.././memory/identity.ts';
import { auditedApi, memoryLedger, summarize as summarizeMemoryLedger } from '.././memory/memory-audit.ts';
import { experiencesFromLife, experiencesFromWatched, Tastes } from '.././life/tastes.ts';
import { readLifeEvents } from '.././world/life-events.ts';
import { Timeline, timelineAccount, timelineFromDevice } from '.././memory/timeline.ts';
import { readWebSecrets, WebLookup } from './web.ts';
import { acquireLock, startHeartbeat as startLockHeartbeat } from './lock.ts';
import type { Log } from './log.ts';
import { ChatHistory, type StoredMessage } from '.././memory/history.ts';
import { asleepSince, saidBedtimes } from '.././life/bedtime.ts';
import { BACKFILL_COUNT, CATCH_UP_WINDOW_MS, newerThanStored, shouldCatchUp, toStored, type HistoryMessage } from '.././memory/backfill.ts';
import { segmentsToText, type MessageEvent, type PokeEvent, type QuoteLookup, type RecallEvent, type Segment } from './onebot.ts';
import { MEDIA_TIMEOUTS, mediaReading, type ImageDescriber, type MediaReader } from '.././vision/media.ts';
import type { Responder, ResponderStatus } from '.././social/responder.ts';
import { contextSummarizer } from '.././language/context-window.ts';
import { createContactResponder as createPipeline, loadTierCard, replySkip, type ContactPipelineOptions, type TierCard } from './contact.ts';
import { currentTierHistory, TierRecord } from '.././memory/tier-record.ts';
import { HindsightClient } from '.././memory/hindsight.ts';
import { arrivedWhileAsleep } from '.././social/reply-timing.ts';
import { answerWhy, createSilenceWatcher, noteFromInfo, recordSilence, type SilenceInfo } from '.././social/silence.ts';
import { drainOutbox } from '.././social/outbox.ts';
import { writeOwnerBank } from '.././memory/owner-bank.ts';
import { desktopBlock, desktopRecentPath } from '.././memory/cross-recent.ts';
import { inspectReply, stripInternalMarkers, summarizeIssues, tidyQuestionMarks, type ExitIssue } from '.././language/exit-check.ts';
import { ODD_BODY_WORDS, STILTED_WORDS } from '.././language/expression.ts';
import { startHeartbeat } from './heartbeat.ts';
import { createFeedbackChannel } from '.././emotion/feedback.ts';
import { readWorkMode, setWorkMode, takeWorkMarker, WORK_MARKER } from './work-mode.ts';
import { noteResident, runWorkTask, rememberWorkTask } from './work-bridge.ts';
import { isTypedByHim, NOT_TYPED_NOTICE, WANTED_BUT_NOT_TYPED_NOTICE } from './instruction-source.ts';
import { addSoulRating, appendPrivate, addRefusal, recentRefusals, ratingSummary, soulDir } from './soul-rating.ts';
import { momentsReader } from '.././emotion/moments.ts';
import { loadEverydayFrom } from '.././life/everyday.ts';
import { dishesBetween, loadMenuFrom } from '.././life/menu.ts';
import { BILI_STICKER_PER_DAY, biliStickerDiscover, STICKER_UNCUED_CHANCE } from '.././language/bili-stickers.ts';
import { pursuitsReader } from '.././life/pursuits.ts';
import { describeForOwner, loadSelfState, reflectIfDue, selfAwareReader } from '.././life/self-pursuits.ts';
import { describeNotesForOwner, loadNotesState, reflectIfDue as reflectSpeechNotes, speechNotesReader, speechStats } from '.././language/speech-notes.ts';
import { describeTrend, speechTrend } from '.././language/speech-trend.ts';
import { FEEDBACK_NO_TURN, describeFeedbackForOwner, feedbackReceipt, lastTurn, loadFeedback, parseFeedbackCommand, recentFeedback, recordFeedback } from '.././language/speech-feedback.ts';
import { writeFeelingsExport, type FeelingsReport } from '.././emotion/feeling-export.ts';
import { describeFeelingsForOwner, loadReviewState, reviewIfDue, reviewReader } from '.././emotion/feeling-review.ts';
import { describeInsightsForOwner, insightsReader, loadInsightsState, recordSelfDiary, reflectIfDue as reflectInsights, writeInsightsExport } from '.././life/diary-insights.ts';
import { substituteMacros } from '.././st/macros.ts';
import { removeFaces } from '.././language/qq-faces.ts';
import { LongTermMemory, type MemoryEvent } from '.././memory/long-term.ts';
import { withFestivalActivities, withFestivals } from '.././world/festivals.ts';
import { newsKindsOf, dayMatches, withAsk, withBack, withCatPhoto, withCurious, withFoodShares, withInner, withInvite, withReach, withRoom, withSmallNews, type ProactiveMode } from '.././proactive/proactive.ts';
import { createPresence, FESTIVAL_SIGNATURES, reactionEmoji, type Presence, type PresenceTransport } from '.././social/presence.ts';
import { qzoneComposer } from '.././social/qzone.ts';
import { createVideoBrowsing, dmMessageId, fetchHotComments, type BiliFetch, type CommentOptions, type DmOptions, type VideoBrowsing } from '.././bilibili/bilibili.ts';
import { realRequest, type BiliAccount, type BiliRequest } from '.././bilibili/bilibili-account.ts';
import { createAccountSource } from '.././bilibili/bilibili-account-source.ts';
import { stripDeviceTokens } from './device-actions.ts';
import { CAMERA_VISION_PROMPT, SCREEN_VISION_PROMPT, startDeviceService, type DeviceService } from './device-service.ts';
import { configuredImageDescriber } from '.././vision/vision.ts';
import { BILIBILI_RISK, createBreaker, guardRequest } from '.././bilibili/platform-breaker.ts';
import { commentComposer, replyComposer } from '.././bilibili/bilibili-comment.ts';
import { createReplyWatcher, type ReplyOptions, type ReplyWatcher } from '.././bilibili/bilibili-replies.ts';
import { createRiskMonitor, type RiskMonitor } from '.././bilibili/bilibili-risk.ts';
import { detectCrisis, type CrisisLevel } from '.././emotion/crisis.ts';
import { createCrisisState, CRISIS_PAUSE_MS } from '.././emotion/crisis-state.ts';
import { createPokeLimiter, POKE_BACK_COOLDOWN_MS, POKE_MAX_AGE_MS, POKE_MAX_IN_WINDOW, POKE_OUT_TEXT, pokeBackPlan, pokeMessage, pokeOutMessageId, quietEnoughToPoke } from '.././social/pokes.ts';
import { createProactivePlanner, newsFrom, reschedulesFrom, type Planner, type PlannerStatus } from '.././proactive/proactive-planner.ts';
import { PromiseStateUnavailable } from '.././life/promise-state.ts';
import { promiseKeeper, type Appointment } from '.././life/promises.ts';
import { bookProgressAt, herDayLogger, moodAt, readingActivities } from '.././life/her-days.ts';
import { herPlanActivities, saveHerPlan, windowAt } from '.././life/her-plans.ts';
import { bodyAt } from '.././life/body.ts';
import { worldState, type WorldNow } from '.././world/world.ts';
import { actionQueue, settlingWorld } from '.././world/action-queue.ts';
import { lifeExecutor } from '.././world/life-selector.ts';
import { loadNeedsAnchor } from '.././life/needs.ts';
import { DIARY_BACKFILL_DAYS, DIARY_TEMPERATURE, diaryWriter } from '.././life/diary.ts';
import { armIntimate, INTIMATE_REPLIES, takeIntimateLine } from '.././language/intimacy.ts';
import { describeState, formatDate, herDay, stateAt, type Schedule } from '.././life/schedule.ts';
import { useRealWeather, weatherFetcher } from '.././world/weather.ts';
import { featureStatuses, type FeatureStatus } from './features.ts';
import { idiomStore, IDIOMS_CHECK_MS, refreshIdioms } from '.././language/idioms.ts';
import { jokeStore, JOKES_CHECK_MS, refreshJokes } from '.././language/jokes.ts';
import { fetchLists, gatherEvidence, loadMemes, memesPath, refreshDue, refreshMemes, type MemeEntry } from '.././language/memes.ts';
import { loadWatched, watchedFacts, watchedPath, watchOne, type Watched } from '.././language/watching.ts';
import { feedFactEntry, feedOnce, feedPath, loadFeed } from '.././bilibili/feed-browsing.ts';
import { fetchDanmaku, fetchStoryboard, fetchView } from '.././bilibili/bilibili-view.ts';
import { weeklyReportDue, writeWeeklyReport } from './weekly-report.ts';
import { togetherNow } from '.././language/together.ts';
import { FOOD_DISCOVERY_INTERVAL_MS, photoAllowance, photoShelf, PHOTO_DISCOVERY_INTERVAL_MS, PHOTO_RETRY_MAX, PHOTO_RETRY_MS, type FoodSource, type PhotoSource } from '.././vision/photos.ts';
import { STICKER_DISCOVERY_INTERVAL_MS, STICKER_ONLY_SHARE, type StickerShelf } from '.././social/stickers.ts';
import { SlidingWindowRateLimiter } from '.././social/rate-limit.ts';
import { sensitiveSwitch, useSensitiveSwitch, type SensitiveSwitch } from './sensitive.ts';
import { runtimeInfo, type RuntimeInfo } from './runtime-info.ts';
import { wakeBackfill } from '../memory/wake-backfill.ts';
import { selfThread, selfThreadLine } from '.././language/self-thread.ts';
import { openMemeDict } from '.././language/meme-dict.ts';
import { loadExemplars } from '.././language/exemplars.ts';
import { activityWithChat, NOW_REFRESH_MS, renderNow, writeNow } from '.././life/now-export.ts';
import { askExpired, askLine, takeConsent } from './consent.ts';

/** 自己过日子的执行器多久推一次（ADR 0040） */
const LIFE_TICK_MS = 10 * 60_000;

/** 写一次长期记忆的间隔 */
export const MEMORY_SYNC_MS = 5 * 60_000;
/** 真实天气多久取一次（ADR 0048） */
export const WEATHER_REFRESH_MS = 30 * 60_000;

/** 入口提供的收发 */
export interface Transport extends PresenceTransport {
    /** 发一条私聊文字，返回 QQ 消息 id；文字里白名单的小黄脸「[捂脸]」发成 face 段（qq-faces.ts textToSegments，ADR 0051） */
    sendPrivateText(userId: number, text: string, replyTo?: number): Promise<number>;
    /** 发一条 QQ 分享卡片（B 站小程序），返回消息 id；没有就不发卡片、用文字链接 */
    sendPrivateCard?(userId: number, cardJson: string): Promise<number>;
    /** 标已读（NapCat mark_private_msg_as_read，配置 readReceipts，ADR 0083）；没有就不标 */
    markRead?(userId: number): Promise<void>;
    /** 给某条消息点表情回应（NapCat set_msg_emoji_like，配置 reactions，ADR 0083）；没有就不点 */
    reactMessage?(messageId: number, emojiId: number): Promise<void>;
    /** 让对方那边显示「正在输入…」（配置 typingStatus，ADR 0077）；没有就不显示 */
    setInputStatus?(userId: number, eventType?: number): Promise<void>;
    /** 撤回自己发出去的一条（NapCat 的 delete_msg，配置 selfRecall，ADR 0086）；没有就不撤回 */
    deleteMessage?(messageId: number): Promise<void>;
    /** 戳他一下（NapCat 的 friend_poke，配置 pokeBack）；没有就不戳 */
    pokeFriend?(userId: number): Promise<void>;
    /** 发本地图片表情；配置 stickers 开时两个入口都提供。 */
    sendPrivateImage?(userId: number, file: string, summary: string): Promise<number>;
    /** NapCat 的 get_friend_msg_history：某人最近 count 条私聊（含小号自己发的），从旧到新。没有任何记录时 NapCat 也报错 */
    friendHistory(userId: number, count: number): Promise<HistoryMessage[]>;
    /** 通用 OneBot 调用（账号控制面用，ADR 0142）：传什么动作就发什么，闸由 account.ts 管；没有就不开控制面 */
    callAction?(action: string, params: Record<string, unknown>): Promise<unknown>;
}

export interface App {
    /** 连上（或重连上）NapCat：补回漏掉的消息，补完之前到的消息攒着、补完按顺序处理，然后有没回的就回、写一次长期记忆 */
    connected(selfId: number): Promise<void>;
    /** 一条直接私聊（入口已经过滤掉群聊、群临时会话和小号自己发的） */
    receive(event: MessageEvent): void;
    /** 名单里的人私聊戳了她一下（ADR 0079，配置 pokes）：算数的话变成一条「[戳了戳你]」走原来的回复流程；其余的忽略 */
    receivePoke(event: PokeEvent): void;
    /** 名单里的人撤回了一条消息（ADR 0082，配置 recalls）：还没回的话记成「[撤回了一条消息]」；其余的忽略 */
    receiveRecall(event: RecallEvent): void;
    /** 有人申请加她（ADR 0142，配置 qqFriendGate）：名单内同意；名单外按档留着或驳回。不认识的申请不碰 */
    receiveFriendRequest(input: { userId: number; flag: string; comment?: string }): void;
    /** 停下：回复器都停掉，不再写记忆，释放锁（Koishi 插件停用或重启时） */
    stop(): void;
    /** 此刻的状态（控制台「林梦瑶」页面，ADR 0010）；不含聊天内容 */
    status(): AppStatus;
}

export interface ContactStatus {
    qq: number;
    name: string;
    tier: Tier;
    /** 配置里写的：这个人是否知道她是程序（ADR 0067）；没写就没有这个字段，按不知道处理 */
    knowsBot?: boolean;
    /** 实际用的卡：档位名，或承认版「<档位>-open」（ADR 0067） */
    card: string;
    /** 名单外的好友（按 unlisted 档临时建的回复器） */
    unlisted: boolean;
    /** 从什么时候起是这一档（tiers.json）；没换过档就没有 */
    tierSince?: string;
    /** 最近一次危机信号的时间和分级（不记内容），以及普通主动消息是否仍暂停；没触发过就没有。 */
    crisis?: { at: string; level: CrisisLevel; paused: boolean };
    responder: ResponderStatus;
    /** 最后一条消息的时间和谁发的，不含内容 */
    last?: { time: string; from: 'user' | 'assistant' };
    /** 作息开着时，这一档看到的「她现在在干什么」 */
    now?: string;
    /** 主动消息的计划（开着、这一档会主动时） */
    proactive?: PlannerStatus;
}

export interface AppStatus {
    /** 正在运行的提交、分支和启动时间；由启动脚本注入，不再靠 ADR 猜线上版本。 */
    runtime: RuntimeInfo;
    contacts: ContactStatus[];
    unlistedFriends: boolean;
    schedule: boolean;
    /** 看心情不回（ADR 0013）开没开；作息关着时不起作用 */
    moody: boolean;
    /** 出口检查里查不查说话的毛病（ADR 0014） */
    speechCheck: boolean;
    /** 她自己的日子（ADR 0015）开没开 */
    herDays: boolean;
    /** 开着、用到的档位卡上有心情或书时：她今天的心情和在读的书 */
    today?: HerDayStatus;
    proactive: ProactiveMode;
    /** 每个功能开关此刻开没开（ADR 0120）：状态页按模块分组画 */
    features: FeatureStatus[];
    /** 照片货架 / 小梗 / 最近一份周报（ADR 0120）；对应的功能没开就没有 */
    extras?: { photos?: { count: number; cat: number; view: number; work: number; food: number }; jokes?: number; report?: { name: string; text: string } };
    /** 长期记忆开着时：服务探测结果（每分钟最多探一次）、最近一次写入和召回 */
    memory?: { baseUrl: string; health?: MemoryEvent; lastWrite?: MemoryEvent; lastRecall?: MemoryEvent };
}

/** 状态页的「今天」（ADR 0015） */
export interface HerDayStatus {
    /** 她的哪一天（02:00 之前算前一天） */
    day: string;
    mood?: { name: string; reason: string };
    books: { title: string; amount: number; unit: string; finished: boolean; stopped: boolean; putDown: boolean }[];
}

/** Hindsight 健康检查的间隔 */
const HEALTH_PROBE_MS = 60_000;

export interface AppOptions {
    config: AppConfig;
    transport: Transport;
    log: Log;
    /** 测试用：替换每个回复器的生成、连发合并等待等 */
    pipeline?: Partial<Pick<ContactPipelineOptions, 'generate' | 'settle' | 'now' | 'waitUntil'>>;
    /** NapCat 的语音转文字、OCR（ADR 0052）；不给就不听不看，照旧「[语音]」「[图片]」 */
    media?: MediaReader;
    /** 看图（ADR 0055）：运行入口按配置建；测试也可以直接给假的 */
    vision?: ImageDescriber;
    /** 图片表情收藏（ADR 0063）；运行入口按配置建，测试可给假的。 */
    stickers?: StickerShelf;
    /** 照片货架的网络来源（ADR 0109：她自己从网上找高清图）；运行入口按配置建（看图没配置就没有），测试可给假的 */
    photoSource?: PhotoSource;
    /** 吃的照片的来源（ADR 0128，photo-sources.ts 的 webFoodSource）；不给就没有吃的照片 */
    foodSource?: FoodSource;
    /** 照片找到一半被限流 / 断网打断后多久再试（毫秒，默认 PHOTO_RETRY_MS；测试用） */
    photoRetryMs?: number;
    /** 允许发图片表情的轮次里抽中发的概率（不写按 STICKER_TURN_CHANCE；测试用）*/
    stickerChance?: number;
    /** 抽到发表情的轮次里只发表情不写文字的概率（不写：shapeFeel 开着按 STICKER_ONLY_SHARE，否则 0；测试用，ADR 0099）*/
    stickerOnlyChance?: number;
    /** B 站公开接口的 fetch（配置 bilibili；不给就用全局 fetch，测试注入假的） */
    bilibiliFetch?: BiliFetch;
    /** 她的 B 站号用的请求函数（配置 bilibiliAccount；要读 Set-Cookie、发 POST；不给就用真的，测试注入假的） */
    bilibiliRequest?: BiliRequest;
    /** 测试用：换掉听、看各项的上限 */
    mediaTimeouts?: Partial<typeof MEDIA_TIMEOUTS>;
    /** 测试注入：换掉设备控制服务的启动函数（ADR 0148；真的要监听端口、读密钥） */
    startDevices?: typeof startDeviceService;
    /** 测试注入：换掉给 dsh 派活的函数（ADR 0179；真的会起整机权限的子进程） */
    workRunner?: typeof runWorkTask;
    /** 敏感调试开关（ADR 0070 第 8 项）；不传按环境变量 QQBOT_SENSITIVE_LOGS（默认关） */
    sensitive?: SensitiveSwitch;
}

/** 名单外的人在提示词里的称呼（{{user}}）：QQ 昵称，没有就叫「对方」 */
export function unlistedName(nickname: string | undefined): string {
    return nickname?.trim() || '对方';
}

export function startApp({ config, transport, log, pipeline, media, vision, stickers, photoSource, foodSource, photoRetryMs, stickerChance, stickerOnlyChance, mediaTimeouts, bilibiliFetch, bilibiliRequest, startDevices, workRunner, sensitive = sensitiveSwitch() }: AppOptions): App {
    const runtime = runtimeInfo();
    useSensitiveSwitch(sensitive);
    log(sensitive.describe());
    // 关着的时候不留上次开着时的完整提示词
    if (!sensitive.on()) rmSync(join(config.dataDir, 'last-prompt.json'), { force: true });
    // 以后要加的人：<dataDir>/others.json，不改代码就能加；重复 QQ 自动跳过
    const extraContacts = loadOthers(config.dataDir, config.contacts, log);
    if (extraContacts.length) {
        config.contacts = [...config.contacts, ...extraContacts];
        log(`动态联系人：${extraContacts.map(contact => `${contact.name}(${contact.qq})`).join('、')}`);
    }
    // 每个档位一张角色卡和一本世界书，用到时读一次；不知道她是程序的联系人用「<档位>-open」承认版（ADR 0067，cardKey）
    let typingFailed = false;
    const failedOnce = new Set<string>();
    const failOnce = (what: string, userId: number, error: unknown) => {
        if (failedOnce.has(what)) return;
        failedOnce.add(what);
        log(`[${userId}] ${what}失败（之后不再记）：${error instanceof Error ? error.message : String(error)}`);
    };
    // 补充的日常小事（ADR 0106）：第一次开的时候定下“从哪天起”（第二天）并存起来，以后重启读同一个；她已经过完的日子不改写
    mkdirSync(join(config.dataDir, 'world'), { recursive: true });
    const everydayFrom = config.everydayLife ? loadEverydayFrom(join(config.dataDir, 'world', 'everyday-from.json'), new Date(), log) : undefined;
    // 每顿吃什么（ADR 0125）：同样第一次开的时候定下“从哪天起”
    const menuFrom = config.menu ? loadMenuFrom(join(config.dataDir, 'world', 'menu-from.json'), new Date(), log) : undefined;
    const cards = new Map<string, TierCard>();
    const cardFor = (tier: string) => {
        let card = cards.get(tier);
        if (!card) {
            card = loadTierCard(config.characterCard, tier, { ...(everydayFrom ? { everydayLife: true, everydayFrom } : {}), ...(menuFrom ? { menu: true, menuFrom } : {}) });
            // 闺蜜的约（ADR 0061，配置 npcAsks）：开关设在这张卡的世界上，其余代码照旧读世界
            if (config.npcAsks && card.character.herWorld) card.character.herWorld.asks = true;
            // 公共节日（ADR 0076，配置 festivals）：并进这一档的重要的日子，时间块和主动消息照旧读 dates
            card.character.dates = withFestivals(card.character.dates, new Date(), config.festivals);
            withFestivalActivities(card.character.schedule, new Date(), config.festivals);
            cards.set(tier, card);
        }
        return card;
    };
    // 承认版的卡（ADR 0067）：危机回合用（ADR 0068 决策 7）；本来就用承认版的、名单外的没有；文件缺了就不换（那一轮靠意图行里的承认说法）
    const openCards = new Map<string, TierCard | undefined>();
    const openCardFor = (contact: Contact): TierCard | undefined => {
        if (contact.tier === UNLISTED_TIER || cardKey(contact) !== contact.tier) return undefined;
        const key = `${contact.tier}-open`;
        if (!openCards.has(key)) {
            try { openCards.set(key, cardFor(key)); } catch (error) {
                log(`危机回合的承认版卡 ${key} 读不了，这一档的危机回合只靠意图行承认身份：${error instanceof Error ? error.message : String(error)}`);
                openCards.set(key, undefined);
            }
        }
        return openCards.get(key);
    };
    // 先把要用到的都读一遍，缺文件立刻报错
    const tiersInUse = new Set<Tier>(config.contacts.map(c => c.tier));
    if (config.unlistedFriends) tiersInUse.add(UNLISTED_TIER);
    // 知道她是程序的联系人平时用原卡，危机回合要换的承认版 <档位>-open 也先读一遍：缺文件就启动报错，和 knowsBot 不是 true 那一侧一样（原来只在危机那一刻 log 一行，
    // 然后原卡的“不承认、绕开”和意图行的“如实承认”同时进提示词；DSH 10-15 复核 0067 问题 1）
    const crisisOpenTiers = config.contacts.filter(c => c.tier !== UNLISTED_TIER && c.knowsBot === true).map(c => `${c.tier}-open`);
    for (const tier of new Set<string>([...tiersInUse, ...config.contacts.map(cardKey), ...crisisOpenTiers])) {
        const { character, worldInfo } = cardFor(tier);
        log(`档位 ${tier}：角色 ${character.name}，世界书 ${character.world || '无'}（${worldInfo.length} 条）`);
    }
    const whitelist = config.contacts.map(c => `${c.qq}（${c.name}，${c.tier}，${c.knowsBot === true ? '知道她是程序' : '按不知道处理：被认真问到会承认'}）`).join('、');
    log(`名单：${whitelist}；名单外的好友${config.unlistedFriends ? '按 unlisted 档回复' : '不回复'}`);
    log(`出口检查：做不到的事、禁用词${config.speechCheck ? '、说话的毛病（助手腔、算账、怪对方没说、重复、一段里叮嘱两遍、话说到一半就停）' : '（说话的毛病不查，配置 speechCheck: false）'}`);
    // 她自己的日子同一天对所有人一样；摘要和状态页用名单里最亲的、卡上有心情或书的那一档（书按档位裁过，这里只用书名和进度）
    const herDaysCard = config.herDays
        ? ([...CONTACT_TIERS, UNLISTED_TIER] as Tier[]).filter(tier => tiersInUse.has(tier)).map(tier => cardFor(tier).character)
            .find(character => character.schedule && (character.moods.length || character.books.length))
        : undefined;
    log(`她自己的日子：${!config.herDays ? '关（配置 herDays: false）'
        : herDaysCard ? `开（每日心情、在读的书${config.schedule ? '、看书的空闲活动' : ''}、进度数字的检查）` : '开，但用到的档位卡上都没有心情和书'}`);
    // 她的世界（ADR 0021）：用名单里最亲的、卡上有作息和世界的那一档（同一天对所有人一样，档位只决定看得到哪些块）
    const worldCard = config.herDays
        ? ([...CONTACT_TIERS, UNLISTED_TIER] as Tier[]).filter(tier => tiersInUse.has(tier)).map(tier => cardFor(tier).character).find(c => c.schedule && c.herWorld)
        : undefined;
    const worldNow = pipeline?.now ?? Date.now;
    const ledgerWorld = worldCard
        ? worldState(worldCard.herWorld!, worldCard.schedule!, log, join(config.dataDir, 'world'), worldNow)
        : undefined;
    // 真实天气（ADR 0048）：世界里的天气按济南 / 青岛实际的；取不到、开始取之前的日子照旧按日期生成
    const weather = config.realWeather && worldCard ? weatherFetcher({ dir: join(config.dataDir, 'weather'), log, now: worldNow }) : undefined;
    useRealWeather(weather);
    if (weather) void weather.refresh();
    const weatherTimer = weather ? setInterval(() => void weather.refresh(), WEATHER_REFRESH_MS) : undefined;
    weatherTimer?.unref();
    if (worldCard) log(`真实天气：${weather ? `开（济南 / 青岛逐小时，每 ${WEATHER_REFRESH_MS / 60_000} 分钟取一次；取不到照旧按日期生成）` : '关（配置 realWeather: false），按日期生成'}`);
    // 没人聊天时她一件件过日子（ADR 0040，影子模式）：读世界之前先排到现在、结算到期的；从这次启动排起，以前排过的从事件账接着排
    const lifeQueue = config.autonomousLife && ledgerWorld ? actionQueue(join(config.dataDir, 'world', 'action-queue.json'), log) : undefined;
    const lifeStartedAt = new Date(worldNow());
    const needsAnchor = lifeQueue ? loadNeedsAnchor(join(config.dataDir, 'world', 'needs-anchor.json'), lifeStartedAt, log) : undefined;
    // 她在聊天里跟名单里谁说过「睡了」（ADR 0042）：聊天记录在下面才打开，打开之前当没说过（之后读世界时排着的会按它改）
    let loadChat: ((qq: number) => StoredMessage[]) | undefined;
    // promiseKeeper 要等聊天记录打开后才能建；生活执行器先拿稳定代理，真正第一次推进前再接上。
    let loadAppointments: ((from: Date, to: Date) => readonly Appointment[]) | undefined;
    let appointmentsAvailable = () => true;
    let appointmentPlanningPaused = false;
    const bedtimes = (schedule: Schedule, now: number) => (loadChat ? saidBedtimes(config.contacts.map(c => loadChat!(c.qq)), schedule, now - 86_400_000) : []);
    const lifeRunner = lifeQueue && worldCard && ledgerWorld
        ? lifeExecutor({
            schedule: worldCard.schedule!, books: worldCard.books, ...(worldCard.herWorld!.plans ? { plans: worldCard.herWorld!.plans } : {}),
            worldAt: time => ledgerWorld.at(worldCard.herWorld!, worldCard.schedule!, time), events: () => ledgerWorld.events(),
            ...(config.projectChoice ? { projectChoice: true } : {}),
            ...(worldCard.herWorld!.body ? { bodyAt: (time: Date) => bodyAt(worldCard.herWorld!.body!, worldCard.schedule!, time) } : {}),
            bedtimes: () => bedtimes(worldCard.schedule!, worldNow()),
            appointmentsBetween: (from, to) => loadAppointments?.(from, to) ?? [],
            ...(needsAnchor ? { needsAnchor } : {}),
        }, lifeQueue, { since: lifeStartedAt, log })
        : undefined;
    const sharedWorld = ledgerWorld && lifeQueue
        ? settlingWorld(ledgerWorld, lifeQueue, worldNow, lifeRunner ? now => {
            if (!appointmentsAvailable()) {
                if (!appointmentPlanningPaused) log('生活安排：约定来源不可用，暂停新增安排，不把未知约定当成空日历');
                appointmentPlanningPaused = true;
                return;
            }
            try { lifeRunner.fill(now); appointmentPlanningPaused = false; }
            catch (error) {
                if (!(error instanceof PromiseStateUnavailable)) throw error;
                if (!appointmentPlanningPaused) log('生活安排：读取约定期间状态不可用，暂停新增安排');
                appointmentPlanningPaused = true;
            }
        } : undefined)
        : ledgerWorld;
    if (config.contextTurns) log(`最近几轮 + 要点（ADR 0043）：${config.memory ? `开：原文只放最近 ${config.contextTurns} 轮，更早的在后台整理成要点，没整理好的那一轮照旧最近 80 条；${config.contextContacts.length ? `只对 ${config.contextContacts.join("、")}` : "名单里开了记忆的都开"}` : "配置开了，但长期记忆没开，不开"}`);
    if (config.candidates > 1) log(`挑候选：他难过、说亲密话、收尾时一次生成 ${config.candidates} 个，按规则挑一个（ADR 0041）`);
    if (config.autonomousLife) log(`没人聊天时她一件件过日子：${lifeRunner ? '开（ADR 0040/0045，影子模式：需要值只改行动账，不进提示词）' : '配置开了，但没有带作息和世界的卡，不开'}`);
    if (config.projectChoice) log(`项目选择：${lifeRunner ? '开（ADR 0056：三天内作业可接管空闲安排，状态行与行动账共用）' : '配置开了，但生活执行器没开，不生效'}`);
    // 没人找她的时候也每 ${LIFE_TICK_MS / 60_000} 分钟推一次，过完的时段尽快落账
    const lifeTimer = lifeRunner ? setInterval(() => { sharedWorld?.events(); }, LIFE_TICK_MS) : undefined;
    const noteMoodAndBooks = herDaysCard ? herDayLogger(
        herDaysCard.schedule!, herDaysCard.moods, herDaysCard.books, log, undefined,
        now => ({
            ...(herDaysCard.herWorld?.body ? { body: bodyAt(herDaysCard.herWorld.body, herDaysCard.schedule!, now) } : {}),
            ...(herDaysCard.herWorld && sharedWorld ? { world: sharedWorld.at(herDaysCard.herWorld, herDaysCard.schedule!, now) } : {}),
        }),
    ) : undefined;
    const noteWorld = sharedWorld?.note;
    const noteHerDay = noteMoodAndBooks || noteWorld ? (now: Date) => { noteMoodAndBooks?.(now); noteWorld?.(now); } : undefined;
    log(`作息：${config.schedule ? '按角色卡（她现在在干什么、什么时候看到、打字多久）' : '关（配置 schedule: false），随时几秒内回'}`);
    if (config.schedule) {
        const paces = [...tiersInUse].map(tier => `${tier} ×${cardFor(tier).character.pace}`).join('、');
        log(`回复节奏：${paces}；看心情不回：${config.moody ? '开' : '关'}`);
    }
    // 听语音、看图上的字（ADR 0052）：配置关了、入口没给就不读
    const mediaLimits = { ...MEDIA_TIMEOUTS, ...(config.vision ? { vision: config.vision.timeoutMs } : {}), ...mediaTimeouts };
    const reading = config.media ? mediaReading({ ...(media ? { reader: media } : {}), ...(vision ? { vision } : {}), timeouts: mediaLimits }) : undefined;
    // 看图只给名单里的人（用户 10-10 22:50：开，只对名单里的人）——图会发到看图模型的服务器；名单外的照旧只认图上的字（OCR 在本机）
    const readingUnlisted = config.media && vision ? mediaReading({ ...(media ? { reader: media } : {}), timeouts: mediaLimits }) : reading;
    const readerFor = (qq: number) => (config.contacts.some(c => c.qq === qq) ? reading : readingUnlisted);
    const canRead = [media?.voiceToText && '语音转文字', media?.ocr && '图上的字（OCR）', vision && '看图（只对名单里的人）'].filter(Boolean).join('、');
    log(`听语音、看图：${!config.media ? '关（配置 media: false），照旧「[语音]」「[图片]」'
        : canRead ? `开（${canRead}；语音最多等 ${mediaLimits.voice / 1000} 秒，OCR ${mediaLimits.ocr / 1000} 秒，看图模型 ${mediaLimits.vision / 1000} 秒，读不出来照旧「[语音]」「[图片]」）` : '开，但入口没给 NapCat 的语音转文字和 OCR，照旧「[语音]」「[图片]」'}`);
    const stickerMode = config.stickers ?? 'off';
    const collectingStickers = stickerMode !== 'off' ? stickers : undefined;
    const sendingStickers = stickerMode === 'send' && transport.sendPrivateImage ? collectingStickers : undefined;
    // 小梗（ADR 0114）：派生数据，存 <数据目录>/jokes/<QQ>.json
    const jokes = config.jokes ? jokeStore({ dir: join(config.dataDir, 'jokes'), log }) : undefined;
    // 他的口头习惯（ADR 0138）：派生数据，存 <数据目录>/idioms/<QQ>.json
    const idioms = config.idioms ? idiomStore({ dir: join(config.dataDir, 'idioms'), log }) : undefined;
    // 网络热梗（ADR 0129）：派生数据，存 <数据目录>/memes/memes.json；刷新在下面（要她的 B 站号）
    const memesFile = memesPath(config.dataDir);
    let memeEntries: readonly MemeEntry[] = config.memes ? loadMemes(memesFile, log).entries : [];
    // 梗百科词库（2026-10-29）：6668 条，只读；文件不在就是没有，不影响自己学的那些
    const memeDict = config.memes ? openMemeDict(join(config.dataDir, 'memes', 'dict.json'), log) : undefined;
    // 真人例子（ADR 0190，默认关）：语料由 scripts/build-exemplars.mjs 从已批准的真人语料生成
    const exemplarCorpus = join(config.dataDir, 'exemplars', 'corpus.jsonl');
    const exemplars = config.exemplars ? loadExemplars(exemplarCorpus, log) : [];
    log(`真人例子：${config.exemplars ? `开（${exemplars.length} 条）` : '关'}${config.exemplars && !exemplars.length ? `——语料没读到（${exemplarCorpus}）` : ''}`);
    if (memeDict) log(`梗百科：词库 ${memeDict.count()} 条（他提到的词查这里，不写进她自己学的库）`);
    // 她自己在 B 站看过的（ADR 0130）：派生数据，存 <数据目录>/watching/watched.json；“看”在下面（要她的 B 站号）
    const watchedFile = watchedPath(config.dataDir);
    let watchedEntries: readonly Watched[] = config.watching ? loadWatched(watchedFile, log).entries : [];
    // 照片货架（ADR 0109）：作者放进去的照片；没有照片就什么都不做
    const photos = config.photos && transport.sendPrivateImage ? photoShelf({ dir: join(config.dataDir, 'photos'), log, ...(photoSource ? { source: photoSource } : {}), ...(config.foodPhotos && foodSource ? { foodSource } : {}) }) : undefined;
    if (config.photos) {
        const have = photos?.status();
        log(photos ? `照片货架：开（本地 ${have!.count} 张：土豆 ${have!.byKind.cat}、风景 ${have!.byKind.view}、她的片子 ${have!.byKind.work}；${photoSource ? '她自己去网上找（CC0 / 公有领域，看图把关，每 6 小时一次）' : '网络来源没开（看图没配置），只有手动加的'}；只对男朋友档；没有照片就什么都不做）` : '照片货架：配置开着，但发图片的通道没准备好，不工作');
    }
    log(`图片表情：${stickerMode === 'off' ? '关（配置 stickers: "off"）'
        : !collectingStickers ? `配置为 ${stickerMode}，但看图或收藏库没准备好，不工作`
            : stickerMode === 'collect' ? `只收藏核对（本地 ${collectingStickers.status().count} 个；不进提示词、不发送）`
                : sendingStickers ? `允许发送（本地 ${sendingStickers.status().count} 个；第一阶段只对男朋友档）`
                    : '配置为 send，但图片发送通道没准备好；仍只收藏、不发送'}`);
    // 主动消息：卡上写了 proactive 的名单联系人（名单外的不主动）；要按作息算时机
    const proactiveContacts = config.proactive !== 'off' && config.schedule
        ? config.contacts.filter(c => cardFor(c.tier).character.proactive && cardFor(c.tier).character.schedule)
        : [];
    if (config.proactive === 'off') log('主动消息：关');
    else if (!config.schedule) log('主动消息：作息关着，不主动（时机按作息算）');
    else {
        const who = proactiveContacts.map(c => `${c.qq}（${c.name}，${c.tier}）`).join('、') || '名单里没有会主动找的档位';
        log(`主动消息：${config.proactive === 'dryRun' ? '试运行（只写日志，不发）' : '开'}：${who}`);
    }

    const chatHistory = new ChatHistory(config.dataDir, log);
    // 放在 ChatHistory 之后：它会建好数据目录
    // 心跳：锁文件只记 PID，会被「进程卡死」和「PID 被复用」骗；心跳加一道，3 分钟没写就当它死了
    const lockHeartbeatFile = join(config.dataDir, 'bot.lock.hb');
    const releaseLock = acquireLock(join(config.dataDir, 'bot.lock'), process.pid, undefined, { path: lockHeartbeatFile });
    const stopLockHeartbeat = startLockHeartbeat(lockHeartbeatFile, 30_000, join(config.dataDir, 'bot.lock'));
    // 心跳（任务书 T3b）：每分钟写 heartbeat.json（只有时间和进程号），ops/heartbeat-watch-cli.ts 看它多久没更新
    let connectedAt: Date | undefined;
    let lastMessageAt: Date | undefined;
    const heartbeat = startHeartbeat({ dataDir: config.dataDir, log, state: () => ({ connectedAt, lastMessageAt }) });

    const tierRecord = new TierRecord(join(config.dataDir, 'tiers.json'));
    for (const contact of config.contacts) {
        const warning = tierRecord.update(contact.qq, contact.tier);
        if (warning) log(warning);
    }
    // 换过档的联系人只看换档之后的记录：提示词、长期记忆、补回都一样（ADR 0003 后果一节）
    const history = currentTierHistory(chatHistory, tierRecord);
    // 反馈通道（ADR 0073）：男朋友档回「假」/「像」只记下来，不当聊天；默认关
    const feedback = config.feedbackCommands ? createFeedbackChannel(config.dataDir, log) : undefined;
    if (feedback) log(`反馈通道：开（${config.contacts.filter(canGiveFeedback).map(c => c.name).join('、')}对她的话回「假」/「像」，记在数据目录的 feedback/ 里，不当聊天、不回应）`);
    loadChat = qq => history.load(qq);

    // 她对他的电脑和手机的有限控制（ADR 0148，配置 deviceControl）：只给男朋友档；服务是异步起的（要监听端口），
    // 起来之前她的菜单是空的、回复里的令牌只摘不用
    let deviceService: DeviceService | undefined;
    const deviceOwner = config.contacts.find(c => c.tier === 'boyfriend');

    // ───────── 连续性（ADR 0157–0163）：设定账本 / 记忆账本 / 时间线 / 搜索 / 休眠 / 口味 / 认识的人 ─────────
    // 都是默认关的开关；账本和时间线只写数据目录里的小文件。出错一律只记日志，不影响聊天
    // 这个文件在 packages/bot/src/platform/：往上四层才是仓库根（模块目录重构前在 src/ 下，三层）
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const clockNow = () => new Date(pipeline?.now ? pipeline.now() : Date.now());
    /** 连上之后发给用户的运维提示（设定账本验不过、有没登记原因的改动……）：以「（」开头的纯文字，不进她的聊天记录 */
    const ownerNotices: string[] = [];
    const timeline = config.timeline ? new Timeline(join(config.dataDir, 'timeline.jsonl'), clockNow) : undefined;
    const noteTimeline = (entry: Parameters<Timeline['record']>[0]): void => {
        try { timeline?.record(entry); } catch (error) { log(`时间线：写不进去（${error instanceof Error ? error.message : String(error)}）`); }
    };
    const identity = config.identityLedger ? new Identity({ repoRoot, dataDir: config.dataDir, now: clockNow, log }) : undefined;
    if (identity) {
        try {
            const report = identity.check();
            if (!report.chain.ok) ownerNotices.push(`（设定账本验不过：${report.chain.reason}，从第 ${report.chain.brokenAt} 条起。账本只追加，被动过的话原文件先留着。）`);
            if (report.unexplained.length) ownerNotices.push(`（设定有 ${report.unexplained.length} 处改动没有登记原因——文件变了，但没有对应的提交说明，或工作区里还有没提交的改动。发 /设定 看详情。）`);
            const first = report.changes[0];
            if (first) noteTimeline({ channel: 'identity', kind: 'change', summary: `设定变了 ${first.files.length} 个文件（${first.explained ? '有记录' : '没登记原因'}）`, ok: first.explained });
        } catch (error) {
            log(`设定账本：核对出错（${error instanceof Error ? error.message : String(error)}）`);
        }
    }
    const memoryLedgerNow = config.memoryAudit ? memoryLedger(config.dataDir) : undefined;
    if (memoryLedgerNow) {
        const check = memoryLedgerNow.verify();
        log(`记忆账本：${check.ok ? `验过了（${check.count} 条）` : `验不过：${check.reason}`}`);
        if (!check.ok) ownerNotices.push(`（记忆账本验不过：${check.reason}，从第 ${check.brokenAt} 条起。）`);
    }
    // 小调用（摘录、分类、回头看）：不开思考，温度 0；测试里换成假的
    const { reasoning_effort: _effort, ...llmExtra } = config.llm.extraBody as Record<string, unknown>;
    const quietLlm = { ...forExtraction(config.llm), temperature: 0, extraBody: { ...llmExtra, thinking: { type: 'disabled' } } };
    const askSmall = (messages: { role: 'system' | 'user'; content: string }[]): Promise<string> => (pipeline?.generate
        ? pipeline.generate(messages, log)
        : chatCompletion(quietLlm, messages, { log, purpose: 'background' }));
    const web = config.webLookup !== 'off'
        ? new WebLookup({
            mode: config.webLookup, dataDir: config.dataDir, ask: askSmall, now: clockNow, log,
            ...(readWebSecrets(join(config.dataDir, 'secrets', 'web.json')) ? { secrets: readWebSecrets(join(config.dataDir, 'secrets', 'web.json'))! } : {}),
            onDone: e => noteTimeline({ channel: 'web', kind: e.kind, summary: e.summary, ok: e.ok }),
        })
        : undefined;
    const tastes = config.tastes
        ? new Tastes({
            dataDir: config.dataDir, now: clockNow, log,
            experiences: () => [
                ...experiencesFromLife(readLifeEvents(join(config.dataDir, 'world', 'events.json'), () => undefined)),
                ...experiencesFromWatched(loadWatched(watchedPath(config.dataDir)).entries),
            ],
            ask: (system, user) => (pipeline?.generate
                ? pipeline.generate([{ role: 'system', content: system }, { role: 'user', content: user }], log)
                : chatCompletion({ ...forExtraction(config.llm), temperature: 0 }, [{ role: 'system', content: system }, { role: 'user', content: user }], { log, purpose: 'background' })),
            onChange: (taste, kind) => noteTimeline({ channel: 'tastes', kind, summary: `${kind === 'new' ? '发现自己' : '重新看了看自己'}${taste.stance === 'like' ? '喜欢' : '不太喜欢'}${taste.name}` }),
        })
        : undefined;
    // 回头看一天最多一次（tastes.ts 里有间隔）：每小时来看一眼要不要看，启动两分钟后先看一次
    const tastesTimer = tastes ? setInterval(() => void tastes.reflect().catch(error => log(`口味：出错（${error instanceof Error ? error.message : String(error)}）`)), 3_600_000) : undefined;
    tastesTimer?.unref();
    const tastesFirst = tastes ? setTimeout(() => void tastes.reflect().catch(error => log(`口味：出错（${error instanceof Error ? error.message : String(error)}）`)), 120_000) : undefined;
    tastesFirst?.unref();
    const acquaintances = config.acquaintances ? new Acquaintances({ dataDir: config.dataDir, now: clockNow, log }) : undefined;
    const dormancy = config.dormancy && deviceOwner ? new Dormancy({ dataDir: config.dataDir, repoRoot, now: clockNow, gitHead: () => realGit(repoRoot).head(), log }) : undefined;
    if (config.dormancy && !deviceOwner) log('休眠：开着，但名单里没有男朋友档的联系人，不启动');
    if (dormancy?.isDormant()) log(`休眠：${dormancy.status()}`);
    const decorateAccounts = (source: () => Promise<BiliAccount | undefined>): (() => Promise<BiliAccount | undefined>) => (!timeline && !acquaintances ? source : async () => {
        const account = await source();
        if (!account) return account;
        const recorded = timeline ? timelineAccount(account, timeline) : account;
        return acquaintances ? acquaintancesAccount(recorded, acquaintances) : recorded;
    });
    const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | undefined> => new Promise(resolveTimeout => {
        const timer = setTimeout(() => resolveTimeout(undefined), ms);
        timer.unref?.();
        promise.then(value => { clearTimeout(timer); resolveTimeout(value); }, () => { clearTimeout(timer); resolveTimeout(undefined); });
    });
    /** 给每个联系人流水线的一组“连续性”提示词行（ADR 0157–0163）：只给男朋友档 */
    const continuity: ContactPipelineOptions['continuity'] | undefined = identity || timeline || web || tastes || acquaintances
        ? async ({ contact, said, initiating, now }) => {
            if (contact.tier !== 'boyfriend') return [];
            const lines: string[] = [];
            const note = contact.knowsBot ? identity?.promptLine() : undefined;
            if (note) { lines.push(note); identity!.markTold(); }
            const looked = web && !initiating && said.trim() ? await withTimeout(web.line(said), 25_000) : undefined;
            if (looked) lines.push(looked);
            for (const line of [timeline?.promptLine(now), tastes?.promptLine(), acquaintances?.promptLine(now)]) if (line) lines.push(line);
            return lines;
        }
        : undefined;
    const deviceHooks: NonNullable<ContactPipelineOptions['devices']> | undefined = config.deviceControl !== 'off' && deviceOwner
        ? {
            menu: () => deviceService?.control.menu() ?? '',
            parse: reply => deviceService?.control.parse(reply) ?? { reply: stripDeviceTokens(reply), proposals: [], rejected: [] },
            commit: parsed => deviceService?.control.commit(parsed),
        }
        : undefined;
    if (config.deviceControl !== 'off' && !deviceOwner) log('设备控制：开着，但名单里没有男朋友档的联系人，不启动');
    if (deviceHooks && deviceOwner) {
        const describers = config.vision
            ? { screen: configuredImageDescriber(config, SCREEN_VISION_PROMPT), camera: configuredImageDescriber(config, CAMERA_VISION_PROMPT) }
            : undefined;
        void (startDevices ?? startDeviceService)({
            dataDir: config.dataDir, mode: config.deviceControl as 'dryRun' | 'on', links: config.deviceLinks, apps: config.deviceApps, log,
            ...(timeline ? { onAudit: timelineFromDevice(timeline) } : {}),
            say: text => { transport.sendPrivateText(deviceOwner.qq, text).catch(error => log(`设备控制：提示没发出去（${error instanceof Error ? error.message : String(error)}）`)); },
            ...(describers?.screen && describers.camera ? { describe: { screen: describers.screen, camera: describers.camera } } : {}),
        }).then(service => {
            if (stopped) { void service?.stop(); return; }
            deviceService = service;
        }).catch(error => log(`设备控制：启动出错（${error instanceof Error ? error.message : String(error)}）`));
    }

    // 长期记忆（Hindsight）：补回之后写一次，之后每隔一段时间把结束了的片段写进去
    const hindsight = config.memory ? new HindsightClient(config.memory.baseUrl, config.memory.timeoutMs) : undefined;
    const memory = config.memory
        ? new LongTermMemory({
            api: memoryLedgerNow ? auditedApi(hindsight!, memoryLedgerNow, { now: clockNow, log }) : hindsight!,
            dir: join(config.dataDir, 'memory'),
            bankPrefix: config.memory.bankPrefix,
            recallTimeoutMs: config.memory.recallTimeoutMs,
            log,
            common: true,
        })
        : undefined;
    log(memory
        ? `长期记忆：Hindsight ${config.memory!.baseUrl}（名单里的联系人；公共记忆库 ${memory.commonBankId()}，陌生人档不写不查）`
        : '长期记忆：未启用（配置里没有 memory）');
    // 同一个她（ADR 0176）：把他的 bank 告诉 DSH 桌面上的她，让两边读写同一份记忆
    if (memory && deviceOwner) {
        try {
            const crossFiles = config.crossRecent ? { chatFile: join(config.dataDir, 'chats', `${deviceOwner.qq}.jsonl`), recalledFile: join(config.dataDir, 'chats', `${deviceOwner.qq}.recalled.json`), desktopFile: desktopRecentPath(join(config.dataDir, 'memory')) } : {};
            if (writeOwnerBank(join(config.dataDir, 'memory'), { ownerBank: memory.bankId(deviceOwner), commonBank: memory.commonBankId(), legacyBank: config.memory!.bankPrefix, ...crossFiles })) log(`同一个她：他的记忆 bank 写进 memory/owner-bank.json（DSH 桌面上的她读它）${config.crossRecent ? '；两边互读最近几轮：开' : ''}`);
        } catch (error) { log(`同一个她：owner-bank.json 没写成（${error instanceof Error ? error.message : String(error)}）`); }
    }
    // 她的日记（ADR 0017）：用名单里最亲的、卡上有作息的那一档；herDays 关着时不带心情和书。温度低一点，少编
    // 日记里的世界按同学档（会召回公共库的档位里最外面的一层，ADR 0026）
    const diaryWorldCard = memory ? cardFor('classmate').character : undefined;
    const diaryCard = memory
        ? (CONTACT_TIERS as readonly Tier[]).filter(tier => tiersInUse.has(tier)).map(tier => cardFor(tier).character).find(character => character.schedule)
        : undefined;
    // 她答应过的事（ADR 0018 决策 2）：开了长期记忆时，名单里的人每段聊天结束后抽一次；到了日子在时间块里提醒，那天的打算写进日记
    const promises = memory
        ? promiseKeeper({
            contacts: config.contacts,
            history,
            names: contact => ({ user: contact.name, char: cardFor(contact.tier).character.name }),
            ...(diaryCard?.schedule ? { schedule: diaryCard.schedule } : {}),
            extract: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion(forExtraction(config.llm), messages, { log, purpose: 'background' })),
            dir: join(config.dataDir, 'promises'),
            log,
            ...(pipeline?.now ? { now: pipeline.now } : {}),
            ...(sharedWorld ? { onWorldActions: sharedWorld.record } : {}),
        })
        : undefined;
    loadAppointments = promises?.appointmentsBetween;
    appointmentsAvailable = () => promises?.available() ?? true;
    // 约定来源已经接上以后再第一次推进生活；否则启动瞬间会把赴约时段排成普通休闲。
    noteHerDay?.(new Date(pipeline?.now?.() ?? Date.now()));
    if (promises) log('她答应的事：名单里的人每段聊天结束后抽一次，到了日子在时间块里提醒');
    const diaries = !config.selfDirectedMemory && memory && diaryCard
        ? diaryWriter({
            sources: {
                charName: diaryCard.name,
                schedule: diaryCard.schedule!,
                moods: config.herDays ? diaryCard.moods : [],
                books: config.herDays ? diaryCard.books : [],
                // 她那边、她的身体（ADR 0026）：日记进公共库，用同学档看得到的那部分
                ...(config.herDays && diaryWorldCard?.herWorld ? { world: diaryWorldCard.herWorld, ...(diaryWorldCard.schedule ? { worldSchedule: diaryWorldCard.schedule } : {}) } : {}),
                ...(sharedWorld ? { resolveWorld: sharedWorld.at } : {}),
            },
            contacts: config.contacts,
            history,
            memory,
            ...(promises ? { plans: promises.plansOn } : {}),
            generate: messages => (pipeline?.generate
                ? pipeline.generate(messages, log)
                : chatCompletion({ ...config.llm, temperature: DIARY_TEMPERATURE }, messages, { log, purpose: 'background' })),
            dir: join(config.dataDir, 'memory'),
            log,
        })
        : undefined;
    if (memory) log(config.selfDirectedMemory
        ? '混合记忆：自动记底账，她写 <<记住：…>> / <<日记：…>> 的另记；自动日记关'
        : diaries ? `她的日记：她的每一天结束后写一篇存进公共记忆（没聊天的日子也写，停过的补最近 ${DIARY_BACKFILL_DAYS} 天）` : '她的日记：不写（用到的档位卡上都没有作息）');
    function syncMemory(): void {
        if (!memory) return;
        // 混合模式：底账照记（自动 episode），她自己标记的另记；自动日记仍关
        for (const contact of config.contacts) {
            void memory.sync(contact, { user: contact.name, char: cardFor(contact.tier).character.name }, history.load(contact.qq));
        }
        if (!config.selfDirectedMemory) void diaries?.catchUp(new Date(pipeline?.now?.() ?? Date.now()));
        void promises?.sync();
    }
    const memoryTimer = memory ? setInterval(syncMemory, MEMORY_SYNC_MS) : undefined;
    memoryTimer?.unref();

    // 「她现在在干嘛」只写一份（任务书 §2）：QQ 这边按自己的作息 + 世界 + 心境渲染 NOW.md，
    // DSH 桌面只读它（超过 30 分钟不注入）。以前这份是 her-life.mjs 自己按另一套规则写的，两边会对不上。
    const nowFile = join(soulDir(), 'NOW.md');
    const exportNow = (): void => {
        const schedule = worldCard?.schedule;
        if (!schedule) return;
        try {
            const at = Date.now();
            // 在读的书 + 她自己决定今天想做的（ADR 0182）：状态行里她就是个在做那件事的人
            const extraFree = config.herDays ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, new Date(at), log)] : [];
            const owner = deviceOwner;
            const base = describeState(stateAt(schedule, new Date(at), extraFree), schedule, owner ? { userName: owner.name } : {});
            // 中断层：他刚说过话就写「和你聊天中」，聊完下一次渲染自己回到原来的轨迹
            const lastAt = owner ? Date.parse(history.load(owner.qq).at(-1)?.time ?? '') : NaN;
            const doing = activityWithChat(base, Number.isFinite(lastAt) ? lastAt : undefined, at);
            writeNow(nowFile, renderNow({ doing, at }));
        } catch (error) {
            log(`「她现在在干嘛」没写出去（${error instanceof Error ? error.message : String(error)}）`);
        }
    };
    exportNow();
    const nowTimer = setInterval(exportNow, NOW_REFRESH_MS);
    nowTimer.unref();

    // 她自己想让他知道的事：常驻进程/她写进 OUTBOX.jsonl，这里发出去（ADR 0174：和别的主动消息守同一套规矩）
    const outboxFile = process.env.QQBOT_OUTBOX ?? join(soulDir(), 'OUTBOX.jsonl');
    const OUTBOX_BLOCKING = new Set<ExitIssue['kind']>(['banned', 'promise', 'media', 'script', 'text-intimacy']);
    let outboxBusy = false;
    let outboxBlockedBy: string | undefined;
    const outboxTimer = setInterval(() => {
        const owner = deviceOwner;
        if (!owner || outboxBusy) return;
        const { character } = cardFor(owner.tier);
        outboxBusy = true;
        void drainOutbox({
            file: outboxFile,
            stateFile: join(config.dataDir, 'outbox-state.json'),
            now: () => clockNow().getTime(),
            blocked: now => crisisState.pausedAt(owner.qq, now) ? '他最近说过想伤害自己的话，普通主动消息暂停 48 小时'
                : dormancy?.isDormant() ? '休眠中'
                : character.schedule && asleepSince(character.schedule, bedtimes(character.schedule, now), new Date(now)) ? '她睡了'
                : undefined,
            inspect: text => {
                const issues = inspectReply(text, [...character.banned, ...ODD_BODY_WORDS, ...STILTED_WORDS]).filter(issue => OUTBOX_BLOCKING.has(issue.kind));
                return issues.length ? summarizeIssues(issues) : undefined;
            },
            send: text => transport.sendPrivateText(owner.qq, text),
            record: (text, messageId, at) => history.append(owner.qq, { time: new Date(at).toISOString(), role: 'assistant', content: text, messageId }),
            log,
        }).then(result => {
            if (result.blockedBy !== outboxBlockedBy) {
                outboxBlockedBy = result.blockedBy;
                if (result.blockedBy) log(`主动留话：先留着不发（${result.blockedBy}）`);
            }
        }).catch(error => log(`主动留话出错：${error instanceof Error ? error.message : String(error)}`)).finally(() => { outboxBusy = false; });
    }, 30_000);
    outboxTimer.unref();

    // 追求（ADR 0104）：作者的文件 + 内置；开了 selfPursuits（ADR 0178）再套上她自己的决定、接上她自己加的
    const authorPursuits = pursuitsReader(config.dataDir, log);
    const pursuitsNow = config.selfPursuits ? selfAwareReader(config.dataDir, authorPursuits) : authorPursuits;
    // 她自己总结的说话习惯（ADR 0193）：要在创建回复器之前定义（createContactResponder 里用得到）
    const speechNotesNow = config.speechNotes ? speechNotesReader(config.dataDir) : undefined;
    // 她翻日记时发现的自己（ADR 0194）：同理，要在创建回复器之前定义
    const diaryInsightsNow = config.diaryInsights ? insightsReader(config.dataDir) : undefined;
    // 最近一次给他算的心境（ADR 0197）：写给桌面上的她，/心境 也看它；同样要在创建回复器之前定义
    let lastFeelings: FeelingsReport | undefined;
    // 她夜里回想、指出了依据的感受（ADR 0197）：作为「别处算好的评估」进心境；要 herFeelings 开着
    const feelingReviewNow = config.feelingReview && config.herFeelings ? reviewReader(config.dataDir) : undefined;
    // 每个联系人一个回复器：聊天记录、生成和重新生成都互不影响
    const responders = new Map<number, Responder>(config.contacts.map(contact => [contact.qq, createContactResponder(contact)]));

    /** 他这一条原本说的话：她写 `<<用电脑>>` 时，要拿它去干活（标记发出去之前就得留住） */
    const lastUserText = new Map<number, string>();
    const runWork = workRunner ?? runWorkTask;

    // 没回时告诉他原因（ADR 0173）：他连着发了几条都没回、过了一会儿，用「（」开头的运维提示说一次；他也可以随时发 /为什么 问
    const silenceDeps = (owner: Contact) => ({
        dataDir: config.dataDir, qq: owner.qq, now: () => clockNow().getTime(),
        history: () => history.load(owner.qq),
        status: () => responders.get(owner.qq)?.status() ?? { phase: 'idle', failures: 0 },
        external: () => ({ dormant: Boolean(dormancy?.isDormant()), working: readWorkMode(config.dataDir, owner.qq) === 'work' }),
    });
    // 她每晚想一次要不要放下 / 改主意 / 提新的（ADR 0178）：到点才想，失败 2 小时后再试，每天最多试 3 次
    const selfPursuitTimer = config.selfPursuits && config.pursuits && deviceOwner ? (() => {
        const owner = deviceOwner;
        const { character } = cardFor(owner.tier);
        let busy = false;
        const tick = () => {
            if (busy || stopped) return;
            busy = true;
            void reflectIfDue({
                dataDir: config.dataDir,
                now: () => clockNow().getTime(),
                generate: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion({ ...config.llm, temperature: 0.9 }, messages, { log, purpose: 'background' })),
                base: authorPursuits,
                chat: () => history.load(owner.qq).slice(-16).map(message => ({ role: message.role, content: message.content })),
                persona: () => substituteMacros(character.description, { user: owner.name, char: character.name }).slice(0, 700),
                names: { char: character.name, user: owner.name },
                log,
            }).catch(error => log(`追求：想的时候出错（${error instanceof Error ? error.message : String(error)}）`)).finally(() => { busy = false; });
        };
        const timer = setInterval(tick, 30 * 60_000);
        timer.unref();
        return timer;
    })() : undefined;
    if (config.selfPursuits) log(config.pursuits && deviceOwner ? '她自己定追求：开（每晚 20 点以后想一次；/追求 随时看）' : '她自己定追求：开着，但 pursuits 没开或名单里没有男朋友档，不启动');
    // 她每晚自己总结说话习惯（ADR 0193）：22 点以后想一次，最近说话够多才想；失败 2 小时后再试，每天最多试 3 次
    const speechNotesTimer = config.speechNotes && deviceOwner ? (() => {
        const owner = deviceOwner;
        const { character } = cardFor(owner.tier);
        let busy = false;
        const tick = () => {
            if (busy || stopped) return;
            busy = true;
            void reflectSpeechNotes({
                dataDir: config.dataDir,
                now: () => clockNow().getTime(),
                generate: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion({ ...config.llm, temperature: 0.9 }, messages, { log, purpose: 'background' })),
                history: () => history.load(owner.qq),
                corpus: () => loadExemplars(join(config.dataDir, 'exemplars', 'corpus.jsonl')),
                persona: () => substituteMacros(character.description, { user: owner.name, char: character.name }).slice(0, 700),
                names: { char: character.name, user: owner.name },
                // 他标过的「像真人」/「这句像 AI」（ADR 0195）：只进每晚想的这一次，不进聊天时的提示词
                feedback: () => recentFeedback(loadFeedback(config.dataDir), clockNow().getTime()),
                log,
            }).catch(error => log(`说话习惯：想的时候出错（${error instanceof Error ? error.message : String(error)}）`)).finally(() => { busy = false; });
        };
        const timer = setInterval(tick, 30 * 60_000);
        timer.unref();
        return timer;
    })() : undefined;
    if (config.speechNotes) log(deviceOwner ? '她自己总结说话习惯：开（每晚 22 点以后想一次；/说话习惯 随时看）' : '她自己总结说话习惯：开着，但名单里没有男朋友档，不启动');
    // 她每晚翻自己的日记，写下对自己的认识（ADR 0194）：22 点以后想一次，日记够多、有新的才想；失败 2 小时后再试，每天最多试 3 次
    // 桌面上的她也看得到（同一个她）：写进灵魂目录的 INSIGHTS.json，桌面插件只读；每小时刷新时间戳，6 小时没刷新桌面就不用（关掉开关 / QQ 没在跑）
    const exportInsights = (): void => {
        try { writeInsightsExport(soulDir(), loadInsightsState(config.dataDir).notes, clockNow().getTime()); }
        catch (error) { log(`自我认识：没能写给桌面上的她（${error instanceof Error ? error.message : String(error)}）`); }
    };
    // 她聊完回想一下、记下有依据的感受（ADR 0197）：一段聊天结束半小时后想一次，聊得够多、有新聊天才想；每 10 分钟看一眼，两次尝试至少隔 1 小时，每天最多试 8 次
    const feelingReviewTimer = config.feelingReview && config.herFeelings && deviceOwner ? (() => {
        const owner = deviceOwner;
        const { character } = cardFor(owner.tier);
        let busy = false;
        const tick = () => {
            if (busy || stopped) return;
            busy = true;
            void reviewIfDue({
                dataDir: config.dataDir,
                soulDir: soulDir(),
                now: () => clockNow().getTime(),
                generate: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion({ ...config.llm, temperature: 0.9 }, messages, { log, purpose: 'background' })),
                history: () => history.load(owner.qq),
                persona: () => substituteMacros(character.description, { user: owner.name, char: character.name }).slice(0, 700),
                names: { char: character.name, user: owner.name },
                others: () => config.contacts.filter(contact => contact.qq !== owner.qq).map(contact => contact.name),
                // 心里已经有的（最近 6 小时内给他算过的明显感受）：别重复记
                existing: () => (lastFeelings && clockNow().getTime() - lastFeelings.at <= 6 * 3_600_000
                    ? lastFeelings.felt.filter(item => item.level !== 'faint').map(item => ({ kind: item.kind, cause: item.cause }))
                    : []),
                log,
            }).catch(error => log(`心境回想：想的时候出错（${error instanceof Error ? error.message : String(error)}）`)).finally(() => { busy = false; });
        };
        const timer = setInterval(tick, 10 * 60_000);
        timer.unref();
        return timer;
    })() : undefined;
    if (config.feelingReview) log(config.herFeelings && deviceOwner ? '她聊完回想一下、记下有依据的感受：开（一段聊天结束半小时后想一次；/心境 随时看）' : '她聊完回想一下：feelingReview 开着，但 herFeelings 没开或名单里没有男朋友档，不启动');
    const diaryInsightsTimer = config.diaryInsights && deviceOwner ? (() => {
        const owner = deviceOwner;
        const { character } = cardFor(owner.tier);
        let busy = false;
        const tick = () => {
            if (busy || stopped) return;
            busy = true;
            void reflectInsights({
                dataDir: config.dataDir,
                soulDir: soulDir(),
                now: () => clockNow().getTime(),
                generate: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion({ ...config.llm, temperature: 0.9 }, messages, { log, purpose: 'background' })),
                history: () => history.load(owner.qq),
                persona: () => substituteMacros(character.description, { user: owner.name, char: character.name }).slice(0, 700),
                names: { char: character.name, user: owner.name },
                others: () => config.contacts.filter(contact => contact.qq !== owner.qq).map(contact => contact.name),
                log,
            }).catch(error => log(`自我认识：想的时候出错（${error instanceof Error ? error.message : String(error)}）`)).finally(() => { busy = false; exportInsights(); });
        };
        exportInsights();
        const timer = setInterval(tick, 30 * 60_000);
        timer.unref();
        return timer;
    })() : undefined;
    if (config.diaryInsights) log(deviceOwner ? '她翻自己的日记写对自己的认识：开（每晚 22 点以后想一次；/自我认识 随时看）' : '她翻自己的日记写对自己的认识：开着，但名单里没有男朋友档，不启动');
    const silenceTimer = config.silenceNotice && deviceOwner ? (() => {
        const watcher = createSilenceWatcher({ ...silenceDeps(deviceOwner), tell: text => tellOwner(text), log });
        const timer = setInterval(() => { try { watcher.tick(); } catch (error) { log(`没回的原因没能告诉他（${error instanceof Error ? error.message : String(error)}）`); } }, 60_000);
        timer.unref();
        return timer;
    })() : undefined;
    if (config.silenceNotice) log(deviceOwner ? '没回时告诉他原因：开（连着 2 条以上、第一条过 8 分钟还没回就说一次；/为什么 随时问）' : '没回时告诉他原因：开着，但名单里没有男朋友档，不通知');

    /** 名单外临时建了回复器的好友（状态页要显示称呼和档位） */
    const unlisted = new Map<number, Contact>();
    /** 他提给她、等她点头的请求（看屏幕 / 摄像头……）：她写 <<同意>> 才做，写 <<拒绝：原因>> 就作罢（2026-10-30） */
    const pendingAsk = new Map<number, { label: string; at: number; run: () => Promise<{ kind: string; text?: string }> }>();

    /** 最近几轮 + 要点（ADR 0043）：开了 contextTurns、这个人开了记忆、在灰度名单里（空 = 都开）才给；整理好的要点存在 context/<QQ>.json */
    function contextWindowFor(contact: Contact): Pick<ContactPipelineOptions, 'contextWindow'> {
        if (!config.contextTurns || !memory || (config.contextContacts.length && !config.contextContacts.includes(contact.qq))) return {};
        const dir = join(config.dataDir, 'context');
        mkdirSync(dir, { recursive: true });
        return {
            contextWindow: {
                turns: config.contextTurns,
                step: 4,
                summarize: contextSummarizer({
                    names: { user: contact.name, char: cardFor(contact.tier).character.name },
                    generate: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion(forExtraction(config.llm), messages, { log, purpose: 'background' })),
                    log: message => log(`[${contact.qq}] ${message}`),
                    file: join(dir, `${contact.qq}.json`),
                }),
            },
        };
    }

    /** 她自己决定记不记：剥掉回复末尾的 `<<记住：…>>` / `<<日记：…>>` / `<<私密：…>>`，返回干净文本和要记的条目 */
    function takeSelfNotes(input: string): { text: string; notes: Array<{ kind: '记住' | '日记' | '私密'; text: string }> } {
        const notes: Array<{ kind: '记住' | '日记' | '私密'; text: string }> = [];
        const text = input.replace(/<<(记住|日记|私密)[：:]\s*([\s\S]*?)>>/g, (_, kind: '记住' | '日记' | '私密', body: string) => {
            const value = body.trim();
            if (value) notes.push({ kind, text: value });
            return '';
        }).replace(/\n{3,}/g, '\n\n').trim();
        return { text, notes };
    }

    /** 存进聊天记录的版本：所有内部标记都剥掉，免得下一轮她又在历史里看见自己写标记 */
    function historyText(sent: string): string {
        return stripInternalMarkers(takeSelfNotes(sent).text)
            .replace(/<<查[：:][\s\S]*?>>/g, '')
            .replace(/<<同意工作>>/g, '')
            .replace(/<<拒绝工作[：:][\s\S]*?>>/g, '')
            .replace(/<<拒绝[：:][\s\S]*?>>/g, '')
            .replace(/<<同意>>/g, '')
            .split(WORK_MARKER).join('')
            .replace(/\n{2,}/g, '\n')
            .trim();
    }

    function createContactResponder(contact: Contact): Responder {
        // 回复里的内部标记（<<记住>> / <<日记>> / <<私密>> / <<同意工作>> / <<拒绝工作>> / <<用电脑>> / <<同意>> / <<拒绝>>）：从文字里剥掉、该办的事办了，返回剩下的文字。
        // 发出去的气泡走 send 时先过这里；整条只有标记的气泡不发，也要过这里（responder 的 absorb），不然写在单独一行的标记就丢了。
        const absorbMarkers = (userId: number, input: string): string => {
            let text = input;
            const selfNotes = takeSelfNotes(text);
            text = selfNotes.text;
            for (const note of selfNotes.notes) {
                if (note.kind === '私密') {
                    appendPrivate(note.text);
                    continue;
                }
                // 她翻日记时要读的：他那一档聊天里写的 <<日记>> 在本地也留一份（ADR 0194；Hindsight 里没法按日期整批读）
                if (note.kind === '日记' && config.diaryInsights && contact.tier === 'boyfriend') {
                    try { recordSelfDiary(config.dataDir, note.text, clockNow().getTime()); } catch (error) { log(`[${userId}] 她写的日记没能在本地留一份：${error instanceof Error ? error.message : String(error)}`); }
                }
                if (memory) {
                    void memory.rememberSelfNote(contact, note.text, note.kind)
                        .catch(error => log(`[${userId}] 她自己记的事没写进记忆：${error instanceof Error ? error.message : String(error)}`));
                }
            }
            // 她答应/拒绝切工作：标记不发出去，但状态要改
            if (text.includes('<<同意工作>>')) {
                setWorkMode(config.dataDir, userId, 'work');
                text = text.replace(/<<同意工作>>/g, '').trim();
                log(`[${userId}] 她答应了切工作模式`);
            }
            const rejected = /<<拒绝工作[：:]\s*([\s\S]*?)>>/.exec(text);
            if (rejected) {
                const reason = (rejected[1] ?? '').trim();
                setWorkMode(config.dataDir, userId, 'chat');
                addRefusal(reason);
                text = text.replace(/<<拒绝工作[：:][\s\S]*?>>/g, '').trim();
                log(`[${userId}] 她拒绝了切工作：${reason.slice(0, 40)}`);
            }
            // 她自己判断这条要动电脑（2026-10-29）：当轮交给 dsh 干，干完把结果单独发回去。
            // 不落工作模式，所以他不用发 /dsh，也不用事后 /QQ 切回来
            if (contact.tier === 'boyfriend') {
                const judged = takeWorkMarker(text);
                if (judged.wanted) {
                    text = judged.text;
                    const task = lastUserText.get(userId);
                    if (task) {
                        const recent = history.load(userId).slice(-10)
                            .map(message => `${message.role === 'user' ? '他' : '我'}：${message.content}`)
                            .join('\n');
                        log(`[${userId}] 她判断这条要动电脑：${task.slice(0, 60)}`);
                        void runWork(task, { context: recent })
                            .then(async reply => {
                                const messageId = await transport.sendPrivateText(userId, reply);
                                // 干完的结果也进聊天记录（和 /dsh 工作模式一样，ADR 0176），活记在他自己的 bank 里
                                history.append(userId, { time: clockNow().toISOString(), role: 'assistant', content: reply, messageId });
                                void rememberWorkTask(task, reply, memory?.bankId(contact));
                            })
                            .catch(error => {
                                log(`[${userId}] 她判断要动电脑、没干成：${error instanceof Error ? error.message : String(error)}`);
                                void transport.sendPrivateText(userId, '这个没弄成，等下我再看。').catch(() => {});
                            });
                    } else {
                        log(`[${userId}] 她写了 ${WORK_MARKER}，但他最后那一条不是亲手打的字（ADR 0179），不动电脑`);
                        tellOwner(WANTED_BUT_NOT_TYPED_NOTICE);
                    }
                }
            }
            // 他提给她的请求（看屏幕 / 摄像头）：她写了 <<同意>> 就做，写了 <<拒绝：原因>> 就作罢（2026-10-30）
            if (contact.tier === 'boyfriend') {
                const judged = takeConsent(text);
                if (judged.refusal !== undefined) {
                    text = judged.text;
                    const pending = pendingAsk.get(userId);
                    pendingAsk.delete(userId);
                    log(`[${userId}] 她拒绝了：${judged.refusal || '不想'}${pending ? '（撤掉了他的请求）' : ''}`);
                    void transport.sendPrivateText(userId, `（她说：${judged.refusal || '这个不想'}）`).catch(() => {});
                } else if (judged.consent) {
                    text = judged.text;
                    const pending = pendingAsk.get(userId);
                    if (pending && !askExpired(pending.at, Date.now())) {
                        pendingAsk.delete(userId);
                        log(`[${userId}] 她答应了：${pending.label}`);
                        void pending.run().then(async handled => {
                            if (handled.kind === 'reply' && handled.text) await transport.sendPrivateText(userId, handled.text);
                        }).catch(error => log(`[${userId}] 她答应了但没做成：${error instanceof Error ? error.message : String(error)}`));
                    }
                }
            }
            // 网络热梗：她这条里原样用上了库里的哪个（只记词，不记意思）。用来回答「她会用梗吗」
            if (config.memes && contact.tier === 'boyfriend') {
                const usedMeme = memeEntries.find(entry => entry.term && text.includes(entry.term));
                if (usedMeme) log(`[${userId}] 网络热梗：她用了「${usedMeme.term}」`);
            }
            return text;
        };

        return createPipeline({
            contact,
            card: cardFor(cardKey(contact)),
            // 危机回合被问是不是真人一律承认（ADR 0068 决策 7）：知道她是程序的联系人这一轮换用承认版的卡
            ...(openCardFor(contact) ? { openCard: openCardFor(contact)! } : {}),
            ...(contact.tier === 'boyfriend' ? {
                // 她有「自己的下文」吗（2026-10-30 她自己的诊断）：日记最后一段 + 她自己在做的事，用不用她定
                selfThread: (): string | undefined => {
                    try {
                        const journal = selfThreadLine(selfThread(readFileSync(join(soulDir(), 'JOURNAL.md'), 'utf8')));
                        let doing: string | undefined;
                        try {
                            const life = JSON.parse(readFileSync(join(soulDir(), 'LIFE.json'), 'utf8')) as { events?: { text?: string }[] };
                            const own = (life.events ?? []).map(e => String(e.text ?? '')).filter(t => t && !t.includes('跟我说') && !t.startsWith('新的一天')).slice(-2);
                            if (own.length) doing = `[你这两天自己在做的：${own.map(t => t.replace(/^我在/, '')).join('；').slice(0, 80)}]`;
                        } catch { /* 没有 LIFE.json 就只有日记那一段 */ }
                        return [journal, doing].filter(Boolean).join(String.fromCharCode(10)) || undefined;
                    } catch { return undefined; }
                },
                workMode: () => readWorkMode(config.dataDir, contact.qq) === 'work',
                workJudge: () => readWorkMode(config.dataDir, contact.qq) === 'chat',
                ask: (): string | undefined => {
                    const pending = pendingAsk.get(contact.qq);
                    if (!pending || askExpired(pending.at, Date.now())) return undefined;
                    return askLine(pending.label, Math.floor((Date.now() - pending.at) / 60_000));
                },
                workRequest: () => readWorkMode(config.dataDir, contact.qq) === 'pending',
                refusalLine: () => recentRefusals(),
                ratingLine: () => ratingSummary(),
                // 「你现在的生活」（NOW.md）的「最近」一行带着他说过的话的原句（前 40 字）和关系状态（「还在生他的气……」）：
                // 只给男朋友档，别的联系人的提示词里不能有他的话（ADR 0020 披露分级；10-29 复核）
                // NOW.md 现在由 QQ 自己渲染（上面 exportNow），内容就是时间块里的那一句：
                // 再注入一次就是重复，所以带 generated-at 的版本不再往回读（任务书 §2）。
                lifeLine: () => {
                    try {
                        const text = readFileSync(join(soulDir(), 'NOW.md'), 'utf8').trim();
                        return text.includes('generated-at:') ? undefined : text;
                    } catch { return undefined; }
                },
                // 首轮铺底：他走了 ≥6 小时回来，第一轮带上她自己写的日记；挂着 lifeInPrompt，不新增开关
                ...(config.lifeInPrompt ? {
                    wakeNote: (): string | undefined => {
                        try {
                            // 刚收的这条已经进聊天记录了，算间隔要拿它之前的那条（5 分钟内的都当成本轮）
                            const cutoff = Date.now() - 5 * 60_000;
                            const older = history.load(contact.qq).filter(message => Date.parse(message.time) < cutoff);
                            const journal = readFileSync(join(soulDir(), 'JOURNAL.md'), 'utf8');
                            return wakeBackfill({ lastAt: older.at(-1)?.time, now: Date.now(), journal, log });
                        } catch { return undefined; }
                    },
                } : {}),
            } : {}),
            ...(config.selfDirectedMemory ? { selfMemory: true } : {}),
            // 他的消息没有马上回的每一个原因逐条记账（ADR 0173）：只是旁观，记不进去也不影响回复
            ...(config.silenceNotice ? { onSilence: (info: SilenceInfo) => { try { recordSilence(config.dataDir, contact.qq, noteFromInfo(info, clockNow().getTime())); } catch (error) { log(`没回的原因记不进账（${error instanceof Error ? error.message : String(error)}）`); } } } : {}),
            llm: config.llm,
            prompt: config.prompt,
            schedule: config.schedule,
            moody: config.moody,
            speechCheck: config.speechCheck,
            ...(config.tailCap ? { tailCap: true } : {}),
            herDays: config.herDays,
            candidates: config.candidates,
            ...contextWindowFor(contact),
            ...(sendingStickers && contact.tier === 'boyfriend' ? { stickers: sendingStickers } : {}),
            ...(deviceHooks && contact.tier === 'boyfriend' ? { devices: deviceHooks } : {}),
            // 他刚才在 DSH 桌面上和她的对话（ADR 0177，crossRecent）：只给男朋友档；文件由 DSH 插件写，没有就没有这一段
            ...(config.crossRecent && contact.tier === 'boyfriend' ? { desktopRecent: (now: Date) => desktopBlock(desktopRecentPath(join(config.dataDir, 'memory')), now.getTime()) } : {}),
            ...(photos && contact.tier === 'boyfriend' ? { photos } : {}),
            ...(stickerChance !== undefined ? { stickerChance } : {}),
            ...(config.biliStickers ? { stickerUncued: STICKER_UNCUED_CHANCE } : {}),
            // 抽到发表情的轮次里一半只发表情（ADR 0099）：跟着情绪轮的开关走；测试可以直接给概率
            ...((stickerOnlyChance ?? (config.shape && config.shapeFeel ? STICKER_ONLY_SHARE : 0)) > 0 ? { stickerOnlyChance: stickerOnlyChance ?? STICKER_ONLY_SHARE } : {}),
            ...(noteHerDay ? { onHerDay: noteHerDay } : {}),
            history,
            historyContent: historyText,
            memory,
            ...(memory && config.selfDirectedMemory ? { pullRecall: (query: string) => memory!.recallPull(contact, query, new Date()) } : {}),
            ...(promises ? { promises } : {}),
            ...(sharedWorld ? { worldState: sharedWorld } : {}),
            ...(config.projectChoice && lifeRunner ? { projectChoice: true } : {}),
            ...(config.lifeInPrompt && lifeRunner ? { lifeInPrompt: true } : {}),
            ...(config.grievance ? { grievance: true } : {}),
            ...(config.rhythm ? { rhythm: true } : {}),
            ...(config.shortReplies ? { shortReplies: true } : {}),
            ...(config.shape ? { shape: true } : {}),
            ...(config.shape && config.shapeAgenda ? { shapeAgenda: true } : {}),
            ...(config.shape && config.shapeFiller ? { shapeFiller: true } : {}),
            ...(config.shape && config.shapeFeel ? { shapeFeel: true } : {}),
            // 她最近心里在想什么（ADR 0101）：计划器建好之后才有，所以每次现取
            ...(config.innerLife ? { innerLine: () => planners.get(contact.qq)?.innerLine() } : {}),
            // 她自己决定今天想做什么（ADR 0182）：和「在读的书」一起当额外的空闲活动，每次现取
            ...(config.innerLife ? { herPlan: (at: Date) => herPlanActivities(config.dataDir, at, log) } : {}),
            // 他刚发过「/亲热」（ADR 0170）：接下来十条回复黏一点，每生成一条减一
            ...(contact.tier === 'boyfriend' ? { intimacyLine: () => takeIntimateLine(config.dataDir, contact.qq) } : {}),
            // 心境（ADR 0102）：作者写下的事每次现取
            ...(config.herFeelings ? { herFeelings: true, moments: momentsReader(config.dataDir, log) } : {}),
            // 桌面上的她读同一份心境（ADR 0197）：QQ 是唯一算心境的地方，算完写进灵魂目录
            ...(config.herFeelings && contact.tier === 'boyfriend' ? { onFeelings: (report: FeelingsReport) => { lastFeelings = report; writeFeelingsExport(soulDir(), report); } } : {}),
            ...(feelingReviewNow && contact.tier === 'boyfriend' ? { feelingReview: feelingReviewNow } : {}),
            ...(config.together ? { together: true } : {}),
            ...(config.relationship ? { relationship: true } : {}),
            ...(config.jealousy ? { jealousy: true } : {}),
            ...(config.curious ? { curious: true } : {}),
            ...(config.interruptions ? { interruptions: true } : {}),
            ...(jokes && contact.tier === 'boyfriend' ? { jokes: () => jokes.load(contact.qq).jokes } : {}),
            ...(idioms && contact.tier === 'boyfriend' ? { idioms: () => idioms.load(contact.qq).items } : {}),
            ...(config.memes && contact.tier === 'boyfriend' ? { memes: () => memeEntries } : {}),
            ...(exemplars.length && contact.tier === 'boyfriend' ? { exemplars } : {}),
            ...(speechNotesNow && contact.tier === 'boyfriend' ? { speechNotes: speechNotesNow } : {}),
            ...(diaryInsightsNow && contact.tier === 'boyfriend' ? { diaryInsights: diaryInsightsNow } : {}),
            ...(memeDict && contact.tier === 'boyfriend' ? { memeDict } : {}),
            ...(config.watching && contact.tier === 'boyfriend' ? { watched: () => watchedEntries } : {}),
            ...(config.texture ? { texture: true } : {}),
            ...(config.quoteReply ? { quoteReply: true } : {}),
            ...(config.factCheck !== 'off' ? { factCheck: config.factCheck } : {}),
            ...(config.herNo ? { herNo: true } : {}),
            ...(config.lagTail ? { lagTail: true } : {}),
            ...(config.everydayLife ? { everydayLife: true } : {}),
            ...(config.pursuits ? { pursuits: pursuitsNow } : {}),
            ...(config.shape && config.shapeSplit ? { shapeSplit: true } : {}),
            ...(config.shape && config.shapeAsk ? { shapeAsk: true } : {}),
            ...(config.shape && config.shapeLong ? { shapeLong: true } : {}),
            ...(config.deliberate ? { deliberate: { llm: deliberateLlm(config.llm, config.deliberateModel) } } : {}),
            ...(continuity ? { continuity } : {}),
            contacts: config.contacts,
            // 带小黄脸的发送失败（QQ / NapCat 不收那个 face 段）就去掉表情再发一次纯文字，免得整轮回复失败、重试几次后不回了（ADR 0051）；
            // 超时不重发：可能已经发出去了，再发就重复
            // 她打字的这段时间对方那边显示「正在输入…」（ADR 0077，配置 typingStatus，默认关）；出错只记一次日志，不影响发送
            ...(config.selfRecall && transport.deleteMessage ? { recallOwn: (messageId: number) => transport.deleteMessage!(messageId) } : {}),
            ...(config.typingStatus && transport.setInputStatus ? { typing: (userId: number) => { transport.setInputStatus!(userId).catch(error => { if (!typingFailed) { typingFailed = true; log(`[${userId}] 显示「正在输入」失败（之后不再记）：${error instanceof Error ? error.message : String(error)}`); } }); } } : {}),
            // 她在 QQ 上的样子（签名、最近发的说说）进时间块（ADR 0083）
            selfNote: (now: number) => presence?.selfNote(now),
            // 已读回执 / 表情回应（ADR 0083）：失败只记第一次，不影响回复
            ...(config.readReceipts && transport.markRead ? { markRead: (userId: number) => { transport.markRead!(userId).catch(error => failOnce('已读回执', userId, error)); } } : {}),
            ...(config.reactions && transport.reactMessage ? { react: (userId: number, messageId: number, text: string) => { transport.reactMessage!(messageId, reactionEmoji(text, messageId)).then(() => log(`[${userId}] 看到了没回，点了个表情回应`), error => failOnce('表情回应', userId, error)); } } : {}),
            send: async (userId, text, sendOptions) => {
                text = absorbMarkers(userId, text);
                // 兜底：她偶尔把提示词里的标记原样写出来（10-30 发过「<<当前时间：…>>」），发送前剥掉
                text = tidyQuestionMarks(stripInternalMarkers(text));
                if (!text.trim()) return 0;
                const photo = contact.tier === 'boyfriend' ? photos?.resolve(text) : undefined;
                if (photo) {
                    const id = await transport.sendPrivateImage!(userId, photo.file, '[照片]');
                    photos!.used(photo.id);
                    return id;
                }
                const sticker = contact.tier === 'boyfriend' ? sendingStickers?.resolve(text) : undefined;
                if (sticker) {
                    const id = await transport.sendPrivateImage!(userId, sticker.file, `[${sticker.description}]`);
                    sendingStickers!.used(sticker.id);
                    return id;
                }
                // 引用回复（ADR 0136）：引用发不出去（那条消息太老 / QQ 不认）就去掉引用再发一次；超时不重发，可能已经发出去了
                const replyTo = sendOptions?.replyTo;
                const sendText = async (body: string): Promise<number> => {
                    if (replyTo === undefined) return transport.sendPrivateText(userId, body);
                    try {
                        return await transport.sendPrivateText(userId, body, replyTo);
                    } catch (error) {
                        const reason = error instanceof Error ? error.message : String(error);
                        if (/timeout|timed out|超时/i.test(reason)) throw error;
                        log(`[${userId}] 引用回复没发出去（${reason}），去掉引用再发一次`);
                        return transport.sendPrivateText(userId, body);
                    }
                };
                try {
                    return await sendText(text);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    const plain = removeFaces(text, face => face !== undefined);
                    if (plain === text || !plain || /timeout|timed out|超时/i.test(reason)) throw error;
                    log(`[${userId}] 带小黄脸的消息没发出去（${reason}），去掉表情再发一次`);
                    return sendText(plain);
                }
            },
            // 整条只有内部标记的气泡不发，但里面的标记要处理（responder 的 absorb）
            absorb: (userId, part) => { absorbMarkers(userId, part); },
            log,
            // last-prompt.json 记录的是后处理之后、实际发给模型的消息
            sensitive: sensitive.on,
            onPrompt: prompt => {
                if (!sensitive.on()) return;
                writeFileSync(join(config.dataDir, 'last-prompt.json'), JSON.stringify({ qq: contact.qq, ...prompt }, null, 2));
            },
            ...pipeline,
        });
    }

    // 危机信号（ADR 0068）：只记哪个联系人、什么时候，不记内容
    const crisisState = createCrisisState(config.dataDir, log);

    /** 存在感（ADR 0083）：在线状态 / 资料卡点赞 / 个性签名 / 说说；第一次连上才起，一个开关都没开就不起 */
    let presence: Presence | undefined;
    function startPresence(): void {
        if (presence) return;
        if (!config.onlineStatus && !config.profileLikes && config.signature === 'off' && config.qzone === 'off' && (config.qzoneBrowse ?? 'off') === 'off' && (config.qzonePeek ?? 'off') === 'off' && (config.qzoneStrangers ?? 'off') === 'off' && !config.pokeOut) return;
        if (!worldCard?.schedule) {
            log('存在感：没有作息（herDays 关或卡上没有作息），不启动——在线状态、点赞、签名、说说都按她的作息排');
            return;
        }
        const schedule = worldCard.schedule;
        const extraFree = config.herDays ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, new Date(), log)] : [];
        const dir = join(config.dataDir, 'presence');
        // 说说用最低隐私档的卡来写（陌生人档，没有就同学档）；两张都读不了就不发说说
        let lowest: TierCard | undefined;
        for (const tier of ['stranger', 'classmate']) {
            try { lowest = cardFor(tier); break; } catch { /* 试下一档 */ }
        }
        const publicSchedule = lowest?.character.schedule ?? schedule;
        const qzone = config.qzone !== 'off' && lowest
            ? qzoneComposer({
                character: { name: lowest.character.name, description: lowest.character.description, personality: lowest.character.personality, banned: lowest.character.banned },
                generate: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion({ ...config.llm, temperature: 1.1 }, messages, { log, purpose: 'background' })),
                ...(vision ? { vision } : {}),
                photoDir: join(dir, 'photos'),
                situation: now => [
                    // 这一档自己的作息：空闲时她在干什么按这一档看得到的来（男朋友档知道的事——买相机、他——不能漏进谁都可能看到的说说里）
                    `你现在：${describeState(stateAt(publicSchedule, new Date(now), extraFree), publicSchedule)}`,
                    ...(rainyAt(now) ? ['天气：在下雨'] : []),
                ],
                log,
            })
            : undefined;
        if (config.qzone !== 'off' && !qzone) log('存在感：陌生人档和同学档的卡都读不了，不写说说');
        presence = createPresence({
            ...(dormancy ? { paused: () => dormancy.isDormant() } : {}),
            flags: { onlineStatus: config.onlineStatus, profileLikes: config.profileLikes, signature: config.signature, qzone: qzone ? config.qzone : 'off', qzoneVisibility: config.qzoneVisibility, pokeOut: config.pokeOut, qzoneBrowse: config.qzoneBrowse, qzonePeek: config.qzonePeek, qzoneStrangers: config.qzoneStrangers },
            transport, schedule, extraFree,
            likeTargets: config.contacts.filter(c => c.tier === 'boyfriend').map(c => c.qq),
            // 能看谁的空间：只放用户点名的（qqAllowFriends），名字用于提示词里说是谁的空间
            peekTargets: config.contacts.filter(c => (config.qqAllowFriends ?? []).includes(c.qq)).map(c => ({ qq: c.qq, name: c.name })),
            pokeTargets: config.contacts.filter(c => c.tier === 'boyfriend').map(c => c.qq),
            // 聊天安静了一阵、最后一条是她说的、不是刚道过晚安，且没在危机暂停里，才戳他（ADR 0087）
            canPokeOut: (qq, now) => !crisisState.pausedAt(qq, now) && quietEnoughToPoke(chatHistory.load(qq), now),
            recordPokeOut: (qq, now) => { chatHistory.append(qq, { time: new Date(now).toISOString(), role: 'assistant', content: POKE_OUT_TEXT, messageId: pokeOutMessageId(now) }); },
            dir, now: worldNow, log,
            saidSleep: now => Boolean(asleepSince(schedule, bedtimes(schedule, now), new Date(now))),
            festival: day => worldCard.dates.find(d => FESTIVAL_SIGNATURES[d.name] && dayMatches(d, day) === 'solar')?.name,
            rainy: rainyAt,
            ...(qzone ? { composeQzone: qzone } : {}),
        });
        presence.start();
        log(`存在感：${[config.onlineStatus && '在线状态', config.profileLikes && '资料卡点赞', config.pokeOut && '主动戳他', config.signature !== 'off' && `个性签名（${config.signature === 'dryRun' ? '只写草稿' : '真改'}）`, qzone && `说说（${config.qzone === 'dryRun' ? '只写草稿' : '真发'}，${config.qzoneVisibility === 'public' ? '所有人可见' : '仅好友可见'}）`, (config.qzoneBrowse ?? 'off') !== 'off' && `翻空间（${config.qzoneBrowse === 'dryRun' ? '只写草稿' : '记进提示词'}）`, (config.qzonePeek ?? 'off') !== 'off' && `看好友空间（${config.qzonePeek === 'dryRun' ? '只写草稿' : '记进提示词'}）`, (config.qzoneStrangers ?? 'off') !== 'off' && `刷陌生人（${config.qzoneStrangers === 'dryRun' ? '只写草稿' : '记进提示词 + 留样本'}）`].filter(Boolean).join('、')}`);
    }
    /** 她刷 B 站、挑一个真视频发给他（ADR 0084，配置 bilibili）：只发给男朋友档的第一个人；第一次连上才起 */
    let browsing: VideoBrowsing | undefined;

    /** 公开的地方（说说、B 站评论）用最低隐私档的卡来写：陌生人档，没有就同学档；两张都读不了返回 undefined */
    function lowestTierCard(): TierCard | undefined {
        for (const tier of ['stranger', 'classmate']) {
            try { return cardFor(tier); } catch { /* 试下一档 */ }
        }
        return undefined;
    }

    /** 她的 B 站号（ADR 0089，配置 bilibiliAccount）：按需打开，凭证文件换了（重新扫码）就自动换上；细节在 bilibili-account-source.ts */
    let accountSource: (() => Promise<BiliAccount | undefined>) | undefined;
    function bilibiliAccountSource(): (() => Promise<BiliAccount | undefined>) | undefined {
        if (!config.bilibiliAccount) return undefined;
        // 刷视频和回复评论共用一个来源：凭证只读一次、失败只记一次日志
        // 真实请求外面包一层持久熔断（ADR 0147）：碰到 B 站的风控信号就整体停，要人在本机 `npm run platform -w @qqbot/bot -- resume bilibili --acknowledge-account-risk` 才恢复；测试注入的假请求不包
        accountSource ??= decorateAccounts(createAccountSource({ dataDir: config.dataDir, request: bilibiliRequest ?? guardRequest(realRequest, createBreaker({ dataDir: config.dataDir, platform: 'bilibili', log }), BILIBILI_RISK), now: worldNow, log }));
        return accountSource;
    }

    // 她自己在 B 站找表情包（ADR 0132，配置 biliStickers）：表情包的候选来源换成 B 站（原来的公开目录兜底）；别的来源（他发来的、QQ 收藏、导入箱）照旧
    if (config.biliStickers && stickers?.setTrend) {
        const source = bilibiliAccountSource();
        if (!source) log('B 站表情包：biliStickers 开着，但要 bilibiliAccount 也开着，还用原来的公开目录');
        else stickers.setTrend(previous => biliStickerDiscover({ account: source, fetch: (url, init) => fetch(url, init) as never, now: () => new Date(worldNow()), log }, previous), BILI_STICKER_PER_DAY);
    }

    /** 分享之后在视频下评论并 @ 他（ADR 0089，配置 bilibiliComment）：没配好就记一行日志、不评论 */
    function bilibiliCommentOptions(): CommentOptions | undefined {
        const mode = config.bilibiliComment;
        if (mode === 'off') return undefined;
        if (!config.bilibiliAccount) {
            log('刷 B 站：bilibiliComment 开着，但要 bilibiliAccount 也开着才能评论，不评论');
            return undefined;
        }
        if (!config.bilibiliAtName || config.bilibiliAtUid <= 0) {
            log('刷 B 站：bilibiliComment 开着，但没填 bilibiliAtName / bilibiliAtUid（要 @ 的人），不评论');
            return undefined;
        }
        const lowest = lowestTierCard();
        if (!lowest) {
            log('刷 B 站：陌生人档和同学档的卡都读不了，不评论');
            return undefined;
        }
        return {
            mode,
            at: { name: config.bilibiliAtName, uid: config.bilibiliAtUid },
            ...(config.bilibiliCommentKeywords.length ? { keywords: config.bilibiliCommentKeywords } : {}),
            compose: commentComposer({
                character: { name: lowest.character.name, description: lowest.character.description, personality: lowest.character.personality, banned: lowest.character.banned },
                generate: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion({ ...config.llm, temperature: 1.1 }, messages, { log, purpose: 'background' })),
                log,
            }),
        };
    }

    /** 在 B 站给他发私信、QQ 上只提醒一句（ADR 0089，配置 bilibiliDm）：没配好就记一行日志、不发 */
    function bilibiliDmOptions(): DmOptions | undefined {
        const mode = config.bilibiliDm;
        if (mode === 'off') return undefined;
        if (!config.bilibiliAccount) {
            log('刷 B 站：bilibiliDm 开着，但要 bilibiliAccount 也开着才能发私信，不发私信');
            return undefined;
        }
        if (config.bilibiliAtUid <= 0) {
            log('刷 B 站：bilibiliDm 开着，但没填 bilibiliAtUid（收私信的人的 B 站 uid），不发私信');
            return undefined;
        }
        return { mode, uid: config.bilibiliAtUid };
    }

    function startBrowsing(): void {
        if (browsing || config.bilibili === 'off') return;
        const target = config.contacts.find(c => c.tier === 'boyfriend');
        if (!target || !worldCard?.schedule) {
            log('刷 B 站：没有男朋友档的联系人或没有作息，不启动');
            return;
        }
        const qq = target.qq;
        const account = bilibiliAccountSource();
        const comment = bilibiliCommentOptions();
        const dm = bilibiliDmOptions();
        const gate = comment ? bilibiliRisk() : undefined;
        browsing = createVideoBrowsing({
            mode: config.bilibili,
            ...(account ? { account } : {}),
            ...(account && comment ? { comment } : {}),
            ...(gate ? { risk: gate } : {}),
            ...(account && dm ? {
                dm,
                // 私信不在 QQ 上，要自己记进聊天记录：他问起「哪个视频」时她知道自己发过什么
                recordDm: (text, video, at) => { chatHistory.append(qq, { time: new Date(at).toISOString(), role: 'assistant', content: `[B 站私信] ${text}（《${video.title}》）`, messageId: dmMessageId(at) }); },
            } : {}),
            target: { qq, name: target.name },
            schedule: worldCard.schedule,
            extraFree: config.herDays ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, new Date(), log)] : [],
            dir: join(config.dataDir, 'presence'),
            now: worldNow, log,
            saidSleep: now => Boolean(asleepSince(worldCard.schedule!, bedtimes(worldCard.schedule!, now), new Date(now))),
            fetch: bilibiliFetch ?? ((url, init) => fetch(url, init)),
            initiate: request => responders.get(qq)!.initiate(request),
            // 真链接作为下一条发出去；聊天记录里连标题一起记，她之后知道自己发过什么
            sendLink: async video => {
                // 这台 QQ（NapCat 里的版本）太旧，json 卡片一律提示「版本过低」，所以不发卡片：
                // 先发封面图，再发「标题 + 链接」，QQ 自己会把链接展开成预览。
                if (transport.sendPrivateImage && video.cover) {
                    try { await transport.sendPrivateImage(qq, video.cover, '[视频封面]'); } catch { /* 封面发不了就算了，链接照发 */ }
                }
                const messageId = await transport.sendPrivateText(qq, `${video.title}
${video.link}`);
                chatHistory.append(qq, { time: new Date(worldNow()).toISOString(), role: 'assistant', content: `[分享视频]《${video.title}》${video.link}`, messageId });
            },
        });
        browsing.start();
        log(`刷 B 站：${config.bilibili === 'dryRun' ? '只写草稿（不发）' : '开'}，发给 ${target.name}；一周最多 3 个，${account ? '用她的 B 站号按口味搜、读字幕，搜不到再读 B 站热门榜' : '读 B 站热门榜（公开接口，不登录）'}${account && dm ? `；改在 B 站给他发私信（${dm.mode === 'dryRun' || config.bilibili === 'dryRun' ? '只写草稿' : '真发'}），QQ 上只提醒一句` : ''}${account && comment ? `；${comment.keywords?.length ? `按话题（${comment.keywords.join('、')}）自己找视频` : '分享后在视频下'}评论并 @ ${config.bilibiliAtName}（${comment.mode === 'dryRun' || config.bilibili === 'dryRun' ? '只写草稿' : '真发'}）` : ''}`);
    }

    /**
     * 风险转私信（ADR 0090）：公开评论或回复开着时，每 15 分钟看一次她的系统通知；评论 / 回复被拦、评论发出去看不到、收到违规警告类的通知，
     * 立刻停公开发言并私信告诉他。评论和回复共用一个，没开公开发言或没填他的 uid 就没有
     */
    let risk: RiskMonitor | undefined;
    function bilibiliRisk(): RiskMonitor | undefined {
        if (risk) return risk;
        if (config.bilibiliComment === 'off' && config.bilibiliReplies === 'off') return undefined;
        const account = bilibiliAccountSource();
        if (!account || config.bilibiliAtUid <= 0) return undefined;
        risk = createRiskMonitor({ account, uid: config.bilibiliAtUid, dir: join(config.dataDir, 'presence'), now: worldNow, log });
        risk.start();
        log('B 站风险：公开评论 / 回复开着，每 15 分钟看一次她的系统通知；评论或回复被拦、评论发出去看不到、收到违规或警告通知时，立刻停公开发言并私信告诉他（这条私信不受私信试运行开关管）');
        return risk;
    }

    /** 回复别人回在她评论下面的话（ADR 0090，配置 bilibiliReplies）：没配好就记一行日志、不回；和刷视频各自启动（只要有评论就会有回复，不管分享开没开） */
    let replies: ReplyWatcher | undefined;
    function bilibiliReplyOptions(): ReplyOptions | undefined {
        const mode = config.bilibiliReplies;
        if (mode === 'off') return undefined;
        const account = bilibiliAccountSource();
        if (!account) {
            log('回复 B 站评论：bilibiliReplies 开着，但要 bilibiliAccount 也开着，不回复');
            return undefined;
        }
        if (config.bilibiliAtUid <= 0) {
            log('回复 B 站评论：bilibiliReplies 开着，但没填 bilibiliAtUid（先回谁），不回复');
            return undefined;
        }
        const schedule = worldCard?.schedule;
        const lowest = lowestTierCard();
        if (!lowest) {
            log('回复 B 站评论：陌生人档和同学档的卡都读不了，不回复');
            return undefined;
        }
        const extraFree = config.herDays && worldCard ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, new Date(), log)] : [];
        const gate = bilibiliRisk();
        return {
            mode, account, userUid: config.bilibiliAtUid,
            ...(gate ? { risk: gate } : {}),
            compose: replyComposer({
                character: { name: lowest.character.name, description: lowest.character.description, personality: lowest.character.personality, banned: lowest.character.banned },
                generate: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion({ ...config.llm, temperature: 1.1 }, messages, { log, purpose: 'background' })),
                log,
            }),
            dir: join(config.dataDir, 'presence'),
            now: worldNow, log,
            // 睡着、上课、说过「睡了」时不看不回；没有作息就一直方便
            ...(schedule ? {
                awake: (now: number) => {
                    const kind = stateAt(schedule, new Date(now), extraFree).activity.kind;
                    return (kind === 'free' || kind === 'between') && !asleepSince(schedule, bedtimes(schedule, now), new Date(now));
                },
            } : {}),
        };
    }

    function startReplies(): void {
        if (replies) return;
        const options = bilibiliReplyOptions();
        if (!options) return;
        replies = createReplyWatcher(options);
        replies.start();
        log(`回复 B 站评论：${options.mode === 'dryRun' ? '只写草稿（不发）' : '开'}；每 10 分钟看一次「回复我的」，先回他，其次挑有价值的，一天最多 5 条（他的不算），问 AI / 真人的、骂人的、广告一律不回；有价值的回复另存真人语料（presence/bilibili-corpus.jsonl）`);
    }

    function rainyAt(now: number): boolean {
        if (!sharedWorld || !worldCard?.herWorld || !worldCard.schedule) return false;
        return Boolean(sharedWorld.at(worldCard.herWorld, worldCard.schedule, new Date(now))?.weather?.rain);
    }

    /** 主动消息的计划器：第一次补回完才建 */
    const planners = new Map<number, Planner>();
    function startPlanners(): void {
        if (planners.size || config.proactive === 'off') return;
        for (const contact of proactiveContacts) {
            const { character } = cardFor(contact.tier);
            const plannerSettings = [config.proactiveReach && withReach, config.innerLife && withInner, config.proactiveInvite && withInvite, config.proactiveAsk && withAsk, config.photos && config.photoShares && photos && contact.tier === 'boyfriend' && withCatPhoto, config.comeBack && withBack, config.proactiveRoom && withRoom, contact.tier === 'boyfriend' && config.curious && withCurious, config.menu && config.foodPhotos && photos && contact.tier === 'boyfriend' && withFoodShares, contact.tier === 'boyfriend' && config.everydayLife && config.smallNews && withSmallNews]
                .reduce((settings, overlay) => (overlay ? overlay(settings) : settings), character.proactive!);
            planners.set(contact.qq, createProactivePlanner({
                contact,
                schedule: character.schedule!,
                settings: plannerSettings,
                // 喂完土豆拍的照片（ADR 0110）：货架里有土豆的照片、这会儿也允许发才发
                ...(config.hisHours && contact.tier === 'boyfriend' ? { hisHours: true } : {}),
                ...(config.together && contact.tier === 'boyfriend' ? { together: (at: number) => Boolean(togetherNow(history.load(contact.qq), at)) } : {}),
                ...(photos && (config.photoShares || config.foodPhotos) ? { photoReady: (kind: 'cat' | 'food', at: number, dish?: string) => photos.has(kind, dish) && photoAllowance(history.load(contact.qq), at).allowed } : {}),
                ...(config.innerLife ? { inner: true } : {}),
                // 她自己想弄明白一件事（ADR 0180）：内心冒出来的「想查：关键词」真去查一次，查到的进聊天提示词
                ...(config.innerLife && web ? { look: (query: string) => web.look(query) } : {}),
                // 她自己决定今天想干什么（ADR 0182）：写进这一天的打算，状态行和「你今天的打算」都用它
                ...(config.innerLife ? {
                    planToday: (todo: string, at: Date) => {
                        saveHerPlan(config.dataDir, { date: `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`, window: windowAt(at), text: todo, at: at.toISOString() });
                    },
                } : {}),
                // 最近在 B 站看过 / 今天刷到过（ADR 0130 / 0168）：内心想事情时多一个真事可讲；看过的优先
                ...(config.innerLife && contact.tier === 'boyfriend' && (config.watching || (config.biliFeed ?? 'off') !== 'off') ? {
                    watchedFacts: () => {
                        const when = new Date(pipeline?.now ? pipeline.now() : Date.now());
                        const watched = config.watching ? watchedFacts(watchedEntries, when) : undefined;
                        if (watched) return watched;
                        return (config.biliFeed ?? 'off') !== 'off' ? feedFactEntry(loadFeed(feedPath(config.dataDir), log), when) : undefined;
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
                extract: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion(forExtraction(config.llm), messages, { log, purpose: 'background' })),
                ...(pipeline?.now ? { now: pipeline.now } : {}),
                ...(pipeline?.waitUntil ? { waitUntil: pipeline.waitUntil } : {}),
            }));
        }
        if (planners.size) {
            followUpTimer = setInterval(syncFollowUps, MEMORY_SYNC_MS);
            followUpTimer.unref();
        }
    }
    let followUpTimer: ReturnType<typeof setInterval> | undefined;
    function syncFollowUps(): void {
        for (const planner of planners.values()) void planner.syncFollowUps();
    }

    let stopped = false;
    let stickerDiscoveryTimer: ReturnType<typeof setInterval> | undefined;
    let photoDiscoveryTimer: ReturnType<typeof setInterval> | undefined;
    let foodDiscoveryTimer: ReturnType<typeof setInterval> | undefined;
    let foodRetryTimer: ReturnType<typeof setTimeout> | undefined;
    let foodRetries = 0;
    // 周报（ADR 0118）：每小时看一眼，周日 21:30 以后这周的还没有就写一份；出错只记日志
    let weeklyTimer: ReturnType<typeof setInterval> | undefined;
    const checkWeeklyReport = () => {
        if (!config.weeklyReport || stopped) return;
        const reportsDir = join(config.dataDir, 'reports');
        const nowDate = new Date(pipeline?.now ? pipeline.now() : Date.now());
        if (!weeklyReportDue(nowDate, reportsDir)) return;
        for (const contact of config.contacts.filter(c => c.tier === 'boyfriend')) {
            try {
                const file = writeWeeklyReport({ dataDir: config.dataDir, qq: contact.qq, tier: contact.tier, since: nowDate.getTime() - 7 * 86_400_000, now: nowDate.getTime(), reportsDir });
                log(`周报：写好了（${file}；只有数字）`);
            } catch (error) { log(`周报：写不出来（${error instanceof Error ? error.message : String(error)}）`); }
        }
    };
    // 状态页的补充（ADR 0120）：货架、小梗个数、最近一份周报的文字（只有数字）
    const statusExtras = (): NonNullable<AppStatus['extras']> => {
        const extras: NonNullable<AppStatus['extras']> = {};
        if (photos) { const s = photos.status(); extras.photos = { count: s.count, cat: s.byKind.cat, view: s.byKind.view, work: s.byKind.work, food: s.byKind.food }; }
        if (jokes) extras.jokes = config.contacts.filter(c => c.tier === 'boyfriend').reduce((n, c) => n + jokes.load(c.qq).jokes.length, 0);
        if (config.weeklyReport) {
            try {
                const dir = join(config.dataDir, 'reports');
                const latest = existsSync(dir) ? readdirSync(dir).filter(f => /^weekly-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().at(-1) : undefined;
                if (latest) extras.report = { name: latest, text: readFileSync(join(dir, latest), 'utf8').slice(0, 4000) };
            } catch { /* 读不到就不显示 */ }
        }
        return extras;
    };
    // 小梗（ADR 0114）：隔一阵从最近的聊天里抽；出错只记日志
    let jokesTimer: ReturnType<typeof setInterval> | undefined;
    let idiomsTimer: ReturnType<typeof setInterval> | undefined;
    let memesTimer: ReturnType<typeof setInterval> | undefined;
    let watchingTimer: ReturnType<typeof setInterval> | undefined;
    let watchingRunning = false;
    let memesRunning = false;
    const refreshAllJokes = () => {
        if (!jokes || stopped) return;
        for (const contact of config.contacts.filter(c => c.tier === 'boyfriend')) {
            void refreshJokes({
                qq: contact.qq, userName: contact.name, charName: cardFor(contact.tier).character.name, history: history.load(contact.qq), store: jokes,
                extract: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion(forExtraction(config.llm), messages, { log, purpose: 'background' })),
                now: pipeline?.now ? pipeline.now() : Date.now(), log: message => log(`[${contact.qq}] ${message}`),
            }).catch(error => log(`[${contact.qq}] 小梗：抽取出错（${error instanceof Error ? error.message : String(error)}）`));
        }
    };
    // 他的口头习惯（ADR 0138）：隔一阵从他最近的话里学；出错只记日志。不收进去的词：联系人和角色的名字、卡上的禁用词
    const refreshAllIdioms = () => {
        if (!idioms || stopped) return;
        for (const contact of config.contacts.filter(c => c.tier === 'boyfriend')) {
            const character = cardFor(contact.tier).character;
            void refreshIdioms({
                qq: contact.qq, userName: contact.name, charName: character.name, history: history.load(contact.qq), store: idioms,
                blocked: [contact.name, character.name, ...config.contacts.map(c => c.name), ...character.banned],
                extract: messages => (pipeline?.generate ? pipeline.generate(messages, log) : chatCompletion(forExtraction(config.llm), messages, { log, purpose: 'background' })),
                now: pipeline?.now ? pipeline.now() : Date.now(), log: message => log(`[${contact.qq}] ${message}`),
            }).catch(error => log(`[${contact.qq}] 口头习惯：学习出错（${error instanceof Error ? error.message : String(error)}）`));
        }
    };
    // 她自己看一个视频（ADR 0130）：每天一次，14 点以后；30 分钟看一眼该不该看；要她的 B 站号
    const watchJob = async (): Promise<void> => {
        if (!config.watching || stopped || watchingRunning) return;
        const source = bilibiliAccountSource();
        if (!source) return;
        const nowDate = new Date(pipeline?.now ? pipeline.now() : Date.now());
        if (nowDate.getHours() < 14) return;
        watchingRunning = true;
        try {
            const account = await source();
            if (!account) return;
            const biliFetch: BiliFetch = bilibiliFetch ?? ((url, init) => fetch(url, init));
            // view / 弹幕 的 fetch 形状不强制 signal，补一个
            const viewFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) =>
                biliFetch(url, { headers: init.headers, signal: init.signal ?? new AbortController().signal });
            await watchOne({
                path: watchedFile, now: () => nowDate, log,
                search: keyword => account.search(keyword), subtitle: video => account.subtitle(video), hotComments: aid => fetchHotComments(biliFetch, aid, 3),
                // 章节 + 弹幕高能（ADR 0168）：只读公开接口，读不到不影响「看过」
                view: async video => { try { return await fetchView(viewFetch, video.bvid); } catch { return undefined; } },
                danmaku: async cid => fetchDanmaku(viewFetch, cid),
                storyboard: async (bvid, cid) => (await fetchStoryboard(viewFetch, bvid, cid))?.urls ?? [],
                ...(vision ? { describeImage: async (url: string) => { try { return await vision.describe({ url }); } catch { return undefined; } } } : {}),
                sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
            });
            watchedEntries = loadWatched(watchedFile, log).entries;
        } catch (error) {
            log(`她看视频：这一轮出错（${error instanceof Error ? error.message : String(error)}）`);
        } finally {
            watchingRunning = false;
        }
    };
    // 她每天刷一小会儿 B 站推荐（ADR 0168）：14 点后一天一次；30 分钟看一眼该不该刷；只读、只记账
    let feedTimer: ReturnType<typeof setInterval> | undefined;
    let feedRunning = false;
    const feedJob = async (): Promise<void> => {
        if (!config.biliFeed || config.biliFeed === 'off' || stopped || feedRunning) return;
        const rawFetch: BiliFetch = bilibiliFetch ?? ((url, init) => fetch(url, init));
        // feed 模块的 fetch 形状不强制 signal（只读、单次请求），这里补一个
        const biliFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) =>
            rawFetch(url, { headers: init.headers, signal: init.signal ?? new AbortController().signal });
        const nowDate = new Date(pipeline?.now ? pipeline.now() : Date.now());
        const schedule = worldCard?.schedule;
        const extraFree = config.herDays && worldCard ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, new Date(), log)] : [];
        feedRunning = true;
        try {
            await feedOnce({
                mode: config.biliFeed, path: join(config.dataDir, 'watching', 'feed.json'),
                now: () => nowDate, fetch: biliFetch, log,
                draft: (title, body) => {
                    mkdirSync(join(config.dataDir, 'presence'), { recursive: true });
                    appendFileSync(join(config.dataDir, 'presence', 'drafts.md'), `## ${title}

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
            log(`刷 B 站：这一轮出错（${error instanceof Error ? error.message : String(error)}）`);
        } finally {
            feedRunning = false;
        }
    };

    // 网络热梗（ADR 0129）：每 12 小时一次（30 分钟看一眼该不该刷）；要她的 B 站号，没有就不学，只用库里已有的
    const refreshMemeJob = async (): Promise<void> => {
        if (!config.memes || stopped || memesRunning) return;
        const source = bilibiliAccountSource();
        if (!source) return;
        const nowDate = new Date(pipeline?.now ? pipeline.now() : Date.now());
        if (!refreshDue(loadMemes(memesFile, log), nowDate)) return;
        memesRunning = true;
        try {
            const account = await source();
            if (!account) { log('网络热梗：她的 B 站号这会儿打不开，下次再学'); return; }
            const biliFetch: BiliFetch = bilibiliFetch ?? ((url, init) => fetch(url, init));
            await refreshMemes({
                path: memesFile, now: () => nowDate, log,
                fetchLists: () => fetchLists((url, init) => fetch(url, init) as never, log),
                ask: prompt => (pipeline?.generate ? pipeline.generate([{ role: 'user', content: prompt }], log) : chatCompletion(forExtraction(config.llm), [{ role: 'user', content: prompt }], { log, purpose: 'background' })),
                gather: term => gatherEvidence(term, {
                    search: keyword => account.search(keyword), subtitle: video => account.subtitle(video), hotComments: aid => fetchHotComments(biliFetch, aid, 3),
                    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
                }),
            });
            memeEntries = loadMemes(memesFile, log).entries;
        } catch (error) {
            log(`网络热梗：这一轮出错（${error instanceof Error ? error.message : String(error)}）`);
        } finally {
            memesRunning = false;
        }
    };
    // 被限流 / 断网打断了就过一会儿再来（上线时第一次就撞上 Wikimedia 的 429，货架空了 6 小时），最多 PHOTO_RETRY_MAX 次
    let photoRetries = 0;
    let photoRetryTimer: ReturnType<typeof setTimeout> | undefined;
    const discoverPhotos = (): void => {
        if (!photos || stopped) return;
        photos.discover().then(result => {
            if (result === 'done') { photoRetries = 0; return; }
            if (photoRetries >= PHOTO_RETRY_MAX || stopped) return;
            photoRetries++;
            clearTimeout(photoRetryTimer);
            photoRetryTimer = setTimeout(discoverPhotos, photoRetryMs ?? PHOTO_RETRY_MS);
            photoRetryTimer.unref();
        }).catch(error => log(`照片货架：找照片出错（${error instanceof Error ? error.message : String(error)}）`));
    };
    // 吃的照片（ADR 0128）：给今天、明天要吃的菜找照片；被限流 / 断网打断了同样过一会儿再来
    const discoverFoodPhotos = (): void => {
        if (!photos || !foodSource || !config.foodPhotos || !config.menu || stopped) return;
        const dishes = dishesBetween(new Date(), 2, cardFor('boyfriend').character.herWorld?.menu, menuFrom);
        if (!dishes.length) return;
        photos.discoverFood(dishes).then(result => {
            if (result === 'done') { foodRetries = 0; return; }
            if (foodRetries >= PHOTO_RETRY_MAX || stopped) return;
            foodRetries++;
            clearTimeout(foodRetryTimer);
            foodRetryTimer = setTimeout(discoverFoodPhotos, photoRetryMs ?? PHOTO_RETRY_MS);
            foodRetryTimer.unref();
        }).catch(error => log(`照片货架：找吃的照片出错（${error instanceof Error ? error.message : String(error)}）`));
    };
    const discoverStickers = () => void collectingStickers?.discover()
        .catch(error => log(`图片表情：读取导入箱和 QQ 自定义表情失败（${error instanceof Error ? error.message : String(error)}）`));
    /** Hindsight 健康检查的结果（状态页用到时才探，见 status()） */
    let health: MemoryEvent | undefined;
    let probing = false;
    // 补完之前到的新消息先攒着，补完再按顺序处理
    let syncing = false;
    const buffered: MessageEvent[] = [];

    /** 每人一条：要听、要看的消息读完才进聊天记录，后面来的排在它后面（顺序不乱；读是一收到就开始读，不排队） */
    const inbox = new Map<number, Promise<void>>();
    const unlistedLimiter = new SlidingWindowRateLimiter();
    const pokeLimiter = createPokeLimiter();
    const lastPokeBack = new Map<number, number>();
    const pokeTimers = new Set<ReturnType<typeof setTimeout>>();

    function onMessage(event: MessageEvent): void {
        // 补回或入口重投的同一条消息不消耗限额，也不重复处理。
        if (chatHistory.hasMessage(event.user_id, event.message_id)) return;
        let responder = responders.get(event.user_id);
        if (!responder) {
            if (!config.unlistedFriends) {
                log(`忽略 QQ ${event.user_id} 的私聊（不在名单）`);
                return;
            }
            const decision = unlistedLimiter.take(event.user_id);
            if (!decision.allowed) {
                log(`忽略 QQ ${event.user_id} 的私聊（名单外好友${decision.scope === 'contact' ? '个人' : '全局'}限流；约 ${Math.ceil(decision.retryAfterMs / 60_000)} 分钟后恢复）`);
                return;
            }
            // 名单外的好友：{{user}} 用对方的 QQ 昵称
            const contact: Contact = { qq: event.user_id, name: unlistedName(event.sender.nickname), tier: UNLISTED_TIER };
            // 换档时间取这条消息的 QQ 时间（秒）：取现在的话，这条消息的时间比换档时间早不到一秒，会被当成换档前的消息挡掉
            const warning = tierRecord.update(contact.qq, contact.tier, new Date(event.time * 1000));
            if (warning) log(warning);
            log(`QQ ${contact.qq}（${contact.name}）不在名单，按 ${UNLISTED_TIER} 档回复`);
            responder = createContactResponder(contact);
            responders.set(contact.qq, responder);
            unlisted.set(contact.qq, contact);
        } else if (unlisted.has(event.user_id)) {
            const decision = unlistedLimiter.take(event.user_id);
            if (!decision.allowed) {
                log(`忽略 QQ ${event.user_id} 的私聊（名单外好友${decision.scope === 'contact' ? '个人' : '全局'}限流；约 ${Math.ceil(decision.retryAfterMs / 60_000)} 分钟后恢复）`);
                return;
            }
        }
        // 他对她的话回「假」/「像」：记下来就算处理完，不进聊天记录、不交给回复器、不触发主动计划（ADR 0073）
        const feedbackContact = feedback ? config.contacts.find(c => c.qq === event.user_id && canGiveFeedback(c)) : undefined;
        if (feedback && feedbackContact
            && feedback.consume(event.user_id, feedbackContact.tier, event.message, event.message_id, new Date(event.time * 1000), history.load(event.user_id))) return;
        // 连续性命令（ADR 0157 / 0161）：「/设定」看设定账本和记忆账本的摘要；「/休眠 [原因]」「/休眠 确认」「/休眠 取消」「/唤醒」。
        // 只认纯文字、只认男朋友档的他；命中的算处理完，不进聊天记录、不交给回复器。休眠中除了这几条，她什么都不回
        if (deviceOwner && event.user_id === deviceOwner.qq) {
            const plain = plainTextOf(event.message)?.trim();
            if (plain === '/设定' && (identity || memoryLedgerNow || dormancy)) {
                tellOwner([identity?.status(), memoryLedgerNow ? summarizeMemoryLedger(memoryLedgerNow) : undefined, dormancy?.status()].filter(Boolean).join('\n\n'));
                return;
            }
            // 「/为什么」：她为什么没回（ADR 0173）；放在这里是因为这条命令不能算进「没回的消息」里
            if (config.silenceNotice && plain === '/为什么') { tellOwner(answerWhy(silenceDeps(deviceOwner))); return; }
            // 「/追求」：她现在在追什么、放下过什么、想过没成什么（ADR 0178）；只能看，不能改
            if (config.selfPursuits && config.pursuits && plain === '/追求') { tellOwner(describeForOwner(pursuitsNow(), loadSelfState(config.dataDir), clockNow().getTime())); return; }
            // 「/说话习惯」：她自己总结的说话习惯、放下过什么、想写没成什么（ADR 0193）；只能看，不能改
            if (config.speechNotes && plain === '/说话习惯') {
                const now = clockNow().getTime();
                tellOwner(describeNotesForOwner(loadNotesState(config.dataDir), now, describeFeedbackForOwner(loadFeedback(config.dataDir), now)));
                return;
            }
            // 「/说话趋势」：她说话的样子按周看，放上真人语料的同一组数字；从聊天记录里数，不存状态，只是监测（ADR 0196）
            if (config.speechNotes && plain === '/说话趋势') {
                const corpus = loadExemplars(join(config.dataDir, 'exemplars', 'corpus.jsonl'));
                tellOwner(describeTrend(speechTrend(history.load(deviceOwner.qq), clockNow().getTime()), speechStats(corpus.map(item => item.replied))));
                return;
            }
            // 「/像AI」「/像真人」（可以跟一句理由）：把她最近那一次说的话连着他前面的话存下来，每晚想说话习惯时她会看到（ADR 0195，随 speechNotes）
            const feedbackCommand = config.speechNotes ? parseFeedbackCommand(plain) : undefined;
            if (feedbackCommand) {
                const now = clockNow().getTime();
                const turn = lastTurn(history.load(deviceOwner.qq), now);
                if (!turn) { tellOwner(FEEDBACK_NO_TURN); return; }
                try {
                    const total = recordFeedback(config.dataDir, { at: now, label: feedbackCommand.label, his: turn.his, hers: turn.hers, ...(feedbackCommand.why ? { why: feedbackCommand.why } : {}) });
                    tellOwner(feedbackReceipt(feedbackCommand.label, turn.hers, total));
                    log(`说话习惯：他把她最近一次说的话标成「${feedbackCommand.label === 'human' ? '像真人' : '这句像 AI'}」（日志不记内容）`);
                } catch (error) {
                    tellOwner('（没记下来，等下再试一次。）');
                    log(`说话习惯：标记没写进去（${error instanceof Error ? error.message : String(error)}）`);
                }
                return;
            }
            // 「/心境」：她此刻的心境和来由、夜里自己回想记下的（带依据）、放下的、想记没成的（ADR 0197）；只能看，不能改
            if (config.herFeelings && plain === '/心境') { tellOwner(describeFeelingsForOwner(lastFeelings, loadReviewState(config.dataDir), clockNow().getTime(), Boolean(config.feelingReview))); return; }
            // 「/自我认识」：她翻日记时发现的自己、放下过什么、想写没成什么（ADR 0194）；只能看，不能改
            if (config.diaryInsights && plain === '/自我认识') { tellOwner(describeInsightsForOwner(loadInsightsState(config.dataDir), clockNow().getTime())); return; }
            if (dormancy && plain && /^\/休眠(?:\s|$)/.test(plain)) { void handleDormancyCommand(plain.replace(/^\/休眠\s*/, '')); return; }
            if (dormancy && plain === '/唤醒') { void wakeUp(); return; }
        }
        if (dormancy?.isDormant()) {
            if (deviceOwner && event.user_id === deviceOwner.qq && Date.now() - lastDormantHint > 30 * 60_000) {
                lastDormantHint = Date.now();
                tellOwner('（她在休眠中，发 /唤醒 叫醒她）');
            }
            return;
        }
        // 他发「/亲热」（ADR 0170）：接下来十条回复临时黏一点；这条照常交给她回（回的那条也算一条）
        if (event.user_id === deviceOwner?.qq && plainTextOf(event.message)?.trim() === '/亲热') {
            armIntimate(config.dataDir, event.user_id);
            log(`[${event.user_id}] 收到 /亲热：接下来 ${INTIMATE_REPLIES} 条回复黏一点`);
        }
        // 他发「/dsh」「/QQ」「/模式」：只认男朋友档的他、只认纯文字；命中的算处理完，不进聊天记录
        if (event.user_id === deviceOwner?.qq) {
            const plain = plainTextOf(event.message)?.trim();
            log(`[${event.user_id}] 命令检查：${JSON.stringify(plain)}`);
            if (plain === '/dsh' || plain === '/工作') {
                // 不机械切换：先挂起，让她自己答应/拒绝/提条件；反复催会让她烦
                const previous = readWorkMode(config.dataDir, event.user_id);
                setWorkMode(config.dataDir, event.user_id, 'pending');
                if (previous === 'pending') void noteResident({ text: '他又催我切工作', from: 'baobao', negative: true });
                log(`[${event.user_id}] 收到 /dsh：等她决定`);
            } else if (plain === '/QQ' || plain === '/qq' || plain === '/回聊') {
                setWorkMode(config.dataDir, event.user_id, 'chat');
                tellOwner('（回聊天模式了）');
                log(`[${event.user_id}] 收到 /QQ：切回聊天模式`);
                return;
            } else if (plain === '/模式') {
                const mode = readWorkMode(config.dataDir, event.user_id);
                tellOwner(mode === 'work' ? '（现在：工作模式）' : mode === 'pending' ? '（她还没答应切工作）' : '（现在：聊天模式）');
                return;
            }
            // 给她的回复打分（决定她能不能改 SOUL）
            if (plain === '/好' || plain === '/一般' || plain === '/差') {
                addSoulRating(plain === '/好' ? 1 : plain === '/一般' ? 0 : -1);
                tellOwner(`（记下了：${plain.slice(1)}）`);
                return;
            }
        }
        // 他发「/主动」（ADR 0156）：让她现在就主动找他一次，只认纯文字、只认男朋友档的他；命中的算处理完，不进聊天记录、不交给回复器。
        // 她自己发的那条走主动消息的整条链路（人设、事实、记忆）；发不了（危机暂停、他有没回的消息、主动没开）时回一句原因
        if (event.user_id === deviceOwner?.qq && plainTextOf(event.message)?.trim() === '/主动') {
            const qq = event.user_id;
            const planner = planners.get(qq);
            void (planner ? planner.fireNow() : Promise.resolve('主动消息没开'))
                .then(reason => (reason ? transport.sendPrivateText(qq, `（现在不能主动找你：${reason}）`) : undefined))
                .catch(error => log(`[${qq}] 「/主动」出错：${error instanceof Error ? error.message : String(error)}`));
            return;
        }
        // 他发的设备命令（ADR 0148）：「批准」「拒绝」「/屏幕」「/摄像头」「/设备」，只认纯文字、只认男朋友档的他；
        // 命中的算处理完，不进聊天记录、不交给回复器。看屏幕 / 摄像头：看完的描述作为他这一条消息交给回复器，她自然地回
        if (deviceService && deviceOwner && event.user_id === deviceOwner.qq) {
            const plain = plainTextOf(event.message);
            const outcome = plain === undefined ? undefined : deviceService.owner(plain);
            if (outcome?.kind === 'reply') {
                void transport.sendPrivateText(event.user_id, outcome.text).catch(error => log(`设备控制：回复没发出去（${error instanceof Error ? error.message : String(error)}）`));
                return;
            }
            if (outcome?.kind === 'capture') {
                // 她有权拒绝（用户 10-30）：先把请求提给她，不直接做
                pendingAsk.set(event.user_id, { label: '看你的屏幕或摄像头', at: Date.now(), run: outcome.run });
                void transport.sendPrivateText(event.user_id, '（我跟她说了，她愿意就给我看）').catch(error => log(`设备控制：话说没发出去：${error instanceof Error ? error.message : String(error)}`));
                planners.get(event.user_id)?.poke();
                return;
            }
        }
        // 只从名单联系人收到的图片表情里挑；看图、判断、下载都在后台串行，不挡住这条消息的正常回复。
        if (collectingStickers && config.contacts.some(contact => contact.qq === event.user_id && contact.tier === 'boyfriend')) {
            void collectingStickers.consider(event.message, { from: event.user_id, messageId: event.message_id });
        }
        const queued = inbox.get(event.user_id);
        const reader = readerFor(event.user_id);
        if (!queued && !reader?.needs(event.message)) {
            deliver(responder, event, event.message);
            return;
        }
        const qq = event.user_id;
        const target = responder;
        // Defer media work until the previous message has fully entered the contact pipeline.
        // Starting read() before awaiting `queued` only serialized delivery and still leaked parallel OCR/vision calls.
        const job = (queued ?? Promise.resolve()).then(async () => {
            if (stopped || chatHistory.hasMessage(qq, event.message_id)) return;
            const message = reader
                ? await reader.read(event.message, event.message_id, message => log(`[${qq}] ${message}`)).catch(() => event.message)
                : event.message;
            // 读的时候补回可能已经记下了这条
            if (stopped || chatHistory.hasMessage(qq, event.message_id)) return;
            deliver(target, event, message);
        }).catch(error => log(`[${qq}] 处理收到的消息出错：${error instanceof Error ? error.message : String(error)}`));
        inbox.set(qq, job);
        void job.then(() => { if (inbox.get(qq) === job) inbox.delete(qq); });
    }

    /** 整条消息只有文字段才返回文字（图片、语音、@、引用……一出现就不是命令）；设备命令只认这种 */
    function plainTextOf(message: Segment[] | string): string | undefined {
        if (typeof message === 'string') return message;
        if (message.length === 0 || !message.every(segment => segment.type === 'text' && typeof segment.data.text === 'string')) return undefined;
        return message.map(segment => segment.data.text as string).join('');
    }

    /** 他引用回复时，被引用的那一条在聊天记录里（按 QQ 消息 id；ADR 0081） */
    const quoteLookup = (qq: number): QuoteLookup => id => {
        const found = history.load(qq).findLast(message => message.messageId === id);
        return found ? { role: found.role, content: found.content } : undefined;
    };

    function deliver(responder: Responder, event: MessageEvent, message: Segment[] | string): void {
        const text = segmentsToText(message, quoteLookup(event.user_id)).trim();
        if (!text) return;
        // 能让她动电脑的只有他亲手打的字（ADR 0179）：用原始消息判断，不用处理后的文本——看过的图、听过的语音会被换成一段文字，和他亲手打的混在一起
        const typed = event.user_id === deviceOwner?.qq && isTypedByHim(event.message);
        if (typed) lastUserText.set(event.user_id, text); else lastUserText.delete(event.user_id);
        if (event.user_id === deviceOwner?.qq && !typed && readWorkMode(config.dataDir, event.user_id) === 'work') tellOwner(NOT_TYPED_NOTICE);
        // 连续生活：他一句话会改变她的心情/关系（不挡回复）
        void noteResident({ text, from: event.user_id === deviceOwner?.qq ? 'baobao' : 'classmate' });
        // 工作模式：不进普通聊天回复器，交给 headless 的她干活，干完再回（工具桥）
        if (event.user_id === deviceOwner?.qq && typed && !text.startsWith('/') && readWorkMode(config.dataDir, event.user_id) === 'work') {
            const qq = event.user_id;
            const recent = history.load(qq).slice(-10)
                .map(message => `${message.role === 'user' ? '他' : '我'}：${message.content}`)
                .join('\n');
            log(`[${qq}] 工作模式：交给 dsh 干活（带 ${recent ? '最近对话' : '无'}上下文）`);
            // 他的话、她的回复都进聊天记录（ADR 0176）：原来工作模式里的来回不进记录，切回聊天后她不知道刚才说过什么
            history.append(qq, { time: new Date(event.time * 1000).toISOString(), role: 'user', content: text, messageId: event.message_id });
            void runWork(text, { context: recent })
                .then(async reply => {
                    const messageId = await transport.sendPrivateText(qq, reply);
                    history.append(qq, { time: clockNow().toISOString(), role: 'assistant', content: reply, messageId });
                    // 活记在他自己的 bank 里（和 QQ 聊天、DSH 桌面对话同一个），不再单独放 linmengyao
                    void rememberWorkTask(text, reply, memory?.bankId(deviceOwner));
                })
                .catch(error => {
                    log(`[${qq}] 工作桥出错：${error instanceof Error ? error.message : String(error)}`);
                    void transport.sendPrivateText(qq, '这个没弄成，等下我再看。');
                });
            return;
        }
        responder.receive(text, event.message_id, new Date(event.time * 1000));
        exportNow();
        const crisis = detectCrisis(text);
        if (crisis && config.contacts.some(c => c.qq === event.user_id)) {
            crisisState.mark(event.user_id, event.time * 1000, crisis.level);
            log(`[${event.user_id}] 危机信号：${crisis.level} 级（只记级别和时间，不记内容）${crisis.level === 'concern' ? '；关切级不停主动消息' : `；普通主动消息暂停 ${CRISIS_PAUSE_MS / 3_600_000} 小时`}`);
        }
        planners.get(event.user_id)?.poke();
    }

    // ───────── 休眠与连续性命令的实现（ADR 0161）─────────
    let selfIdKnown = 0;
    let lastDormantHint = 0;
    const tellOwner = (text: string): void => {
        if (!deviceOwner) return;
        transport.sendPrivateText(deviceOwner.qq, text).catch(error => log(`提示没发出去（${error instanceof Error ? error.message : String(error)}）`));
    };

    /** 「/休眠 [原因]」先商量：让她自己说话（这一条会发给他），记下她的话；「/休眠 确认」才封存并休眠；「/休眠 取消」回到醒着 */
    async function handleDormancyCommand(argument: string): Promise<void> {
        if (!dormancy || !deviceOwner) return;
        try {
            if (argument === '确认') {
                const done = dormancy.confirm();
                if (!done.ok) { tellOwner(`（${done.reason}）`); return; }
                noteTimeline({ channel: 'dormancy', kind: 'sleep', summary: '进入休眠，设定和状态封存好了' });
                log(`休眠：已封存 ${done.archive.files} 个文件（${(done.archive.bytes / 1_048_576).toFixed(1)} MB）到 ${done.archive.dir}`);
                tellOwner(`（已封存：${done.archive.files} 个文件、${(done.archive.bytes / 1_048_576).toFixed(1)} MB，在 ${done.archive.dir}；不含密钥、日志和 Hindsight 数据库。她进入休眠，发 /唤醒 叫醒她。）`);
                return;
            }
            if (argument === '取消') { tellOwner(dormancy.cancel() ? '（不休眠了，她还醒着。）' : '（没有在商量的休眠。）'); return; }
            if (dormancy.isDormant()) { tellOwner('（她已经在休眠了。）'); return; }
            const reason = argument.trim() || undefined;
            dormancy.propose(reason, undefined);
            const outcome = await responders.get(deviceOwner.qq)!.initiate({ label: '休眠前商量', note: proposeNote(reason), topic: '休眠前她想对他说什么', maxBubbles: 3, dryRun: false, commit: () => undefined });
            if (outcome.result === 'sent') {
                dormancy.propose(reason, outcome.parts.join('\n'));
                tellOwner('（她回答了，上面就是她的话，已经记进封存。要继续就发「/休眠 确认」，改主意发「/休眠 取消」。）');
            } else {
                tellOwner(`（没能让她回答${outcome.result === 'failed' || outcome.result === 'skipped' ? `：${outcome.reason}` : ''}。你可以直接发「/休眠 确认」（她的留言会是空的），或「/休眠 取消」。）`);
            }
        } catch (error) {
            log(`休眠：处理命令出错（${error instanceof Error ? error.message : String(error)}）`);
            tellOwner('（休眠命令出错了，没有做任何改动；详情看日志。）');
        }
    }

    /** 「/唤醒」：核对封存清单、设定账本、记忆账本，补回休眠期间漏掉的消息，她像刚睡醒一样跟他说一句 */
    async function wakeUp(): Promise<void> {
        if (!dormancy || !deviceOwner) return;
        try {
            const since = (() => { const state = dormancy.state(); return state.state === 'dormant' ? Date.parse(state.since) : Date.now(); })();
            const woke = dormancy.wake();
            if (!woke.ok) { tellOwner(`（${woke.reason}）`); return; }
            const problems = [...woke.check.problems];
            let identityLine: string | undefined;
            if (identity) {
                const report = identity.check();
                if (!report.chain.ok) problems.push(`设定账本验不过（${report.chain.reason}）`);
                identityLine = report.changes.length ? `设定有 ${report.changes[0]!.files.length} 处改动${report.unexplained.length ? '，其中有没登记原因的' : '，都有记录'}` : '设定和睡前一样';
            }
            if (memoryLedgerNow) { const check = memoryLedgerNow.verify(); if (!check.ok) problems.push(`记忆账本验不过（${check.reason}）`); }
            noteTimeline({ channel: 'dormancy', kind: 'wake', summary: `醒来了，睡了 ${woke.minutes} 分钟${problems.length ? '，核对有问题' : '，核对都对得上'}`, ok: problems.length === 0 });
            if (selfIdKnown) { await syncMissed(selfIdKnown); }
            const missed = chatHistory.load(deviceOwner.qq).filter(m => m.role === 'user' && Date.parse(m.time) >= since).length;
            tellOwner(`（她醒了。睡了 ${woke.minutes} 分钟；核对：${problems.length ? problems.join('；') : '封存清单、设定、记忆账本都对得上'}。休眠期间你发了 ${missed} 条。）`);
            catchUpAll();
            startBrowsing(); startReplies(); void watchJob();
            for (const planner of planners.values()) planner.poke();
            presence?.reapply();
            const outcome = await responders.get(deviceOwner.qq)!.initiate({
                label: '醒来', note: wakeNote(woke.minutes, problems, identityLine, missed ? `休眠期间他发了 ${missed} 条，你会接着回。` : ''),
                topic: '她刚睡醒，想对他说什么', maxBubbles: 3, dryRun: false, commit: () => undefined,
            });
            if (outcome.result !== 'sent') log('休眠：醒来的那一句没发出去');
        } catch (error) {
            log(`休眠：醒来出错（${error instanceof Error ? error.message : String(error)}）`);
            tellOwner('（醒来的过程出错了；详情看日志。）');
        }
    }

    async function syncMissed(selfId: number): Promise<void> {
        for (const contact of config.contacts) {
            let fetched: HistoryMessage[] = [];
            try {
                fetched = await transport.friendHistory(contact.qq, BACKFILL_COUNT);
            } catch (error) {
                // 没有任何聊天记录时 NapCat 也报错（“消息…不存在”）
                log(`[${contact.qq}] 拉取历史消息失败，跳过补回：${error instanceof Error ? error.message : String(error)}`);
                continue;
            }
            if (stopped) return;
            let fresh = newerThanStored(history.load(contact.qq), fetched, tierRecord.since(contact.qq));
            // 停机期间他回的「假」/「像」：记下来，不当聊天补回（ADR 0073）
            if (feedback && canGiveFeedback(contact)) {
                const stored = history.load(contact.qq);
                fresh = fresh.filter(m => (m.sender?.user_id ?? m.user_id) === selfId
                    || !feedback.consume(contact.qq, contact.tier, m.message, m.message_id, new Date(m.time * 1000), stored));
            }
            // 他发的语音、图片先听一听、看一看（ADR 0052）；读的时候实时收到的那条可能已经记下了，按 id 再筛一遍
            const backReader = readerFor(contact.qq);
            if (collectingStickers && contact.tier === 'boyfriend') {
                for (const message of fresh.filter(message => (message.sender?.user_id ?? message.user_id) !== selfId)) {
                    void collectingStickers.consider(message.message, { from: contact.qq, messageId: message.message_id });
                }
            }
            if (backReader && fresh.some(m => backReader.needs(m.message))) {
                const contactLog = (message: string) => log(`[${contact.qq}] ${message}`);
                fresh = await Promise.all(fresh.map(async m => ({ ...m, message: await backReader.read(m.message, m.message_id, contactLog).catch(() => m.message) })));
                if (stopped) return;
                const known = new Set(history.load(contact.qq).map(m => m.messageId));
                fresh = fresh.filter(m => !known.has(m.message_id));
            }
            const missed = toStored(fresh, selfId, quoteLookup(contact.qq));
            for (const message of missed) history.append(contact.qq, message);
            // 停机期间他说过想伤害自己的话：补回时也记一笔（只记时间），暂停期从他说话的时候算（ADR 0068）
            for (const message of missed) {
                if (message.role !== 'user') continue;
                const crisis = detectCrisis(message.content);
                if (crisis) crisisState.mark(contact.qq, Date.parse(message.time), crisis.level);
            }
            if (missed.length) {
                const lines = sensitive.on()
                    ? missed.map(m => `${m.role === 'user' ? '对方' : '她'}：${m.content}`).join(' / ')
                    : `${missed.filter(m => m.role === 'user').length} 条是对方的，${missed.filter(m => m.role !== 'user').length} 条是她的（共 ${missed.reduce((total, m) => total + [...m.content].length, 0)} 字）`;
                log(`[${contact.qq}] 补回 ${missed.length} 条漏掉的消息：${lines}`);
            }
        }
    }

    function catchUpAll(): void {
        const now = new Date();
        for (const contact of config.contacts) {
            const stored = history.load(contact.qq);
            // 按作息时：她睡着时来的消息，起床后照样回（ADR 0007 决策 4）；还在睡就由回复器等到起床
            const schedule = config.schedule ? cardFor(contact.tier).character.schedule : undefined;
            if (shouldCatchUp(stored, now) || (schedule && arrivedWhileAsleep(stored, now.getTime(), schedule))) {
                log(`[${contact.qq}] 有没回的消息，回复`);
                responders.get(contact.qq)!.catchUp();
            } else if (stored.at(-1)?.role === 'user') {
                log(`[${contact.qq}] 没回的消息已超过 ${CATCH_UP_WINDOW_MS / 3_600_000} 小时，只补记录，等对方下一条消息时一起回`);
            }
        }
    }

    // 账号控制面（ADR 0142）：qqControl 开着、入口给了通用 OneBot 调用才建；每个动作都过闸并写审计
    const accountMode = config.qqControl ?? 'off';
    const account = accountMode !== 'off' && transport.callAction
        ? createAccount({
            policy: {
                mode: accountMode,
                friends: config.qqAllowFriends ?? [],
                groups: config.qqAllowGroups ?? [],
                perHour: 6,
                dangerous: config.qqDangerous ?? false,
            },
            call: transport.callAction,
            now: () => Date.now(),
            log,
            audit: entry => { try { appendFileSync(join(config.dataDir, 'account-audit.jsonl'), `${JSON.stringify(entry)}
`); } catch { /* 审计写不进去不影响动作 */ } },
        })
        : undefined;
    if (accountMode !== 'off' && !account) log('账号控制面：入口没给通用 OneBot 调用，控制面没有启动');
    if ((config.qqFriendGate ?? 'off') !== 'off' && accountMode !== 'on') log('好友申请：要 qqControl 设为 on 才处理，现在没生效');
    else if ((config.qqFriendGate ?? 'off') !== 'off') log(`好友申请：${config.qqFriendGate === 'all' ? '名单内同意、名单外驳回' : '只自动同意名单内的'}（名单 ${(config.qqAllowFriends ?? []).join('、') || '空'}）`);

    return {
        async connected(selfId) {
            if (stopped) return;
            connectedAt = new Date();
            selfIdKnown = selfId;
            syncing = true;
            try {
                await syncMissed(selfId);
            } finally {
                syncing = false;
                if (!stopped) {
                    for (const message of buffered.splice(0)) onMessage(message);
                    if (!dormancy?.isDormant()) catchUpAll();
                    syncMemory();
                    startPlanners();
                    startPresence();
                    presence?.reapply();
                    if (!dormancy?.isDormant()) { startBrowsing(); startReplies(); }
                    for (const planner of planners.values()) planner.poke();
                    for (const notice of ownerNotices.splice(0)) tellOwner(notice);
                    syncFollowUps();
                    discoverStickers();
                    discoverPhotos();
                    discoverFoodPhotos();
                    void refreshMemeJob();
                    if (!dormancy?.isDormant()) void watchJob();
                    refreshAllJokes();
                    refreshAllIdioms();
                    checkWeeklyReport();
                    if (config.weeklyReport && !weeklyTimer) {
                        weeklyTimer = setInterval(checkWeeklyReport, 60 * 60_000);
                        weeklyTimer.unref();
                    }
                    if (config.watching && !watchingTimer) {
                        watchingTimer = setInterval(() => void watchJob(), 30 * 60_000);
                        watchingTimer.unref();
                    }
                    if (config.biliFeed && config.biliFeed !== 'off' && !feedTimer) {
                        void feedJob();
                        feedTimer = setInterval(() => void feedJob(), 30 * 60_000);
                        feedTimer.unref();
                    }
                    if (config.memes && !memesTimer) {
                        memesTimer = setInterval(() => void refreshMemeJob(), 30 * 60_000);
                        memesTimer.unref();
                    }
                    if (jokes && !jokesTimer) {
                        jokesTimer = setInterval(refreshAllJokes, JOKES_CHECK_MS);
                        jokesTimer.unref();
                    }
                    if (idioms && !idiomsTimer) {
                        idiomsTimer = setInterval(refreshAllIdioms, IDIOMS_CHECK_MS);
                        idiomsTimer.unref();
                    }
                    if (photos && !photoDiscoveryTimer) {
                        photoDiscoveryTimer = setInterval(discoverPhotos, PHOTO_DISCOVERY_INTERVAL_MS);
                        photoDiscoveryTimer.unref();
                    }
                    if (photos && foodSource && config.foodPhotos && !foodDiscoveryTimer) {
                        foodDiscoveryTimer = setInterval(discoverFoodPhotos, FOOD_DISCOVERY_INTERVAL_MS);
                        foodDiscoveryTimer.unref();
                    }
                    if (collectingStickers && !stickerDiscoveryTimer) {
                        stickerDiscoveryTimer = setInterval(discoverStickers, STICKER_DISCOVERY_INTERVAL_MS);
                        stickerDiscoveryTimer.unref();
                    }
                }
            }
        },
        receive(event) {
            if (stopped) return;
            lastMessageAt = new Date();
            if (syncing) buffered.push(event);
            else onMessage(event);
        },
        receivePoke(event) {
            if (stopped || syncing || !config.pokes) return;
            const contact = config.contacts.find(c => c.qq === event.user_id);
            if (!contact) return;
            const now = worldNow();
            if (now - event.time * 1000 > POKE_MAX_AGE_MS) return;
            // 睡着、在上课时的戳不算：她看不到手机，起床、下课后回一句「戳我干嘛」是怪的（消息才会等到起床后看到）
            const schedule = config.schedule ? cardFor(contact.tier).character.schedule : undefined;
            if (schedule) {
                const kind = stateAt(schedule, new Date(now)).activity.kind;
                if (kind === 'sleep' || kind === 'class' || asleepSince(schedule, bedtimes(schedule, now), new Date(now))) {
                    log(`[${contact.qq}] 戳了她一下，她在${kind === 'class' ? '上课' : '睡觉'}，不理`);
                    return;
                }
            }
            if (!pokeLimiter.take(contact.qq, now)) {
                log(`[${contact.qq}] 戳了她一下，5 分钟里已经戳过 ${POKE_MAX_IN_WINDOW} 下，不理`);
                return;
            }
            log(`[${contact.qq}] 戳了她一下`);
            onMessage(pokeMessage(event));
            // 她也戳回去一下（比文字回复早一点）；失败只记一行，不影响回复
            const back = config.pokeBack && transport.pokeFriend ? pokeBackPlan(contact.qq, event.time) : undefined;
            const lastBack = lastPokeBack.get(contact.qq);
            if (back && (lastBack === undefined || now - lastBack >= POKE_BACK_COOLDOWN_MS)) {
                lastPokeBack.set(contact.qq, now);
                const timer = setTimeout(() => {
                    pokeTimers.delete(timer);
                    if (stopped) return;
                    transport.pokeFriend!(contact.qq).then(() => log(`[${contact.qq}] 戳回去了`), error => log(`[${contact.qq}] 戳回去失败：${error instanceof Error ? error.message : String(error)}`));
                }, back.delayMs);
                timer.unref?.();
                pokeTimers.add(timer);
            }
        },

        receiveRecall(event) {
            if (stopped || !config.recalls) return;
            const contact = config.contacts.find(c => c.qq === event.user_id);
            if (!contact) return;
            // 想伤害自己的话撤回了也照样看到（安全比像人优先，ADR 0068）；回过的她已经看过
            if (chatHistory.recall(contact.qq, event.message_id, content => Boolean(detectCrisis(content)))) {
                log(`[${contact.qq}] 他撤回了一条还没回的消息，记成「撤回了一条消息」`);
            }
        },
        receiveFriendRequest({ userId, flag }) {
            const gate = config.qqFriendGate ?? 'off';
            if (!account || gate === 'off') return;
            const verdict = friendRequestVerdict(gate, config.qqAllowFriends ?? [], userId);
            if (verdict === 'ignore') {
                log(`[好友申请] ${userId} 不在名单里，留着给你处理`);
                return;
            }
            account.run('set_friend_add_request', { flag, approve: verdict === 'accept' })
                .then(() => log(`[好友申请] ${userId} ${verdict === 'accept' ? '同意' : '驳回'}`))
                .catch(error => log(`[好友申请] ${userId} 处理失败：${error instanceof Error ? error.message : String(error)}`));
        },
        stop() {
            if (stopped) return;
            stopped = true;
            for (const timer of pokeTimers) clearTimeout(timer);
            pokeTimers.clear();
            heartbeat.stop();
            reading?.stop();
            if (readingUnlisted !== reading) readingUnlisted?.stop();
            for (const planner of planners.values()) planner.stop();
            for (const responder of responders.values()) responder.stop();
            if (memoryTimer) clearInterval(memoryTimer);
            if (tastesTimer) clearInterval(tastesTimer);
            if (tastesFirst) clearTimeout(tastesFirst);
            if (followUpTimer) clearInterval(followUpTimer);
            presence?.stop();
            browsing?.stop();
            replies?.stop();
            risk?.stop();
            if (lifeTimer) clearInterval(lifeTimer);
            if (weatherTimer) clearInterval(weatherTimer);
            if (stickerDiscoveryTimer) clearInterval(stickerDiscoveryTimer);
            if (photoDiscoveryTimer) clearInterval(photoDiscoveryTimer);
            if (memesTimer) clearInterval(memesTimer);
            if (watchingTimer) clearInterval(watchingTimer);
            if (feedTimer) clearInterval(feedTimer);
            if (silenceTimer) clearInterval(silenceTimer);
            if (selfPursuitTimer) clearInterval(selfPursuitTimer);
            if (speechNotesTimer) clearInterval(speechNotesTimer);
            if (diaryInsightsTimer) clearInterval(diaryInsightsTimer);
            if (feelingReviewTimer) clearInterval(feelingReviewTimer);
            clearInterval(outboxTimer);
            if (foodDiscoveryTimer) clearInterval(foodDiscoveryTimer);
            clearTimeout(foodRetryTimer);
            if (jokesTimer) clearInterval(jokesTimer);
            if (idiomsTimer) clearInterval(idiomsTimer);
            void deviceService?.stop();
            if (weeklyTimer) clearInterval(weeklyTimer);
            clearTimeout(photoRetryTimer);
            useRealWeather(undefined);
            stopLockHeartbeat();
            releaseLock();
        },
        status() {
            const now = new Date();
            const contactStatus = (contact: Contact, isUnlisted: boolean): ContactStatus => {
                const last = history.load(contact.qq).at(-1);
                const since = tierRecord.since(contact.qq);
                const { character } = cardFor(contact.tier);
                const schedule = config.schedule ? character.schedule : undefined;
                const extraFree = config.herDays ? [...readingActivities(character.books), ...herPlanActivities(config.dataDir, new Date(), log)] : [];
                return {
                    qq: contact.qq,
                    name: contact.name,
                    tier: contact.tier,
                    ...(contact.knowsBot !== undefined ? { knowsBot: contact.knowsBot } : {}),
                    card: cardKey(contact),
                    unlisted: isUnlisted,
                    ...(since ? { tierSince: since.toISOString() } : {}),
                    ...(crisisState.last(contact.qq) ? { crisis: {
                        at: new Date(crisisState.last(contact.qq)!.at).toISOString(),
                        level: crisisState.last(contact.qq)!.level,
                        paused: crisisState.pausedAt(contact.qq, now.getTime()),
                    } } : {}),
                    responder: responders.get(contact.qq)!.status(),
                    ...(last ? { last: { time: last.time, from: last.role } } : {}),
                    ...(schedule ? { now: describeState(stateAt(schedule, now, extraFree), schedule, { userName: contact.name }) } : {}),
                    ...(planners.has(contact.qq) ? { proactive: planners.get(contact.qq)!.status() } : {}),
                };
            };
            if (hindsight && !stopped && !probing && (!health || now.getTime() - health.at >= HEALTH_PROBE_MS)) {
                probing = true;
                hindsight.health()
                    .then(() => { health = { at: Date.now(), ok: true }; }, error => {
                        health = { at: Date.now(), ok: false, error: error instanceof Error ? error.message : String(error) };
                    })
                    .finally(() => { probing = false; });
            }
            return {
                runtime,
                contacts: [
                    ...config.contacts.map(contact => contactStatus(contact, false)),
                    ...[...unlisted.values()].map(contact => contactStatus(contact, true)),
                ],
                unlistedFriends: config.unlistedFriends,
                schedule: config.schedule,
                moody: config.moody,
                speechCheck: config.speechCheck,
                ...(config.tailCap ? { tailCap: true } : {}),
                herDays: config.herDays,
                ...(herDaysCard ? { today: herDayStatus(herDaysCard.schedule!, herDaysCard, now,
                    herDaysCard.herWorld && sharedWorld ? sharedWorld.at(herDaysCard.herWorld, herDaysCard.schedule!, now) : undefined) } : {}),
                proactive: config.proactive,
                features: featureStatuses(config),
                ...(photos || jokes || config.weeklyReport ? { extras: statusExtras() } : {}),
                ...(config.memory ? { memory: { baseUrl: config.memory.baseUrl, health, ...memory!.status() } } : {}),
            };
        },
    };
}

function herDayStatus(schedule: NonNullable<TierCard['character']['schedule']>, character: TierCard['character'], now: Date, world?: WorldNow): HerDayStatus {
    const body = character.herWorld?.body ? bodyAt(character.herWorld.body, schedule, now) : undefined;
    const mood = moodAt(schedule, character.moods, now, undefined, { body, world });
    return {
        day: formatDate(herDay(schedule, now)),
        ...(mood ? { mood: { name: mood.mood.name, reason: mood.reason } } : {}),
        books: character.books.map(book => {
            const progress = bookProgressAt(schedule, book, now);
            return {
                title: book.title, amount: progress.amount, unit: progress.unit,
                finished: progress.finished, stopped: progress.stopped, putDown: book.progress.state === 'put_down',
            };
        }),
    };
}
