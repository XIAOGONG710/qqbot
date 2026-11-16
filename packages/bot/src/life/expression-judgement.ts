// 她对“表达机会”的最后判断格式。模型只能选说、等、不说；内容仍由既有回复/主动消息管线生成。

import type { ExpressionOpportunity } from './expression-opportunity.ts';

export const EXPRESSION_CHOICES = ['speak', 'wait', 'decline'] as const;
export type ExpressionChoice = (typeof EXPRESSION_CHOICES)[number];
export interface ExpressionJudgement { choice: ExpressionChoice; reason?: string }

/** 只给她判断权，不给“必须开口”的指令，也不携带用户私事或记忆正文。 */
export function expressionJudgementPrompt(opportunity: ExpressionOpportunity): string | undefined {
    if (!opportunity.eligible) return undefined;
    return [
        '现在有一件你可以自行考虑是否表达的事。你没有义务开口，也不需要解释。',
        '只返回 JSON：{"choice":"speak"|"wait"|"decline","reason":"可选的短理由"}。',
        'speak 只表示愿意交给既有主动消息管线继续判断；wait 和 decline 都是完全正常的选择。',
        `机会来源：${opportunity.reason}。`,
    ].join('\n');
}

export function parseExpressionJudgement(value: string): ExpressionJudgement | undefined {
    try {
        const raw = JSON.parse(value) as { choice?: unknown; reason?: unknown };
        if (!EXPRESSION_CHOICES.includes(raw.choice as ExpressionChoice)) return undefined;
        if (raw.reason !== undefined && (typeof raw.reason !== 'string' || raw.reason.length > 80)) return undefined;
        return { choice: raw.choice as ExpressionChoice, ...(typeof raw.reason === 'string' && raw.reason.trim() ? { reason: raw.reason.trim() } : {}) };
    } catch { return undefined; }
}
