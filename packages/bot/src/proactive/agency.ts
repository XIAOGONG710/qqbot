// 主动候选进入统一内外驱池的适配层。时钟只能提供检查机会，不能凭“到点了”制造想说话的动机。

import { expressionOpportunity, type ExpressionOpportunity } from '../life/expression-opportunity.ts';
import { internalDrivesAt, type Drive } from '../life/motivation.ts';
import { resolveShadowDrives, type ShadowDriveDecision } from '../life/motivation-resolution.ts';
import type { RegulationSnapshot } from '../life/regulation.ts';
import type { Candidate } from './proactive.ts';

export interface ProactiveAgencyResult {
    eligible: boolean;
    reason: string;
    drive?: Drive;
    decision?: ShadowDriveDecision;
    opportunity?: ExpressionOpportunity;
}
export interface ProactiveAgencyContext { unansweredCount?: number }

const CLOCK_ONLY = new Set<Candidate['occasion']>(['after_class', 'quiet', 'share', 'ask', 'invite']);
const INTERNAL = new Set<Candidate['occasion']>(['back', 'inner', 'reach', 'morning', 'bedtime']);
const WEIGHTS: Record<Candidate['occasion'], readonly [number, number, number]> = {
    dates: [0.9, 0.8, 0.8], back: [0.7, 0.55, 0.5], reschedule: [1, 0.95, 0.9], news: [0.78, 0.45, 0.65],
    follow_up: [0.7, 0.55, 0.7], weather: [0.82, 0.7, 0.55], inner: [0.85, 0.65, 0.8], reach: [0.6, 0.45, 0.5],
    morning: [0.58, 0.25, 0.7], bedtime: [0.76, 0.5, 0.75], after_class: [0, 0, 0], quiet: [0, 0, 0],
    invite: [0, 0, 0], ask: [0, 0, 0], share: [0, 0, 0],
};

function driveFor(candidate: Candidate, at: Date): Drive | undefined {
    if (CLOCK_ONLY.has(candidate.occasion)) return undefined;
    const bodilyNews = candidate.occasion === 'news' && candidate.news?.kind === 'unwell';
    const [strength, urgency, persistence] = bodilyNews ? [1, 0.9, 0.9] as const : WEIGHTS[candidate.occasion];
    const source = INTERNAL.has(candidate.occasion) || bodilyNews ? 'internal' as const : 'external' as const;
    const stateKeys = candidate.occasion === 'bedtime' ? ['regulation.recoveryNeed']
        : bodilyNews ? ['regulation.discomfort'] : [`proactive.${candidate.occasion}`];
    return {
        id: `drive:proactive:${candidate.id}`, source, goal: `自行判断是否表达：${candidate.occasion}`, target: 'self',
        ...(source === 'internal' ? { stateKeys } : { eventIds: [`proactive:${candidate.id}`] }),
        strength, urgency, persistence, createdAt: at.toISOString(), status: 'active',
    };
}

/** 通过也只代表可交给她决定，计划器还必须允许她输出“不发”。 */
export function proactiveAgency(candidate: Candidate, regulation: RegulationSnapshot, at: Date, context: ProactiveAgencyContext = {}): ProactiveAgencyResult {
    if (!Number.isFinite(at.getTime())) return { eligible: false, reason: '主动性判断时间无效' };
    const bodilyNews = candidate.occasion === 'news' && candidate.news?.kind === 'unwell';
    const urgent = bodilyNews || ['dates', 'reschedule', 'weather', 'bedtime'].includes(candidate.occasion);
    if ((context.unansweredCount ?? candidate.reach?.count ?? 0) >= 1 && !urgent) return { eligible: false, reason: '已经主动过一次还没收到回复，先等' };
    const drive = driveFor(candidate, at);
    if (!drive) return { eligible: false, reason: '只有固定时机，没有形成内驱或外驱' };
    const decision = resolveShadowDrives([...internalDrivesAt(regulation), drive], regulation, at).find(item => item.driveId === drive.id);
    if (!decision) return { eligible: false, reason: '动机没有形成可审计裁决', drive };
    const opportunity = expressionOpportunity(decision, drive, regulation);
    return {
        eligible: opportunity.eligible,
        reason: opportunity.eligible ? '内外驱裁决形成表达机会，仍由她决定说或不说' : decision.reason,
        drive, decision, opportunity,
    };
}
