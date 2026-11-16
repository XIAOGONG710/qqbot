// 表达机会门槛：它只说明“可以交给她当下判断”，不生成内容、更不发送消息。

import type { Drive } from './motivation.ts';
import type { ShadowDriveDecision } from './motivation-resolution.ts';
import type { RegulationSnapshot } from './regulation.ts';

export type ExpressionBlock = 'not_focused' | 'low_mood' | 'body_discomfort' | 'recovery' | 'private_source' | 'diary_source';
export interface ExpressionOpportunity {
    driveId: string;
    eligible: boolean;
    blocks: readonly ExpressionBlock[];
    /** 无内容的理由标签，仅供把“是否开口”交给她判断。 */
    reason: string;
}

export interface ExpressionContext {
    /** 已由现有情绪系统得出的低心境标记；不存情绪原文。 */
    lowMood?: boolean;
    /** 来源是否来自她的私事或日记。调用方必须显式标记，缺省保守地不假设。 */
    privateSource?: boolean;
    diarySource?: boolean;
}

/**
 * 她定的边界在这里是硬门槛：低落、身体不适、恢复负荷、私事、日记都不会被推进到表达判断。
 * 通过也只是“可由她决定”，而不是“应该说”或“系统发送”。
 */
export function expressionOpportunity(decision: ShadowDriveDecision, drive: Drive, regulation: RegulationSnapshot, context: ExpressionContext = {}): ExpressionOpportunity {
    const blocks: ExpressionBlock[] = [];
    if (decision.driveId !== drive.id || decision.outcome !== 'focus') blocks.push('not_focused');
    if (context.lowMood) blocks.push('low_mood');
    if (regulation.discomfort >= 0.4) blocks.push('body_discomfort');
    if (regulation.recoveryNeed >= 0.7) blocks.push('recovery');
    if (context.privateSource) blocks.push('private_source');
    if (context.diarySource) blocks.push('diary_source');
    const eligible = blocks.length === 0;
    return { driveId: drive.id, eligible, blocks, reason: eligible ? '可交给她当下判断是否开口' : '当前不应推动她开口' };
}
