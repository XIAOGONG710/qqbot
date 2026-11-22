// Koishi 插件（ADR 0008）：adapter-onebot + packages/bot 的 app.ts。这里只做接线：
// - 配置 Schema（控制台表单，ADR 0009），转成和 runtime/bot/config.json 同形的对象，走同一个 parseAppConfig；
// - 中间件插到最前面，NapCat 的直接私聊交给 app（不调 next，别的插件看不到），其余放行；
// - 发送、补回走适配器的原始 OneBot 接口（和 onebot.ts 发的是同一个请求）；
// - 连上就补回；adapter-onebot 6.9.4 断线后不会自己重连（上游 PR #81），这里按退避调 bot.start()；
// - 角色卡、世界书文件变了就重启插件（和控制台改配置一样：旧的停掉，新的按聊天记录 catchUp）。
// 模型 key 只从环境变量 QQBOT_LLM_API_KEY 读。

import type * as Koishi from 'koishi';
import type { Bot, Context, Session } from 'koishi';
import { watch } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp, type Transport } from '../../bot/src/platform/app.ts';
import type { MobileCompanionIntegration } from '../../bot/src/mobile-companion-dsh.ts';
import { attachCompanionWebSocket, type CompanionWebSocketLike } from '@qqbot/mobile-companion/websocket';
import { createCompanionKoaActionPollHandler, createCompanionKoaEnvelopeHandler, createCompanionKoaMediaHandler } from '@qqbot/mobile-companion/koa';
import type { HistoryMessage } from '../../bot/src/memory/backfill.ts';
import type { WebMode } from '../../bot/src/platform/web.ts';
import { CONTACT_TIERS, DEFAULTS, parseAppConfig, type AppConfig, type ContactTier, type StickerMode } from '../../bot/src/platform/config.ts';
import { createLog, type Log } from '../../bot/src/platform/log.ts';
import { createPromptManifestLog } from '../../bot/src/platform/prompt-manifest.ts';
import { FEATURES, featureDetail, type FeatureDef } from '../../bot/src/platform/features.ts';
import { type FactCheckMode } from '../../bot/src/language/fact-check.ts';
import { QZONE_VISIBILITIES, type PresenceMode, type QzoneVisibility } from '../../bot/src/social/presence.ts';
import { type GroupAgencyMode, type GroupChatMode, type GroupOwnMode } from '../../bot/src/platform/config.ts';
import { readQzoneFeed } from '../../bot/src/social/qzone-feed.ts';
import { readFriendsFeed } from '../../bot/src/social/qzone-feeds3.ts';
import { sessionFromCookies } from '../../bot/src/social/qzone-remote.ts';
import { readStrangerFeed } from '../../bot/src/social/qzone-strangers.ts';
import { type ControlMode, type FriendGate } from '../../bot/src/social/account.ts';
import { assertKernelOk, isFriendRecall, isGroupMessage, isPokeAtMe, isPrivateFriendMessage, replySegment, type OneBotEvent } from '../../bot/src/platform/onebot.ts';
import { ocrLines, type MediaReader } from '../../bot/src/vision/media.ts';
import { textToSegments } from '../../bot/src/language/qq-faces.ts';
import { type FestivalMode } from '../../bot/src/world/festivals.ts';
import { type ProactiveMode } from '../../bot/src/proactive/proactive.ts';
import { PROMPT_POST_PROCESSING, type PromptPostProcessing } from '../../bot/src/st/prompt-converters.ts';
import { configuredImageDescriber, STICKER_VISION_PROMPT } from '../../bot/src/vision/vision.ts';
import { stickerDecider, stickerShelf } from '../../bot/src/social/stickers.ts';
import { qqFavorites } from '../../bot/src/social/sticker-favorites.ts';
import { bqbDiscover } from '../../bot/src/social/sticker-sources.ts';
import { biliStickerScreen } from '../../bot/src/language/bili-stickers.ts';
import { webFoodSource, webPhotoSource } from '../../bot/src/vision/photo-sources.ts';
import { characterPaths, registerConsole, setConsoleState } from './console.ts';
import { EXTERNAL_PLATFORM_MODES, type ExternalPlatformMode } from '../../bot/src/social/external-platforms.ts';
import { claimTimeZone, DEFAULT_TIME_ZONE, timeZoneChoices } from '../../bot/src/platform/time-zone.ts';

// koishi 的 ESM 入口是坏的（@koishijs/loader/lib/index.mjs 默认导入了一个 CJS 文件）：取 loader 自己用的那份 CJS
const { Schema } = createRequire(import.meta.url)('koishi') as typeof Koishi;
/** @satorijs/protocol 的 Status：类型里是 const enum，按值比较 */
const OFFLINE = 0;
const ONLINE = 1;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export const name = 'qqbot';
// apply 在实例（fork）里运行：配置有误、apply 抛错时，控制台侧栏把插件标成失败（红点）。
// 不是 reusable 时只有插件主体失败，控制台看的实例仍是绿点，还弹「配置已重载」（ADR 0009 试验结果第 2 条）
export const reusable = true;
// Koishi 通用的「过滤器设置」对这个插件没用。不导出 usage：用户不要页面顶部那段说明（10-05）
export const filter = false;

export interface CompanionServerLike {
    ws(path: string, callback: (socket: CompanionWebSocketLike) => void): { close(): void };
    get?(path: string, callback: (ctx: unknown) => Promise<void>): unknown;
    post?(path: string, callback: (ctx: unknown) => Promise<void>): unknown;
}

/** Koishi 不同版本对路由句柄的返回类型不一致；能关闭就关闭，旧版本没有句柄时保持兼容。 */
function closeCompanionRoute(handle: unknown): void {
    if (!handle || typeof handle !== 'object') return;
    const route = handle as { close?: unknown; dispose?: unknown };
    if (typeof route.close === 'function') { route.close(); return; }
    if (typeof route.dispose === 'function') route.dispose();
}

/** 纯接线函数：便于测试，也避免在插件入口散落端口 / DSH 判断。 */
export function mountMobileCompanion(server: CompanionServerLike | undefined, companion: MobileCompanionIntegration | undefined, options: { enabled: boolean; websocketPath: string; httpPath?: string }, log: Log): (() => void) | undefined {
    if (!options.enabled) return undefined;
    if (!companion) { log('手机伴侣：开关已开，但 DSH 关闭，未挂载 WebSocket'); return undefined; }
    if (!server) { log('手机伴侣：开关已开，但 Koishi server 服务不可用，未挂载 WebSocket'); return undefined; }
    const layer = server.ws(options.websocketPath, socket => attachCompanionWebSocket(socket, companion.runtime));
    const routes: unknown[] = [];
    log(`手机伴侣：WebSocket 已挂载到 ${options.websocketPath}（沿用 DSH 配对和动作审计）`);
    if (server.post && options.httpPath) {
        routes.push(server.post(options.httpPath, createCompanionKoaEnvelopeHandler(companion.runtime, { path: options.httpPath }) as unknown as (ctx: unknown) => Promise<void>));
        const mediaHandler = markNoParseBody(createCompanionKoaMediaHandler(companion.runtime, companion.media, { path: `${options.httpPath}/media` }));
        routes.push(server.post(`${options.httpPath}/media`, mediaHandler as unknown as (ctx: unknown) => Promise<void>));
        log(`手机伴侣：HTTPS envelope / 媒体上传已挂载到 ${options.httpPath}（沿用 session 和内存媒体仓库）`);
    }
    if (server.get && options.httpPath) {
        const mediaReadHandler = createCompanionKoaMediaHandler(companion.runtime, companion.media, { path: `${options.httpPath}/media` });
        routes.push(server.get(`${options.httpPath}/media`, mediaReadHandler as unknown as (ctx: unknown) => Promise<void>));
        routes.push(server.get(`${options.httpPath}/actions`, createCompanionKoaActionPollHandler(companion.runtime, { path: `${options.httpPath}/actions` }) as unknown as (ctx: unknown) => Promise<void>));
        log(`手机伴侣：HTTPS 缩略图读取 / 动作轮询已挂载（仅限已配对设备）`);
    }
    return () => {
        layer.close();
        for (const route of routes) closeCompanionRoute(route);
    };
}

/** Koishi server 默认会先跑 koa-body；媒体路由必须保留原始二进制流给 readBody()。 */
function markNoParseBody<T extends (...args: any[]) => unknown>(handler: T): T {
    Object.defineProperty(handler, Symbol.for('noParseBody'), { value: true });
    return handler;
}

const TIER_LABELS: Record<ContactTier, string> = {
    boyfriend: '男朋友',
    bestie: '闺蜜',
    girl_friend: '女生熟人',
    known: '熟人',
    classmate: '同学',
    stranger: '陌生人',
};

/** 思考（DeepSeek 的 thinking / reasoning_effort，ADR 0009 A4）；不选 = 两个参数都不传，用接口默认 */
export const THINKING = ['off', 'low', 'high', 'max'] as const;
export type Thinking = (typeof THINKING)[number];
const THINKING_LABELS: Record<Thinking, string> = { off: '关', low: '低', high: '高', max: '最高' };

const QZONE_LABELS: Record<QzoneVisibility, string> = { friends: '仅好友可见', public: '所有人可见' };
const EXTERNAL_PLATFORM_LABELS: Record<ExternalPlatformMode, string> = { off: '关闭', draft: '只生成草稿', authorized: '官方授权模式（需适配器）' };

const POST_PROCESSING_LABELS: Record<PromptPostProcessing, string> = {
    '': '不处理',
    merge: 'merge：合并相邻的同角色消息',
    semi: 'semi：角色交替（DeepSeek 用这个）',
    strict: 'strict：用户开头、角色交替',
};

// 功能开关在配置页上的那一项（ADR 0336 第 6 步）：类型、默认值、说明、几档模式的选项都从功能总表（bot 的 platform/features.ts）来，
// 这里只排配置页上的先后。功能总表以外的配置（模型、联系人、数值……）照旧在下面手写。
const FEATURE_DEFS = new Map(FEATURES.map(def => [def.key, def]));
function featureDef(key: string): FeatureDef {
    const def = FEATURE_DEFS.get(key);
    if (!def) throw new Error(`功能总表里没有「${key}」`);
    return def;
}
/** 配上功能总表里这一项的说明（没写说明的照旧不配） */
function described<T>(schema: Koishi.Schema<T>, key: string): Koishi.Schema<T> {
    const detail = featureDetail(featureDef(key));
    return detail === undefined ? schema : schema.description(detail);
}
const defaultOf = <K extends keyof Config>(key: K) => (DEFAULTS as unknown as Record<string, unknown>)[key] as Config[K];
/** 开 / 关的开关 */
const toggle = <K extends keyof Config>(key: K): Koishi.Schema<Config[K]> =>
    described(Schema.boolean().default(defaultOf(key) as boolean), key) as unknown as Koishi.Schema<Config[K]>;
/** 几档模式的开关：下拉框的每一档和它的说法也在功能总表里 */
const choice = <K extends keyof Config>(key: K): Koishi.Schema<Config[K]> => {
    const labels = featureDef(key).modeLabels;
    if (!labels) throw new Error(`功能总表里「${key}」没写 modeLabels`);
    return described(Schema.union(Object.entries(labels).map(([value, label]) => Schema.const(value).description(label))).default(defaultOf(key) as string), key) as unknown as Koishi.Schema<Config[K]>;
};

const MEMORY_BASE_URL = 'http://127.0.0.1:8899';
const CHARACTER_CARD = 'characters/linmengyao/st/linmengyao-{tier}.json';
/** 不能是空串或只有空白（表单上直接提示） */
const NOT_BLANK = /\S/;

/** QQ 号的下拉选项（小号的好友列表），插件连上 NapCat 后生成 */
const FRIENDS_SCHEMA = 'qqbot.friends';
const QQ_DESCRIPTION = '**QQ 号**：从小号的好友里选';

export interface Config {
    contacts: { qq: number; name: string; tier: ContactTier; persona?: string; intro?: string; knowsBot?: boolean; feedback?: boolean }[];
    unlistedFriends: boolean;
    schedule: boolean;
    timeZone?: string;
    media: boolean;
    stickers: StickerMode;
    vision: { enabled: boolean; baseUrl?: string; model?: string; timeoutMs?: number };
    moody: boolean;
    speechCheck: boolean;
    herDays: boolean;
    autonomousLife: boolean;
    projectChoice: boolean;
    lifeInPrompt: boolean;
    grievance: boolean;
    npcAsks: boolean;
    pokes: boolean;
    recalls: boolean;
    pokeBack: boolean;
    pokeOut: boolean;
    readReceipts: boolean;
    bilibili: PresenceMode;
    bilibiliAccount: boolean;
    biliFeed: PresenceMode;
    bilibiliComment: PresenceMode;
    bilibiliDm: PresenceMode;
    bilibiliReplies: PresenceMode;
    bilibiliCommentKeywords: string[];
    shape: boolean;
    shapeAgenda: boolean;
    shapeFiller: boolean;
    shapeFeel: boolean;
    proactiveReach: boolean;
    proactiveInvite: boolean;
    photos: boolean;
    aiPhotos: boolean;
    photoShares: boolean;
    together: boolean;
    comeBack: boolean;
    relationship: boolean;
    jokes: boolean;
    interruptions: boolean;
    proactiveAsk: boolean;
    hisHours: boolean;
    weeklyReport: boolean;
    jealousy: boolean;
    proactiveRoom: boolean;
    menu: boolean;
    curious: boolean;
    smallNews: boolean;
    foodPhotos: boolean;
    memes: boolean;
    watching: boolean;
    texture: boolean;
    biliStickers: boolean;
    quoteReply: boolean;
    idioms: boolean;
    tailCap: boolean;
    deviceControl: PresenceMode;
    deviceLinks: string[];
    deviceApps: string[];
    factCheck: FactCheckMode;
    innerLife: boolean;
    adultSiteUrls: string[];
    herFeelings: boolean;
    herNo: boolean;
    afterNo: boolean;
    lagTail: boolean;
    everydayLife: boolean;
    worldDrama: boolean;
    worldThreads: boolean;
    diaryLookback: boolean;
    memoryFeelings: boolean;
    realNights: boolean;
    chatReview: boolean;
    pursuits: boolean;
    shapeSplit: boolean;
    shapeAsk: boolean;
    shapeLong: boolean;
    deliberate: boolean;
    deliberateModel: string;
    identityLedger: boolean;
    memoryAudit: boolean;
    dormancy: boolean;
    timeline: boolean;
    webLookup: WebMode;
    tastes: boolean;
    acquaintances: boolean;
    bilibiliAtName: string;
    bilibiliAtUid: number;
    reactions: boolean;
    onlineStatus: boolean;
    profileLikes: boolean;
    signature: PresenceMode;
    qzone: PresenceMode;
    qzoneVisibility: QzoneVisibility;
    qzoneBrowse: PresenceMode;
    qzonePeek: PresenceMode;
    qzoneStrangers: PresenceMode;
    groupChat: GroupChatMode;
    groupOwn: GroupOwnMode;
    groupAgency: GroupAgencyMode;
    groups: { id: number; name: string; knowsBot?: boolean; disguise?: boolean; cover?: string }[];
    qqControl: ControlMode;
    qqFriendGate: FriendGate;
    qqAllowFriends: number[];
    qqAllowGroups: number[];
    qqDangerous: boolean;
    feedbackCommands: boolean;
    realWeather: boolean;
    realAirQuality?: boolean;
    realDaylight?: boolean;
    realCalendar?: boolean;
    realTransport: { enabled: boolean; endpoint?: string; source?: string };
    festivals: FestivalMode;
    typingStatus: boolean;
    selfRecall: boolean;
    selfDirectedMemory: boolean;
    silenceNotice: boolean;
    crossRecent: boolean;
    selfExport: boolean;
    selfReceipts: boolean;
    ownDays: boolean;
    desktopDay: boolean;
    desktopReview: boolean;
    desktopPromises: boolean;
    oneDiary: boolean;
    desktopConflict: boolean;
    selfPursuits: boolean;
    speechNotes: boolean;
    diaryInsights: boolean;
    selfPortrait: boolean;
    fewerRules: boolean;
    feelingReview: boolean;
    ownerPeek: boolean;
    memoryReconcile: boolean;
    depthRouting: boolean;
    factHim: boolean;
    readStickers: boolean;
    readingTakes: boolean;
    hisReactions: boolean;
    herGuesses: boolean;
    openQuestions: boolean;
    exemplars: boolean;
    rhythm: boolean;
    shortReplies: boolean;
    candidates: number;
    contextTurns: number;
    contextContacts: number[];
    proactive: ProactiveMode;
    llm: {
        baseUrl: string;
        model: string;
        thinking?: Thinking;
        temperature: number;
        maxTokens: number;
        timeoutMs: number;
        promptPostProcessing: PromptPostProcessing;
        /** JSON 文本 */
        extraBody: string;
    };
    dsh: { enabled: boolean; baseUrl?: string; model?: string; timeoutMs?: number };
    externalPlatforms: { tieba: ExternalPlatformMode; douyin: ExternalPlatformMode; xiaohongshu: ExternalPlatformMode };
    mobileCompanion: { enabled: boolean; websocketPath: string; httpPath: string };
    prompt: {
        maxContext: number;
        pinExamples: boolean;
        worldInfo: { depth: number; budgetPercent: number; budgetCap: number; includeNames: boolean; caseSensitive: boolean; matchWholeWords: boolean };
    };
    memory: { enabled: boolean; baseUrl?: string; timeoutMs?: number; recallTimeoutMs?: number; bankPrefix?: string };
    characterCard: string;
    dataDir: string;
}

// 键名不改（旧的 koishi.yml 要能读）；控制台把键名当标题，中文名放在说明的开头。
// 默认值都来自 config.ts 的 DEFAULTS，表单里显示的就是实际在用的值；等于默认值的项不写进 koishi.yml。
// 每个对象只放在一个组里：拆到两个组的话，schema.simplify（loader 写回、控制台的「按 JSON 编辑」都用它）
// 会用后一组的整个对象盖掉前一组的。只有嵌套的对象能折叠（ADR 0009 试验结果第 4 条）。
export const Config: Koishi.Schema<Config> = Schema.intersect([
    Schema.object({
        contacts: Schema.array(Schema.object({
            // 说明写在动态 schema 上（它会顶替这里的说明）
            qq: Schema.dynamic(FRIENDS_SCHEMA),
            name: Schema.string().required().pattern(NOT_BLANK).description('**称呼**：提示词里的 {{user}}'),
            tier: Schema.union(CONTACT_TIERS.map(tier => Schema.const(tier).description(TIER_LABELS[tier]))).required()
                .description('**档位**：按这一档的角色卡回复（ADR 0003）。换档后，之前的聊天记录不再进提示词'),
            persona: Schema.string().role('textarea', { rows: [2, 8] }).description('**他是谁**：一两句，可选'),
            knowsBot: Schema.boolean()
                .description('**知道她是程序**（ADR 0067 / 0208）：勾上＝这个人知道，被认真问到是不是 AI 时说不说由她自己决定；不勾或没写＝按不知道处理，被认真问到时承认'),
            feedback: Schema.boolean()
                .description('**可以对她的话打分**（ADR 0073）：勾上＝这个人发只有「假」或「像」一个字的消息时，记下她那一轮话是「假」还是「像」，不当聊天、她不回应。男朋友档不用勾；其余档位只对勾了的人生效，要先让他知道有这个功能。还要打开上面的「反馈通道」总开关'),
            intro: Schema.string().role('textarea', { rows: [1, 4] })
                .description('**别人提起时**：她认识的这个人，一两句（例如「网上认识的朋友，比较熟」）。名单里别人说起他的称呼时给她看，留空就是不认识（ADR 0016）'),
        })).description('**回复名单**：每人按自己的档位回复'),
        unlistedFriends: toggle('unlistedFriends'),
        schedule: toggle('schedule'),
        timeZone: Schema.union([
            ...timeZoneChoices().map(choice => Schema.const(choice.zone).description(choice.label)),
            Schema.string().description('其他（填 IANA 时区名）'),
        ]).default(DEFAULT_TIME_ZONE)
            .description('**她的时区**（ADR 0331，一般不用改）：作息、饭点、日记的日界都按这个时区算，跟机器的系统时区无关。'
                + '下拉里是全部 IANA 时区（常用的在前，其余按 UTC 偏移排，括号里是此刻的偏移，夏令时由系统自己换）；列表里没有的选「其他」手填'),
        media: toggle('media'),
        stickers: choice('stickers'),
        vision: Schema.intersect([
            Schema.object({ enabled: Schema.boolean().default(false).description('**看懂图片内容**（DeepSeek，ADR 0055）') }),
            Schema.union([
                Schema.object({
                    enabled: Schema.const(true).required(),
                    baseUrl: Schema.string().default(DEFAULTS.vision.baseUrl).pattern(NOT_BLANK).description('**接口地址**：一般不用改，复用模型页的 QQBOT_LLM_API_KEY'),
                    model: Schema.string().default(DEFAULTS.vision.model).pattern(NOT_BLANK).description('**模型名**：deepseek-flash 支持图片'),
                    timeoutMs: Schema.natural().min(1).default(DEFAULTS.vision.timeoutMs).description('**看图超时**（毫秒）：失败就退回只知道是图片'),
                }),
                Schema.object({}),
            ]),
        ]).description('普通照片和截图会发给 DeepSeek；图上的字仍同时走 NapCat OCR。图片表情在上面选择 collect/send 后也会看图，用于收藏判断。'),
        moody: toggle('moody'),
        speechCheck: toggle('speechCheck'),
        herDays: toggle('herDays'),
        autonomousLife: toggle('autonomousLife'),
        projectChoice: toggle('projectChoice'),
        lifeInPrompt: toggle('lifeInPrompt'),
        pokes: toggle('pokes'),
        recalls: toggle('recalls'),
        bilibili: choice('bilibili'),
        biliFeed: choice('biliFeed'),
        bilibiliAccount: toggle('bilibiliAccount'),
        bilibiliComment: choice('bilibiliComment'),
        bilibiliDm: choice('bilibiliDm'),
        bilibiliReplies: choice('bilibiliReplies'),
        bilibiliCommentKeywords: Schema.array(Schema.string()).default([...DEFAULTS.bilibiliCommentKeywords])
            .description('**评论的话题关键词**（ADR 0092）：填了，评论就不再跟着分享走，而是她自己每天按其中一个关键词搜视频（比如「大肥鱼 插件」「DSH 插件」「deepseek harness」），在播放多的前几个里挑一个，读字幕和热评后评论并 @ 他。不看分区，所以 AI 视频、DSH 插件视频搜得到；约一半的日子想评论一次，仍受「隔至少一天、一周最多 3 条」管。前期专评 AI 视频和 DSH 插件视频用。不填就是老样子（分享之后在那个视频下评论）。最多 10 个，每个不超过 30 个字'),
        shape: toggle('shape'),
        shapeAgenda: toggle('shapeAgenda'),
        shapeFiller: toggle('shapeFiller'),
        shapeFeel: toggle('shapeFeel'),
        proactiveReach: toggle('proactiveReach'),
        proactiveInvite: toggle('proactiveInvite'),
        photos: toggle('photos'),
        aiPhotos: toggle('aiPhotos'),
        photoShares: toggle('photoShares'),
        together: toggle('together'),
        comeBack: toggle('comeBack'),
        relationship: toggle('relationship'),
        jokes: toggle('jokes'),
        interruptions: toggle('interruptions'),
        proactiveAsk: toggle('proactiveAsk'),
        hisHours: toggle('hisHours'),
        weeklyReport: toggle('weeklyReport'),
        jealousy: toggle('jealousy'),
        proactiveRoom: toggle('proactiveRoom'),
        menu: toggle('menu'),
        curious: toggle('curious'),
        smallNews: toggle('smallNews'),
        foodPhotos: toggle('foodPhotos'),
        memes: toggle('memes'),
        watching: toggle('watching'),
        texture: toggle('texture'),
        biliStickers: toggle('biliStickers'),
        quoteReply: toggle('quoteReply'),
        idioms: toggle('idioms'),
        deviceControl: choice('deviceControl'),
        deviceLinks: Schema.array(Schema.string()).default([...DEFAULTS.deviceLinks])
            .description('他登记的网页（她只能说名字），每行“名字=https://地址”，最多 8 个；电脑上的 device-agent.config.json 里也要有同名的才会打开'),
        deviceApps: Schema.array(Schema.string()).default([...DEFAULTS.deviceApps])
            .description('他登记的应用名字，最多 8 个；电脑上的 device-agent.config.json 里要有同名的路径才会打开'),
        tailCap: toggle('tailCap'),
        factCheck: choice('factCheck'),
        innerLife: toggle('innerLife'),
        adultSiteUrls: Schema.array(Schema.string()).default([...DEFAULTS.adultSiteUrls])
            .description('成人网站访问。填写允许访问的 HTTPS 网页地址，留空关闭。需要内心、主动消息和自主生活。'),
        herFeelings: toggle('herFeelings'),
        afterNo: toggle('afterNo'),
        herNo: toggle('herNo'),
        lagTail: toggle('lagTail'),
        everydayLife: toggle('everydayLife'),
        chatReview: toggle('chatReview'),
        realNights: toggle('realNights'),
        memoryFeelings: toggle('memoryFeelings'),
        diaryLookback: toggle('diaryLookback'),
        worldThreads: toggle('worldThreads'),
        worldDrama: toggle('worldDrama'),
        pursuits: toggle('pursuits'),
        shapeSplit: toggle('shapeSplit'),
        shapeAsk: toggle('shapeAsk'),
        shapeLong: toggle('shapeLong'),
        deliberate: toggle('deliberate'),
        deliberateModel: Schema.string().default(DEFAULTS.deliberateModel)
            .description('深思轮次用的模型名（和聊天用的同一个接口）。默认 deepseek-v4-pro'),
        identityLedger: toggle('identityLedger'),
        memoryAudit: toggle('memoryAudit'),
        timeline: toggle('timeline'),
        webLookup: choice('webLookup'),
        dormancy: toggle('dormancy'),
        tastes: toggle('tastes'),
        acquaintances: toggle('acquaintances'),
        bilibiliAtName: Schema.string().default(DEFAULTS.bilibiliAtName)
            .description('**要 @ 的人的 B 站昵称**（ADR 0089）：评论最前面会写 @昵称；不含 @ 和换行'),
        bilibiliAtUid: Schema.number().default(DEFAULTS.bilibiliAtUid)
            .description('**他的 B 站 uid**（ADR 0089）：@ 评论（要昵称和 uid 两样）和发私信（只要 uid）都用；在 B 站网页「个人空间」的网址里能看到'),
        readReceipts: toggle('readReceipts'),
        reactions: toggle('reactions'),
        onlineStatus: toggle('onlineStatus'),
        profileLikes: toggle('profileLikes'),
        signature: choice('signature'),
        qzone: choice('qzone'),
        qzoneVisibility: Schema.union(QZONE_VISIBILITIES.map(mode => Schema.const(mode).description(QZONE_LABELS[mode]))).default(DEFAULTS.qzoneVisibility)
            .description('**说说谁能看**（ADR 0083）：仅好友（默认）；所有人可见会让陌生人看到，也可能被「空友爱看」收录并收到好友申请'),
        qzoneBrowse: choice('qzoneBrowse'),
        qzonePeek: choice('qzonePeek'),
        qzoneStrangers: choice('qzoneStrangers'),
        groupChat: choice('groupChat'),
        groupOwn: choice('groupOwn'),
        groupAgency: choice('groupAgency'),
        groups: Schema.array(Schema.object({
            id: Schema.natural().required().description('**群号**'),
            name: Schema.string().required().pattern(NOT_BLANK).description('**群名**：给她看的，比如「宿舍群」'),
            knowsBot: Schema.boolean().description('**群里的人都知道她是 AI**：勾上＝被认真问是不是 AI 时由她自己决定；不勾＝按不知道，认真问到就承认（ADR 0067 / 0208 / 0210）'),
            disguise: Schema.boolean().description('**装成真人**：用原卡、不承认是 AI，被认真问就含糊带过（危机时仍用承认版）'),
            cover: Schema.string().description('**进群的说法**：有人问「你也是来养鱼的吗」「你是不是谁养的鱼」时照这个口径答（只在这一群用）'),
        })).default([]).description('**群**（ADR 0210）：你拉她进去、想让她在里面说话的群'),
        qqControl: choice('qqControl'),
        qqAllowFriends: Schema.array(Schema.number()).default([])
            .description('账号控制面允许动作的好友 QQ 号（允许清单；空 = 一个都不许）。只影响账号级动作，不影响她现在跟他聊天'),
        qqAllowGroups: Schema.array(Schema.number()).default([])
            .description('账号控制面允许动作的群号（同上）'),
        qqDangerous: Schema.boolean().default(DEFAULTS.qqDangerous)
            .description('危险动作闸（ADR 0142）：踢人 / 禁言 / 删好友 / 群发 / 建群 / 退群。开了也要过允许清单和限流。默认关'),
        qqFriendGate: choice('qqFriendGate'),
        pokeBack: toggle('pokeBack'),
        pokeOut: toggle('pokeOut'),
        grievance: toggle('grievance'),
        npcAsks: toggle('npcAsks'),
        feedbackCommands: toggle('feedbackCommands'),
        realWeather: toggle('realWeather'),
        realAirQuality: toggle('realAirQuality'),
        realDaylight: toggle('realDaylight'),
        realCalendar: toggle('realCalendar'),
        realTransport: Schema.intersect([
            Schema.object({
                enabled: Schema.boolean().default(DEFAULTS.realTransport.enabled)
                    .description('**现实交通**（ADR 0232）：明确打开后才读取卡上写的地方（学校、家）的结构化交通状态。失败或过期不写进她的世界，不改变课表或行动。默认关'),
            }),
            Schema.union([
                Schema.object({
                    enabled: Schema.const(true).required(),
                    endpoint: Schema.string().required().pattern(NOT_BLANK)
                        .description('**数据接口地址**：只填可信的公网 HTTPS 地址；不能包含账号、密码或密钥'),
                    source: Schema.string().required().pattern(/^[\p{L}\p{N}._ -]{1,40}$/u)
                        .description('**来源名称**：页面和日志里的简短名称，例如“城市公共交通”'),
                }),
                Schema.object({}),
            ]),
        ]).default(DEFAULTS.realTransport).description('现实交通（高级）'),
        festivals: choice('festivals'),
        typingStatus: toggle('typingStatus'),
        selfRecall: toggle('selfRecall'),
        selfDirectedMemory: toggle('selfDirectedMemory'),
        silenceNotice: toggle('silenceNotice'),
        crossRecent: toggle('crossRecent'),
        selfExport: toggle('selfExport'),
        selfReceipts: toggle('selfReceipts'),
        ownDays: toggle('ownDays'),
        desktopDay: toggle('desktopDay'),
        desktopReview: toggle('desktopReview'),
        desktopPromises: toggle('desktopPromises'),
        oneDiary: toggle('oneDiary'),
        desktopConflict: toggle('desktopConflict'),
        selfPursuits: toggle('selfPursuits'),
        exemplars: toggle('exemplars'),
        speechNotes: toggle('speechNotes'),
        diaryInsights: toggle('diaryInsights'),
        selfPortrait: toggle('selfPortrait'),
        fewerRules: toggle('fewerRules'),
        feelingReview: toggle('feelingReview'),
        ownerPeek: toggle('ownerPeek'),
        memoryReconcile: toggle('memoryReconcile'),
        depthRouting: toggle('depthRouting'),
        readStickers: toggle('readStickers'),
        factHim: toggle('factHim'),
        openQuestions: toggle('openQuestions'),
        readingTakes: toggle('readingTakes'),
        herGuesses: toggle('herGuesses'),
        hisReactions: toggle('hisReactions'),
        rhythm: toggle('rhythm'),
        shortReplies: toggle('shortReplies'),
        candidates: Schema.natural().min(1).max(5).default(DEFAULTS.candidates)
            .description('**挑候选**（ADR 0041）：他难过、说亲密话、收尾时一次生成几个回复、按规则挑一个（少说几句、不扯自己的事、不约「写完跟我说」）。1 是不挑；3 是这几种时候三倍的模型调用'),
        contextTurns: Schema.natural().max(40).default(DEFAULTS.contextTurns)
            .description('**最近几轮 + 要点**（ADR 0043）：0 是关（照旧放最近 80 条聊天原文）；开了是原文只放最近这么多轮（实验用 10），更早的在后台整理成几条要点。'
                + '要点没整理好的那一轮照旧放最近 80 条，不等它。只对开了长期记忆的联系人'),
        contextContacts: Schema.array(Schema.natural()).default([...DEFAULTS.contextContacts])
            .description('上面那项只对这几个 QQ 开（灰度）；空着就是名单里开了记忆的都开'),
        proactive: choice('proactive'),
    }).description('联系人'),
    Schema.object({
        llm: Schema.object({
            baseUrl: Schema.string().required().pattern(NOT_BLANK)
                .description('**接口地址**：OpenAI 兼容，不含 /chat/completions。key 只从环境变量 QQBOT_LLM_API_KEY 读'),
            model: Schema.string().required().pattern(NOT_BLANK).description('**模型名**'),
            thinking: Schema.union(THINKING.map(value => Schema.const(value).description(THINKING_LABELS[value])))
                .description('**思考**（DeepSeek）：开着时温度不生效，回复长度上限包含思考过程。不选 = 用接口默认（DeepSeek：开，强度高）'),
            temperature: Schema.number().min(0).max(2).step(0.1).default(DEFAULTS.llm.temperature).description('**温度**：开思考时不生效'),
            maxTokens: Schema.natural().min(1).default(DEFAULTS.llm.maxTokens)
                .description('**回复长度上限**（token）：开思考时包含思考过程，要调大'),
            extraBody: Schema.string().role('textarea', { rows: [2, 8] }).default('{}')
                .description('**其他参数**（JSON，一般不用改）：合并进请求体，同 ST 的 Include Body Parameters。思考请用上面的控件'),
            promptPostProcessing: Schema.union(PROMPT_POST_PROCESSING.map(value => Schema.const(value).description(POST_PROCESSING_LABELS[value])))
                .default(DEFAULTS.llm.promptPostProcessing).description('**Prompt Post-Processing**（一般不用改）：同 ST 自定义接口的同名设置'),
            timeoutMs: Schema.natural().default(DEFAULTS.llm.timeoutMs).description('**请求超时**（毫秒，一般不用改）：整个请求'),
        }),
    }).description('模型'),
    Schema.object({
        dsh: Schema.object({
            enabled: described(Schema.boolean().default(DEFAULTS.dsh.enabled), 'dsh'),
            baseUrl: Schema.string().pattern(NOT_BLANK)
                .description('**独立接口地址（可选）**：只覆盖 DSH，不含 `/chat/completions`；key 仍复用 QQBOT_LLM_API_KEY。'),
            model: Schema.string().pattern(NOT_BLANK).description('**独立模型名（可选）**：只覆盖 DSH。'),
            timeoutMs: Schema.natural().min(1).description('**DSH 请求超时（可选）**：毫秒。留空时沿用主模型超时。'),
        }).description('DSH'),
    }),
    Schema.object({
        externalPlatforms: Schema.object({
            tieba: Schema.union(EXTERNAL_PLATFORM_MODES.map(mode => Schema.const(mode).description(EXTERNAL_PLATFORM_LABELS[mode]))).default(DEFAULTS.externalPlatforms.tieba)
                .description('**百度贴吧**：只使用官方开放能力；草稿模式不登录、不发帖，授权模式需先取得合作权限。'),
            douyin: Schema.union(EXTERNAL_PLATFORM_MODES.map(mode => Schema.const(mode).description(EXTERNAL_PLATFORM_LABELS[mode]))).default(DEFAULTS.externalPlatforms.douyin)
                .description('**抖音**：只使用官方 OAuth 和已申请权限；草稿模式不发布，授权模式需通过应用审核。'),
            xiaohongshu: Schema.union(EXTERNAL_PLATFORM_MODES.map(mode => Schema.const(mode).description(EXTERNAL_PLATFORM_LABELS[mode]))).default(DEFAULTS.externalPlatforms.xiaohongshu)
                .description('**小红书**：使用官方授权 / 分享能力；不抓取公开笔记，授权模式需官方应用能力。'),
        }).description('外部平台（默认关闭；先草稿，后授权）'),
    }),
    Schema.object({
        mobileCompanion: Schema.object({
            enabled: Schema.boolean().default(false)
                .description('**手机伴侣 WebSocket**（ADR 0224）：明确打开后才在 Koishi server 上挂载受配对保护的连接；必须同时打开 DSH。默认关，不自动监听新端口。'),
            websocketPath: Schema.string().default('/qqbot/companion').pattern(/^\/[A-Za-z0-9/_-]{1,120}$/)
                .description('**WebSocket 路径**：只允许路径字符；外层 Koishi server 仍由 server.host / server.port 控制。'),
            httpPath: Schema.string().default('/qqbot/companion/http').pattern(/^\/[A-Za-z0-9/_-]{1,110}$/)
                .description('**HTTPS 路径**：同一 Koishi server 上的 envelope 路径；媒体上传在其下的 `/media`，宿主下行动作轮询在 `/actions`，都需要已配对 session。'),
        }).description('手机伴侣'),
    }),
    Schema.object({
        // 写法同 plugin-auth 的 admin：开着才多出细项，存的形状不变
        memory: Schema.intersect([
            Schema.object({ enabled: Schema.boolean().default(false).description('**长期记忆**（Hindsight）') }),
            Schema.union([
                Schema.object({
                    enabled: Schema.const(true).required(),
                    baseUrl: Schema.string().default(MEMORY_BASE_URL).pattern(NOT_BLANK).description('**地址**'),
                    timeoutMs: Schema.natural().default(DEFAULTS.memory.timeoutMs).description('**写入超时**（毫秒）'),
                    recallTimeoutMs: Schema.natural().default(DEFAULTS.memory.recallTimeoutMs)
                        .description('**召回超时**（毫秒）：生成前召回超时就不带记忆，不拖住回复'),
                    bankPrefix: Schema.string().default(DEFAULTS.memory.bankPrefix).description('**bank 前缀**：后面接 QQ 号的哈希和档位'),
                }),
                Schema.object({}),
            ]),
        ]),
    }).description('长期记忆'),
    Schema.object({
        prompt: Schema.object({
            maxContext: Schema.natural().default(DEFAULTS.prompt.maxContext).description('**上下文上限**（token）：同 ST 的 Context Size'),
            pinExamples: Schema.boolean().default(DEFAULTS.prompt.pinExamples)
                .description('**示例对话常驻**：不被聊天记录挤掉，同 ST 的 Always include examples'),
            worldInfo: Schema.object({
                depth: Schema.natural().default(DEFAULTS.prompt.worldInfo.depth).description('**扫描深度**：看最近几条消息'),
                budgetPercent: Schema.natural().max(100).default(DEFAULTS.prompt.worldInfo.budgetPercent).description('**预算**：占上下文的百分比'),
                budgetCap: Schema.natural().default(DEFAULTS.prompt.worldInfo.budgetCap).description('**预算上限**（token）：0 = 不封顶'),
                includeNames: Schema.boolean().default(DEFAULTS.prompt.worldInfo.includeNames).description('**扫描时带名字**'),
                caseSensitive: Schema.boolean().default(DEFAULTS.prompt.worldInfo.caseSensitive).description('**区分大小写**'),
                matchWholeWords: Schema.boolean().default(DEFAULTS.prompt.worldInfo.matchWholeWords).description('**整词匹配**'),
            }).collapse().description('**世界书**：同 ST 的 World Info 设置'),
        }).collapse().description('**提示词**'),
        characterCard: Schema.string().default(CHARACTER_CARD).pattern(NOT_BLANK)
            .description('**角色卡路径**：{tier} 换成档位名；相对路径按仓库根目录'),
        dataDir: Schema.string().default(DEFAULTS.dataDir).pattern(NOT_BLANK)
            .description('**数据目录**：聊天记录、换档记录、日志等。和独立入口 main.ts 共用时两者不能同时运行（单实例锁）'),
    }).description('高级（一般不用改）'),
]);

const dropUndefined = (obj: object) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));

/** 思考控件 → 请求体里的参数（DeepSeek 文档，10-05 核对） */
export function thinkingBody(thinking: Thinking): Record<string, unknown> {
    return thinking === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'enabled' }, reasoning_effort: thinking };
}

function parseExtraBody(text: string): Record<string, unknown> {
    let value: unknown;
    try {
        value = JSON.parse(text || '{}');
    } catch (error) {
        throw new Error(`其他参数（llm.extraBody）不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`);
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('其他参数（llm.extraBody）应为 JSON 对象，例如 {}');
    return value as Record<string, unknown>;
}

/** 控制台表单的配置 → config.json 的形状（交给 parseAppConfig 校验、补默认值） */
export function toAppConfigInput(config: Config): Record<string, unknown> {
    const { thinking, extraBody: extraText, ...llm } = config.llm;
    const extraBody = parseExtraBody(extraText);
    if (thinking !== undefined) {
        if ('thinking' in extraBody || 'reasoning_effort' in extraBody) {
            throw new Error('思考（llm.thinking）选了值，其他参数里就不要再写 thinking / reasoning_effort');
        }
        Object.assign(extraBody, thinkingBody(thinking));
    }
    const { enabled, ...memory } = config.memory ?? { enabled: false };
    const { enabled: visionEnabled, ...vision } = config.vision ?? { enabled: false };
    return {
        llm: dropUndefined({ ...llm, extraBody }),
        ...(config.dsh?.enabled ? { dsh: dropUndefined({ enabled: true, baseUrl: config.dsh.baseUrl, model: config.dsh.model, timeoutMs: config.dsh.timeoutMs }) } : {}),
        externalPlatforms: { ...DEFAULTS.externalPlatforms, ...(config.externalPlatforms ?? {}) },
        prompt: dropUndefined({ ...config.prompt, worldInfo: dropUndefined(config.prompt?.worldInfo ?? {}) }),
        characterCard: config.characterCard,
        contacts: config.contacts.map(contact => dropUndefined(contact)),
        unlistedFriends: config.unlistedFriends,
        schedule: config.schedule,
        ...(config.timeZone !== undefined ? { timeZone: config.timeZone } : {}),
        // 旧的 koishi.yml 没有这几项：parseAppConfig 按默认值（看心情不回开、说话的毛病开、她自己的日子开、主动消息关）
        ...(config.moody !== undefined ? { moody: config.moody } : {}),
        ...(config.speechCheck !== undefined ? { speechCheck: config.speechCheck } : {}),
        ...(config.herDays !== undefined ? { herDays: config.herDays } : {}),
        ...(config.autonomousLife !== undefined ? { autonomousLife: config.autonomousLife } : {}),
        ...(config.projectChoice !== undefined ? { projectChoice: config.projectChoice } : {}),
        ...(config.lifeInPrompt !== undefined ? { lifeInPrompt: config.lifeInPrompt } : {}),
        ...(config.grievance !== undefined ? { grievance: config.grievance } : {}),
        ...(config.npcAsks !== undefined ? { npcAsks: config.npcAsks } : {}),
        ...(config.pokes !== undefined ? { pokes: config.pokes } : {}),
        ...(config.recalls !== undefined ? { recalls: config.recalls } : {}),
        ...(config.pokeBack !== undefined ? { pokeBack: config.pokeBack } : {}),
        ...(config.pokeOut !== undefined ? { pokeOut: config.pokeOut } : {}),
        ...(config.readReceipts !== undefined ? { readReceipts: config.readReceipts } : {}),
        ...(config.bilibili !== undefined ? { bilibili: config.bilibili } : {}),
        ...(config.bilibiliAccount !== undefined ? { bilibiliAccount: config.bilibiliAccount } : {}),
        ...(config.biliFeed !== undefined ? { biliFeed: config.biliFeed } : {}),
        ...(config.bilibiliComment !== undefined ? { bilibiliComment: config.bilibiliComment } : {}),
        ...(config.bilibiliDm !== undefined ? { bilibiliDm: config.bilibiliDm } : {}),
        ...(config.bilibiliReplies !== undefined ? { bilibiliReplies: config.bilibiliReplies } : {}),
        ...(config.bilibiliCommentKeywords !== undefined ? { bilibiliCommentKeywords: config.bilibiliCommentKeywords } : {}),
        ...(config.shape !== undefined ? { shape: config.shape } : {}),
        ...(config.shapeAgenda !== undefined ? { shapeAgenda: config.shapeAgenda } : {}),
        ...(config.shapeFiller !== undefined ? { shapeFiller: config.shapeFiller } : {}),
        ...(config.shapeFeel !== undefined ? { shapeFeel: config.shapeFeel } : {}),
        ...(config.proactiveReach !== undefined ? { proactiveReach: config.proactiveReach } : {}),
        ...(config.proactiveInvite !== undefined ? { proactiveInvite: config.proactiveInvite } : {}),
        ...(config.photos !== undefined ? { photos: config.photos } : {}),
        ...(config.aiPhotos !== undefined ? { aiPhotos: config.aiPhotos } : {}),
        ...(config.photoShares !== undefined ? { photoShares: config.photoShares } : {}),
        ...(config.together !== undefined ? { together: config.together } : {}),
        ...(config.comeBack !== undefined ? { comeBack: config.comeBack } : {}),
        ...(config.relationship !== undefined ? { relationship: config.relationship } : {}),
        ...(config.jokes !== undefined ? { jokes: config.jokes } : {}),
        ...(config.interruptions !== undefined ? { interruptions: config.interruptions } : {}),
        ...(config.proactiveAsk !== undefined ? { proactiveAsk: config.proactiveAsk } : {}),
        ...(config.hisHours !== undefined ? { hisHours: config.hisHours } : {}),
        ...(config.weeklyReport !== undefined ? { weeklyReport: config.weeklyReport } : {}),
        ...(config.jealousy !== undefined ? { jealousy: config.jealousy } : {}),
        ...(config.proactiveRoom !== undefined ? { proactiveRoom: config.proactiveRoom } : {}),
        ...(config.menu !== undefined ? { menu: config.menu } : {}),
        ...(config.curious !== undefined ? { curious: config.curious } : {}),
        ...(config.smallNews !== undefined ? { smallNews: config.smallNews } : {}),
        ...(config.foodPhotos !== undefined ? { foodPhotos: config.foodPhotos } : {}),
        ...(config.memes !== undefined ? { memes: config.memes } : {}),
        ...(config.watching !== undefined ? { watching: config.watching } : {}),
        ...(config.texture !== undefined ? { texture: config.texture } : {}),
        ...(config.biliStickers !== undefined ? { biliStickers: config.biliStickers } : {}),
        ...(config.quoteReply !== undefined ? { quoteReply: config.quoteReply } : {}),
        ...(config.idioms !== undefined ? { idioms: config.idioms } : {}),
        ...(config.tailCap !== undefined ? { tailCap: config.tailCap } : {}),
        ...(config.deviceControl !== undefined ? { deviceControl: config.deviceControl } : {}),
        ...(config.deviceLinks !== undefined ? { deviceLinks: config.deviceLinks } : {}),
        ...(config.deviceApps !== undefined ? { deviceApps: config.deviceApps } : {}),
        ...(config.factCheck !== undefined ? { factCheck: config.factCheck } : {}),
        ...(config.innerLife !== undefined ? { innerLife: config.innerLife } : {}),
        ...(config.adultSiteUrls !== undefined ? { adultSiteUrls: config.adultSiteUrls } : {}),
        ...(config.herFeelings !== undefined ? { herFeelings: config.herFeelings } : {}),
        ...(config.herNo !== undefined ? { herNo: config.herNo } : {}),
        ...(config.afterNo !== undefined ? { afterNo: config.afterNo } : {}),
        ...(config.lagTail !== undefined ? { lagTail: config.lagTail } : {}),
        ...(config.everydayLife !== undefined ? { everydayLife: config.everydayLife } : {}),
        ...(config.worldDrama !== undefined ? { worldDrama: config.worldDrama } : {}),
        ...(config.worldThreads !== undefined ? { worldThreads: config.worldThreads } : {}),
        ...(config.diaryLookback !== undefined ? { diaryLookback: config.diaryLookback } : {}),
        ...(config.memoryFeelings !== undefined ? { memoryFeelings: config.memoryFeelings } : {}),
        ...(config.realNights !== undefined ? { realNights: config.realNights } : {}),
        ...(config.chatReview !== undefined ? { chatReview: config.chatReview } : {}),
        ...(config.pursuits !== undefined ? { pursuits: config.pursuits } : {}),
        ...(config.shapeSplit !== undefined ? { shapeSplit: config.shapeSplit } : {}),
        ...(config.shapeAsk !== undefined ? { shapeAsk: config.shapeAsk } : {}),
        ...(config.shapeLong !== undefined ? { shapeLong: config.shapeLong } : {}),
        ...(config.deliberate !== undefined ? { deliberate: config.deliberate } : {}),
        ...(config.deliberateModel !== undefined ? { deliberateModel: config.deliberateModel } : {}),
        ...(config.identityLedger !== undefined ? { identityLedger: config.identityLedger } : {}),
        ...(config.memoryAudit !== undefined ? { memoryAudit: config.memoryAudit } : {}),
        ...(config.dormancy !== undefined ? { dormancy: config.dormancy } : {}),
        ...(config.timeline !== undefined ? { timeline: config.timeline } : {}),
        ...(config.webLookup !== undefined ? { webLookup: config.webLookup } : {}),
        ...(config.tastes !== undefined ? { tastes: config.tastes } : {}),
        ...(config.acquaintances !== undefined ? { acquaintances: config.acquaintances } : {}),
        ...(config.bilibiliAtName !== undefined ? { bilibiliAtName: config.bilibiliAtName } : {}),
        ...(config.bilibiliAtUid !== undefined ? { bilibiliAtUid: config.bilibiliAtUid } : {}),
        ...(config.reactions !== undefined ? { reactions: config.reactions } : {}),
        ...(config.onlineStatus !== undefined ? { onlineStatus: config.onlineStatus } : {}),
        ...(config.profileLikes !== undefined ? { profileLikes: config.profileLikes } : {}),
        ...(config.signature !== undefined ? { signature: config.signature } : {}),
        ...(config.qzone !== undefined ? { qzone: config.qzone } : {}),
        ...(config.qzoneVisibility !== undefined ? { qzoneVisibility: config.qzoneVisibility } : {}),
        ...(config.qzoneBrowse !== undefined ? { qzoneBrowse: config.qzoneBrowse } : {}),
        ...(config.qzonePeek !== undefined ? { qzonePeek: config.qzonePeek } : {}),
        ...(config.qzoneStrangers !== undefined ? { qzoneStrangers: config.qzoneStrangers } : {}),
        ...(config.groupChat !== undefined ? { groupChat: config.groupChat } : {}),
        ...(config.groupOwn !== undefined ? { groupOwn: config.groupOwn } : {}),
        ...(config.groupAgency !== undefined ? { groupAgency: config.groupAgency } : {}),
        ...(config.groups?.length ? { groups: config.groups.map(group => dropUndefined(group)) } : {}),
        ...(config.qqControl !== undefined ? { qqControl: config.qqControl } : {}),
        ...(config.qqAllowFriends !== undefined ? { qqAllowFriends: config.qqAllowFriends } : {}),
        ...(config.qqAllowGroups !== undefined ? { qqAllowGroups: config.qqAllowGroups } : {}),
        ...(config.qqDangerous !== undefined ? { qqDangerous: config.qqDangerous } : {}),
        ...(config.qqFriendGate !== undefined ? { qqFriendGate: config.qqFriendGate } : {}),
        ...(config.feedbackCommands !== undefined ? { feedbackCommands: config.feedbackCommands } : {}),
        ...(config.realWeather !== undefined ? { realWeather: config.realWeather } : {}),
        ...(config.realAirQuality !== undefined ? { realAirQuality: config.realAirQuality } : {}),
        ...(config.realDaylight !== undefined ? { realDaylight: config.realDaylight } : {}),
        ...(config.realCalendar !== undefined ? { realCalendar: config.realCalendar } : {}),
        ...(config.realTransport?.enabled ? { realTransport: dropUndefined({
            enabled: true,
            endpoint: config.realTransport.endpoint,
            source: config.realTransport.source,
        }) } : {}),
        ...(config.festivals !== undefined ? { festivals: config.festivals } : {}),
        ...(config.typingStatus !== undefined ? { typingStatus: config.typingStatus } : {}),
        ...(config.selfRecall !== undefined ? { selfRecall: config.selfRecall } : {}),
        ...(config.selfDirectedMemory !== undefined ? { selfDirectedMemory: config.selfDirectedMemory } : {}),
        ...(config.silenceNotice !== undefined ? { silenceNotice: config.silenceNotice } : {}),
        ...(config.crossRecent !== undefined ? { crossRecent: config.crossRecent } : {}),
        ...(config.selfExport !== undefined ? { selfExport: config.selfExport } : {}),
        ...(config.selfReceipts !== undefined ? { selfReceipts: config.selfReceipts } : {}),
        ...(config.ownDays !== undefined ? { ownDays: config.ownDays } : {}),
        ...(config.desktopDay !== undefined ? { desktopDay: config.desktopDay } : {}),
        ...(config.desktopReview !== undefined ? { desktopReview: config.desktopReview } : {}),
        ...(config.desktopPromises !== undefined ? { desktopPromises: config.desktopPromises } : {}),
        ...(config.oneDiary !== undefined ? { oneDiary: config.oneDiary } : {}),
        ...(config.desktopConflict !== undefined ? { desktopConflict: config.desktopConflict } : {}),
        ...(config.selfPursuits !== undefined ? { selfPursuits: config.selfPursuits } : {}),
        ...(config.speechNotes !== undefined ? { speechNotes: config.speechNotes } : {}),
        ...(config.exemplars !== undefined ? { exemplars: config.exemplars } : {}),
        ...(config.diaryInsights !== undefined ? { diaryInsights: config.diaryInsights } : {}),
        ...(config.selfPortrait !== undefined ? { selfPortrait: config.selfPortrait } : {}),
        ...(config.fewerRules !== undefined ? { fewerRules: config.fewerRules } : {}),
        ...(config.feelingReview !== undefined ? { feelingReview: config.feelingReview } : {}),
        ...(config.ownerPeek !== undefined ? { ownerPeek: config.ownerPeek } : {}),
        ...(config.memoryReconcile !== undefined ? { memoryReconcile: config.memoryReconcile } : {}),
        ...(config.depthRouting !== undefined ? { depthRouting: config.depthRouting } : {}),
        ...(config.factHim !== undefined ? { factHim: config.factHim } : {}),
        ...(config.readStickers !== undefined ? { readStickers: config.readStickers } : {}),
        ...(config.readingTakes !== undefined ? { readingTakes: config.readingTakes } : {}),
        ...(config.hisReactions !== undefined ? { hisReactions: config.hisReactions } : {}),
        ...(config.herGuesses !== undefined ? { herGuesses: config.herGuesses } : {}),
        ...(config.openQuestions !== undefined ? { openQuestions: config.openQuestions } : {}),
        ...(config.rhythm !== undefined ? { rhythm: config.rhythm } : {}),
        ...(config.shortReplies !== undefined ? { shortReplies: config.shortReplies } : {}),
        ...(config.candidates !== undefined ? { candidates: config.candidates } : {}),
        ...(config.contextTurns !== undefined ? { contextTurns: config.contextTurns } : {}),
        ...(config.contextContacts !== undefined ? { contextContacts: config.contextContacts } : {}),
        ...(config.proactive !== undefined ? { proactive: config.proactive } : {}),
        ...(config.media !== undefined ? { media: config.media } : {}),
        ...(config.stickers !== undefined ? { stickers: config.stickers } : {}),
        ...(visionEnabled ? { vision: { provider: DEFAULTS.vision.provider, ...dropUndefined(vision) } } : {}),
        ...(enabled ? { memory: dropUndefined(memory) } : {}),
        dataDir: config.dataDir,
    };
}

/**
 * 旧写法（ADR 0009 之前）：思考写在其他参数的 JSON 里。能一一对上控件的选项时，搬到控件上，返回新配置；
 * 对不上（还有别的写法、或者控件已经选了）就返回 undefined，原样留在 JSON 里。搬完请求体不变。
 */
export function migrateThinking(config: Config): Config | undefined {
    if (config.llm.thinking !== undefined) return;
    let extra: Record<string, unknown>;
    try {
        extra = parseExtraBody(config.llm.extraBody);
    } catch {
        return;
    }
    const { thinking, reasoning_effort: effort, ...rest } = extra;
    if (typeof thinking !== 'object' || thinking === null || Object.keys(thinking).length !== 1) return;
    const type = (thinking as { type?: unknown }).type;
    let value: Thinking | undefined;
    if (type === 'disabled' && effort === undefined) value = 'off';
    else if (type === 'enabled' && (effort === 'low' || effort === 'high' || effort === 'max')) value = effort;
    if (!value) return;
    return { ...config, llm: { ...config.llm, thinking: value, extraBody: JSON.stringify(rest) } };
}

/** 抛给 Koishi 的错误只留一句话：Koishi 把 stack 打进运行日志，调用栈会把有用的那句顶出控制台的日志框 */
function plainError(prefix: string, error: unknown): Error {
    const plain = new Error(`${prefix}：${error instanceof Error ? error.message : String(error)}`);
    plain.stack = plain.message;
    return plain;
}

/** 断线后重连的等待：5 秒、10 秒、30 秒，之后每分钟一次 */
export const RECONNECT_MS = [5_000, 10_000, 30_000, 60_000];

/** 角色卡、世界书文件改动后，等这么久没有新的改动再重启（转换器一次写十几个文件） */
const CARD_RELOAD_DELAY_MS = 2000;

/** 好友列表多久重新拉一次（小号新加了好友，不用重启也能在下拉里选到） */
const FRIENDS_REFRESH_MS = 60_000;

/** 这次 Koishi 进程里拉到过好友列表没有：拉到过就一直留着上一次的（插件失败、重启时下拉仍在） */
let friendsLoaded = false;
let friendsKey = '';

export function apply(ctx: Context, config: Config) {
    // 控制台的「林梦瑶」页面（ADR 0010）：注册一次，插件失败时也在
    registerConsole(ctx, repoRoot);
    const card = config.characterCard ?? CHARACTER_CARD;
    setConsoleState({ running: false, error: undefined, status: undefined, dataDir: undefined, character: characterPaths(isAbsolute(card) ? card : resolve(repoRoot, card)) });

    const migrated = migrateThinking(config);
    if (migrated) {
        ctx.logger('qqbot').info(`迁移配置：其他参数里的思考设置搬到「思考」控件（${THINKING_LABELS[migrated.llm.thinking!]}），请求体不变`);
        // 同步调用时 loader 还没登记这个实例，不会写回 koishi.yml（ADR 0009 试验结果第 3 条）；写回后插件按新配置重启
        ctx.setTimeout(() => ctx.scope.update(migrated), 0);
        return;
    }

    let appConfig: AppConfig;
    let releaseTimeZone: () => void = () => {};
    try {
        appConfig = parseAppConfig(toAppConfigInput(config), repoRoot);
        setConsoleState({ dataDir: appConfig.dataDir });
        ctx.logger('qqbot').info(`开关：exemplars=${appConfig.exemplars} speechNotes=${appConfig.speechNotes} diaryInsights=${appConfig.diaryInsights} herFeelings=${appConfig.herFeelings} feelingReview=${appConfig.feelingReview} ownerPeek=${appConfig.ownerPeek} memoryReconcile=${appConfig.memoryReconcile} depthRouting=${appConfig.depthRouting} factHim=${appConfig.factHim} readingTakes=${appConfig.readingTakes} hisReactions=${appConfig.hisReactions} herGuesses=${appConfig.herGuesses} diaryLookback=${appConfig.diaryLookback ?? false} memoryFeelings=${appConfig.memoryFeelings ?? false} realNights=${appConfig.realNights ?? false} chatReview=${appConfig.chatReview ?? false} worldThreads=${appConfig.worldThreads ?? false} afterNo=${appConfig.afterNo ?? false} openQuestions=${appConfig.openQuestions}`);
        // 她的时区（ADR 0331）：整个 Koishi 进程跟着她的时区走，作息和日界不再取决于机器设置；
        // 插件停用或重载时还原（还原只在没有更新的实例占用时才做，见 claimTimeZone）
        releaseTimeZone = claimTimeZone(appConfig.timeZone);
    } catch (error) {
        const plain = plainError('配置有误，插件没有启动', error);
        setConsoleState({ error: plain.message });
        throw plain;
    }
    // 兜底：占用成功后立刻登记。apply 在后面注册正式的 dispose 之前抛错（图片表情索引不可用、手机伴侣挂载失败……）时，
    // Koishi 只会跑已经登记的 dispose，这一条保证进程时区仍然被还原；正式的 dispose 登记时会接手释放（要等收尾做完）。
    const timeZoneLease = { handedOver: false };
    ctx.on('dispose', () => { if (!timeZoneLease.handedOver) releaseTimeZone(); });
    // 同一份按天日志（runtime/bot/logs），grep 的核对方式不变；控制台里看 ctx.logger 那份
    const fileLog = createLog(join(appConfig.dataDir, 'logs'), undefined, () => {});
    const logger = ctx.logger('qqbot');
    const log: Log = message => {
        logger.info(message);
        fileLog(message);
    };

    // 只支持一个 NapCat 账号：用在线的那个
    const onlineBot = () => {
        const bot = ctx.bots.find(b => b.platform === 'onebot' && b.status === ONLINE);
        if (!bot) throw new Error('NapCat 未连接');
        return bot as Bot & { internal: OneBotInternal };
    };
    const transport: Transport = {
        // 白名单的小黄脸「[捂脸]」发成 face 段（ADR 0051），和 onebot.ts 发的是同一个请求
        sendPrivateText: async (userId, text, replyTo) => Number(await onlineBot().internal.sendPrivateMsg(userId, replyTo === undefined ? textToSegments(text) : [replySegment(replyTo), ...textToSegments(text)])),
        // B 站分享卡片（ADR 0084）：json 段；QQ 不认就抛错，调用方退回发链接
        // 群消息（ADR 0210）
        sendGroupText: async (groupId, text, replyTo) => Number(await onlineBot().internal.sendGroupMsg(groupId, replyTo === undefined ? textToSegments(text) : [replySegment(replyTo), ...textToSegments(text)])),
        // 段（@人、引用一起带）：群里她能指着人说话（2026-11-14）
        sendGroupMessage: async (groupId, segments, replyTo) => Number(await onlineBot().internal.sendGroupMsg(groupId, (replyTo === undefined ? segments : [replySegment(replyTo), ...segments]) as never)),
        pokeGroup: async (groupId, userId) => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('group_poke', { group_id: String(groupId), user_id: String(userId) }); },
        sendPrivateCard: async (userId, cardJson) => Number(await onlineBot().internal.sendPrivateMsg(userId, [{ type: 'json', data: { data: cardJson } }])),
        // 语音条（2026-11-14）：koishi 这条链路原来没有这个方法，app 里 Boolean(transport.sendPrivateVoice)
        // 恒为 false，她的语音和唱歌片段一直发不出去
        sendPrivateVoice: async (userId, file) => Number(await onlineBot().internal.sendPrivateMsg(userId, [{ type: 'record', data: { file: `file:///${file.split('\\').join('/')}` } }])),
        deleteMessage: async messageId => { await onlineBot().internal.deleteMsg(messageId); },
        pokeFriend: async userId => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('friend_poke', { user_id: String(userId) }); },
        markRead: async userId => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('mark_private_msg_as_read', { user_id: String(userId) }); },
        reactMessage: async (messageId, emojiId) => { assertKernelOk('set_msg_emoji_like', await (onlineBot().internal as unknown as OneBotMediaInternal)._get('set_msg_emoji_like', { message_id: messageId, emoji_id: String(emojiId), set: true })); },
        setOnlineStatus: async (status, ext) => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('set_online_status', { status, ext_status: ext, battery_status: 0 }); },
        sendLike: async (userId, times) => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('send_like', { user_id: String(userId), times }); },
        setSignature: async text => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('set_self_longnick', { longNick: text }); },
        postQzone: async post => String(((await (onlineBot().internal as unknown as OneBotMediaInternal)._get('send_qzone_msg', { content: post.content, ...(post.images ? { images: post.images } : {}), ugc_right: post.ugcRight })) as { tid?: unknown } | null)?.tid ?? ''),
        // 读一页空间动态（ADR 0142）：动作名各版本不同，qzone-feed 会按候选逐个试；都不通返回 undefined，上层只记一行
        readQzoneFeed: async count => readQzoneFeed((action, params) => (onlineBot().internal as unknown as OneBotMediaInternal)._get(action, params), { count }),
        readStrangerFeed: async () => {
            const raw = await (onlineBot().internal as unknown as OneBotMediaInternal)._get('get_cookies', { domain: 'qzone.qq.com' });
            const session = sessionFromCookies(raw);
            return session ? readStrangerFeed({ session }) : undefined;
        },
        // 看好友发的说说（ADR 0145）：读她自己的好友动态流（不进对方空间、不留访客记录），再挑出这个人发的；
        // 拿不到登录态或这页读不了返回 undefined，读到了但这个人没发就返回 []
        readUserQzone: async uin => {
            const raw = await (onlineBot().internal as unknown as OneBotMediaInternal)._get('get_cookies', { domain: 'qzone.qq.com' });
            const session = sessionFromCookies(raw);
            const posts = session ? await readFriendsFeed({ session }) : undefined;
            return posts?.filter(post => post.uin === uin).map(post => ({
                id: post.id,
                uin: post.uin,
                ...(post.name ? { name: post.name } : {}),
                text: post.text,
                images: post.images,
                ...(post.at !== undefined ? { at: post.at } : {}),
            }));
        },
        // 空友爱看相关的说明见 ADR 0083
        sendPrivateImage: async (userId, file, summary) => Number(await onlineBot().internal.sendPrivateMsg(userId, [{ type: 'image', data: { file, summary, sub_type: 1 } }])),
        // NapCat 的扩展动作 set_input_status（adapter-onebot 没有定义它，走通用的 _get：retcode 不是 0 就抛错；ADR 0077）
        setInputStatus: async (userId, eventType = 1) => { assertKernelOk('set_input_status', await (onlineBot().internal as unknown as OneBotMediaInternal)._get('set_input_status', { user_id: String(userId), event_type: eventType })); },
        friendHistory: (userId, count) => onlineBot().internal.getFriendMsgHistory(String(userId), undefined, count),
        // 账号控制面（ADR 0142）的通用调用：动作名和参数由 account.ts 的白名单决定，这里只负责发
        callAction: async (action, params) => (onlineBot().internal as unknown as OneBotMediaInternal)._get(action, params),
    };

    // 听语音、看图上的字（ADR 0052）：QQ 自带的语音转文字、NapCat 的 OCR（只有 Windows）。adapter-onebot 没有 fetch_ptt_text 的方法，用它通用的 _get
    const mediaBot = () => onlineBot().internal as unknown as OneBotMediaInternal;
    const media: MediaReader = {
        voiceToText: async messageId => String((await mediaBot()._get('fetch_ptt_text', { message_id: messageId }) as { text?: unknown } | null)?.text ?? ''),
        ocr: async image => ocrLines(await mediaBot().ocrImage(image)),
    };
    const vision = configuredImageDescriber(appConfig);
    const stickerVision = configuredImageDescriber(appConfig, STICKER_VISION_PROMPT);
    // 读他刚发来的表情包（ADR 0206）：同一个要求，但在聊天路上，不排在后台收藏后面
    const stickerReader = appConfig.readStickers ? configuredImageDescriber(appConfig, STICKER_VISION_PROMPT, 'chat') : undefined;
    const qqFav = qqFavorites((action, params) => mediaBot()._get(action, params));
    const stickers = (appConfig.stickers ?? 'off') !== 'off' && stickerVision ? stickerShelf({
        dir: join(appConfig.dataDir, 'stickers'),
        describe: image => stickerVision.describe(image),
        decide: stickerDecider(appConfig.llm, log),
        trendDiscover: bqbDiscover({ dir: join(appConfig.dataDir, 'stickers', 'sources'), log }),
        screen: biliStickerScreen,
        discover: qqFav.discover,
        favorites: qqFav.favorites,
        log,
    }) : undefined;
    let app: ReturnType<typeof startApp>;
    try {
        const photoSource = appConfig.photos ? webPhotoSource(appConfig, log) : undefined;
        const foodSource = appConfig.photos && appConfig.foodPhotos && appConfig.menu ? webFoodSource(appConfig, log) : undefined;
        // 提示词指纹清单（platform/prompt-manifest.ts）：和按天日志同一个目录，默认就写（没有正文）
        const promptManifest = createPromptManifestLog(join(appConfig.dataDir, 'logs'), { log });
        app = startApp({ config: appConfig, transport, log, media, vision, promptManifest, ...(stickerReader ? { stickerReader } : {}), ...(stickers ? { stickers } : {}), ...(photoSource ? { photoSource } : {}), ...(foodSource ? { foodSource } : {}) });
    } catch (error) {
        releaseTimeZone();
        const plain = plainError('插件没有启动', error);
        setConsoleState({ error: plain.message });
        throw plain;
    }
    setConsoleState({ running: true, error: undefined, status: () => app.status() });
    const unmountMobileCompanion = mountMobileCompanion(
        (ctx as unknown as { server?: CompanionServerLike }).server,
        app.mobileCompanion(),
        config.mobileCompanion,
        log,
    );
    if (unmountMobileCompanion) ctx.on('dispose', unmountMobileCompanion);
    timeZoneLease.handedOver = true; // 从这里起由下面的 dispose 释放（兜底那条在它之前登记，先跑，所以要在登记时就交接）
    ctx.on('dispose', () => {
        let drained: Promise<void> | undefined;
        try { drained = app.stop(); }
        catch (error) {
            // stop 同步抛错也要把控制台状态和时区收拾好
            setConsoleState({ running: false, status: undefined });
            releaseTimeZone();
            throw error;
        }
        setConsoleState({ running: false, status: undefined });
        // 收尾还在按她的时区算日期，等做完再还原进程时区
        if (drained) return Promise.resolve(drained).finally(releaseTimeZone);
        releaseTimeZone();
        return drained;
    });

    ctx.middleware((session, next) => {
        const event = (session as Session & { onebot?: OneBotEvent }).onebot;
        if (session.platform !== 'onebot' || !event) return next();
        // 群消息（ADR 0210）：交给 app，它只认配置 groups 名单里的群；照样往下传（别的插件也能看到）
        if (isGroupMessage(event)) { app.receiveGroup(event); return next(); }
        if (!isPrivateFriendMessage(event)) return next();
        app.receive(event);
    }, true);

    // 戳一戳（ADR 0079）：adapter-onebot 把 notice/notify/poke 发成 notice 事件（subtype poke），原始数据在 session.onebot
    ctx.on('internal/session', session => {
        if (session.type !== 'notice' || session.subtype !== 'poke') return;
        const event = (session as Session & { onebot?: OneBotEvent }).onebot;
        if (session.platform === 'onebot' && event && isPokeAtMe(event)) app.receivePoke(event);
    });

    // 他撤回消息（ADR 0082）：adapter-onebot 把 friend_recall 发成 message-deleted 事件，原始数据在 session.onebot
    ctx.on('internal/session', session => {
        const event = (session as Session & { onebot?: OneBotEvent }).onebot;
        if (session.platform === 'onebot' && event && isFriendRecall(event)) app.receiveRecall(event);
    });

    // 有人申请加她（ADR 0142，配置 qqFriendGate）：adapter-onebot 把 request/friend 发成 friend-request，flag 在 messageId
    ctx.on('internal/session', session => {
        if (session.type !== 'friend-request' || session.platform !== 'onebot') return;
        const userId = Number(session.userId);
        const flag = String(session.messageId ?? '');
        if (!Number.isSafeInteger(userId) || userId <= 0 || !flag) return;
        app.receiveFriendRequest({ userId, flag });
    });

    // QQ 号的下拉：挂在根上下文上，插件失败、重启时不卸掉（ADR 0009 试验结果第 5 条）
    if (!friendsLoaded) {
        ctx.root.schema.set(FRIENDS_SCHEMA, Schema.natural().description('**QQ 号**：NapCat 还没连上，先手填；连上后可以从好友里选'));
    }
    const refreshFriends = async () => {
        let friends: OneBotFriend[];
        try {
            friends = await onlineBot().internal.getFriendList();
        } catch {
            return;
        }
        const known = new Set(friends.map(f => f.user_id));
        const strangers = config.contacts.map(c => c.qq).filter(qq => typeof qq === 'number' && !known.has(qq));
        const options = [
            ...friends.map(f => [f.user_id, `${f.remark || f.nickname}（${f.nickname}）${f.user_id}`] as const),
            ...strangers.map(qq => [qq, `${qq}（不是小号的好友，收不到私聊）`] as const),
        ];
        const key = JSON.stringify(options);
        if (friendsLoaded && key === friendsKey) return;
        friendsLoaded = true;
        friendsKey = key;
        ctx.root.schema.set(FRIENDS_SCHEMA, options.length
            ? Schema.union(options.map(([qq, label]) => Schema.const(qq).description(label))).description(QQ_DESCRIPTION)
            : Schema.natural().description('**QQ 号**：小号还没有好友，先手填'));
    };
    ctx.setInterval(() => void refreshFriends(), FRIENDS_REFRESH_MS);

    let reconnects = 0;
    let warnedTemplate = false;
    ctx.on('login-updated', ({ bot }) => {
        if (bot.platform !== 'onebot') return;
        if (bot.status === ONLINE) {
            reconnects = 0;
            log(`NapCat 账号 ${bot.selfId} 已就绪`);
            void app.connected(Number(bot.selfId));
            void refreshFriends();
        } else if (bot.status === OFFLINE) {
            const token = String((bot.config as { token?: unknown }).token ?? '');
            if (token.includes('${{') && !warnedTemplate) {
                warnedTemplate = true;
                log('adapter-onebot 的 token 是没插值的 ${{ }} 原文：控制台保存适配器配置时不做插值，重启 Koishi 才会生效（ADR 0008）');
            }
            const delay = RECONNECT_MS[Math.min(reconnects++, RECONNECT_MS.length - 1)]!;
            log(`NapCat 连接断开，${delay / 1000} 秒后重连`);
            // 控制台重载过适配器的话旧 bot 已作废：到点时按 sid 找现在的
            const sid = bot.sid;
            ctx.setTimeout(() => {
                const current = ctx.bots.find(b => b.sid === sid);
                if (current?.status === OFFLINE) void current.start();
            }, delay);
        }
    });
    // 插件因改配置重启时适配器还连着，不会再有上线事件
    for (const bot of ctx.bots) {
        if (bot.platform === 'onebot' && bot.status === ONLINE) {
            void app.connected(Number(bot.selfId));
            void refreshFriends();
        }
    }

    // 角色卡、世界书由转换器生成（characters/<角色>/source/ → st/，ADR 0010），变了就重启插件重新读
    const cardDir = dirname(appConfig.characterCard);
    let reloadTimer: (() => void) | undefined;
    const watcher = watch(cardDir, (_event, filename) => {
        if (!filename?.endsWith('.json')) return;
        reloadTimer?.();
        reloadTimer = ctx.setTimeout(() => {
            log(`${cardDir} 下的角色卡或世界书变了，重启插件重新读`);
            ctx.scope.restart();
        }, CARD_RELOAD_DELAY_MS);
    });
    ctx.on('dispose', () => watcher.close());
}

/** NapCat get_friend_list 的一项（用到的字段） */
interface OneBotFriend {
    user_id: number;
    nickname: string;
    remark?: string;
}

/** adapter-onebot 的 bot.internal 里用到的几个（Internal.defineExtract，返回值已经取出 message_id / messages） */
interface OneBotInternal {
    sendPrivateMsg(userId: number, message: { type: string; data: Record<string, unknown> }[]): Promise<number>;
    getFriendMsgHistory(userId: string, messageSeq: undefined, count: number): Promise<HistoryMessage[]>;
    getFriendList(): Promise<OneBotFriend[]>;
}

/** 听语音、看图（ADR 0052）用到的：ocr_image 是 adapter-onebot 定义了的方法（原样返回 data），fetch_ptt_text 没有，走通用的 _get（retcode 不是 0 就抛错） */
interface OneBotMediaInternal {
    ocrImage(image: string): Promise<unknown>;
    _get(action: string, params: Record<string, unknown>): Promise<unknown>;
}
