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
import { startApp, type Transport } from '../../bot/src/app.ts';
import type { HistoryMessage } from '../../bot/src/backfill.ts';
import { CONTACT_TIERS, DEFAULTS, STICKER_MODES, parseAppConfig, type AppConfig, type ContactTier, type StickerMode } from '../../bot/src/config.ts';
import { createLog, type Log } from '../../bot/src/log.ts';
import { FACT_CHECK_MODES, type FactCheckMode } from '../../bot/src/fact-check.ts';
import { PRESENCE_MODES, QZONE_VISIBILITIES, type PresenceMode, type QzoneVisibility } from '../../bot/src/presence.ts';
import { assertKernelOk, isFriendRecall, isPokeAtMe, isPrivateFriendMessage, replySegment, type OneBotEvent } from '../../bot/src/onebot.ts';
import { ocrLines, type MediaReader } from '../../bot/src/media.ts';
import { textToSegments } from '../../bot/src/qq-faces.ts';
import { FESTIVAL_MODES, type FestivalMode } from '../../bot/src/festivals.ts';
import { PROACTIVE_MODES, type ProactiveMode } from '../../bot/src/proactive.ts';
import { PROMPT_POST_PROCESSING, type PromptPostProcessing } from '../../bot/src/st/prompt-converters.ts';
import { configuredImageDescriber, STICKER_VISION_PROMPT } from '../../bot/src/vision.ts';
import { stickerDecider, stickerShelf } from '../../bot/src/stickers.ts';
import { qqFavorites } from '../../bot/src/sticker-favorites.ts';
import { bqbDiscover } from '../../bot/src/sticker-sources.ts';
import { biliStickerScreen } from '../../bot/src/bili-stickers.ts';
import { webFoodSource, webPhotoSource } from '../../bot/src/photo-sources.ts';
import { characterPaths, registerConsole, setConsoleState } from './console.ts';

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

const FACT_CHECK_LABELS: Record<FactCheckMode, string> = { off: '关', log: '只查、只记日志，回复照发', fix: '查到就重写' };
const PRESENCE_LABELS: Record<PresenceMode, string> = { off: '关', dryRun: '只写草稿，不真做', on: '开' };
const QZONE_LABELS: Record<QzoneVisibility, string> = { friends: '仅好友可见', public: '所有人可见' };
const FESTIVAL_LABELS: Record<FestivalMode, string> = { off: '关', notes: '只让她知道今天 / 快到的是什么节', greet: '知道，并在新年零点、除夕、平安夜、情人节等主动说一句' };
const PROACTIVE_LABELS: Record<ProactiveMode, string> = { off: '关', dryRun: '试运行（只写日志不发）', on: '开' };
const STICKER_LABELS: Record<StickerMode, string> = { off: '关', collect: '只收藏核对（不发）', send: '收藏并发送' };

const POST_PROCESSING_LABELS: Record<PromptPostProcessing, string> = {
    '': '不处理',
    merge: 'merge：合并相邻的同角色消息',
    semi: 'semi：角色交替（DeepSeek 用这个）',
    strict: 'strict：用户开头、角色交替',
};

const MEMORY_BASE_URL = 'http://127.0.0.1:8888';
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
    factCheck: FactCheckMode;
    innerLife: boolean;
    herFeelings: boolean;
    herNo: boolean;
    lagTail: boolean;
    everydayLife: boolean;
    pursuits: boolean;
    shapeSplit: boolean;
    bilibiliAtName: string;
    bilibiliAtUid: number;
    reactions: boolean;
    onlineStatus: boolean;
    profileLikes: boolean;
    signature: PresenceMode;
    qzone: PresenceMode;
    qzoneVisibility: QzoneVisibility;
    feedbackCommands: boolean;
    realWeather: boolean;
    festivals: FestivalMode;
    typingStatus: boolean;
    selfRecall: boolean;
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
                .description('**知道她是程序**（ADR 0067）：勾上＝这个人知道，被认真问到是不是 AI 时按原卡（不承认、绕开）；不勾或没写＝按不知道处理，用承认版卡，被认真问到会承认。漏填不会对不知情的人否认'),
            feedback: Schema.boolean()
                .description('**可以对她的话打分**（ADR 0073）：勾上＝这个人发只有「假」或「像」一个字的消息时，记下她那一轮话是「假」还是「像」，不当聊天、她不回应。男朋友档不用勾；其余档位只对勾了的人生效，要先让他知道有这个功能。还要打开上面的「反馈通道」总开关'),
            intro: Schema.string().role('textarea', { rows: [1, 4] })
                .description('**别人提起时**：她认识的这个人，一两句（例如「网上认识的朋友，比较熟」）。名单里别人说起他的称呼时给她看，留空就是不认识（ADR 0016）'),
        })).description('**回复名单**：每人按自己的档位回复'),
        unlistedFriends: Schema.boolean().default(DEFAULTS.unlistedFriends)
            .description('**名单外的好友**：默认关闭。打开后私聊按 unlisted 档回复（被认真问到时承认是 AI）；每人 10 分钟最多 30 条，全部名单外好友合计最多 100 条'),
        schedule: Schema.boolean().default(DEFAULTS.schedule)
            .description('**作息**：按角色卡上的作息，凌晨睡觉不回、上课晚回、打字有时间。深夜测试时关掉'),
        media: Schema.boolean().default(DEFAULTS.media)
            .description('**听语音、看图上的字**（ADR 0052）：他发的语音用 QQ 自带的语音转文字，照片、截图用 NapCat 的 OCR 取上面的字（只有 Windows），她就着内容回，听完语音才回。'
                + '转不出来、没字、超时（5 秒）照旧只知道是语音、图片；表情包照旧用名字'),
        stickers: Schema.union(STICKER_MODES.map(mode => Schema.const(mode).description(STICKER_LABELS[mode]))).default(DEFAULTS.stickers)
            .description('**图片表情**（ADR 0063）：第一阶段只处理男朋友档。先用“只收藏核对”观察描述；完成真图核对和 NapCat 真发预检后，才可选“收藏并发送”。需要打开“看懂图片内容”；默认关'),
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
        moody: Schema.boolean().default(DEFAULTS.moody)
            .description('**看心情不回**（ADR 0013）：正聊着、对方一串只回了「哈哈」「嗯」这类反应时，偶尔不回（男朋友档约 15%，越疏越多，最多 35%）。'
                + '隔一分钟以上再来一条一定回；问句、图片、晚安都照样回。要开着作息'),
        speechCheck: Schema.boolean().default(DEFAULTS.speechCheck)
            .description('**说话的毛病**（ADR 0014）：发出去之前查助手腔、算账（「这会儿才想起来找我」）、怪对方没说、和她最近几次回复重复。'
                + '开头重复的「行，」这类语气词直接去掉；别的带说明重写一次，命中时这一轮晚几秒'),
        herDays: Schema.boolean().default(DEFAULTS.herDays)
            .description('**她自己的日子**（ADR 0015）：每日心情、在读的书。每天一个心情（按日期和当天课表，同一天对谁都一样），写进她说话的方式；'
                + '聊到书或她正在看书时，提示词里加上在读的三本书和进度，说错第几卷 / 章就带说明重写一次。只对卡上有心情和书的档位（陌生人、名单外没有）'),
        autonomousLife: Schema.boolean().default(DEFAULTS.autonomousLife)
            .description('**没人聊天时她一件件过日子**（ADR 0040）：按作息、课表、饭点、世界里的事和一天的打算排行动，过完记进事件账。'
                + '现在是影子模式：只记账，还不进提示词。要开着她自己的日子'),
        projectChoice: Schema.boolean().default(DEFAULTS.projectChoice)
            .description('**项目选择接管空闲安排**（ADR 0056，实验）：三天内未完成的课程作业优先于刷手机、休息、阅读和摄影；上课、吃饭、赴约等硬事件照旧优先。状态行和行动账共用同一决策。要开着上面那一项'),
        lifeInPrompt: Schema.boolean().default(DEFAULTS.lifeInPrompt)
            .description('**生活账进提示词（第一步）**：她最近三天里有几天练拍照修图、上一回是什么时候，按账上记着的写一行进时间块；只给看得到她爱好的档位。要开着上面那一项'),
        pokes: Schema.boolean().default(DEFAULTS.pokes)
            .description('**戳一戳**（ADR 0079）：名单里的人在 QQ 里戳她一下，她看到的是一条「[戳了戳你]」，像「戳我干嘛」那样短短回一句；睡着、上课时不理，5 分钟里最多算 3 下，不戳回去。默认关'),
        recalls: Schema.boolean().default(DEFAULTS.recalls)
            .description('**撤回**（ADR 0082）：他撤回了一条她还没回的消息，她看到的是「撤回了一条消息」而不是原文（像真人那样问一句「撤回啥了」）；回过的、想伤害自己的话撤回了也照样看到。默认关'),
        bilibili: Schema.union(PRESENCE_MODES.map(mode => Schema.const(mode).description(PRESENCE_LABELS[mode]))).default(DEFAULTS.bilibili)
            .description('**刷 B 站**（ADR 0084）：她从 B 站热门榜里按口味挑一个真视频（日常、搞笑、萌宠、美食、音乐、影视、游戏），连热评一起读，发给男朋友档的人并说一句感受，再把真链接发在后面；一周最多 3 个，工作日晚上、周末下午到晚上，睡着、上课、正聊着时不发。只读 B 站公开接口，不登录、不在 B 站发任何东西。选「只写草稿」时存在 presence/drafts.md。默认关'),
        bilibiliAccount: Schema.boolean().default(DEFAULTS.bilibiliAccount)
            .description('**她的 B 站号**（ADR 0089）：用她自己的 B 站号（数据目录 secrets/bilibili.json，先在命令行跑 `npm run bilibili-login -w @qqbot/bot` 扫码）按口味搜视频（三花猫、王者荣耀、宿舍日常……每天换一个词）并读字幕，分享时她知道视频里讲了什么；前三个候选里挑第一个有字幕的。只读，不在 B 站发任何东西。要上面「刷 B 站」也开着。凭证失效会在日志里说，重新扫码后重启。默认关'),
        bilibiliComment: Schema.union(PRESENCE_MODES.map(mode => Schema.const(mode).description(PRESENCE_LABELS[mode]))).default(DEFAULTS.bilibiliComment)
            .description('**在 B 站评论并 @ 他**（ADR 0089）：每次分享后在那个视频下发一条公开评论、真 @ 他的 B 站号（一周最多 3 条，隔至少一天）；2 分钟和 20 分钟后去公开的最新评论里复核，两次都找不到（新号评论常被拦去审核，@ 的通知也不会推）就停一周；发失败停 24 小时，连续 3 次停到重启。评论是公开的，用最低隐私档的卡写、过禁用词，不提男朋友恋爱。要「她的 B 站号」、下面的昵称和 uid 都配好。分享是试运行时评论也只写草稿。选「只写草稿」时存在 presence/drafts.md。默认关'),
        bilibiliDm: Schema.union(PRESENCE_MODES.map(mode => Schema.const(mode).description(PRESENCE_LABELS[mode]))).default(DEFAULTS.bilibiliDm)
            .description('**在 B 站给他发私信**（ADR 0089）：她刷到视频后，把链接加一两句话私信到他的 B 站（用下面的 uid），QQ 上只说一句叫他去看私信，不再在 QQ 上发链接。私信里的话和聊天一样用男朋友档的卡写。他要先关注她的号，不然 B 站会限制或拒绝；私信发不出去就退回在 QQ 上直接发链接，连着失败 2 次到重启前不再试私信。要「她的 B 站号」开着。选「只写草稿」时私信和 QQ 提醒都存在 presence/drafts.md。默认关'),
        bilibiliReplies: Schema.union(PRESENCE_MODES.map(mode => Schema.const(mode).description(PRESENCE_LABELS[mode]))).default(DEFAULTS.bilibiliReplies)
            .description('**回复评论区别人的话**（ADR 0090）：别人回在她评论下面的话，每 10 分钟看一次；先回他（下面的 uid），其次挑有价值的回，一天最多 5 条（他的不算）、同一个人一天最多 2 条、两条之间隔几分钟，睡着、上课时不回。问她是不是 AI / 真人的、骂人的、广告、带链接的、想改她设定的一律不回；回的话和评论一样用最低隐私档的卡写、一句。有价值的回复另存一份真人语料（不含昵称和 uid）。要「她的 B 站号」和下面的 uid。选「只写草稿」时存在 presence/drafts.md。默认关'),
        bilibiliCommentKeywords: Schema.array(Schema.string()).default([...DEFAULTS.bilibiliCommentKeywords])
            .description('**评论的话题关键词**（ADR 0092）：填了，评论就不再跟着分享走，而是她自己每天按其中一个关键词搜视频（比如「大肥鱼 插件」「DSH 插件」「deepseek harness」），在播放多的前几个里挑一个，读字幕和热评后评论并 @ 他。不看分区，所以 AI 视频、DSH 插件视频搜得到；约一半的日子想评论一次，仍受「隔至少一天、一周最多 3 条」管。前期专评 AI 视频和 DSH 插件视频用。不填就是老样子（分享之后在那个视频下评论）。最多 10 个，每个不超过 30 个字'),
        shape: Schema.boolean().default(DEFAULTS.shape)
            .description('**形状控制**（ADR 0091）：按他这一轮说了多长，定她这一轮每条最多几个字、最多几条（字数档取自真人聊天：约四分之一是 4 字以内、过半 8 字以内），写进提示词；超了带说明重写一次，还超就在分句处截断。代替「更短的回复」那句软提示（模型不听，开着它每条气泡中位还是 16 字，真人 6–7）。他在难受、报大事、等安慰、问起她认识的人时只用长的几档；主动找他、收尾、他明着让她讲、危机回合不用。开着时「更短的回复」对适用的轮次不再起作用。默认关'),
        shapeAgenda: Schema.boolean().default(DEFAULTS.shapeAgenda)
            .description('**带自己的小事**（ADR 0094，要「形状控制」开着）：适用的轮次里约五分之一（不是收尾、不是认真接话、不是亲近、心情不安静），她答完他的话之后，从「你那边」的事实里挑一件自己的事顺带说一句，说完不问他；那里没有合适的就不说，不编。这一轮至少 14 字一条、至少 2 条。默认关'),
        shapeFiller: Schema.boolean().default(DEFAULTS.shapeFiller)
            .description('**废话**（ADR 0095，要「形状控制」开着）：真人聊天里有不带内容的话（哈哈哈、嗯嗯、啊啊啊、好困、无聊），她的线上回复几乎没有。开了以后，他的话短、不是问句、不在难受 / 撒娇 / 收尾的轮次里约 7% 她只回一条不超过 4 个字、不带内容的话；他用「～」或拖长音说话时，约六成的轮次她也跟着拖音。默认关'),
        shapeFeel: Schema.boolean().default(DEFAULTS.shapeFeel)
            .description('**情绪轮**（ADR 0099，要「形状控制」开着）：适用的轮次里约 18%，她这一轮先说自己对他的一点小情绪——撒娇要确认、夸张地装崩溃、小委屈、不讲理地考验他——不把他的话处理完整。真人女生约三分之一的回复主要在表达情绪 / 态度，她更多是体贴地把事情处理完。默认关。'),
        proactiveReach: Schema.boolean().default(DEFAULTS.proactiveReach)
            .description('**他没回也继续找他、催他一下**（ADR 0100，要「主动消息」开着）：原来她主动发的有一条没回就整个停下等他回。开了以后没回的可以再发到 3 条，一条比一条隔得久（隔 2 小时、再隔 4 小时），她自己想一想要不要催他——第一次轻轻戳一下，第二次带点小脾气，也可以决定先不发；晚上 10 点半以后、他说过去睡了 / 去忙了不催；到 3 条就停，等他回。默认关。'),
        proactiveInvite: Schema.boolean().default(DEFAULTS.proactiveInvite)
            .description('**约他一起玩**（ADR 0107，要「主动消息」开着）：晚上（19:30 以后）她想起你们的固定节目——卡上写着的我的世界存档、王者双排——随口约他一句。一周最多 3 次、两次之间至少隔 2 天（他回的第一句像拒绝就隔 4 天）；他没回不催；他说过去忙 / 去睡了、他今晚有事、她自己很累 / 不舒服 / 心情不好，就不约。默认关。'),
        photos: Schema.boolean().default(DEFAULTS.photos)
            .description('**照片货架**（ADR 0109）：他要看土豆（楼下的流浪猫）/ 天空时，货架里有就发一张高清照片（只对男朋友档）。照片由她自己从网上找：Wikimedia Commons 里 CC0 / 公有领域的原图（不用署名），看图模型逐张把关——有人脸、有水印 / 文字 / 相框、不清晰、不是三花猫 / 天空的都不收；猫只收同一只（同一个系列）。需要「看图」开着才会去找；货架空着这个开关什么都不做。她本人的自拍、吃的不在里面。默认关。'),
        photoShares: Schema.boolean().default(DEFAULTS.photoShares)
            .description('**她主动发照片**（ADR 0110，要「照片货架」和「主动消息」开着）：喂完土豆、见到它的日子里，约三分之一的天她拍了张照片，过十来分钟发给他、配一句话（不用他回应）。货架里没有土豆的照片就不发；刚发过 / 今天发够了也不发。默认关。'),
        together: Schema.boolean().default(DEFAULTS.together)
            .description('**陪玩状态**（ADR 0111）：他答应了她的邀约（或她答应了他的“今晚王者双排吗”）之后的两三个小时，她正和他一起玩——回话短一点、慢一点，聊眼前这局 / 存档里的事；这段时间不插“你人呢”之类别的主动消息；谁说“下了 / 不玩了 / 睡了 / 晚安”就结束。只对男朋友档。默认关。'),
        comeBack: Schema.boolean().default(DEFAULTS.comeBack)
            .description('**说了“等下”之后自己回来**（ADR 0112，要「主动消息」开着）：她最后一句是“等下 / 我去拿个东西 / 弄完这张再说”，他没接话，过 4–14 分钟她回来说一声“回来了”，顺带说刚才那件事怎么样了；不算每天的主动条数，他在这几分钟里说了话就不回来了。默认关。'),
        relationship: Schema.boolean().default(DEFAULTS.relationship)
            .description('**关系阶段**（ADR 0113）：角色卡写着她“相处越久越敢说心里话”。最近 30 天里有 14 天以上真聊过（他那天至少说了 3 条），她会更放得开一点：想他直接说、心里的事愿意往外倒一点，仍然是她、不黏人。聊得少时保持现在的样子（只向上变，不会因为他忙而变冷）；不存分数，窗口是滑动的。只对男朋友档。默认关。'),
        jokes: Schema.boolean().default(DEFAULTS.jokes)
            .description('**小梗回头提**（ADR 0114）：情侣之间只有你们懂的玩笑。隔一阵让模型从最近两周的聊天里挑最多 3 个反复出现、当时都在笑的词 / 短句（后台抽取；代码硬校验——梗必须在聊天里原样出现过至少两次，编的丢掉）；约四分之一的轮次给她看一个，话赶话正好接得上就顺口提一句；她 72 小时内用过的不再给；你难过 / 危机 / 小别扭时不给。存在数据目录的 jokes/，可随时删。只对男朋友档。默认关。'),
        interruptions: Schema.boolean().default(DEFAULTS.interruptions)
            .description('**被第三方打断**（ADR 0115）：正聊着（最近一条在 5 分钟内），她那边发生了一件小事——世界账里有发生时刻的日常小事（室友、食堂、澡堂、查卫生……）恰好落在她上一次回话之后的几分钟里——她当场岔一下说一声（“等下，……”），细节只用世界账那一句、不编。你难过 / 危机 / 小别扭时不打断。只对男朋友档。默认关。'),
        proactiveAsk: Schema.boolean().default(DEFAULTS.proactiveAsk)
            .description('**问问他的意见**（ADR 0116，要「主动消息」开着）：下午到傍晚她拿不准一件小事（吃什么、穿什么、作业先写哪个、周末干嘛），随口问他一句，选项最多两个，不考他知识、不要他替她做大决定。一周最多 2 次、两次之间至少隔 2 天；他没回不催；他刚说过去忙 / 累了、下午晚上有事就不问；她自己难过 / 很累 / 不舒服可以只输出「不发」。默认关。'),
        hisHours: Schema.boolean().default(DEFAULTS.hisHours)
            .description('**按他平时在线的钟头排**（ADR 0117，要「主动消息」开着）：「随口说件事」「约他」「问他意见」本来就没有固定钟点，别挑在他最近三周几乎从不说话的钟头——挪到它自己时间窗内最近的、他常在线的钟头。他最近 21 天说的话少于 60 条（没规律）时不挪。默认关。'),
        weeklyReport: Schema.boolean().default(DEFAULTS.weeklyReport)
            .description('**周报**（ADR 0118）：每周日 21:30 以后自动出一份“她离真人还差多少”的数字——说话的样子（字数、一轮几条、延迟）、表情和语气、主动、日志里数到的新功能有没有真的在发生——写进数据目录的 reports/weekly-<周日日期>.md。只有数字，没有原话。也可手动：`node src/ops/weekly-report-cli.ts --write`。默认关。'),
        jealousy: Schema.boolean().default(DEFAULTS.jealousy)
            .description('**吃醋，最轻的一档**（ADR 0123）：角色卡写着她“会吃醋，但嘴上不承认”。你明确提到别的女生、并且是在说和她有来往（一起吃饭、聊天、加微信、夸她好看……）时，约一半的情况她酸一句 / 岔开话题 / 轻轻问一句“哦，谁啊”就放下。不盘问、不要你保证、不让你愧疚、不翻旧账、不威胁、不冷战、不限制你跟谁来往；你一解释 / 哄她她就松下来；3 天内只触发第一次；你难过 / 生病 / 危机 / 小别扭时让路。只对男朋友档。默认关。'),
        proactiveRoom: Schema.boolean().default(DEFAULTS.proactiveRoom)
            .description('**给主动名额留余地**（ADR 0124，要「主动消息」开着）：你一整天没回时，早安 + 催你 + 冷场会把每天的条数占满，「随口说件事」「下课」「睡前」全被挤掉（10-22 连晚安都没说成）。开了以后：睡前那句晚安不占名额；别的时机最多占「每天上限 - 1」条，留一个给「随口说件事」。总条数不超过「每天上限 + 睡前一条」，不增加催你的次数。默认关。'),
        menu: Schema.boolean().default(DEFAULTS.menu)
            .description('**每顿吃什么**（ADR 0125）：账上的“吃饭”只有午饭 / 晚饭和在哪吃，没有“吃了什么”，你问“中午吃的啥”她就现编，前后对不上。开了以后每天每顿从一张通用的学生菜单里按日期随机取一道（同一天对所有人一样、一个循环不重样），她说得出今天吃了什么、昨天吃了什么。第一次开的时候定下“从哪天起”（第二天），已经过完的日子不改。以后“吃的照片”要靠它。默认关。'),
        curious: Schema.boolean().default(DEFAULTS.curious)
            .description('**会追问**（ADR 0126）：量过，她问句率 12% 和真人持平，但问的多是口头语（「睡吧？」），问你生活、问你刚说那件事的很少——因为你说自己的事时提示词写着“别急着追问细节，真要问也只问一两个字”。开了以后：你说了件有细节的事（去了哪、见了谁、买了什么、考试 / 面试 / 项目……），约六成回完反应后问一个关于这件事本身的问题（最近几条里问过就不问，一轮最多一个）；「主动消息」开着的话，“问问你”那个时机换成“想多了解你一点”，问你自己的事。只对男朋友档。默认关。'),
        smallNews: Schema.boolean().default(DEFAULTS.smallNews)
            .description('**她会主动讲今天的小事**（ADR 0127，要「主动消息」和「日常小事」都开着）：日常小事（食堂新窗口、宿舍楼道的灯、朋友发来的搞笑图……）原来只在你问“今天干嘛了”时才说得出口，她自己从来不提，聊天就只剩作业 / 相机 / 困。开了以后：约一半的日子，她从当天碰到的小事里挑一件，过十几二十分钟随口发给你（一天最多一件，不要你回应）。只对男朋友档。默认关。'),
        foodPhotos: Schema.boolean().default(DEFAULTS.foodPhotos)
            .description('**吃的照片**（ADR 0128，要「照片货架」和「每顿吃什么」都开着）：她每天按菜单吃的那几道菜，自己去网上（Wikimedia Commons，普通人随手拍的饭，高清；看图把关：人脸 / 水印 / 招牌 / 不是这道菜的都不收；出处和许可存在货架索引里）找照片。你说“拍给我看看你吃的”时发这一顿这道菜的；主动那边（要「主动消息」开着）约每顿 18% 吃完饭拍了张发给你。没有这道菜的照片就不发，她那顿“没拍”。只对男朋友档。默认关。'),
        memes: Schema.boolean().default(DEFAULTS.memes)
            .description('**网络热梗**（ADR 0129，要「她的 B 站号」开着才会自己去学）：她的知识停在模型训练的那一天，网上现在流行的梗她一个都不知道。开了以后每 12 小时读一次 B 站热门 / 热搜、微博热搜、百度热榜，挑出可能是梗的词，用她的 B 站号搜「<词> 什么梗」、读字幕当证据，只根据证据写意思（把握不到“中”、不适合聊天的不收；政治、灾难、案件、低俗、骂人的一律不收）；聊天里你用到库里的梗，她知道意思、顺着接；没用到时约 20% 的轮次给她看最近的几个，想用就自然地用。只对男朋友档。默认关。'),
        watching: Schema.boolean().default(DEFAULTS.watching)
            .description('**她自己在 B 站看东西、形成看法**（ADR 0130，要「她的 B 站号」开着；要「内心」开着看法才会变成念头和主动消息）：每天 14 点以后她自己“看”一个视频（按口味搜、读字幕摘要和热评，只存摘要），想事情时多一个题目“你最近在 B 站看过的那个东西，你自己怎么想”；你问到“最近看了什么”时，给她真看过的两条。B 站评论区当说话语料试过（957 句只剩 39 句可用，全是“哈哈哈”“加油”），不做。只对男朋友档。默认关。'),
        texture: Schema.boolean().default(DEFAULTS.texture)
            .description('**说话的质感**（ADR 0131）：用“像不像真人”的尺子量，她的话和真人差在写法上——句末几乎不带标点、问句不带问号、没有“～”、没有小黄脸、不叠字、很少回两个字的反应。模型自己不会写这些，所以放在代码里：发出去之前按概率、按语气加（问号、“～”、语气对得上的小黄脸、叠字、偶尔 ok / hhh、去掉结尾的省略号、两条短的并成一条、先回一个字的反应）。危机和你难过 / 生病 / 小别扭的回合不加。只对男朋友档。默认关。'),
        biliStickers: Schema.boolean().default(DEFAULTS.biliStickers)
            .description('**她自己在 B 站找表情包**（ADR 0132，要「图片表情」和「她的 B 站号」开着）：表情包的候选来源换成 B 站——她的号读官方表情包（热词系列、tv_小电视；不要小黄脸、颜文字）+ 热门视频评论区里像表情包的图（真人照片、截图、广告的不收）；公开目录只在 B 站这路没东西时兜底。并且没有明确反应的、允许发表情的轮次里也约 12% 发一个（原来她线上 437 轮里只发了 1 个），顶替小黄脸。默认关。'),
        quoteReply: Schema.boolean().default(DEFAULTS.quoteReply)
            .description('**引用回复**（ADR 0136）：QQ 里长按一条消息“回复”。她以前一次都没引用过。两种明确的时候才引：他连着发了几条、其中有个不是最后一条的问题，她回答它时按概率引用它；打错字撤回失败（超过两分钟）补“*对的词”时有时引用那条错的。他自己 654 条消息里只引用过 1 次，所以这是很少出现的事。引用发不出去就去掉引用再发一次。'),
        factCheck: Schema.union(FACT_CHECK_MODES.map(mode => Schema.const(mode).description(FACT_CHECK_LABELS[mode]))).default(DEFAULTS.factCheck)
            .description('**逐条事实检查**（ADR 0137）：她最容易露馅的是编——事实里只有“土豆今天没下楼”，她写“土豆一见我撒腿就跑”；状态是在逛淘宝，她写“刚放下手机”。回复发出去之前让模型当审稿员，把回复拆成关于她自己 / 她身边世界的一条条具体说法，对照设定、这一轮的事实和聊天记录，找出“矛盾”和“事实里根本没有”的（每个回复多一次小调用，温度 0）。off 不查；log 只查、只在日志里记（敏感调试关着时只记条数），回复照发——先看误报多不多；fix 有问题就带说明重写一次，重写后再查，还有就删那几行。危机回合不查，查不成一律照发。'),
        innerLife: Schema.boolean().default(DEFAULTS.innerLife)
            .description('**内心**（ADR 0101，要「主动消息」开着）：每隔一阵（醒着时约一个半到两个半小时，聊完一段后也会想一想）她自己安静地想一想，写下一两句心里的话存起来（只记感受和想法，不记新发生的事）；想告诉他 / 想问他的念头过一会儿会变成“心里惦记”的主动消息（一天最多 2 条），最近的几个念头也放进聊天提示词，让她前后是同一个在想事情的人。默认关。'),
        herFeelings: Schema.boolean().default(DEFAULTS.herFeelings)
            .description('**心境**（ADR 0102，只给男朋友档）：她那边的事（闺蜜病了、作业快到期、买到相机）、他的态度（哄她、说他不舒服、她难过时晾了她很久）、作者写进 runtime 数据目录 moments.json 的事，在她心里留下带来由的感受——开心、难过、担心、烦——会累积、会慢慢散，表现在语气上；难过得很的时候可能忍不住哭，被他一问更容易绷不住。不存分数，每一轮从事实重算；危机回合、小别扭那一轮不放。默认关。'),
        herNo: Schema.boolean().default(DEFAULTS.herNo)
            .description('**会拒绝**（ADR 0103，只给男朋友档）：她刚推了他一件事（在上课、很累、没空）、他再磨一句，不会被磨两句就答应——软着再推一次，或者给个折中（下课以后 / 明天 / 就十分钟），他给了新理由才松口；他命令式地管着她（“不许跟别的男生说话”“听到没”）时不顺着说“好好好都听你的”，先别扭一句、明说不答应。他难过 / 生病、危机时让路；关心她的“不许熬夜”不算。默认关。'),
        lagTail: Schema.boolean().default(DEFAULTS.lagTail)
            .description('**回复延迟的长尾**（ADR 0105）：真人回消息的延迟是长尾的（公开数据里只有约 58% 的回复在 1 分钟内），她醒着空着时原来几乎全在十几秒内。开了以后一部分消息她在做别的，20 秒到一小时才看到（一来一回很快时少，冷场时多，他难受 / 问她在不在时更快）；回复一直失败（断网）十分钟以上才发出去时，时间块里多一句断网的事实，她可以顺口说一句“刚才网断了”。默认关。'),
        everydayLife: Schema.boolean().default(DEFAULTS.everydayLife)
            .description('**她每天碰到的小事**（ADR 0106）：线上事件账全是课、饭、睡这样的例行。开了以后世界里多约 90 条日常尺度的小事（外卖晚了、老师拖堂、下雨没带伞、舍友的闹钟、晚霞拍了几张、和苏雨桐 / 陈佳宁的来往、土豆的事……），按日期哈希、有天气 / 月份 / 星期条件，一天最多多 4 件；另有“小测”一条线（高数 / 概率论 / 专业课每四周一次，前一次课老师说、当天写、两天后出分，数学类偏低）。不改角色卡。带感受的小事会成为她开心 / 烦 / 担心 / 难过的来由（要开「心境」）。默认关。'),
        pursuits: Schema.boolean().default(DEFAULTS.pursuits)
            .description('**她自己的追求**（ADR 0104，只给男朋友档）：内置两条自传里写明的——「别挂科」和「用新相机拍出自己满意的东西」（买到相机之后分五步，进度来自她真的拍过 / 修过几回）。做完一步她会开心、好几天没碰有点愧疚；时间块里一小段让她知道自己在追什么（不用主动提）；配合「会拒绝」，她正在修片时他让她先放下，她可以先弄完这一小段。作者可在数据目录 pursuits.json 里暂停 / 放下 / 加自己的。默认关。'),
        shapeSplit: Schema.boolean().default(DEFAULTS.shapeSplit)
            .description('**分成几条**（ADR 0096，要「形状控制」开着）：形状控制抽出的条数（1 条约 55%、2 条约 28%、3 条约 17%）本来只是上限，真模型多半只写一行——线上和重放里 85% 的轮次只有 1 条，真人女生 59%。开了以后抽到 2 / 3 条的轮次，提示词写“分成 N 条发，一条一行”，并说明每条是一个小意思（先一条反应，再补一句想法、细节或一个小问题），不是把一句话硬断开。默认关'),
        bilibiliAtName: Schema.string().default(DEFAULTS.bilibiliAtName)
            .description('**要 @ 的人的 B 站昵称**（ADR 0089）：评论最前面会写 @昵称；不含 @ 和换行'),
        bilibiliAtUid: Schema.number().default(DEFAULTS.bilibiliAtUid)
            .description('**他的 B 站 uid**（ADR 0089）：@ 评论（要昵称和 uid 两样）和发私信（只要 uid）都用；在 B 站网页「个人空间」的网址里能看到'),
        readReceipts: Schema.boolean().default(DEFAULTS.readReceipts)
            .description('**已读回执**（ADR 0083）：她「看到」他的消息的那一刻标已读（NapCat 的 mark_private_msg_as_read），睡着、上课时不标，保持未读；「看心情不回」就成了真正的已读不回。NapCat 收到消息不会自动标已读。QQ 私聊本身没有「已读 / 未读」的显示（10-20 用户实测），所以对方看不到，无害但没有可见效果。默认关'),
        reactions: Schema.boolean().default(DEFAULTS.reactions)
            .description('**表情回应**（ADR 0083）：她看到了却不回（看心情不回、收尾后的附和）时，给他最后一条消息点个表情回应（赞、爱心、笑哭），比空着像人。**私聊里点不了**（10-20 实测：NapCat 的 set_msg_emoji_like 外层返回成功，内核结果是 65011「操作失败」，对方看不到），所以不要开；开着只会白调用并记一行失败。默认关'),
        onlineStatus: Schema.boolean().default(DEFAULTS.onlineStatus)
            .description('**在线状态**（ADR 0083）：按她的作息，睡着或说过睡了「睡觉中」、上课「学习中」、在听歌「听歌中」、其余「在线」（NapCat 的 set_online_status）；状态变了至少隔 10 分钟才改。不用「离开」：QQ 的「离开」会给每个来消息的人自动回一句预设的话（10-20 实测）。对外可见。默认关'),
        profileLikes: Schema.boolean().default(DEFAULTS.profileLikes)
            .description('**资料卡点赞**（ADR 0083）：约 80% 的日子，中午到晚上某个时刻给男朋友档的人点 1–5 个赞（NapCat 的 send_like）；睡着、上课时不点。他会收到通知。默认关'),
        signature: Schema.union(PRESENCE_MODES.map(mode => Schema.const(mode).description(PRESENCE_LABELS[mode]))).default(DEFAULTS.signature)
            .description('**个性签名**（ADR 0083）：隔 3–5 天换一条（节日当天是祝福，下雨天有雨天的；NapCat 的 set_self_longnick）。选「只写草稿」时草稿存在数据目录的 presence/drafts.md 里，不真改。默认关'),
        qzone: Schema.union(PRESENCE_MODES.map(mode => Schema.const(mode).description(PRESENCE_LABELS[mode]))).default(DEFAULTS.qzone)
            .description('**QQ 空间说说**（ADR 0083）：一周两三条，模仿「空友爱看」里常见的那种——随手一两句，有图就围着图写（图放在数据目录的 presence/photos/ 里，需要开「看懂图片内容」）。用最低隐私档的卡来写并过禁用词；选「只写草稿」时存在 presence/drafts.md 里，不真发。默认关'),
        qzoneVisibility: Schema.union(QZONE_VISIBILITIES.map(mode => Schema.const(mode).description(QZONE_LABELS[mode]))).default(DEFAULTS.qzoneVisibility)
            .description('**说说谁能看**（ADR 0083）：仅好友（默认）；所有人可见会让陌生人看到，也可能被「空友爱看」收录并收到好友申请'),
        pokeBack: Schema.boolean().default(DEFAULTS.pokeBack)
            .description('**戳回去**（ADR 0079 补）：要先开上面的「戳一戳」。算数的戳里约 40% 她也戳他一下（NapCat 的 friend_poke，要它的 packet 服务可用；不可用就只记一行日志）。默认关'),
        pokeOut: Schema.boolean().default(DEFAULTS.pokeOut)
            .description('**主动戳他**（ADR 0087）：男朋友档，聊天安静了一个半小时以上、最后一条是她说的（他没回）、不是刚道过晚安时，约三成的日子晚上她戳他一下，一周最多 3 次、隔至少 36 小时（NapCat 的 friend_poke，要它的 packet 服务可用）。他问起「戳我干嘛」她知道自己戳过。默认关'),
        grievance: Schema.boolean().default(DEFAULTS.grievance)
            .description('**有起因的小别扭与和好**（ADR 0074）：男朋友档，他隔了 3 天以上才来、这几天她发的一直没回时，她回来的头一两轮淡一点、点一句，他一解释 / 道歉 / 哄就软下来。只由这一个具体事件触发，一次只有一档，不存跨天的情绪，每轮从聊天记录的时间重算。默认关'),
        npcAsks: Schema.boolean().default(DEFAULTS.npcAsks)
            .description('**闺蜜的约**（ADR 0061）：陈佳宁、苏雨桐会约她（一起吃饭、去图书馆、微信视频），有时迟到、改到晚一点、临时取消；她按自己的课、身体、作业答应或推掉。进她的一天（状态行）和「你那边」。只给看得到这两个人的档位。默认关'),
        feedbackCommands: Schema.boolean().default(DEFAULTS.feedbackCommands)
            .description('**反馈通道**（ADR 0073）：男朋友档收到只有「假」或「像」一个字的消息（可带前面的 / 、后面的标点或一个小黄脸、QQ 的回复引用）时，记下她那一轮话是「假」还是「像」，不当聊天、她不回应。记录在数据目录的 feedback/ 里，不进日志正文。默认关'),
        realWeather: Schema.boolean().default(DEFAULTS.realWeather)
            .description('**真实天气**（ADR 0048）：她的世界里的天气按济南（在学校）/ 青岛（放假在家）实际的，每 30 分钟从 Open-Meteo 取一次；取不到照旧按日期生成'),
        festivals: Schema.union(FESTIVAL_MODES.map(mode => Schema.const(mode).description(FESTIVAL_LABELS[mode]))).default(DEFAULTS.festivals)
            .description('**公共节日**（ADR 0076）：她知道今天是平安夜、除夕、情人节……（时间块提前几天提醒）；选「主动说」时再在新年零点、除夕、平安夜、情人节、元宵、520、七夕、端午、中秋由「重要的日子」时机带一句。默认关'),
        typingStatus: Schema.boolean().default(DEFAULTS.typingStatus)
            .description('**正在输入**（ADR 0077）：她打字的那几秒，对方的 QQ 上显示「对方正在输入…」（NapCat 的 set_input_status）。只在等待超过 1.5 秒时显示，每 4 秒补发一次。默认关'),
        selfRecall: Schema.boolean().default(DEFAULTS.selfRecall)
            .description('**打错字撤回重发**（ADR 0086）：她打错字想改口时，约一半改成「先发打错的，几秒后撤回，再发对的」，他那边会看到「对方撤回了一条消息」；其余照旧补一条「*对的词」。撤回不了（超过两分钟）就补改口。大约 60 条回复里一次。默认关'),
        rhythm: Schema.boolean().default(DEFAULTS.rhythm)
            .description('**回复节奏**（ADR 0075）：打字的时间按字数算（0.6 秒 + 每字 0.18 秒，0.9–9 秒），回之前先「看 + 想」一会儿（多半 0.8–3.5 秒，偶尔几秒到半分钟）；热聊的第一条中位慢约 4 秒。默认关（老样子：0.8 秒 + 每字 0.1 秒，1–4 秒）'),
        shortReplies: Schema.boolean().default(DEFAULTS.shortReplies)
            .description('**更短的回复**（ADR 0024 的 10-19 调整，候选 5）：约一半的轮次只回很短的一句（老样子 35%）；他在难受、说担心的事（报告被打回、没过）、问起她的朋友时不加。默认关'),
        candidates: Schema.natural().min(1).max(5).default(DEFAULTS.candidates)
            .description('**挑候选**（ADR 0041）：他难过、说亲密话、收尾时一次生成几个回复、按规则挑一个（少说几句、不扯自己的事、不约「写完跟我说」）。1 是不挑；3 是这几种时候三倍的模型调用'),
        contextTurns: Schema.natural().max(40).default(DEFAULTS.contextTurns)
            .description('**最近几轮 + 要点**（ADR 0043）：0 是关（照旧放最近 80 条聊天原文）；开了是原文只放最近这么多轮（实验用 10），更早的在后台整理成几条要点。'
                + '要点没整理好的那一轮照旧放最近 80 条，不等它。只对开了长期记忆的联系人'),
        contextContacts: Schema.array(Schema.natural()).default([...DEFAULTS.contextContacts])
            .description('上面那项只对这几个 QQ 开（灰度）；空着就是名单里开了记忆的都开'),
        proactive: Schema.union(PROACTIVE_MODES.map(mode => Schema.const(mode).description(PROACTIVE_LABELS[mode]))).default(DEFAULTS.proactive)
            .description('**主动消息**（ADR 0011）：她在合适的时候先找人（早安、下课、睡前、冷场、他说过的事、重要的日子）。'
                + '只对「林梦瑶」页面档位里开了主动的档位（现在只有男朋友档），要开着作息。试运行：照算照生成，只写日志不发'),
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
        prompt: dropUndefined({ ...config.prompt, worldInfo: dropUndefined(config.prompt?.worldInfo ?? {}) }),
        characterCard: config.characterCard,
        contacts: config.contacts.map(contact => dropUndefined(contact)),
        unlistedFriends: config.unlistedFriends,
        schedule: config.schedule,
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
        ...(config.factCheck !== undefined ? { factCheck: config.factCheck } : {}),
        ...(config.innerLife !== undefined ? { innerLife: config.innerLife } : {}),
        ...(config.herFeelings !== undefined ? { herFeelings: config.herFeelings } : {}),
        ...(config.herNo !== undefined ? { herNo: config.herNo } : {}),
        ...(config.lagTail !== undefined ? { lagTail: config.lagTail } : {}),
        ...(config.everydayLife !== undefined ? { everydayLife: config.everydayLife } : {}),
        ...(config.pursuits !== undefined ? { pursuits: config.pursuits } : {}),
        ...(config.shapeSplit !== undefined ? { shapeSplit: config.shapeSplit } : {}),
        ...(config.bilibiliAtName !== undefined ? { bilibiliAtName: config.bilibiliAtName } : {}),
        ...(config.bilibiliAtUid !== undefined ? { bilibiliAtUid: config.bilibiliAtUid } : {}),
        ...(config.reactions !== undefined ? { reactions: config.reactions } : {}),
        ...(config.onlineStatus !== undefined ? { onlineStatus: config.onlineStatus } : {}),
        ...(config.profileLikes !== undefined ? { profileLikes: config.profileLikes } : {}),
        ...(config.signature !== undefined ? { signature: config.signature } : {}),
        ...(config.qzone !== undefined ? { qzone: config.qzone } : {}),
        ...(config.qzoneVisibility !== undefined ? { qzoneVisibility: config.qzoneVisibility } : {}),
        ...(config.feedbackCommands !== undefined ? { feedbackCommands: config.feedbackCommands } : {}),
        ...(config.realWeather !== undefined ? { realWeather: config.realWeather } : {}),
        ...(config.festivals !== undefined ? { festivals: config.festivals } : {}),
        ...(config.typingStatus !== undefined ? { typingStatus: config.typingStatus } : {}),
        ...(config.selfRecall !== undefined ? { selfRecall: config.selfRecall } : {}),
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
    setConsoleState({ running: false, error: undefined, status: undefined, character: characterPaths(isAbsolute(card) ? card : resolve(repoRoot, card)) });

    const migrated = migrateThinking(config);
    if (migrated) {
        ctx.logger('qqbot').info(`迁移配置：其他参数里的思考设置搬到「思考」控件（${THINKING_LABELS[migrated.llm.thinking!]}），请求体不变`);
        // 同步调用时 loader 还没登记这个实例，不会写回 koishi.yml（ADR 0009 试验结果第 3 条）；写回后插件按新配置重启
        ctx.setTimeout(() => ctx.scope.update(migrated), 0);
        return;
    }

    let appConfig: AppConfig;
    try {
        appConfig = parseAppConfig(toAppConfigInput(config), repoRoot);
    } catch (error) {
        const plain = plainError('配置有误，插件没有启动', error);
        setConsoleState({ error: plain.message });
        throw plain;
    }
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
        deleteMessage: async messageId => { await onlineBot().internal.deleteMsg(messageId); },
        pokeFriend: async userId => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('friend_poke', { user_id: String(userId) }); },
        markRead: async userId => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('mark_private_msg_as_read', { user_id: String(userId) }); },
        reactMessage: async (messageId, emojiId) => { assertKernelOk('set_msg_emoji_like', await (onlineBot().internal as unknown as OneBotMediaInternal)._get('set_msg_emoji_like', { message_id: messageId, emoji_id: String(emojiId), set: true })); },
        setOnlineStatus: async (status, ext) => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('set_online_status', { status, ext_status: ext, battery_status: 0 }); },
        sendLike: async (userId, times) => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('send_like', { user_id: String(userId), times }); },
        setSignature: async text => { await (onlineBot().internal as unknown as OneBotMediaInternal)._get('set_self_longnick', { longNick: text }); },
        postQzone: async post => String(((await (onlineBot().internal as unknown as OneBotMediaInternal)._get('send_qzone_msg', { content: post.content, ...(post.images ? { images: post.images } : {}), ugc_right: post.ugcRight })) as { tid?: unknown } | null)?.tid ?? ''),
        // 空友爱看相关的说明见 ADR 0083
        sendPrivateImage: async (userId, file, summary) => Number(await onlineBot().internal.sendPrivateMsg(userId, [{ type: 'image', data: { file, summary, sub_type: 1 } }])),
        // NapCat 的扩展动作 set_input_status（adapter-onebot 没有定义它，走通用的 _get：retcode 不是 0 就抛错；ADR 0077）
        setInputStatus: async (userId, eventType = 1) => { assertKernelOk('set_input_status', await (onlineBot().internal as unknown as OneBotMediaInternal)._get('set_input_status', { user_id: String(userId), event_type: eventType })); },
        friendHistory: (userId, count) => onlineBot().internal.getFriendMsgHistory(String(userId), undefined, count),
    };

    // 听语音、看图上的字（ADR 0052）：QQ 自带的语音转文字、NapCat 的 OCR（只有 Windows）。adapter-onebot 没有 fetch_ptt_text 的方法，用它通用的 _get
    const mediaBot = () => onlineBot().internal as unknown as OneBotMediaInternal;
    const media: MediaReader = {
        voiceToText: async messageId => String((await mediaBot()._get('fetch_ptt_text', { message_id: messageId }) as { text?: unknown } | null)?.text ?? ''),
        ocr: async image => ocrLines(await mediaBot().ocrImage(image)),
    };
    const vision = configuredImageDescriber(appConfig);
    const stickerVision = configuredImageDescriber(appConfig, STICKER_VISION_PROMPT);
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
        app = startApp({ config: appConfig, transport, log, media, vision, ...(stickers ? { stickers } : {}), ...(photoSource ? { photoSource } : {}), ...(foodSource ? { foodSource } : {}) });
    } catch (error) {
        const plain = plainError('插件没有启动', error);
        setConsoleState({ error: plain.message });
        throw plain;
    }
    setConsoleState({ running: true, error: undefined, status: () => app.status() });
    ctx.on('dispose', () => {
        app.stop();
        setConsoleState({ running: false, status: undefined });
    });

    ctx.middleware((session, next) => {
        const event = (session as Session & { onebot?: OneBotEvent }).onebot;
        if (session.platform !== 'onebot' || !event || !isPrivateFriendMessage(event)) return next();
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
