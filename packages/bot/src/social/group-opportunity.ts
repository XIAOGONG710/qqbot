// 群自主（ADR 0343）：把已有的动机影子闭环投影成「此刻能不能在群里开口」。
// 只读影子账，不生成内容、不调用模型、不发送消息。异常一律按潜水处理。

import type { ExpressionBlock } from '../life/expression-opportunity.ts';
import type { AgencyShadow } from '../world/agency-shadow.ts';

/** 群里的开口决策：影子账里那一条表达机会的无内容投影 */
export interface GroupMotiveDecision {
    eligible: boolean;
    blocks: readonly ExpressionBlock[];
    reason: string;
    driveId?: string;
    score?: number;
}

/** 高强度才推到群开口；低于这条只是她心里的事（和影子裁决的 focus 门槛一致） */
export const GROUP_MOTIVE = { minScore: 0.2 } as const;

/**
 * 一次表达机会管多久（groupAgency A，用户 2026-11-22 选「加时间窗」，ADR 0343）：原来账里一条 eligible 写进去就永远放行，
 * 群里的「她想说话」成了卡住不动的开关。现在从那次裁决起一小时内有效；动机自己更早过期就到那时。
 * 窗口读的时候算（裁决账的 decidedAt、动机账的 expiresAt），账的格式不变，旧账也一样有窗口
 */
export const EXPRESSION_WINDOW_MS = 60 * 60_000;

/** 这次机会此刻还开着吗：decidedAt ≤ now < min(decidedAt + 窗口, 动机过期)；时间读不出来就算关着 */
export function opportunityOpen(decidedAt: string | undefined, expiresAt: string | undefined, now: number): boolean {
    const from = decidedAt === undefined ? Number.NaN : Date.parse(decidedAt);
    if (!Number.isFinite(from) || now < from) return false;
    const expires = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt);
    return now < Math.min(from + EXPRESSION_WINDOW_MS, Number.isFinite(expires) ? expires : Number.POSITIVE_INFINITY);
}

/** 动机是否放行：eligible 且（没给分数，或分数够高）。抽签不参与。 */
export function motiveAllows(decision: GroupMotiveDecision | undefined): boolean {
    return Boolean(decision?.eligible && (decision.score === undefined || decision.score >= GROUP_MOTIVE.minScore));
}

const none = (reason: string): GroupMotiveDecision => ({ eligible: false, blocks: [], reason });

/**
 * 从影子的表达机会账里取此刻还在时间窗里、分数最高的那一条可表达机会，连同裁决分数一起交回去；
 * 没有账、没有可用机会、读取出错都按「不说」，绝不在出错时退回去抽签。
 */
export function groupOpportunity(at: Date, shadow: AgencyShadow | undefined): GroupMotiveDecision {
    if (!Number.isFinite(at.getTime()) || !shadow) return none('没有影子账或时间无效，先潜水');
    try {
        const decided = new Map(shadow.decisions.decisions().map(decision => [decision.driveId, decision]));
        const scores = new Map([...decided].map(([driveId, decision]) => [driveId, decision.score]));
        const expires = new Map((shadow.motivations?.drives() ?? []).map(drive => [drive.id, drive.expiresAt]));
        const now = at.getTime();
        const candidates = (shadow.opportunities.opportunities() ?? [])
            // 只看此刻还在时间窗里的（groupAgency A）：过了窗口的、找不到裁决的都不算
            .filter(opportunity => opportunity.eligible && opportunityOpen(decided.get(opportunity.driveId)?.decidedAt, expires.get(opportunity.driveId), now))
            .map(opportunity => ({ opportunity, score: scores.get(opportunity.driveId) }))
            .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.opportunity.driveId.localeCompare(b.opportunity.driveId));
        const best = candidates[0];
        if (!best) return none('影子账里没有可交给群表达的机会');
        return {
            eligible: true,
            blocks: best.opportunity.blocks,
            reason: best.opportunity.reason,
            driveId: best.opportunity.driveId,
            ...(best.score === undefined ? {} : { score: best.score }),
        };
    } catch {
        return none('读影子账出错，按潜水处理');
    }
}
