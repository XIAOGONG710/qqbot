// 看他的反应（ADR 0212，配置 hisReactions，默认关；只男朋友档）。
// 她主动跟他说自己的事（随口说件事、冷场、心里惦记、她那边的小事 / 土豆 / 吃的……）之后，他是接着聊了、回个「嗯」、没回，还是说了「别老发这个」——
// 按话题（土豆、吃的、课和作业……）记下来，下次她主动开口时给她看一行事实，说什么、说多说少由她自己拿捏。
// 为什么：dsh-fish / 「按自己作息刷 B 站」那几只「大肥鱼」会看主人回不回来调整分享；她只看时间和状态，学不到「他对土豆的事回得多、对课的事回个嗯」。
//
// 她本人的条件（11-02 `scripts/ask-her.mjs`，两遍）写进了这里：
// 1. 「土豆今天干的那点破事我就是想说」「我要真只挑你爱听的说，你慢慢就不知道我一天在干嘛了」——只给事实、不禁话题；「他不怎么接」的那类不会变成不能说。
// 2. 「我真不舒服的时候会跟你说」「你熬夜不吃早饭，我该说你还是说你」「我损你那几句……不会因为怕你不高兴就装乖」——
//    她不舒服、关心他吃饭睡觉的话不归任何话题（EXEMPT），不进统计，也就不会被他的反应压下去；损他不是她主动开口的话题，这里本来就不碰。
// 3. 「你要是哪件事真的不想听，直接说，别嗯」——他明说不想听（STOP）比回个「嗯」分量重得多：那一类这几天先不提。
// 4. 「头两天可能还照常发……再往后会说得少、说得冲」——他好几天不理人那一段，已经有 ADR 0100（没回也继续，第二次起带点小脾气）和 ADR 0074（隔 ≥3 天回来的小别扭）管着，这里不再加。
//
// 不落盘：每次从聊天记录（她发出去的那几条的 QQ 消息 id）和主动消息记录重算，重启前后一样。

import type { StoredMessage } from '../memory/history.ts';
import type { Candidate, NewsKind, Occasion, ProactiveRecord } from './proactive.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** 看多久以前的（三周） */
export const REACTION_WINDOW_DAYS = 21;
/** 越早的越不算数：一周减半 */
const HALF_LIFE_MS = 7 * DAY;
/** 她说完之后多久之内他回的才算回这一条（之后她又说了别的就截住） */
export const REPLY_WINDOW_MS = 12 * HOUR;
/** 一类事至少有这么多次（她主动说过的）才说他「多半……」 */
export const MIN_SAMPLES = 3;
/** 他明说不想听之后，这一类先不提这么多天 */
export const STOP_DAYS = 7;

/** 她主动说自己的事的那几个时机；早安、晚安、下课、催他、约他、问他意见、待跟进、重要的日子、改约、下雨、回来了不算 */
const SHARING: ReadonlySet<Occasion> = new Set(['share', 'quiet', 'inner', 'news']);
/** news 里不算的：她不舒服（条件 2） */
const NOT_SHARING_NEWS: ReadonlySet<NewsKind> = new Set(['unwell']);

export const REACTION_TOPICS = ['cat', 'food', 'study', 'friends', 'watch', 'buy', 'weather'] as const;
export type ReactionTopic = (typeof REACTION_TOPICS)[number];

/** 给她看的说法 */
export const TOPIC_LABEL: Readonly<Record<ReactionTopic, string>> = {
    cat: '土豆的事',
    food: '吃的',
    study: '课和作业',
    friends: '朋友和室友的事',
    watch: '看的玩的（剧、视频、游戏、书）',
    buy: '买东西、快递',
    weather: '天气',
};

const TOPIC_RE: Readonly<Record<ReactionTopic, RegExp>> = {
    cat: /土豆|猫|喵|猫粮|猫条/,
    food: /吃|饭|外卖|食堂|奶茶|零食|火锅|麻辣烫|面条|饺子|早餐|午餐|晚餐|夜宵|好饿|饿了|甜品|蛋糕|咖啡/,
    study: /课|作业|考试|小测|期中|期末|老师|论文|复习|图书馆|实验|预习|ddl|DDL|报告|学分|绩点|上机|作文/,
    friends: /室友|舍友|闺蜜|同学|朋友|学姐|学长|社团/,
    watch: /剧|视频|电影|游戏|番|综艺|动漫|小说|这本书|看书|读完|追更|up主|UP主|直播|歌/,
    buy: /买|快递|下单|拼单|到货|攒钱|包裹|驿站|淘宝|京东/,
    weather: /下雨|雨|降温|好冷|好热|太阳|刮风|大风|雪|天气/,
};

/**
 * 她自己的条件 2：不看他反应的话——她不舒服；关心他吃饭、睡觉、熬夜、喝水、穿衣。
 * 一条话里有这些就整条不进统计（宁可少算，不把她的关心算成「他不爱听的话题」）
 */
const EXEMPT_RE = /不舒服|难受|疼|发烧|感冒|生理期|姨妈|头晕|想吐|你.{0,8}(吃饭|吃了没|吃了吗|早饭|早餐|睡觉|早点睡|熬夜|喝水|多穿|休息|别太累)/;

/**
 * 他明说不想听（条件 3）。只认这几种说得很明白的：玩笑里的「别说了笑死」「滚」不算（规则判会误报，ADR 0074 同一个顾虑）
 */
const TELL = '(?:发(?!烧|胖|呆|愁|火|脾气|疯|抖|炎)|说|提)';
const STOP_RE = new RegExp(`不想(听|看)(这|那|你说)|不感兴趣|没(啥|什么)?兴趣|关我(什么|啥)事|别(老|再|总|一直)(给我)?${TELL}|能不能别(老|再|总)?${TELL}(这|那)|别发这(些|种|个)?(了|啦)?$`);

/** 「嗯」级的回：一条、去掉表情占位后只剩一两个字或这些词 */
const BRIEF_RE = /^(嗯+|嗯嗯|哦+|噢+|喔+|好+的?|好吧|行吧?|ok+|okk|收到|知道了|了解|哈+|嘿+|是吗|是嘛|啊+|哇+|6+|[。.…~～!！?？]+)$/i;
/** 聊天记录里的占位：[动画表情：……] [图片] [分享：……] */
const PLACEHOLDER_RE = /\[[^\]]{0,60}\]/g;

export type Reaction = 'engaged' | 'brief' | 'none' | 'stop';

/** 这几类分数：接着聊 +1；回个嗯 −0.4；没回 −0.25（他多半是在忙，不全算他不爱听） */
const REACTION_SCORE: Readonly<Record<Exclude<Reaction, 'stop'>, number>> = { engaged: 1, brief: -0.4, none: -0.25 };
/** 平均分到这么多：「他多半会接着聊」 */
const LIKED_AT = 0.5;
/** 平均分到这么低：「他多半回个嗯或者没回」 */
const FLAT_AT = -0.2;

/** 一条话属于哪几类；她不舒服 / 关心他的话不属于任何一类。names：她那边的人名（世界卡里的朋友），归「朋友和室友」 */
export function topicsOf(text: string, names: readonly string[] = []): ReactionTopic[] {
    if (EXEMPT_RE.test(text)) return [];
    const found = REACTION_TOPICS.filter(topic => TOPIC_RE[topic].test(text));
    // 三个字的名字她常只叫后两个字（陈佳宁 → 佳宁）
    const called = (name: string) => text.includes(name) || ([...name].length === 3 && text.includes([...name].slice(1).join('')));
    if (!found.includes('friends') && names.some(name => [...name].length >= 2 && called(name))) found.push('friends');
    return found;
}

/** 他对她说的那一条是怎么回的：after 是她说完之后的聊天记录（按时间） */
export function reactionTo(after: readonly StoredMessage[], saidAt: number): Reaction {
    const his: StoredMessage[] = [];
    for (const message of after) {
        const at = Date.parse(message.time);
        if (at <= saidAt) continue;
        if (at - saidAt > REPLY_WINDOW_MS) break;
        // 她又说了一句（她自己接着说的、或者回了他）：他这一串回的就到这里
        if (message.role === 'assistant') {
            if (his.length) break;
            continue;
        }
        his.push(message);
    }
    if (!his.length) return 'none';
    if (his.some(message => STOP_RE.test(message.content.trim()))) return 'stop';
    if (his.length >= 2) return 'engaged';
    const core = his[0]!.content.replace(PLACEHOLDER_RE, '').replace(/\s+/g, '').trim();
    // 只发了个表情 / 图：算「嗯」那一档（他看见了，没接话）
    if (!core || [...core].length <= 2 || BRIEF_RE.test(core)) return 'brief';
    return 'engaged';
}

export interface TopicReactions {
    topic: ReactionTopic;
    /** 她主动说过几次（三周内） */
    count: number;
    engaged: number;
    brief: number;
    none: number;
    /** 按时间减半加权的平均分 */
    mean: number;
    /** 他最后一次明说不想听的时刻 */
    stoppedAt?: number;
}

/**
 * 三周内她主动说自己的事（发出去了的）他都是怎么回的，按话题汇总。
 * 只认真发出去的（sent，带 QQ 消息 id，在聊天记录里找得到）；试运行、没发的不算
 */
export function hisReactions(history: readonly StoredMessage[], records: readonly ProactiveRecord[], now: number, names: readonly string[] = []): TopicReactions[] {
    const since = now - REACTION_WINDOW_DAYS * DAY;
    const byId = new Map<number, number>();
    history.forEach((message, index) => {
        if (message.role === 'assistant' && message.messageId !== undefined) byId.set(message.messageId, index);
    });
    const sums = new Map<ReactionTopic, { count: number; engaged: number; brief: number; none: number; weighted: number; weight: number; stoppedAt?: number }>();
    for (const record of records) {
        if (record.result !== 'sent' || !record.messageIds?.length || !SHARING.has(record.occasion)) continue;
        const indexes = record.messageIds.map(id => byId.get(id)).filter((i): i is number => i !== undefined);
        if (!indexes.length) continue;
        const last = Math.max(...indexes);
        const saidAt = Date.parse(history[last]!.time);
        if (!(saidAt >= since && saidAt <= now)) continue;
        const text = indexes.map(i => history[i]!.content).join(' ');
        // 喂完土豆 / 吃饭拍的照片：话题定了；她不舒服那一类不算
        const kind = newsKindOf(record);
        if (kind && NOT_SHARING_NEWS.has(kind)) continue;
        const topics = kind === 'cat_photo' ? ['cat' as const] : kind === 'food_photo' ? ['food' as const] : topicsOf(text, names);
        if (!topics.length) continue;
        const reaction = reactionTo(history.slice(last + 1), saidAt);
        const weight = 0.5 ** ((now - saidAt) / HALF_LIFE_MS);
        for (const topic of topics) {
            const sum = sums.get(topic) ?? { count: 0, engaged: 0, brief: 0, none: 0, weighted: 0, weight: 0 };
            sum.count++;
            if (reaction === 'stop') {
                sum.stoppedAt = Math.max(sum.stoppedAt ?? 0, saidAt);
            } else {
                sum[reaction]++;
                sum.weighted += REACTION_SCORE[reaction] * weight;
                sum.weight += weight;
            }
            sums.set(topic, sum);
        }
    }
    return REACTION_TOPICS.filter(topic => sums.has(topic)).map(topic => {
        const { count, engaged, brief, none, weighted, weight, stoppedAt } = sums.get(topic)!;
        return { topic, count, engaged, brief, none, mean: weight ? weighted / weight : 0, ...(stoppedAt !== undefined ? { stoppedAt } : {}) };
    });
}

/**
 * 记录 id 里带着的 news 那一件是哪一类：记录 id 是 <天>:news:<事件 id>，事件 id 的头一段是 world.ts 定的
 * （cat_photo:<天>、food_photo:<天>:<顿>、small:<天>:<id>、camera、homework:<天>、friend_sick:<人>:<天>、friend:<约>、unwell:<天>）
 */
const NEWS_ID_HEAD: Readonly<Record<string, NewsKind>> = {
    cat_photo: 'cat_photo', food_photo: 'food_photo', small: 'small_thing', camera: 'camera', homework: 'homework_done',
    friend_sick: 'friend_sick', friend: 'friend_changed', unwell: 'unwell',
};
export function newsKindOf(record: Pick<ProactiveRecord, 'id' | 'occasion'>): NewsKind | undefined {
    if (record.occasion !== 'news') return undefined;
    const newsId = record.id.split(':news:')[1];
    return newsId ? NEWS_ID_HEAD[newsId.split(':')[0]!] : undefined;
}

/** 他明说不想听的、还在 STOP_DAYS 天里的那几类 */
export function stoppedTopics(stats: readonly TopicReactions[], now: number): ReactionTopic[] {
    return stats.filter(s => s.stoppedAt !== undefined && now - s.stoppedAt < STOP_DAYS * DAY).map(s => s.topic);
}

/** 他多半不怎么接的那几类（够次数、平均分够低、这几天没被他明说过的） */
export function flatTopics(stats: readonly TopicReactions[], now: number): ReactionTopic[] {
    const stopped = new Set(stoppedTopics(stats, now));
    return stats.filter(s => !stopped.has(s.topic) && s.engaged + s.brief + s.none >= MIN_SAMPLES && s.mean <= FLAT_AT).map(s => s.topic);
}

/**
 * 主动开口时给她看的一行（只给事实和「你自己拿捏」，不给台词、不禁话题）。
 * 没有够次数的类、也没有他明说过的，就没有这一行
 */
export function reactionsLine(stats: readonly TopicReactions[], now: number): string | undefined {
    const stopped = stoppedTopics(stats, now);
    const flat = flatTopics(stats, now);
    const liked = stats.filter(s => !stopped.includes(s.topic) && s.engaged + s.brief + s.none >= MIN_SAMPLES && s.mean >= LIKED_AT).map(s => s.topic);
    if (!stopped.length && !flat.length && !liked.length) return undefined;
    const label = (topics: readonly ReactionTopic[]) => topics.map(topic => TOPIC_LABEL[topic]).join('、');
    const seen = [
        liked.length ? `${label(liked)}他多半会接着聊` : '',
        flat.length ? `${label(flat)}他多半就回个嗯，或者没回` : '',
    ].filter(Boolean).join('；');
    const stop = stopped.map(topic => {
        const days = Math.max(1, Math.round((now - stats.find(s => s.topic === topic)!.stoppedAt!) / DAY));
        return `他 ${days} 天前直接说过不想听你说${TOPIC_LABEL[topic]}，这几天先别跟他提这个`;
    }).join('；');
    return `你看到的他的反应（这三周你主动跟他说的事）：${[seen, stop].filter(Boolean).join('；')}。这只是你看到的，说什么、说多说少你自己拿捏，想说的照样可以说`;
}

/** 日志里的一句（只有话题和次数，不带任何一句原话） */
export function reactionsLog(stats: readonly TopicReactions[]): string {
    return stats.map(s => `${TOPIC_LABEL[s.topic].replace(/（.*）/, '')} 接 ${s.engaged} / 嗯 ${s.brief} / 没回 ${s.none}${s.stoppedAt !== undefined ? ' / 说过不想听' : ''}`).join('；');
}

/** 这一件定了话题的事（喂完土豆的照片、吃饭的照片）：他明说过不想听这一类就不发；他只是不怎么接的，交给她自己决定（canDecline） */
export function fixedTopicOf(kind: NewsKind | undefined): ReactionTopic | undefined {
    return kind === 'cat_photo' ? 'cat' : kind === 'food_photo' ? 'food' : undefined;
}

/** 这一次主动开口时用：跳过（他明说过不想听这一类）、给她看的那一行、能不能决定不发、日志 */
export interface ReactionPlan {
    skip?: string;
    seen?: string;
    canDecline?: true;
    log?: string;
}

/** 给她看反应的时机：她自己挑话题的（随口说件事、冷场），和话题定了的小事 / 土豆 / 吃的照片 */
const LIGHT_NEWS: ReadonlySet<NewsKind> = new Set(['small_thing', 'cat_photo', 'food_photo']);

export function reactionPlan(
    candidate: Pick<Candidate, 'occasion' | 'news'>, stats: readonly TopicReactions[], now: number, names: readonly string[] = [],
): ReactionPlan {
    const news = candidate.occasion === 'news' ? candidate.news : undefined;
    if (candidate.occasion !== 'share' && candidate.occasion !== 'quiet' && !(news && LIGHT_NEWS.has(news.kind))) return {};
    const fixed: ReactionTopic[] = news ? (fixedTopicOf(news.kind) ? [fixedTopicOf(news.kind)!] : topicsOf(news.what, names)) : [];
    const stopped = stoppedTopics(stats, now);
    const hit = fixed.find(topic => stopped.includes(topic));
    if (hit) {
        const days = Math.max(1, Math.round((now - stats.find(s => s.topic === hit)!.stoppedAt!) / DAY));
        return { skip: `他 ${days} 天前说过不想听${TOPIC_LABEL[hit]}，这几天先不说这个`, log: reactionsLog(stats) };
    }
    const line = reactionsLine(stats, now);
    if (!line) return {};
    // 话题定了、正好是他不怎么接的那类：让她自己决定这次说不说（条件 1：土豆的事她照发，不给这个口子）
    const flat = flatTopics(stats, now);
    if (news && news.kind !== 'cat_photo' && fixed.some(topic => flat.includes(topic))) {
        return { seen: `${line}；要是这件正好是他不怎么接的那类、你这会儿也不太想说了，就只输出「不发」两个字`, canDecline: true, log: reactionsLog(stats) };
    }
    return { seen: line, log: reactionsLog(stats) };
}
