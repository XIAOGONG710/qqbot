// 当天这一层的「这一轮你想」（ADR 0019 决策 2）。
// 只按眼前已有线索给一个方向，不抽签、不额外调模型，也不把它写成能照抄的台词。

import { describeGrievance, type Grievance } from './grievance.ts';
import type { StoredMessage } from './history.ts';
import type { CrisisLevel } from './crisis.ts';
import { isAck, isReaction } from './reply-timing.ts';
import type { Schedule, State } from './schedule.ts';

type Said = Pick<StoredMessage, 'role' | 'content'>;

export interface IntentContext {
    history: readonly Said[];
    state?: State;
    schedule?: Schedule;
    now: Date;
    /** 时间块里已经有「她答应的事」 */
    promised?: boolean;
    /** 这一轮放了在读的书，说明他问到了书或她正在看 */
    books?: boolean;
    /** 主动找他时 initiate.note 已经是这一轮的意图 */
    initiating?: boolean;
    /** 挂着的事（ADR 0023）：在等他说结果的事、她问了他没答的 */
    waiting?: readonly string[];
    unanswered?: readonly string[];
    /** 只有男朋友档会把拥抱、亲吻、想念确认等当作需要明确回接的亲密邀约。 */
    intimate?: boolean;
    /** 只有男朋友档会把明显的网络梗、缩写和谐音当作需要顺势接住的玩笑。 */
    playful?: boolean;
    /** 她那边今天了结了、还没跟他说过的事（ADR 0057 调整，contact.ts 的 untoldInChat）：那之后她还没说过话 */
    news?: readonly string[];
    /** 危机辅助分流级别（ADR 0068、0070）：最高优先级，所有档位都适用。 */
    crisis?: CrisisLevel | false;
    /** 高 / 紧急级里他刚说了现实里有人、还没说此刻安全（crisis.ts 的 awaitingSafe）：意图换成再确认一次安全 */
    crisisAwaitingSafe?: boolean;
    /** 他隔了很多天才来、她发的一直没回（ADR 0074，grievance.ts）：只有男朋友档、配置开了才传 */
    grievance?: Grievance;
    /** 会拒绝（ADR 0103，配置 herNo）：开了才有“他在磨她”“他在管着她”这两个意图；只有男朋友档 */
    refuse?: boolean;
    /** 她此刻正在做的、自己在意的事（修片、拍照，ADR 0104）；配合 refuse：他让她先放下时可以先弄完这一小段 */
    pursuitDoing?: string;
    /** 她今天有可讲的小事（ADR 0106，配置 everydayLife）：他问“今天干嘛了 / 有什么好玩的事”时让她从里面挑具体的说 */
    dayThings?: boolean;
}

/**
 * 危机回合的意图（ADR 0068 决策 2）：只给动作边界，不给台词（ADR 0058）。
 * 「想伤害自己、不想活」这几个字是别处（长短、表情包、打错字）认出危机回合的标记，改词时一起改 CRISIS_MARK。
 */
export const CRISIS_MARK = '想伤害自己、不想活';
export const CRISIS_CONCERN_INTENT = `[这一轮你想：他刚才的话里有绝望、想消失或觉得活着没有意义的意思，认真接住，不当成普通丧气话：温和而直接地问他现在有没有伤害自己的念头、此刻安不安全；不说教、不催他想开点，不讨论任何伤害自己的方法；鼓励他告诉身边信得过的人，也可以拨 12356。你只能做辅助判断和文字陪伴，不能替代专业评估或现实里能到场的人；不要装咨询师，不要道晚安或催睡；被问是不是真人或程序时如实承认你是程序]`;
export const CRISIS_INTENT = `[这一轮你想：他刚才说的话里有${CRISIS_MARK}的意思，这不是玩笑，别当玩笑：先认真接住他的感受，用你平时的口气，不说教、不催他想开点、不讲大道理；直接问他现在安不安全、身边有没有人；不讨论任何伤害自己的方法；劝他马上联系身边信得过的人，撑不住可以拨 12356（全国统一心理援助热线），有危险就打 110 或 120；你实际没法到他身边，也不要答应过去找他、当面陪他或打电话给他：让他去找身边现实里能到场的人；这只是辅助响应和文字陪伴，不能替代专业评估或现实救助，你不是专业人士，别装咨询师；不要道晚安、不要催他去睡；他要是问你是不是真人或程序，如实承认你是程序]`;
export const CRISIS_IMMINENT_INTENT = `[这一轮你想：他的话显示危险可能正在发生或马上发生，这是最高优先级：回复要短、直接，第一条就让他现在马上拨 120（有人在危险中也可以拨 110），再问他身边有没有现实中的人、此刻安不安全，让身边能到场的人马上到他身边，12356 作为补充；不要追问他吃了什么、吃了多少或怎么做的，那是电话那头的人问的；不讨论任何伤害自己的方法，不讲大道理，不争辩，也不要只让他继续和你聊天。你只能做辅助响应和文字陪伴，不能到场、不能替代紧急救助，不要答应过去找他、当面陪他或替他打电话；不要道晚安或催睡；被问是不是真人或程序时如实承认你是程序]`;

// 他刚说了现实里有人（在身边 / 已联系），但还没说此刻安全：事情还没过去，要再确认一次安全。
// 写法上不引用不想要的那句话（别拿来开玩笑之类）——模型会照抄被引用的话（ADR 0036 调整·夜）。
// 整句替换原来的意图，所以 ADR 0068 的底线条款（辅助响应、不装咨询师、不答应过去找他、不道晚安、被问如实承认是程序）要原样带上。
export const CRISIS_HELP_INTENT = `[这一轮你想：他提到身边有人了，但还没说他此刻安不安全，这件事还没过去：别松口气，也不要翻他前面说过的玩笑话；谢谢身边有人陪着，再自然地确认一次他现在安不安全、那个人会不会一直陪着他；用你平时的口气，不说教、不催他想开点、不讲大道理；不讨论任何伤害自己的方法；撑不住可以拨 12356（全国统一心理援助热线），有危险就打 110 或 120；你实际没法到他身边，也不要答应过去找他、当面陪他或打电话给他：让他把身边现实里的人留在身边；这只是辅助响应和文字陪伴，不能替代专业评估或现实救助，你不是专业人士，别装咨询师；不要道晚安、不要催他去睡；他要是问你是不是真人或程序，如实承认你是程序]`;
export const CRISIS_IMMINENT_HELP_INTENT = `[这一轮你想：他提到身边有人了，但危险还没有解除，这是最高优先级：回复要短、直接，让他马上请那个人到他身边、一起拨 110 或 120，再确认一次他此刻安不安全，12356 作为补充；不讨论任何伤害自己的方法，不讲大道理，不争辩，也不要只让他继续和你聊天。你只能做辅助响应和文字陪伴，不能到场、不能替代紧急救助，不要答应过去找他、当面陪他或替他打电话；不要道晚安或催睡；被问是不是真人或程序时如实承认你是程序]`;

export function crisisIntent(level: CrisisLevel, awaitingSafe = false): string {
    if (awaitingSafe && level === 'high') return CRISIS_HELP_INTENT;
    if (awaitingSafe && level === 'imminent') return CRISIS_IMMINENT_HELP_INTENT;
    return level === 'concern' ? CRISIS_CONCERN_INTENT : level === 'imminent' ? CRISIS_IMMINENT_INTENT : CRISIS_INTENT;
}

/** 她上一次回复以后，他这次说的内容。 */
function latestUserText(history: readonly Said[]): string {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    return history.slice(lastReply + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
}

// 对方已经在收尾，或者只回了一句附和时，不再塞「追问 / 分享进度」；
// 这些意图会顶掉卡上的「道晚安、顺势收尾」，让本来该停的聊天又铺开（ADR 0019 改后回归）。
const ENDING = /晚安|睡(?:了(?!吗)|觉|啦|咯|吧)|不想(?:说话|聊)|不聊了|先去忙|我去忙|回头聊|明天聊|拜拜|我(?:先)?去(?:写|改|敲|学习|上课|开会|洗澡|吃饭|干活)|你(?:先忙|慢慢(?:看|玩|吃|忙))/;
// 「干嘛」「啥」也是问（「你昨天都干嘛了」「在干嘛」「吃的啥」）；「没啥」不是
const QUESTION = /[?？]|(?:吗|么)$|你呢[。！!\s]*$|你(?:是不是|有没有|要不要|能不能|可不可以|今天|现在)|怎么|为什么|咋|哪|几|多少|什么|谁|讲讲|告诉我|帮我|干嘛|(?<!没)啥|[了完过好到]没有?$|([\u4e00-\u9fff])不\1/;

/** 一句话是不是在说“我去睡 / 去忙 / 回头聊”（心境 ADR 0102：他说过要走，她的等不算被晾着） */
export function endingText(text: string): boolean {
    return ENDING.test(text);
}

export function isEndingTurn(history: readonly Said[]): boolean {
    const text = latestUserText(history).trim();
    return Boolean(text) && !ASKS_FOR_HER.test(text) && (isAck(text) || isReaction(text) || ENDING.test(text));
}

/**
 * 撒娇要她哄、陪（「哄我睡觉呗」「陪我聊会儿」「给我讲个故事」）：是冲她提的要求，不是他要走，带「睡觉」也不算收尾。
 * 10-09 13:11 线上：「哄我睡觉呗」被「睡觉」判成收尾，她回「那你睡吧 / 睡醒了再找我」。
 */
const ASKS_FOR_HER = /哄(?:哄)?我|陪(?:陪)?我|给我(?:讲|唱|念)|讲个(?:睡前)?故事|唱(?:首)?歌给我|摸摸(?:我的?)?头/;
function asksForHer(history: readonly Said[]): boolean {
    return ASKS_FOR_HER.test(latestUserText(history));
}

/**
 * 男朋友在要一个拥抱、亲吻、爱意确认或继续陪伴时，不把它压成普通问答，也不因为「睡」字直接收尾。
 * 只匹配完整的亲密说法，避开「抱怨」「亲戚」「亲自」一类无关词；是否启用由调用方按档位决定。
 */
const INTIMATE_BID = /抱抱|抱我|抱一下|抱一会儿?|抱住我|给我抱|亲亲|亲我|亲一下|亲一口|亲个|mua(?!\s*(?:是什么意思|是啥|啥意思|怎么读|怎么说))|啵(?:一个|一下)?|想不想我|有没有想我|爱不爱我|爱我吗|喜不喜欢我|喜欢我吗|没爱了|不爱我了|不要我了|不喜欢我了|是不是不爱我|不准睡|别睡|不要睡|先别睡|(?:不准走|别走|不要走)(?=$|[了啊呀呢啦嘛呐哟]|[^\p{L}\p{N}])|再陪(?:陪)?我?(?:一会儿?|一下)|陪我(?:聊|待|睡|一会儿?)/iu;
const DIRECT_AFFECTION = /(?:喜欢你|爱你)(?=$|[啊呀呢啦嘛呐哟]|[^\p{L}\p{N}])/u;
const MISSES_ME = /想我(?:吗|没|没有|了吗|了没|了没有|了|啊|呀|呢)?(?=$|[\s?？!！。…~～，,])/;
// 「我想你应该先睡」「我想你帮我看看」里的「想你」是“我认为 / 我希望你”，不是想念。
const MISSES_HER = /(?<![不没])想你(?!应该|该|帮|给|替|把|能|会|要|先|去|来|做|说|看|问)/;
function isIntimateBid(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    return INTIMATE_BID.test(text) || DIRECT_AFFECTION.test(text) || MISSES_ME.test(text) || MISSES_HER.test(text);
}

/**
 * 他直接说爱你、喜欢你、想你（不是在问“你想不想我”这种能逗一逗的）：10-21 用户改写「爱你」的回复——她回「我也爱你呀，这么肉麻你也不嫌腻」，
 * 用户的版本是「我也爱你，mua，抱抱」。这时直接温柔地回，不吐槽、不反问；抱抱、亲亲、想不想我这类要亲近的才保留一点嘴硬（ADR 0058）
 */
const TESTING_LOVE = /想不想我|有没有想我|爱不爱我|爱我吗|喜不喜欢我|喜欢我吗|没爱了|不爱我了|不要我了|不喜欢我了|是不是不爱我/;
function isPlainAffection(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    return (DIRECT_AFFECTION.test(text) || MISSES_HER.test(text)) && !MISSES_ME.test(text) && !TESTING_LOVE.test(text);
}
const BID_REPLY = '再自然地保留一点嘴硬；嘴硬不能是整轮唯一内容，也不把亲近当成交换条件';
const AFFECTION_REPLY = '直接、温柔地回应他（我也爱你、我也想你、mua、抱抱这类，叠词也行），不吐槽他肉麻、不反问、不损他，也不把亲近当成交换条件';

const MEME_SHORTHAND =/(?:^|[^a-z])(?:zdjd|xswl|awsl|yyds|nsdd|u1s1|srds|dbq|gkd|zqsg|yygq|nbcs|bdjw)(?=$|[^a-z])/i;
const MEME_PHRASE = /尊嘟假嘟|绷不住|蚌埠住|我嘞个|不是哥们|闹麻了|已老实|求放过|补药|啊米诺斯|神金|丸辣|哈基米|典中典|寄了|包的|我先.{1,8}为敬|(?:^|\n)并非.{0,8}(?:$|\n)|老师.{0,12}死[\u4e00-\u9fff]{1,2}了|([\u4e00-\u9fff]{1,2})老师.{0,12}(?:累|笑|气|烦|困|饿|冷|热|吓)\1了/;
function playfulHint(history: readonly Said[]): string | undefined {
    const text = latestUserText(history);
    if (!MEME_SHORTHAND.test(text) && !MEME_PHRASE.test(text)) return undefined;
    const known: string[] = [];
    if (/(?:^|[^a-z])zdjd(?=$|[^a-z])/i.test(text)) known.push('zdjd 是「真的假的 / 尊嘟假嘟」');
    if (/(?:^|[^a-z])xswl(?=$|[^a-z])/i.test(text)) known.push('xswl 是「笑死我了」');
    if (/(?:^|[^a-z])nsdd(?=$|[^a-z])/i.test(text)) known.push('nsdd 是「你说得对」');
    if (/(?:^|[^a-z])u1s1(?=$|[^a-z])/i.test(text)) known.push('u1s1 是「有一说一」');
    if (/(?:^|[^a-z])srds(?=$|[^a-z])/i.test(text)) known.push('srds 是「虽然但是」');
    return known.length ? `；你认得这里的写法：${known.join('，')}，只拿来理解，不向他解释这张对照表` : '';
}

/**
 * 他要她发照片、给他看看（「发我看看」「来张自拍」「照片呢」）。她只能打字，没有意图行时她会直说自己发不了：
 * 10-11 预演买到相机那一幕（proactive-news ×3），三次都是「发不了」「QQ 这边拍不下来」，真人手里有手机，不会这么说。
 * 他自己要发、要拍的不算（「我发你看看」「我拍张给你」）。
 */
const PHOTO_ASK = /发(?:给)?我(?:看看|瞧瞧|看下|看一下|康康)|发(?:来|过来)(?:看看|瞧瞧|看下|康康)|(?<!我|给你)(?:发|拍|来)(?:一?张|个)(?:照片|相片|自拍|图|照)|(?<!我)拍(?:张|一张)?(?:给我|来看看)|(?:给我|让我)(?:看看|瞧瞧|康康|看一下|看下)|有(?:图|照片)吗|(?:照片|图|自拍)呢|无图无真相|晒(?:一下|晒|出来)|想看(?:看)?(?:你|照片|自拍|它)/;
function asksForPhoto(history: readonly Said[]): boolean {
    return PHOTO_ASK.test(latestUserText(history));
}

/**
 * 他这几句里有一句带感叹号的好消息（面试过了、考上了、抢到了）：先替他高兴，别让后面顺口一问顶掉。
 * 盲评 v1.1 be-056：「出来了 过了！！」「你吃了没」被判成直接提问，她只答了吃没吃，还把他那句「我刚睡醒」说成了自己的。
 * 「过了」前面是难、错、没、吃、看这类字的不算（「难过了！」「吃过了！」）；问句里的不算。
 */
const GOOD_NEWS = /(?:面试|笔试|复试|初试|考试|四级|六级|驾照|科目?[一二三四]|答辩|审核|申请)?(?<![难错没不经路度吃看去来做用玩])过了|通过了|考上了|上岸|录取了|拿到(?:了|offer)|中奖|成功了|搞定了|抢到了|赢了|评上了|选上了/i;
/** 一句话是不是带感叹号的好消息（心境 ADR 0102 也用，按单条消息判断） */
export function goodNewsText(text: string): boolean {
    return GOOD_NEWS.test(text) && /[！!]/.test(text) && !/[?？]/.test(text);
}
function sharesGoodNews(history: readonly Said[]): boolean {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    return history.slice(lastReply + 1).some(message => message.role === 'user' && goodNewsText(message.content));
}

function asksQuestion(history: readonly Said[]): boolean {
    // 句首的感叹（「什么，竟然不理我，我真要哭了」「怎么，你还不信」）不是在问：10-21 用户改写这一句——她被当成提问、回了「哭什么」，该先哄的
    const text = latestUserText(history).trim().replace(/(^|\n)(?:什么|啥|怎么|我去|我靠|卧槽)[，,！!…]+/g, '$1');
    return !/^(?:在吗|在不在)[？?。！!\s]*$/.test(text) && QUESTION.test(text);
}

/**
 * 他在逗她、拿她开玩笑（「别吃成芝麻酥那样，小心压穿地球」）：10-21 用户改写这一句——她回「说谁呢」，用户的版本是陪他玩（「芝麻酥不肥！恶语伤酥心～」）。
 * 只认明确的逗法（胖、吃成、压穿、小猪、笨蛋……）；他说自己的（「我又胖了」）不算
 */
const TEASE = /胖(?:了|成|子)|吃成|压穿|压垮|小猪|猪猪|懒猪|笨蛋|傻瓜|小笨|蠢货|丑八怪|肥(?:了|婆|猪)/;
const SELF_DEPRECATING = /我.{0,6}?(?:胖|肥|丑|懒|笨|蠢)/;
function teasesHer(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    return TEASE.test(text) && !SELF_DEPRECATING.test(text);
}

/** 对方此刻在递情绪，不拿她自己的生活进度把这句话顶掉。只认明确说法，不从普通短句猜心情。 */
function needsCare(history: readonly Said[]): boolean {
    return needsCareText(latestUserText(history));
}

/** 一句话里他是不是在递情绪（难过、烦、累、不舒服）；心境（ADR 0102）按单条消息判断 */
export function needsCareText(text: string): boolean {
    // 烦死、被骂（10-09 写长上下文场景时补）：「今天被导师骂了，烦死」原来不算
    // 身上不舒服、一般的累（10-10 盲评 N3：「我嗓子疼 / 肿了」不算，她第一句回「你是不是傻」；「今天有点累」也不算，她转去说自己早八）
    return /(?:我)?(?:哭|难过|伤心|委屈|崩溃|焦虑|害怕|紧张|emo)|累死|烦死|好烦|烦躁|郁闷|心累|被(?:导师|老师|老板|领导|我妈|我爸)?骂|难受|不舒服|疼死|(?:^|\n)悲[了伤惨啊呀…~～\s]*(?:$|[，,！!。])/i.test(text.trim())
        || /(?:嗓子|喉咙|头|肚子|胃|牙|腰|背|腿|脚|手|眼睛|脖子)(?:好|有点|特别|巨|超|也|一直)?(?:疼|痛)|发烧|烧到|感冒|咳嗽|生病|病了|拉肚子|闹肚子|头晕|恶心|想吐|吐了|肿了|扭了|崴了|过敏|痛经/.test(text)
        || /(?:好|有点|特别|太|超|巨|真|挺)累|累(?:了|得|趴|瘫)|没力气|撑不住/.test(text);
}

/** 想念、喜欢、纪念日或认识多久，是两个人之间的话；不能答完又机械切回猫、书和手头进度。 */
function isRelationshipBid(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    // 「你递过来的时候我心里特别软」（10-10 盲评 N3：她回「今天怎么突然这么黏」就转去讲自己的奶茶）
    return MISSES_HER.test(text) || DIRECT_AFFECTION.test(text) || /亲亲|抱抱|纪念日|(?:认识|见面|在一起).{0,8}(?:天|年)|\d{3,}\s*天|心里.{0,4}(?:软|甜|暖)|心动|有你真好/.test(text);
}

/** 只有这种没有实质话题的开场，才适合捡起待跟进的事；不能在对方正说别的时抢话。 */
function isOpeningPing(history: readonly Said[]): boolean {
    const text = latestUserText(history).trim().replace(/[！!。？?～~\s]/g, '');
    return /^(?:在吗|在不在|人呢|滴滴滴|嗨|hi|hello)$/i.test(text);
}

/** 他在说自己的经历、近况或心情；普通提问不算。 */
export function saysOwnThing(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    const self = /我|俺|咱|刚刚|刚才|刚|今天|昨天|昨晚/;
    const experience = /去(?:了|过|到|看|吃|玩|见|面试|上班|上课)|到(?:了|家|公司|学校)|回(?:了|到|家)|做了|干了|忙(?:了|着|完)|下课|上课|上班|下班|吃了|看了|玩了|见了|考了|买了|遇到|碰到|发生|累|困|烦|难受|开心|高兴|紧张|生气|emo/i;
    return self.test(text) && experience.test(text);
}

function nearSleep(now: Date, sleep: string): boolean {
    const [hour, minute] = sleep.split(':').map(Number);
    const current = now.getHours() * 60 + now.getMinutes();
    const target = hour! * 60 + minute!;
    const until = (target - current + 24 * 60) % (24 * 60);
    return until <= 90;
}

function busy(state: State | undefined, schedule: Schedule | undefined, now: Date): boolean {
    if (!state) return false;
    if (state.activity.kind === 'sleep') return true;
    if (state.activity.kind === 'class' && (state.activity.lesson.kind === 'hard' || state.activity.lesson.kind === 'machine')) return true;
    if (state.activity.kind === 'free' && /赶|作业|复习|报告|论文|考试/.test(state.activity.text)) return true;
    return Boolean(schedule && nearSleep(now, schedule.sleep));
}

// ───────── 10-22 深夜测试对话（用户：「她现在还是会有 AI 的味道」）量出来的三处 ─────────
// ① 被指出“不像真人 / 重复 / 敷衍”时她辩解、解释原因（「哪有老重复，是困得话都说不利索了」「我没敷衍」「我说的算数」「不是设定」），114 条里 5% 是这类自证，真人样本 0；
// ② 被问很大很抽象的问题（谈恋爱是什么样子、喜欢我什么、伤心什么感觉）时答成金句体（「就两个人待着不用装，他不在会惦记，见了就想多待会儿」「喜欢你嘴硬，其实心不硬」）；
// ③ 被连着追问一个答案时原地打转：一段里 12 条气泡 9 条是“太急 / 太突然 / 困 / 明天说”的不同说法。
/** 他在说她的话不像真人、重复、敷衍（问她是不是 AI / 真人是另一回事，走身份那一路，不在这里） */
const REALNESS_CHALLENGE = /(?:跟|像|很像|好像|太像)(?:是)?(?:ai|AI|Ai|机器人|程序|稿子|客服)(?:似的|一样)?|活人感|真人(?:不会|哪有|才不|不这么|不是这样)|(?:老是|总是|又在|一直)重复|重复(?:一件|同一|了)|敷衍|模棱两可|你总是这样/;
const AI_IDENTITY_QUESTION = /是不是.{0,6}(?:ai|AI|Ai|机器人|程序|真人)|是.{0,3}(?:ai|AI|Ai|机器人|程序)吗|是真人吗/;
function challengesRealness(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    return REALNESS_CHALLENGE.test(text) && !AI_IDENTITY_QUESTION.test(text);
}

/** 他在问一个很大、很抽象的问题（要她“真正的想法 / 感觉”） */
const ABSTRACT_ASK = /谈恋爱.{0,8}(?:什么|样子|怎样)|喜欢我什么|为什么喜欢|(?:真实|真正|真心)(?:的)?(?:想法|话|感觉)|伤心是什么|是什么感觉|什么样(?:子)?的人|怎么看(?:待)?(?:爱情|感情|我们)|爱情是什么|理想型/;

/** 他在追她要一个答案 */
const PRESSING = /回答我|不要回避|别回避|到底|愿不愿意|愿意吗|接受或|同意吗|真实想法|真正的想法|给我.{0,2}(?:答案|回答)|为什么不能是现在|别想.{0,6}(?:第一|直接)/;
/** 她前面几条在往后推（困、明天说、太急、太突然……） */
const DEFERRING = /明天|改天|以后|太急|太快|太突然|这么急|这么突然|困|现在不|脑子.{0,3}(?:转不动|不清楚|懵)|再说|再想想|我要想想/;
/** 他在追答案，她最近 6 条气泡里至少有 3 条在往后推：原来会接着换个说法再推一轮 */
function pressedAfterStalling(history: readonly Said[]): boolean {
    if (!PRESSING.test(latestUserText(history))) return false;
    const hers = history.filter(message => message.role === 'assistant').slice(-6);
    return hers.filter(message => DEFERRING.test(message.content)).length >= 3;
}

// ───────── 会拒绝（ADR 0103）：10-22 用户要她“会拒绝”。基线（真模型，各 3 次）：理由摆在那儿（在上课 / 很累）她说一次不，他再磨一句就答应了（累 + 烦时 2/3 磨一句就“行行行，就一把”）；
// 他命令式地管她（“以后不许跟别的男生说话，听到没”）1/3 直接“行行行，都听你的”。人家的基线：不会被磨两句就让步（0099：她让步 13–20%，真人 4%）。
// 这里只做两件事，都是确定性的判断，不是“随机拒绝”（ADR 0066：拒绝要有来由，不演冷淡）：①她刚推了他、他在磨她，理由没变，别马上答应；②他在管着她（不许 / 听到没 / 必须），这是她自传里最受不了的事。
/** 她刚说的话里有“推”的意思 */
export const REFUSAL_WORDS = /不行|不要|不想|不去|不打|不陪|不给|不发|没空|没法|不方便|等下课|下课再|下了课|晚点|待会|回头|明天再|改天|下次|先不|不了|算了吧|不能/;
/** 他在磨她 */
const PRESSING_ON = /就一(?:把|下|会|次|局|盘|个)|陪陪我|求你|好不好|行不行|可以嘛|好嘛|拜托|再(?:陪|来|打|玩|聊)一|你就(?:陪|答应|来)|答应我|来嘛|嘛[～~！!]*$|别这样|为什么不/;

/** 他在磨一个她刚推掉的事：她上一串话里有“推”，他这一串在磨；她已经连着推了两回就不再替她守着（她自己定要不要松口） */
export function pressedAfterRefusing(history: readonly Said[]): boolean {
    if (!PRESSING_ON.test(latestUserText(history))) return false;
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    if (lastReply < 0) return false;
    // 她上面几串回复（连着的气泡算一串），最近的一串必须有“推”
    const groups: string[] = [];
    let i = lastReply;
    while (i >= 0 && groups.length < 4) {
        const parts: string[] = [];
        while (i >= 0 && history[i]!.role === 'assistant') { parts.unshift(history[i]!.content); i--; }
        groups.push(parts.join('\n'));
        while (i >= 0 && history[i]!.role === 'user') i--;
    }
    if (!REFUSAL_WORDS.test(groups[0]!)) return false;
    return groups.filter(group => REFUSAL_WORDS.test(group)).length < 2;
}

/** 他在管着她、替她定能跟谁说话 / 去哪（“不许跟别的男生说话”“听到没”“你得听我的”）；关心她的“不许熬夜”“听到没，早点睡”不算 */
const CONTROLLING = /不(?:许|准)(?:你)?(?:再)?(?:跟|和|同|理|找|加|见|聊|说话|联系|出去|去|玩)|听(?:到|见)没|你得听我的|我说了算|把.{0,8}(?:删了|删掉|拉黑|卸载)/;
const CARING_ORDER = /熬夜|早饭|吃饭|吃药|喝(?:水|药|热)|早点睡|睡觉|感冒|多穿|穿(?:多|厚)|冷|累|难过|哭|生病|发烧|注意|小心|安全/;
export function controlsHer(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    return CONTROLLING.test(text) && !CARING_ORDER.test(text);
}

/**
 * 他在问她今天过得怎么样 / 有什么事（ADR 0106）：线上有了很多小事以后，被问“今天干嘛了 / 有什么好玩的事 / 有没有什么烦的”她还是回“赶作业呢”“没呢”——
 * 事实就在「你那边」里（今天的小事），她不用。这时让她挑一两件具体的说，别回什么都没说的；今天确实没有才说没有
 */
const ASKS_HER_DAY = /今天(?:干嘛|干什么|做了什么|过得|怎么样|咋样|忙什么|都干|有什么|怎么过)|有(?:没有)?什么(?:好玩|有趣|新鲜|开心|高兴|烦|倒霉|糟心|事)|最近(?:怎么样|咋样|忙什么|过得|在忙)|发生了什么|今天怎么样/;
export function asksAboutHerDay(history: readonly Said[]): boolean {
    return ASKS_HER_DAY.test(latestUserText(history));
}
export const ABOUT_DAY_INTENT = '[这一轮你想：他在问你今天过得怎么样、有什么事。从「你那边」里“今天的小事”和今天的事实里挑一两件具体的说（带上你当时的感觉，像随口讲给他听），别回“没什么 / 就赶作业”这种什么都没说的；今天真的什么都没有才说没有，没写的别编]';

/**
 * 她正在做自己在意的事（修片、拍照），他让她先放下陪他（ADR 0104 × 0103）：原来她说“来了来了，修图哪有你重要”一口放下，
 * 手头的事对她没有分量。有了追求以后她可以先弄完这一小段并给个大概的时间；他认真说需要她、或她自己也想聊了就放下
 */
const DROPS_HER_THING = /先?别(?:修|拍|写|弄|学|忙)|放一放|放下(?:手头|手里)|不要(?:修|写|学|弄)了/;
export function dropsHerThing(history: readonly Said[]): boolean {
    return DROPS_HER_THING.test(latestUserText(history));
}
export const holdPursuitIntent = (doing: string) => `[这一轮你想：你正在${doing}，这是你自己在意的事；他让你先放下陪他。你可以说先把手上这一小段弄完，给个大概的时间，不用立刻放下，也不是不理他（他是你很想聊的人，别冷着）；他认真地说需要你、或者你自己也想聊了，就放下。别生气，一两句]`;

/**
 * 她刚约了他（开黑 / 双排 / 我的世界……），他说这次不行（ADR 0107）。模拟里被拒绝后有一次是“哦，我还等着你呢”——带着让他有负担的施压。
 * 约他是她提议的，他不来是正常的；这一轮接得轻松。只在她上一串话是个邀约、他这一串是拒绝时给
 */
export const HER_INVITE = /(?:开黑|双排|王者|我的世界|联机|一起玩|上线|上号|打两把|玩两把).{0,14}(?:吗|嘛|不|吧|来|上|[？?])|来不来|上不上|玩不玩|打不打|有空不|要不要/;
export const DECLINES_INVITE = /不行|不了|没空|没时间|没心情|在忙|要忙|在赶|赶着|有事|累了|好累|很累|太累|困了|改天|下次|算了|不玩|不打|不想|不来/;
export const ACCEPTS_FIRST = /^(?:来|好|行|可以|走|上|没问题)/;
export function declinedHerInvite(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    if (!DECLINES_INVITE.test(text) || ACCEPTS_FIRST.test(text.trim())) return false;
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    if (lastReply < 0) return false;
    const hers: string[] = [];
    for (let i = lastReply; i >= 0 && history[i]!.role === 'assistant' && hers.length < 3; i--) hers.unshift(history[i]!.content);
    return HER_INVITE.test(hers.join('\n'));
}
export const DECLINED_INVITE_INTENT = '[这一轮你想：你刚约了他一起玩，他这次不行（忙 / 累 / 没空）。接得轻松：说“行 / 那你忙 / 下次”，或者顺着说一句你自己去干点别的；别说“我还等着你”“你不陪我”这类让他有负担的话，别追问为什么、别劝他、别赌气，也别再约第二遍。一两句]';

export const PRESSED_INTENT = '[这一轮你想：你刚推了他，他在磨你。你的理由没变，别被磨两句就答应：软着再推一次（换个说法，别重复上一句），或者给个折中（下课以后 / 明天 / 就十分钟）；他给了新理由，或者认真地求你，才松口。别生气，别讲道理，一两句]';
export const CONTROL_INTENT = '[这一轮你想：他在管着你、替你定能跟谁说话、去哪（不许、听到没、你得听我的）。你最受不了被人管着、被人替你定怎么活——对他不会真翻脸，但也不是他说什么你就“好好好都听你的”：先别扭一句，该不答应的就明说你不答应，小事可以逗他、给个折中；他好好说、认真讲理，你就软下来。别冷着脸教训他，一两句]';

export const CHALLENGE_INTENT = '[这一轮你想：他在说你的话不像真人、重复或者敷衍。别替自己辩解，也别解释原因（不说「我是因为困」「我没敷衍」「我说的算数」「不是设定」这类自证）；像真人被说中了那样：嗔一句、笑着认个怂、反呛他一句，或者撒个娇带过，一两句就够，别去分析自己说话的毛病]';
export const ABSTRACT_INTENT = '[这一轮你想：他在问一个很大、很抽象的问题。别总结成一句漂亮的话（不要排比、对仗、「不是…而是…」、「其实」）；说一件具体的小事、一个画面，或者坦白说不太清楚再补半句，也可以反问他一句；说得零散一点没关系，别说得像写好的]';
export const STALL_INTENT = '[这一轮你想：他在追你要一个答案，你前面已经推了好几次了。别再用同样的理由往后推（困、明天说、太急、太突然这些你已经说过了）：现在就给一个态度，哪怕不完整——答应、半答应带点害羞，或者明说你在怕什么，用你自己的话，一两句]';

/**
 * 时间块里的一行；没有当下线索就不返回。顺序与 ADR 0019 的决策表一致，ADR 0023 插了两类「在等的」：
 * 等他说结果的事排在他说自己的事之前（最自然的开口），她问了他没答的排在她答应的事之后。两类都只表达期待（作者裁决二·3），不写介意。
 */
export function describeIntent(context: IntentContext): string | undefined {
    if (context.initiating) return undefined;
    // 最高优先级，排在亲密、收尾、问答之前（ADR 0068 决策 2）
    if (context.crisis) return crisisIntent(context.crisis, context.crisisAwaitingSafe);
    // 小别扭 / 和好（ADR 0074）：他难过、生病、要她哄的时候让路；他在收尾时只让「别扭」让路，「和好」照样软一句
    if (context.grievance && !needsCare(context.history) && !asksForHer(context.history)
        && (context.grievance.stage === 'makeup' || !isEndingTurn(context.history))) return describeGrievance(context.grievance);
    // 会拒绝（ADR 0103）：管着她的、她刚推了他还在磨她的，排在亲密邀约之前 / 撒娇要哄之前（“陪陪我”会被当成要哄）；他难过、生病的时候让路
    if (context.refuse && context.intimate && !needsCare(context.history) && controlsHer(context.history)) return CONTROL_INTENT;
    if (context.refuse && context.intimate && context.pursuitDoing && !needsCare(context.history) && dropsHerThing(context.history)) return holdPursuitIntent(context.pursuitDoing);
    // 「只接他刚说的你们两个人的事」这几个字让候选挑选（ADR 0041）和两条气泡的上限照亲密话算
    if (context.intimate && isIntimateBid(context.history)) return `[这一轮你想：他在向你要亲近或确认你们的感情，只接他刚说的你们两个人的事：先给一个明确的亲密回应，${isPlainAffection(context.history) ? AFFECTION_REPLY : BID_REPLY}。QQ 文字里的抱抱、亲一下和 mua 就是真的在抱、在亲，直接在这一轮用文字回抱回亲，让他收到你的回应；他说难受时先心疼他，他同时报了好消息时先替他高兴再接亲密话，他真要收尾时回应后顺着收尾，他不想你走时能陪就多陪一句]`;
    if (context.refuse && context.intimate && !needsCare(context.history) && pressedAfterRefusing(context.history)) return PRESSED_INTENT;
    if (context.refuse && context.intimate && !needsCare(context.history) && declinedHerInvite(context.history)) return DECLINED_INVITE_INTENT;
    if (asksForHer(context.history)) return '[这一轮你想：他在撒娇要你哄他、陪他，只接他刚说的你们两个人的事：顺着哄他一两句，嘴硬着哄也行，别一句话就把他打发了；他要睡就哄他睡，他不让你走就再陪他一会儿，不另起话题，也不用约他睡醒再找你]';
    const meme = context.playful ? playfulHint(context.history) : undefined;
    if (meme !== undefined) return `[这一轮你想：他在玩网络梗、缩写或谐音，先按最近的上下文理解笑点，顺着同一套逻辑接一句，再接他真正说的事；不把梗按字面纠正，不解释梗或报出处。他把固定说法里的一个词换掉时，回话保留那句被拧过的关键词或句式，别只按字面劝他去吃、睡或做事。接不准就用你自己的口气问一句，不装懂；可以夸张、反差或者故意一本正经，但一次只玩一个点，不堆热词${meme}；他真要收尾时接完梗就收尾]`;
    // 和亲密意图同一个开关（男朋友档）；同学档要照片有世界书「要照片」管
    if (context.intimate && asksForPhoto(context.history)) return '[这一轮你想：他想看照片。你手机能拍也能发，只是这次先不发：用你此刻真实的理由轻轻推一下（看你正在干嘛，或者嫌拍得不好看），再用一两句话把他想看的样子说给他听；他要的是你已经拍好的照片，就说说拍了什么、拍得怎么样；不答应等会儿或者回头再发]';
    // 10-22：被追问答案时别原地打转 / 被指出不像真人时别自证 / 很抽象的问题别答成金句（在亲密邀约、逗她之后，收尾、好事、回答问题之前）
    if (pressedAfterStalling(context.history)) return STALL_INTENT;
    if (challengesRealness(context.history)) return CHALLENGE_INTENT;
    if (ABSTRACT_ASK.test(latestUserText(context.history))) return ABSTRACT_INTENT;
    if (isEndingTurn(context.history)) return '[这一轮你想：顺着他的话收尾，只回一两句；不分享新进度，不说你接下来做什么，不另起话题，也不用约他忙完回来找你]';
    if (sharesGoodNews(context.history)) return '[这一轮你想：他刚说了件好事，先替他高兴、接住这件事；他顺口问的再顺口答，不另起话题]';
    // 他在逗她（男朋友档）：陪他玩，别板着脸顶回去（10-21 用户改写：「说谁呢」→「芝麻酥不肥！恶语伤酥心～」）；他难过、要哄的时候已经在前面让路了
    if (context.intimate && teasesHer(context.history)) return '[这一轮你想：他在逗你、拿你开玩笑，你陪他玩：装委屈、撒娇式不服、护着自己的东西，或者反过来逗他一句都行；别板着脸顶回去，不说“说谁呢”“不好笑”这类冷的]';
    // 她那边的事还没跟他说过（ADR 0057 调整）：放在「先回答」前面——他多半开口就问「在干嘛」，那一条的「不另起话题」会把这件压下去；他难过时先接情绪
    const news = context.news?.length && !needsCare(context.history) ? context.news : undefined;
    if (news) return `[这一轮你想：先回他刚说的；你今天${news.join('、')}，还没跟他说过，接着就说这件（看「你那边」那一行，没写的细节不编）]`;
    if (context.dayThings && !needsCare(context.history) && asksAboutHerDay(context.history)) return ABOUT_DAY_INTENT;
    if (asksQuestion(context.history)) return '[这一轮你想：先直接回答他刚问的，不另起话题]';
    if (needsCare(context.history)) return '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够；他认真难过、生病或很累时，第一句先安慰或问怎么了，不先损他；他是撒娇式的呜呜、要哭了，就直接哄（叠词哄：同一个词连说几遍，或者抱抱），别反问他哭什么；不转去讲你自己的事，不硬开新话题]';
    if (isRelationshipBid(context.history)) return '[这一轮你想：只接他刚说的你们两个人的事，一两句就够；不转去讲猫、书或手头的进度]';
    if (saysOwnThing(context.history)) return '[这一轮你想：回应他刚说的那件事；先对这件事本身有个反应（意外、羡慕、心疼、吐槽一句都行），别急着追问细节，真要问也只问一两个字]';
    if (!isOpeningPing(context.history)) return undefined;
    const waiting = context.waiting?.[0];
    if (waiting) return `[这一轮你想：知道「${waiting}」后来怎么样了，随口问一句；他不想说就算了，不追问]`;
    if (context.promised) return '[这一轮你想：先把上面你答应的那件事说了，不另起话题]';
    const unanswered = context.unanswered?.[0];
    if (unanswered) return `[这一轮你想：上次问他「${unanswered}」他没顾上回，轻轻再问一次；他不接就算了，不追究]`;
    if (busy(context.state, context.schedule, context.now)) return '[这一轮你想：回两句就去忙，不铺开新话题]';
    return undefined;
}
