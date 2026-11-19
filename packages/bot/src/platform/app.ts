// 一个 bot 的编排：名单里每人一个回复器（contact.ts），名单外的好友按 unlisted 档（可关），连上 NapCat 时补回漏掉的消息再 catchUp，
// 定时写长期记忆，记下换档，同一个数据目录只跑一个。群聊、群临时会话由入口过滤掉，不进这里。
// 主动消息（ADR 0011）：配置 proactive 不是 off、作息开着、卡上写了 proactive 的名单联系人，各一个计划器（proactive-planner.ts）；
// 第一次补回完才开始排（之前的聊天记录不全），聊天记录变了就让它重新算。
// 她自己的日子（ADR 0015）：启动时、她的每一天第一次生成时写一行当天的心情和进度；状态页的「今天」也在这里算。
// 收发由入口传进来（ADR 0008）：独立入口 main.ts 是自写的 OneBot 客户端（onebot.ts），Koishi 插件是 adapter-onebot；
// 两边给的都是 NapCat 的原始 OneBot 数据，所以转文字（segmentsToText）、补回（findMissed）只有一份。
// 他发的语音、图片（ADR 0052）：入口给了 NapCat 的语音转文字、OCR（AppOptions.media）就先听一听、看一看再进聊天记录（media.ts），
// 每人的消息按收到的顺序一条条进；读的时候不卡别人，读不出来、超时照旧「[语音]」「[图片]」。

// 碰文件都经执行器（exec.files，ADR 0336 第 6 步）；只剩语音那几行（用户本人在做，代理不碰）还直接读
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canGiveFeedback, cardKey, CONTACT_TIERS, DEFAULTS, deliberateLlm, UNLISTED_TIER, type AppConfig, type Contact, type Tier } from './config.ts';
import { loadOthers } from '.././social/others.ts';
import { createAccount } from '.././social/account.ts';
import { chatCompletion, forExtraction } from '.././language/llm.ts';
import { createExecutor, realFiles, type ExecutorOptions } from '../executor/executor.ts';
import { absorbStage, createInterpreter } from '../interpreter/interpreter.ts';
import { jokesModule } from '../modules/jokes.ts';
import { takeMemoryReview, takeSelfNotes } from '../modules/self-notes.ts';
import { idiomsModule } from '../modules/idioms.ts';
import { buildTurnModules } from './turn-modules.ts';
import { reflectionsModule } from '../modules/reflections.ts';
import { memorySyncModule } from '../modules/memory-sync.ts';
import { worldUpkeepModule } from '../modules/world-upkeep.ts';
import { dshInboxModule } from '../modules/dsh-inbox.ts';
import { tastesModule } from '../modules/tastes.ts';
import { followUpsModule } from '../modules/follow-ups.ts';
import { nowExportModule } from '../modules/now-export.ts';
import { outboxModule } from '../modules/outbox.ts';
import { dreamsModule } from '../modules/dreams.ts';
import { leaveNoteModule } from '../modules/leave-note.ts';
import { dshStateModule } from '../modules/dsh-state.ts';
import { dreamJobs } from '../life/dream-jobs.ts';
import { Acquaintances, acquaintancesAccount } from '.././life/acquaintances.ts';
import { Dormancy } from '.././memory/dormancy.ts';
import { dormancyCommands } from '.././memory/dormancy-commands.ts';
import { Identity } from '.././memory/identity.ts';
import { auditedApi, memoryLedger } from '.././memory/memory-audit.ts';
import { experiencesFromLife, experiencesFromWatched, Tastes } from '.././life/tastes.ts';
import { readLifeEvents } from '.././world/life-events.ts';
import { Timeline, timelineAccount } from '.././memory/timeline.ts';
import { consumeDshTimelineInbox, consumeDshWorldInbox } from '.././memory/dsh-inbox.ts';
import { planExplicit, readWebSecrets, searchCarry, searchNeedsClarification, WebLookup } from './web.ts';
import { acquireLock } from './lock.ts';
import { unfinishedForgetJobs } from '../memory/forget-job.ts';
import { unfinishedArchiveJobs } from '../memory/archive-job.ts';
import type { Log } from './log.ts';
import { appLifetime, type Lifetime } from './lifetime.ts';
import { ChatHistory, type StoredMessage } from '.././memory/history.ts';
import { describeError } from '../memory/transient-io.ts';
import { asleepSince, saidBedtimes } from '.././life/bedtime.ts';
import { type HistoryMessage } from '.././memory/backfill.ts';
import { segmentsToText, type GroupMessageEvent, type MessageEvent, type PokeEvent, type RecallEvent, type Segment } from './onebot.ts';
import { isSticker, MEDIA_TIMEOUTS, mediaReading, type ImageDescriber, type MediaReader } from '.././vision/media.ts';
import { createHearing } from '.././vision/hearing.ts';
import { speakViaGateway, speakViaHttp, speakViaWorker, startVoiceWorker, takeVoiceLines } from '.././vision/voice-out.ts';
import { matchSingRequest, singSong, singVideoReference } from '../voice/sing.ts';

/** 唱歌这条链路的回执也是她说的：短、口语，别像系统提示（2026-11-14 用户要求） */
const SING_LINES = {
    start: ['行，唱一首，等我几分钟。', '唱就唱，别催啊，得几分钟。', '好，那你等会儿，我唱。'],
    busy: ['上一首还没唱完呢，急什么。', '还在唱呢，等我唱完这个。'],
    fail: ['诶，没唱成：{0}', '这个我唱不了——{0}'],
    done: ['喏，唱完了。', '听吧，唱好了。', '唱完了，凑合听。'],
    donePath: ['唱完了，文件在 {0}', '喏，{0}'],
};
const pickLine = (lines: readonly string[], ...args: string[]): string =>
    lines[Math.floor(Math.random() * lines.length)]!.replace(/\{(\d)\}/g, (_, i: string) => args[Number(i)] ?? '');
import { stickerReads as openStickerReads } from '.././vision/sticker-reads.ts';
import type { Responder, ResponderStatus } from '.././social/responder.ts';
import { contextSummarizer } from '.././language/context-window.ts';
import { createContactResponder as createPipeline, loadTierCard, type ContactPipelineOptions, type TierCard } from './contact.ts';
import { groupLog } from '.././social/group-chat.ts';
import { privateGroupBulletinRecall, privateGroupBulletinTarget, privateGroupScheduleRecall } from '../social/group-memory.ts';
import { groupPeople } from '.././social/group-people.ts';
import { groupRoom } from '.././social/group-room.ts';
import { groupRoomModule } from '../modules/group-room.ts';
import { friendRequestsModule } from '../modules/friend-requests.ts';
import { pokesModule, type PokeDeps } from '../modules/pokes.ts';
import { recallsModule } from '../modules/recalls.ts';
import { groupAffect } from '.././social/group-affect.ts';
import { currentTierHistory, TierRecord } from '.././memory/tier-record.ts';
import { HindsightClient } from '.././memory/hindsight.ts';
import { noteFromInfo, recentSilence, recordSilence, silenceReplyCue, type SilenceInfo } from '.././social/silence.ts';
import { drainOutbox } from '.././social/outbox.ts';
import { revokeOwnerBank, writeOwnerBank } from '.././memory/owner-bank.ts';
import { desktopBlock, desktopRecentPath } from '.././memory/cross-recent.ts';
import { inspectReply, stripInternalMarkers, summarizeIssues, tidyQuestionMarks, type ExitIssue } from '.././language/exit-check.ts';
import { ODD_BODY_WORDS, STILTED_WORDS } from '.././language/expression.ts';
import { startHeartbeat } from './heartbeat.ts';
import { createFeedbackChannel } from '.././emotion/feedback.ts';
import { readWorkMode, setWorkMode, WORK_MARKER } from './work-mode.ts';
import { noteResident, runWorkTask } from './work-bridge.ts';
import { workHandoff } from './work-handoff.ts';
import { isTypedByHim, NOT_TYPED_NOTICE, WANTED_BUT_NOT_TYPED_NOTICE } from './instruction-source.ts';
import { appendPrivate, addRefusal, recentRefusals, ratingSummary, soulDir } from './soul-rating.ts';
import { momentsReader } from '.././emotion/moments.ts';
import { loadEverydayFrom } from '.././life/everyday.ts';
import { loadThreadsFrom } from '.././world/threads.ts';
import { loadMenuFrom } from '.././life/menu.ts';
import { photoShelfDiscovery } from '.././vision/photo-discovery.ts';
import { BILI_STICKER_PER_DAY, biliStickerDiscover, STICKER_UNCUED_CHANCE } from '.././language/bili-stickers.ts';
import { pursuitsReader } from '.././life/pursuits.ts';
import { selfAwareReader } from '.././life/self-pursuits.ts';
import { speechNotesReader } from '.././language/speech-notes.ts';
import { reviewReader as chatReviewReader } from '.././language/chat-review.ts';
import { loadFeedback, recentFeedback } from '.././language/speech-feedback.ts';
import { writeFeelingsExport, type FeelingsReport } from '.././emotion/feeling-export.ts';
import { reviewReader } from '.././emotion/feeling-review.ts';
import { takesReader } from '.././life/reading-takes.ts';
import { thoughtsReader } from '.././life/open-questions.ts';
import { guessesReader } from '.././life/her-guesses.ts';
import { insightsReader, loadInsightsState, loadSelfDiary, recordSelfDiary, writeInsightsExport } from '.././life/diary-insights.ts';
import { removeFaces } from '.././language/qq-faces.ts';
import { LongTermMemory, type MemoryEvent } from '.././memory/long-term.ts';
import { withFestivalActivities, withFestivals } from '.././world/festivals.ts';
import { type ProactiveMode } from '.././proactive/proactive.ts';
import { reactionEmoji, type PresenceTransport } from '.././social/presence.ts';
import { presenceOwner } from '.././social/presence-owner.ts';
import { type BiliFetch } from '.././bilibili/bilibili.ts';
import type { BiliAccount, BiliRequest } from '.././bilibili/bilibili-account.ts';
import { bilibiliOwners } from '.././bilibili/owners.ts';
import { stripDeviceTokens } from './device-actions.ts';
import type { startDeviceService } from './device-service.ts';
import { deviceHost } from './device-host.ts';
import { configuredImageDescriber } from '.././vision/vision.ts';
import { aiPhotoDraftFreshness, aiPhotoDraftStore, generateAiPhoto } from '.././vision/ai-photo-drafts.ts';
import { aiPhotoProvidersFromEnv, createAiPhotoProviderPool } from '.././vision/ai-photo-provider.ts';
import { aiPhotoReferenceStore } from '.././vision/ai-photo-references.ts';
import { aiPhotoReviewModelFromImageDescriber, createAiPhotoVisualReviewer, qualityCheckedAiPhotoGenerator } from '.././vision/ai-photo-quality-adapter.ts';
import { aiPhotoRequestService, defaultAiPhotoStateFile, requestCurrentAiPhoto, type AiPhotoRequestService } from '.././proactive/ai-photo-requests.ts';
import { detectCrisis, type CrisisLevel } from '.././emotion/crisis.ts';
import { createCrisisState, crisisMarks, CRISIS_PAUSE_MS } from '.././emotion/crisis-state.ts';
import { createPokeLimiter } from '.././social/pokes.ts';
import { plannerHost } from '.././proactive/planner-host.ts';
import { type PlannerStatus } from '.././proactive/proactive-planner.ts';
import { PromiseStateUnavailable } from '.././life/promise-state.ts';
import { promiseKeeper, type Appointment } from '.././life/promises.ts';
import { bookProgressAt, herDayLogger, moodAt, readingActivities } from '.././life/her-days.ts';
import { herPlanActivities } from '.././life/her-plans.ts';
import { correctionReplyLine, isCorrection, recordCorrection, understandingLine } from '.././life/understanding.ts';
import { attachMatchingMemoryReviews, finishMemoryReviews, readMemoryReviews, recordMemoryReview } from '../memory/memory-review.ts';
import { recordTrace, traceOf, tracesLine } from '.././life/traces.ts';
import { bodyAt } from '.././life/body.ts';
import { useWorldNeeds, worldState, type WorldNow } from '.././world/world.ts';
import { worldHighlights } from '.././world/highlights.ts';
import { actionQueue, settlingWorld } from '.././world/action-queue.ts';
import { lifeExecutor } from '.././world/life-selector.ts';
import { DIARY_BACKFILL_DAYS, DIARY_TEMPERATURE, diaryWriter } from '.././life/diary.ts';
import { takeIntimateLine } from '.././language/intimacy.ts';
import { describeState, formatDate, herDay, stateAt, type Schedule } from '.././life/schedule.ts';
import { useRealWeather, weatherFetcher, type WeatherFetcherStatus } from '.././world/weather.ts';
import { parseWeatherObservation, readWeatherEvidenceLedger, reconciledWeather, userWeatherEvidence } from '.././world/weather-evidence.ts';
import { airQualityFetcher, useRealAirQuality, type AirQualityFetcherStatus } from '.././world/air-quality.ts';
import { daylightFetcher, useRealDaylight, type DaylightFetcherStatus } from '.././world/daylight.ts';
import { calendarFetcher, useRealCalendar, type CalendarStatus } from '.././world/calendar.ts';
import { transportFetcher, useRealTransport, type TransportFetcherStatus } from '.././world/transport.ts';
import { featureStatuses, type FeatureStatus } from './features.ts';
import { loadMemes, memesPath } from '.././language/memes.ts';
import { loadWatched, watchedPath, type Watched } from '.././language/watching.ts';
import { passiveJobs } from '.././bilibili/passive-jobs.ts';
import { passiveReads } from './passive-reads.ts';
import { quotedContext } from './quoted-context.ts';
import { ownerCommands } from './owner-commands.ts';
import { incomingReceipts } from './incoming.ts';
import { missedMessages } from './missed-messages.ts';
import { privateAdmission } from '.././social/private-admission.ts';
import { weeklyReportDue, writeWeeklyReport } from './weekly-report.ts';
import { photoShelf, PHOTO_HISTORY_PREFIX, type FoodSource, type PhotoKind, type PhotoSource } from '.././vision/photos.ts';
import { STICKER_ONLY_SHARE, type StickerShelf } from '.././social/stickers.ts';
import { sensitiveSwitch, useSensitiveSwitch, type SensitiveSwitch } from './sensitive.ts';
import { runtimeInfo, type RuntimeInfo } from './runtime-info.ts';
import { loadNeedsAnchor, needsAt } from '.././life/needs.ts';
import { regulationAt } from '.././life/regulation.ts';
import { readAgencyShadow } from '.././world/agency-shadow.ts';
import { humanValuesAt, humanValuesFromAnchor, type HumanValues, type HumanValueTrends } from '.././human-values.ts';
import { type DevelopmentSummary } from '.././life/development.ts';
import { createDshLink, dshOptionsFromLlm, sanitizeDshError, type DshProbeResult, type DshVoice } from '.././dsh-link.ts';
import { DshConversationContext } from '.././dsh-continuity.ts';
import { dshAsks } from '.././dsh-asks.ts';
import { createMobileCompanion, type MobileCompanionIntegration } from '.././mobile-companion-dsh.ts';
import { dshStateSource } from '.././dsh-state.ts';
import { humanStateAt } from '.././human-projection.ts';
import type { CompanionMessage } from '@qqbot/mobile-companion/protocol';
import { PHOTO_REVIEW_MAX_THUMBNAIL_BYTES } from '@qqbot/mobile-companion/photo-review';
import { MAX_QUEUED_PER_CLIENT } from '@qqbot/mobile-companion/runtime';
import { wakeBackfill } from '../memory/wake-backfill.ts';
import { journalOn, selfThread, selfThreadLine } from '.././language/self-thread.ts';
import { leaveAnnouncer } from '.././life/leave-note.ts';
import { auditShell } from './shell-tool.ts';
import { dreamAppraisals, dreamNoteLine, latestDream } from '.././life/dreams.ts';
import { loadQuestion, questionLine } from '.././life/learning-questions.ts';
import { openMemeDict } from '.././language/meme-dict.ts';
import { loadExemplars } from '.././language/exemplars.ts';
import { activityWithChat, NOW_REFRESH_MS, renderNow, writeNow } from '.././life/now-export.ts';
import { askExpired, askLine } from './consent.ts';
import { createTurnWeigher, WEIGH_TIMEOUT_MS } from '.././language/turn-weight.ts';
import { externalPlatformMode, type ExternalPlatformMode } from '../social/external-platforms.ts';
import { createExternalDraftStore, type ExternalDraftStore, type ExternalDraftSummary } from '../social/external-drafts.ts';
import { createCommandReceiptStore } from './command-receipts.ts';
import { processTimeZone } from './time-zone.ts';
import { noteCharacterTerms } from '../character-terms.ts';
import { loadCharacterCard } from '../st/card.ts';

/** 自己过日子的执行器多久推一次（ADR 0040） */
const LIFE_TICK_MS = 10 * 60_000;

/** 写一次长期记忆的间隔 */
export const MEMORY_SYNC_MS = 5 * 60_000;
/** 真实天气多久取一次（ADR 0048） */
export const WEATHER_REFRESH_MS = 30 * 60_000;
/** 真实空气质量多久取一次（ADR 0227） */
export const AIR_QUALITY_REFRESH_MS = 30 * 60_000;
/** 真实日照多久取一次（ADR 0228） */
export const DAYLIGHT_REFRESH_MS = 6 * 60 * 60_000;
/** 现实法定日历多久取一次（ADR 0231） */
export const CALENDAR_REFRESH_MS = 12 * 60 * 60_000;
/** 现实交通刷新周期；供应商失败时继续使用仍在有效期内的旧缓存。 */
export const TRANSPORT_REFRESH_MS = 30 * 60_000;

/** 入口提供的收发 */
export interface Transport extends PresenceTransport {
    /** 发一条私聊文字，返回 QQ 消息 id；文字里白名单的小黄脸「[捂脸]」发成 face 段（qq-faces.ts textToSegments，ADR 0051） */
    sendPrivateText(userId: number, text: string, replyTo?: number): Promise<number>;
    /** 发群消息（ADR 0210，NapCat 的 send_group_msg）；没有就不在群里说话 */
    sendGroupText?(groupId: number, text: string, replyTo?: number): Promise<number>;
    /** 发群消息（段）：@某人、引用那一条（2026-11-14）；没有就退回 sendGroupText */
    sendGroupMessage?(groupId: number, segments: Segment[], replyTo?: number): Promise<number>;
    /** 在群里戳一下某人（NapCat 的 group_poke，配置 pokeOut）；没有就不戳 */
    pokeGroup?(groupId: number, userId: number): Promise<void>;
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
    /** 发一条语音（本机 wav，NapCat 转语音条）；没有就不发语音（2026-11-01） */
    sendPrivateVoice?(userId: number, file: string): Promise<number>;
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
    /** 群里别人发的一条（ADR 0210，配置 groupChat + groups）：只在名单里的群看、该开口时才说；不在名单的群什么都不做 */
    receiveGroup(event: GroupMessageEvent): void;
    /** 停下：拒绝新工作；已派发的记忆写入/回复发送确认并收尾后才释放锁。idle同步，忙时宿主须await。 */
    stop(): Promise<void> | undefined;
    /** 此刻的状态（控制台「林梦瑶」页面，ADR 0010）；不含聊天内容 */
    status(): AppStatus;
    /** DSH 开启时可供宿主挂 HTTPS / WebSocket 的手机伴侣运行时；默认关闭时为 undefined。 */
    mobileCompanion(): MobileCompanionIntegration | undefined;
    /** 外部平台草稿箱；只保存草稿和审计状态，不执行发布。 */
    externalDrafts(): ExternalDraftStore;
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
    /** 进程此刻实际在用的时区（ADR 0331）：作息、饭点、日界都按它算；状态页据此显示她那边的本地时间 */
    timeZone: string;
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
    /** 照片货架 / AI 照片草稿 / 小梗 / 最近一份周报；对应的功能没开就没有。 */
    extras?: { photos?: { count: number; cat: number; view: number; work: number; food: number }; aiPhotoDrafts?: { total: number; pending: number; approved: number; rejected: number }; jokes?: number; report?: { name: string; text: string } };
    /** 长期记忆开着时：服务探测结果（每分钟最多探一次）、最近一次写入和召回 */
    memory?: { baseUrl: string; health?: MemoryEvent; lastWrite?: MemoryEvent; lastRecall?: MemoryEvent };
    /** 手机伴侣安全摘要：不含配对码、nonce 或消息正文。 */
    mobileCompanion?: { enabled: boolean; pairedClientId?: string; connected: boolean; queued: number; maxQueuedPerClient: number };
    /** 真实天气缓存的新鲜度和覆盖范围，不含坐标和请求内容。 */
    weather?: WeatherFetcherStatus;
    /** 真实空气质量缓存的新鲜度和覆盖范围，不含坐标和请求内容。 */
    airQuality?: AirQualityFetcherStatus;
    /** 真实日照缓存的新鲜度和覆盖范围，不含坐标和请求内容。 */
    daylight?: DaylightFetcherStatus;
    /** 现实法定日历缓存的新鲜度和覆盖年份。 */
    calendar?: CalendarStatus;
    /** 现实交通缓存的新鲜度和地点摘要；不含端点和凭据。 */
    transport?: TransportFetcherStatus;
    /** 外部内容平台接入模式。 */
    externalPlatforms: { tieba: ExternalPlatformMode; douyin: ExternalPlatformMode; xiaohongshu: ExternalPlatformMode };
    /** 外部平台统一草稿箱的计数摘要。 */
    externalDrafts: ExternalDraftSummary;
    /** DSH 连接摘要；探针只在 QQ 明确发起 /dsh probe 后更新。 */
    dsh: { enabled: boolean; lastProbe?: Pick<DshProbeResult, 'ok' | 'at' | 'model' | 'latencyMs'> };
    /** 自主生活开启且有需要锚点时的全局真人式状态；关系值也随同一快照提供给 DSH / 控制台。 */
    humanValues?: Pick<HumanValues, 'at' | 'energy' | 'hunger' | 'stress' | 'mood' | 'health' | 'loneliness' | 'confidence' | 'curiosity' | 'boredom' | 'motivation' | 'socialBattery' | 'selfEsteem' | 'openness' | 'satisfaction' | 'comfort' | 'frustration' | 'relationship'>;
    /** 由同一事实账重算的一小时变化量，不另存第二套分数。 */
    humanTrends?: HumanValueTrends;
    /** 人格与生活深化的脱敏派生摘要；不含聊天原文、事件正文或内部评分。 */
    development?: DevelopmentSummary;
}

/** 状态页的「今天」（ADR 0015） */
export interface HerDayStatus {
    /** 她的哪一天（02:00 之前算前一天） */
    day: string;
    mood?: { name: string; reason: string };
    books: { title: string; amount: number; unit: string; finished: boolean; stopped: boolean; putDown: boolean }[];
    /** 世界账里今天已经发生的近期事实；只给控制台看，不含计划和模型猜测。 */
    highlights?: { at: string; text: string }[];
}

/** Hindsight 健康检查的间隔 */
const HEALTH_PROBE_MS = 60_000;

export interface AppOptions {
    sing?: typeof singSong;
    config: AppConfig;
    transport: Transport;
    log: Log;
    /** 测试用：替换每个回复器的生成、连发合并等待等 */
    pipeline?: Partial<Pick<ContactPipelineOptions, 'generate' | 'settle' | 'now' | 'waitUntil' | 'retryAfterMs'>>;
    /** NapCat 的语音转文字、OCR（ADR 0052）；不给就不听不看，照旧「[语音]」「[图片]」 */
    media?: MediaReader;
    /** 看图（ADR 0055）：运行入口按配置建；测试也可以直接给假的 */
    vision?: ImageDescriber;
    /** 测试可替换；运行时按当前视觉配置创建。 */
    imageRecognition?: ImageDescriber;
    imageSearch?: ImageDescriber;
    /** 读他发来的表情包（ADR 0206，readStickers）：表情包专用的看图要求、聊天优先级；运行入口按配置建，测试可给假的 */
    stickerReader?: ImageDescriber;
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
    /** 测试 / 审计：执行器派发每个动作之前看一眼（ADR 0336；行为基线用它记下每次调模型的完整配置） */
    observe?: ExecutorOptions['observe'];
    /** 测试用：仓库根（休眠封存从这里复制角色目录、设定账本从这里核对）；不给按本文件位置往上推。测试给合成的根，就不会把真实角色复制出来 */
    repoRoot?: string;
}

/** 名单外的人在提示词里的称呼（{{user}}）：QQ 昵称，没有就叫「对方」 */
export function unlistedName(nickname: string | undefined): string {
    return nickname?.trim() || '对方';
}

/**
 * App.stop 的先后（ADR 0336 第 6 步统一停止；构造失败时按登记先后停）。原来手写在 stop() 里的先后原样搬过来：
 * 先置 stopped；日记、答应的事先于长期记忆停（它们收尾时还要写记忆），口味也在模块之前；解释器停各模块（关定时任务）；
 * 然后是各条后台活、入站和危机状态落盘、回复器、连上之后才起的那几样、设备；最后撤掉现实数据的全局读口。
 * 同名的几项（每个联系人一个回复器、一份上下文要点）按登记先后。小梗、口头习惯在解释器建好前单独登记，之后交给 modules。
 */
const STOP_ORDER = [
    'stopped',
    'diaries', 'promises', 'memory', 'tastes',
    'jokes', 'idioms', 'modules',
    'dsh-asks', 'mobile-companion', 'probing',
    'passive-reads', 'sticker-work', 'account-guard', 'notices',
    'context', 'incoming', 'photo-discovery', 'crisis', 'pokes', 'heartbeat',
    'reading', 'reading-unlisted', 'planners', 'responders',
    'presence', 'browsing', 'replies', 'risk', 'food-retry', 'devices', 'photo-retry',
    'weather', 'air-quality', 'daylight', 'calendar', 'transport', 'world-needs',
] as const;
type StopName = typeof STOP_ORDER[number];

export function startApp(options: AppOptions): App {
    realFiles.mkdir(options.config.dataDir);
    const release = acquireLock(join(options.config.dataDir, 'bot.lock'));
    const lifetime = appLifetime({ release, log: options.log, stopOrder: STOP_ORDER });
    try {
        if (unfinishedForgetJobs(options.config.dataDir).length) throw new Error('数据目录有未完成遗忘任务；保留原记录，请先按原任务 --resume 核实恢复，再启动 bot');
        if (unfinishedArchiveJobs(options.config.dataDir).length) throw new Error('数据目录有未完成归档任务；保留原计划，请先 --resume 原归档任务恢复，再启动 bot');
        const app = createApp(options, lifetime);
        lifetime.commit();
        return app;
    }
    catch (error) { lifetime.rollback(); throw error; }
}

function createApp({ config, transport: rawTransport, log, pipeline, media, vision, imageRecognition, imageSearch, stickerReader, stickers, photoSource, foodSource, photoRetryMs, sing = singSong, stickerChance, stickerOnlyChance, mediaTimeouts, bilibiliFetch, bilibiliRequest, startDevices, workRunner, sensitive = sensitiveSwitch(), observe, repoRoot: repoRootOverride }: AppOptions, lifetime: Lifetime<StopName>): App {
    // 碰外部的都经执行器（ADR 0336 第 3 步）：QQ 动作、调模型、时钟和计时器、设备登记（第 8 步：设备服务下面才异步起，登记时现取）
    const exec = createExecutor({ transport: rawTransport, ...(pipeline?.generate ? { generate: pipeline.generate } : {}), ...(pipeline?.now ? { now: pipeline.now } : {}), ...(observe ? { observe } : {}), ...(workRunner ? { processes: { work: workRunner } } : {}), devices: () => devicesHost.service()?.control });
    const transport = exec.qq;
    let stopped = false;
    lifetime.own('stopped', () => { stopped = true; });
    // 纯后台的读（看视频、刷推荐、学热梗、查东西）：在 passive-reads.ts（ADR 0336 第 6 步）；停法照旧在这里登记
    const passive = passiveReads({ stopped: () => stopped, exec });
    const passiveLifetime = passive.lifetime;
    lifetime.own('passive-reads', () => passive.stop());
    // The injected shelf may be shared. Own only calls initiated by this App;
    // their promises include already-dispatched favorite mutations and receipts.
    const stickerLifetime = new AbortController(), stickerJobs = new Set<Promise<void>>();
    let stickerDrain: Promise<void> | undefined;
    let releaseStickerTrend: (() => void) | undefined;
    const ownStickerWork = (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
        if (stopped || stickerLifetime.signal.aborted) return Promise.resolve();
        const task = Promise.resolve().then(() => {
            if (!stopped && !stickerLifetime.signal.aborted) return work(stickerLifetime.signal);
        }).catch(error => {
            if (!stopped && !stickerLifetime.signal.aborted) log(`图片表情：后台处理失败（${describeError(error)}）`);
        }).finally(() => { stickerJobs.delete(task); });
        stickerJobs.add(task); return task;
    };
    const stopStickerWork = () => {
        if (stickerLifetime.signal.aborted) return stickerDrain;
        stickerLifetime.abort();
        try { releaseStickerTrend?.(); } catch (error) { try { log(`图片表情：归还来源失败（${describeError(error)}）`); } catch { /* Continue draining owned work. */ } }
        releaseStickerTrend = undefined;
        if (stickerJobs.size) stickerDrain = Promise.allSettled([...stickerJobs]).then(() => {});
        return stickerDrain;
    };
    lifetime.own('sticker-work', stopStickerWork);
    // The real account transport also persists breaker observations. Even a
    // nominal GET must retain its complete guard settlement while stopping.
    const accountGuardSettlements = new Set<Promise<void>>();
    const ownAccountGuard = (request: BiliRequest): BiliRequest => (url, init) => {
        let settle!: () => void;
        const pending = new Promise<void>(resolve => { settle = resolve; });
        accountGuardSettlements.add(pending);
        const done = () => { accountGuardSettlements.delete(pending); settle(); };
        try { return request(url, init).then(response => { done(); return response; }, error => { done(); throw error; }); }
        catch (error) { done(); return Promise.reject(error); }
    };
    lifetime.own('account-guard', () => [...accountGuardSettlements]);
    // Direct notices have no chat-history entry, but their already dispatched
    // transport and outcome diagnostics still belong to this App's lease.
    const noticeSettlements = new Set<Promise<void>>();
    const sendOwnedNotice = (send: () => Promise<unknown>, success: () => void, failure: (error: unknown) => void): Promise<void> => {
        if (stopped) return Promise.resolve();
        let settle!: () => void;
        const pending = new Promise<void>(resolve => { settle = resolve; });
        noticeSettlements.add(pending);
        const finish = () => { noticeSettlements.delete(pending); settle(); };
        const report = (callback: () => void) => { try { callback(); } catch { /* Diagnostics cannot change a confirmed outcome or strand shutdown. */ } finally { finish(); } };
        try { Promise.resolve(send()).then(() => report(success), error => report(() => failure(error))); }
        catch (error) { report(() => failure(error)); }
        return pending;
    };
    lifetime.own('notices', () => [...noticeSettlements]);
    const runtime = runtimeInfo();
    useSensitiveSwitch(sensitive);
    log(sensitive.describe());
    const dshConfig = config.dsh ?? { enabled: false };
    const externalDraftStore = createExternalDraftStore({
        dir: join(config.dataDir, 'external-drafts'),
        log: message => log(`外部草稿：${message}`),
        canDraft: platform => externalPlatformMode(config.externalPlatforms?.[platform]) !== 'off',
    });
    // 生图仍由显式 CLI 发起；运行时只读取草稿摘要给中文控制台看，不调用外部服务。
    const aiPhotoDrafts = aiPhotoDraftStore({ dir: join(config.dataDir, 'ai-photo-drafts'), log: message => log(`AI 照片草稿：${message}`) });
    const dshLink = createDshLink(dshOptionsFromLlm(config.llm, {
        ...(dshConfig.baseUrl ? { baseUrl: dshConfig.baseUrl } : {}),
        ...(dshConfig.model ? { model: dshConfig.model } : {}),
        ...(dshConfig.timeoutMs === undefined ? {} : { timeoutMs: dshConfig.timeoutMs }),
    }), { log: message => log(`DSH：${message}`) });
    const dshEnabled = dshConfig.enabled === true;
    const commandReceipts = createCommandReceiptStore({
        dir: join(config.dataDir, 'ingress'),
        log: message => log(`入口：${message}`),
    });
    let dshProbe: DshProbeResult | undefined;
    const dshConversation = new DshConversationContext({
        file: join(config.dataDir, 'memory', 'dsh-recent.json'),
        log: message => log(`DSH：${message}`),
    });
    log(`DSH 顾问：${dshEnabled ? '开（显式 /dsh ask 或 /dsh probe）' : '关'}`);
    // 关着的时候不留上次开着时的完整提示词
    if (!sensitive.on()) exec.files.remove(join(config.dataDir, 'last-prompt.json'));
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
    exec.files.mkdir(join(config.dataDir, 'world'));
    const everydayFrom = config.everydayLife ? loadEverydayFrom(join(config.dataDir, 'world', 'everyday-from.json'), new Date(), log) : undefined;
    // 每顿吃什么（ADR 0125）：同样第一次开的时候定下“从哪天起”
    // 她那边的事有后续（ADR 0216）：要日常小事和小起伏都开着（后续接在小起伏后面）
    const threadsFrom = config.worldThreads && config.everydayLife && config.worldDrama ? loadThreadsFrom(join(config.dataDir, 'world', 'threads-from.json'), new Date(), log) : undefined;
    if (config.worldThreads && !threadsFrom) log('她那边的事有后续：worldThreads 开着，但要 everydayLife 和 worldDrama 都开着才起作用');
    const menuFrom = config.menu ? loadMenuFrom(join(config.dataDir, 'world', 'menu-from.json'), new Date(), log) : undefined;
    const cards = new Map<string, TierCard>();
    const cardFor = (tier: string) => {
        let card = cards.get(tier);
        if (!card) {
            card = loadTierCard(config.characterCard, tier, { ...(everydayFrom ? { everydayLife: true, everydayFrom } : {}), ...(menuFrom ? { menu: true, menuFrom } : {}), ...(config.worldDrama ? { worldDrama: true } : {}), ...(threadsFrom ? { threadsFrom } : {}) });
            // 闺蜜的约（ADR 0061，配置 npcAsks）：开关设在这张卡的世界上，其余代码照旧读世界
            if (config.npcAsks && card.character.herWorld) card.character.herWorld.asks = true;
            // 公共节日（ADR 0076，配置 festivals）：并进这一档的重要的日子，时间块和主动消息照旧读 dates
            card.character.dates = withFestivals(card.character.dates, new Date(), config.festivals);
            withFestivalActivities(card.character.schedule, new Date(), config.festivals);
            cards.set(tier, card);
        }
        return card;
    };
    // 专有名字（ADR 0335）：城市名只写在前几档的卡上；名单里只有低档位时，也从最亲那一档的卡上记下（读不了就算了，照旧用卡上有的）
    try {
        const openest = config.characterCard.replaceAll('{tier}', 'boyfriend');
        if (exec.files.exists(openest)) noteCharacterTerms(loadCharacterCard(openest).herWorld);
    } catch { /* 那张卡真用到时 loadTierCard 会报错 */ }
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
    // 真实天气（ADR 0048 / 0338）：当前天气须经软件实况与现场观察裁决；取不到就保持未知，不用模拟天气冒充现实。
    const weatherPlaces = worldCard?.herWorld?.weather?.places;
    const weather = config.realWeather && worldCard && weatherPlaces
        ? weatherFetcher({ dir: join(config.dataDir, 'weather'), places: [weatherPlaces.school, weatherPlaces.home], log, now: worldNow })
        : undefined;
    const weatherEvidence = weather ? readWeatherEvidenceLedger(join(config.dataDir, 'weather', 'evidence.json'), log) : undefined;
    const weatherReality = weather && weatherEvidence ? reconciledWeather(weather, weatherEvidence) : weather;
    useRealWeather(weatherReality);
    const ownRealityRefresh = (
        source: { refresh(): Promise<void> } | undefined,
        refreshes: Set<Promise<void>>,
    ): Promise<void> | undefined => {
        if (stopped || !source) return undefined;
        let resolveOwned!: () => void;
        let rejectOwned!: (reason?: unknown) => void;
        const owned = new Promise<void>((resolve, reject) => { resolveOwned = resolve; rejectOwned = reject; });
        refreshes.add(owned);
        const finished = () => { refreshes.delete(owned); };
        void owned.then(finished, finished);
        try { void source.refresh().then(resolveOwned, rejectOwned); }
        catch (error) { rejectOwned(error); }
        return owned;
    };
    // A refresh owns both cities and may still publish caches after its first
    // await. Keep that whole round inside this App's data-directory lease.
    const weatherRefreshes = new Set<Promise<void>>();
    const refreshWeather = () => ownRealityRefresh(weather, weatherRefreshes);
    void refreshWeather();
    lifetime.own('weather', () => { useRealWeather(undefined); return [...weatherRefreshes]; });
    if (worldCard) log(`真实天气：${weather ? `开（${weatherPlaces!.school.name} / ${weatherPlaces!.home.name}逐小时，每 ${WEATHER_REFRESH_MS / 60_000} 分钟取一次；当前事实过期或冲突时保持未知）`
        : !config.realWeather ? '关（配置 realWeather: false），按日期生成' : '关（卡上没写 weather.places），按日期生成'}`);
    const airQuality = config.realAirQuality === true && worldCard && weatherPlaces ? airQualityFetcher({ dir: join(config.dataDir, 'air-quality'), places: [weatherPlaces.school, weatherPlaces.home], log, now: worldNow }) : undefined;
    useRealAirQuality(airQuality);
    const airQualityRefreshes = new Set<Promise<void>>();
    const refreshAirQuality = () => ownRealityRefresh(airQuality, airQualityRefreshes);
    void refreshAirQuality();
    lifetime.own('air-quality', () => { useRealAirQuality(undefined); return [...airQualityRefreshes]; });
    if (worldCard) log(`真实空气质量：${airQuality ? `开（${weatherPlaces!.school.name} / ${weatherPlaces!.home.name}当前观测，每 ${AIR_QUALITY_REFRESH_MS / 60_000} 分钟取一次；取不到不写进世界）` : (config.realAirQuality !== true ? '关（配置 realAirQuality: false）' : '关（卡上没写 weather.places）')}`);
    const daylight = config.realDaylight === true && worldCard && weatherPlaces ? daylightFetcher({ dir: join(config.dataDir, 'daylight'), places: [weatherPlaces.school, weatherPlaces.home], log, now: worldNow }) : undefined;
    useRealDaylight(daylight);
    const daylightRefreshes = new Set<Promise<void>>();
    const refreshDaylight = () => ownRealityRefresh(daylight, daylightRefreshes);
    void refreshDaylight();
    lifetime.own('daylight', () => { useRealDaylight(undefined); return [...daylightRefreshes]; });
    if (worldCard) log(`真实日照：${daylight ? `开（${weatherPlaces!.school.name} / ${weatherPlaces!.home.name}日出日落，每 ${DAYLIGHT_REFRESH_MS / 60_000} 分钟取一次；取不到不写进世界）` : (config.realDaylight !== true ? '关（配置 realDaylight: false）' : '关（卡上没写 weather.places）')}`);
    const calendar = config.realCalendar === true && worldCard ? calendarFetcher({ dir: join(config.dataDir, 'calendar'), log, now: worldNow }) : undefined;
    useRealCalendar(calendar);
    const calendarRefreshes = new Set<Promise<void>>();
    const refreshCalendar = () => ownRealityRefresh(calendar, calendarRefreshes);
    void refreshCalendar();
    lifetime.own('calendar', () => { useRealCalendar(undefined); return [...calendarRefreshes]; });
    if (worldCard) log(`现实法定日历：${calendar ? `开（当前年和下一年，每 ${CALENDAR_REFRESH_MS / 60_000} 小时取一次；取不到不写进世界）` : '关（配置 realCalendar: false）'}`);
    const transportConfig = config.realTransport ?? DEFAULTS.realTransport;
    const worldTransport = transportConfig.enabled && worldCard && weatherPlaces ? transportFetcher({
        dir: join(config.dataDir, 'transport'), log, now: worldNow,
        // 地点和天气一样从卡上读（weather.places，ADR 0334）
        locations: [weatherPlaces.school, weatherPlaces.home].map(place => ({ id: place.id, name: place.name })),
        endpoint: transportConfig.endpoint, source: transportConfig.source,
    }) : undefined;
    useRealTransport(worldTransport);
    const transportRefreshes = new Set<Promise<void>>();
    const refreshTransport = () => ownRealityRefresh(worldTransport, transportRefreshes);
    void refreshTransport();
    lifetime.own('transport', () => { useRealTransport(undefined); return [...transportRefreshes]; });
    if (worldCard) log(`现实交通：${worldTransport ? `开（${weatherPlaces!.school.name} / ${weatherPlaces!.home.name}，每 ${TRANSPORT_REFRESH_MS / 60_000} 分钟取一次；取不到不写进世界）` : (!transportConfig.enabled ? '关（配置 realTransport.enabled: false）' : '关（卡上没写 weather.places）')}`);
    // 没人聊天时她一件件过日子（ADR 0040，影子模式）：读世界之前先排到现在、结算到期的；从这次启动排起，以前排过的从事件账接着排
    const lifeQueue = config.autonomousLife && ledgerWorld ? actionQueue(join(config.dataDir, 'world', 'action-queue.json'), log) : undefined;
    const lifeStartedAt = new Date(worldNow());
    const needsAnchor = lifeQueue ? loadNeedsAnchor(join(config.dataDir, 'world', 'needs-anchor.json'), lifeStartedAt, log) : undefined;
    // ADR 0338：世界—动机账本本身不调用执行器；计划器只读取它给出的表达机会，
    // 最终仍由主动生成明确选择发送或“不发”。
    const agencyShadow = needsAnchor && worldCard && ledgerWorld ? readAgencyShadow(config.dataDir, lifeStartedAt, log) : undefined;
    const observeAgencyShadow = (): void => {
        if (!agencyShadow || !needsAnchor || !worldCard || !ledgerWorld || stopped) return;
        try {
            const at = new Date(worldNow());
            const body = worldCard.herWorld?.body ? bodyAt(worldCard.herWorld.body, worldCard.schedule!, at) : undefined;
            const currentWorld = ledgerWorld.at(worldCard.herWorld!, worldCard.schedule!, at);
            const worldEvents = currentWorld ? agencyShadow.recordWorld(currentWorld, at) : 0;
            const result = agencyShadow.observe(at, regulationAt(needsAt(needsAnchor, ledgerWorld.events(), at), body));
            if (worldEvents || result.events || result.impacts || result.drives || result.candidates) {
                log(`世界影子：事件 ${worldEvents + result.events}，影响 ${result.impacts}，动机 ${result.drives}，候选 ${result.candidates}（只记录，不外发）`);
            }
        } catch (error) {
            log(`世界影子：观察失败（${error instanceof Error ? error.message : String(error)}）`);
        }
    };
    observeAgencyShadow();
    useWorldNeeds(needsAnchor && ledgerWorld ? {
        at: time => {
            try { return needsAt(needsAnchor, ledgerWorld.events(), time); }
            catch (error) {
                log(`她的世界：需要投影失败（${error instanceof Error ? error.message : String(error)}）`);
                return undefined;
            }
        },
    } : undefined);
    lifetime.own('world-needs', () => useWorldNeeds(undefined));
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
            ...(needsAnchor ? {
                needsAnchor,
                humanValuesAt: ({ at, needs }) => {
                    try {
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
    const imageProviders = aiPhotoProvidersFromEnv();
    let aiPhotoSetupFailed = false;
    let aiPhotoRequests: AiPhotoRequestService | undefined;
    if (config.aiPhotos === true && imageProviders.length && config.vision) {
        try {
            const providerPool = createAiPhotoProviderPool({
                dir: join(config.dataDir, 'ai-photo-usage'), providers: imageProviders,
                dailyLimit: Number(process.env.QQBOT_IMAGE_DAILY_LIMIT ?? 4),
                now: () => new Date(worldNow()), log, generate: generateAiPhoto,
            });
            const references = aiPhotoReferenceStore({ file: join(config.dataDir, 'ai-photo-references', 'index.json'), now: () => new Date(worldNow()), log });
            const reviewer = createAiPhotoVisualReviewer(aiPhotoReviewModelFromImageDescriber(prompt => configuredImageDescriber(config, prompt, 'background')!));
            aiPhotoRequests = aiPhotoRequestService({
                store: aiPhotoDrafts,
                stateFile: defaultAiPhotoStateFile(config.dataDir),
                now: () => new Date(worldNow()), log,
                generator: (prompt, context) => qualityCheckedAiPhotoGenerator({
                    context, reviewer, references, generate: value => providerPool.generate(value),
                    maxQualityRegenerations: 1, log,
                })(prompt),
            });
        } catch {
            aiPhotoSetupFailed = true;
            log('AI 照片草稿：初始化失败，已保持关闭（错误正文不写日志）');
        }
    }
    const observeAiPhotoWorld = aiPhotoRequests && sharedWorld && worldCard?.herWorld && worldCard.schedule
        ? () => {
            const at = new Date(worldNow());
            const snapshot = sharedWorld.at(worldCard.herWorld!, worldCard.schedule!, at);
            return snapshot ? aiPhotoRequests.observeWorld(snapshot, at) : Promise.resolve([]);
        }
        : undefined;
    const scanAiPhotoWorld = observeAiPhotoWorld ? () => {
        void observeAiPhotoWorld().catch(() => log('AI 生活照草稿：本轮读取或写入状态失败，跳过；错误正文不写日志'));
    } : undefined;
    log(`AI 生活照草稿：${!config.aiPhotos ? '关（配置 aiPhotos: false）'
        : !imageProviders.length ? '配置已开，但没有可用的本地/主/备用生图服务，不生成'
            : !config.vision ? '配置已开，但没有视觉审查服务；质量门失败关闭，不生成'
                : aiPhotoSetupFailed ? '初始化失败，已保持关闭'
                    : observeAiPhotoWorld ? '开（先过视觉质量门，只生成待审核草稿；不自动审核、不自动发送）'
                        : '配置已开且质量门可用，但没有世界账；只响应 QQ 的当前照片请求'}`);
    if (config.contextTurns) log(`最近几轮 + 要点（ADR 0043）：${config.memory ? `开：原文只放最近 ${config.contextTurns} 轮，更早的在后台整理成要点，没整理好的那一轮照旧最近 80 条；${config.contextContacts.length ? `只对 ${config.contextContacts.join("、")}` : "名单里开了记忆的都开"}` : "配置开了，但长期记忆没开，不开"}`);
    if (config.candidates > 1) log(`挑候选：他难过、说亲密话、收尾时一次生成 ${config.candidates} 个，按规则挑一个（ADR 0041）`);
    if (config.autonomousLife) log(`没人聊天时她一件件过日子：${lifeRunner ? '开（ADR 0040/0045，影子模式：需要值只改行动账，不进提示词）' : '配置开了，但没有带作息和世界的卡，不开'}`);
    if (config.projectChoice) log(`项目选择：${lifeRunner ? '开（ADR 0056：三天内作业可接管空闲安排，状态行与行动账共用）' : '配置开了，但生活执行器没开，不生效'}`);
    // 没人找她的时候也每 ${LIFE_TICK_MS / 60_000} 分钟推一次，过完的时段尽快落账
    scanAiPhotoWorld?.();
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
    // 他发来的表情包也读（ADR 0206 readStickers）：只对名单里的人（和看图一样，图会发到看图模型）；读过的缓存在 stickers/read-cache.json
    const readingStickers = Boolean(config.media && config.readStickers && stickerReader);
    const stickerReading = readingStickers ? { stickerVision: stickerReader!, stickerReads: openStickerReads(join(config.dataDir, 'stickers', 'read-cache.json')) } : {};
    // 「真正听到声音」的实现接上之后，语音旁边会多一段「[声音：…]」（vision/hearing.ts）
    const hearing = config.media ? createHearing() : undefined;
    const reading = config.media ? mediaReading({ ...(media ? { reader: media } : {}), ...(vision ? { vision } : {}), ...(hearing ? { hearing } : {}), ...stickerReading, timeouts: mediaLimits }) : undefined;
    lifetime.own('reading', () => reading?.stop());
    // 看图只给名单里的人（用户 10-10 22:50：开，只对名单里的人）——图会发到看图模型的服务器；名单外的照旧只认图上的字（OCR 在本机）
    const readingUnlisted = config.media && vision ? mediaReading({ ...(media ? { reader: media } : {}), timeouts: mediaLimits }) : reading;
    lifetime.own('reading-unlisted', () => { if (readingUnlisted !== reading) readingUnlisted?.stop(); });
    const readerFor = (qq: number) => (config.contacts.some(c => c.qq === qq) ? reading : readingUnlisted);
    const canRead = [media?.voiceToText && '语音转文字', media?.ocr && '图上的字（OCR）', vision && '看图（只对名单里的人）'].filter(Boolean).join('、');
    log(`听语音、看图：${!config.media ? '关（配置 media: false），照旧「[语音]」「[图片]」'
        : canRead ? `开（${canRead}；语音最多等 ${mediaLimits.voice / 1000} 秒，OCR ${mediaLimits.ocr / 1000} 秒，看图模型 ${mediaLimits.vision / 1000} 秒，读不出来照旧「[语音]」「[图片]」）` : '开，但入口没给 NapCat 的语音转文字和 OCR，照旧「[语音]」「[图片]」'}`);
    log(`看他发的表情包：${readingStickers ? '开（名单里的人；先抄图上的字再说画面，同一张只读一次；读不出来照旧「[动画表情]」）' : config.readStickers ? '开着，但没有看图模型或 media 关着，照旧「[动画表情]」' : '关（配置 readStickers: false），照旧「[动画表情]」'}`);
    const stickerMode = config.stickers ?? 'off';
    const collectingStickers = stickerMode !== 'off' ? stickers : undefined;
    const sendingStickers = stickerMode === 'send' && transport.sendPrivateImage ? collectingStickers : undefined;
    // 小梗（ADR 0114）：解释器的模块（modules/jokes.ts）；派生数据存 <数据目录>/jokes/<QQ>.json
    const jokes = config.jokes ? jokesModule({
        exec, dataDir: config.dataDir, log, contacts: config.contacts, llm: config.llm,
        charName: contact => cardFor(contact.tier).character.name, history: qq => history.load(qq),
    }) : undefined;
    lifetime.own('jokes', () => jokes?.stop?.());
    // 他的口头习惯（ADR 0138）：解释器的模块（modules/idioms.ts）；派生数据存 <数据目录>/idioms/<QQ>.json。
    // 不收进去的词：联系人和角色的名字、卡上的禁用词
    const idioms = config.idioms ? idiomsModule({
        exec, dataDir: config.dataDir, log, contacts: config.contacts, llm: config.llm,
        charName: contact => cardFor(contact.tier).character.name, history: qq => history.load(qq),
        blocked: contact => {
            const character = cardFor(contact.tier).character;
            return [contact.name, character.name, ...config.contacts.map(person => person.name), ...character.banned];
        },
    }) : undefined;
    lifetime.own('idioms', () => idioms?.stop?.());
    // 网络热梗（ADR 0129）：派生数据，存 <数据目录>/memes/memes.json；放进提示词的是下面的模块，刷新在后面（要她的 B 站号）
    const memesFile = memesPath(config.dataDir);
    // 梗百科词库（2026-10-29）：6668 条，只读；文件不在就是没有，不影响自己学的那些
    const memeDict = config.memes ? openMemeDict(join(config.dataDir, 'memes', 'dict.json'), log) : undefined;
    // 真人例子（ADR 0190，默认关）：语料由 scripts/build-exemplars.mjs 从已批准的真人语料生成
    const exemplarCorpus = join(config.dataDir, 'exemplars', 'corpus.jsonl');
    const exemplars = config.exemplars ? loadExemplars(exemplarCorpus, log) : [];
    log(`真人例子：${config.exemplars ? `开（${exemplars.length} 条）` : '关'}${config.exemplars && !exemplars.length ? `——语料没读到（${exemplarCorpus}）` : ''}`);
    if (memeDict) log(`梗百科：词库 ${memeDict.count()} 条（他提到的词查这里，不写进她自己学的库）`);
    // 她自己在 B 站看过的（ADR 0130）：派生数据，存 <数据目录>/watching/watched.json；放进提示词的是下面的模块，“看”在后面（要她的 B 站号）
    const watchedFile = watchedPath(config.dataDir);
    let watchedEntries: readonly Watched[] = config.watching ? loadWatched(watchedFile, log).entries : [];
    // 做判断的都经解释器（ADR 0336 第 4 步）：迁移前的整套逻辑先作为一个「旧逻辑」模块挂上；迁出去的模块逐个加在这里
    // 她自己记下的东西（说话习惯 ADR 0193、日记里发现的自己 0194、读完看完的想法 0204、没想完的问题 0207、她猜的事 0213）的读取：
    // 要在建解释器之前定义（「她自己记下的东西」模块用得到；夜里的反思、想事情的计划器也用同一份）
    const speechNotesNow = config.speechNotes ? speechNotesReader(config.dataDir) : undefined;
    const diaryInsightsNow = config.diaryInsights ? insightsReader(config.dataDir) : undefined;
    const readingTakesNow = config.readingTakes ? takesReader(config.dataDir) : undefined;
    const openQuestionsNow = config.openQuestions ? thoughtsReader(config.dataDir) : undefined;
    // 她猜的事（ADR 0213）：要她那边的世界（世界账）才对得上结果
    const herGuessesNow = config.herGuesses ? guessesReader(config.dataDir) : undefined;
    const deviceOwner = config.contacts.find(c => c.tier === 'boyfriend');
    // 她自己想一想的那几样（ADR 0336 第 6 步）：只有定时任务，App 搭好时开；好些东西（聊天记录、时钟、追求、心境、自我认识的导出）在后面才建，这里给的都是到点再取的函数
    const reflections = reflectionsModule({
        owner: deviceOwner,
        character: tier => cardFor(tier).character,
        contacts: () => config.contacts,
        dataDir: config.dataDir,
        soulDir,
        now: () => clockNow(),
        log,
        stopped: () => stopped,
        generate: temperature => messages => exec.llm({ purpose: 'background', config: { ...config.llm, temperature }, messages }, log),
        history: qq => history.load(qq),
        ...(config.selfPursuits && config.pursuits ? { selfPursuits: { base: () => authorPursuits } } : {}),
        ...(config.speechNotes ? { speechNotes: {
            corpus: () => loadExemplars(join(config.dataDir, 'exemplars', 'corpus.jsonl')),
            feedback: () => recentFeedback(loadFeedback(config.dataDir), clockNow().getTime()),
        } } : {}),
        ...(config.chatReview ? { chatReview: true } : {}),
        ...(config.feelingReview && config.herFeelings ? { feelingReview: {
            existing: () => (lastFeelings && clockNow().getTime() - lastFeelings.at <= 6 * 3_600_000
                ? lastFeelings.felt.filter(item => item.level !== 'faint').map(item => ({ kind: item.kind, cause: item.cause }))
                : []),
        } } : {}),
        ...(config.diaryInsights ? { diaryInsights: { exportInsights: () => exportInsights() } } : {}),
        ...(config.readingTakes ? { readingTakes: { watched: () => loadWatched(watchedPath(config.dataDir), log).entries } } : {}),
        // 没想完的问题用深思的模型；这一处原来就直接调 chatCompletion、没经执行器（照旧，收进执行器另做）
        ...(config.openQuestions ? { openQuestions: { ponder: messages => chatCompletion({ ...deliberateLlm(config.llm, config.deliberateModel), temperature: 0.9 }, messages, { log, purpose: 'background' }) } } : {}),
        ...(config.herGuesses && sharedWorld && worldCard ? { herGuesses: { worldAt: time => sharedWorld.at(worldCard.herWorld!, worldCard.schedule!, time) } } : {}),
    });
    // 她那边的世界的后台维护、DSH 收件箱、口味（ADR 0336 第 6 步）：只有定时任务，App 搭好时开，先后同原来（排在所有 built 的最前面）。
    // 取数器、世界影子、生活执行器都在上面建好了；收件箱、口味在后面才建，到点再取
    const worldUpkeep = worldUpkeepModule({
        ...(weather ? { weather: { every: WEATHER_REFRESH_MS, run: () => void refreshWeather() } } : {}),
        ...(airQuality ? { airQuality: { every: AIR_QUALITY_REFRESH_MS, run: () => void refreshAirQuality() } } : {}),
        ...(daylight ? { daylight: { every: DAYLIGHT_REFRESH_MS, run: () => void refreshDaylight() } } : {}),
        ...(calendar ? { calendar: { every: CALENDAR_REFRESH_MS, run: () => void refreshCalendar() } } : {}),
        ...(worldTransport ? { transport: { every: TRANSPORT_REFRESH_MS, run: () => void refreshTransport() } } : {}),
        ...(agencyShadow ? { agencyShadow: { every: 5 * 60_000, run: observeAgencyShadow } } : {}),
        ...(lifeRunner || observeAiPhotoWorld ? { life: { every: LIFE_TICK_MS, run: () => {
            sharedWorld?.events();
            scanAiPhotoWorld?.();
        } } } : {}),
    });
    const dshInbox = dshInboxModule(dshEnabled && (config.timeline || sharedWorld) ? () => syncDshInboxes() : undefined);
    // 待跟进（连上之后才有计划器）：排在所有 synced 的最前面，同迁移前
    // 群消息的入口（ADR 0336 第 6 步）：群里那一摊在下面才建，事件来了再取
    const groupRoomEntry = groupRoomModule(() => groupChat);
    // 好友申请（ADR 0142）：账号控制面在下面才建，事件来了再取
    const friendRequests = friendRequestsModule({ config, stopped: () => stopped, account: () => account, sendOwnedNotice, log });
    // 他戳她（限流、戳回去的冷却在下面才建，事件来了再取）
    const pokes = pokesModule(() => pokeDeps);
    // 他撤回消息（聊天记录、记忆在下面才建，事件来了再取）
    const recalls = recallsModule(() => ({ config, stopped: () => stopped, chatHistory, hasMemory: Boolean(memory), observeRecalledMemory, syncRecalledMemory, incomingFailure, log }));
    const followUps = followUpsModule(() => syncFollowUps(), () => planners.size > 0, MEMORY_SYNC_MS);
    const tastesJob = tastesModule(config.tastes ? () => reflectTastes() : undefined);
    // 长期记忆同步、「她现在在干嘛」导出、她留的话（ADR 0336 第 6 步）：只有定时任务，App 搭好时开，先后同原来（在她自己想一想的那几样之前）；做的事都在后面才建，到点再取
    const memorySync = memorySyncModule(config.memory ? () => syncMemory() : undefined, MEMORY_SYNC_MS);
    const nowExport = nowExportModule(() => exportNow(), NOW_REFRESH_MS);
    const outbox = outboxModule(() => outboxTick());
    // 做梦那一拍、走开前说一声、DSH 状态快照（ADR 0336 第 6 步）：同样只有定时任务，App 搭好时开，先后同原来（夜里那几样之后）。
    // 心境、长期记忆、危机状态、聊天记录、导出函数都在后面才建：到点再取
    const dreams = dreamsModule(deviceOwner && config.herFeelings ? dreamJobs({
        owner: deviceOwner,
        character: tier => cardFor(tier).character,
        dataDir: config.dataDir,
        soulDir,
        now: () => clockNow(),
        log,
        stopped: () => stopped,
        generate: temperature => messages => exec.llm({ purpose: 'background', config: { ...forExtraction(config.llm), temperature }, messages }, log),
        lastFeelings: () => lastFeelings,
        rememberSelfNote: (contact, text, kind) => memory?.rememberSelfNote(contact, text, kind),
        ...(sharedWorld && worldCard?.herWorld && worldCard.schedule ? { worldAt: (at: Date) => sharedWorld.at(worldCard.herWorld!, worldCard.schedule!, at) } : {}),
    }).tick : undefined);
    const leaveNote = leaveNoteModule(config.proactive !== 'off' && deviceOwner && lifeRunner ? leaveAnnouncer({
        owner: deviceOwner,
        ...(sharedWorld && worldCard?.herWorld && worldCard.schedule ? { worldAt: (at: Date) => sharedWorld.at(worldCard.herWorld!, worldCard.schedule!, at) } : {}),
        paused: (qq, now) => crisisState.pausedAt(qq, now),
        history: qq => chatHistory.load(qq),
        append: (qq, message) => chatHistory.append(qq, message),
        send: (qq, text) => transport.sendPrivateText(qq, text),
        generate: messages => exec.llm({ purpose: 'background', config: { ...config.llm, temperature: 0.9 }, messages }, log),
        log,
        stopped: () => stopped,
    }).check : undefined);
    const dshStateExport = dshStateModule(dshEnabled ? () => exportDshState() : undefined, NOW_REFRESH_MS);
    // 一轮回复的模块（ADR 0336 第 6 步）：和模拟器同一份接线（platform/turn-modules.ts），先后在那里定；这里只按配置给选项。
    // 好些东西（聊天记录、答应的事、长期记忆、设备服务、计划器……）在后面才建：这里给的都是用到时再取的函数，挂不挂只看配置
    const turnModules = buildTurnModules({
        log,
        now: () => exec.now(),
        history: qq => history.load(qq),
        contacts: () => config.contacts,
        worldState: () => sharedWorld ?? undefined,
        appointmentsAt: at => promises?.appointmentsAt?.(at),
        promises: () => promises ?? undefined,
        mediaDiscovery: () => ({
            ...(photos ? { photos: discoverPhotos } : {}),
            ...(photos && foodSource && config.foodPhotos ? { food: discoverFoodPhotos } : {}),
            ...(collectingStickers ? { stickers: discoverStickers } : {}),
        }),
        syncedJobs: {
            ...(config.weeklyReport ? { weeklyReport: () => checkWeeklyReport() } : {}),
            ...(config.watching ? { watching: () => { void watchJob(); } } : {}),
            ...(config.biliFeed && config.biliFeed !== 'off' ? { feed: () => { void feedJob(); } } : {}),
            ...(config.memes ? { memes: () => { void refreshMemeJob(); } } : {}),
        },
        schedule: config.schedule,
        herDays: config.herDays,
        // 危机信号（ADR 0068）和小别扭 / 和好的起因（ADR 0074，配置 grievance）：assess 的最前面，意图阶梯和后面的判断都读
        grievance: config.grievance,
        shortReplies: config.shortReplies,
        // 时间块（ADR 0004 / 0105）：断网很久才回那一句跟着 lagTail
        lagTail: config.lagTail,
        // 她这几天拍照修图（配置 lifeInPrompt，要有生活执行器）
        lifeInPrompt: Boolean(config.lifeInPrompt && lifeRunner),
        // 意图阶梯（ADR 0019 起）：开关是它的选项
        intent: {
            ...(config.herNo ? { refuse: true } : {}), ...(config.afterNo ? { afterNo: true } : {}), ...(config.jealousy ? { jealous: true } : {}), ...(config.curious ? { curious: true } : {}),
            ...(config.everydayLife ? { everydayLife: true } : {}), ...(config.pursuits ? { pursuits: true } : {}),
        },
        // 形状控制（ADR 0091，配置 shape 及各分项）：shapeAll（ADR 0220）App 从来没接配置，只有模拟器用；分项同给联系人流水线的（都要 shape 开着）
        shape: {
            shape: config.shape, shapeAgenda: config.shape && config.shapeAgenda, shapeFiller: config.shape && config.shapeFiller, shapeFeel: config.shape && config.shapeFeel,
            shapeSplit: config.shape && config.shapeSplit, shapeAsk: config.shape && config.shapeAsk, shapeLong: config.shape && config.shapeLong,
        },
        // 她此刻（她那边、身体、状态行）的另几样
        herNow: {
            ...(config.projectChoice && lifeRunner ? { projectChoice: true } : {}),
            ...(config.realNights ? { realNights: true } : {}), ...(config.innerLife ? { herPlan: (at: Date) => herPlanActivities(config.dataDir, at, log) } : {}),
        },
        // 她自己记下的东西（DSH：说话习惯、聊天回顾、日记里发现的自己、读完看完的想法、没想完的问题、她猜的事）：各自的开关开着才给读取；只给男朋友档
        herNotes: {
            ...(speechNotesNow ? { speechNotes: speechNotesNow } : {}),
            ...(config.chatReview ? { chatReview: chatReviewReader(config.dataDir) } : {}),
            ...(diaryInsightsNow ? { diaryInsights: diaryInsightsNow } : {}),
            ...(readingTakesNow ? { readingTakes: readingTakesNow } : {}),
            ...(openQuestionsNow ? { openQuestions: openQuestionsNow } : {}),
            ...(herGuessesNow ? { herGuesses: herGuessesNow } : {}),
        },
        // 她可以在这台电脑上跑命令（DSH 10-30）：上一轮的命令结果（读了就清掉）和「可以跑命令」那一行；只给男朋友档
        shell: {
            noteOf: contact => {
                const note = shellNotes.get(contact.qq);
                if (note) shellNotes.delete(contact.qq);
                return note;
            },
            // 她写的 <<执行：命令>>（2026-10-30 用户：把最高权限给她）：标记不发出去，命令后台跑，结果留给下一轮
            commands: {
                lookedRecently: contact => (Date.now() - (webTurns.get(contact.qq) ?? 0)) < 3 * 60_000,
                setNote: (contact, note) => { shellNotes.set(contact.qq, note); },
                run: command => exec.process.shell(command, { cwd: process.env.USERPROFILE }),
                audit: run => auditShell(config.dataDir, run),
                log,
            },
        },
        // 她想查才查（<<查：…>>）：总是挂（摘标记和开关无关）；开了长期记忆和 selfDirectedMemory 才真的去查。memory 在后面才建，查的时候现取
        reviewPull: { ...(config.memory && config.selfDirectedMemory ? { recall: async (contact: Contact, query: string) => {
            const recalled = await memory!.recallPull(contact, query, new Date(), config.contacts);
            if (!recalled || !deviceOwner || contact.qq !== deviceOwner.qq) return recalled;
            return attachMatchingMemoryReviews(recalled, readMemoryReviews(config.dataDir).reviews);
        }, finishReview: (contact, offers, resolution) => {
            if (contact.qq !== deviceOwner?.qq) return;
            finishMemoryReviews(config.dataDir, offers, resolution, clockNow().getTime());
        } } : {}) },
        // 她自己决定记不记（selfDirectedMemory，DSH 10-30 / 10-31）：「记忆由你自己决定」、理解偏过、他最近的事
        ...(config.selfDirectedMemory ? { selfMemory: {
            understanding: hisWords => understandingLine(config.dataDir, hisWords),
            immediateCorrection: (contact, hisWords) => deviceOwner && contact.qq === deviceOwner.qq ? correctionReplyLine(hisWords) : undefined,
            traces: () => tracesLine(config.dataDir),
        } } : {}),
        // 工作模式的三行（DSH 10-29 / 10-30）：按他现在的状态放其中一行；只给男朋友档
        workMode: {
            modeOf: contact => readWorkMode(config.dataDir, contact.qq),
            // 她回复里的 <<同意工作>> / <<拒绝工作>> / <<用电脑>>：发出去之前摘掉、改状态；动电脑的活在后台干，干完把结果单独发回去
            markers: {
                setMode: (contact, mode) => setWorkMode(config.dataDir, contact.qq, mode),
                refused: reason => addRefusal(reason),
                taskOf: contact => lastUserText.get(contact.qq),
                // 她自己判断这条要动电脑（2026-10-29）：当轮交给 dsh 干，干完把结果单独发回去。不落工作模式，所以他不用发 /dsh，也不用事后 /QQ 切回来
                // 干完的结果也进聊天记录（和 /dsh 工作模式一样，ADR 0176），活记在他自己的 bank 里；没干成那句也记（work-handoff.ts）
                start: (contact, task) => work.handOff(contact.qq, task, work.recentFor(contact.qq), () => memory?.bankId(contact), '她判断要动电脑、没干成'),
                notTyped: () => tellOwner(WANTED_BUT_NOT_TYPED_NOTICE),
                log,
            },
        },
        // 她自己记的（<<记住>> / <<日记>> / <<私密>>）：发出去之前摘掉、该记的记下；摘标记和开关无关，总是挂。memory 在后面才建，记的时候现取
        selfNotes: {
            keepPrivate: text => { appendPrivate(text); },
            ...(config.diaryInsights ? { keepDiary: (text: string) => { recordSelfDiary(config.dataDir, text, clockNow().getTime()); } } : {}),
            remember: (contact, text, kind) => memory?.rememberSelfNote(contact, text, kind),
            ...(config.selfDirectedMemory ? { reviewMemory: (contact, cue) => {
                if (deviceOwner && contact.qq === deviceOwner.qq && config.memory) recordMemoryReview(config.dataDir, cue, clockNow().getTime());
            } } : {}),
            log,
        },
        // 她在本机的那一份（DSH 的灵魂目录）：心里的线头、拒绝过的、评价、「你现在的生活」、首轮铺底；只给男朋友档，每一轮现读
        soul: {
            selfThread: (): string | undefined => {
                try {
                    const journal = selfThreadLine(selfThread(exec.files.read(join(soulDir(), 'JOURNAL.md'))));
                    let doing: string | undefined;
                    try {
                        const life = JSON.parse(exec.files.read(join(soulDir(), 'LIFE.json'))) as { events?: { text?: string }[] };
                        const own = (life.events ?? []).map(e => String(e.text ?? '')).filter(t => t && !t.includes('跟我说') && !t.startsWith('新的一天')).slice(-2);
                        if (own.length) doing = `[你这两天自己在做的：${own.map(t => t.replace(/^我在/, '')).join('；').slice(0, 80)}]`;
                    } catch { /* 没有 LIFE.json 就只有日记那一段 */ }
                    return [journal, doing].filter(Boolean).join(String.fromCharCode(10)) || undefined;
                } catch { return undefined; }
            },
            refusals: () => recentRefusals(),
            rating: () => ratingSummary(),
            // 「你现在的生活」（NOW.md）的「最近」一行带着他说过的话的原句（前 40 字）和关系状态（「还在生他的气……」）：
            // 只给男朋友档，别的联系人的提示词里不能有他的话（ADR 0020 披露分级；10-29 复核）
            // NOW.md 现在由 QQ 自己渲染（exportNow），内容就是时间块里的那一句：
            // 再注入一次就是重复，所以带 generated-at 的版本不再往回读（任务书 §2）。
            life: () => {
                try {
                    const text = exec.files.read(join(soulDir(), 'NOW.md')).trim();
                    return text.includes('generated-at:') ? undefined : text;
                } catch { return undefined; }
            },
            // 首轮铺底：他走了 ≥6 小时回来，第一轮带上她自己写的日记；挂着 lifeInPrompt，不新增开关
            ...(config.lifeInPrompt ? {
                wake: (contact: Contact): string | undefined => {
                    try {
                        // 刚收的这条已经进聊天记录了，算间隔要拿它之前的那条（5 分钟内的都当成本轮）
                        const cutoff = Date.now() - 5 * 60_000;
                        const older = history.load(contact.qq).filter(message => Date.parse(message.time) < cutoff);
                        const journal = exec.files.read(join(soulDir(), 'JOURNAL.md'));
                        return wakeBackfill({ lastAt: older.at(-1)?.time, now: Date.now(), journal, log });
                    } catch { return undefined; }
                },
            } : {}),
        },
        // 她学的时候没想通的地方（DSH 10-31）：两天内存下的那个问题，想问就问他；只给男朋友档，危机、只想一想时不放
        learningQuestion: () => questionLine(loadQuestion(config.dataDir), clockNow().getTime()),
        // 真人例子（ADR 0190，配置 exemplars）：语料上面启动时读过一次，有条目才挂
        exemplars,
        // 她最近心里在想什么（ADR 0101，配置 innerLife）：念头是主动消息的计划器想的，计划器在后面才建，每次现取
        ...(config.innerLife ? { innerLine: (contact: Contact) => planners.get(contact.qq)?.innerLine() } : {}),
        // 她能替他操作的设备的菜单（ADR 0148，配置 deviceControl）：名单里有男朋友档才有设备控制（同下面的 deviceOwner）；服务是异步起的，起来之前菜单是空串，每轮现取
        ...(config.deviceControl !== 'off' && config.contacts.some(c => c.tier === 'boyfriend')
            ? { devices: { menu: () => devicesHost.service()?.control.menu() ?? '', allowed: (contact: Contact) => contact.tier === 'boyfriend' } }
            : {}),
        // 他的请求等她点头（2026-10-30）：他发「/看屏幕」「/摄像头」时下面的 pendingAsk 先记下来，她写 <<同意>> 才做；只给男朋友档、过期的不算，每轮现取
        consent: {
            ask: contact => {
                if (contact.tier !== 'boyfriend') return undefined;
                const pending = pendingAsk.get(contact.qq);
                if (!pending || askExpired(pending.at, Date.now())) return undefined;
                return askLine(pending.label, Math.floor((Date.now() - pending.at) / 60_000));
            },
            // 她写了 <<同意>> 就做，写了 <<拒绝：原因>> 就作罢（2026-10-30）
            answer: {
                withdraw: contact => pendingAsk.delete(contact.qq),
                tellRefusal: (contact, reason) => { void transport.sendPrivateText(contact.qq, `（她说：${reason || '这个不想'}）`).catch(() => {}); },
                claim: contact => {
                    const userId = contact.qq;
                    const pending = pendingAsk.get(userId);
                    if (!pending || askExpired(pending.at, Date.now())) return undefined;
                    pendingAsk.delete(userId);
                    return {
                        label: pending.label,
                        // 停止后不再发晚到的结果；已交给 transport 的回复由 App 持有到成功或失败确认，之后才释放租约（ADR 0148）
                        run: () => {
                            void pending.run().then(async handled => {
                                if (stopped) return;
                                if (handled.kind === 'reply' && handled.text) {
                                    const text = handled.text;
                                    await sendOwnedNotice(() => transport.sendPrivateText(userId, text), () => {},
                                        error => log(`[${userId}] 她答应了，结果没发出去：${error instanceof Error ? error.message : String(error)}`));
                                }
                            }).catch(error => log(`[${userId}] 她答应了但没做成：${error instanceof Error ? error.message : String(error)}`));
                        },
                    };
                },
                log,
            },
        },
        // 引用回复（ADR 0136，配置 quoteReply）：contribute 时挑出要引用的那条、写回 turn.facts.quote，旧逻辑发送时引用它
        ...(config.quoteReply ? { quote: {} } : {}),
        // 逐条事实检查（ADR 0137 / 0203）：factCheck 是 log / fix 时挂；审稿经执行器，同一个模型、温度 0，日志用这个联系人的（ctx.log 已带 [QQ]）
        ...(config.factCheck !== 'off' ? { factCheck: {
            mode: config.factCheck, ...(config.factHim ? { aboutHim: true } : {}),
            audit: (messages, scopedLog) => exec.llm({ purpose: 'chat', config: { ...forExtraction(config.llm), temperature: 0 }, messages }, scopedLog),
        } } : {}),
        // 话说到一半（ADR 0141）：跟着 speechCheck
        speechCheck: config.speechCheck,
        // 挑候选（ADR 0041，配置 candidates 大于 1 才挂）：说话的毛病跟着 speechCheck / tailCap
        ...(config.candidates > 1 ? { candidates: { count: config.candidates, speechCheck: config.speechCheck, tailCap: config.tailCap } } : {}),
        // 连续性（ADR 0157–0163）、群里最近的事、真人数值和人格成长层（ADR 0222 / 0251）：facts 由联系人流水线原位取，没有开关，总是挂
        continuity: true,
        group: true,
        humanState: true,
        // 发出去之前的修饰（ADR 0336 第 11 步）：质感（ADR 0131，配置 texture）跟着开关挂；打错字总是挂
        texture: config.texture,
        // 关系阶段（ADR 0113）、陪玩（ADR 0111）、被打断（ADR 0115）：跟着各自的开关
        relationship: config.relationship,
        together: config.together,
        interruptions: config.interruptions,
        // 小梗（ADR 0114）、口头习惯（ADR 0138）：上面建好的那两个（带定时抽取和收尾）
        ...(jokes ? { jokes } : {}),
        ...(idioms ? { idioms } : {}),
        // 网络热梗（ADR 0129）：每一轮从库里现读（作者可以在两轮之间改 / 删，别用改之前的快照），停下之后不再读；从热榜学新梗还在下面（要她的 B 站号）
        ...(config.memes ? { memes: () => (stopped ? [] : loadMemes(memesFile, log).entries) } : {}),
        // 她看视频（ADR 0130）：他问起时放她真看过的两条；用的是内存里那份（她看完一个就换新的），每次现取
        ...(config.watching ? { watched: () => watchedEntries } : {}),
        // 梗百科（DSH 10-29）：要在热梗之后（读 facts.meme）
        ...(memeDict ? { memeDict } : {}),
    });
    // 做判断的都经解释器（ADR 0336 第 4 步）：「旧逻辑」那一个（事件分发）在最前，后面是一轮回复的模块，最后是只有定时任务的
    const interpreter = createInterpreter({
        modules: [{
            id: 'app-legacy',
            on: {
                connected: ({ selfId }) => legacy.connected(selfId),
                message: ({ event }) => legacy.receive(event),
            },
        }, groupRoomEntry, friendRequests, pokes, recalls, followUps, ...turnModules, worldUpkeep, dshInbox, tastesJob, memorySync, nowExport, outbox, reflections, dreams, leaveNote, dshStateExport],
        exec,
    });
    // 解释器接手各模块的停（关定时任务、拒新工作；小梗、口头习惯的收尾在里面）
    lifetime.handOver(['jokes', 'idioms'], 'modules', () => interpreter.stop());
    // 照片货架（ADR 0109）：作者放进去的照片；没有照片就什么都不做
    const photoDiscovery = new AbortController();
    lifetime.own('photo-discovery', () => photoDiscovery.abort());
    const photos = config.photos && transport.sendPrivateImage ? photoShelf({ dir: join(config.dataDir, 'photos'), log, signal: photoDiscovery.signal, ...(photoSource ? { source: photoSource } : {}), ...(config.foodPhotos && foodSource ? { foodSource } : {}) }) : undefined;
    if (config.photos) {
        const have = photos?.status();
        log(photos ? `照片货架：开（本地 ${have!.count} 张：猫 ${have!.byKind.cat}、风景 ${have!.byKind.view}、她的片子 ${have!.byKind.work}；${photoSource ? '她自己去网上找（CC0 / 公有领域，看图把关，每 6 小时一次）' : '网络来源没开（看图没配置），只有手动加的'}；只对男朋友档；没有照片就什么都不做）` : '照片货架：配置开着，但发图片的通道没准备好，不工作');
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
    // 模型线路：换线路（免费网关）时要在日志里看得见走的是哪条
    log(`模型线路：${config.llm.baseUrl.replace(/\/+$/, '')} / ${config.llm.model}${config.llm.fallback ? `（备用：${config.llm.fallback.baseUrl.replace(/\/+$/, '')}${config.llm.fallback.model ? ` / ${config.llm.fallback.model}` : ''}）` : ''}`);
    // 目录锁已在构造入口获取，任何状态初始化都位于锁内。
    // 心跳（任务书 T3b）：每分钟写 heartbeat.json（只有时间和进程号），ops/heartbeat-watch-cli.ts 看它多久没更新
    let connectedAt: Date | undefined;
    let lastMessageAt: Date | undefined;
    const heartbeat = startHeartbeat({ dataDir: config.dataDir, log, state: () => ({ connectedAt, lastMessageAt }) });
    lifetime.own('heartbeat', () => heartbeat.stop());

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

    // 她对他的电脑和手机的有限控制（ADR 0148，配置 deviceControl）：只给男朋友档；服务的起停在 device-host.ts（ADR 0336 第 6 步），
    // 起来之前她的菜单是空的、回复里的令牌只摘不用
    const devicesHost = deviceHost({ stopped: () => stopped, log });

    // ───────── 连续性（ADR 0157–0163）：设定账本 / 记忆账本 / 时间线 / 搜索 / 休眠 / 口味 / 认识的人 ─────────
    // 都是默认关的开关；账本和时间线只写数据目录里的小文件。出错一律只记日志，不影响聊天
    // 这个文件在 packages/bot/src/platform/：往上四层才是仓库根（模块目录重构前在 src/ 下，三层）
    const repoRoot = repoRootOverride ?? resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
    const clockNow = () => new Date(exec.now());
    /** 连上之后发给用户的运维提示（设定账本验不过、有没登记原因的改动……）：以「（」开头的纯文字，不进她的聊天记录 */
    const ownerNotices: string[] = [];
    const timeline = config.timeline ? new Timeline(join(config.dataDir, 'timeline.jsonl'), clockNow) : undefined;
    const noteTimeline = (entry: Parameters<Timeline['record']>[0]): void => {
        try { timeline?.record(entry); } catch (error) { log(`时间线：写不进去（${error instanceof Error ? error.message : String(error)}）`); }
    };
    // DSH 只追加脱敏收件箱；QQ 开着 DSH 时用同一条时间线 / 世界账落地，关掉时不启动同步定时器。
    const syncDshInboxes = (): void => {
        if (!dshEnabled) return;
        const now = new Date(worldNow());
        try {
            if (timeline) {
                const count = consumeDshTimelineInbox(
                    join(soulDir(), 'timeline-inbox.jsonl'),
                    join(config.dataDir, 'memory', 'dsh-timeline-inbox.json'),
                    now, timeline, log,
                );
                if (count) log(`DSH：收进时间线 ${count} 条`);
            }
            if (sharedWorld) {
                const count = consumeDshWorldInbox(
                    join(soulDir(), 'world-inbox.jsonl'),
                    join(config.dataDir, 'world', 'dsh-world-inbox.json'),
                    now, sharedWorld, log,
                );
                if (count) log(`DSH：收进世界事件 ${count} 条`);
            }
        } catch (error) {
            log(`DSH：收件箱同步失败（${error instanceof Error ? error.message : String(error)}）`);
        }
    };
    // 之后每 30 秒再收一次：由 dsh-inbox 模块声明（ADR 0336 第 6 步，App 搭好时开）
    if (dshEnabled && (timeline || sharedWorld)) syncDshInboxes();
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
    const askSmall = (messages: { role: 'system' | 'user'; content: string }[]): Promise<string> => (exec.llm({ purpose: 'background', config: quietLlm, messages }, log));
    // 语义路由（ADR 0202）：深思开着、而且配置了 depthRouting 才建；小调用不开思考、温度 0、几十个 token，超时由 createTurnWeigher 管
    const turnWeigher = config.depthRouting && config.deliberate
        ? createTurnWeigher({
            ask: messages => exec.llm({ purpose: 'chat', config: { ...config.llm, temperature: 0, maxTokens: 80, timeoutMs: WEIGH_TIMEOUT_MS, extraBody: { ...llmExtra, thinking: { type: 'disabled' } } }, messages }, log),
            log, now: () => clockNow().getTime(),
        })
        : undefined;
    if (config.depthRouting && !config.deliberate) log('语义路由：depthRouting 开着，但 deliberate 没开——没有地方放，不起作用');
    const web = config.webLookup !== 'off'
        ? new WebLookup({
            mode: config.webLookup, dataDir: config.dataDir, ask: askSmall, now: clockNow,
            log: message => { if (!stopped && !passiveLifetime.signal.aborted) log(message); },
            ...(readWebSecrets(join(config.dataDir, 'secrets', 'web.json')) ? { secrets: readWebSecrets(join(config.dataDir, 'secrets', 'web.json'))! } : {}),
            onDone: e => { if (!stopped && !passiveLifetime.signal.aborted) noteTimeline({ channel: 'web', kind: e.kind, summary: e.summary, ok: e.ok }); },
        })
        : undefined;
    const recentImage = new Map<number, { url: string; at: number }>();
    const imageRecognizer = web && (imageRecognition ?? (config.vision ? configuredImageDescriber(config,
        '用户刚让你认这张图。请直接看原图判断动漫人物可能是谁；考虑作品角色、品牌和 AI 产品的拟人形象。只给最有依据的候选及可见依据，明确标为猜测；线索不足就说认不准。不要辨认真实人物。限 80 字。', 'chat') : undefined));
    const imageSearcher = web && (imageSearch ?? (config.vision ? configuredImageDescriber(config,
        '用户请你搜索这张图。请用搜图核对人物身份、画师或作品，并比对图中发色、服饰和物品。只用两句话给出候选和核对依据；对不上就说不确定，不要把搜索所得说成原本就知道。', 'chat', true) : undefined));
    const tastesLog: Log = message => { if (!stopped) log(message); };
    const tastes = config.tastes
        ? new Tastes({
            dataDir: config.dataDir, now: clockNow, log: tastesLog,
            experiences: () => [
                ...experiencesFromLife(readLifeEvents(join(config.dataDir, 'world', 'events.json'), () => undefined)),
                ...experiencesFromWatched(loadWatched(watchedPath(config.dataDir)).entries),
            ],
            ask: (system, user) => {
                if (stopped) return Promise.resolve('[]');
                return exec.llm({ purpose: 'background', config: { ...forExtraction(config.llm), temperature: 0 }, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }, tastesLog);
            },
            onChange: (taste, kind) => { if (!stopped) noteTimeline({ channel: 'tastes', kind, summary: `${kind === 'new' ? '发现自己' : '重新看了看自己'}${taste.stance === 'like' ? '喜欢' : '不太喜欢'}${taste.name}` }); },
        })
        : undefined;
    lifetime.own('tastes', () => tastes?.stop());
    const reflectTastes = () => { if (!stopped) void tastes?.reflect().catch(error => tastesLog(`口味：出错（${error instanceof Error ? error.message : String(error)}）`)); };
    // 回头看一天最多一次（tastes.ts 里有间隔）：每小时来看一眼要不要看，启动两分钟后先看一次——由 tastes 模块声明（ADR 0336 第 6 步，App 搭好时开）
    const acquaintances = config.acquaintances ? new Acquaintances({ dataDir: config.dataDir, now: clockNow, log }) : undefined;
    const dormancy = config.dormancy && deviceOwner ? new Dormancy({ dataDir: config.dataDir, repoRoot, now: clockNow, gitHead: () => exec.process.gitHead(repoRoot), log }) : undefined;
    if (config.dormancy && !deviceOwner) log('休眠：开着，但名单里没有男朋友档的联系人，不启动');
    if (dormancy?.isDormant()) log(`休眠：${dormancy.status()}`);
    const decorateAccounts = (source: () => Promise<BiliAccount | undefined>): (() => Promise<BiliAccount | undefined>) => (!timeline && !acquaintances ? source : async () => {
        const account = await source();
        if (!account) return account;
        const recorded = timeline ? timelineAccount(account, timeline, { acceptRead: () => !stopped }) : account;
        return acquaintances ? acquaintancesAccount(recorded, acquaintances) : recorded;
    });
    const withTimeout = <T,>(promise: Promise<T>, ms: number): Promise<T | undefined> => new Promise(resolveTimeout => {
        const timer = exec.after(() => resolveTimeout(undefined), ms);
        timer.unref?.();
        promise.then(value => { exec.cancel(timer); resolveTimeout(value); }, () => { exec.cancel(timer); resolveTimeout(undefined); });
    });
    const untilCancelled = <T,>(promise: Promise<T>, signal: AbortSignal): Promise<T | undefined> => new Promise(resolve => {
        if (signal.aborted) { resolve(undefined); return; }
        let settled = false;
        const finish = (value: T | undefined) => {
            if (settled) return;
            settled = true;
            signal.removeEventListener('abort', cancel);
            resolve(value);
        };
        const cancel = () => finish(undefined);
        signal.addEventListener('abort', cancel, { once: true });
        promise.then(value => finish(value), () => finish(undefined));
    });
    /** 给每个联系人流水线的一组“连续性”提示词行（ADR 0157–0163）：只给男朋友档 */
    const continuity: ContactPipelineOptions['continuity'] | undefined = identity || timeline || web || tastes || acquaintances || config.silenceNotice
        ? async ({ contact, said, initiating, now }) => {
            if (contact.tier !== 'boyfriend') return [];
            const lines: string[] = [];
            if (config.silenceNotice && !initiating && contact.qq === deviceOwner?.qq) {
                const cue = silenceReplyCue(said, history.load(contact.qq), recentSilence(config.dataDir, contact.qq), now.getTime());
                if (cue) lines.push(cue);
            }
            const note = contact.knowsBot ? identity?.promptLine() : undefined;
            if (note) { lines.push(note); identity!.markTold(); }
            let looked: string | undefined;
            if (web && !initiating && said.trim() && !passiveLifetime.signal.aborted) {
                // 25 秒只限制这一轮 continuity；超时产生的孤儿任务也必须拿到取消信号，
                // 否则它会在替代实例接管目录后继续摘录、写时间线和缓存。
                const deadline = new AbortController();
                const carry = searchCarry(said, chatHistory.load(contact.qq), clockNow());
                const image = recentImage.get(contact.qq);
                const hasOriginal = image && clockNow().getTime() - image.at <= 15 * 60_000 && /^\[图片：/.test(carry ?? '');
                const imagePlan = hasOriginal ? planExplicit(said, carry) : undefined;
                const wantsImageSearch = hasOriginal && !planExplicit(said) && imagePlan?.kind === 'search' && !searchNeedsClarification(said, imagePlan, carry);
                const wantsImageRecognition = hasOriginal && /(?:认|识别|是谁|叫什么|哪个角色)/.test(said) && /(?:这个|这张|这幅|它|刚才那)/.test(said);
                const timer = exec.after(() => deadline.abort(), wantsImageSearch ? 55_000 : 25_000);
                timer.unref?.();
                const signal = AbortSignal.any([passiveLifetime.signal, deadline.signal]);
                // 上一轮他的话：像「你看看能不能搜到」这种话里没有检索对象，得靠它（2026-11-15）
                try {
                    try {
                        if (wantsImageSearch && imageSearcher) {
                            const found = await untilCancelled(imageSearcher.describe({ url: image!.url, signal }), signal);
                            if (found?.startsWith('已搜图：')) looked = `[你刚用原图搜过并核对：${found.slice(4, 450)}。这是搜索所得的候选，不是你原本认识的；只在特征对得上时说名字，否则如实说不确定。]`;
                        } else if (wantsImageRecognition && imageRecognizer) {
                            const guessed = await untilCancelled(imageRecognizer.describe({ url: image!.url, signal }), signal);
                            if (guessed?.trim()) looked = `[你刚重新看了他发的原图：${guessed.slice(0, 300)}。这是看图猜测，不能装作已经确认；说不准就说不准。]`;
                        }
                    } catch (error) {
                        if (!signal.aborted) log(`看原图辨认或搜图失败：${error instanceof Error ? error.name : '未知错误'}，退回文字检索`);
                    }
                    if (!looked && !signal.aborted) looked = await untilCancelled(web.line(said, signal, carry), signal);
                }
                finally { exec.cancel(timer); }
                // deadline 只是不放 Web 资料，仍照常回复；App stop 则终止整次提示词构建，
                // 避免孤儿 continuity 在目录租约释放后继续写日志或派模型。
                if (passiveLifetime.signal.aborted) throw new DOMException('App 已停止', 'AbortError');
            }
            if (looked) { lines.push(looked); webTurns.set(contact.qq, Date.now()); }
            for (const line of [timeline?.promptLine(now), tastes?.promptLine(), acquaintances?.promptLine(now)]) if (line) lines.push(line);
            return lines;
        }
        : undefined;
    const deviceHooks: NonNullable<ContactPipelineOptions['devices']> | undefined = config.deviceControl !== 'off' && deviceOwner
        ? {
            parse: reply => devicesHost.service()?.control.parse(reply) ?? { reply: stripDeviceTokens(reply), proposals: [], rejected: [] },
            // 发送前登记选中那一稿的设备指令（联系人流水线的 beforeSend）：经执行器的 device 动作
            commit: parsed => exec.run({ kind: 'device', parsed }),
        }
        : undefined;
    if (config.deviceControl !== 'off' && !deviceOwner) log('设备控制：开着，但名单里没有男朋友档的联系人，不启动');
    if (deviceHooks && deviceOwner) devicesHost.start({ config, owner: deviceOwner, timeline, startDevices, sendText: (qq, text) => transport.sendPrivateText(qq, text) });
    lifetime.own('devices', () => devicesHost.stop());

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
            ...(deviceOwner ? { privateContact: deviceOwner } : {}),
            reconcile: config.memoryReconcile,
        })
        : undefined;
    lifetime.own('memory', () => memory?.stop());
    log(memory
        ? `长期记忆：Hindsight ${config.memory!.baseUrl}（名单里的联系人；公共记忆库 ${memory.commonBankId()}，陌生人档不写不查）`
        : '长期记忆：未启用（配置里没有 memory）');
    // 同一个她（ADR 0176）：把他的 bank 告诉 DSH 桌面上的她，让两边读写同一份记忆
    try {
        if (memory && deviceOwner) {
            const crossFiles = config.crossRecent ? { chatFile: join(config.dataDir, 'chats', `${deviceOwner.qq}.jsonl`), recalledFile: join(config.dataDir, 'chats', `${deviceOwner.qq}.recalled.json`), desktopFile: desktopRecentPath(join(config.dataDir, 'memory')) } : {};
            if (writeOwnerBank(join(config.dataDir, 'memory'), { ownerBank: memory.bankId(deviceOwner), commonBank: memory.commonBankId(), legacyBank: config.memory!.bankPrefix, ...crossFiles })) log(`同一个她：他的记忆 bank 写进 memory/owner-bank.json（DSH 桌面上的她读它）${config.crossRecent ? '；两边互读最近几轮：开' : ''}`);
        } else if (revokeOwnerBank(join(config.dataDir, 'memory'), memory ? 'owner_missing' : 'memory_disabled')) {
            log(`同一个她：owner-bank.json 已撤销（${memory ? '没有设备 owner' : '长期记忆已关闭'}）`);
        }
    } catch (error) { log(`同一个她：owner-bank.json 没更新成（${error instanceof Error ? error.message : String(error)}）`); }
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
            extract: messages => (exec.llm({ purpose: 'background', config: forExtraction(config.llm), messages }, log)),
            dir: join(config.dataDir, 'promises'),
            log,
            ...(pipeline?.now ? { now: pipeline.now } : {}),
            ...(sharedWorld ? { onWorldActions: sharedWorld.record } : {}),
        })
        : undefined;
    lifetime.own('promises', () => promises?.stop());
    loadAppointments = promises?.appointmentsBetween;
    appointmentsAvailable = () => promises?.available() ?? true;
    // 约定来源已经接上以后再第一次推进生活；否则启动瞬间会把赴约时段排成普通休闲。
    noteHerDay?.(new Date(exec.now()));
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
            sourceSince: contact => tierRecord.since(contact.qq)?.toISOString(),
            history,
            memory,
            ...(promises ? { plans: promises.plansOn } : {}),
            generate: messages => (exec.llm({ purpose: 'background', config: { ...config.llm, temperature: DIARY_TEMPERATURE }, messages }, log)),
            dir: join(config.dataDir, 'memory'),
            log,
        })
        : undefined;
    if (memory) log(config.selfDirectedMemory
        ? '混合记忆：自动记底账，她写 <<记住：…>> / <<日记：…>> 的另记；自动日记关'
        : diaries ? `她的日记：她的每一天结束后写一篇存进公共记忆（没聊天的日子也写，停过的补最近 ${DIARY_BACKFILL_DAYS} 天）` : '她的日记：不写（用到的档位卡上都没有作息）');
    lifetime.own('diaries', () => diaries?.stop());
    if (memory) {
        memory.setWrittenSourceVerifier(diaries ? intents => diaries.verifySources(new Date(exec.now()), intents) : null);
        // Recover completed authored-source invalidation before any responder can read public models.
        memory.derivedAvailable();
    }
    const recalledMemoryPending = new Set<number>();
    // 旧进度可能已覆盖文档而供应商模型仍旧；在回复器能读模型前恢复持久屏障。
    if (memory) for (const contact of config.contacts) {
        let snapshot: StoredMessage[];
        try { snapshot = history.load(contact.qq); }
        catch (error) {
            memory.noteRecall(contact);
            log(`记忆历史来源尚未确认，派生读取保留屏障（${describeError(error)}）`);
            continue;
        }
        if (snapshot.some(message => message.recalled)) memory.noteRecall(contact, snapshot);
    }
    function observeRecalledMemory(contact: Contact): void {
        if (!memory) return;
        recalledMemoryPending.add(contact.qq);
        let snapshot: StoredMessage[];
        try { snapshot = history.load(contact.qq); }
        catch (error) { memory.noteRecall(contact); throw error; }
        memory.noteRecall(contact, snapshot);
    }
    function syncContactMemory(contact: Contact): void {
        if (!memory || stopped) return;
        try {
            if (dormancy?.isDormant()) return;
            // load先确认撤回观察已经发布；不能把dirty或旧档位正文交给记忆队列。
            const snapshot = history.load(contact.qq);
            const since = tierRecord.since(contact.qq);
            const pending = recalledMemoryPending.has(contact.qq) && chatHistory.pendingIncoming(contact.qq).some(entry => entry.withdrawn
                && (!since || Date.parse(entry.source.time) >= since.getTime()));
            const task = memory.sync(contact, { user: contact.name, char: cardFor(contact.tier).character.name }, snapshot);
            // 待解码撤回还没进入聊天，完成后必须再提交最新视图，不能提前清掉观察。
            if (!pending) recalledMemoryPending.delete(contact.qq);
            void task.catch(incomingFailure);
        } catch (error) { incomingFailure(error); }
    }
    function syncRecalledMemory(qq: number): void {
        if (!recalledMemoryPending.has(qq)) return;
        const contact = config.contacts.find(contact => contact.qq === qq);
        if (contact) syncContactMemory(contact);
    }
    function syncMemory(): void {
        if (!memory || stopped) return;
        try { if (dormancy?.isDormant()) return; }
        catch (error) { incomingFailure(error); return; }
        for (const contact of config.contacts) syncContactMemory(contact);
        if (!config.selfDirectedMemory) void diaries?.catchUp(new Date(exec.now())).catch(incomingFailure);
        void promises?.sync().catch(incomingFailure);
    }
    // 每 MEMORY_SYNC_MS 同步一次：由 memory-sync 模块声明（ADR 0336 第 6 步，App 搭好时开）

    // 「她现在在干嘛」只写一份（任务书 §2）：QQ 这边按自己的作息 + 世界 + 心境渲染 NOW.md，
    // DSH 桌面只读它（超过 30 分钟不注入）。以前这份是 her-life.mjs 自己按另一套规则写的，两边会对不上。
    const nowFile = join(soulDir(), 'NOW.md');
    const exportNow = (): void => {
        const schedule = worldCard?.schedule;
        if (!schedule) return;
        try {
            const at = worldNow();
            const now = new Date(at);
            // 在读的书 + 她自己决定今天想做的（ADR 0182）：状态行里她就是个在做那件事的人
            const extraFree = config.herDays ? [...readingActivities(worldCard.books), ...herPlanActivities(config.dataDir, now, log)] : [];
            const owner = deviceOwner;
            const base = describeState(stateAt(schedule, now, extraFree), schedule, owner ? { userName: owner.name } : {});
            // 中断层：他刚说过话就写「和你聊天中」，聊完下一次渲染自己回到原来的轨迹
            const lastAt = owner ? Date.parse(history.load(owner.qq).at(-1)?.time ?? '') : NaN;
            const doing = activityWithChat(base, Number.isFinite(lastAt) ? lastAt : undefined, at);
            // 私有生活片段（ADR 0236）：和控制台使用同一确定性投影，只写已经发生的世界事实。
            // 不放聊天原文、未来计划，也不调用模型生成“朋友圈”。
            const recent = worldCard.herWorld && sharedWorld
                ? worldHighlights(sharedWorld.at(worldCard.herWorld, schedule, now), now).map(item => item.text)
                : [];
            writeNow(nowFile, renderNow({ doing, at, ...(recent.length ? { recent } : {}) }));
        } catch (error) {
            log(`「她现在在干嘛」没写出去（${error instanceof Error ? error.message : String(error)}）`);
        }
    };
    exportNow();
    // 之后每 NOW_REFRESH_MS 再写一次：由 now-export 模块声明（ADR 0336 第 6 步，App 搭好时开）

    // 她自己想让他知道的事：常驻进程/她写进 OUTBOX.jsonl，这里发出去（ADR 0174：和别的主动消息守同一套规矩）
    const outboxFile = process.env.QQBOT_OUTBOX ?? join(soulDir(), 'OUTBOX.jsonl');
    const OUTBOX_BLOCKING = new Set<ExitIssue['kind']>(['banned', 'promise', 'media', 'script', 'text-intimacy']);
    let outboxBusy = false;
    let outboxBlockedBy: string | undefined;
    // 每 30 秒一拍：由 outbox 模块声明（ADR 0336 第 6 步，App 搭好时开）
    const outboxTick = (): void => {
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
    };

    // 追求（ADR 0104）：作者的文件 + 内置；开了 selfPursuits（ADR 0178）再套上她自己的决定、接上她自己加的
    const authorPursuits = pursuitsReader(config.dataDir, log);
    const pursuitsNow = config.selfPursuits ? selfAwareReader(config.dataDir, authorPursuits) : authorPursuits;
    // 最近一次给他算的心境（ADR 0197）：写给桌面上的她，/心境 也看它；同样要在创建回复器之前定义
    let lastFeelings: FeelingsReport | undefined;
    // 群里的遭遇（2026-11-14，心境用）：群聊那段构造时才赋值，这里先声明，回复器每次现取
    let groupFeel: ReturnType<typeof groupAffect> | undefined;
    // 群记录同理：私聊要能读到「群里最近的事」，得在回复器构造之前就声明
    let groupLogs: ReturnType<typeof groupLog> | undefined;
    // 她夜里回想、指出了依据的感受（ADR 0197）：作为「别处算好的评估」进心境；要 herFeelings 开着
    const feelingReviewNow = config.feelingReview && config.herFeelings ? reviewReader(config.dataDir) : undefined;
    // 每个联系人一个回复器：聊天记录、生成和重新生成都互不影响
    const responders = new Map<number, Responder>(config.contacts.map(contact => [contact.qq, createContactResponder(contact)]));

    /** 他这一条原本说的话：她写 `<<用电脑>>` 时，要拿它去干活（标记发出去之前就得留住） */
    const lastUserText = new Map<number, string>();
    const runWork: typeof runWorkTask = (task, options) => exec.process.work(task, options);
    // 把活交给 dsh、干完发回去（工作模式和她自己判断动电脑两处共用）：在 work-handoff.ts（ADR 0336 第 6 步）
    const work = workHandoff({ runWork, transport, history, clockNow, log });

    // 下面这几样她自己想一想的事，定时都在 modules/reflections.ts（ADR 0336 第 6 步，App 搭好时由解释器开）；这里只留开没开的日志和自我认识那一份导出
    // 她每晚想一次要不要放下 / 改主意 / 提新的（ADR 0178）：到点才想，失败 2 小时后再试，每天最多试 3 次
    if (config.selfPursuits) log(config.pursuits && deviceOwner ? '她自己定追求：开（每晚 20 点以后想一次；/追求 随时看）' : '她自己定追求：开着，但 pursuits 没开或名单里没有男朋友档，不启动');
    // 她每晚自己总结说话习惯（ADR 0193）：22 点以后想一次，最近说话够多才想；失败 2 小时后再试，每天最多试 3 次
    if (config.speechNotes) log(deviceOwner ? '她自己总结说话习惯：开（每晚 22 点以后想一次；/说话习惯 随时看）' : '她自己总结说话习惯：开着，但名单里没有男朋友档，不启动');
    // 她每天回顾聊天、找出内容上的问题、学着改（ADR 0221）：22 点以后看一次今天和他的聊天里数得出来的几处，她自己判断、记一句；私人空间
    if (config.chatReview) log(deviceOwner ? '她每天回顾聊天：开（每晚 22 点以后看一次今天和他的聊天里数得出来的几处，她自己判断、记一句；私人空间，日志只记个数）' : '她每天回顾聊天：chatReview 开着，但名单里没有男朋友档，不启动');
    // 她每晚翻自己的日记，写下对自己的认识（ADR 0194）：22 点以后想一次，日记够多、有新的才想；失败 2 小时后再试，每天最多试 3 次
    // 桌面上的她也看得到（同一个她）：写进灵魂目录的 INSIGHTS.json，桌面插件只读；每小时刷新时间戳，6 小时没刷新桌面就不用（关掉开关 / QQ 没在跑）
    const exportInsights = (): void => {
        try { writeInsightsExport(soulDir(), loadInsightsState(config.dataDir).notes, clockNow().getTime()); }
        catch (error) { log(`自我认识：没能写给桌面上的她（${error instanceof Error ? error.message : String(error)}）`); }
    };
    // 她聊完回想一下、记下有依据的感受（ADR 0197）：一段聊天结束半小时后想一次，聊得够多、有新聊天才想；每 10 分钟看一眼，两次尝试至少隔 1 小时，每天最多试 8 次
    if (config.feelingReview) log(config.herFeelings && deviceOwner ? '她聊完回想一下、记下有依据的感受：开（一段聊天结束半小时后想一次；/心境 随时看）' : '她聊完回想一下：feelingReview 开着，但 herFeelings 没开或名单里没有男朋友档，不启动');
    if (config.diaryInsights && deviceOwner) exportInsights();
    if (config.diaryInsights) log(deviceOwner ? '她翻自己的日记写对自己的认识：开（每晚 22 点以后想一次；/自我认识 随时看）' : '她翻自己的日记写对自己的认识：开着，但名单里没有男朋友档，不启动');
    // 她读完 / 看完之后自己想的（ADR 0204）：22 点以后想一次；今天读到哪儿 / 看了什么视频，有话想说才写一句；私人空间，没有命令念给他
    if (config.readingTakes) log(deviceOwner ? '她读完看完之后自己想的：开（每晚 22 点以后想一次，有话想说才写；私人空间，没有命令念给他）' : '她读完看完之后自己想的：readingTakes 开着，但名单里没有男朋友档，不起作用');
    if (config.hisReactions) log(`看他的反应：${config.proactive === 'off' ? '开着，但主动消息（proactive）关着，不起作用' : '开（只男朋友档；她主动说自己的事时提示词多一行他三周内对各类事的反应，说什么她自己拿捏；他明说过不想听的那一类照片 / 小事 7 天内不发）'}`);
    // 她没想完的问题（ADR 0207）：22 点以后想一次；他问过、她答「不知道」的，让她自己想（deliberateModel，开思考），想出什么写什么；私人空间，没有命令念给他
    if (config.openQuestions) log(deviceOwner ? '她没想完的问题：开（他问了她答不上来的，每晚 22 点以后她自己想一遍；私人空间，没有命令念给他）' : '她没想完的问题：openQuestions 开着，但名单里没有男朋友档，不起作用');
    // 她猜的事和后来的结果（ADR 0213）：22 点以后对一次；白天她像在猜结果的几句给她挑，挂着的对照世界账里这几天真实发生的事；私人空间，没有命令念给他
    if (config.herGuesses) log(!deviceOwner ? '她猜的事：herGuesses 开着，但名单里没有男朋友档，不起作用' : !(sharedWorld && worldCard) ? '她猜的事：herGuesses 开着，但没有她那边的世界（世界账），对不上结果，不起作用' : `她猜的事：开（白天留意她像在猜结果的话，每晚 22 点以后她自己挑哪句算数、对照世界账看对没对；私人空间，没有命令念给他${config.innerLife ? '；刚对上的那件她下次一个人想事情时会想到' : ''}）`);
    if (config.silenceNotice) log(deviceOwner ? '没回时告诉他原因：开（随正常回复解释，不另发通知）' : '没回时告诉他原因：开着，但名单里没有男朋友档，不解释');

    /** 名单外临时建了回复器的好友（状态页要显示称呼和档位） */
    const unlisted = new Map<number, Contact>();
    /** 他提给她、等她点头的请求（看屏幕 / 摄像头……）：她写 <<同意>> 才做，写 <<拒绝：原因>> 就作罢（2026-10-30） */
    const pendingAsk = new Map<number, { label: string; at: number; run: () => Promise<{ kind: string; text?: string }> }>();

    /** 最近几轮 + 要点（ADR 0043）：开了 contextTurns、这个人开了记忆、在灰度名单里（空 = 都开）才给；整理好的要点存在 context/<QQ>.json */
    function contextWindowFor(contact: Contact): Pick<ContactPipelineOptions, 'contextWindow'> {
        if (!config.contextTurns || !memory || (config.contextContacts.length && !config.contextContacts.includes(contact.qq))) return {};
        const dir = join(config.dataDir, 'context');
        exec.files.mkdir(dir);
        const summarize = contextSummarizer({
            names: { user: contact.name, char: cardFor(contact.tier).character.name },
            generate: messages => {
                const scoped: Log = message => { if (!stopped) log(message); };
                return exec.llm({ purpose: 'background', config: forExtraction(config.llm), messages }, scoped);
            },
            log: message => log(`[${contact.qq}] ${message}`),
            file: join(dir, `${contact.qq}.json`),
        });
        lifetime.own('context', () => summarize.stop());
        return {
            contextWindow: {
                turns: config.contextTurns,
                step: 4,
                summarize,
            },
        };
    }

    /** 存进聊天记录的版本：所有内部标记都剥掉，免得下一轮她又在历史里看见自己写标记 */
    function historyText(sent: string): string {
        return stripInternalMarkers(takeMemoryReview(takeSelfNotes(sent).text).text)
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
        // 她的声音（2026-11-01）：她写 `<<语音：…>>` 就念出来、发语音条。worker 常驻，一句话 10–15 秒
        const voiceDir = process.env.QQBOT_TTS_DIR ?? join(process.cwd(), 'runtime', 'indextts');
        // 情绪参考（calm/happy/sad/angry/shy）和生成的临时文件；api_v2（her11）在 9880
        const voiceRefsDir = process.env.QQBOT_VOICE_REFS ?? join(process.cwd(), 'runtime', 'voice-refs');
        const voiceOutDir = join(process.cwd(), 'runtime', 'voice-out');
        const voiceOn = contact.tier === 'boyfriend' && Boolean(transport.sendPrivateVoice) && process.env.QQBOT_TTS !== 'off';
        const lastVoiceAt = new Map<number, number>();
        // 11-02「检查类似的问题」：原来语音那一行从回复里摘掉以后，聊天记录里就没有了（historyText 把 <<语音：…>> 当内部标记剥掉），
        // 他回「你刚那条语音……」她不知道自己说过什么；三分钟内跳过、没生成出来、发送失败时那句话也直接丢了，他没收到、她也不知道没发出去。
        // 现在：发出去了记一行「[语音：…]」（带消息 id，他引用也对得上）；没发成语音就改用文字发出去，照样记下
        const spokenLine = (line: string) => `[语音：${line}]`;
        const speakAsText = (userId: number, line: string, why: string): void => {
            log(`[${userId}] 语音${why}，那句话改用文字发`);
            void transport.sendPrivateText(userId, line)
                .then(id => chatHistory.append(userId, { time: new Date(worldNow()).toISOString(), role: 'assistant', content: line, messageId: id }))
                .catch(error => log(`[${userId}] 那句话用文字也没发出去：${error instanceof Error ? error.message : String(error)}`));
        };
        // 情绪写在语音标记里：`<<语音：开心|你回来啦>>`。她 2026-11-12 定：情绪由文本标明、用户审核，
        // 不从心情自动推断（分错了更烦）。没写就不加情绪，用平静参考。
        const emoBucket = (word: string | undefined): 'calm' | 'happy' | 'sad' | 'angry' | 'shy' => {
            const w = (word ?? '').trim().toLowerCase();
            if (/开心|高兴|兴奋|愉快|雀跃|happy/.test(w)) return 'happy';
            if (/委屈|难过|伤心|低落|想哭|sad/.test(w)) return 'sad';
            if (/生气|烦|恼|怒|angry/.test(w)) return 'angry';
            if (/害羞|撒娇|甜|黏|心动|shy/.test(w)) return 'shy';
            return 'calm';
        };
        const splitVoiceTag = (line: string): { emo: ReturnType<typeof emoBucket>; body: string } => {
            const m = /^\s*([^|｜]{1,6})\s*[|｜]\s*(.+)$/.exec(line);
            if (m && /开心|高兴|委屈|难过|生气|害羞|撒娇|平静|happy|sad|angry|shy|calm/i.test(m[1]!)) {
                const bucket = emoBucket(m[1]);
                return { emo: bucket, body: m[2]!.trim() };
            }
            return { emo: 'calm', body: line };
        };
        const emoRef = (emo: ReturnType<typeof emoBucket>): { refAudio: string; refText: string } | undefined => {
            if (!voiceRefsDir || !existsSync(voiceRefsDir)) return undefined;
            const wav = join(voiceRefsDir, `${emo}.wav`);
            const txt = join(voiceRefsDir, `${emo}.txt`);
            if (!existsSync(wav) || !existsSync(txt)) return undefined;
            return { refAudio: wav, refText: readFileSync(txt, 'utf8').trim() };
        };
        const speakVoice = (userId: number, rawLine: string): void => {
            const { emo, body: line } = splitVoiceTag(rawLine);
            if (!voiceOn) { speakAsText(userId, line, '关着'); return; }
            const last = lastVoiceAt.get(userId) ?? 0;
            if (Date.now() - last < 3 * 60_000) { speakAsText(userId, line, '三分钟内已经发过'); return; }
            lastVoiceAt.set(userId, Date.now());
            const ref = emoRef(emo);
            // 首选语音网关（多 seed 择优 + 提亮）；网关不在就直连 api_v2；再不行回落到 worker / 文字
            const gateway = process.env.QQBOT_VOICE_GATEWAY ?? 'http://127.0.0.1:9890';
            const spoken = speakViaGateway(line, { baseUrl: gateway, emotion: emo, outDir: voiceOutDir })
                .then(wav => wav ?? (ref
                    ? speakViaHttp(line, { refAudio: ref.refAudio, refText: ref.refText, temperature: emo === 'calm' ? 0.8 : 0.9, outDir: voiceOutDir })
                    : Promise.resolve(undefined)));
            void spoken
                .then(wav => wav ?? speakViaWorker(line, { dir: voiceDir }))
                .then(async wav => {
                    if (!wav) { speakAsText(userId, line, '没生成出来'); return; }
                    let id: number;
                    try {
                        id = await transport.sendPrivateVoice!(userId, wav);
                    } catch (error) {
                        speakAsText(userId, line, `没发出去（${error instanceof Error ? error.message : String(error)}）`);
                        return;
                    }
                    chatHistory.append(userId, { time: new Date(worldNow()).toISOString(), role: 'assistant', content: spokenLine(line), messageId: id });
                    log(`[${userId}] 发了一条语音（${line.slice(0, 20)}…，情绪 ${emo}，消息 ${id}）`);
                })
                .catch(error => speakAsText(userId, line, `出错了（${error instanceof Error ? error.message : String(error)}）`));
        };
        if (voiceOn) startVoiceWorker(voiceDir);

        const absorbMarkers = (userId: number, input: string): string => {
            // 标记处理顺序表（ADR 0336「生成之后那一段」第 12 步，interpreter 的 ABSORB_STAGES）：各模块摘自己的标记、办自己的事；语音是用户自己的代码，留在这里原位
            // 她自己记的（<<记住>> / <<日记>> / <<私密>>）：modules/self-notes.ts
            let text = absorbStage(interpreter.modules, 'notes', input, contact);
            // 她要“说话”（语音条）：标记不发出去，念出来单独发一条
            const voiced = takeVoiceLines(text);
            text = voiced.text;
            for (const line of voiced.lines) speakVoice(userId, line);
            // 跑命令（<<执行>>，modules/shell.ts）→ 切工作（<<同意工作>> / <<拒绝工作>>）→ 动电脑（<<用电脑>>，modules/work-mode.ts）→ 他的请求（<<同意>> / <<拒绝>>，modules/consent.ts）
            for (const stage of ['shell', 'workSwitch', 'work', 'consent'] as const) text = absorbStage(interpreter.modules, stage, text, contact);
            // 网络热梗：她这条里原样用上了库里的哪个（只记词，不记意思）。用来回答「她会用梗吗」
            if (config.memes && contact.tier === 'boyfriend') {
                const usedMeme = loadMemes(memesFile, log).entries.find(entry => entry.term && text.includes(entry.term));
                if (usedMeme) log(`[${userId}] 网络热梗：她用了「${usedMeme.term}」`);
            }
            return text;
        };

        // 仅保存已确认、待写聊天历史的发送快照；按消息ID绑定，不受同照片并发发送完成顺序影响。
        const sentPhotoHistory = new Map<number, { token: string; content: string }>();
        const responder = createPipeline({
            contact,
            card: cardFor(cardKey(contact)),
            // 危机回合被问是不是真人一律承认（ADR 0068 决策 7）：知道她是程序的联系人这一轮换用承认版的卡
            ...(openCardFor(contact) ? { openCard: openCardFor(contact)! } : {}),
            ...(contact.tier === 'boyfriend' ? {
                // 她有「自己的下文」吗（2026-10-30 她自己的诊断）：日记最后一段 + 她自己在做的事，用不用她定
                dreams: () => ({ appraisals: dreamAppraisals(config.dataDir, clockNow().getTime()), line: dreamNoteLine(latestDream(config.dataDir, clockNow().getTime())) }),
                // 他问到过去的某一天时，她那天自己写的日记（ADR 0217，配置 diaryLookback）：JOURNAL.md 那天的段落 + 她在聊天里写的 <<日记>>
                ...(config.diaryLookback && contact.tier === 'boyfriend' ? {
                    diaryOn: (date: string): string | undefined => {
                        let journal = '';
                        try { journal = exec.files.read(join(soulDir(), 'JOURNAL.md')); } catch { /* 还没有日记 */ }
                        return journalOn(journal, loadSelfDiary(config.dataDir), date);
                    },
                } : {}),
            } : {}),
            // 他的消息没有马上回的每一个原因逐条记账（ADR 0173）：只是旁观，记不进去也不影响回复
            ...(config.silenceNotice && contact.qq === deviceOwner?.qq ? { onSilence: (info: SilenceInfo) => { try { recordSilence(config.dataDir, contact.qq, noteFromInfo(info, clockNow().getTime())); } catch (error) { log(`没回的原因记不进账（${error instanceof Error ? error.message : String(error)}）`); } } } : {}),
            llm: config.llm,
            prompt: config.prompt,
            schedule: config.schedule,
            moody: config.moody,
            speechCheck: config.speechCheck,
            ...(config.tailCap ? { tailCap: true } : {}),
            herDays: config.herDays,
            ...contextWindowFor(contact),
            ...(sendingStickers && contact.tier === 'boyfriend' ? { stickers: sendingStickers } : {}),
            ...(deviceHooks && contact.tier === 'boyfriend' ? { devices: deviceHooks } : {}),
            // 桌面对话文件只属于唯一 deviceOwner；不能仅按 boyfriend 档放行，否则多个同档联系人会互相看到私聊。
            ...(config.crossRecent && deviceOwner?.qq === contact.qq ? { desktopRecent: (now: Date) => desktopBlock(desktopRecentPath(join(config.dataDir, 'memory')), now.getTime()) } : {}),
            ...(photos && contact.tier === 'boyfriend' ? { photos } : {}),
            ...(aiPhotoRequests && contact.tier === 'boyfriend' ? {
                currentAiPhoto: ({ kind, dish, at, world }: { kind: PhotoKind; dish?: string; at: Date; world: WorldNow }) => requestCurrentAiPhoto(aiPhotoRequests, kind, world, at, dish),
            } : {}),
            ...(photos && contact.tier === 'boyfriend' ? { sentHistory: (text: string, messageId: number) => {
                const snapshot = sentPhotoHistory.get(messageId);
                if (!snapshot || snapshot.token !== text.trim().toLowerCase()) return undefined;
                sentPhotoHistory.delete(messageId);
                return snapshot.content;
            } } : {}),
            ...(stickerChance !== undefined ? { stickerChance } : {}),
            ...(config.biliStickers ? { stickerUncued: STICKER_UNCUED_CHANCE } : {}),
            // 抽到发表情的轮次里一半只发表情（ADR 0099）：跟着情绪轮的开关走；测试可以直接给概率
            ...((stickerOnlyChance ?? (config.shape && config.shapeFeel ? STICKER_ONLY_SHARE : 0)) > 0 ? { stickerOnlyChance: stickerOnlyChance ?? STICKER_ONLY_SHARE } : {}),
            ...(noteHerDay ? { onHerDay: noteHerDay } : {}),
            history,
            historyContent: historyText,
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
            ...(config.rhythm ? { rhythm: true } : {}),
            ...(config.shortReplies ? { shortReplies: true } : {}),
            // 她自己决定今天想做什么（ADR 0182）：和「在读的书」一起当额外的空闲活动，每次现取
            ...(config.innerLife ? { herPlan: (at: Date) => herPlanActivities(config.dataDir, at, log) } : {}),
            // 她理解人的话（10-30）：他这句话和以前被纠正过的事撞上时提醒她
            // 他说过、做过、答应过的事（10-31 留痕）：最近的几条递给她
            // 他刚发过「/亲热」（ADR 0170）：接下来十条回复黏一点，每生成一条减一
            ...(contact.tier === 'boyfriend' ? { intimacyLine: () => takeIntimateLine(config.dataDir, contact.qq) } : {}),
            // 心境（ADR 0102）：作者写下的事每次现取
            ...(config.herFeelings ? { herFeelings: true, moments: momentsReader(config.dataDir, log) } : {}),
            // 设备所有者明确问指定群时，才查该群。群底账在回复器建好后初始化。
            ...(contact.qq === deviceOwner?.qq ? {
                groupRecent: async (question: string, at: Date) => {
                    const groups = config.groups ?? [];
                    const local = groupLogs ? privateGroupScheduleRecall(groupLogs.load, groups, question, at.getTime()) : undefined;
                    const groupId = privateGroupBulletinTarget(groups, question);
                    if (groupId === undefined) return local;
                    if (!transport.callAction) return [local, '[指定群的 QQ 公告栏暂时读不到（接口不可用 / 无权限），请如实说明。]'].filter(Boolean).join('\n');
                    let timeout: ReturnType<typeof setTimeout> | undefined;
                    try {
                        const response = await Promise.race([
                            transport.callAction('_get_group_notice', { group_id: String(groupId) }),
                            new Promise<never>((_, reject) => {
                                timeout = setTimeout(() => reject(new Error('读取群公告超时')), 3_000);
                                timeout.unref?.();
                            }),
                        ]);
                        const bulletin = privateGroupBulletinRecall(groups, question, response, at.getTime());
                        const statusNote = bulletin?.status === 'empty' ? '公告栏为空。'
                            : bulletin?.status === 'no-match' ? '这段时间没有匹配的公告。'
                                : bulletin?.status === 'filtered' ? '公告内容涉及个人信息或不适合转述，我没有提供。'
                                    : bulletin?.status === 'invalid' || !bulletin ? '公告接口返回无法识别的内容。' : undefined;
                        const note = bulletin?.status === 'ok' ? bulletin.context : `[指定群的 QQ 公告栏：${statusNote}请如实说明，不猜测或补写。]`;
                        return [local, note].filter(Boolean).join('\n');
                    } catch (error) {
                        log(`指定群公告读取失败（群 ${groupId}）：${error instanceof Error ? error.message : '接口异常'}`);
                        return [local, '[指定群的 QQ 公告栏暂时读不到，请如实说明。]'].filter(Boolean).join('\n');
                    } finally {
                        if (timeout) clearTimeout(timeout);
                    }
                },
            } : {}),
            // 群里的遭遇也进心境（2026-11-14）：有人在群里夸她、冲她发火、说想不开，私聊里她也带着
            ...(config.herFeelings && (config.groupChat ?? 'off') !== 'off' && (config.groups ?? []).length > 0 ? { groupMood: () => groupFeel?.appraisals() ?? [] } : {}),
            // 桌面上的她读同一份心境（ADR 0197）：QQ 是唯一算心境的地方，算完写进灵魂目录
            ...(config.herFeelings && contact.tier === 'boyfriend' ? { onFeelings: (report: FeelingsReport) => { lastFeelings = report; writeFeelingsExport(soulDir(), report); } } : {}),
            ...(feelingReviewNow && contact.tier === 'boyfriend' ? { feelingReview: feelingReviewNow } : {}),
            ...(config.quoteReply ? { quoteReply: true } : {}),
            ...(config.memoryFeelings && config.herFeelings ? { memoryFeelings: true } : {}),
            ...(config.realNights ? { realNights: true } : {}),
            ...(config.lagTail ? { lagTail: true } : {}),
            ...(config.everydayLife ? { everydayLife: true } : {}),
            ...(config.pursuits ? { pursuits: pursuitsNow } : {}),
            ...(config.deliberate ? { deliberate: { llm: deliberateLlm(config.llm, config.deliberateModel) } } : {}),
            ...(turnWeigher ? { turnWeight: turnWeigher } : {}),
            ...(continuity ? { continuity } : {}),
            contacts: config.contacts,
            // 带小黄脸的发送失败（QQ / NapCat 不收那个 face 段）就去掉表情再发一次纯文字，免得整轮回复失败、重试几次后不回了（ADR 0051）；
            // 超时不重发：可能已经发出去了，再发就重复
            // 她打字的这段时间对方那边显示「正在输入…」（ADR 0077，配置 typingStatus，默认关）；出错只记一次日志，不影响发送
            ...(config.selfRecall && transport.deleteMessage ? { recallOwn: (messageId: number) => transport.deleteMessage!(messageId) } : {}),
            ...(config.typingStatus && transport.setInputStatus ? { typing: (userId: number) => {
                void sendOwnedNotice(() => transport.setInputStatus!(userId), () => {}, error => {
                    if (!typingFailed) {
                        typingFailed = true;
                        log(`[${userId}] 显示「正在输入」失败（之后不再记）：${error instanceof Error ? error.message : String(error)}`);
                    }
                });
            } } : {}),
            // 她在 QQ 上的样子（签名、最近发的说说）进时间块（ADR 0083）
            selfNote: (now: number) => herPresence.selfNote(now),
            // 已读回执 / 表情回应（ADR 0083）：失败只记第一次，不影响回复
            ...(config.readReceipts && transport.markRead ? { markRead: (userId: number) => {
                void sendOwnedNotice(() => transport.markRead!(userId), () => {}, error => failOnce('已读回执', userId, error));
            } } : {}),
            ...(config.reactions && transport.reactMessage ? { react: (userId: number, messageId: number, text: string) => {
                void sendOwnedNotice(() => transport.reactMessage!(messageId, reactionEmoji(text, messageId)),
                    () => log(`[${userId}] 看到了没回，点了个表情回应`), error => failOnce('表情回应', userId, error));
            } } : {}),
            send: async (userId, text, sendOptions) => {
                text = absorbMarkers(userId, text);
                // 兜底：她偶尔把提示词里的标记原样写出来（10-30 发过「<<当前时间：…>>」），发送前剥掉
                text = tidyQuestionMarks(stripInternalMarkers(text));
                if (!text.trim()) return 0;
                const photo = contact.tier === 'boyfriend' ? photos?.resolve(text) : undefined;
                // A cleaned photo can lose its cache before transmission; never send its control token as text.
                if (!photo && /^<photo:[a-f0-9]{12}>$/i.test(text.trim())) throw new Error('照片发送前已不可用；本轮未发送照片');
                if (photo) {
                    const id = await transport.sendPrivateImage!(userId, photo.file, '[照片]');
                    sentPhotoHistory.set(id, { token: `<photo:${photo.id}>`, content: `${PHOTO_HISTORY_PREFIX}${photo.caption}` });
                    // 正常历史转换立即消费；撤回成功或异常中断留下的快照最多保留128项。
                    if (sentPhotoHistory.size > 128) sentPhotoHistory.delete(sentPhotoHistory.keys().next().value!);
                    // 传输确认的消息 ID 是发送事实；副索引失败不能把成功改判成失败而重发。
                    try { photos!.used(photo.id); }
                    catch { log('照片货架：照片已发送，使用记录写入失败；保留发送结果，不重发'); }
                    return id;
                }
                const sticker = contact.tier === 'boyfriend' ? sendingStickers?.resolve(text) : undefined;
                if (sticker) {
                    // sticker.file 可能只是文件名（c15a5b9e3b6e.png），直接丢给 NapCat 会找不到文件；
                    // 已经是绝对路径（测试、别处传进来的）就原样用
                    const file = isAbsolute(sticker.file) ? sticker.file : join(config.dataDir, 'stickers', sticker.file);
                    const id = await transport.sendPrivateImage!(userId, file, `[${sticker.description}]`);
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
            // last-prompt.json 记录的是后处理之后、实际发给模型的消息（要 QQBOT_SENSITIVE_LOGS 开着才写，见 docs）
            onPrompt: prompt => {
                if (!sensitive.on()) return;
                exec.files.write(join(config.dataDir, 'last-prompt.json'), JSON.stringify({ qq: contact.qq, ...prompt }, null, 2));
            },
            turnModules: interpreter.turnModules,
            ...pipeline,
            // 回复和逐条事实检查的审稿也经执行器（ADR 0336 第 3 步）：配置、日志和原来 contact.ts 的默认调用一样；
            // 换模型（深思）时测试替身收到换成的那份配置，同原来 generate 的第三个参数
            generate: (messages, scopedLog, use) => exec.llm({ purpose: 'chat', config: use ?? config.llm, messages, ...(use ? { use } : {}) }, scopedLog),
        });
        lifetime.own('responders', () => responder.stop());
        return responder;
    }

    // 危机信号（ADR 0068）：只记哪个联系人、什么时候，不记内容
    // 她去洗澡 / 上课之前说一声（2026-10-30 用户：聊着聊着就去洗澡了，都不说一声）
    /** 她刚跑过的命令结果：下一轮提示词给她看一眼就清掉（max 权限，但结果要回到她脑子里） */
    const shellNotes = new Map<number, string>();
    // 做梦（2026-10-31）：她睡着的那几小时里，把白天的东西糊成一团；一晚一个，存 dreams/DREAMS.jsonl。
    // 那四件事在 life/dream-jobs.ts，每 30 分钟一拍由 dreams 模块声明（ADR 0336 第 6 步，App 搭好时开）

    /** 这一轮提示词里放了网上的内容（防注入第一道：这种回合不执行她写的命令） */
    const webTurns = new Map<number, number>();
    const crisisState = createCrisisState(config.dataDir, log);
    // 记危机信号、没存进去就后台重试、停止时最后存一次：在 emotion/crisis-state.ts（ADR 0336 第 6 步）；停法照旧在这里登记
    const crisisMarker = crisisMarks({ crisisState, exec, stopped: () => stopped, log });
    lifetime.own('crisis', () => crisisMarker.stop());
    const markCrisis = crisisMarker.mark;

    // 存在感（ADR 0083）：在 social/presence-owner.ts（ADR 0336 第 6 步）；停法照旧在这里登记
    const herPresence = presenceOwner({ config, log, worldNow, cardFor, worldCard, bedtimes, exec, chatHistory, transport, vision, rainyAt, dormancy, crisisState });
    lifetime.own('presence', () => herPresence.stop());
    const startPresence = herPresence.start;
    // 她在 B 站的那几样（她的号、刷视频、风险转私信、回复评论）：在 bilibili/owners.ts（ADR 0336 第 6 步）；停法照旧在这里登记，先后同原来
    const bilibili = bilibiliOwners({ config, stopped: () => stopped, log, worldNow, cardFor, worldCard, bedtimes, exec, chatHistory, transport, responders, decorateAccounts, ownAccountGuard, bilibiliRequest, bilibiliFetch });
    lifetime.own('browsing', () => bilibili.stopBrowsing());
    lifetime.own('risk', () => bilibili.stopRisk());
    lifetime.own('replies', () => bilibili.stopReplies());
    const bilibiliAccountSource = bilibili.accountSource;
    const startBilibiliOwners = bilibili.startOwners;

    // 她自己在 B 站找表情包（ADR 0132，配置 biliStickers）：表情包的候选来源换成 B 站（原来的公开目录兜底）；别的来源（他发来的、QQ 收藏、导入箱）照旧
    if (config.biliStickers && stickers?.setTrend) {
        const source = bilibiliAccountSource();
        if (!source) log('B 站表情包：biliStickers 开着，但要 bilibiliAccount 也开着，还用原来的公开目录');
        else {
            const release = stickers.setTrend(previous => biliStickerDiscover({ account: source, fetch: (url, init) => fetch(url, init) as never, now: () => new Date(worldNow()), log: message => { if (!stopped) log(message); } }, previous), BILI_STICKER_PER_DAY);
            if (typeof release === 'function') releaseStickerTrend = release;
        }
    }

    function rainyAt(now: number): boolean {
        if (!sharedWorld || !worldCard?.herWorld || !worldCard.schedule) return false;
        return Boolean(sharedWorld.at(worldCard.herWorld, worldCard.schedule, new Date(now))?.weather?.rain);
    }

    /** 主动消息的计划器：第一次补回完才建 */
    // 主动消息的计划器（第一次补回完才建）：在 proactive/planner-host.ts（ADR 0336 第 6 步）；计划器表由它持有，停法照旧在这里登记
    const proactivePlanners = plannerHost({
        config, log, exec, clockNow, cardFor, proactiveContacts, deviceOwner, responders, history, photos, worldCard, ledgerWorld, sharedWorld, needsAnchor,
        agencyShadow, weather, web, herGuessesNow, promises, dormancy, crisisState, bedtimes, watchedEntries: () => watchedEntries, pipeline,
    });
    const planners = proactivePlanners.planners;
    lifetime.own('planners', () => { for (const planner of planners.values()) planner.stop(); });
    const startPlanners = proactivePlanners.start;
    function syncFollowUps(): void {
        for (const planner of planners.values()) void planner.syncFollowUps();
    }

    let stopDrain: Promise<void> | undefined;
    // 周报（ADR 0118）：每小时看一眼，周日 21:30 以后这周的还没有就写一份；出错只记日志
    const checkWeeklyReport = () => {
        if (!config.weeklyReport || stopped) return;
        const reportsDir = join(config.dataDir, 'reports');
        const nowDate = new Date(exec.now());
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
        const aiDraftStatus = aiPhotoDrafts.status();
        if (aiDraftStatus.total) extras.aiPhotoDrafts = aiDraftStatus;
        Object.assign(extras, interpreter.status());
        if (config.weeklyReport) {
            try {
                const dir = join(config.dataDir, 'reports');
                const latest = exec.files.exists(dir) ? exec.files.list(dir).filter(f => /^weekly-\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().at(-1) : undefined;
                if (latest) extras.report = { name: latest, text: exec.files.read(join(dir, latest)).slice(0, 4000) };
            } catch { /* 读不到就不显示 */ }
        }
        return extras;
    };
    // 她在 B 站只读的三件事（看视频、刷推荐、学热梗）：在 bilibili/passive-jobs.ts（ADR 0336 第 6 步）；看完视频更新的「看过的」交回这里
    const { watchJob, feedJob, refreshMemeJob } = passiveJobs({
        config, stopped: () => stopped, log, exec, passive, bilibiliAccountSource, bilibiliFetch, vision, worldCard, bedtimes,
        watchedFile, setWatched: entries => { watchedEntries = entries; }, memesFile,
    });
    // 照片货架的发现与重试（ADR 0110 / 0128）：在 vision/photo-discovery.ts（ADR 0336 第 6 步）；两个重试计时器的停法照旧在这里登记
    const shelfDiscovery = photoShelfDiscovery({
        photos, hasFoodSource: Boolean(foodSource), config, stopped: () => stopped,
        menu: () => cardFor('boyfriend').character.herWorld?.menu, menuFrom, exec, retryMs: photoRetryMs, log,
    });
    lifetime.own('food-retry', () => shelfDiscovery.cancelFoodRetry());
    lifetime.own('photo-retry', () => shelfDiscovery.cancelPhotoRetry());
    const { discoverPhotos, discoverFoodPhotos } = shelfDiscovery;
    const discoverStickers = () => { if (collectingStickers) void ownStickerWork(signal => collectingStickers.discover({ signal })); };
    /** Hindsight 健康检查的结果（状态页用到时才探，见 status()） */
    let health: MemoryEvent | undefined;
    let probing = false;
    lifetime.own('probing', () => { probing = false; });
    // 补完之前到的新消息先攒着，补完再按顺序处理
    let syncing = false;
    let syncPromise: Promise<void> | undefined;
    const buffered: MessageEvent[] = [];
    // OneBot may redeliver an event before it reaches chat history. Commands intentionally do not
    // enter chat history, so keep a bounded ingress index for them and for other in-flight events.
    const recentIngress = new Set<string>();
    const rememberIngress = (event: MessageEvent): boolean => {
        // QQ 的 message_id 不保证全局唯一（ADR 0238：会被不同消息重用）：重投的同一条消息 id、序号、秒数都相同，
        // 同 id 但序号或秒数不同的是另一条，不能被入口吞掉。
        const key = `${event.user_id}:${event.message_id}:${event.real_seq ?? ''}:${event.time}`;
        if (recentIngress.has(key)) return false;
        recentIngress.add(key);
        if (recentIngress.size > 4_096) {
            const oldest = recentIngress.values().next().value as string | undefined;
            if (oldest !== undefined) recentIngress.delete(oldest);
        }
        return true;
    };

    /** 每人一条：要听、要看的消息读完才进聊天记录，后面来的排在它后面（顺序不乱；读是一收到就开始读，不排队） */
    const inbox = new Map<number, Promise<void>>();
    // 谁的私聊她回、陌生人的规矩和个性签名（ADR 0209）：在 social/private-admission.ts（ADR 0336 第 6 步）
    const admission = privateAdmission({ config, transport, responders, unlisted, createResponder: contact => createContactResponder(contact), tierRecord, history, unlistedName, worldNow, log });
    const { strangers, ensureAiSignature } = admission;
    const pokeLimiter = createPokeLimiter();
    const lastPokeBack = new Map<number, number>();
    const pokeTimers = new Set<ReturnType<typeof setTimeout>>();
    lifetime.own('pokes', () => { for (const timer of pokeTimers) exec.cancel(timer); pokeTimers.clear(); });
    const pokeDeps: PokeDeps = {
        config, stopped: () => stopped, syncing: () => syncing, now: worldNow,
        scheduleOf: tier => cardFor(tier).character.schedule, bedtimes,
        limiter: pokeLimiter, lastPokeBack,
        onMessage: event => onMessage(event),
        pokeFriend: transport.pokeFriend ? qq => transport.pokeFriend!(qq) : undefined,
        later: (run, delayMs) => {
            const timer = exec.after(() => { pokeTimers.delete(timer); run(); }, delayMs);
            timer.unref?.();
            pokeTimers.add(timer);
        },
        sendOwnedNotice, log,
    };
    // 入站收据：收到的私聊先记一笔、读完才进聊天记录，中途断了下次补上；失败后台重试（ADR 0336 第 6 步搬到 incoming.ts）。停法照旧在这里登记
    const incoming = incomingReceipts({
        config, stopped: () => stopped, syncing: () => syncing, exec, chatHistory, history, tierRecord, dormancy, responders, readerFor,
        quoteLookup: qq => quoteLookup(qq), forwardLookup: qq => forwardLookup(qq), markCrisis, syncRecalledMemory, deviceOwner, plainTextOf, inbox, log,
    });
    lifetime.own('incoming', () => incoming.stop());
    const { activeIncoming, claimIncoming, releaseIncoming, bufferedIncoming, bufferedIncomingIds, eventIdentity, validIncomingEvent, tracksIncoming, stageEvent, incomingFailure, prepareReceived, recoverIncoming, queueIncomingRecovery } = incoming;
    let privateSongReference: { song: string; at: number } | undefined;
    const groupSongRequests = new Map<number, { song: string; at: number }>();
    const songRequestLifetime = 5 * 60_000;

    function onMessage(event: MessageEvent): void {
        if (!validIncomingEvent(event)) { log('收到的私聊来源身份无效，已忽略'); return; }
        const reservation = { id: bufferedIncoming.get(event), owned: false };
        if (reservation.id) bufferedIncomingIds.delete(reservation.id);
        let handled = false;
        try { processMessage({ ...event }, reservation); handled = true; }
        catch (error) { incomingFailure(error); }
        finally {
            if (handled && reservation.id && !reservation.owned) {
                try { chatHistory.discardIncoming(event.user_id, reservation.id); } catch (error) { incomingFailure(error); }
            }
        }
    }
    function processMessage(event: MessageEvent, reservation: { id?: string; owned: boolean }): void {
        const sourceIdentity = eventIdentity(event);
        // 补回或入口重投的同一条消息不消耗限额，也不重复处理。
        if (chatHistory.hasMessage(event.user_id, event.message_id, sourceIdentity)) return;
        // 这条私聊回不回（名单、名单外限流、陌生人的规矩 ADR 0209）：在 social/private-admission.ts（ADR 0336 第 6 步）
        const responder = admission.admit(event);
        if (!responder) return;
        // 他对她的话回「假」/「像」：记下来就算处理完，不进聊天记录、不交给回复器、不触发主动计划（ADR 0073）
        const feedbackContact = feedback ? config.contacts.find(c => c.qq === event.user_id && canGiveFeedback(c)) : undefined;
        if (feedback && feedbackContact
            && feedback.consume(event.user_id, feedbackContact.tier, event.message, event.message_id, new Date(event.time * 1000), history.load(event.user_id))) return;
        // 连续性命令（ADR 0157 / 0161）：「/设定」看设定账本和记忆账本的摘要；「/休眠 [原因]」「/休眠 确认」「/休眠 取消」「/唤醒」。
        // 只认纯文字、只认男朋友档的他；命中的算处理完，不进聊天记录、不交给回复器。休眠中除了这几条，她什么都不回
        if (deviceOwner && event.user_id === deviceOwner.qq) {
            const plain = plainTextOf(event.message)?.trim();
            // 他的运维指令（/dsh 子命令、不用了的、/设定、/休眠、/唤醒）：在 owner-commands.ts（ADR 0336 第 6 步）
            if (ownerCommandsNow.early(event, plain)) return;
            // 「唱 BVxxxx」（2026-11-14）：他要她唱一首。后台跑 scripts/sing.py（约 5 分钟），
            // 出结果发整首语音条；不占她这一轮的回复，也不进提示词。
            const priorSong = privateSongReference;
            const reference = plain ? singVideoReference(plain) : undefined;
            const at = worldNow();
            privateSongReference = reference ? { song: reference, at } : undefined;
            const singBv = !dormancy?.isDormant() && plain
                ? matchSingRequest(plain) ?? (priorSong && at - priorSong.at <= songRequestLifetime
                    && /^(?:(?:我)?想听|(?:给我)?唱(?:一下)?)?这首[吧呀啊。！？!?]*$/.test(plain) ? priorSong.song : undefined)
                : undefined;
            if (singBv) {
                tellOwner(pickLine(SING_LINES.start));
                log(`[${event.user_id}] 唱歌：开始 ${singBv}`);
                void sing(singBv, {
                    root: repoRoot,
                    python: join(repoRoot, 'runtime', 'gpt-sovits', '.venv', 'Scripts', 'python.exe'),
                    ffmpeg: process.env.QQBOT_FFMPEG ?? 'ffmpeg',
                    log,
                }).then(async result => {
                    if (stopped || dormancy?.isDormant()) return;
                    if (result.error || !result.mp3) {
                        tellOwner(result.error === 'busy'
                            ? pickLine(SING_LINES.busy)
                            : pickLine(SING_LINES.fail, result.error ?? '没出结果'));
                        log(`[${event.user_id}] 唱歌：失败 ${singBv}（${result.error ?? 'no result'}）`);
                        return;
                    }
                    // 整首直接发语音条（2026-11-14 实测 3:46 也收得下）；发不动才退回 60 秒片段
                    let sent = false;
                    if (transport.sendPrivateVoice) {
                        try {
                            await transport.sendPrivateVoice(event.user_id, result.mp3);
                            sent = true;
                        } catch (error) {
                            log(`[${event.user_id}] 唱歌：整首没发出去（${error instanceof Error ? error.message : String(error)}），改发片段`);
                        }
                        if (!sent && result.clip && !stopped && !dormancy?.isDormant()) {
                            try {
                                await transport.sendPrivateVoice(event.user_id, result.clip);
                                sent = true;
                            } catch (error) {
                                log(`[${event.user_id}] 唱歌：片段也没发出去（${error instanceof Error ? error.message : String(error)}）`);
                            }
                        }
                    }
                    tellOwner(sent ? pickLine(SING_LINES.done) : pickLine(SING_LINES.donePath, result.mp3));
                    log(`[${event.user_id}] 唱歌：完成 ${singBv}（语音${sent ? '已发' : '没发出去'}）`);
                }).catch(error => {
                    tellOwner(pickLine(SING_LINES.fail, '唱到一半出错了'));
                    log(`[${event.user_id}] 唱歌：出错（${error instanceof Error ? error.message : String(error)}）`);
                });
                return;
            }
        }
        if (dormancy?.isDormant()) {
            if (deviceOwner && event.user_id === deviceOwner.qq && Date.now() - lastDormantHint > 30 * 60_000) {
                lastDormantHint = Date.now();
                tellOwner('（她在休眠中，发 /唤醒 叫醒她）');
            }
            return;
        }
        // 他发「/dsh」「/工作」「/QQ」「/模式」：在 owner-commands.ts（ADR 0336 第 6 步）
        if (ownerCommandsNow.workMode(event)) return;
        // 他发的设备命令（ADR 0148）：在 owner-commands.ts（ADR 0336 第 6 步）
        if (ownerCommandsNow.device(event)) return;
        // 只从名单联系人收到的图片表情里挑；看图、判断、下载都在后台串行，不挡住这条消息的正常回复。
        if (collectingStickers && config.contacts.some(contact => contact.qq === event.user_id && contact.tier === 'boyfriend')) {
            void ownStickerWork(signal => collectingStickers.consider(event.message, { from: event.user_id, messageId: event.message_id }, { signal }));
        }
        const reader = readerFor(event.user_id);
        if (imageSearcher && config.contacts.some(c => c.qq === event.user_id) && Array.isArray(event.message)) {
            const photo = event.message.findLast(s => s.type === 'image' && !isSticker(s.data ?? {}) && typeof s.data?.url === 'string');
            if (photo && typeof photo.data?.url === 'string') recentImage.set(event.user_id, { url: photo.data.url, at: clockNow().getTime() });
        }
        // 引用的那一条不在记录里：先问 NapCat 再交给回复器（和读图、听语音走同一条串行的路）
        const quotesToFetch = missingQuotes(event.user_id, event.message);
        const forwardsToFetch = missingForwards(event.message);
        reservation.owned = true;
        reservation.id ??= stageEvent(event);
        const receipt = reservation.id;
        // A recovered storage failure must be delivered before a later live
        // conversation message, using the same per-contact inbox owner.
        if (tracksIncoming(event.user_id) && chatHistory.pendingIncoming(event.user_id).some(entry => entry.id !== receipt
            && !activeIncoming.has(entry.id) && !bufferedIncomingIds.has(entry.id))) void queueIncomingRecovery(event.user_id).catch(incomingFailure);
        const queued = inbox.get(event.user_id);
        if (!queued && !reader?.needs(event.message) && !quotesToFetch.length && !forwardsToFetch.length) {
            deliver(responder, event, event.message, receipt);
            return;
        }
        const qq = event.user_id;
        const target = responder;
        if (receipt) claimIncoming(receipt);
        // Defer media work until the previous message has fully entered the contact pipeline.
        // Starting read() before awaiting `queued` only serialized delivery and still leaked parallel OCR/vision calls.
        const job = (queued ?? Promise.resolve()).then(async () => {
            if (stopped || chatHistory.hasMessage(qq, event.message_id, sourceIdentity)) return;
            if (quotesToFetch.length) await fetchQuotes(qq, quotesToFetch);
            if (forwardsToFetch.length) await fetchForwards(qq, forwardsToFetch);
            const message = reader
                ? await reader.read(event.message, event.message_id, message => log(`[${qq}] ${message}`), { ...sourceIdentity, messageId: event.message_id, peer: qq }).catch(() => event.message)
                : event.message;
            // 读的时候补回可能已经记下了这条
            if (stopped || chatHistory.hasMessage(qq, event.message_id, sourceIdentity)) return;
            deliver(target, event, message, receipt);
        }).catch(incomingFailure).finally(() => { if (receipt) releaseIncoming(receipt); });
        inbox.set(qq, job);
        void job.then(() => { if (inbox.get(qq) === job) inbox.delete(qq); });
    }

    /** 整条消息只有文字段才返回文字（图片、语音、@、引用……一出现就不是命令）；设备命令只认这种 */
    function plainTextOf(message: Segment[] | string): string | undefined {
        if (typeof message === 'string') return message;
        if (message.length === 0 || !message.every(segment => segment.type === 'text' && typeof segment.data.text === 'string')) return undefined;
        return message.map(segment => segment.data.text as string).join('');
    }

    // 他引用的那一条、他转发的聊天记录（记录里没有的先问 NapCat）：在 quoted-context.ts（ADR 0336 第 6 步）
    const quoted = quotedContext({ transport, history, selfId: () => selfIdKnown, log });
    const { quoteLookup, missingQuotes, fetchQuotes, missingForwards, fetchForwards, forwardLookup } = quoted;

    // ───────── 群聊（ADR 0210） ─────────
    const groupsOn = (config.groupChat ?? 'off') !== 'off' && (config.groups ?? []).length > 0;
    groupLogs = groupsOn ? groupLog(config.dataDir) : undefined;
    /** 群里认识的人（2026-11-14）：聊过就记住，下次再见不能当陌生人 */
    const groupPeopleBook = groupsOn ? groupPeople(config.dataDir) : undefined;
    /** 群里的遭遇（有人夸她、冲她发火、有人想不开）也算进心境 */
    groupFeel = groupsOn ? groupAffect(config.dataDir) : undefined;
    // 群里的那一摊（攒一批再说、开口、点歌、戳、点赞、印象）在 social/group-room.ts；群消息经解释器的 group-room 模块进来（ADR 0336 第 6 步）。
    // 群记录、群里认识的人、群里的遭遇私聊那边也读，留在这里建
    const groupChat = groupRoom({
        config, exec, transport, log, worldNow, reading, dormancy, cardFor, sendOwnedNotice, sing, repoRoot,
        groupsOn, groupLogs, groupPeopleBook, groupFeel, groupSongRequests, songRequestLifetime,
        stopped: () => stopped, selfId: () => selfIdKnown, lastFeelings: () => lastFeelings,
        plainTextOf, singBusyLine: () => pickLine(SING_LINES.busy),
    });


    function deliver(responder: Responder, event: MessageEvent, message: Segment[] | string, receipt?: string): void {
        const text = segmentsToText(message, quoteLookup(event.user_id), forwardLookup(event.user_id)).trim();
        if (!text) { if (receipt) chatHistory.discardIncoming(event.user_id, receipt); return; }
        const accepted = prepareReceived(event, text, receipt);
        if (stopped || dormancy?.isDormant()) return;
        if (agencyShadow?.recordUserMessage(event.user_id, event.message_id, new Date(accepted.time), new Date(worldNow()))) {
            log(`[${event.user_id}] 世界影子：记录收到私聊（不记正文，不触发主动活动）`);
        }
        // 能让她动电脑的只有他亲手打的字（ADR 0179）：用原始消息判断，不用处理后的文本——看过的图、听过的语音会被换成一段文字，和他亲手打的混在一起
        const typed = event.user_id === deviceOwner?.qq && isTypedByHim(event.message);
        if (typed) lastUserText.set(event.user_id, text); else lastUserText.delete(event.user_id);
        if (typed && weatherEvidence && weatherPlaces && worldCard && ledgerWorld) {
            const parsed = parseWeatherObservation(text);
            if (parsed) {
                const at = new Date(accepted.time);
                const current = ledgerWorld.at(worldCard.herWorld!, worldCard.schedule!, at);
                const location = parsed.target === 'user' ? 'user'
                    : parsed.target === 'school' ? weatherPlaces.school.id
                        : parsed.target === 'home' ? weatherPlaces.home.id
                            : current ? (current.atSchool ? weatherPlaces.school.id : weatherPlaces.home.id) : undefined;
                const evidence = location ? userWeatherEvidence(location, parsed.condition, at) : undefined;
                if (evidence && weatherEvidence.append(evidence)) {
                    log(`[${event.user_id}] 天气证据：记下${parsed.target === 'user' ? '他所在地' : '她所在地'}的现场观察（有效 60 分钟，不记原话）`);
                    planners.get(event.user_id)?.poke();
                }
            }
        }
        if (event.user_id === deviceOwner?.qq && !typed && readWorkMode(config.dataDir, event.user_id) === 'work') tellOwner(NOT_TYPED_NOTICE);
        // 连续生活：他一句话会改变她的心情/关系（不挡回复）
        void noteResident({ text, from: event.user_id === deviceOwner?.qq ? 'baobao' : 'classmate' });
        // 工作模式：不进普通聊天回复器，交给 headless 的她干活，干完再回（工具桥）
        if (event.user_id === deviceOwner?.qq && typed && !text.startsWith('/') && readWorkMode(config.dataDir, event.user_id) === 'work') {
            const qq = event.user_id;
            const recent = work.recentFor(qq);
            log(`[${qq}] 工作模式：交给 dsh 干活（带 ${recent ? '最近对话' : '无'}上下文）`);
            // 他的话、她的回复都进聊天记录（ADR 0176）：原来工作模式里的来回不进记录，切回聊天后她不知道刚才说过什么
            history.append(qq, accepted);
            // 活记在他自己的 bank 里（和 QQ 聊天、DSH 桌面对话同一个），不再单独放 linmengyao
            work.handOff(qq, text, recent, () => memory?.bankId(deviceOwner), '工作桥出错');
            return;
        }
        responder.receive(accepted.content, event.message_id, new Date(accepted.time), accepted.messageSeq, accepted.incomingId);
        // 他这句在纠正她上一轮的接法（10-30 用户：让她自己学习去理解人说的话）：记下他说的、她接的、他纠正的
        // 只记男朋友档那位的（同学档说的不是“他”；记在同一个文件里会串到别人的对话里）
        if (config.selfDirectedMemory && deviceOwner && event.user_id === deviceOwner.qq && isCorrection(text)) {
            const chat = chatHistory.load(event.user_id);
            const lastHer = [...chat].reverse().find(m => m.role === 'assistant');
            const prevHis = [...chat].reverse().filter(m => m.role === 'user')[1];
            if (lastHer && prevHis) {
                recordCorrection(config.dataDir, { his: prevHis.content, her: lastHer.content, fix: text });
                log(`[${event.user_id}] 理解：他这次是在纠正上一次的接法，记下了（日志不记内容）`);
            }
        }
        exportNow();
        // 他说过的话、做过的事留痕（10-31 用户）：亲密话 / 承诺 / 他自己的事，提炼成一句她记得的事
        // 只记男朋友档那位的：traces.json 不分人，同学档说的「我喜欢你」会变成“他说喜欢我”，还会出现在别人的对话里
        if (config.selfDirectedMemory && deviceOwner && event.user_id === deviceOwner.qq) {
            const trace = traceOf(text);
            if (trace && recordTrace(config.dataDir, trace)) log(`[${event.user_id}] 痕迹：记下${trace.kind === 'affection' ? '他说的话' : trace.kind === 'promise' ? '他答应的事' : '他做过的事'}（日志不记内容）`);
        }
        syncRecalledMemory(event.user_id);
        const crisis = detectCrisis(accepted.content);
        if (crisis && config.contacts.some(c => c.qq === event.user_id)) {
            markCrisis(event.user_id, event.time * 1000, crisis.level);
            log(`[${event.user_id}] 危机信号：${crisis.level} 级（只记级别和时间，不记内容）${crisis.level === 'concern' ? '；关切级不停主动消息' : `；普通主动消息暂停 ${CRISIS_PAUSE_MS / 3_600_000} 小时`}`);
        }
        planners.get(event.user_id)?.poke();
    }

    // ───────── 休眠与连续性命令的实现（ADR 0161）─────────
    let selfIdKnown = 0;
    let lastDormantHint = 0;
    const tellOwner = (text: string): void => {
        if (stopped || !deviceOwner) return;
        sendOwnedNotice(() => transport.sendPrivateText(deviceOwner.qq, text), () => {},
            error => log(`提示没发出去（${error instanceof Error ? error.message : String(error)}）`));
    };

    // 给 DSH 的脱敏状态摘要（不带聊天原文）和灵魂目录里的 STATE.json：在 dsh-state.ts（ADR 0336 第 6 步）
    const dshStateFile = join(soulDir(), 'STATE.json');
    const { dshState, exportDshState } = dshStateSource({ dshEnabled, needsAnchor, sharedWorld, deviceOwner, history, aiPhotoDrafts, worldNow, exec, dshStateFile, log });
    // 之后每 NOW_REFRESH_MS 再写一次：由 dsh-state 模块声明（ADR 0336 第 6 步，App 搭好时开）
    if (dshEnabled) {
        exportDshState();
    } else {
        exec.files.remove(dshStateFile);
    }

    const dshRecentTurns = () => {
        if (!deviceOwner) return undefined;
        return dshConversation.recent(history.load(deviceOwner.qq));
    };

    const dshVoice = (): DshVoice | undefined => {
        try {
            const character = cardFor(deviceOwner?.tier ?? 'boyfriend').character;
            return { name: character.name, description: character.description, personality: character.personality };
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
    if (dshEnabled) {
        const ownedCompanion = createMobileCompanion({
            dsh: dshLink,
            state: dshState,
            voice: dshVoice,
            now: worldNow,
            sharedConversation: {
                recent: () => dshRecentTurns(),
                commit: (_clientId, question, reply, askedAt, repliedAt) => dshConversation.commit(question, reply, askedAt, repliedAt),
            },
            describeMedia: describeMobileMedia,
            ...(media?.voiceDataToText ? {
                transcribeVoice: async (data: Uint8Array, mime: 'audio/ogg' | 'audio/webm' | 'audio/wav' | 'audio/mp4') => {
                    const transcript = await withTimeout(media.voiceDataToText!(data, mime), MEDIA_TIMEOUTS.voice);
                    if (!transcript?.trim()) throw new Error('没有听清这段语音');
                    return transcript;
                },
            } : {}),
            onActionResult: async (result, clientId) => {
                log(`手机动作回执：设备 ${clientId}，请求 ${result.requestId}，${result.ok ? '成功' : '失败'}，决策 ${result.decision}${result.error ? `（${sanitizeDshError(result.error)}）` : ''}`);
            },
            onPhotoReviewList: async (request, clientId) => {
                const matching = aiPhotoDrafts.list(request.status);
                const items = matching.slice(-Math.min(request.limit ?? 20, 50)).reverse().map(entry => {
                    let thumbnail: { mediaId: string; mime: 'image/jpeg' | 'image/png' | 'image/webp'; bytes: number } | undefined;
                    try {
                        const preview = aiPhotoDrafts.preview(entry.id);
                        if (preview.bytes.length <= PHOTO_REVIEW_MAX_THUMBNAIL_BYTES && mobileCompanion) {
                            const record = mobileCompanion.media.put({
                                clientId, mime: preview.type, data: Buffer.from(preview.bytes), bytes: preview.bytes.length,
                            });
                            thumbnail = { mediaId: record.mediaId, mime: preview.type, bytes: record.bytes };
                        }
                    } catch { /* 文件异常时只不给预览；审核动作仍会再次失败关闭。 */ }
                    return {
                        id: entry.id, kind: entry.kind, status: entry.status, caption: entry.caption,
                        createdAt: entry.createdAt, expiresAt: aiPhotoDraftFreshness(entry, new Date(worldNow())).expiresAt,
                        ...(entry.reviewedAt ? { reviewedAt: entry.reviewedAt } : {}),
                        ...(thumbnail ? { thumbnail } : {}),
                    };
                });
                return { items, total: matching.length };
            },
            onPhotoReviewDecision: async (request, clientId, requestId) => {
                const shelf = photos ?? photoShelf({ dir: join(config.dataDir, 'photos'), log });
                const entry = request.decision === 'approve'
                    ? aiPhotoDrafts.approve(request.draftId, shelf)
                    : aiPhotoDrafts.reject(request.draftId);
                if (!entry.reviewedAt || (entry.status !== 'approved' && entry.status !== 'rejected')) throw new Error('照片审核没有完成');
                log(`手机照片审核：设备 ${clientId}，请求 ${requestId}，${entry.id} ${entry.status === 'approved' ? '已通过' : '已拒绝'}；不会自动发送`);
                return { draftId: entry.id, status: entry.status, reviewedAt: entry.reviewedAt };
            },
        });
        mobileCompanion = ownedCompanion;
        lifetime.own('mobile-companion', () => {
            const drain = ownedCompanion.stop();
            if (mobileCompanion === ownedCompanion) mobileCompanion = undefined;
            return drain;
        });
    }

    // 「/dsh ask」「/dsh talk」：在 dsh-asks.ts（ADR 0336 第 6 步）
    const dshAskQueue = dshAsks({ stopped: () => stopped, now: worldNow, link: dshLink, state: dshState, recentTurns: dshRecentTurns, voice: dshVoice, conversation: dshConversation, tellOwner });
    const askDsh = dshAskQueue.ask;
    lifetime.own('dsh-asks', () => dshAskQueue.stop());

    // 连上之后补回漏掉的消息、有没回的就回：在 missed-messages.ts（ADR 0336 第 6 步）
    const { syncMissed, catchUpAll } = missedMessages({
        config, stopped: () => stopped, transport, history, chatHistory, tierRecord, feedback, collectingStickers, ownStickerWork, readerFor, incoming, quoted, markCrisis, sensitive, cardFor, responders, log,
    });

    // 「/休眠」「/唤醒」（ADR 0161）：在 memory/dormancy-commands.ts（ADR 0336 第 6 步）
    const dormancyCommandsNow = dormancyCommands({
        config, dormancy, deviceOwner, stopped: () => stopped, selfIdKnown: () => selfIdKnown, responders, chatHistory, identity, memoryLedgerNow, noteTimeline, tellOwner, syncMissed, syncRecalledMemory,
        resume: () => {
            catchUpAll();
            startBilibiliOwners(); void watchJob();
            for (const planner of planners.values()) planner.poke();
            herPresence.reapply();
        },
        log,
    });

    // 他发的指令（只认纯文字、只认他；命中的不进聊天记录）：在 owner-commands.ts（ADR 0336 第 6 步），processMessage 按原来的先后调三段
    const ownerCommandsNow = ownerCommands({
        config, deviceOwner, dshEnabled, dshLink, setDshProbe: result => { dshProbe = result; }, mobileCompanion: () => mobileCompanion, askDsh,
        identity, memoryLedgerNow, dormancy, dormancyCommands: dormancyCommandsNow, commandReceipts, clockNow, tellOwner, plainTextOf,
        deviceService: () => devicesHost.service(), transport, sendOwnedNotice, pendingAsk, planners, log,
    });

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
            audit: entry => { try { exec.files.append(join(config.dataDir, 'account-audit.jsonl'), `${JSON.stringify(entry)}
`); } catch { /* 审计写不进去不影响动作 */ } },
        })
        : undefined;
    if (accountMode !== 'off' && !account) log('账号控制面：入口没给通用 OneBot 调用，控制面没有启动');
    if ((config.qqFriendGate ?? 'off') !== 'off' && accountMode !== 'on') log('好友申请：要 qqControl 设为 on 才处理，现在没生效');
    else if ((config.qqFriendGate ?? 'off') !== 'off') log(`好友申请：${config.qqFriendGate === 'all' ? '名单内同意、名单外驳回' : '只自动同意名单内的'}（名单 ${(config.qqAllowFriends ?? []).join('、') || '空'}）`);

    // 群消息、好友申请、戳、撤回不经这里：解释器直接交给 group-room / friend-requests / pokes / recalls 模块（ADR 0336 第 6 步）
    const legacy: Omit<App, 'receiveGroup' | 'receiveFriendRequest' | 'receivePoke' | 'receiveRecall'> = {
        async connected(selfId) {
            if (stopped) return;
            // Koishi / NapCat 可能在同一次重连期间重复发出 ready。共用正在进行的补回，
            // 避免并发拉两遍历史，并避免其中一轮先把实时消息缓冲提前放开。
            if (syncPromise) return syncPromise;
            connectedAt = new Date();
            selfIdKnown = selfId;
            if (strangers) void ensureAiSignature(selfId);
            syncing = true;
            const currentSync = syncMissed(selfId);
            syncPromise = currentSync;
            try {
                await currentSync;
            } finally {
                syncPromise = undefined;
                syncing = false;
                if (!stopped) {
                    for (const message of buffered.splice(0)) onMessage(message);
                    if (!dormancy?.isDormant()) catchUpAll();
                    syncMemory();
                    startPlanners();
                    startPresence();
                    herPresence.reapply();
                    if (!dormancy?.isDormant()) startBilibiliOwners();
                    for (const planner of planners.values()) planner.poke();
                    for (const notice of ownerNotices.splice(0)) tellOwner(notice);
                    syncFollowUps();
                    discoverStickers();
                    discoverPhotos();
                    discoverFoodPhotos();
                    void groupChat.syncNames();
                    void refreshMemeJob();
                    if (!dormancy?.isDormant()) void watchJob();
                    // 补完漏掉的消息之后：各模块连上后要做一次的事（小梗抽一次、口头习惯学一次……，ADR 0336）
                    void interpreter.dispatch({ kind: 'synced' });
                    checkWeeklyReport();
                    // 各模块的定时任务（小梗、口头习惯每 6 小时……）：只开一次
                    interpreter.startSchedules();
                }
            }
        },
        receive(event) {
            if (stopped) return;
            if (!rememberIngress(event)) return;
            lastMessageAt = new Date();
            if (syncing) {
                const snapshot = { ...event };
                if (validIncomingEvent(snapshot)) {
                    try { const receipt = stageEvent(snapshot); if (receipt) { bufferedIncoming.set(snapshot, receipt); bufferedIncomingIds.add(receipt); } }
                    catch (error) { incomingFailure(error); }
                }
                buffered.push(snapshot);
            }
            else onMessage(event);
        },
        mobileCompanion: () => mobileCompanion,
        externalDrafts: () => externalDraftStore,
        stop() {
            if (stopped) return stopDrain;
            // 每项的停法在建它的地方登记（lifetime.own），先后按 STOP_ORDER
            stopDrain = lifetime.stop();
            return stopDrain;
        },
        status() {
            // 控制台、测试时钟和导给 DSH 的 NOW.md 必须共用同一个“现在”。
            // 否则使用虚拟时钟（或宿主注入时钟）时，两端会看到不同的生活片段。
            const now = new Date(worldNow());
            const contactStatus = (contact: Contact, isUnlisted: boolean): ContactStatus => {
                const last = history.load(contact.qq).at(-1);
                const since = tierRecord.since(contact.qq);
                const { character } = cardFor(contact.tier);
                const schedule = config.schedule ? character.schedule : undefined;
                const extraFree = config.herDays ? [...readingActivities(character.books), ...herPlanActivities(config.dataDir, now, log)] : [];
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
                    .then(() => { if (!stopped) health = { at: Date.now(), ok: true }; }, error => {
                        if (!stopped) health = { at: Date.now(), ok: false, error: error instanceof Error ? error.message : String(error) };
                    })
                    .finally(() => { if (!stopped) probing = false; });
            }
            const currentHumanState = (() => {
                if (!needsAnchor) return undefined;
                try {
                    const events = sharedWorld?.events?.() ?? [];
                    const recentHistory = deviceOwner ? history.load(deviceOwner.qq).slice(-24) : [];
                    // 和给 DSH 的摘要同一套算法（human-projection.ts）
                    const { values, trends, development } = humanStateAt({ anchor: needsAnchor, events, at: now, history: recentHistory, tier: deviceOwner?.tier ?? 'boyfriend' });
                    return { values, trends, development };
                } catch (error) {
                    log(`状态页：真人式状态投影失败（${error instanceof Error ? error.message : String(error)}）`);
                    return undefined;
                }
            })();
            const extras = statusExtras();
            return {
                runtime,
                timeZone: processTimeZone(),
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
                ...(Object.keys(extras).length ? { extras } : {}),
                ...(config.memory ? { memory: { baseUrl: config.memory.baseUrl, health, ...memory!.status() } } : {}),
                ...(mobileCompanion ? { mobileCompanion: { enabled: true, ...mobileCompanion.runtime.status() } } : { mobileCompanion: { enabled: false, connected: false, queued: 0, maxQueuedPerClient: MAX_QUEUED_PER_CLIENT } }),
                ...(weather ? { weather: weather.status() } : {}),
                ...(airQuality ? { airQuality: airQuality.status() } : {}),
                ...(daylight ? { daylight: daylight.status() } : {}),
                ...(calendar ? { calendar: calendar.status() } : {}),
                ...(worldTransport ? { transport: worldTransport.status() } : {}),
                externalPlatforms: config.externalPlatforms ?? DEFAULTS.externalPlatforms,
                externalDrafts: externalDraftStore.summary(),
                dsh: { enabled: dshEnabled, ...(dshProbe ? { lastProbe: { ok: dshProbe.ok, at: dshProbe.at, model: dshProbe.model, latencyMs: dshProbe.latencyMs } } : {}) },
                ...(currentHumanState ? { humanValues: currentHumanState.values, humanTrends: currentHumanState.trends, development: currentHumanState.development } : {}),
            };
        },
    };
    // App 搭好了：开各模块「搭好就开」的定时任务（原来在构造时开的那些，ADR 0336 第 6 步；同一刻到点的按这里开的先后触发）
    interpreter.startSchedules('built');
    // 对外的入口都经解释器分发（ADR 0336 第 4 步）；停止、状态、手机伴侣、外部草稿不是事件，照旧直接给
    return {
        connected: selfId => interpreter.dispatch({ kind: 'connected', selfId }) ?? Promise.resolve(),
        receive: event => { void interpreter.dispatch({ kind: 'message', event }); },
        receivePoke: event => { void interpreter.dispatch({ kind: 'poke', event }); },
        receiveRecall: event => { void interpreter.dispatch({ kind: 'recall', event }); },
        receiveFriendRequest: request => { void interpreter.dispatch({ kind: 'friendRequest', request }); },
        receiveGroup: event => { void interpreter.dispatch({ kind: 'group', event }); },
        stop: () => legacy.stop(),
        status: () => legacy.status(),
        mobileCompanion: () => legacy.mobileCompanion(),
        externalDrafts: () => legacy.externalDrafts(),
    };
}

function herDayStatus(schedule: NonNullable<TierCard['character']['schedule']>, character: TierCard['character'], now: Date, world?: WorldNow): HerDayStatus {
    const body = character.herWorld?.body ? bodyAt(character.herWorld.body, schedule, now) : undefined;
    const mood = moodAt(schedule, character.moods, now, undefined, { body, world });
    return {
        day: formatDate(herDay(schedule, now)),
        ...(mood ? { mood: { name: mood.mood.name, reason: mood.reason } } : {}),
        ...(world ? { highlights: worldHighlights(world, now) } : {}),
        books: character.books.map(book => {
            const progress = bookProgressAt(schedule, book, now);
            return {
                title: book.title, amount: progress.amount, unit: progress.unit,
                finished: progress.finished, stopped: progress.stopped, putDown: book.progress.state === 'put_down',
            };
        }),
    };
}
