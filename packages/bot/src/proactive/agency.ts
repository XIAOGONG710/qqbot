// 动机优先的活动选择层。时钟只能提供检查机会，不能凭“到点了”制造想说话的动机。

import { expressionOpportunity, type ExpressionOpportunity } from '../life/expression-opportunity.ts';
import { internalDrivesAt, type Drive, type ShadowActivityCandidate, type ShadowActivityKind } from '../life/motivation.ts';
import { resolveShadowDrives, type ShadowDriveDecision } from '../life/motivation-resolution.ts';
import type { RegulationSnapshot } from '../life/regulation.ts';
import type { InnerThought } from './inner.ts';
import type { Candidate } from './proactive.ts';

export interface ProactiveAgencyResult {
    eligible: boolean;
    reason: string;
    drive?: Drive;
    decision?: ShadowDriveDecision;
    opportunity?: ExpressionOpportunity;
    /** 当前真正选择的活动；只有 message 才能继续进入主动表达管线。 */
    activity?: ShadowActivityCandidate;
    /** 这条动机下可采取的低风险选项，不表示全部都会执行。 */
    options?: readonly ShadowActivityKind[];
}
export interface ProactiveAgencyContext { unansweredCount?: number }

/** 这些全是旧时机，没有独立事实或她明确留下的念头，不能再自行制造动机。 */
const CLOCK_ONLY = new Set<Candidate['occasion']>(['morning', 'after_class', 'quiet', 'bedtime', 'reach', 'share', 'ask', 'invite']);
const choiceId = (drive: Drive, kind: ShadowActivityKind) => `${drive.id}:activity:${kind}`;
const activity = (drive: Drive, kind: ShadowActivityKind, at: Date, reason: string): ShadowActivityCandidate => ({
    id: choiceId(drive, kind), driveId: drive.id, kind, createdAt: at.toISOString(), reason,
});

interface DriveSeed {
    source: Drive['source'];
    goal: string;
    origin: string;
    strength: number;
    urgency: number;
    persistence: number;
}

/** 从信号背后的事实取来源；不再用 occasion 本身充当来源。 */
function seedFor(signal: Candidate): DriveSeed | undefined {
    if (CLOCK_ONLY.has(signal.occasion)) return undefined;
    if (signal.occasion === 'inner' && signal.inner) return { source: 'internal', goal: '处理自己想说的念头', origin: `inner.${signal.inner.id}`, strength: 0.85, urgency: 0.55, persistence: 0.8 };
    if (signal.occasion === 'news' && signal.news?.kind === 'unwell') return { source: 'internal', goal: '照顾身体不适并决定是否告诉他', origin: 'regulation.discomfort', strength: 0.9, urgency: 0.7, persistence: 0.75 };
    if (signal.occasion === 'reschedule' && signal.reschedule) return { source: 'external', goal: '处理已经答应但需要改约的事', origin: `promise.${signal.reschedule.id}`, strength: 1, urgency: 0.95, persistence: 0.9 };
    if (signal.occasion === 'news' && signal.news) return { source: 'external', goal: '处理已经发生的生活事件', origin: `life.${signal.news.id}`, strength: 0.78, urgency: 0.45, persistence: 0.65 };
    if (signal.occasion === 'follow_up' && signal.followUp) return { source: 'external', goal: '记得自己答应跟进的事', origin: `follow-up.${signal.followUp.item.id}`, strength: 0.7, urgency: 0.55, persistence: 0.7 };
    if (signal.occasion === 'weather') return { source: 'external', goal: '留意已经核实的当前天气', origin: `weather.${signal.day}`, strength: 0.82, urgency: 0.7, persistence: 0.55 };
    if (signal.occasion === 'dates') return { source: 'external', goal: '记得对两人有意义的日子', origin: `date.${signal.id}`, strength: 0.9, urgency: 0.8, persistence: 0.8 };
    if (signal.occasion === 'back') return { source: 'external', goal: '兑现自己说过会回来的承诺', origin: `promise.${signal.id}`, strength: 0.82, urgency: 0.7, persistence: 0.85 };
    return undefined;
}

function driveFor(signal: Candidate, at: Date): Drive | undefined {
    const seed = seedFor(signal);
    if (!seed) return undefined;
    return {
        id: signal.occasion === 'inner' && signal.inner ? `drive:inner:${signal.inner.id}` : `drive:proactive:${signal.id}`,
        source: seed.source, goal: seed.goal, target: 'self',
        ...(seed.source === 'internal' ? { stateKeys: [seed.origin] } : { eventIds: [seed.origin] }),
        strength: seed.strength, urgency: seed.urgency, persistence: seed.persistence, createdAt: at.toISOString(), status: 'active',
    };
}

function optionsFor(signal: Candidate): readonly ShadowActivityKind[] {
    if (signal.occasion === 'news' && signal.news?.kind === 'unwell') return ['self_care', 'remember', 'message', 'wait'];
    if (signal.occasion === 'reschedule') return ['adjust_schedule', 'remember', 'message', 'wait'];
    if (signal.occasion === 'weather') return ['observe', 'remember', 'message', 'wait'];
    return ['remember', 'message', 'wait'];
}

/**
 * 信号先形成有来源的动机，再裁决活动。只有明确选中 message 才进入主动生成；生成器仍可输出“不发”。
 * 早晚钟点、下课、冷场和催回复没有独立动机时直接等待。
 */
export function proactiveAgency(signal: Candidate, regulation: RegulationSnapshot, at: Date, context: ProactiveAgencyContext = {}): ProactiveAgencyResult {
    if (!Number.isFinite(at.getTime())) return { eligible: false, reason: '主动性判断时间无效' };
    const urgent = signal.occasion === 'dates' || signal.occasion === 'reschedule' || signal.occasion === 'back';
    if ((context.unansweredCount ?? signal.reach?.count ?? 0) >= 1 && !urgent) return { eligible: false, reason: '已经主动过一次还没收到回复，先等' };
    const drive = driveFor(signal, at);
    if (!drive) return { eligible: false, reason: '只有固定时机，没有形成内驱或外驱' };
    const decision = resolveShadowDrives([...internalDrivesAt(regulation), drive], regulation, at).find(item => item.driveId === drive.id);
    if (!decision) return { eligible: false, reason: '动机没有形成可审计裁决', drive };
    const opportunity = expressionOpportunity(decision, drive, regulation, { commitmentDue: signal.occasion === 'reschedule' || signal.occasion === 'back' });
    const options = optionsFor(signal);
    let selected: ShadowActivityKind = 'message';
    let reason = '动机形成表达选项，交给她决定说或不说';
    if (decision.outcome === 'suppress') { selected = 'suppress'; reason = decision.reason; }
    else if (decision.outcome !== 'focus') { selected = 'wait'; reason = decision.reason; }
    else if (signal.occasion === 'news' && signal.news?.kind === 'unwell' && regulation.recoveryNeed >= 0.7) {
        selected = 'self_care'; reason = '身体恢复优先，她先照顾自己，不拿不舒服换关心';
    } else if (!opportunity.eligible) { selected = 'wait'; reason = opportunity.reason; }
    const chosen = activity(drive, selected, at, reason);
    return { eligible: selected === 'message' && opportunity.eligible, reason, drive, decision, opportunity, activity: chosen, options };
}

/** 内心已经由她明确选过一次：把“记着 / 查资料 / 调整安排 / 想联系他”直接记成活动，不再先伪装成消息时机。 */
export function activitiesFromInnerChoice(thought: InnerThought, at: Date, wants?: string, todo?: string): { drive: Drive; activities: ShadowActivityCandidate[] } | undefined {
    if (!Number.isFinite(at.getTime()) || !thought.id || !Number.isFinite(Date.parse(thought.at))) return undefined;
    const drive: Drive = {
        id: `drive:inner:${thought.id}`, source: 'internal', goal: '落实自己刚形成的念头', target: 'self', stateKeys: [`inner.${thought.id}`],
        strength: thought.goes === 'keep' && !wants && !todo ? 0.5 : 0.78, urgency: 0.35, persistence: 0.7, createdAt: at.toISOString(), status: 'active',
    };
    const choices: [ShadowActivityKind, string][] = [];
    if (wants) choices.push(['research', '她明确想弄明白一件事，只查公开资料']);
    if (todo) choices.push(['adjust_schedule', '她明确决定调整自己今天的安排']);
    if (thought.goes === 'tell' || thought.goes === 'ask') choices.push(['message', '她明确选择以后告诉他或问他']);
    if (!choices.length) choices.push(['remember', '她选择先放在心里，不推动外发']);
    return { drive, activities: choices.map(([kind, reason]) => activity(drive, kind, at, reason)) };
}
