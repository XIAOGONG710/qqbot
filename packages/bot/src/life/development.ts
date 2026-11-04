// 人格与生活深化（ADR 0251）。
//
// 这一层不保存第二套“人格状态”。长期人生线、自主选择、关系阶段、情绪惯性、
// 审美、共同经历与反思都从已经存在的聊天、生活事件账和真人式状态重算。
// 因此重启、回放与 DSH/QQ 两端会得到同一结论，也不会把模型临时说的话写成事实。

import type { HumanValues } from '../human-values.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { LifeEvent } from '../world/life-events.ts';

const DAY = 86_400_000;
const clamp = (value: number) => Math.max(0, Math.min(100, Math.round(value)));
const atOf = (value: string | undefined) => value ? Date.parse(value) : Number.NaN;

export type LifeArcId = 'study' | 'photography' | 'relationships' | 'self-care' | 'creative';
export interface LifeArc {
    id: LifeArcId;
    progress: number;
    evidence: number;
    state: 'active' | 'steady' | 'stalled';
    momentum: 'growing' | 'holding' | 'cooling';
    lastAt?: string;
}

export type AutonomyMode = 'recover' | 'focus' | 'explore' | 'connect' | 'maintain';
export interface AutonomyDecision {
    mode: AutonomyMode;
    /** 只保留原因类别，不保留聊天原文。 */
    reason: 'body' | 'pressure' | 'curiosity' | 'loneliness' | 'balance';
    mayChangePlan: boolean;
    horizon: 'now' | 'today';
}

export type RelationshipStage = 'guarded' | 'warming' | 'secure' | 'strained' | 'repairing';
export interface RelationshipDevelopment {
    stage: RelationshipStage;
    security: number;
    closenessNeed: number;
    repairReadiness: number;
    pace: 'cautious' | 'open' | 'repair';
}

export interface EmotionContinuity {
    tone: 'bright' | 'steady' | 'low' | 'tense' | 'recovering';
    inertia: 'rising' | 'stable' | 'falling';
    source: 'body' | 'life' | 'relationship' | 'mixed';
    carry: 'short' | 'medium' | 'long';
}

export interface ShareCandidate {
    sourceEventId: string;
    eventKind: string;
    occurredAt: string;
    expiresAt: string;
    readiness: 'hold' | 'draft' | 'share';
    reason: 'too-tired' | 'too-private' | 'worth-sharing' | 'ordinary';
}

export interface TasteSignal {
    theme: 'photography' | 'music' | 'books' | 'games' | 'food' | 'style';
    leaning: 'like' | 'dislike' | 'curious';
    evidence: number;
    confidence: 'emerging' | 'stable' | 'strong';
    updatedAt?: string;
}

export interface CreativeDraftIntent {
    kind: 'journal' | 'photo' | 'voice' | 'status';
    sourceEventId: string;
    reason: 'reflect' | 'record-life' | 'milestone' | 'share';
    expiresAt: string;
    requiresReview: true;
}

export interface SharedExperience {
    kind: 'anniversary' | 'promise' | 'plan' | 'inside-joke';
    evidence: number;
    mutual: true;
    lastAt?: string;
}

export interface ReflectionLesson {
    kind: 'pace' | 'retry' | 'rest' | 'repair' | 'ask-for-help';
    evidence: number;
    sourceEventIds: string[];
}

export interface DevelopmentSnapshot {
    at: string;
    lifeArcs: LifeArc[];
    autonomy: AutonomyDecision;
    relationship: RelationshipDevelopment;
    emotion: EmotionContinuity;
    share?: ShareCandidate;
    tastes: TasteSignal[];
    creativeDrafts: CreativeDraftIntent[];
    sharedExperiences: SharedExperience[];
    reflections: ReflectionLesson[];
}

export interface DevelopmentSummary {
    activeLifeArcs: number;
    steadyLifeArcs: number;
    stalledLifeArcs: number;
    autonomyMode: AutonomyMode;
    relationshipStage: RelationshipStage;
    emotionTone: EmotionContinuity['tone'];
    shareReady: boolean;
    shareState: 'none' | ShareCandidate['readiness'];
    tasteThemes: number;
    creativeDrafts: number;
    sharedExperienceKinds: number;
    reflectionLessons: number;
    lifeArcStates: Array<Pick<LifeArc, 'id' | 'state' | 'momentum'>>;
    tasteSignals: Array<Pick<TasteSignal, 'theme' | 'leaning' | 'confidence'>>;
    creativeDraftKinds: CreativeDraftIntent['kind'][];
    sharedExperienceTypes: SharedExperience['kind'][];
    reflectionKinds: ReflectionLesson['kind'][];
}

export interface DevelopmentFacts {
    at: Date;
    values: HumanValues;
    history: readonly (Pick<StoredMessage, 'role' | 'content'> & { time?: string })[];
    events: readonly LifeEvent[];
}

const ARC_KINDS: Record<LifeArcId, RegExp> = {
    study: /study|class|homework|quiz|exam|assignment|project_choice|写作业|上课|小测|考试/i,
    photography: /photo|camera|photography|拍照|修片|相机/i,
    relationships: /meet|chat|friend|roommate|npc|见面|聊天|同学|室友/i,
    'self-care': /sleep|rest|meal|eat|shower|walk|exercise|睡觉|休息|吃饭|洗澡|散步|运动/i,
    creative: /read|write|draw|create|journal|video|阅读|写日记|创作|剪辑/i,
};

function recentEvents(events: readonly LifeEvent[], now: number, days: number): LifeEvent[] {
    return events.filter(event => {
        const at = atOf(event.endedAt);
        return Number.isFinite(at) && at <= now && now - at <= days * DAY;
    });
}

export function lifeArcs(events: readonly LifeEvent[], at: Date): LifeArc[] {
    const now = at.getTime();
    const within90 = recentEvents(events, now, 90);
    return (Object.entries(ARC_KINDS) as [LifeArcId, RegExp][]).flatMap(([id, pattern]) => {
        const matching = within90.filter(event => pattern.test(`${event.kind} ${event.subject ?? ''}`));
        if (!matching.length) return [];
        const succeeded = matching.filter(event => event.result === 'succeeded').length;
        const latest = matching.reduce((best, event) => atOf(event.endedAt) > atOf(best.endedAt) ? event : best);
        const age = now - atOf(latest.endedAt);
        const state = age <= 7 * DAY ? 'active' : age <= 30 * DAY ? 'steady' : 'stalled';
        const current = matching.filter(event => now - atOf(event.endedAt) <= 14 * DAY).length;
        const previous = matching.filter(event => {
            const eventAge = now - atOf(event.endedAt);
            return eventAge > 14 * DAY && eventAge <= 28 * DAY;
        }).length;
        const momentum = state === 'stalled' || current < previous ? 'cooling' : current > previous ? 'growing' : 'holding';
        return [{ id, progress: clamp(succeeded * 8 + matching.length * 2), evidence: matching.length, state, momentum, lastAt: latest.endedAt }];
    });
}

export function autonomyDecision(values: HumanValues): AutonomyDecision {
    if (values.energy < 30 || values.health < 55 || values.comfort < 35) return { mode: 'recover', reason: 'body', mayChangePlan: true, horizon: 'now' };
    if (values.stress > 70 || values.frustration > 65) return { mode: 'focus', reason: 'pressure', mayChangePlan: true, horizon: 'now' };
    if (values.loneliness > 68 && values.socialBattery > 35) return { mode: 'connect', reason: 'loneliness', mayChangePlan: true, horizon: 'today' };
    if (values.curiosity > 68 && values.motivation > 52) return { mode: 'explore', reason: 'curiosity', mayChangePlan: false, horizon: 'today' };
    return { mode: 'maintain', reason: 'balance', mayChangePlan: false, horizon: 'today' };
}

const REPAIR = /对不起|抱歉|我错了|别生气|和好|原谅/;
const WARM = /谢谢|抱抱|想你|爱你|喜欢你|辛苦了|我在/;

export function relationshipDevelopment(values: HumanValues, history: DevelopmentFacts['history']): RelationshipDevelopment {
    const recent = history.slice(-24);
    const repairs = recent.filter(message => message.role === 'user' && REPAIR.test(message.content)).length;
    const warm = recent.filter(message => message.role === 'user' && WARM.test(message.content)).length;
    const relation = values.relationship;
    const security = clamp(relation.trust * 0.46 + relation.intimacy * 0.34 + relation.familiarity * 0.2 - relation.friction * 0.55);
    const repairReadiness = clamp((100 - relation.friction) * 0.42 + relation.trust * 0.34 + repairs * 12 + warm * 3);
    const stage: RelationshipStage = relation.friction >= 35
        ? repairs > 0 || repairReadiness >= 65 ? 'repairing' : 'strained'
        : relation.intimacy >= 75 && relation.trust >= 65 ? 'secure'
            : relation.familiarity >= 45 ? 'warming' : 'guarded';
    const pace = stage === 'repairing' ? 'repair' : stage === 'guarded' || stage === 'strained' ? 'cautious' : 'open';
    return { stage, security, closenessNeed: clamp(relation.attachment + values.loneliness * 0.2 - values.socialBattery * 0.08), repairReadiness, pace };
}

export function emotionContinuity(values: HumanValues, relation: RelationshipDevelopment, history: DevelopmentFacts['history']): EmotionContinuity {
    const recent = history.slice(-12);
    const positive = recent.filter(message => WARM.test(message.content)).length;
    const negative = recent.filter(message => /难受|压力|生气|烦|失望|累|吵架/.test(message.content)).length;
    const inertia = positive > negative + 1 ? 'rising' : negative > positive + 1 ? 'falling' : 'stable';
    if (relation.stage === 'repairing') return { tone: 'recovering', inertia, source: 'relationship', carry: 'long' };
    if (values.stress >= 70 || values.frustration >= 68) return { tone: 'tense', inertia, source: values.energy < 35 ? 'mixed' : 'life', carry: 'long' };
    if (values.mood <= 35) return { tone: 'low', inertia, source: values.energy < 40 ? 'body' : 'mixed', carry: 'medium' };
    if (values.mood >= 70 && values.satisfaction >= 55) return { tone: 'bright', inertia, source: 'life', carry: 'short' };
    return { tone: 'steady', inertia, source: values.energy < 35 ? 'body' : 'mixed', carry: 'medium' };
}

const PRIVATE_EVENT = /crisis|medical|money|receive_money|conflict|private/i;
const MEANINGFUL_EVENT = /photo|camera|project|read|write|meet|quiz|exam|finish|first|拍照|修片|读|写|见面|考试|完成/i;

export function proactiveShare(events: readonly LifeEvent[], values: HumanValues, at: Date): ShareCandidate | undefined {
    const candidate = recentEvents(events, at.getTime(), 1)
        .filter(event => event.result === 'succeeded' && !event.seen)
        .sort((a, b) => atOf(b.endedAt) - atOf(a.endedAt))[0];
    if (!candidate) return undefined;
    const base = {
        sourceEventId: candidate.id,
        eventKind: candidate.kind,
        occurredAt: candidate.endedAt,
        expiresAt: new Date(atOf(candidate.endedAt) + DAY).toISOString(),
    };
    if (PRIVATE_EVENT.test(candidate.kind)) return { ...base, readiness: 'hold', reason: 'too-private' };
    if (values.energy < 25 || values.socialBattery < 20) return { ...base, readiness: 'hold', reason: 'too-tired' };
    return MEANINGFUL_EVENT.test(`${candidate.kind} ${candidate.subject ?? ''}`)
        ? { ...base, readiness: 'share', reason: 'worth-sharing' }
        : { ...base, readiness: 'draft', reason: 'ordinary' };
}

const TASTE_THEMES: Record<TasteSignal['theme'], RegExp> = {
    photography: /照片|拍照|相机|镜头|构图|光影/,
    music: /音乐|歌|专辑|旋律|演唱会/,
    books: /书|小说|漫画|阅读|作者/,
    games: /游戏|王者|空洞骑士|主机|steam/i,
    food: /吃|菜|饭|奶茶|火锅|麻辣烫|香菜/,
    style: /穿搭|衣服|颜色|发型|审美|好看/,
};
const LIKE = /喜欢|挺好|好看|好听|好玩|爱吃|想试|有意思|想拍/;
const DISLIKE = /不喜欢|不好看|难听|不好玩|不爱吃|讨厌|不想碰/;
const CURIOUS = /想看看|想试试|没接触过|有点好奇/;

export function tasteProfile(history: DevelopmentFacts['history']): TasteSignal[] {
    const assistant = history.filter(message => message.role === 'assistant').slice(-120);
    return (Object.entries(TASTE_THEMES) as [TasteSignal['theme'], RegExp][]).flatMap(([theme, pattern]) => {
        const signals: Array<{ leaning: TasteSignal['leaning']; weight: number; time?: string }> = assistant.flatMap((message, index) => {
            if (!pattern.test(message.content)) return [];
            const leaning: TasteSignal['leaning'] | undefined = DISLIKE.test(message.content) ? 'dislike' : CURIOUS.test(message.content) ? 'curious' : LIKE.test(message.content) ? 'like' : undefined;
            if (!leaning) return [];
            // 越靠近现在权重越高，让后续反复形成的新看法能逐步修正早期偏好。
            return [{ leaning, weight: 0.5 + 0.5 * ((index + 1) / Math.max(assistant.length, 1)), time: message.time }];
        });
        const evidence = signals.length;
        // 一次随口说的不算稳定偏好；至少两次独立表达，之后的新证据可以改变方向。
        if (evidence < 2) return [];
        const scores = { like: 0, dislike: 0, curious: 0 };
        for (const signal of signals) scores[signal.leaning] += signal.weight;
        const ranked = (Object.entries(scores) as [TasteSignal['leaning'], number][]).sort((a, b) => b[1] - a[1]);
        const leaning = ranked[0]![0];
        const margin = ranked[0]![1] - ranked[1]![1];
        const confidence = evidence >= 6 && margin >= 1.5 ? 'strong' : evidence >= 3 && margin >= 0.6 ? 'stable' : 'emerging';
        const latest = [...signals].reverse().find(signal => Number.isFinite(atOf(signal.time)));
        return [{ theme, leaning, evidence, confidence, ...(latest?.time ? { updatedAt: latest.time } : {}) }];
    });
}

export function creativeDraftIntents(events: readonly LifeEvent[], share: ShareCandidate | undefined, at: Date): CreativeDraftIntent[] {
    const recent = recentEvents(events, at.getTime(), 3).filter(event => event.result === 'succeeded');
    const output: CreativeDraftIntent[] = [];
    for (const event of recent.slice(-12).reverse()) {
        const text = `${event.kind} ${event.subject ?? ''}`;
        const kinds: Array<[CreativeDraftIntent['kind'], CreativeDraftIntent['reason']]> = [];
        if (/photo|camera|拍照|修片/i.test(text)) kinds.push(['photo', 'record-life']);
        if (MEANINGFUL_EVENT.test(text)) kinds.push(['journal', 'reflect']);
        if (share?.sourceEventId === event.id && share.readiness === 'share') kinds.push(['status', 'share']);
        if (/first|finish|meet|第一次|完成|见面/i.test(text)) kinds.push(['voice', 'milestone']);
        const expiresAt = new Date(atOf(event.endedAt) + 3 * DAY).toISOString();
        for (const [kind, reason] of kinds) if (!output.some(item => item.kind === kind)) output.push({ kind, sourceEventId: event.id, reason, expiresAt, requiresReview: true });
        if (output.length >= 4) break;
    }
    return output;
}

const SHARED_PATTERNS: Record<SharedExperience['kind'], RegExp> = {
    anniversary: /纪念日|周年|生日/,
    promise: /答应|说好|约好|承诺/,
    plan: /一起|下次|以后我们|到时候/,
    'inside-joke': /这个梗|老梗|又来了|只有我们|还记得.*笑/,
};

export function sharedExperiences(history: DevelopmentFacts['history']): SharedExperience[] {
    return (Object.entries(SHARED_PATTERNS) as [SharedExperience['kind'], RegExp][]).flatMap(([kind, pattern]) => {
        const anchors = history.map((message, index) => ({ message, index })).filter(item => pattern.test(item.message.content));
        const mutual = anchors.filter(anchor => history.some((other, index) => {
            if (other.role === anchor.message.role || Math.abs(index - anchor.index) > 2) return false;
            return pattern.test(other.content) || /好啊|好呀|可以|行啊|记得|当然|说好|答应|一起|到时候|下次|又来了|哈哈/.test(other.content);
        }));
        if (!mutual.length) return [];
        const latest = [...mutual].reverse().map(item => item.message).find(message => Number.isFinite(atOf(message.time)));
        return [{ kind, evidence: mutual.length, mutual: true, ...(latest?.time ? { lastAt: latest.time } : {}) }];
    });
}

export function reflectionLessons(events: readonly LifeEvent[], relation: RelationshipDevelopment, values: HumanValues): ReflectionLesson[] {
    const ordered = [...events].filter(event => Number.isFinite(atOf(event.endedAt))).sort((a, b) => atOf(a.endedAt) - atOf(b.endedAt));
    const lessons = new Map<ReflectionLesson['kind'], { evidence: number; sourceEventIds: string[] }>();
    const add = (kind: ReflectionLesson['kind'], sourceEventId?: string) => {
        const current = lessons.get(kind) ?? { evidence: 0, sourceEventIds: [] };
        current.evidence++;
        if (sourceEventId && !current.sourceEventIds.includes(sourceEventId)) current.sourceEventIds.push(sourceEventId);
        lessons.set(kind, current);
    };
    for (const [index, event] of ordered.entries()) {
        if (event.result === 'interrupted') add('pace', event.id);
        if (event.result === 'failed') {
            const recovered = ordered.slice(index + 1).some(next => next.kind === event.kind && next.result === 'succeeded');
            add(recovered ? 'retry' : 'ask-for-help', event.id);
        }
    }
    if (values.energy < 30 || values.health < 55) add('rest');
    if (relation.stage === 'repairing') add('repair');
    return [...lessons].map(([kind, lesson]) => ({ kind, ...lesson })).sort((a, b) => b.evidence - a.evidence).slice(0, 4);
}

export function developmentSnapshot(facts: DevelopmentFacts): DevelopmentSnapshot {
    if (!Number.isFinite(facts.at.getTime())) throw new Error('人格成长快照时间不合法');
    const relationship = relationshipDevelopment(facts.values, facts.history);
    const share = proactiveShare(facts.events, facts.values, facts.at);
    return {
        at: facts.at.toISOString(),
        lifeArcs: lifeArcs(facts.events, facts.at),
        autonomy: autonomyDecision(facts.values),
        relationship,
        emotion: emotionContinuity(facts.values, relationship, facts.history),
        ...(share ? { share } : {}),
        tastes: tasteProfile(facts.history),
        creativeDrafts: creativeDraftIntents(facts.events, share, facts.at),
        sharedExperiences: sharedExperiences(facts.history),
        reflections: reflectionLessons(facts.events, relationship, facts.values),
    };
}

export function developmentSummary(snapshot: DevelopmentSnapshot): DevelopmentSummary {
    return {
        activeLifeArcs: snapshot.lifeArcs.filter(arc => arc.state === 'active').length,
        steadyLifeArcs: snapshot.lifeArcs.filter(arc => arc.state === 'steady').length,
        stalledLifeArcs: snapshot.lifeArcs.filter(arc => arc.state === 'stalled').length,
        autonomyMode: snapshot.autonomy.mode,
        relationshipStage: snapshot.relationship.stage,
        emotionTone: snapshot.emotion.tone,
        shareReady: snapshot.share?.readiness === 'share',
        shareState: snapshot.share?.readiness ?? 'none',
        tasteThemes: snapshot.tastes.length,
        creativeDrafts: snapshot.creativeDrafts.length,
        sharedExperienceKinds: snapshot.sharedExperiences.length,
        reflectionLessons: snapshot.reflections.length,
        lifeArcStates: snapshot.lifeArcs.map(({ id, state, momentum }) => ({ id, state, momentum })),
        tasteSignals: snapshot.tastes.map(({ theme, leaning, confidence }) => ({ theme, leaning, confidence })),
        creativeDraftKinds: snapshot.creativeDrafts.map(draft => draft.kind),
        sharedExperienceTypes: snapshot.sharedExperiences.map(item => item.kind),
        reflectionKinds: snapshot.reflections.map(item => item.kind),
    };
}

/** 给模型的只是一小段行为底色，不给分数、不列账，也不要求主动说出来。 */
export function describeDevelopment(snapshot: DevelopmentSnapshot): string | undefined {
    const parts: string[] = [];
    const active = snapshot.lifeArcs.filter(arc => arc.state === 'active').map(arc => ({
        study: '学业', photography: '摄影', relationships: '身边的人', 'self-care': '照顾自己', creative: '创作',
    }[arc.id]));
    if (active.length) parts.push(`最近持续在推进${active.slice(0, 2).join('和')}`);
    const modes: Record<AutonomyMode, string> = {
        recover: '这会儿更适合先恢复状态，可以改掉不重要的安排',
        focus: '这会儿更想把手头最要紧的一件事处理完',
        explore: '这会儿对新东西有兴趣，但不用为了新鲜硬换话题',
        connect: '这会儿愿意靠近一点，但不是必须找话说',
        maintain: '这会儿按原来的节奏过就好',
    };
    parts.push(modes[snapshot.autonomy.mode]);
    if (snapshot.relationship.stage === 'repairing') parts.push('你们正在从一次别扭里往回走，别瞬间当作什么都没发生');
    else if (snapshot.relationship.stage === 'strained') parts.push('你们之间还有点别扭，既不用翻旧账，也不用强装亲密');
    else if (snapshot.relationship.stage === 'secure') parts.push('你们的关系很稳，可以自然亲近，不用反复确认');
    if (snapshot.emotion.tone === 'recovering') parts.push('情绪在慢慢松下来，不是一下子清零');
    else if (snapshot.emotion.tone === 'tense') parts.push('心里还有点绷，做不到和平时完全一样也正常');
    if (snapshot.share?.readiness === 'share') parts.push('最近有一件真实发生的小事值得分享；只有接得上当前话题或主动时机才提');
    if (snapshot.reflections.length) parts.push('之前的结果会影响这次选择；可以改变做法，不用宣布自己成长了');
    return parts.length ? `[你最近形成的生活脉络：${parts.join('；')}。这些是行为依据，不是汇报提纲；没被问到就别逐条说。]` : undefined;
}

/** 纯结构自检；不读取或输出聊天原文。 */
export function auditDevelopment(snapshot: DevelopmentSnapshot, events: readonly LifeEvent[]): string[] {
    const problems: string[] = [];
    if (snapshot.lifeArcs.some(arc => arc.evidence < 1 || arc.progress < 0 || arc.progress > 100)) problems.push('人生线证据或进度不合法');
    const ids = new Set(events.map(event => event.id));
    if (snapshot.creativeDrafts.some(draft => !ids.has(draft.sourceEventId))) problems.push('创作草稿没有真实事件来源');
    if (snapshot.creativeDrafts.some(draft => !Number.isFinite(atOf(draft.expiresAt)) || atOf(draft.expiresAt) < atOf(snapshot.at))) problems.push('创作草稿已过期或期限不合法');
    if (snapshot.tastes.some(taste => taste.evidence < 2)) problems.push('审美偏好没有足够证据');
    if (snapshot.sharedExperiences.some(item => item.evidence < 1 || item.mutual !== true)) problems.push('共同经历没有双方证据');
    if (snapshot.reflections.some(item => item.sourceEventIds.some(id => !ids.has(id)))) problems.push('反思引用了不存在的事件');
    if (snapshot.share && !events.some(event => event.id === snapshot.share!.sourceEventId && event.kind === snapshot.share!.eventKind && event.result === 'succeeded')) problems.push('主动分享没有成功事件来源');
    if (snapshot.share && (atOf(snapshot.share.expiresAt) <= atOf(snapshot.share.occurredAt) || atOf(snapshot.share.expiresAt) < atOf(snapshot.at))) problems.push('主动分享期限不合法');
    return problems;
}
