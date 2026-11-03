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
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canGiveFeedback, cardKey, CONTACT_TIERS, deliberateLlm, UNLISTED_TIER, type AppConfig, type Contact, type Tier } from './config.ts';
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
import { acquireLock } from './lock.ts';
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
import { startHeartbeat } from './heartbeat.ts';
import { createFeedbackChannel } from '.././emotion/feedback.ts';
import { momentsReader } from '.././emotion/moments.ts';
import { loadEverydayFrom } from '.././life/everyday.ts';
import { dishesBetween, loadMenuFrom } from '.././life/menu.ts';
import { BILI_STICKER_PER_DAY, biliStickerDiscover, STICKER_UNCUED_CHANCE } from '.././language/bili-stickers.ts';
import { pursuitsReader } from '.././life/pursuits.ts';
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
import { bodyAt } from '.././life/body.ts';
import { worldState, type WorldNow } from '.././world/world.ts';
import { actionQueue, settlingWorld } from '.././world/action-queue.ts';
import { lifeExecutor } from '.././world/life-selector.ts';
import { loadNeedsAnchor, needsAt } from '.././life/needs.ts';
import { humanValuesAt, humanValuesFromAnchor } from '.././human-values.ts';
import { createDshLink, dshOptionsFromLlm, type DshConversationTurn, type DshState, type DshVoice } from '.././dsh-link.ts';
import { createMobileCompanion, type MobileCompanionIntegration } from '.././mobile-companion-dsh.ts';
import type { CompanionMessage } from '@qqbot/mobile-companion/protocol';
import { DIARY_BACKFILL_DAYS, DIARY_TEMPERATURE, diaryWriter } from '.././life/diary.ts';
import { armIntimate, INTIMATE_REPLIES, takeIntimateLine } from '.././language/intimacy.ts';
import { describeState, formatDate, herDay, stateAt, type Schedule } from '.././life/schedule.ts';
import { useRealWeather, weatherFetcher, type WeatherFetcherStatus } from '.././world/weather.ts';
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
    /** DSH 开启时可供宿主挂 HTTPS / WebSocket 的手机伴侣运行时；默认关闭时为 undefined。 */
    mobileCompanion(): MobileCompanionIntegration | undefined;
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
    /** 真实天气取数的新鲜度与覆盖范围；不包含坐标、聊天或角色资料。 */
    weather?: WeatherFetcherStatus;
    /** 手机伴侣安全摘要：不含配对码、nonce 或消息正文。 */
    mobileCompanion?: { enabled: boolean; pairedClientId?: string; connected: boolean; queued: number; maxQueuedPerClient: number };
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
    /** 敏感调试开关（ADR 0070 第 8 项）；不传按环境变量 QQBOT_SENSITIVE_LOGS（默认关） */
    sensitive?: SensitiveSwitch;
}

/** 名单外的人在提示词里的称呼（{{user}}）：QQ 昵称，没有就叫「对方」 */
export function unlistedName(nickname: string | undefined): string {
    return nickname?.trim() || '对方';
}

export function startApp({ config, transport, log, pipeline, media, vision, stickers, photoSource, foodSource, photoRetryMs, stickerChance, stickerOnlyChance, mediaTimeouts, bilibiliFetch, bilibiliRequest, startDevices, sensitive = sensitiveSwitch() }: AppOptions): App {
    const runtime = runtimeInfo();
    useSensitiveSwitch(sensitive);
    log(sensitive.describe());
    // 旧的直接调用方 / 测试夹具可能没有新加的 dsh 字段；缺失时按关闭处理，保持 AppConfig 之前的调用兼容。
    const dshConfig = config.dsh ?? { enabled: false };
    // DSH 桥默认只建立对象，不自动发网络请求；插件打开且男朋友显式发 /dsh 才探针或咨询。
    const dshLink = createDshLink(dshOptionsFromLlm(config.llm, {
        ...(dshConfig.baseUrl ? { baseUrl: dshConfig.baseUrl } : {}),
        ...(dshConfig.model ? { model: dshConfig.model } : {}),
        ...(dshConfig.timeoutMs === undefined ? {} : { timeoutMs: dshConfig.timeoutMs }),
    }), { log: message => log(`DSH：${message}`) });
    // 兼容旧的直接调用方/测试夹具：未带 dsh 时按默认关闭处理。
    const dshEnabled = dshConfig.enabled === true;
    // DSH 咨询必须按 QQ 到达顺序串行，避免快速连发时后发问题先返回，破坏上下文连续性。
    let dshAskTail: Promise<void> = Promise.resolve();
    // DSH 命令不写入普通 QQ 聊天记录，单独保留一个有上限的进程内连续上下文。
    const dshConversation: DshConversationTurn[] = [];
    log(`DSH 顾问：${dshEnabled ? '开（仅男朋友档显式 /dsh 命令）' : '关'}`);
    // 关着的时候不留上次开着时的完整提示词
    if (!sensitive.on()) rmSync(join(config.dataDir, 'last-prompt.json'), { force: true });
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
            ...(needsAnchor ? {
                humanValuesAt: ({ at, needs }) => {
                    try {
                        // 生活选择器只需要全局、与事件账一致的动机 / 无聊底色；联系人聊天仍由各自回复器投影，避免把某人的局部关系误作全局决策。
                        return humanValuesAt({ at, needs, history: [], tier: 'known', events: ledgerWorld.events() });
                    } catch (error) {
                        log(`生活选择器：真人式状态投影失败（${error instanceof Error ? error.message : String(error)}）`);
                        return undefined;
                    }
                },
            } : {}),
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
    if (config.autonomousLife) log(`没人聊天时她一件件过日子：${lifeRunner ? '开（ADR 0040/0045，原始需要值只改行动账；真人式底色按联系人自然语言接入回复）' : '配置开了，但没有带作息和世界的卡，不开'}`);
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
    const releaseLock = acquireLock(join(config.dataDir, 'bot.lock'));
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
    const diaries = memory && diaryCard
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
    if (memory) log(diaries ? `她的日记：她的每一天结束后写一篇存进公共记忆（没聊天的日子也写，停过的补最近 ${DIARY_BACKFILL_DAYS} 天）` : '她的日记：不写（用到的档位卡上都没有作息）');
    function syncMemory(): void {
        if (!memory) return;
        for (const contact of config.contacts) {
            void memory.sync(contact, { user: contact.name, char: cardFor(contact.tier).character.name }, history.load(contact.qq));
        }
        void diaries?.catchUp(new Date(pipeline?.now?.() ?? Date.now()));
        void promises?.sync();
    }
    const memoryTimer = memory ? setInterval(syncMemory, MEMORY_SYNC_MS) : undefined;
    memoryTimer?.unref();

    // 每个联系人一个回复器：聊天记录、生成和重新生成都互不影响
    const responders = new Map<number, Responder>(config.contacts.map(contact => [contact.qq, createContactResponder(contact)]));
    /** 名单外临时建了回复器的好友（状态页要显示称呼和档位） */
    const unlisted = new Map<number, Contact>();

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

    function createContactResponder(contact: Contact): Responder {
        return createPipeline({
            contact,
            card: cardFor(cardKey(contact)),
            // 危机回合被问是不是真人一律承认（ADR 0068 决策 7）：知道她是程序的联系人这一轮换用承认版的卡
            ...(openCardFor(contact) ? { openCard: openCardFor(contact)! } : {}),
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
            ...(photos && contact.tier === 'boyfriend' ? { photos } : {}),
            ...(stickerChance !== undefined ? { stickerChance } : {}),
            ...(config.biliStickers ? { stickerUncued: STICKER_UNCUED_CHANCE } : {}),
            // 抽到发表情的轮次里一半只发表情（ADR 0099）：跟着情绪轮的开关走；测试可以直接给概率
            ...((stickerOnlyChance ?? (config.shape && config.shapeFeel ? STICKER_ONLY_SHARE : 0)) > 0 ? { stickerOnlyChance: stickerOnlyChance ?? STICKER_ONLY_SHARE } : {}),
            ...(noteHerDay ? { onHerDay: noteHerDay } : {}),
            history,
            ...(needsAnchor && sharedWorld ? {
                humanValues: ({ contact: valueContact, history: valueHistory, at }: { contact: Contact; history: readonly (Pick<StoredMessage, 'role' | 'content'> & { time?: string })[]; at: Date }) => {
                    try {
                        const events = sharedWorld.events?.() ?? [];
                        return humanValuesFromAnchor({ at, anchor: needsAnchor, history: valueHistory, tier: valueContact.tier, events });
                    } catch (error) {
                        log(`[${valueContact.qq}] 数值状态：投影失败（${error instanceof Error ? error.message : String(error)}）`);
                        return undefined;
                    }
                },
            } : {}),
            memory,
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
            // 他刚发过「/亲热」（ADR 0170）：接下来十条回复黏一点，每生成一条减一
            ...(contact.tier === 'boyfriend' ? { intimacyLine: () => takeIntimateLine(config.dataDir, contact.qq) } : {}),
            // 心境（ADR 0102）：作者写下的事每次现取
            ...(config.herFeelings ? { herFeelings: true, moments: momentsReader(config.dataDir, log) } : {}),
            ...(config.together ? { together: true } : {}),
            ...(config.relationship ? { relationship: true } : {}),
            ...(config.jealousy ? { jealousy: true } : {}),
            ...(config.curious ? { curious: true } : {}),
            ...(config.interruptions ? { interruptions: true } : {}),
            ...(jokes && contact.tier === 'boyfriend' ? { jokes: () => jokes.load(contact.qq).jokes } : {}),
            ...(idioms && contact.tier === 'boyfriend' ? { idioms: () => idioms.load(contact.qq).items } : {}),
            ...(config.memes && contact.tier === 'boyfriend' ? { memes: () => memeEntries } : {}),
            ...(config.watching && contact.tier === 'boyfriend' ? { watched: () => watchedEntries } : {}),
            ...(config.texture ? { texture: true } : {}),
            ...(config.quoteReply ? { quoteReply: true } : {}),
            ...(config.factCheck !== 'off' ? { factCheck: config.factCheck } : {}),
            ...(config.herNo ? { herNo: true } : {}),
            ...(config.lagTail ? { lagTail: true } : {}),
            ...(config.everydayLife ? { everydayLife: true } : {}),
            ...(config.pursuits ? { pursuits: pursuitsReader(config.dataDir, log) } : {}),
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
        const extraFree = config.herDays ? readingActivities(worldCard.books) : [];
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
            extraFree: config.herDays ? readingActivities(worldCard.books) : [],
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
        const extraFree = config.herDays && worldCard ? readingActivities(worldCard.books) : [];
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
        const extraFree = config.herDays && worldCard ? readingActivities(worldCard.books) : [];
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
            if (dshEnabled && plain === '/dsh') {
                void dshLink.probe().then(result => {
                    tellOwner(result.ok
                        ? `（DSH 已连通：${result.model}，${result.latencyMs}ms）`
                        : `（DSH 没连上：${result.error ?? '未知错误'}）`);
                });
                return;
            }
            if (dshEnabled && plain === '/dsh pair') {
                if (!mobileCompanion) { tellOwner('（手机伴侣还没开。）'); return; }
                const clientId = `android-${randomBytes(6).toString('hex')}`;
                const ticket = mobileCompanion.issuePairing(clientId);
                tellOwner(`（手机伴侣配对码：${ticket.pairingCode}；设备 ID：${clientId}；${Math.ceil((ticket.expiresAt - Date.now()) / 60_000)} 分钟内有效。不要把配对码发给别人。）`);
                return;
            }
            if (dshEnabled && plain === '/dsh unpair') {
                if (!mobileCompanion) { tellOwner('（手机伴侣还没开。）'); return; }
                const oldClientId = mobileCompanion.runtime.status().pairedClientId;
                mobileCompanion.runtime.reset();
                if (oldClientId) mobileCompanion.media.clear(oldClientId);
                tellOwner('（手机伴侣已解除配对，旧连接和媒体会话都失效了。）');
                return;
            }
            if (dshEnabled && plain?.startsWith('/dsh ask ')) {
                const question = plain.slice('/dsh ask '.length).trim();
                askDsh(question);
                return;
            }
            // 直写「/dsh 问题」是 /dsh ask 的便捷别名；仍只对男朋友档和显式命令生效。
            if (dshEnabled && plain?.startsWith('/dsh ')) {
                const question = plain.slice('/dsh '.length).trim();
                if (question && question !== 'ask') {
                    askDsh(question);
                    return;
                }
                tellOwner('（用法：/dsh 探针，/dsh pair，/dsh unpair，/dsh ask <问题>，也可以直接 /dsh <问题>）');
                return;
            }
            if (plain === '/设定' && (identity || memoryLedgerNow || dormancy)) {
                tellOwner([identity?.status(), memoryLedgerNow ? summarizeMemoryLedger(memoryLedgerNow) : undefined, dormancy?.status()].filter(Boolean).join('\n\n'));
                return;
            }
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
                const target = responder;
                void outcome.run().then(async handled => {
                    if (stopped) return;
                    if (handled.kind === 'reply') { await transport.sendPrivateText(event.user_id, handled.text); return; }
                    target.receive(handled.text, event.message_id, new Date(event.time * 1000));
                    planners.get(event.user_id)?.poke();
                }).catch(error => log(`设备控制：看屏幕 / 摄像头出错（${error instanceof Error ? error.message : String(error)}）`));
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
        responder.receive(text, event.message_id, new Date(event.time * 1000));
        const crisis = detectCrisis(text);
        if (crisis && config.contacts.some(c => c.qq === event.user_id)) {
            crisisState.mark(event.user_id, event.time * 1000, crisis.level);
            log(`[${event.user_id}] 危机信号：${crisis.level} 级（只记级别和时间，不记内容）；普通主动消息暂停 ${CRISIS_PAUSE_MS / 3_600_000} 小时`);
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

    /** DSH 咨询只拿她的无原文状态：需要、真人式数值、关系数值和事件类型，不带聊天内容。 */
    const dshState = (): DshState | undefined => {
        if (!needsAnchor) return undefined;
        const at = new Date(worldNow());
        try {
            const events = sharedWorld?.events?.() ?? [];
            const needs = needsAt(needsAnchor, events, at);
            const values = humanValuesAt({ at, needs, history: [], tier: deviceOwner?.tier ?? 'boyfriend', events });
            return {
                at: at.toISOString(),
                tier: deviceOwner?.tier ?? 'boyfriend',
                needs: { energy: needs.energy, hunger: needs.hunger, stress: needs.stress },
                values: {
                    energy: values.energy, hunger: values.hunger, stress: values.stress, mood: values.mood,
                    health: values.health, loneliness: values.loneliness, motivation: values.motivation,
                    boredom: values.boredom, socialBattery: values.socialBattery,
                },
                relationship: values.relationship,
                recentEvents: events.slice(-8).map(event => event.kind),
            };
        } catch (error) {
            log(`DSH：读取状态摘要失败（${error instanceof Error ? error.message : String(error)}）`);
            return undefined;
        }
    };

    /** DSH 只在显式 /dsh ask 时拿最近 6 条，保证 QQ 与 DSH 能接上话但不把整份聊天记录外发。 */
    const dshRecentTurns = () => {
        if (!deviceOwner) return undefined;
        return [...history.load(deviceOwner.qq).slice(-6).map(message => ({ role: message.role, content: message.content })), ...dshConversation].slice(-6);
    };

    /** 从当前档位卡提取最小语气档案；不把世界书、禁用词或长期记忆交给 DSH。 */
    const dshVoice = (): DshVoice | undefined => {
        try {
            const character = cardFor(deviceOwner?.tier ?? 'boyfriend').character;
            return {
                name: character.name,
                description: character.description,
                personality: character.personality,
            };
        } catch (error) {
            log(`DSH：读取语气档案失败（${error instanceof Error ? error.message : String(error)}）`);
            return undefined;
        }
    };

    let mobileCompanion: MobileCompanionIntegration | undefined;
    const describeMobileMedia = async (message: CompanionMessage, clientId: string): Promise<string | undefined> => {
        if (!message.media?.mediaId || !mobileCompanion) return undefined;
        const record = mobileCompanion.media.get(clientId, message.media.mediaId);
        if (!record) return undefined;
        if (message.kind === 'audio') {
            if (!media?.voiceDataToText) return undefined;
            return await withTimeout(media.voiceDataToText(record.data, record.mime), MEDIA_TIMEOUTS.voice);
        }
        if (!vision || !['image', 'sticker'].includes(message.kind)) return undefined;
        const dataUrl = `data:${record.mime};base64,${record.data.toString('base64')}`;
        return await withTimeout(vision.describe({ url: dataUrl, dataUrl }), MEDIA_TIMEOUTS.vision);
    };
    if (dshEnabled) mobileCompanion = createMobileCompanion({
        dsh: dshLink,
        state: dshState,
        voice: dshVoice,
        describeMedia: describeMobileMedia,
        onActionResult: async (result, clientId) => {
            // 只记设备、动作结果和决策，不把参数或媒体内容写入日志；执行仍完全由手机端白名单策略负责。
            log(`手机动作回执：设备 ${clientId}，请求 ${result.requestId}，${result.ok ? '成功' : '失败'}，决策 ${result.decision}${result.error ? `（${result.error.replace(/\s+/g, ' ').slice(0, 160)}）` : ''}`);
        },
    });

    /** 显式咨询才调用 DSH；问答本身留在独立上下文里，下一次 /dsh 可以接着说。 */
    const askDsh = (question: string): void => {
        dshAskTail = dshAskTail.then(async () => {
            try {
                const continuity = dshRecentTurns();
                dshConversation.push({ role: 'user', content: question });
                const reply = await dshLink.advise({ question, state: dshState(), recentTurns: continuity, voice: dshVoice() });
                const text = reply.trim() || '我刚才没整理好，你再问我一次。';
                dshConversation.push({ role: 'assistant', content: text });
                dshConversation.splice(0, Math.max(0, dshConversation.length - 12));
                tellOwner(text);
            } catch (error) {
                tellOwner(`（DSH 咨询失败：${error instanceof Error ? error.message : String(error)}）`);
            }
        });
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
            if (foodDiscoveryTimer) clearInterval(foodDiscoveryTimer);
            clearTimeout(foodRetryTimer);
            if (jokesTimer) clearInterval(jokesTimer);
            if (idiomsTimer) clearInterval(idiomsTimer);
            void deviceService?.stop();
            if (weeklyTimer) clearInterval(weeklyTimer);
            clearTimeout(photoRetryTimer);
            useRealWeather(undefined);
            releaseLock();
        },
        status() {
            const now = new Date();
            const contactStatus = (contact: Contact, isUnlisted: boolean): ContactStatus => {
                const last = history.load(contact.qq).at(-1);
                const since = tierRecord.since(contact.qq);
                const { character } = cardFor(contact.tier);
                const schedule = config.schedule ? character.schedule : undefined;
                const extraFree = config.herDays ? readingActivities(character.books) : [];
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
                ...(weather ? { weather: weather.status() } : {}),
                mobileCompanion: mobileCompanion ? { enabled: true, ...mobileCompanion.runtime.status() } : { enabled: false, connected: false, queued: 0, maxQueuedPerClient: 32 },
            };
        },
        mobileCompanion: () => mobileCompanion,
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
