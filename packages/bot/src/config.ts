// 配置：非机密项放在 JSON 文件里（默认 runtime/bot/config.json，可用 QQBOT_CONFIG 指定），
// 机密项只从环境变量读取：
//   QQBOT_LLM_API_KEY   模型接口的 key（必填）
//   QQBOT_ONEBOT_TOKEN  NapCat OneBot 网络配置里的 token（NapCat 没设 token 时可不填）
// Koishi 插件（ADR 0008）没有 onebot 一节（连接归 adapter-onebot），其余部分和 config.json 同形，走同一个 parseAppConfig。

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { MEDIA_TIMEOUTS } from './media.ts';
import { FESTIVAL_MODES, type FestivalMode } from './festivals.ts';
import { PRESENCE_MODES, QZONE_VISIBILITIES, type PresenceMode, type QzoneVisibility } from './presence.ts';
import { PROACTIVE_MODES, type ProactiveMode } from './proactive.ts';
import { PROMPT_POST_PROCESSING, type PromptPostProcessing } from './st/prompt-converters.ts';
import { DEFAULT_WORLD_INFO_SETTINGS, type WorldInfoSettings } from './st/world-info.ts';

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
    innerLife: false,
    herFeelings: false,
    herNo: false,
    lagTail: false,
    everydayLife: false,
    pursuits: false,
    shapeSplit: false,
    bilibiliAtName: '',
    bilibiliAtUid: 0,
    reactions: false,
    onlineStatus: false,
    profileLikes: false,
    signature: 'off' as PresenceMode,
    qzone: 'off' as PresenceMode,
    qzoneVisibility: 'friends' as QzoneVisibility,
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

export function loadConfig(repoRoot: string, env: NodeJS.ProcessEnv = process.env): BotConfig {
    const path = resolvePath(repoRoot, env.QQBOT_CONFIG || 'runtime/bot/config.json');
    if (!existsSync(path)) {
        throw new Error(`找不到配置文件 ${path}，参照 packages/bot/config.example.json 创建`);
    }
    const file = JSON.parse(readFileSync(path, 'utf8')) as Json;
    const app = parseAppConfig(file, repoRoot, env);
    const onebot = section(file, 'onebot');
    return { onebot: { url: str(onebot, 'url', 'onebot'), token: env.QQBOT_ONEBOT_TOKEN ?? '' }, ...app };
}

/** config.json 里除 onebot 之外的部分（Koishi 插件的配置也是这个形状）：校验、补默认值，相对路径按仓库根目录解析 */
export function parseAppConfig(file: Json, repoRoot: string, env: NodeJS.ProcessEnv = process.env): AppConfig {
    const apiKey = env.QQBOT_LLM_API_KEY;
    if (!apiKey) throw new Error('缺少环境变量 QQBOT_LLM_API_KEY');

    const llm = section(file, 'llm');
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
        vision = {
            provider: provider as (typeof VISION_PROVIDERS)[number],
            model: str(v, 'model', 'vision'),
            ...(typeof v.baseUrl === 'string' && v.baseUrl ? { baseUrl: v.baseUrl } : {}),
            timeoutMs: num(v, 'timeoutMs', 'vision', MEDIA_TIMEOUTS.vision),
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
        innerLife: bool(file, 'innerLife', '', DEFAULTS.innerLife),
        herFeelings: bool(file, 'herFeelings', '', DEFAULTS.herFeelings),
        herNo: bool(file, 'herNo', '', DEFAULTS.herNo),
        lagTail: bool(file, 'lagTail', '', DEFAULTS.lagTail),
        everydayLife: bool(file, 'everydayLife', '', DEFAULTS.everydayLife),
        pursuits: bool(file, 'pursuits', '', DEFAULTS.pursuits),
        shapeSplit: bool(file, 'shapeSplit', '', DEFAULTS.shapeSplit),
        bilibiliAtName: bilibiliAtName(file.bilibiliAtName),
        bilibiliAtUid: bilibiliAtUid(file.bilibiliAtUid),
        reactions: bool(file, 'reactions', '', DEFAULTS.reactions),
        onlineStatus: bool(file, 'onlineStatus', '', DEFAULTS.onlineStatus),
        profileLikes: bool(file, 'profileLikes', '', DEFAULTS.profileLikes),
        signature: oneOf(file.signature, 'signature', PRESENCE_MODES, DEFAULTS.signature),
        qzone: oneOf(file.qzone, 'qzone', PRESENCE_MODES, DEFAULTS.qzone),
        qzoneVisibility: oneOf(file.qzoneVisibility, 'qzoneVisibility', QZONE_VISIBILITIES, DEFAULTS.qzoneVisibility),
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
