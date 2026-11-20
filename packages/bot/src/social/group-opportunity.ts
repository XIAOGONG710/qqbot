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

/** 动机是否放行：eligible 且（没给分数，或分数够高）。抽签不参与。 */
export function motiveAllows(decision: GroupMotiveDecision | undefined): boolean {
    return Boolean(decision?.eligible && (decision.score === undefined || decision.score >= GROUP_MOTIVE.minScore));
}

const none = (reason: string): GroupMotiveDecision => ({ eligible: false, blocks: [], reason });

/**
 * 从影子的表达机会账里取分数最高的那一条可表达机会，连同裁决分数一起交回去；
 * 没有账、没有可用机会、读取出错都按「不说」，绝不在出错时退回去抽签。
 */
export function groupOpportunity(at: Date, shadow: AgencyShadow | undefined): GroupMotiveDecision {
    if (!Number.isFinite(at.getTime()) || !shadow) return none('没有影子账或时间无效，先潜水');
    try {
        const scores = new Map(shadow.decisions.decisions().map(decision => [decision.driveId, decision.score]));
        const candidates = (shadow.opportunities.opportunities() ?? [])
            .filter(opportunity => opportunity.eligible)
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
