// 一个 bot 的编排：名单里每人一个回复器（contact.ts），名单外的好友按 unlisted 档（可关），连上 NapCat 时补回漏掉的消息再 catchUp，
// 定时写长期记忆，记下换档，同一个数据目录只跑一个。群聊、群临时会话由入口过滤掉，不进这里。
// 主动消息（ADR 0011）：配置 proactive 不是 off、作息开着、卡上写了 proactive 的名单联系人，各一个计划器（proactive-planner.ts）；
// 第一次补回完才开始排（之前的聊天记录不全），聊天记录变了就让它重新算。
// 她自己的日子（ADR 0015）：启动时、她的每一天第一次生成时写一行当天的心情和进度；状态页的「今天」也在这里算。
// 收发由入口传进来（ADR 0008）：独立入口 main.ts 是自写的 OneBot 客户端（onebot.ts），Koishi 插件是 adapter-onebot；
// 两边给的都是 NapCat 的原始 OneBot 数据，所以转文字（segmentsToText）、补回（findMissed）只有一份。
// 他发的语音、图片（ADR 0052）：入口给了 NapCat 的语音转文字、OCR（AppOptions.media）就先听一听、看一看再进聊天记录（media.ts），
// 每人的消息按收到的顺序一条条进；读的时候不卡别人，读不出来、超时照旧「[语音]」「[图片]」。

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { canGiveFeedback, cardKey, CONTACT_TIERS, UNLISTED_TIER, type AppConfig, type Contact, type Tier } from './config.ts';
import { chatCompletion, forExtraction } from './llm.ts';
import { acquireLock } from './lock.ts';
import type { Log } from './log.ts';
import { ChatHistory, type StoredMessage } from './history.ts';
import { asleepSince, saidBedtimes } from './bedtime.ts';
import { BACKFILL_COUNT, CATCH_UP_WINDOW_MS, newerThanStored, shouldCatchUp, toStored, type HistoryMessage } from './backfill.ts';
import { segmentsToText, type MessageEvent, type PokeEvent, type QuoteLookup, type RecallEvent, type Segment } from './onebot.ts';
import { MEDIA_TIMEOUTS, mediaReading, type ImageDescriber, type MediaReader } from './media.ts';
import type { Responder, ResponderStatus } from './responder.ts';
import { contextSummarizer } from './context-window.ts';
import { createContactResponder as createPipeline, loadTierCard, replySkip, type ContactPipelineOptions, type TierCard } from './contact.ts';
import { currentTierHistory, TierRecord } from './tier-record.ts';
import { HindsightClient } from './memory/hindsight.ts';
import { arrivedWhileAsleep } from './reply-timing.ts';
import { startHeartbeat } from './heartbeat.ts';
import { createFeedbackChannel } from './feedback.ts';
import { removeFaces } from './qq-faces.ts';
import { LongTermMemory, type MemoryEvent } from './memory/long-term.ts';
import { withFestivalActivities, withFestivals } from './festivals.ts';
import { newsKindsOf, type ProactiveMode } from './proactive.ts';
import { detectCrisis, type CrisisLevel } from './crisis.ts';
import { createCrisisState, CRISIS_PAUSE_MS } from './crisis-state.ts';
import { createPokeLimiter, POKE_BACK_COOLDOWN_MS, POKE_MAX_AGE_MS, POKE_MAX_IN_WINDOW, pokeBackPlan, pokeMessage } from './pokes.ts';
import { createProactivePlanner, newsFrom, reschedulesFrom, type Planner, type PlannerStatus } from './proactive-planner.ts';
import { PromiseStateUnavailable } from './promise-state.ts';
import { promiseKeeper, type Appointment } from './promises.ts';
import { bookProgressAt, herDayLogger, moodAt, readingActivities } from './her-days.ts';
import { bodyAt } from './body.ts';
import { worldState, type WorldNow } from './world.ts';
import { actionQueue, settlingWorld } from './action-queue.ts';
import { lifeExecutor } from './life-selector.ts';
import { loadNeedsAnchor } from './needs.ts';
import { DIARY_BACKFILL_DAYS, DIARY_TEMPERATURE, diaryWriter } from './diary.ts';
import { describeState, formatDate, herDay, stateAt, type Schedule } from './schedule.ts';
import { useRealWeather, weatherFetcher } from './weather.ts';
import { STICKER_DISCOVERY_INTERVAL_MS, type StickerShelf } from './stickers.ts';
import { SlidingWindowRateLimiter } from './rate-limit.ts';
import { sensitiveSwitch, useSensitiveSwitch, type SensitiveSwitch } from './sensitive.ts';
import { runtimeInfo, type RuntimeInfo } from './runtime-info.ts';

/** 自己过日子的执行器多久推一次（ADR 0040） */
const LIFE_TICK_MS = 10 * 60_000;

/** 写一次长期记忆的间隔 */
export const MEMORY_SYNC_MS = 5 * 60_000;
/** 真实天气多久取一次（ADR 0048） */
export const WEATHER_REFRESH_MS = 30 * 60_000;

/** 入口提供的收发 */
export interface Transport {
    /** 发一条私聊文字，返回 QQ 消息 id；文字里白名单的小黄脸「[捂脸]」发成 face 段（qq-faces.ts textToSegments，ADR 0051） */
    sendPrivateText(userId: number, text: string): Promise<number>;
    /** 让对方那边显示「正在输入…」（配置 typingStatus，ADR 0077）；没有就不显示 */
    setInputStatus?(userId: number, eventType?: number): Promise<void>;
    /** 戳他一下（NapCat 的 friend_poke，配置 pokeBack）；没有就不戳 */
    pokeFriend?(userId: number): Promise<void>;
    /** 发本地图片表情；配置 stickers 开时两个入口都提供。 */
    sendPrivateImage?(userId: number, file: string, summary: string): Promise<number>;
    /** NapCat 的 get_friend_msg_history：某人最近 count 条私聊（含小号自己发的），从旧到新。没有任何记录时 NapCat 也报错 */
    friendHistory(userId: number, count: number): Promise<HistoryMessage[]>;
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
    /** 允许发图片表情的轮次里抽中发的概率（不写按 STICKER_TURN_CHANCE；测试用）*/
    stickerChance?: number;
    /** 测试用：换掉听、看各项的上限 */
    mediaTimeouts?: Partial<typeof MEDIA_TIMEOUTS>;
    /** 敏感调试开关（ADR 0070 第 8 项）；不传按环境变量 QQBOT_SENSITIVE_LOGS（默认关） */
    sensitive?: SensitiveSwitch;
}

/** 名单外的人在提示词里的称呼（{{user}}）：QQ 昵称，没有就叫「对方」 */
export function unlistedName(nickname: string | undefined): string {
    return nickname?.trim() || '对方';
}

export function startApp({ config, transport, log, pipeline, media, vision, stickers, stickerChance, mediaTimeouts, sensitive = sensitiveSwitch() }: AppOptions): App {
    const runtime = runtimeInfo();
    useSensitiveSwitch(sensitive);
    log(sensitive.describe());
    // 关着的时候不留上次开着时的完整提示词
    if (!sensitive.on()) rmSync(join(config.dataDir, 'last-prompt.json'), { force: true });
    // 每个档位一张角色卡和一本世界书，用到时读一次；不知道她是程序的联系人用「<档位>-open」承认版（ADR 0067，cardKey）
    let typingFailed = false;
    const cards = new Map<string, TierCard>();
    const cardFor = (tier: string) => {
        let card = cards.get(tier);
        if (!card) {
            card = loadTierCard(config.characterCard, tier);
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
    for (const tier of new Set<string>([...tiersInUse, ...config.contacts.map(cardKey)])) {
        const { character, worldInfo } = cardFor(tier);
        log(`档位 ${tier}：角色 ${character.name}，世界书 ${character.world || '无'}（${worldInfo.length} 条）`);
    }
    const whitelist = config.contacts.map(c => `${c.qq}（${c.name}，${c.tier}，${c.knowsBot === true ? '知道她是程序' : '按不知道处理：被认真问到会承认'}）`).join('、');
    log(`名单：${whitelist}；名单外的好友${config.unlistedFriends ? '按 unlisted 档回复' : '不回复'}`);
    log(`出口检查：做不到的事、禁用词${config.speechCheck ? '、说话的毛病（助手腔、算账、怪对方没说、重复、一段里叮嘱两遍）' : '（说话的毛病不查，配置 speechCheck: false）'}`);
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

    // 长期记忆（Hindsight）：补回之后写一次，之后每隔一段时间把结束了的片段写进去
    const hindsight = config.memory ? new HindsightClient(config.memory.baseUrl, config.memory.timeoutMs) : undefined;
    const memory = config.memory
        ? new LongTermMemory({
            api: hindsight!,
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
            herDays: config.herDays,
            candidates: config.candidates,
            ...contextWindowFor(contact),
            ...(sendingStickers && contact.tier === 'boyfriend' ? { stickers: sendingStickers } : {}),
            ...(stickerChance !== undefined ? { stickerChance } : {}),
            ...(noteHerDay ? { onHerDay: noteHerDay } : {}),
            history,
            memory,
            ...(promises ? { promises } : {}),
            ...(sharedWorld ? { worldState: sharedWorld } : {}),
            ...(config.projectChoice && lifeRunner ? { projectChoice: true } : {}),
            ...(config.lifeInPrompt && lifeRunner ? { lifeInPrompt: true } : {}),
            ...(config.grievance ? { grievance: true } : {}),
            contacts: config.contacts,
            // 带小黄脸的发送失败（QQ / NapCat 不收那个 face 段）就去掉表情再发一次纯文字，免得整轮回复失败、重试几次后不回了（ADR 0051）；
            // 超时不重发：可能已经发出去了，再发就重复
            // 她打字的这段时间对方那边显示「正在输入…」（ADR 0077，配置 typingStatus，默认关）；出错只记一次日志，不影响发送
            ...(config.typingStatus && transport.setInputStatus ? { typing: (userId: number) => { transport.setInputStatus!(userId).catch(error => { if (!typingFailed) { typingFailed = true; log(`[${userId}] 显示「正在输入」失败（之后不再记）：${error instanceof Error ? error.message : String(error)}`); } }); } } : {}),
            send: async (userId, text) => {
                const sticker = contact.tier === 'boyfriend' ? sendingStickers?.resolve(text) : undefined;
                if (sticker) {
                    const id = await transport.sendPrivateImage!(userId, sticker.file, `[${sticker.description}]`);
                    sendingStickers!.used(sticker.id);
                    return id;
                }
                try {
                    return await transport.sendPrivateText(userId, text);
                } catch (error) {
                    const reason = error instanceof Error ? error.message : String(error);
                    const plain = removeFaces(text, face => face !== undefined);
                    if (plain === text || !plain || /timeout|timed out|超时/i.test(reason)) throw error;
                    log(`[${userId}] 带小黄脸的消息没发出去（${reason}），去掉表情再发一次`);
                    return transport.sendPrivateText(userId, plain);
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

    /** 主动消息的计划器：第一次补回完才建 */
    const planners = new Map<number, Planner>();
    function startPlanners(): void {
        if (planners.size || config.proactive === 'off') return;
        for (const contact of proactiveContacts) {
            const { character } = cardFor(contact.tier);
            planners.set(contact.qq, createProactivePlanner({
                contact,
                schedule: character.schedule!,
                settings: character.proactive!,
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
                asleep: now => Boolean(asleepSince(character.schedule!, bedtimes(character.schedule!, now), new Date(now))),
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
                        kinds: newsKindsOf(character.proactive!),
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

    return {
        async connected(selfId) {
            if (stopped) return;
            connectedAt = new Date();
            syncing = true;
            try {
                await syncMissed(selfId);
            } finally {
                syncing = false;
                if (!stopped) {
                    for (const message of buffered.splice(0)) onMessage(message);
                    catchUpAll();
                    syncMemory();
                    startPlanners();
                    for (const planner of planners.values()) planner.poke();
                    syncFollowUps();
                    discoverStickers();
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
            if (followUpTimer) clearInterval(followUpTimer);
            if (lifeTimer) clearInterval(lifeTimer);
            if (weatherTimer) clearInterval(weatherTimer);
            if (stickerDiscoveryTimer) clearInterval(stickerDiscoveryTimer);
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
                herDays: config.herDays,
                ...(herDaysCard ? { today: herDayStatus(herDaysCard.schedule!, herDaysCard, now,
                    herDaysCard.herWorld && sharedWorld ? sharedWorld.at(herDaysCard.herWorld, herDaysCard.schedule!, now) : undefined) } : {}),
                proactive: config.proactive,
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
