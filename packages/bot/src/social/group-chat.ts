// 群聊（ADR 0210，用户 2026-11-02「下一步做群聊和陌生人互动」）。
// 用户定的：只进他拉她进的群，而且要加进配置 groups 才说话；他来标哪些群的人都知道她是 AI（标了的群承不承认由她，没标的按不知道：认真问到就承认）。
// 她本人（scripts/ask-her.mjs）：「基本潜水」「有人点我名了，或者话题正好撞我枪口上——吃的、剧、猫」「有人在群里损你，那我得出来说两句」；
// 「群里肯定得收着点……但你也别装得跟不认识我似的……就正常说话，别喊得那么黏」。
// 这里是纯函数：群里的记录、谁说的、该不该开口、每个群的额度、给她的说明。调模型、发消息在 app.ts。

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { catAlternative } from '../character-terms.ts';
import { detectCrisis } from '../emotion/crisis.ts';
import { join } from 'node:path';
import { pick } from './reply-timing.ts';
import type { Segment } from '../platform/onebot.ts';
import { motiveAllows, type GroupMotiveDecision } from './group-opportunity.ts';

/** 群里的一条（她自己说的 mine） */
export interface GroupEntry {
    time: string;
    from: number;
    /** 群名片，没有就 QQ 昵称 */
    name: string;
    content: string;
    messageId: number;
    replyTo?: number;
    playful?: true;
    mine?: true;
    /** 进群之前导进来的旧记录（2026-11-14）：只当上下文，不是刚到的消息、不触发回话 */
    history?: true;
}

/** 每个群的额度：一小时、一天最多几条；不是被叫到的话两句之间至少隔多久；顺着话题插嘴一天几次 */
export const GROUP_LIMITS = { perHour: 6, perDay: 30, minGapMs: 90_000, topicPerDay: 3, topicChance: 0.3, overheardPerDay: 2, overheardChance: 0.4 } as const;
/** 放进提示词的最近几条 */
export const GROUP_CONTEXT = 30;

/** 她的叫法：群里有人这样叫就算叫到她（真名）；QQ 昵称、群名片另从群成员资料读（2026-11-14） */
export const HER_NAMES = ['林梦瑶', '梦瑶', '瑶瑶', '瑶姐'] as const;
/** 她在这个群还可能被叫的名字：QQ 昵称 / 群名片 + 真名，去重、太短的不算（「瑶」这种一个字会被当成普通字） */
export function herNameList(extra: readonly string[] = []): string[] {
    return [...new Set([...extra.filter(name => typeof name === 'string' && name.trim().length >= 2).map(name => name.trim()), ...HER_NAMES])];
}
const escaped = (names: readonly string[]) => names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
/** 她熟的话题（她本人：吃的、剧、楼下的猫；猫的名字从卡上读，ADR 0335） */
const herTopics = () => new RegExp(`吃什么|吃啥|饭|外卖|奶茶|火锅|烧烤|零食|追剧|这剧|电视剧|番剧|新番|电影|猫|${catAlternative()}相机|拍照|摄影|修图|照片`);
/** 损人的话（有人这样说他） */
export const TEASING = /菜|笨|傻|蠢|丑|怂|废物|拉胯|垃圾|太弱|弱鸡|不行啊|就这|笑死|好惨|活该|单身狗/;
/** 话说得难听：骂人的、侮辱人的，不是斗嘴那种「菜」「笑死」（groupAgency B，她 11-22：「话说得难听了……那我肯定得说两句」；group-self.ts 的 defendCall） */
export const HARSH = /废物|垃圾|傻[逼比叉B]|(?<![a-z])sb(?![a-z])|滚(?:蛋|开|远点)?(?![滚动烫])|恶心|去死|脑残|智障|贱|狗东西|你妈的|他妈的|tmd|尼玛|死开|丢人现眼|没用的东西/i;
/** 想伤害自己、绝望（群里有人这么说，她认真接，不当玩笑）：用私聊那套判定，夸张、否认、说别人的都不算 */
const despair = (text: string) => detectCrisis(text) !== undefined;

/** 提到她名字的时候，是不是在冲她说话（「梦瑶你说呢」「梦瑶在吗」算；「梦瑶昨天那个视频」不算） */
const namedAt = (text: string, names: readonly string[]) =>
    new RegExp(`(?:${escaped(names)})\\s*[，,、]?\\s*(?:你|您|在吗|在不在|在哪|呢|帮|看|听|来|说|唱|觉得|要不要|怎么|为什么|能不能)`).test(text);
/** 谈论她的口气：夸还是损（2026-11-14 没 @ 她、只在群里聊到她） */
const ABOUT_HER_GOOD = /好看|好听|厉害|牛|可爱|靠谱|温柔|聪明|厉害|真行|不错|挺好|好会|会说话|人好/;
const ABOUT_HER_BAD = /难看|难听|做作|装|绿茶|蠢|傻|烦人|恶心|刻薄|有病|不行|讨厌|自恋|整天/;

/** quiet / news：她自己想说（ADR 0341 G2，groupOwn）——冷场冒一句、她那边有事顺嘴说一句；不是从某条消息来的 */
export type SpeakReason = 'mentioned' | 'crisis' | 'defend' | 'topic' | 'overheard' | 'quiet' | 'news';

/**
 * 这条开口是从哪来的（ADR 0343，与 reason 正交）：
 * - reactive：被叫、危机、替他说，看见就接，跟开关无关；
 * - motive：群自主开着的主动类（话题 / 听见 / 冷场 / 有事），由动机决定，不抽签；
 * - lottery：群自主关着时原来的抽签路径。
 */
export type SpeakSource = 'motive' | 'lottery' | 'reactive';

/** 开口决策的观测（早于模型；模型写「不说」只影响说不说，不改这里） */
export interface SpeakDecision {
    reason: SpeakReason | undefined;
    source: SpeakSource;
    motiveEligible: boolean;
}

/** 群自主开着时传 motives；不传就逐字走原来的抽签逻辑 */
export interface SpeakOptions {
    motives?: GroupMotiveDecision;
    onDecision?: (decision: SpeakDecision) => void;
}

/**
 * 一次开口决策的痕迹（仅模拟器注入 onDecision 时收集，线上不传）。
 * passed 在决策层定（早于模型）：模型写「不说」只影响说不说，不翻这里。
 */
export interface GroupDecisionTrace {
    groupId: number;
    messageId: number;
    timeBlock: number;
    reason: SpeakReason | undefined;
    source: SpeakSource;
    motiveEligible: boolean;
    passed: boolean;
    blockedBy?: 'budget' | 'line' | 'none';
    replyTargetId?: number;
    memoryIncluded?: boolean;
    draftCount?: number;
    deliveries?: Array<{ messageId: number; replyTo?: number }>;
    failed?: true;
}

export interface SpeakContext {
    selfId: number;
    /** 男朋友（宝宝）：他在群里的 QQ 号、她怎么叫他 */
    boyfriend?: { qq: number; name: string };
    /** 群里他的名片 / 昵称（从记录里认出来的） */
    boyfriendNames?: readonly string[];
    /** 她在这个群发过的消息 id（别人引用她） */
    herMessageIds: ReadonlySet<number>;
    /** 这个群今天已经顺着话题插过几次 */
    topicToday: number;
    /** 这个群今天已经「听见别人聊她」接过几次 */
    overheardToday?: number;
    /** 她在群里被叫的名字（QQ 昵称 / 群名片）；不给就只认真名 */
    herNames?: readonly string[];
}

/** 这条是不是在说「她」：叫她的名字（或群里叫她那个名字），但不是在叫她 */
export function mentionsHer(text: string, extra: readonly string[] = []): boolean {
    return herNameList(extra).some(name => text.includes(name));
}

/** 提到她的时候是什么口气 */
export function gossipTone(text: string, extra: readonly string[] = []): 'good' | 'bad' | undefined {
    if (!mentionsHer(text, extra)) return undefined;
    if (ABOUT_HER_BAD.test(text)) return 'bad';
    if (ABOUT_HER_GOOD.test(text)) return 'good';
    return undefined;
}

/** 这条该不该让她开口、为什么；undefined = 潜水 */
export function speakReason(message: Segment[] | string, text: string, from: number, messageId: number, ctx: SpeakContext, options?: SpeakOptions): SpeakReason | undefined {
    const segments = typeof message === 'string' ? [] : message;
    const motives = options?.motives;
    const eligible = motiveAllows(motives);
    // 被动那几路跟开关无关；主动那几路：开着读动机，关着走原来的抽签
    const decide = (reason: SpeakReason | undefined, source: SpeakSource, motiveEligible = false): SpeakReason | undefined => {
        options?.onDecision?.({ reason, source, motiveEligible });
        return reason;
    };
    const onMotive = (reason: SpeakReason): SpeakReason | undefined => decide(eligible ? reason : undefined, 'motive', eligible);
    const atHer = segments.some(s => s.type === 'at' && Number(s.data?.qq) === ctx.selfId);
    const repliesHer = segments.some(s => s.type === 'reply' && ctx.herMessageIds.has(Number(s.data?.id)));
    if (despair(text)) return decide('crisis', 'reactive');
    if (atHer || repliesHer) return decide('mentioned', 'reactive');
    const names = ctx.herNames ?? [];
    if (mentionsHer(text, names)) {
        // 名字后面跟着「你 / 在吗 / 帮我看」这种，就是在跟她说话；只是被提起来，是「听见」
        if (namedAt(text, herNameList(names))) return decide('mentioned', 'reactive');
        if ((ctx.overheardToday ?? 0) >= GROUP_LIMITS.overheardPerDay) return decide(undefined, motives ? 'motive' : 'lottery', eligible);
        // 听见别人聊她：说坏话的更容易接一句给自己分辩；被夸、被随口提起来的大多看着不说话
        if (gossipTone(text, names) === 'bad') return motives ? onMotive('overheard') : decide('overheard', 'lottery');
        if (motives) return onMotive('overheard');
        if (pick(String(messageId), 'group-overheard', [0, 999]) < GROUP_LIMITS.overheardChance * 1000) return decide('overheard', 'lottery');
        return decide(undefined, 'lottery');
    }
    if (ctx.boyfriend && from !== ctx.boyfriend.qq) {
        const atHim = segments.some(s => s.type === 'at' && Number(s.data?.qq) === ctx.boyfriend!.qq);
        const namesHim = (ctx.boyfriendNames ?? []).some(name => name.length >= 2 && text.includes(name));
        // 群自主开着（motives）时难听的话也算损他（她出不出头由 group-self.ts 的 defendCall 定）；关着逐字照旧
        if ((atHim || namesHim) && (TEASING.test(text) || (motives !== undefined && HARSH.test(text)))) return decide('defend', 'reactive');
    }
    if (herTopics().test(text) && ctx.topicToday < GROUP_LIMITS.topicPerDay) {
        if (motives) return onMotive('topic');
        if (pick(String(messageId), 'group-topic', [0, 999]) < GROUP_LIMITS.topicChance * 1000) return decide('topic', 'lottery');
    }
    return decide(undefined, motives ? 'motive' : 'lottery', eligible);
}

/** 额度：这一次能不能说（被叫到、有人说想不开的不看间隔，但照样看一小时 / 一天的上限） */
export function withinBudget(mine: readonly GroupEntry[], now: number, reason: SpeakReason): { ok: true } | { ok: false; why: string } {
    const times = mine.map(e => Date.parse(e.time));
    const lastHour = times.filter(t => now - t < 3_600_000).length;
    const day = new Date(now);
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
    const today = times.filter(t => t >= dayStart).length;
    if (reason !== 'crisis' && lastHour >= GROUP_LIMITS.perHour) return { ok: false, why: `这一小时已经在这个群说了 ${lastHour} 条` };
    if (reason !== 'crisis' && today >= GROUP_LIMITS.perDay) return { ok: false, why: `今天已经在这个群说了 ${today} 条` };
    const last = times.length ? Math.max(...times) : -Infinity;
    if ((reason === 'topic' || reason === 'defend' || reason === 'overheard' || reason === 'quiet' || reason === 'news') && now - last < GROUP_LIMITS.minGapMs) return { ok: false, why: '刚说过，隔一会儿' };
    return { ok: true };
}

/** 群消息里的 @QQ号 换成人话：@她 → @你，@他 → @宝宝，别人用记录里认出来的名字 */
export function nameAts(text: string, selfId: number, names: ReadonlyMap<number, string>, boyfriend?: { qq: number; name: string }): string {
    return text.replace(/@(\d{5,12}) ?/g, (_all, qq: string) => {
        const id = Number(qq);
        if (id === selfId) return '@你 ';
        if (boyfriend && id === boyfriend.qq) return `@${boyfriend.name} `;
        const name = names.get(id);
        return name ? `@${name} ` : '@某人 ';
    });
}

/** 群名片 / 昵称是群友自己随便改的：叫「你」「他」或带着「男朋友」，写出来就像她自己、像他说的 */
const RESERVED_SPEAKER = /^(?:你|我|他|她)$|男朋友/;
/** 一条群消息在记录里最多放几个字（太长的复制粘贴不整段塞进她的提示词） */
export const GROUP_LINE_MAX_CHARS = 500;
/** 换行（含 U+2028 / U+2029，模型也当换行看）连同两边的空白 */
const LINE_BREAKS = new RegExp('\\s*[\\r\\n' + String.fromCharCode(0x2028, 0x2029) + ']+\\s*', 'g');

/**
 * 一条记录写成给她看的一行：她自己 =「你」，男朋友 =「宝宝（你男朋友）」，别人用群名片。
 * 2026-11-26 入站审查：记录是一行一条拼起来的——群友的话里带换行就能自己另起一行「宝宝（你男朋友）：……」「你：……」，
 * 名片改成「你」「某某（你男朋友）」也一样。所以内容压成一行、截短；名片撞上这几个叫法的写成「群友「…」」
 */
export function groupLine(entry: GroupEntry, boyfriend?: { qq: number; name: string }): string {
    const name = entry.name || '群友';
    const who = entry.mine ? '你' : boyfriend && entry.from === boyfriend.qq ? `${boyfriend.name}（你男朋友）` : RESERVED_SPEAKER.test(name) ? `群友「${name}」` : name;
    const flat = entry.content.replace(LINE_BREAKS, ' ');
    const chars = [...flat];
    return `${who}：${chars.length > GROUP_LINE_MAX_CHARS ? `${chars.slice(0, GROUP_LINE_MAX_CHARS).join('')}…` : flat}`;
}

const REASON_NOTE: Record<SpeakReason, string> = {
    mentioned: '刚才有人叫你、@你或者回了你的话，接一句。',
    crisis: '刚才有人说了想不开、不想活这类的话：认真接住他，不开玩笑，别讲大道理；劝他找身边信得过的人，或者打心理援助热线（12356，或 400-161-9995）。',
    defend: '刚才有人在损他（你男朋友），你可以出来替他说两句，嘴上别太凶，像平时斗嘴那样。',
    topic: '刚才聊到的正好是你熟的，想插一句就插一句；没什么想说的就只写「不说」。',
    overheard: '刚才没人在跟你说话，是他们在聊到你（提到你的名字）。你可以装作恰好看见、接一句；被说得不好听就给自己分辩一下，但别大气凛然，也别追着问是谁说的；不想理就只写「不说」。',
    quiet: '群里安静了好一阵了，没人在跟你说话。你这会儿想冒一句就冒一句——说说你这边、随口问一句、接上面没聊完的都行，像自己闲下来顺手发的；不想说就只写「不说」。',
    news: '没人在跟你说话，是你自己这边刚有件事，群里刚好有人在。想顺嘴说一句就说，一句就够；不想说就只写「不说」。',
};

/**
 * 给她的说明（放在聊天记录后面）：这是哪个群、群里怎么说话、他在不在、这次为什么开口。
 * 不写「你是 AI」的立场：认不认按卡（ADR 0067 / 0208），这里不重复
 */
export function groupNote(input: {
    groupName: string; boyfriendHere: boolean; boyfriendName?: string; reason: SpeakReason;
    /** 触发本轮的唯一群消息，已经带说话人。 */
    targetLine?: string;
    /** 这个群里她认识谁（group-people.ts 渲染好的一整段） */
    memory?: string;
    /** 她这会儿的心情（只说怎么样，不说来由） */
    mood?: string;
    /** 她在这个群的 QQ 昵称 / 群名片：别人不一定叫她的真名 */
    myNames?: readonly string[];
    /** 群里导进过以前的记录：她补过课、知道旧事，但**她是刚进群的**（2026-11-14） */
    veteran?: boolean;
    /** 群里的人都知道她是 AI（他标过）：不用主动提，也不用瞒，正常聊 */
    knowsBot?: boolean;
    /** 要装成真人：别提、别承认自己是 AI */
    disguise?: boolean;
    /** 进群的说法：有人问「你也是来养鱼的吗」「你是某人养的鱼吗」时照这个口径答 */
    cover?: string;
    /** 群成员名单（不一定跟她说过话）：别把人当陌生人 */
    roster?: readonly string[];
    /** 这个群平时的味儿（group-style.ts 从聊天记录里统计的） */
    style?: string;
    publicBoundaries?: string;
    /** 她自己（ADR 0341，groupOwn）：群里能带的「你现在」那一段 + 她自己定的群里的边界（group-self.ts） */
    self?: string;
    /** 她那边刚有的事（reason 是 news 时） */
    news?: string;
}): string {
    // 群里叫她别的名字（QQ 昵称、群名片）：那也是她，别人叫那些也算叫她
    const aliases = (input.myNames ?? []).filter(name => name.trim().length >= 2 && !HER_NAMES.includes(name.trim() as typeof HER_NAMES[number]));
    const asksHowJoined = input.reason === 'mentioned'
        && /(?:怎么|为什么|谁.{0,8}(?:拉|邀)).{0,8}(?:进群|进来|来这)|来养鱼的吗|(?:你是|你是不是|你也算).{0,12}(?:养的鱼|家的鱼)[吗？?]/.test(input.targetLine ?? '');
    return [
        `[这是 QQ 群「${input.groupName}」里的聊天，群里有好几个人，上面每行冒号前是谁说的，「你」是你自己说的。`,
        aliases.length ? `群里他们也可能叫你「${aliases.join('」「')}」（你在这个群的昵称 / 群名片）；那都是你，别当成别人。` : '',
        '群里那些鱼、谁家的鱼、别的助手，都是他们自己的说法：你还是你，别顺着就把这些当成自己的；别人的名字、身体特点和经历都归说话的那个人。别人刚说完的话也别捡来当自己的，按你平时的说法接。',
        input.veteran ? '上面有些是你进群之前的旧聊天：你补过课、知道他们聊过什么，但**你是刚进群的**——别把旧事说成你在场（不说「上次」「那天我也在」），别人提起就顺着聊，被问就照实说刚来。' : '',
        input.disguise ? '别主动提、也别承认自己是 AI（这里没人知道）：有人认真问就含糊带过、换个话题，别一本正经解释；被开玩笑叫机器人就当玩笑接。' : '',
        input.cover && asksHowJoined
            ? `眼前这条问的是你的来由：照这个说法随口答一句，别主动扯上他和你的关系——${input.cover}。答完停住。`
            : '',
        input.knowsBot ? '群里的人都知道你是 AI（他跟大家说过）：不用主动提，也不用瞒、不用否认；有人拿这个开玩笑就顺着开两句，别一本正经解释。' : '',
        input.roster?.length ? `群里的人：${input.roster.join('、')}。${input.publicBoundaries ? '这是成员名单，不能凭名单判断熟不熟。' : '这些人你都认得（不一定都跟你说过话），别当陌生人。'}` : '',
        input.style ?? '',
        '群里说话像在群里：短，一两句，不刷屏，不用每句都接；不在群里说你和他之间的私事，也不说别人私下跟你说的事。',
        input.boyfriendHere && input.boyfriendName ? `${input.boyfriendName}（你男朋友）也在这个群：群里收着点，正常说话，别喊得黏，也别装不认识。` : '',
        input.memory ?? '',
        input.self ?? '',
        input.mood ?? '',
        input.targetLine ? `这次只接这一条群消息：${JSON.stringify(input.targetLine)}。其他消息用来理解这一条。` : '',
        input.publicBoundaries && input.reason === 'defend' ? '有人在挤兑群友。要接话就只就眼前的话劝一句，别站队。' : REASON_NOTE[input.reason],
        input.publicBoundaries ?? '',
        input.reason !== 'crisis' && input.reason !== 'defend'
            ? '闲聊时直接接眼前的一个细节，省掉固定开场。一句只说一件事，反应到位就停。只有第二句还在回答那一条，而且有新意思，才补上；不用续出没发生的动作。用你自己的话，不复读、不跟着刷表情；吵架、站队或围着人起哄时不用凑。'
            : '',
        input.news ? `（你这边的事：${input.news}）` : '',
        '只输出你要发到群里的话，不写名字前缀、不写动作；想让谁看见就写「@群名片」（只认这个群里叫得出来的名字）；不想说就只写「不说」。]',
    ].filter(Boolean).join('');
}

/** 只拦把已知群友名字明确当作自己名字的句子，关系、转述和普通接梗仍可说。 */
export function claimsAnotherGroupMember(text: string, otherNames: ReadonlySet<string>): boolean {
    return text.split(/[。！？!?；;，,]/u).some(clause => {
        const match = /^\s*我(?:就是|才是|是|叫)\s*[「“]?(.+?)[」”]?\s*[.。]?\s*$/u.exec(clause);
        const name = match?.[1]?.trim();
        return Boolean(name && (otherNames.has(name) || otherNames.has(name.replace(/[啊呀啦]$/u, ''))));
    });
}

/**
 * 她写的话里带「@老王」就真的 @ 出去（2026-11-14）：只认这个群里认得出的名字，
 * 认不出的照旧当文字留着（不瞎 @ 人）。返回 undefined = 没有能换成段的 @，发纯文字就行。
 */
export function mentionSegments(text: string, names: ReadonlyMap<string, number>): Segment[] | undefined {
    if (!text.includes('@')) return undefined;
    const segments: Segment[] = [];
    let mentioned = false;
    const pattern = /@([^\s@，。！？!?、:：]{1,16})/g;
    let last = 0;
    for (const match of text.matchAll(pattern)) {
        const name = match[1]!;
        const qq = names.get(name);
        if (qq === undefined) continue;
        const at = match.index!;
        const before = text.slice(last, at).replace(/[ \t]+$/, '');
        if (before) segments.push({ type: 'text', data: { text: before } });
        segments.push({ type: 'at', data: { qq: String(qq) } });
        last = at + match[0].length;
        mentioned = true;
    }
    if (!mentioned) return undefined;
    const tail = text.slice(last).trimStart();
    if (tail) segments.push({ type: 'text', data: { text: ` ${tail}` } });
    return segments.length ? segments : undefined;
}

/** 接完话顺手戳一下：约 15%，同一个人 10 分钟最多一次（2026-11-14） */
export const GROUP_POKE = { chance: 0.15, gapMs: 10 * 60_000 } as const;
export function groupPokePlan(seed: string, lastAt: number | undefined, now: number): { delayMs: number } | undefined {
    if (lastAt !== undefined && now - lastAt < GROUP_POKE.gapMs) return undefined;
    if (pick(seed, 'group-poke', [0, 999]) >= GROUP_POKE.chance * 1000) return undefined;
    return { delayMs: pick(seed, 'group-poke-delay', [800, 2400]) };
}


/** 她写的群消息整理成要发的一两条；「不说」或者空的就不发 */
export function groupReply(raw: string, maxBubbles = 2): string[] {
    const lines = raw.replace(/\r/g, '').split('\n')
        .map(line => line.replace(/<<[^<>\n]{0,80}>>/g, '').replace(/^(?:你|林梦瑶|梦瑶)[：:]\s*/, '').trim())
        .filter(Boolean);
    if (!lines.length || lines.every(line => /^[（(]?不说[）)]?[。.]?$/.test(line))) return [];
    return lines.filter(line => !/^[（(]?不说[）)]?[。.]?$/.test(line)).slice(0, maxBubbles).map(line => (line.length > 80 ? `${line.slice(0, 80)}…` : line));
}

/** 群记录：<数据目录>/groups/<群号>.jsonl，一行一条 */
export function groupLog(dataDir: string): { load(groupId: number): GroupEntry[]; append(groupId: number, entry: GroupEntry): void; has(groupId: number, messageId: number): boolean } {
    const dir = join(dataDir, 'groups');
    const file = (groupId: number) => join(dir, `${groupId}.jsonl`);
    const cache = new Map<number, GroupEntry[]>();
    const load = (groupId: number): GroupEntry[] => {
        const hit = cache.get(groupId);
        if (hit) return hit;
        const path = file(groupId);
        const list = existsSync(path)
            ? readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line) as GroupEntry]; } catch { return []; } })
            : [];
        cache.set(groupId, list);
        return list;
    };
    return {
        load,
        append(groupId, entry) {
            mkdirSync(dir, { recursive: true });
            appendFileSync(file(groupId), `${JSON.stringify(entry)}\n`);
            load(groupId).push(entry);
        },
        has: (groupId, messageId) => load(groupId).some(e => e.messageId === messageId),
    };
}
