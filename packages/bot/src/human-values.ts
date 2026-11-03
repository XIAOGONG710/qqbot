// 真人式连续状态（ADR 0222）。
//
// 这里不保存一份会和聊天 / 生活账漂移的“当前分数”。所有值都从已有事实和时刻重算：
// 现有 needs.ts 提供身体需要，聊天记录提供关系与短期心理信号，生活事件提供活动 / 结果。
// 数值先用于审计和后续选择器校准，不直接交给模型，避免她把内部状态说成仪表盘。

import type { LifeEvent } from './world/life-events.ts';
import { needsAt, type NeedsSnapshot } from './life/needs.ts';
import type { StoredMessage } from './memory/history.ts';

export const HUMAN_VALUE_KEYS = [
    'energy', 'hunger', 'stress', 'mood', 'health', 'loneliness',
    'intimacy', 'trust', 'familiarity', 'attachment', 'friction', 'confidence',
    'curiosity', 'boredom', 'motivation', 'socialBattery', 'selfEsteem',
    'openness', 'satisfaction', 'comfort', 'frustration',
] as const;
export type HumanValueKey = (typeof HUMAN_VALUE_KEYS)[number];

export interface RelationshipValues {
    /** 亲密：愿意分享、撒娇、把他当自己人的程度。 */
    intimacy: number;
    /** 信任：相信对方会接住、不会随便伤害自己的程度。 */
    trust: number;
    /** 熟悉度：共同经历和稳定互动积累出的“知道彼此习惯”。 */
    familiarity: number;
    /** 依恋：想靠近、想找对方的倾向。 */
    attachment: number;
    /** 摩擦：最近的小冲突 / 被晾着留下的余波。越高越容易别扭。 */
    friction: number;
}

export interface HumanValues {
    at: string;
    /** 0–100，直接沿用 needs.ts 的可重放身体投影。 */
    energy: number;
    hunger: number;
    stress: number;
    /** 0–100，50 是平稳；越高越愉快。 */
    mood: number;
    /** 0–100，90 左右是健康稳定，低值表示身体负担。 */
    health: number;
    /** 0–100，越高越缺陪伴 / 越想找人。 */
    loneliness: number;
    confidence: number;
    curiosity: number;
    boredom: number;
    /** 做事的启动意愿，不等同于精力：有劲但不想做，或很想做但没劲，都是可能的。 */
    motivation: number;
    /** 社交电量；社交会消耗，睡觉 / 休息会恢复。 */
    socialBattery: number;
    selfEsteem: number;
    openness: number;
    satisfaction: number;
    comfort: number;
    frustration: number;
    relationship: RelationshipValues;
}

export interface HumanValueFacts {
    at: Date;
    needs: NeedsSnapshot;
    history: readonly (Pick<StoredMessage, 'role' | 'content'> & { time?: string })[];
    tier?: string;
    events?: readonly LifeEvent[];
}

/** 从版本化需要锚点和事件账直接得到完整状态，确保“行动结束 → 数值变化”不会被调用方漏掉。 */
export function humanValuesFromAnchor(facts: Omit<HumanValueFacts, 'needs'> & { anchor: NeedsSnapshot }): HumanValues {
    const events = facts.events ?? [];
    return humanValuesAt({ ...facts, needs: needsAt(facts.anchor, events, facts.at) });
}

const HOUR = 3_600_000;
const DAY = 86_400_000;

const BASE_RELATIONSHIP: Record<string, RelationshipValues> = {
    boyfriend: { intimacy: 78, trust: 73, familiarity: 82, attachment: 80, friction: 8 },
    bestie: { intimacy: 68, trust: 70, familiarity: 75, attachment: 58, friction: 7 },
    girl_friend: { intimacy: 55, trust: 62, familiarity: 62, attachment: 38, friction: 6 },
    known: { intimacy: 35, trust: 48, familiarity: 42, attachment: 20, friction: 4 },
    classmate: { intimacy: 24, trust: 40, familiarity: 32, attachment: 12, friction: 3 },
    stranger: { intimacy: 8, trust: 22, familiarity: 10, attachment: 4, friction: 1 },
    unlisted: { intimacy: 5, trust: 18, familiarity: 8, attachment: 3, friction: 1 },
};

const POSITIVE = /谢谢|辛苦了|做得好|好厉害|厉害|不错|对的|你说得对|我在呢|抱抱|抱一下|想你|爱你|喜欢你|亲亲|么么|贴贴/;
const REPAIR = /对不起|抱歉|是我不好|我错了|别生气|原谅我/;
const NEGATIVE = /不对|错了|太假|不像|烦死|生气|失望|别理我|算了|不想说|压力大|焦虑|难受|累死|好累/;
const QUESTION = /[?？]|怎么|为什么|咋|哪儿|哪里|谁|什么时候|要不要|是不是/;
const SHARING = /我今天|刚刚|刚才|我在|我去|我想|我有点|告诉你|给你看/;

function clamp(value: number): number { return Math.max(0, Math.min(100, value)); }
function round(value: number): number { return Math.round(clamp(value) * 10) / 10; }
function atOf(message: { time?: string }): number { return Date.parse(message.time ?? ''); }
function baseFor(tier: string | undefined): RelationshipValues {
    const base = BASE_RELATIONSHIP[tier ?? 'known'] ?? BASE_RELATIONSHIP.known!;
    return {
        intimacy: base.intimacy,
        trust: base.trust,
        familiarity: base.familiarity,
        attachment: base.attachment,
        friction: base.friction,
    };
}

type MessageLike = Pick<StoredMessage, 'role' | 'content'> & { time?: string };

function recentMessages(facts: HumanValueFacts, windowMs: number): readonly MessageLike[] {
    const now = facts.at.getTime();
    return facts.history.filter(message => {
        const at = atOf(message);
        return Number.isFinite(at) && at <= now && now - at <= windowMs;
    });
}

function talkDays(history: readonly (Pick<StoredMessage, 'role'> & { time?: string })[], now: number): number {
    const days = new Set<string>();
    for (const message of history) {
        if (message.role !== 'user') continue;
        const at = atOf(message);
        if (!Number.isFinite(at) || at > now || now - at > 30 * DAY) continue;
        const date = new Date(at);
        days.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
    }
    return days.size;
}

function relationshipAt(facts: HumanValueFacts): RelationshipValues {
    const base = baseFor(facts.tier);
    const recent = recentMessages(facts, 30 * DAY);
    const days = talkDays(recent, facts.at.getTime());
    const userMessages = recent.filter(message => message.role === 'user');
    const positive = userMessages.filter(message => POSITIVE.test(message.content)).length;
    const repairs = userMessages.filter(message => REPAIR.test(message.content)).length;
    const friction = userMessages.filter(message => NEGATIVE.test(message.content)).length;
    const sharing = userMessages.filter(message => SHARING.test(message.content)).length;
    const silenceHours = (() => {
        const last = userMessages.map(atOf).filter(Number.isFinite).reduce<number | undefined>(
            (latest, value) => latest === undefined || value > latest ? value : latest,
            undefined,
        );
        return last === undefined ? 72 : Math.max(0, (facts.at.getTime() - last) / HOUR);
    })();

    // 关系变化很慢：稳定聊天只把基线推高一点，短期冲突只增加摩擦，不会把一年多的关系清零。
    const closeness = days * 0.45 + Math.min(8, sharing * 0.35) + Math.min(7, positive * 0.7) + Math.min(5, repairs * 0.8);
    const recentSilence = Math.max(0, silenceHours - 48) * 0.08;
    const frictionNow = Math.min(25, friction * 1.5 + Math.max(0, silenceHours - 12) * 0.04);
    const intimacy = base.intimacy + closeness - Math.min(7, recentSilence) - frictionNow * 0.25;
    const trust = base.trust + Math.min(10, repairs * 1.4 + positive * 0.35) - Math.min(12, friction * 1.2 + recentSilence * 0.25);
    const familiarity = base.familiarity + Math.min(18, days * 0.6 + sharing * 0.15);
    const attachment = base.attachment + Math.min(12, positive * 0.45 + sharing * 0.2) + Math.max(0, 6 - silenceHours / 12) - Math.min(8, friction * 0.5);
    return {
        intimacy: round(intimacy),
        trust: round(trust),
        familiarity: round(familiarity),
        attachment: round(attachment),
        friction: round(base.friction + frictionNow),
    };
}

interface EventDelta {
    mood: number;
    health: number;
    loneliness: number;
    confidence: number;
    curiosity: number;
    boredom: number;
    motivation: number;
    socialBattery: number;
    selfEsteem: number;
    openness: number;
    satisfaction: number;
    comfort: number;
    frustration: number;
}

const EMPTY_DELTA: EventDelta = {
    mood: 0, health: 0, loneliness: 0, confidence: 0, curiosity: 0, boredom: 0,
    motivation: 0, socialBattery: 0, selfEsteem: 0, openness: 0, satisfaction: 0, comfort: 0, frustration: 0,
};

/** 行动结算对非身体需要的余波；每一条来自事件账，按时间衰减，不另存当前值。 */
function eventDelta(event: Pick<LifeEvent, 'kind' | 'meal' | 'result'>): { delta: EventDelta; halfLifeH: number } {
    const { kind, meal, result } = event;
    if (result === 'failed') return { delta: { ...EMPTY_DELTA, mood: -2, confidence: -1, boredom: 2, motivation: -3, selfEsteem: -2, satisfaction: -3, frustration: 5 }, halfLifeH: 8 };
    if (result === 'interrupted') return { delta: { ...EMPTY_DELTA, mood: -0.8, confidence: -0.4, boredom: 1, motivation: -1, satisfaction: -1, frustration: 3 }, halfLifeH: 6 };
    const mealBonus = meal && kind !== 'eat'
        ? { mood: 1, health: 0.3, boredom: -1, motivation: 0.5, satisfaction: 2, comfort: 4 }
        : EMPTY_DELTA;
    const withMeal = (delta: EventDelta): EventDelta => ({
        ...delta,
        mood: delta.mood + mealBonus.mood,
        health: delta.health + mealBonus.health,
        boredom: delta.boredom + mealBonus.boredom,
        motivation: delta.motivation + mealBonus.motivation,
        satisfaction: delta.satisfaction + mealBonus.satisfaction,
        comfort: delta.comfort + mealBonus.comfort,
    });
    switch (kind) {
        case 'sleep': return { delta: withMeal({ ...EMPTY_DELTA, mood: 3, health: 1.4, boredom: 1, motivation: 3, socialBattery: 8, satisfaction: 3, comfort: 6, frustration: -3 }), halfLifeH: 10 };
        case 'eat': return { delta: withMeal({ ...EMPTY_DELTA, mood: 2, health: 0.8, boredom: -1, motivation: 1, satisfaction: 3, comfort: 5, frustration: -1 }), halfLifeH: 6 };
        case 'rest': return { delta: withMeal({ ...EMPTY_DELTA, mood: 1.2, health: 0.4, boredom: 2, motivation: 2, socialBattery: 6, satisfaction: 1, comfort: 4, frustration: -2 }), halfLifeH: 8 };
        case 'meet':
        case 'interact_npc': return { delta: withMeal({ ...EMPTY_DELTA, mood: 3, loneliness: -18, confidence: 0.8, boredom: -12, socialBattery: -12, openness: 2, satisfaction: 3, motivation: 1 }), halfLifeH: 12 };
        case 'leisure': return { delta: withMeal({ ...EMPTY_DELTA, mood: 1, loneliness: -2, boredom: -14, socialBattery: -2, satisfaction: 2, motivation: 1 }), halfLifeH: 10 };
        case 'read_book': return { delta: withMeal({ ...EMPTY_DELTA, mood: 0.8, curiosity: 3, confidence: 0.4, boredom: -9, selfEsteem: 0.4, satisfaction: 2, motivation: 1 }), halfLifeH: 12 };
        case 'study': return { delta: withMeal({ ...EMPTY_DELTA, confidence: 2, curiosity: 2, boredom: -3, selfEsteem: 2, satisfaction: 3, motivation: 3, frustration: -1 }), halfLifeH: 14 };
        case 'work_on_project': return { delta: withMeal({ ...EMPTY_DELTA, confidence: 2.2, curiosity: 1, boredom: -5, selfEsteem: 2, satisfaction: 3, motivation: 3, frustration: -1 }), halfLifeH: 16 };
        case 'attend_class': return { delta: withMeal({ ...EMPTY_DELTA, confidence: 1, curiosity: 2, boredom: -2, selfEsteem: 0.5, satisfaction: 1, motivation: 1 }), halfLifeH: 14 };
        default: return { delta: EMPTY_DELTA, halfLifeH: 8 };
    }
}

function eventEffectsAt(events: readonly LifeEvent[], now: number): EventDelta {
    const total = { ...EMPTY_DELTA };
    for (const event of events) {
        const ended = Date.parse(event.endedAt);
        if (!Number.isFinite(ended) || ended > now || now - ended > 4 * DAY) continue;
        const { delta, halfLifeH } = eventDelta(event);
        const weight = Math.pow(0.5, Math.max(0, now - ended) / (halfLifeH * HOUR));
        for (const key of Object.keys(total) as (keyof EventDelta)[]) total[key] += delta[key] * weight;
    }
    return total;
}

function moodAt(facts: HumanValueFacts, recent: readonly MessageLike[]): number {
    const now = facts.at.getTime();
    let score = 52;
    for (const message of recent) {
        if (message.role !== 'user') continue;
        const age = Math.max(0, now - atOf(message));
        const weight = Math.pow(0.5, age / (8 * HOUR));
        if (POSITIVE.test(message.content)) score += 4 * weight;
        if (NEGATIVE.test(message.content)) score -= 4 * weight;
        if (REPAIR.test(message.content)) score += 3 * weight;
    }
    return round(score);
}

function latestAt(messages: readonly { role: 'user' | 'assistant'; time?: string }[], role?: 'user' | 'assistant'): number | undefined {
    const times = messages.filter(message => role === undefined || message.role === role).map(atOf).filter(Number.isFinite);
    return times.length ? Math.max(...times) : undefined;
}

export function humanValuesAt(facts: HumanValueFacts): HumanValues {
    const now = facts.at.getTime();
    if (!Number.isFinite(now)) throw new RangeError('真人式状态的时间不合法');
    const needs = facts.needs;
    // 事件账以 id 作为稳定幂等键。身体需要也按同一规则去重，避免一次行动因重试
    // 重复出现在输入中时，饥饿只结算一次、心理余波却叠加多次。
    const seenEventIds = new Set<string>();
    const events = (facts.events ?? []).filter(event => {
        if (seenEventIds.has(event.id)) return false;
        seenEventIds.add(event.id);
        return true;
    });
    const recent = recentMessages(facts, 72 * HOUR);
    const relationship = relationshipAt(facts);
    const eventEffects = eventEffectsAt(events, now);
    const lastUser = latestAt(facts.history, 'user');
    const lastActivity = Math.max(lastUser ?? 0, ...events.map(event => Date.parse(event.endedAt)).filter(Number.isFinite));
    const silenceHours = lastActivity > 0 ? Math.max(0, (now - lastActivity) / HOUR) : 72;
    const questions = recent.filter(message => message.role === 'user' && QUESTION.test(message.content)).length;
    const positive = recent.filter(message => message.role === 'user' && POSITIVE.test(message.content)).length;
    const negative = recent.filter(message => message.role === 'user' && NEGATIVE.test(message.content)).length;
    const eventCount = events.filter(event => {
        const at = Date.parse(event.endedAt);
        return Number.isFinite(at) && at <= now && now - at <= 24 * HOUR && event.result === 'succeeded';
    }).length;

    const health = round(93 - (100 - needs.energy) * 0.08 - needs.hunger * 0.05 - needs.stress * 0.07 + eventEffects.health);
    const loneliness = round(28 + Math.min(35, silenceHours * 1.1) - Math.min(16, relationship.familiarity * 0.08 + positive * 0.8) + eventEffects.loneliness);
    const confidence = round(55 + Math.min(15, positive * 1.4) - Math.min(20, negative * 1.8) - Math.min(8, needs.stress * 0.08) + eventEffects.confidence);
    const curiosity = round(45 + Math.min(28, questions * 1.8 + eventCount * 0.8) - Math.min(12, needs.energy < 25 ? (25 - needs.energy) * 0.4 : 0) + eventEffects.curiosity);
    const boredom = round(18 + Math.min(52, silenceHours * 0.9) - Math.min(25, eventCount * 3 + questions * 0.8) + eventEffects.boredom);
    const rawMood = moodAt(facts, recent) + eventEffects.mood;
    // 先算几个“中间层”：身体负荷和挫败会成为后面多个值的共同输入，形成可解释的联动。
    const comfort = round(62 + needs.energy * 0.1 + health * 0.18 - needs.hunger * 0.2 - needs.stress * 0.15 + eventEffects.comfort);
    const frustration = round(14 + needs.stress * 0.35 + needs.hunger * 0.12 + relationship.friction * 0.45 + negative * 1.2 + eventEffects.frustration);
    const mood = round(rawMood + (comfort - 60) * 0.12 - needs.stress * 0.06 - frustration * 0.04);
    const socialBattery = round(68 + needs.energy * 0.08 + health * 0.06 - needs.stress * 0.12 - Math.min(22, silenceHours * 0.05) + eventEffects.socialBattery);
    const satisfaction = round(46 + eventCount * 1.2 + positive * 0.6 - negative * 1.2 + (mood - 50) * 0.12 + (comfort - 60) * 0.1 + eventEffects.satisfaction);
    const motivation = round(48 + confidence * 0.16 + needs.energy * 0.14 + (mood - 50) * 0.16 + (comfort - 60) * 0.1 - needs.stress * 0.2 - needs.hunger * 0.1 - frustration * 0.08 + eventEffects.motivation);
    const selfEsteem = round(54 + confidence * 0.12 + relationship.trust * 0.08 + (satisfaction - 50) * 0.12 - frustration * 0.08 + eventEffects.selfEsteem - negative * 0.8);
    const openness = round(38 + relationship.intimacy * 0.35 + relationship.trust * 0.25 + (mood - 50) * 0.1 + (socialBattery - 50) * 0.08 - relationship.friction * 0.4 - needs.stress * 0.1 - frustration * 0.06 + eventEffects.openness);

    return {
        at: facts.at.toISOString(),
        energy: round(needs.energy), hunger: round(needs.hunger), stress: round(needs.stress),
        mood, health, loneliness, confidence, curiosity, boredom,
        motivation, socialBattery, selfEsteem, openness, satisfaction, comfort, frustration,
        relationship,
    };
}

/** 只用于日志 / 审计的单行摘要；不含聊天原文。 */
export function describeHumanValues(values: HumanValues): string {
    const r = values.relationship;
    return `数值：精力 ${values.energy}、饥饿 ${values.hunger}、压力 ${values.stress}、心情 ${values.mood}、健康 ${values.health}、孤独 ${values.loneliness}、信心 ${values.confidence}、好奇 ${values.curiosity}、无聊 ${values.boredom}、动机 ${values.motivation}、社交电量 ${values.socialBattery}、自尊 ${values.selfEsteem}、开放 ${values.openness}、满足 ${values.satisfaction}、舒适 ${values.comfort}、挫败 ${values.frustration}；关系（亲密 ${r.intimacy}、信任 ${r.trust}、熟悉 ${r.familiarity}、依恋 ${r.attachment}、摩擦 ${r.friction}）`;
}

/** 给模型看的自然语言底色；不暴露原始分数，也不要求她解释自己的状态。 */
export function describeHumanState(values: HumanValues, tier?: string): string | undefined {
    const body: string[] = [];
    if (values.energy <= 25) body.push('有点累，没什么劲');
    else if (values.energy <= 42) body.push('精神一般');
    if (values.hunger >= 80) body.push('肚子明显饿了');
    else if (values.hunger >= 65) body.push('有点饿');
    if (values.stress >= 80) body.push('压力压得有点紧');
    else if (values.stress >= 65) body.push('手头有点事压着');
    if (values.health <= 55) body.push('身体状态不太好');
    if (values.comfort <= 35) body.push('整个人不太舒服');

    const mind: string[] = [];
    if (values.mood >= 72) mind.push('心情挺好');
    else if (values.mood <= 32) mind.push('心情偏低');
    if (values.loneliness >= 70) mind.push('有点想找人说说话');
    if (values.boredom >= 72) mind.push('有点闷，想找点事做');
    if (values.curiosity >= 72) mind.push('对新东西有兴趣');
    if (values.motivation <= 30) mind.push('不太想动');
    else if (values.motivation >= 75) mind.push('做事有点劲头');
    if (values.socialBattery <= 25) mind.push('社交电量有点低');
    if (values.selfEsteem <= 35) mind.push('心里有点没底');
    if (values.frustration >= 72) mind.push('有点憋着火');

    const relationship = tier === 'boyfriend'
        ? values.relationship.intimacy >= 75 && values.relationship.trust >= 65 ? '跟他很亲近，信任是稳的'
            : values.relationship.friction >= 35 ? '跟他最近有点别扭，但不是要翻旧账'
                : undefined
        : undefined;
    const parts = [...body, ...mind, ...(relationship ? [relationship] : [])];
    return parts.length
        ? `[这一刻的底色：${parts.join('；')}。这是自然状态，不用解释或汇报；接着眼前的话说，别为了表现状态硬加戏]`
        : undefined;
}
