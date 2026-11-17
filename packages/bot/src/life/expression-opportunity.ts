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
    /** 已经答应对方且到期的事要能交代；身体不舒服不能让改约通知永远发不出去。 */
    commitmentDue?: boolean;
}

/**
 * 她定的边界在这里是硬门槛：低落、身体不适、恢复负荷、私事、日记都不会被推进到表达判断。
 * 通过也只是“可由她决定”，而不是“应该说”或“系统发送”。
 */
export function expressionOpportunity(decision: ShadowDriveDecision, drive: Drive, regulation: RegulationSnapshot, context: ExpressionContext = {}): ExpressionOpportunity {
    const blocks: ExpressionBlock[] = [];
    if (decision.driveId !== drive.id || decision.outcome !== 'focus') blocks.push('not_focused');
    if (context.lowMood) blocks.push('low_mood');
    // 她明确保留了“身体不舒服、痛经、真有事时可以主动找他”：身体负荷只拦外部杂事，不封死她自己的内驱。
    if (drive.source === 'external' && !context.commitmentDue && regulation.discomfort >= 0.4) blocks.push('body_discomfort');
    if (drive.source === 'external' && !context.commitmentDue && regulation.recoveryNeed >= 0.7) blocks.push('recovery');
    if (context.privateSource) blocks.push('private_source');
    if (context.diarySource) blocks.push('diary_source');
    const eligible = blocks.length === 0;
    return { driveId: drive.id, eligible, blocks, reason: eligible ? '可交给她当下判断是否开口' : '当前不应推动她开口' };
}
