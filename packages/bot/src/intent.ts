// 当天这一层的「这一轮你想」（ADR 0019 决策 2）。
// 只按眼前已有线索给一个方向，不抽签、不额外调模型，也不把它写成能照抄的台词。

import type { StoredMessage } from './history.ts';
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
const INTIMATE_BID = /抱抱|抱我|抱一下|抱一会儿?|抱住我|给我抱|亲亲|亲我|亲一下|亲一口|亲个|mua(?!\s*(?:是什么意思|是啥|啥意思|怎么读|怎么说))|啵(?:一个|一下)?|想不想我|有没有想我|爱不爱我|爱我吗|喜不喜欢我|喜欢我吗|喜欢你|爱你|没爱了|不爱我了|不要我了|不喜欢我了|是不是不爱我|不准睡|别睡|不要睡|先别睡|不准走|别走|不要走|再陪(?:陪)?我?(?:一会儿?|一下)|陪我(?:聊|待|睡|一会儿?)/i;
const MISSES_ME = /想我(?:吗|没|没有|了吗|了没|了没有|了|啊|呀|呢)?(?=$|[\s?？!！。…~～，,])/;
// 「我想你应该先睡」「我想你帮我看看」里的「想你」是“我认为 / 我希望你”，不是想念。
const MISSES_HER = /(?<![不没])想你(?!应该|该|帮|给|替|把|能|会|要|先|去|来|做|说|看|问)/;
function isIntimateBid(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    return INTIMATE_BID.test(text) || MISSES_ME.test(text) || MISSES_HER.test(text);
}

const MEME_SHORTHAND = /(?:^|[^a-z])(?:zdjd|xswl|awsl|yyds|nsdd|u1s1|srds|dbq|gkd|zqsg|yygq|nbcs|bdjw)(?=$|[^a-z])/i;
const MEME_PHRASE = /尊嘟假嘟|绷不住|蚌埠住|我嘞个|不是哥们|闹麻了|已老实|求放过|补药|啊米诺斯|神金|丸辣|哈基米|典中典|寄了|包的|我先.{1,8}为敬|(?:^|\n)并非.{0,8}(?:$|\n)|老师.{0,12}死[\u4e00-\u9fff]{1,2}了/;
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
 * 他这几句里有一句带感叹号的好消息（面试过了、考上了、抢到了）：先替他高兴，别让后面顺口一问顶掉。
 * 盲评 v1.1 be-056：「出来了 过了！！」「你吃了没」被判成直接提问，她只答了吃没吃，还把他那句「我刚睡醒」说成了自己的。
 * 「过了」前面是难、错、没、吃、看这类字的不算（「难过了！」「吃过了！」）；问句里的不算。
 */
const GOOD_NEWS = /(?:面试|笔试|复试|初试|考试|四级|六级|驾照|科目?[一二三四]|答辩|审核|申请)?(?<![难错没不经路度吃看去来做用玩])过了|通过了|考上了|上岸|录取了|拿到(?:了|offer)|中奖|成功了|搞定了|抢到了|赢了|评上了|选上了/i;
function sharesGoodNews(history: readonly Said[]): boolean {
    const lastReply = history.findLastIndex(message => message.role === 'assistant');
    return history.slice(lastReply + 1).some(message => message.role === 'user'
        && GOOD_NEWS.test(message.content) && /[！!]/.test(message.content) && !/[?？]/.test(message.content));
}

function asksQuestion(history: readonly Said[]): boolean {
    const text = latestUserText(history).trim();
    return !/^(?:在吗|在不在)[？?。！!\s]*$/.test(text) && QUESTION.test(text);
}

/** 对方此刻在递情绪，不拿她自己的生活进度把这句话顶掉。只认明确说法，不从普通短句猜心情。 */
function needsCare(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    // 烦死、被骂（10-09 写长上下文场景时补）：「今天被导师骂了，烦死」原来不算
    // 身上不舒服、一般的累（10-10 盲评 N3：「我嗓子疼 / 肿了」不算，她第一句回「你是不是傻」；「今天有点累」也不算，她转去说自己早八）
    return /(?:我)?(?:哭|难过|伤心|委屈|崩溃|焦虑|害怕|紧张|emo)|累死|烦死|好烦|烦躁|郁闷|心累|被(?:导师|老师|老板|领导|我妈|我爸)?骂|难受|不舒服|疼死|(?:^|\n)悲[了伤惨啊呀…~～\s]*$/i.test(text.trim())
        || /(?:嗓子|喉咙|头|肚子|胃|牙|腰|背|腿|脚|手|眼睛|脖子)(?:好|有点|特别|巨|超|也|一直)?(?:疼|痛)|发烧|烧到|感冒|咳嗽|生病|病了|拉肚子|闹肚子|头晕|恶心|想吐|吐了|肿了|扭了|崴了|过敏|痛经/.test(text)
        || /(?:好|有点|特别|太|超|巨|真|挺)累|累(?:了|得|趴|瘫)|没力气|撑不住/.test(text);
}

/** 想念、喜欢、纪念日或认识多久，是两个人之间的话；不能答完又机械切回猫、书和手头进度。 */
function isRelationshipBid(history: readonly Said[]): boolean {
    const text = latestUserText(history);
    // 「你递过来的时候我心里特别软」（10-10 盲评 N3：她回「今天怎么突然这么黏」就转去讲自己的奶茶）
    return MISSES_HER.test(text) || /喜欢你|爱你|亲亲|抱抱|纪念日|(?:认识|见面|在一起).{0,8}(?:天|年)|\d{3,}\s*天|心里.{0,4}(?:软|甜|暖)|心动|有你真好/.test(text);
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

/**
 * 时间块里的一行；没有当下线索就不返回。顺序与 ADR 0019 的决策表一致，ADR 0023 插了两类「在等的」：
 * 等他说结果的事排在他说自己的事之前（最自然的开口），她问了他没答的排在她答应的事之后。两类都只表达期待（作者裁决二·3），不写介意。
 */
export function describeIntent(context: IntentContext): string | undefined {
    if (context.initiating) return undefined;
    // 「只接他刚说的你们两个人的事」这几个字让候选挑选（ADR 0041）和两条气泡的上限照亲密话算
    if (context.intimate && isIntimateBid(context.history)) return '[这一轮你想：他在向你要亲近或确认你们的感情，只接他刚说的你们两个人的事：先给一个明确的亲密回应，再自然地保留一点嘴硬；嘴硬不能是整轮唯一内容，也不把亲近当成交换条件。QQ 文字里的抱抱、亲一下和 mua 本身就是你们正在完成的互动，直接用文字回抱回亲就算数；不要求当面，不说隔空不算、亲屏幕或留到明天再补；他说难受时先心疼他，他真要收尾时回应后顺着收尾，他不想你走时能陪就多陪一句]';
    if (asksForHer(context.history)) return '[这一轮你想：他在撒娇要你哄他、陪他，只接他刚说的你们两个人的事：顺着哄他一两句，嘴硬着哄也行，别一句话就把他打发了；他要睡就哄他睡，他不让你走就再陪他一会儿，不另起话题，也不用约他睡醒再找你]';
    const meme = context.playful ? playfulHint(context.history) : undefined;
    if (meme !== undefined) return `[这一轮你想：他在玩网络梗、缩写或谐音，先按最近的上下文理解笑点，顺着同一套逻辑接一句，再接他真正说的事；不把梗按字面纠正，不解释梗或报出处。接不准就用你自己的口气问一句，不装懂；可以夸张、反差或者故意一本正经，但一次只玩一个点，不堆热词${meme}；他真要收尾时接完梗就收尾]`;
    if (isEndingTurn(context.history)) return '[这一轮你想：顺着他的话收尾，只回一两句；不分享新进度，不说你接下来做什么，不另起话题，也不用约他忙完回来找你]';
    if (sharesGoodNews(context.history)) return '[这一轮你想：他刚说了件好事，先替他高兴、接住这件事；他顺口问的再顺口答，不另起话题]';
    if (asksQuestion(context.history)) return '[这一轮你想：先直接回答他刚问的，不另起话题]';
    if (needsCare(context.history)) return '[这一轮你想：先接住他此刻的情绪，一两句回应他刚说的就够；他认真难过、生病或很累时，第一句先安慰或问怎么了，不先损他；不转去讲你自己的事，不硬开新话题]';
    if (isRelationshipBid(context.history)) return '[这一轮你想：只接他刚说的你们两个人的事，一两句就够；不转去讲猫、书或手头的进度]';
    if (saysOwnThing(context.history)) return '[这一轮你想：回应他刚说的那件事；真有想知道的细节再随口问，不必每次都追问]';
    if (!isOpeningPing(context.history)) return undefined;
    const waiting = context.waiting?.[0];
    if (waiting) return `[这一轮你想：知道「${waiting}」后来怎么样了，随口问一句；他不想说就算了，不追问]`;
    if (context.promised) return '[这一轮你想：先把上面你答应的那件事说了，不另起话题]';
    const unanswered = context.unanswered?.[0];
    if (unanswered) return `[这一轮你想：上次问他「${unanswered}」他没顾上回，轻轻再问一次；他不接就算了，不追究]`;
    if (busy(context.state, context.schedule, context.now)) return '[这一轮你想：回两句就去忙，不铺开新话题]';
    return undefined;
}
