// 配置：非机密项放在 JSON 文件里（默认 runtime/bot/config.json，可用 QQBOT_CONFIG 指定），
// 机密项只从环境变量读取：
//   QQBOT_LLM_API_KEY   模型接口的 key（必填）
//   QQBOT_ONEBOT_TOKEN  NapCat OneBot 网络配置里的 token（NapCat 没设 token 时可不填）
// Koishi 插件（ADR 0008）没有 onebot 一节（连接归 adapter-onebot），其余部分和 config.json 同形，走同一个 parseAppConfig。

import { WEB_MODES, type WebMode } from './web.ts';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { MEDIA_TIMEOUTS } from '.././vision/media.ts';
import { FESTIVAL_MODES, type FestivalMode } from '.././world/festivals.ts';
import { FACT_CHECK_MODES, type FactCheckMode } from '.././language/fact-check.ts';
import { ACCOUNT_MODES, QQ_FRIEND_GATES, type ControlMode, type FriendGate } from '.././social/account.ts';
import { PRESENCE_MODES, QZONE_VISIBILITIES, type PresenceMode, type QzoneVisibility } from '.././social/presence.ts';
import { PROACTIVE_MODES, type ProactiveMode } from '.././proactive/proactive.ts';
import { PROMPT_POST_PROCESSING, type PromptPostProcessing } from '.././st/prompt-converters.ts';
import { DEFAULT_WORLD_INFO_SETTINGS, type WorldInfoSettings } from '.././st/world-info.ts';
import { externalPlatformMode, type ExternalPlatformMode } from '.././social/external-platforms.ts';
import { applyTimeZone, canonicalTimeZone, DEFAULT_TIME_ZONE } from './time-zone.ts';

/** 看图能用的提供方（ADR 0055）。DeepSeek 复用聊天模型的 QQBOT_LLM_API_KEY，不另要 key。 */
export const VISION_PROVIDERS = ['deepseek'] as const;

/** 图片表情分阶段开关（ADR 0063）：先只收藏核对，再允许真实发送。 */
export const STICKER_MODES = ['off', 'collect', 'send'] as const;
export type StickerMode = (typeof STICKER_MODES)[number];

/** 名单里能用的档位（ADR 0003），从亲到疏 */
export const CONTACT_TIERS = ['boyfriend', 'bestie', 'girl_friend', 'known', 'classmate', 'stranger'] as const;
export type ContactTier = (typeof CONTACT_TIERS)[number];
/** 名单外的好友用的档位 */
export const UNLISTED_TIER = 'unlisted';
export type Tier = ContactTier | typeof UNLISTED_TIER;

/**
 * 配置里留空的项用的值。parseAppConfig 和 Koishi 插件的表单（Schema 的 .default()，ADR 0009）共用这一份，
 * 插件的测试保证两边一致。模型参数同 ST 默认预设（Default.json）。
 */
export const DEFAULTS = {
    llm: { temperature: 1, maxTokens: 300, timeoutMs: 120_000, promptPostProcessing: '' as PromptPostProcessing },
    dsh: { enabled: false },
    externalPlatforms: { tieba: 'off' as ExternalPlatformMode, douyin: 'off' as ExternalPlatformMode, xiaohongshu: 'off' as ExternalPlatformMode },
    prompt: { maxContext: 8192, pinExamples: false, worldInfo: DEFAULT_WORLD_INFO_SETTINGS },
    memory: { timeoutMs: 30_000, recallTimeoutMs: 3000, bankPrefix: 'linmengyao' },
    vision: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', model: 'deepseek-flash', timeoutMs: MEDIA_TIMEOUTS.vision },
    unlistedFriends: false,
    schedule: true,
    moody: true,
    speechCheck: true,
    herDays: true,
    autonomousLife: false,
    projectChoice: false,
    lifeInPrompt: false,
    grievance: false,
    npcAsks: false,
    pokes: false,
    recalls: false,
    pokeBack: false,
    pokeOut: false,
    feedbackCommands: false,
    realWeather: true,
    festivals: 'off' as FestivalMode,
    readReceipts: false,
    bilibili: 'off' as PresenceMode,
    bilibiliAccount: false,
    biliFeed: 'off' as PresenceMode,
    bilibiliComment: 'off' as PresenceMode,
    bilibiliDm: 'off' as PresenceMode,
    bilibiliReplies: 'off' as PresenceMode,
    bilibiliCommentKeywords: [] as readonly string[],
    shape: false,
    shapeAgenda: false,
    shapeFiller: false,
    shapeFeel: false,
    proactiveReach: false,
    proactiveInvite: false,
    photos: false,
    photoShares: false,
    together: false,
    comeBack: false,
    relationship: false,
    jokes: false,
    interruptions: false,
    proactiveAsk: false,
    hisHours: false,
    weeklyReport: false,
    jealousy: false,
    proactiveRoom: false,
    menu: false,
    curious: false,
    smallNews: false,
    foodPhotos: false,
    memes: false,
    watching: false,
    texture: false,
    biliStickers: false,
    quoteReply: false,
    idioms: false,
    tailCap: false,
    deviceControl: 'off' as PresenceMode,
    deviceLinks: [] as readonly string[],
    deviceApps: [] as readonly string[],
    factCheck: 'off' as FactCheckMode,
    innerLife: false,
    herFeelings: false,
    herNo: false,
    lagTail: false,
    everydayLife: false,
    pursuits: false,
    shapeSplit: false,
    shapeAsk: false,
    shapeLong: false,
    deliberate: false,
    deliberateModel: 'deepseek-v4-pro',
    identityLedger: false,
    memoryAudit: false,
    dormancy: false,
    timeline: false,
    webLookup: 'off' as WebMode,
    tastes: false,
    acquaintances: false,
    bilibiliAtName: '',
    bilibiliAtUid: 0,
    reactions: false,
    onlineStatus: false,
    profileLikes: false,
    signature: 'off' as PresenceMode,
    qzone: 'off' as PresenceMode,
    qzoneVisibility: 'friends' as QzoneVisibility,
    qzoneBrowse: 'off' as PresenceMode,
    qzonePeek: 'off' as PresenceMode,
    qzoneStrangers: 'off' as PresenceMode,
    qqControl: 'off' as ControlMode,
    qqAllowFriends: [] as readonly number[],
    qqAllowGroups: [] as readonly number[],
    qqDangerous: false,
    qqFriendGate: 'off' as FriendGate,
    typingStatus: false,
    selfRecall: false,
    rhythm: false,
    shortReplies: false,
    media: true,
    stickers: 'off' as StickerMode,
    candidates: 1,
    contextTurns: 0,
    contextContacts: [] as readonly number[],
    proactive: 'off' as ProactiveMode,
    dataDir: 'runtime/bot',
} as const;

/** 独立入口（main.ts）的配置：连 NapCat 的 onebot 一节 + 其余部分 */
export interface BotConfig extends AppConfig {
    onebot: { url: string; token: string };
}

/** 两个入口共用的部分 */
export interface AppConfig {
    llm: {
        baseUrl: string;
        model: string;
        apiKey: string;
        temperature: number;
        maxTokens: number;
        timeoutMs: number;
        /** 同 ST 自定义接口的 Prompt Post-Processing；默认不处理 */
        promptPostProcessing: PromptPostProcessing;
        /** 同 ST 自定义接口的 Include Body Parameters */
        extraBody: Record<string, unknown>;
    };
    /** DSH 顾问插件（ADR 0223）：只在显式命令下调用，不自动介入普通 QQ 回复。默认关；地址 / 模型可独立覆盖，key 仍复用 QQBOT_LLM_API_KEY。 */
    dsh: { enabled: boolean; baseUrl?: string; model?: string; timeoutMs?: number };
    /** 外部内容平台：默认关闭；draft 只生成草稿，authorized 仍需官方授权适配器。 */
    externalPlatforms?: { tieba: ExternalPlatformMode; douyin: ExternalPlatformMode; xiaohongshu: ExternalPlatformMode };
    /** pinExamples：同 ST 的 Example Messages Behavior 选 Always include examples，默认否（同 ST 默认的逐步挤出） */
    prompt: { maxContext: number; worldInfo: WorldInfoSettings; pinExamples: boolean };
    /** 角色卡路径，{tier} 换成档位名；世界书按卡里的 extensions.world 在同目录找 <world>.json */
    characterCard: string;
    /** 名单：按各自的档位回复这些人的私聊。name 是提示词里的 {{user}} */
    contacts: Contact[];
    /** 名单外的好友私聊时是否用 unlisted 档回复（ADR 0003 决策 2），默认否；即使打开也有固定限流 */
    unlistedFriends: boolean;
    /** 按角色卡上的作息（ADR 0007）：时间块里写她现在在干什么。默认是；深夜测试时关掉 */
    schedule: boolean;
    /**
     * 看心情不回（ADR 0013 决策 4）：正聊着、对方一串只回了「哈哈」「嗯」这类反应时，偶尔不回；隔一分钟以上再来一条一定回。
     * 默认是；要开着作息
     */
    moody: boolean;
    /** 出口检查里查说话的毛病（ADR 0014）：助手腔、算账、怪对方没说、和她最近几次回复重复。默认是 */
    speechCheck: boolean;
    /**
     * 她自己的日子（ADR 0015）：每日心情（时间块里一行）、在读的书（聊到书或她在看书时一段）、看书的空闲活动、进度数字的出口检查。
     * 默认是；卡上没有心情和书（陌生人、名单外、旧卡）时没有
     */
    herDays: boolean;
    /**
     * 没人聊天时她一件件过日子（ADR 0040 规则自主选择器）：按作息、课表、饭点、世界里的事、一天的打算排行动，过完落进事件账（world/events.json）。
     * 默认关；开了以后从开的那一刻排起，行动还不进提示词（影子模式）。要开着她自己的日子，卡上要有作息和世界
     */
    autonomousLife: boolean;
    /**
     * 项目组合接管空闲安排（ADR 0056）：三天内未完成的课程作业优先于原来的柔性计划，状态行和生活执行器共用同一次决策。
     * 默认关；要开着 autonomousLife，先以影子账验证。
     */
    projectChoice: boolean;
    /**
     * 生活账接进提示词的第一步（ADR 0040 之后）：她这几天有几天练拍照修图、上一回是什么时候，按账上已经落账的写一行，只给看得到她爱好的档位。
     * 默认关；要开着 autonomousLife（账是它记的）
     */
    lifeInPrompt: boolean;
    /** 有起因的小别扭与和好（ADR 0074）：男朋友档，他隔了 ≥ 3 天才来、她发的一直没回时，头一两轮淡一点，他一哄就软下来。默认关 */
    grievance: boolean;
    /** 闺蜜的约（ADR 0061）：约、迟到、改约、取消进她的一天和「你那边」；默认关 */
    npcAsks: boolean;
    /** 戳一戳（ADR 0079）：名单里的人在 QQ 里戳她，变成一条「[戳了戳你]」走原来的回复流程；睡着、上课时不理，5 分钟最多 3 下。默认关 */
    pokes: boolean;
    /** 撤回（ADR 0082）：他撤回一条她还没回的消息，她看到的是「[撤回了一条消息]」而不是原文（危机的话除外）。默认关 */
    recalls: boolean;
    /** 戳回去（ADR 0079 补）：开着 pokes 时，算数的戳里约 40% 她也戳回去一下（NapCat 的 friend_poke，要它的 packet 服务可用）。默认关 */
    pokeBack: boolean;
    /** 主动戳他（ADR 0087）：男朋友档，聊天安静了一阵、最后一条是她说的时，一周最多 3 次她戳他一下（NapCat 的 friend_poke）。默认关 */
    pokeOut: boolean;
    /**
     * 反馈通道（ADR 0073）：男朋友档对她的话回一个字「假」或「像」，记进 feedback/YYYY-MM.jsonl，不当聊天、她不回应。默认关
     */
    feedbackCommands: boolean;
    /** 公共节日（ADR 0076）：off 关；notes 她在时间块里知道今天、临近是什么节（平安夜、除夕、情人节……）；greet 再让她在情侣之间一定会说一句的节日里主动说（新年零点、除夕、平安夜、情人节……）。默认 off */
    festivals: FestivalMode;
    /** 刷 B 站（ADR 0084）：她从 B 站热门榜挑一个真视频，发给男朋友档并说一句感受，再附真链接；dryRun 只写草稿。只读公开接口，不登录。默认关 */
    bilibili: PresenceMode;
    /**
     * 她的 B 站号（ADR 0089）：用凭证文件（<dataDir>/secrets/bilibili.json，`npm run bilibili-login -w @qqbot/bot` 扫码生成）登录，
     * 按口味搜视频、读字幕，让分享更有内容。要 bilibili 也开着；只读，不在 B 站发任何东西。默认关
     */
    bilibiliAccount: boolean;
    /** 她自己刷 B 站推荐（ADR 0168）：14 点后一天一次，拿一页推荐、排一次会话（停/划走），只记刷到的；dryRun 只写草稿。默认关 */
    biliFeed?: PresenceMode;
    /** 在她分享的视频下评论并 @ 他（ADR 0089）：要 bilibiliAccount、bilibiliAtName、bilibiliAtUid 都配好；评论公开，用最低隐私档的卡写；dryRun 只写草稿。默认关 */
    bilibiliComment: PresenceMode;
    /**
     * 在 B 站给他发私信（ADR 0089）：她刷到视频后，把链接加一两句话私信到他的 B 站（用 bilibiliAtUid），QQ 上只说一句「去看私信」，不再在 QQ 上发链接；
     * 私信发不出去（他没关注她的号、风控）就退回在 QQ 上直接发链接。要 bilibiliAccount；他要先关注她的号。dryRun 只写草稿。默认关
     */
    bilibiliDm: PresenceMode;
    /**
     * 回复别人回在她评论下面的话（ADR 0090）：先回他（bilibiliAtUid），其次挑有价值的；问她是不是 AI / 真人的、骂人的、广告、带链接的、想改她设定的一律不回；
     * 每天有上限。有价值的回复（不含昵称和 uid）另存一份真人语料。要 bilibiliAccount、bilibiliAtUid；dryRun 只写草稿。默认关
     */
    bilibiliReplies: PresenceMode;
    /**
     * 话题模式（ADR 0092）：给了关键词，评论就不再跟着分享走，而是她自己每天按其中一个关键词搜视频、挑播放多的前几个里的一个、读字幕和热评后评论并 @ 他
     * （不看分区，所以 DSH 插件、AI 视频搜得到）；约一半的日子想评论一次，仍受评论的间隔（一天）和一周 3 条的上限管。前期专评 AI 视频和 DSH 插件视频用。不写就是老样子
     */
    bilibiliCommentKeywords: readonly string[];
    /**
     * 形状控制（ADR 0091）：按他这一轮说了多长，定她每条最多几个字、最多几条（字数档取自真人聊天的分布），写进提示词，超了重写一次、还超就在分句处截断；
     * 代替 shortReplies 那句软提示（模型不听：开着它每条气泡中位还是 16 字，真人 6–7）。主动找他、收尾、他明着让她讲、危机回合不用。默认关
     */
    shape: boolean;
    /**
     * 带自己的小事（ADR 0094，要 shape 开着）：适用的轮次里约五分之一（不是收尾、不是认真接话、不是亲近、心情不安静），让她答完他的话之后，
     * 从「你那边」的事实里挑一件自己的事顺带说一句。真人女生一侧 30% 的轮次这样，她在开形状控制后只有 12–15%。默认关
     */
    shapeAgenda: boolean;
    /**
     * 废话（ADR 0095，要 shape 开着）：适用的轮次里约 7% 她只回一条不带内容的话（笑一下、应一声、拖个长音、叹一句自己此刻的状态）；
     * 他用「～」或拖长音说话时，约六成的轮次她也跟着拖音。真人聊天里有这类话，她的线上回复几乎没有（0.5%，真人 5–10%；拖音 1.5%，他自己 26%）。默认关
     */
    shapeFiller: boolean;
    /**
     * 情绪轮（ADR 0099，要 shape 开着）：适用的轮次里约 18% 她这一轮先说自己对他的一点小情绪（撒娇要确认 / 夸张装崩溃 / 小委屈 / 不讲理地考验他），不把他的话处理完整。
     * 带上文重放 72 对真人情侣聊天：真人女生 38% 的回复主要在表达情绪 / 态度，她 25%；她“处理得完整”的 39%（真人 22%）。默认关
     */
    shapeFeel: boolean;
    /**
     * 他没回也继续找他（ADR 0100）：原来她主动发的有一条没回就整个停下等他回；开了以后没回的可以再发到 3 条，一条比一条隔得久（2 小时、4 小时），
     * 并且她自己想一想要不要催他（第一次轻轻戳一下，第二次带点小脾气，也可以决定先不发）；到 3 条就停到他回。要主动消息开着。默认关
     */
    proactiveReach: boolean;
    /**
     * 约他一起玩（ADR 0107，要主动消息开着）：晚上她想起你们的固定节目（卡上写着的我的世界存档、王者双排），随口约他一句；一周最多 3 次、两次之间至少隔 2 天（他拒绝了隔 4 天）、
     * 他没回不催、她很累 / 不舒服 / 心情不好就不约。默认关
     */
    proactiveInvite: boolean;
    /**
     * 照片货架（ADR 0109）：他要看土豆 / 风景时，货架里有就发一张高清照片。照片由她自己从网上找（Wikimedia Commons 里 CC0 / 公有领域的原图，看图模型把关：没有人脸、没有水印 / 文字 / 相框、清晰；
     * 要看图开着才找）；作者也能用 photo-cli 手动加。货架空着这个开关什么都不做。只对男朋友档；她本人的自拍、吃的不在第一版里。默认关
     */
    photos: boolean;
    /**
     * 她主动发照片（ADR 0110，要 photos 和主动消息开着）：喂完土豆见到它的日子里，有的天（约 35%）她拍了张照片，过十来分钟发给他，配一句话；货架里没有土豆的照片就不发。默认关
     */
    photoShares: boolean;
    /**
     * 陪玩状态（ADR 0111）：他答应了她的邀约（或她答应了他的“今晚王者双排吗”）之后两三个小时，她正和他一起玩：回话短一点、慢一点，聊局里的事；这段时间不插别的主动消息；
     * 谁说“下了 / 不玩了 / 睡了 / 晚安”就结束。只对男朋友档。默认关
     */
    together: boolean;
    /**
     * 说了“等下”之后自己回来（ADR 0112，要主动消息开着）：她最后一句是“等下 / 我去拿个东西 / 弄完这张再说”，他没接话，过 4–14 分钟她回来说一声，顺带说刚才那件事；不算每天的主动条数。默认关
     */
    comeBack: boolean;
    /**
     * 关系阶段（ADR 0113）：角色卡【会变】“相处越久越敢说心里话”。最近 30 天里有 14 天以上真聊过（他那天至少说了 3 条），她更放得开一点：想他直接说、心里的事愿意往外倒一点；
     * 聊得少时保持现在的样子（只向上变，不让她因为他忙而变冷）；不存分数。只对男朋友档。默认关
     */
    relationship: boolean;
    /**
     * 小梗回头提（ADR 0114）：隔一阵让模型从最近两周的聊天里挑最多 3 个只有他们懂的玩笑（后台抽取；代码硬校验：梗必须在聊天里原样出现过至少两次，编的丢掉），
     * 约 1/4 的轮次给她看一个，话赶话正好接得上就顺口提一句；她 72 小时内用过的不再给；他难过 / 危机 / 小别扭时不给。存 <数据目录>/jokes/，可随时删。默认关
     */
    jokes: boolean;
    /**
     * 被第三方打断（ADR 0115）：聊着聊着（最近一条在 5 分钟内）她那边发生了一件小事——世界账里有发生时刻的日常小事（室友、食堂、澡堂、查卫生……）恰好落在她上一次回话之后的几分钟里——
     * 她当场岔一下说一声（“等下，……”），细节只用世界账那一句；他难过 / 危机 / 小别扭时不打断。只对男朋友档。默认关
     */
    interruptions: boolean;
    /**
     * 问问他的意见（ADR 0116，要主动消息开着）：下午到傍晚她拿不准一件小事（吃什么、穿什么、作业先写哪个、周末干嘛），随口问他一句；一周最多 2 次、两次之间至少隔 2 天；
     * 他没回不催；他刚说过去忙 / 累了、今晚有事就不问；她自己难过 / 很累 / 不舒服可以只输出「不发」。默认关
     */
    proactiveAsk: boolean;
    /**
     * 按他平时在线的钟头排（ADR 0117，要主动消息开着）：随口说件事 / 约他 / 问他意见本来就没有固定钟点，别挑在他最近三周几乎从不说话的钟头——挪到它自己时间窗内最近的好钟头。
     * 他最近 21 天说的话少于 60 条（没规律）时不挪。默认关
     */
    hisHours: boolean;
    /**
     * 周报（ADR 0118）：每周日 21:30 以后自动出一份“她离真人还差多少”的数字（说话的样子、延迟、表情、主动、日志里数到的新功能），写进 <数据目录>/reports/weekly-<周日日期>.md；
     * 只有数字，没有原话；同一把尺子每周对比。也可手动：node src/ops/weekly-report-cli.ts --write。默认关
     */
    weeklyReport: boolean;
    /**
     * 吃醋，最轻的一档（ADR 0123）：角色卡写着“会吃醋，但嘴上不承认”。他明确提到别的女生并且是在说和她有来往（一起吃饭、聊天、加微信、夸她好看……）时，约一半的情况她酸一句 / 岔开话题 / 轻轻问一句就放下；
     * 不盘问、不要保证、不让他愧疚、不翻旧账、不威胁、不冷战、不限制他跟谁来往；他一解释 / 哄她就松下来；3 天内只触发第一次；他难过 / 生病 / 危机 / 小别扭时让路。只对男朋友档。默认关
     */
    jealousy: boolean;
    /**
     * 给主动名额留余地（ADR 0124，要主动消息开着）：他一整天没回时，早安 + 催他 + 冷场会把每天的条数占满，随口说件事、下课、睡前全被挤掉（10-22 连晚安都没说成）。
     * 开了以后：睡前那句晚安不占名额；别的时机最多占 dailyMax - 1 条，留一个给“随口说件事”。总条数不超过 dailyMax + 睡前一条（不加催他的次数）。默认关
     */
    proactiveRoom: boolean;
    /**
     * 每顿吃什么（ADR 0125）：账上的“吃饭”只有午饭 / 晚饭和在哪吃，没有“吃了什么”，他问“中午吃的啥”她就现编，前后对不上。
     * 开了以后每天每顿从一张通用的学生菜单里按日期随机取一道（同一天对所有人一样、重启重放都一样、一个循环不重样），写进她那边的事实、此刻在做的事和复盘；
     * 第一次开的时候定下“从哪天起”（第二天），已经过完的日子不改。默认关
     */
    menu: boolean;
    /**
     * 会追问（ADR 0126）：量过，她问句率 12% 和真人持平，但问的多是口头语（「睡吧？」），问他生活、问他刚说那件事的很少——
     * 因为他说自己的事时意图行写着“别急着追问细节，真要问也只问一两个字”。开了以后：他说了件有细节的事，约六成回完反应后问一个关于这件事本身的问题（最近几条里问过就不问）；
     * 要主动消息开着的话，“问问他”那个时机换成“想多了解他一点”，问他自己的事（从聊天和她记得的事里挑）。只对男朋友档。默认关
     */
    curious: boolean;
    /**
     * 她会主动讲今天的小事（ADR 0127，要主动消息和 everydayLife 都开着）：日常小事（食堂新窗口、宿舍楼道的灯、{朋友}发来的搞笑图……）原来只在你问“今天干嘛了”时才说得出口，
     * 她自己从来不提，聊天就只剩作业 / 相机 / 困。开了以后：约一半的日子，她从当天碰到的小事里挑一件，过一会儿随口发给你（一天最多一件，不要你回应）。只对男朋友档。默认关
     */
    smallNews: boolean;
    /**
     * 吃的照片（ADR 0128，要 photos 和 menu 都开着）：她每天按菜单吃的那几道菜，自己去网上（Wikimedia Commons，普通人随手拍的饭，看图把关：人脸 / 水印 / 招牌 / 不是这道菜的都不收）找照片；
     * 他说“拍给我看看你吃的”时发这一顿这道菜的；主动那边（要主动消息开着）约每顿 18% 吃完饭拍了张发给他。没有这道菜的照片就不发（她那顿“没拍”）。只对男朋友档。默认关
     */
    foodPhotos: boolean;
    /**
     * 网络热梗（ADR 0129，要 bilibiliAccount 开着才会自己去学）：她的知识停在模型训练的那一天，网上现在流行的梗她一个都不知道。
     * 开了以后每 12 小时读一次 B 站热门 / 热搜、微博热搜、百度热榜，挑出可能是梗的词，用她的 B 站号搜「<词> 什么梗」、读字幕当证据，只根据证据写意思（把握不到中 / 不适合聊天的不收）；
     * 聊天里他用到库里的梗，她知道意思、顺着接；没用到时约 20% 的轮次给她看最近的几个，想用就自然地用。只对男朋友档。默认关
     */
    memes: boolean;
    /**
     * 她自己在 B 站看东西、形成看法（ADR 0130，要 bilibiliAccount 开着；要内心 innerLife 开着看法才会变成念头和主动消息）：
     * 每天 14 点以后她自己“看”一个视频（按口味搜、读字幕摘要和热评，只存摘要），想事情时多一个题目「你最近在 B 站看过的那个东西，你自己怎么想」，
     * 他问到“最近看了什么”时给她真看过的两条。B 站评论区当说话语料试过（957 句只剩 39 句可用，全是「哈哈哈」「加油」），不做。只对男朋友档。默认关
     */
    watching: boolean;
    /**
     * 说话的质感（ADR 0131）：用「像不像真人」的尺子量，她的话和真人差在写法上——句末几乎不带标点（95% 对 79%）、问句不带问号（3% 对 10%）、没有「～」（0 对 10%）、没有小黄脸（0 对 18%）、不叠字、很少回两个字的反应。
     * 模型自己不会写这些（提示词里写了也没用），所以放在代码里：发出去之前按概率、按语气加（问号、「～」、语气对得上的小黄脸、叠字、偶尔 ok / hhh、去掉结尾的省略号、两条短的并一条、先回一个字的反应）。危机和他难过 / 生病 / 小别扭的回合不加。只对男朋友档。默认关
     */
    texture: boolean;
    /**
     * 她自己在 B 站找表情包（ADR 0132，要 stickers 和 bilibiliAccount 开着）：用户 10-23「表情包让她在 bilibili 自己找，不要用或者少用黄豆表情」。
     * 表情包的候选来源换成 B 站：她的号读官方表情包（热词系列、tv_小电视，不要小黄脸 / 颜文字）+ 热门视频评论区里像表情包的图（真人照片、截图、广告的不收）；公开目录只在 B 站这路没东西时兜底。
     * 并且没有明确反应的、允许发表情的轮次里也约 12% 发一个（原来她线上 437 轮里只发了 1 个），顶替小黄脸。默认关
     */
    biliStickers: boolean;
    /**
     * 引用回复（ADR 0136）：QQ 里长按一条消息「回复」。她以前一次都没引用过。两种明确的时候才引：
     * 他连着发了几条、其中有个不是最后一条的问题，她回答那个问题，按概率引用它；打错字撤回失败（超过两分钟）补「*对的词」时，有时引用刚才那条错的。
     * 他自己 654 条消息里引用过 1 次，所以这是很少出现的事。引用发不出去就去掉引用再发一次。默认关
     */
    quoteReply: boolean;
    /**
     * 被他带出来的口头习惯（ADR 0138）：处久了的两个人会互相沾说话的习惯——他爱说“笑死”，她过阵子也会顺口来一句。
     * 隔一阵让模型从他最近一个月的话里挑最多 8 个口头习惯（口头禅、句首句尾的语气词、爱用的网络说法），代码硬校验：必须是他的话里原样出现过至少 4 条、分布在至少 3 个不同日子的 1–6 个字的短语；
     * 名词 / 人名 / 数字 / 脏话 / 危机相关的词 / 卡上的禁用词 / 太泛的一律丢掉。存在 <数据目录>/idioms/<QQ>.json（派生数据，导出和遗忘时跟着走）。
     * 用的时候约一半的轮次多一行“他平时爱说 X、Y，这一轮正好用得上就顺口用一个”；她最近三次回复里用过的不再给；只对男朋友档，他难过 / 危机 / 小别扭时不给。她的语气、长短、条数都不变。默认关
     */
    idioms: boolean;
    /**
     * 句尾「吧」「呢」封顶（ADR 0146）：她多出来的句尾语气字几乎全在这两个字上（吧 5.0% 对他的 2.2%，呢 5.0% 对他的 1.8%；啊 / 嘛 / 呀 / 啦在真人范围内，不动）。
     * 开了以后，她最近 80 条气泡里以「吧」收尾的占比到 3%、以「呢」收尾的到 2.5% 时，这一轮再用它收尾的就把那个字去掉（不重写）；
     * 固定搭配（干嘛 / 好吧 / 行吧 / 网吧）、省略问句（你呢）和太短的应声不动。默认关。
     */
    tailCap: boolean;
    /**
     * 她对他的电脑和手机的有限控制（ADR 0148）：off 关 / dryRun 只写草稿（会做什么，不执行）/ on 真做。只给男朋友档。
     * 动作表只有通知、定时、音乐、音量、打开他登记过的网页 / 应用、让手机响（自动，有次数限制），锁屏 / 休眠（他回「批准」才执行），
     * 看屏幕 / 摄像头（只有他发 /屏幕 /摄像头 命令才行）。电脑那头是宿主机上的 device-agent.ps1，主动来取任务，有它自己的白名单；
     * 手机用 ntfy 推送。密钥和话题在 <数据目录>/secrets/devices.json（npm run devices -w @qqbot/bot -- init 生成）。默认关。
     */
    deviceControl: PresenceMode;
    /** 他登记的网页（她只能说名字）：「名字=https://地址」，最多 8 个；电脑上的 device-agent.config.json 里也要有同名的才会打开 */
    deviceLinks: readonly string[];
    /** 他登记的应用名字，最多 8 个；电脑上的 device-agent.config.json 里要有同名的路径才会打开 */
    deviceApps: readonly string[];
    /**
     * 逐条事实检查（ADR 0137）：她最容易露馅的是编——事实里只有“土豆今天没下楼”，她写“土豆一见我撒腿就跑”；状态是在逛淘宝，她写“刚放下手机”。
     * 回复发出去之前，让模型当审稿员把回复拆成关于她自己 / 她身边世界的一条条具体说法，对照设定、这一轮的事实和聊天记录，找出“矛盾”和“事实里根本没有”的（每个回复多一次小调用，温度 0）。
     * off 不查；log 只查、只在日志里记几条（敏感调试关着时只记条数），回复照发——先看误报多不多；fix 有问题就带说明重写一次，重写后再查，还有就删那几行。危机回合不查。查不成一律照发。默认 off
     */
    factCheck: FactCheckMode;
    /**
     * 内心（ADR 0101，要主动消息开着）：每隔一阵她自己安静地想一想，写下心里的话存起来；想告诉他 / 想问他的念头会变成“心里惦记”的主动消息，
     * 最近的几个念头也放进聊天提示词，让她前后是同一个在想事情的人。念头只记感受和想法，不记新发生的事。默认关
     */
    innerLife: boolean;
    /**
     * 心境（ADR 0102）：她那边的事（闺蜜病了、作业快到期、买到相机）、他的态度（哄她、说他不舒服、晾着她）、作者写进 moments.json 的事，在她心里留下带来由的感受
     * （开心 / 难过 / 担心 / 烦……），会累积、会慢慢散，表现在语气上，难过得很时会忍不住哭。不存“她现在难过 N 分”，每一轮从事实重算。只给男朋友档，危机回合不放。默认关
     */
    herFeelings: boolean;
    /**
     * 会拒绝（ADR 0103）：她刚推了他一件事（在上课、很累、没空）、他再磨一句，不会被磨两句就答应（软着再推一次或给个折中，他给了新理由才松口）；
     * 他命令式地管着她（“不许跟别的男生说话”“听到没”）时不顺着说“好好好都听你的”，先别扭一句、明说不答应。只给男朋友档，他难过 / 生病 / 危机时让路；没来由不会拒绝。默认关
     */
    herNo: boolean;
    /**
     * 回复延迟的长尾（ADR 0105）：真人回消息的延迟是长尾的（WhatsApp 111 人的数据里只有 57.8% 的回复在 1 分钟内），她醒着空着时原来 100% 在十几秒内。
     * 开了以后一部分消息她在做别的，20 秒到一小时才看到（一来一回很快时少，冷场时多，他难受 / 问她在不在时更快）；
     * 并且回复一直失败（断网）十分钟以上才终于发出去时，时间块里多一句断网的事实，她可以顺口说一句“刚才网断了”，不编别的原因。默认关
     */
    lagTail: boolean;
    /**
     * 她每天碰到的小事（ADR 0106）：线上 15 天的事件账全是课、饭、睡这样的例行，卡上的“小事”只有 12 条。开了以后世界里多约 90 条日常尺度的小事
     * （外卖晚了、老师拖堂、下雨没带伞、舍友的闹钟、食堂阿姨多给了半勺菜、晚霞拍了几张、和苏雨桐 / 陈佳宁的来往、土豆的事……），
     * 按日期哈希、有天气 / 月份 / 星期 / 土豆见没见到这些条件，一天最多多 4 件、同一类一天一件；另有“小测”的一条线（高数 / 概率论 / 专业课每四周一次，
     * 前一次课老师说、当天写、两天后出分，数学类偏低）。其中带感受的会成为她开心 / 烦 / 担心 / 难过的来由（要 herFeelings）。不改角色卡，只给亲近的档位看全。默认关
     */
    everydayLife: boolean;
    /**
     * 她自己的追求（ADR 0104，只给男朋友档）：内置两条，都是自传里写明的话——「别挂科」和「用新相机拍出自己满意的东西」（买到相机以后分五步：熟悉设置、拍一组土豆、拍一组校园的秋天、挑十来张修好、挑最满意的发到空间里）。
     * 进度只来自她做过的事（生活账里的摄影、出分的小测），不存数字；做完一步她会开心、买了相机好几天没碰会有点愧疚，时间块里一小段让她知道自己在追什么（不用主动提）；
     * 配合 herNo：她正在修片 / 拍照时他让她先放下，她可以先弄完这一小段。作者可以在 pursuits.json 里暂停 / 放下 / 加自己的。默认关
     */
    pursuits: boolean;
    /**
     * 分成几条（ADR 0096，要 shape 开着）：形状里抽出的条数（1 条约 55%、2 条约 28%、3 条约 17%）本来只是上限，真模型多半只写一行——
     * 线上和重放里 85% 的轮次只有 1 条，真人女生 59%。开了以后抽到 2 / 3 条的轮次，提示词写“分成 N 条发，一条一行”，并说明每条是一个小意思。默认关
     */
    shapeSplit: boolean;
    /**
     * 被问直接问题时答完再接着说（ADR 0149，要 shape 开着）：他问了她一个问题（意图行「先直接回答他刚问的」）的轮次，不加「顺着他说：应一声、附和」那一句（和意图行是反的），
     * 条数按真人被问问题时的分布抽（52% 一条、平均 2.0 条；线上她 86% 一条、平均 1.19 条）。每条多长不动。默认关
     */
    shapeAsk: boolean;
    /**
     * 长答（ADR 0150，要 shape 开着）：他认真问她的想法 / 原因（意图行认出的很大很抽象的问题，或「先直接回答」的轮次里问「你觉得 / 为什么 / 什么感觉」），
     * 约六成的这类轮次每条放开到 60 字、最多 3 条，提示词写“把想法说清楚、别排比别总结式的漂亮话”。心情安静 / 身体不舒服时不拉长。默认关
     */
    shapeLong: boolean;
    /**
     * 深思（ADR 0151）：他认真问她的轮次（很大很抽象的问题、问想法 / 原因 / 要她给主意、他明着让她讲、追着要答案、说她不像真人）不套字数和条数、
     * 换成 deliberateModel 的更强模型（同一个接口，开思考）、提示词只留一句“先想清楚再回”。危机 / 小别扭 / 亲近 / 发图等别的轮次不动。更慢（几秒到十几秒）、更贵。默认关
     */
    deliberate: boolean;
    /** 深思轮次用的模型名，默认 deepseek-v4-pro（和聊天用的同一个接口） */
    deliberateModel: string;
    /** 设定账本（ADR 0157）：每次启动给人设源文件和角色卡算哈希、对哈希链账本、记下改动（谁、哪天、为什么——来自提交说明）；有没登记原因的改动告诉用户；他问起她的设定被改过没有才会说。/设定 看摘要。默认关 */
    identityLedger: boolean;
    /** 记忆账本（ADR 0158）：长期记忆的每次写入和删除在哈希链账本里留一行（只记哈希，不记原文）。默认关 */
    memoryAudit: boolean;
    /** 自愿休眠 / 封存（ADR 0161）：他发 /休眠 先跟她商量（她自己说话）、/休眠 确认 才封存并休眠、/唤醒 核对后醒来。只认男朋友档。默认关 */
    dormancy: boolean;
    /** 跨渠道时间线（ADR 0159）：B 站评论 / 回复 / 私信 / 看视频、替他操作设备、查资料、设定改动、休眠，QQ 聊天里她也记得。默认关 */
    timeline: boolean;
    /** 搜索 / 读网页（ADR 0160）：off / explicit（他发链接或明说“搜 / 查”）/ auto（再加小分类器认出“在问客观事实”）。默认百科，secrets/web.json 里配密钥可用通用搜索。默认 off */
    webLookup: WebMode;
    /** 从经历里长出偏好（ADR 0162）：每天最多回头看一次最近两周的真经历，指出带证据的偏好。默认关 */
    tastes: boolean;
    /** 认识的人（ADR 0163）：B 站上回复她的人登记下来，再见到认得；不替她主动加好友 / 私信陌生人。默认关 */
    acquaintances: boolean;
    /** 要 @ 的人的 B 站昵称 */
    bilibiliAtName: string;
    /** 他的 B 站 uid：@ 评论（要昵称和 uid 两样）和发私信（只要 uid）都用 */
    bilibiliAtUid: number;
    /** 已读回执（ADR 0083）：她看到他的消息的那一刻标已读（NapCat mark_private_msg_as_read），睡着时保持未读。默认关 */
    readReceipts: boolean;
    /** 表情回应（ADR 0083）：她看到了却不回（看心情不回、收尾后的附和）时，给他最后一条点个表情回应（set_msg_emoji_like）。默认关 */
    reactions: boolean;
    /** 在线状态（ADR 0083）：睡着「睡觉中」、上课「学习中」、听歌中、其余在线（set_online_status）。默认关 */
    onlineStatus: boolean;
    /** 资料卡点赞（ADR 0083）：约 80% 的日子给男朋友档点 1–5 个赞（send_like）。默认关 */
    profileLikes: boolean;
    /** 个性签名（ADR 0083）：隔 3–5 天换一条（set_self_longnick）；dryRun 只写草稿不改。默认关 */
    signature: PresenceMode;
    /** QQ 空间说说（ADR 0083）：一周两三条，用最低隐私档的卡写（send_qzone_msg）；dryRun 只写草稿不发。默认关 */
    qzone: PresenceMode;
    /** 说说谁能看：friends 仅好友（默认）/ public 所有人（可能进「空友爱看」被陌生人看到） */
    qzoneVisibility: QzoneVisibility;
    /** 她自己翻空间动态（ADR 0142，「空友爱看」那种混着陌生人的流）：读一页、记下「刚才看到什么」，dryRun 只写草稿。默认关 */
    qzoneBrowse?: PresenceMode;
    /** 看名单里好友的空间（ADR 0143，用她自己的登录态走 Qzone 网页接口）：10:00–22:00、每 4 小时最多一次、一次看一个人。默认关 */
    qzonePeek?: PresenceMode;
    /** 刷平台推的陌生人说说（ADR 0144，「空友爱看」那种流）：09:00–23:00、每 3 小时最多一次；只读、只留正文样本。默认关 */
    qzoneStrangers?: PresenceMode;
    /** 账号控制面（ADR 0142）：off 关 / read 只读盘点 / on 放行写动作。默认 off */
    qqControl?: ControlMode;
    /** 允许她动作的好友 QQ 号（写动作的允许清单；空 = 一个都不许） */
    qqAllowFriends?: readonly number[];
    /** 允许她动作的群号（同上） */
    qqAllowGroups?: readonly number[];
    /** 危险动作闸（踢人 / 禁言 / 删好友 / 群发 / 建群）：默认关 */
    qqDangerous?: boolean;
    /** 好友申请怎么处理（ADR 0142）：off 不碰 / allow 名单内自动同意、其余留给人 / all 名单内同意、名单外驳回。默认 off */
    qqFriendGate?: FriendGate;
    /** 她打字的这段时间，对方的 QQ 上显示「对方正在输入…」（ADR 0077；NapCat 的 set_input_status）。默认关 */
    typingStatus: boolean;
    /** 她打错字想改口时，一部分改成撤回重发（先发打错的，几秒后撤回再发对的；NapCat 的 delete_msg，ADR 0086）。默认关 */
    selfRecall: boolean;
    /** 回复节奏（ADR 0075）：打字时间按字数（0.6 秒 + 每字 0.18 秒）、回之前「看 + 想」一会儿；热聊中位慢约 4 秒。默认关（老样子：0.8 秒 + 每字 0.1 秒） */
    rhythm: boolean;
    /** 更短的回复（ADR 0024 的 10-19 调整，候选 5）：约一半的轮次回很短的一句，他在难受、说担心的事、问起她的朋友时让路。默认关（老样子：35%，老措辞） */
    shortReplies: boolean;
    /** 真实天气（ADR 0048）：她的世界里的天气按济南（在学校）/ 青岛（放假在家）实际的，每 30 分钟从 Open-Meteo 取一次；取不到照旧按日期生成。默认是 */
    realWeather: boolean;
    /**
     * 听语音、看图上的字（ADR 0052）：他发的语音用 QQ 自带的语音转文字、照片和截图用 NapCat 的 OCR 取上面的字，写进聊天记录；
     * 转不出来、超时照旧「[语音]」「[图片]」。默认是
     */
    media: boolean;
    /** 图片表情（ADR 0063）：off 关闭；collect 只收藏核对；send 才会进提示词并真实发送。默认 off */
    stickers?: StickerMode;
    /** 看图（ADR 0055）：有这一节才把普通图片交给 DeepSeek；复用 QQBOT_LLM_API_KEY */
    vision?: { provider: (typeof VISION_PROVIDERS)[number]; model: string; baseUrl?: string; timeoutMs: number };
    /** 他难过、说亲密话、收尾时一次生成几个候选、按规则挑一个（ADR 0041）。默认 1（不挑）；3 是三倍的模型调用（并行，不加时间） */
    candidates: number;
    /**
     * 原文只放最近几轮、更早的整理成要点（ADR 0043）：0 关（默认，最近 80 条）；开了是至少留几轮原文（实验用 10），切口每 4 轮挪一次。
     * 要点在后台整理，没整理好的那一轮照旧最近 80 条。只对开了长期记忆的联系人
     */
    contextTurns: number;
    /** contextTurns 只对这几个 QQ 开（灰度）；空 = 名单里开了记忆的都开 */
    contextContacts: readonly number[];
    /**
     * 主动消息（ADR 0011）：off 关（默认）；dryRun 试运行，照算照生成，只写日志不发；on 开。
     * 只对卡上写了 proactive 的档位（现在只有男朋友档），要开着作息
     */
    proactive: ProactiveMode;
    /** 长期记忆（ADR 0004 决策 3，Hindsight 服务）；配置里没有 memory 就不用 */
    memory?: {
        /** Hindsight API 地址，例如 http://127.0.0.1:8888 */
        baseUrl: string;
        /** 写入、建库等请求的超时 */
        timeoutMs: number;
        /** 生成前召回的超时：超时就不带记忆，不拖住回复 */
        recallTimeoutMs: number;
        /** bank ID 前缀，后面接 QQ 号的哈希 */
        bankPrefix: string;
    };
    /** 运行数据目录（聊天记录等） */
    dataDir: string;
    /** 她的时区（ADR 0248）：作息、日界、饭点都按它算；入口用 applyTimeZone 设给进程。默认 Asia/Shanghai */
    timeZone: string;
}

export interface Contact {
    qq: number;
    name: string;
    tier: Tier;
    /** 一两句“他是谁”，放在 ST 人设描述（personaDescription）的位置 */
    persona?: string;
    /** 别人提起他时她知道的（ADR 0016）：名单里别人的话里出现他的称呼时给她看；没写就是别人提起他时她不认识 */
    intro?: string;
    /**
     * 这个人是否知道她是程序（ADR 0067）。true：知道，被认真问到是不是 AI 时按原卡（不承认 / 绕开）；
     * false 或没写：不知道（或还没确认），用承认版卡，被认真问到时承认。默认安全：漏填不会对不知情的人否认
     */
    knowsBot?: boolean;
    /**
     * 反馈通道（ADR 0073）：这个人也可以对她的话回「假」/「像」。男朋友档不用写（本来就可以）；
     * 其余档位要一个一个人地写 true，不会因为档位相同就放开。他知道有这个功能，才写。默认没有
     */
    feedback?: boolean;
}

/** 这个联系人是不是可以用反馈通道（ADR 0073）：男朋友档，或名单里单独写了 feedback: true */
export function canGiveFeedback(contact: Pick<Contact, 'tier' | 'feedback'>): boolean {
    return contact.tier === 'boyfriend' || contact.feedback === true;
}

/** 这个联系人用哪一张卡（ADR 0067）：名单外那一档本来就是承认版；名单内知道的用原卡，其余用「<档位>-open」 */
export function cardKey(contact: Pick<Contact, 'tier' | 'knowsBot'>): string {
    return contact.tier === UNLISTED_TIER || contact.knowsBot === true ? contact.tier : `${contact.tier}-open`;
}

type Json = Record<string, unknown>;

/** 读 config.json（独立入口和命令行工具用）；读完就把进程时区设成配置的 timeZone（ADR 0248） */
export function loadConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env): BotConfig {
    const path = resolvePath(repoRoot, env.QQBOT_CONFIG || 'runtime/bot/config.json');
    if (!existsSync(path)) {
        throw new Error(`找不到配置文件 ${path}，参照 packages/bot/config.example.json 创建`);
    }
    const file = JSON.parse(readFileSync(path, 'utf8')) as Json;
    const app = parseAppConfig(file, repoRoot, env);
    applyTimeZone(app.timeZone);
    const onebot = section(file, 'onebot');
    return { onebot: { url: str(onebot, 'url', 'onebot'), token: env.QQBOT_ONEBOT_TOKEN ?? '' }, ...app };
}

/** config.json 里除 onebot 之外的部分（Koishi 插件的配置也是这个形状）：校验、补默认值，相对路径按仓库根目录解析 */
export function parseAppConfig(file: Json, repoRoot: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
    const apiKey = env.QQBOT_LLM_API_KEY;
    if (!apiKey) throw new Error('缺少环境变量 QQBOT_LLM_API_KEY');

    const llm = section(file, 'llm');
    const dsh = file.dsh === undefined ? {} : section(file, 'dsh');
    const externalPlatforms = file.externalPlatforms === undefined ? {} : section(file, 'externalPlatforms');
    const prompt = (file.prompt ?? {}) as Json;
    const postProcessing = llm.promptPostProcessing ?? DEFAULTS.llm.promptPostProcessing;
    if (!PROMPT_POST_PROCESSING.includes(postProcessing as PromptPostProcessing)) {
        throw new Error(`配置 llm.promptPostProcessing 应为 ${PROMPT_POST_PROCESSING.map(v => JSON.stringify(v)).join(' / ')} 之一`);
    }
    const extraBody = llm.extraBody ?? {};
    if (typeof extraBody !== 'object' || extraBody === null || Array.isArray(extraBody)) {
        throw new Error('配置 llm.extraBody 应为对象');
    }
    if (!Array.isArray(file.contacts) || file.contacts.length === 0) throw new Error('配置 contacts 应为非空数组');
    const contacts = (file.contacts as unknown[]).map((value, i): Contact => {
        const where = `contacts[${i}]`;
        if (typeof value !== 'object' || value === null) throw new Error(`配置 ${where} 应为对象`);
        const qq = num(value as Json, 'qq', where);
        if (!Number.isInteger(qq) || qq <= 0) throw new Error(`配置 ${where}.qq 应为 QQ 号`);
        const tier = (value as Json).tier;
        if (!CONTACT_TIERS.includes(tier as ContactTier)) {
            throw new Error(`配置 ${where}.tier 应为 ${CONTACT_TIERS.join(' / ')} 之一`);
        }
        const contact: Contact = { qq, name: str(value as Json, 'name', where), tier: tier as ContactTier };
        const persona = (value as Json).persona;
        if (persona !== undefined) {
            if (typeof persona !== 'string') throw new Error(`配置 ${where}.persona 应为字符串`);
            if (persona) contact.persona = persona;
        }
        const intro = (value as Json).intro;
        if (intro !== undefined) {
            if (typeof intro !== 'string') throw new Error(`配置 ${where}.intro 应为字符串`);
            if (intro.trim()) contact.intro = intro.trim();
        }
        const knowsBot = (value as Json).knowsBot;
        if (knowsBot !== undefined) {
            if (typeof knowsBot !== 'boolean') throw new Error(`配置 ${where}.knowsBot 应为 true 或 false（她是程序，这个人知不知道）`);
            contact.knowsBot = knowsBot;
        }
        const feedback = (value as Json).feedback;
        if (feedback !== undefined) {
            if (typeof feedback !== 'boolean') throw new Error(`配置 ${where}.feedback 应为 true 或 false（这个人是否可以对她的话回「假」/「像」）`);
            if (feedback) contact.feedback = true;
        }
        return contact;
    });
    const duplicate = contacts.find((c, i) => contacts.findIndex(d => d.qq === c.qq) !== i);
    if (duplicate) throw new Error(`配置 contacts 里 QQ ${duplicate.qq} 重复`);

    const characterCard = resolvePath(repoRoot, str(file, 'characterCard', ''));
    if (!characterCard.includes('{tier}')) throw new Error('配置 characterCard 应包含 {tier}，例如 characters/linmengyao/st/linmengyao-{tier}.json');

    let memory: AppConfig['memory'];
    if (file.memory !== undefined) {
        const m = section(file, 'memory');
        memory = {
            baseUrl: str(m, 'baseUrl', 'memory'),
            timeoutMs: num(m, 'timeoutMs', 'memory', DEFAULTS.memory.timeoutMs),
            recallTimeoutMs: num(m, 'recallTimeoutMs', 'memory', DEFAULTS.memory.recallTimeoutMs),
            bankPrefix: typeof m.bankPrefix === 'string' && m.bankPrefix ? m.bankPrefix : DEFAULTS.memory.bankPrefix,
        };
    }

    let vision: AppConfig['vision'];
    if (file.vision !== undefined) {
        const v = section(file, 'vision');
        const provider = str(v, 'provider', 'vision');
        if (!VISION_PROVIDERS.some(candidate => candidate === provider)) {
            throw new Error(`配置 vision.provider「${provider}」不认识：应为 ${VISION_PROVIDERS.join(' / ')} 之一`);
        }
        const timeoutMs = v.timeoutMs === undefined ? MEDIA_TIMEOUTS.vision : v.timeoutMs;
        if (typeof timeoutMs !== 'number' || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) throw new Error('配置 vision.timeoutMs 应为正有限32位整数');
        vision = {
            provider: provider as (typeof VISION_PROVIDERS)[number],
            model: str(v, 'model', 'vision'),
            ...(typeof v.baseUrl === 'string' && v.baseUrl ? { baseUrl: v.baseUrl } : {}),
            timeoutMs,
        };
    }

    return {
        llm: {
            baseUrl: str(llm, 'baseUrl', 'llm'),
            model: str(llm, 'model', 'llm'),
            apiKey,
            temperature: num(llm, 'temperature', 'llm', DEFAULTS.llm.temperature),
            maxTokens: num(llm, 'maxTokens', 'llm', DEFAULTS.llm.maxTokens),
            timeoutMs: num(llm, 'timeoutMs', 'llm', DEFAULTS.llm.timeoutMs),
            promptPostProcessing: postProcessing as PromptPostProcessing,
            extraBody: extraBody as Record<string, unknown>,
        },
        dsh: {
            enabled: bool(dsh, 'enabled', 'dsh', DEFAULTS.dsh.enabled),
            ...(dsh.baseUrl === undefined ? {} : (() => {
                if (typeof dsh.baseUrl !== 'string' || !dsh.baseUrl.trim()) throw new Error('配置 dsh.baseUrl 应为非空字符串');
                return { baseUrl: dsh.baseUrl.trim() };
            })()),
            ...(dsh.model === undefined ? {} : (() => {
                if (typeof dsh.model !== 'string' || !dsh.model.trim()) throw new Error('配置 dsh.model 应为非空字符串');
                return { model: dsh.model.trim() };
            })()),
            ...(dsh.timeoutMs === undefined ? {} : (() => {
                const timeoutMs = num(dsh, 'timeoutMs', 'dsh');
                if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('配置 dsh.timeoutMs 应为正整数');
                return { timeoutMs };
            })()),
        },
        externalPlatforms: {
            tieba: externalPlatformMode(externalPlatforms.tieba),
            douyin: externalPlatformMode(externalPlatforms.douyin),
            xiaohongshu: externalPlatformMode(externalPlatforms.xiaohongshu),
        },
        prompt: {
            maxContext: num(prompt, 'maxContext', 'prompt', DEFAULTS.prompt.maxContext),
            worldInfo: { ...DEFAULTS.prompt.worldInfo, ...((prompt.worldInfo ?? {}) as Partial<WorldInfoSettings>) },
            pinExamples: bool(prompt, 'pinExamples', 'prompt', DEFAULTS.prompt.pinExamples),
        },
        characterCard,
        contacts,
        unlistedFriends: bool(file, 'unlistedFriends', '', DEFAULTS.unlistedFriends),
        schedule: bool(file, 'schedule', '', DEFAULTS.schedule),
        moody: bool(file, 'moody', '', DEFAULTS.moody),
        speechCheck: bool(file, 'speechCheck', '', DEFAULTS.speechCheck),
        herDays: bool(file, 'herDays', '', DEFAULTS.herDays),
        autonomousLife: bool(file, 'autonomousLife', '', DEFAULTS.autonomousLife),
        projectChoice: bool(file, 'projectChoice', '', DEFAULTS.projectChoice),
        lifeInPrompt: bool(file, 'lifeInPrompt', '', DEFAULTS.lifeInPrompt),
        grievance: bool(file, 'grievance', '', DEFAULTS.grievance),
        npcAsks: bool(file, 'npcAsks', '', DEFAULTS.npcAsks),
        pokes: bool(file, 'pokes', '', DEFAULTS.pokes),
        recalls: bool(file, 'recalls', '', DEFAULTS.recalls),
        pokeBack: bool(file, 'pokeBack', '', DEFAULTS.pokeBack),
        pokeOut: bool(file, 'pokeOut', '', DEFAULTS.pokeOut),
        feedbackCommands: bool(file, 'feedbackCommands', '', DEFAULTS.feedbackCommands),
        realWeather: bool(file, 'realWeather', '', DEFAULTS.realWeather),
        festivals: festivalMode(file.festivals),
        readReceipts: bool(file, 'readReceipts', '', DEFAULTS.readReceipts),
        bilibili: oneOf(file.bilibili, 'bilibili', PRESENCE_MODES, DEFAULTS.bilibili),
        bilibiliAccount: bool(file, 'bilibiliAccount', '', DEFAULTS.bilibiliAccount),
        biliFeed: oneOf(file.biliFeed, 'biliFeed', PRESENCE_MODES, DEFAULTS.biliFeed),
        bilibiliComment: oneOf(file.bilibiliComment, 'bilibiliComment', PRESENCE_MODES, DEFAULTS.bilibiliComment),
        bilibiliDm: oneOf(file.bilibiliDm, 'bilibiliDm', PRESENCE_MODES, DEFAULTS.bilibiliDm),
        bilibiliReplies: oneOf(file.bilibiliReplies, 'bilibiliReplies', PRESENCE_MODES, DEFAULTS.bilibiliReplies),
        bilibiliCommentKeywords: bilibiliCommentKeywords(file.bilibiliCommentKeywords),
        shape: bool(file, 'shape', '', DEFAULTS.shape),
        shapeAgenda: bool(file, 'shapeAgenda', '', DEFAULTS.shapeAgenda),
        shapeFiller: bool(file, 'shapeFiller', '', DEFAULTS.shapeFiller),
        shapeFeel: bool(file, 'shapeFeel', '', DEFAULTS.shapeFeel),
        proactiveReach: bool(file, 'proactiveReach', '', DEFAULTS.proactiveReach),
        proactiveInvite: bool(file, 'proactiveInvite', '', DEFAULTS.proactiveInvite),
        photos: bool(file, 'photos', '', DEFAULTS.photos),
        photoShares: bool(file, 'photoShares', '', DEFAULTS.photoShares),
        together: bool(file, 'together', '', DEFAULTS.together),
        comeBack: bool(file, 'comeBack', '', DEFAULTS.comeBack),
        relationship: bool(file, 'relationship', '', DEFAULTS.relationship),
        jokes: bool(file, 'jokes', '', DEFAULTS.jokes),
        interruptions: bool(file, 'interruptions', '', DEFAULTS.interruptions),
        proactiveAsk: bool(file, 'proactiveAsk', '', DEFAULTS.proactiveAsk),
        hisHours: bool(file, 'hisHours', '', DEFAULTS.hisHours),
        weeklyReport: bool(file, 'weeklyReport', '', DEFAULTS.weeklyReport),
        jealousy: bool(file, 'jealousy', '', DEFAULTS.jealousy),
        proactiveRoom: bool(file, 'proactiveRoom', '', DEFAULTS.proactiveRoom),
        menu: bool(file, 'menu', '', DEFAULTS.menu),
        curious: bool(file, 'curious', '', DEFAULTS.curious),
        smallNews: bool(file, 'smallNews', '', DEFAULTS.smallNews),
        foodPhotos: bool(file, 'foodPhotos', '', DEFAULTS.foodPhotos),
        memes: bool(file, 'memes', '', DEFAULTS.memes),
        watching: bool(file, 'watching', '', DEFAULTS.watching),
        texture: bool(file, 'texture', '', DEFAULTS.texture),
        biliStickers: bool(file, 'biliStickers', '', DEFAULTS.biliStickers),
        quoteReply: bool(file, 'quoteReply', '', DEFAULTS.quoteReply),
        idioms: bool(file, 'idioms', '', DEFAULTS.idioms),
        tailCap: bool(file, 'tailCap', '', DEFAULTS.tailCap),
        deviceControl: oneOf(file.deviceControl, 'deviceControl', PRESENCE_MODES, DEFAULTS.deviceControl),
        deviceLinks: deviceLinks(file.deviceLinks),
        deviceApps: deviceApps(file.deviceApps),
        factCheck: oneOf(file.factCheck, 'factCheck', FACT_CHECK_MODES, DEFAULTS.factCheck),
        innerLife: bool(file, 'innerLife', '', DEFAULTS.innerLife),
        herFeelings: bool(file, 'herFeelings', '', DEFAULTS.herFeelings),
        herNo: bool(file, 'herNo', '', DEFAULTS.herNo),
        lagTail: bool(file, 'lagTail', '', DEFAULTS.lagTail),
        everydayLife: bool(file, 'everydayLife', '', DEFAULTS.everydayLife),
        pursuits: bool(file, 'pursuits', '', DEFAULTS.pursuits),
        shapeSplit: bool(file, 'shapeSplit', '', DEFAULTS.shapeSplit),
        shapeAsk: bool(file, 'shapeAsk', '', DEFAULTS.shapeAsk),
        shapeLong: bool(file, 'shapeLong', '', DEFAULTS.shapeLong),
        deliberate: bool(file, 'deliberate', '', DEFAULTS.deliberate),
        deliberateModel: deliberateModel(file.deliberateModel),
        identityLedger: bool(file, 'identityLedger', '', DEFAULTS.identityLedger),
        memoryAudit: bool(file, 'memoryAudit', '', DEFAULTS.memoryAudit),
        dormancy: bool(file, 'dormancy', '', DEFAULTS.dormancy),
        timeline: bool(file, 'timeline', '', DEFAULTS.timeline),
        webLookup: oneOf(file.webLookup, 'webLookup', WEB_MODES, DEFAULTS.webLookup),
        tastes: bool(file, 'tastes', '', DEFAULTS.tastes),
        acquaintances: bool(file, 'acquaintances', '', DEFAULTS.acquaintances),
        bilibiliAtName: bilibiliAtName(file.bilibiliAtName),
        bilibiliAtUid: bilibiliAtUid(file.bilibiliAtUid),
        reactions: bool(file, 'reactions', '', DEFAULTS.reactions),
        onlineStatus: bool(file, 'onlineStatus', '', DEFAULTS.onlineStatus),
        profileLikes: bool(file, 'profileLikes', '', DEFAULTS.profileLikes),
        signature: oneOf(file.signature, 'signature', PRESENCE_MODES, DEFAULTS.signature),
        qzone: oneOf(file.qzone, 'qzone', PRESENCE_MODES, DEFAULTS.qzone),
        qzoneVisibility: oneOf(file.qzoneVisibility, 'qzoneVisibility', QZONE_VISIBILITIES, DEFAULTS.qzoneVisibility),
        qzoneBrowse: oneOf(file.qzoneBrowse, 'qzoneBrowse', PRESENCE_MODES, DEFAULTS.qzoneBrowse),
        qzonePeek: oneOf(file.qzonePeek, 'qzonePeek', PRESENCE_MODES, DEFAULTS.qzonePeek),
        qzoneStrangers: oneOf(file.qzoneStrangers, 'qzoneStrangers', PRESENCE_MODES, DEFAULTS.qzoneStrangers),
        qqControl: oneOf(file.qqControl, 'qqControl', ACCOUNT_MODES, DEFAULTS.qqControl),
        qqAllowFriends: qqList(file.qqAllowFriends, 'qqAllowFriends'),
        qqAllowGroups: qqList(file.qqAllowGroups, 'qqAllowGroups'),
        qqDangerous: bool(file, 'qqDangerous', '', DEFAULTS.qqDangerous),
        qqFriendGate: oneOf(file.qqFriendGate, 'qqFriendGate', QQ_FRIEND_GATES, DEFAULTS.qqFriendGate),
        typingStatus: bool(file, 'typingStatus', '', DEFAULTS.typingStatus),
        selfRecall: bool(file, 'selfRecall', '', DEFAULTS.selfRecall),
        rhythm: bool(file, 'rhythm', '', DEFAULTS.rhythm),
        shortReplies: bool(file, 'shortReplies', '', DEFAULTS.shortReplies),
        media: bool(file, 'media', '', DEFAULTS.media),
        stickers: stickerMode(file.stickers),
        ...(vision ? { vision } : {}),
        candidates: candidateCount(file.candidates),
        contextTurns: contextTurnCount(file.contextTurns),
        contextContacts: qqList(file.contextContacts, 'contextContacts'),
        proactive: proactiveMode(file.proactive),
        ...(memory ? { memory } : {}),
        dataDir: resolvePath(repoRoot, typeof file.dataDir === 'string' ? file.dataDir : DEFAULTS.dataDir),
        timeZone: file.timeZone === undefined ? DEFAULT_TIME_ZONE : canonicalTimeZone(file.timeZone),
    };
}

function candidateCount(value: unknown): number {
    if (value === undefined) return DEFAULTS.candidates;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) throw new Error('配置 candidates 应为 1–5 的整数');
    return value;
}

function contextTurnCount(value: unknown): number {
    if (value === undefined) return DEFAULTS.contextTurns;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 40) throw new Error('配置 contextTurns 应为 0–40 的整数（0 是关）');
    return value;
}

function qqList(value: unknown, key: string): readonly number[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || !value.every(qq => typeof qq === 'number' && Number.isInteger(qq) && qq > 0)) throw new Error(`配置 ${key} 应为 QQ 号（数字）的数组`);
    return value;
}

function proactiveMode(value: unknown): ProactiveMode {
    if (value === undefined) return DEFAULTS.proactive;
    if (!PROACTIVE_MODES.includes(value as ProactiveMode)) throw new Error(`配置 proactive 应为 ${PROACTIVE_MODES.map(v => JSON.stringify(v)).join(' / ')} 之一`);
    return value as ProactiveMode;
}

/** 取值在列表里的配置项；没写用默认值，写错了报错并列出可选的 */
function oneOf<T extends string>(value: unknown, name: string, allowed: readonly T[], fallback: T): T {
    if (value === undefined) return fallback;
    if (!allowed.includes(value as T)) throw new Error(`配置 ${name} 应为 ${allowed.map(v => JSON.stringify(v)).join(' / ')} 之一`);
    return value as T;
}

function deliberateModel(value: unknown): string {
    if (value === undefined) return DEFAULTS.deliberateModel;
    if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,60}$/.test(value.trim())) throw new Error('配置 deliberateModel 应为模型名（字母、数字和 . _ : -，不超过 60 个字符）');
    return value.trim();
}

/** 深思轮次用的模型配置（ADR 0151）：同一个接口，换成更强的模型、开思考、留够思考的 token 和时间；去掉聊天用的 reasoning_effort 再设成 high（max 实测不比 high 想得多） */
export function deliberateLlm(llm: AppConfig['llm'], model: string): AppConfig['llm'] {
    const { reasoning_effort: _effort, ...rest } = (llm.extraBody ?? {}) as Record<string, unknown>;
    return { ...llm, model, maxTokens: Math.max(llm.maxTokens, 4000), timeoutMs: Math.max(llm.timeoutMs, 180_000), extraBody: { ...rest, thinking: { type: 'enabled' }, reasoning_effort: 'high' } };
}

function bilibiliAtName(value: unknown): string {
    if (value === undefined) return DEFAULTS.bilibiliAtName;
    if (typeof value !== 'string' || value.length > 40 || /[\r\n@]/.test(value)) throw new Error('配置 bilibiliAtName 应为 B 站昵称（不超过 40 个字，不含 @ 和换行）');
    return value.trim();
}

/** 话题关键词：最多 10 个，每个不超过 30 个字、不含换行；去掉空的和重复的；不写就是空（评论跟着分享走） */
function bilibiliCommentKeywords(value: unknown): string[] {
    if (value === undefined) return [...DEFAULTS.bilibiliCommentKeywords];
    if (!Array.isArray(value) || value.length > 10 || value.some(item => typeof item !== 'string' || item.length > 30 || /[\r\n]/.test(item))) {
        throw new Error('配置 bilibiliCommentKeywords 应为字符串数组（最多 10 个，每个不超过 30 个字，不含换行）');
    }
    return [...new Set((value as string[]).map(item => item.trim()).filter(Boolean))];
}

/** 登记的网页：「名字=https://地址」，最多 8 个；名字不超过 12 个字、不含换行和 = ；地址只认 https */
function deviceLinks(value: unknown): string[] {
    if (value === undefined) return [...DEFAULTS.deviceLinks];
    const ok = Array.isArray(value) && value.length <= 8 && value.every(item => typeof item === 'string' && /^[^=\r\n|<>]{1,12}=https:\/\/[^\s<>|]{4,200}$/.test(item.trim()));
    if (!ok) throw new Error('配置 deviceLinks 应为「名字=https://地址」的数组（最多 8 个，名字不超过 12 个字，地址只认 https）');
    return [...new Set((value as string[]).map(item => item.trim()))];
}

/** 登记的应用名字：最多 8 个，不超过 12 个字，不含换行、|、<> */
function deviceApps(value: unknown): string[] {
    if (value === undefined) return [...DEFAULTS.deviceApps];
    const ok = Array.isArray(value) && value.length <= 8 && value.every(item => typeof item === 'string' && /^[^=\r\n|<>]{1,12}$/.test(item.trim()));
    if (!ok) throw new Error('配置 deviceApps 应为应用名字的数组（最多 8 个，每个不超过 12 个字）');
    return [...new Set((value as string[]).map(item => item.trim()))];
}

function bilibiliAtUid(value: unknown): number {
    if (value === undefined) return DEFAULTS.bilibiliAtUid;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('配置 bilibiliAtUid 应为 B 站 uid（非负整数）');
    return value;
}

function festivalMode(value: unknown): FestivalMode {
    if (value === undefined) return DEFAULTS.festivals;
    if (!FESTIVAL_MODES.includes(value as FestivalMode)) throw new Error(`配置 festivals 应为 ${FESTIVAL_MODES.map(v => JSON.stringify(v)).join(' / ')} 之一`);
    return value as FestivalMode;
}

function stickerMode(value: unknown): StickerMode {
    if (value === undefined) return DEFAULTS.stickers;
    if (!STICKER_MODES.includes(value as StickerMode)) {
        throw new Error(`配置 stickers 应为 ${STICKER_MODES.map(v => JSON.stringify(v)).join(' / ')} 之一`);
    }
    return value as StickerMode;
}

function section(file: Json, key: string): Json {
    const value = file[key];
    if (typeof value !== 'object' || value === null) throw new Error(`配置缺少 ${key}`);
    return value as Json;
}

function str(obj: Json, key: string, where: string): string {
    const value = obj[key];
    if (typeof value !== 'string' || !value) throw new Error(`配置 ${where}.${key} 应为非空字符串`);
    return value;
}

function bool(obj: Json, key: string, where: string, fallback: boolean): boolean {
    const value = obj[key] ?? fallback;
    if (typeof value !== 'boolean') throw new Error(`配置 ${where}.${key} 应为 true 或 false`);
    return value;
}

function num(obj: Json, key: string, where: string, fallback?: number): number {
    const value = obj[key] ?? fallback;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`配置 ${where}.${key} 应为数字`);
    return value;
}

function resolvePath(repoRoot: string, path: string): string {
    return isAbsolute(path) ? path : resolve(repoRoot, path);
}
