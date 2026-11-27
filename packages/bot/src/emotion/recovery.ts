// 修复事件后的心境回落（D 模块：情绪、心境和恢复；设计稿 runtime/design/2026-11-27-linmengyao-life-design.md 的 D 行）。
//
// 为什么：现有心境只按半衰期衰减（feelings.ts），道歉、说开、对方解释清楚这些「修复事件」只改口头态度（grievance.ts），
// 不会让短时心里的难过 / 烦 / 担心因此更快回落，账里也看不出是哪条证据让它回落的。
// 这里不碰她的措辞、口白、人设：只是给已有的负面评估标上「哪条证据之后开始更快衰减」，由 feelings.ts 按这个标记算分量。
//
// **开关默认关**：没有任何调用方传 repairs 时行为逐字不变（appraisals 不调 applyRecovery，feeling-ledger 也不写这个账）。
// 要开：在 FeelingFacts.repairs 里传入修复事件，再调 appendRecoveries 把回落记录落进感觉账；开关状态写在这段注释里，
// 不在 runtime/ 下新增配置。没有修复事件就不产生回落记录，也不改变任何衰减速度。
// 纯函数，合成用例可重放：同一组输入每次得到同样的评估和账本行。

import type { StoredMessage } from '../memory/history.ts';
import { isExplanationText } from './grievance.ts';
import type { Appraisal, FeelingKind, Source } from './feelings.ts';

/** 修复之后负面分量按这个半衰期（小时）落回去：明显比本来的难过 8 小时、烦 4 小时、担心 8 小时快 */
export const RECOVERY_HALF_LIFE_H = 1;

/** 会被修复事件带下来的那几种；累 / 开心 / 松口气不在此列 */
const NEGATIVE: ReadonlySet<FeelingKind> = new Set(['sad', 'annoyed', 'worry']);
/** 本地列一份，避免和 feelings.ts 形成运行时循环依赖（那边只 type-import 这里） */
const KINDS: ReadonlySet<FeelingKind> = new Set(['joy', 'relief', 'worry', 'sad', 'annoyed', 'tired']);

export interface RepairEvent {
    /** 稳定证据 ID：群聊 / 私聊消息用 m<消息号>，没有消息号时按分钟归一 */
    id: string;
    /** 修复发生的时刻（毫秒） */
    at: number;
    /** 只回落这一条评估；不写就按同一种负面感受匹配 */
    target?: string;
    /** 只回落这一种感受；不写就不限种类 */
    kind?: FeelingKind;
    /** 可审计的说法，不引对方原话 */
    cause: string;
    source: Source;
}

type Said = Pick<StoredMessage, 'role' | 'content'> & { time?: string | undefined; messageId?: number };

/** 从聊天记录里认「道歉 / 说开了 / 解释清楚了」：判据和 grievance.ts 同源，但只用道歉和解释那一档，
 *  不算单纯哄一句、说句想念——那种话不该把此前所有难过一律拖下来 */
export function repairFromHistory(history: readonly Said[], now: number): RepairEvent[] {
    return history.flatMap(message => {
        if (message.role !== 'user') return [];
        const at = Date.parse(message.time ?? '');
        if (!Number.isFinite(at) || at > now || !isExplanationText(message.content)) return [];
        const id = typeof message.messageId === 'number' && Number.isSafeInteger(message.messageId)
            ? `m${message.messageId}` : `him:repair:${Math.floor(at / 60_000)}`;
        return [{ id, at, cause: '他道歉、解释或者哄你了', source: 'him' as const }];
    });
}

/** 一条账：哪条评估因为哪条证据回落 */
export interface Recovery {
    /** 修复发生的时刻 */
    at: number;
    /** 回落的评估 id */
    repaired: string;
    kind: FeelingKind;
    repairedCause: string;
    /** 造成回落的证据 id */
    by: string;
    byCause: string;
}

const validRepair = (event: RepairEvent | undefined): event is RepairEvent =>
    Boolean(event && typeof event.id === 'string' && event.id.trim() && Number.isFinite(event.at)
        && typeof event.cause === 'string' && event.cause.trim()
        && (event.target === undefined || typeof event.target === 'string')
        && (event.kind === undefined || KINDS.has(event.kind)));

/**
 * 给修复事件之后的负面评估打上 repairedAt；同时产出回落记录给感觉账。
 * 没有匹配的修复事件就不打标、不记录；同一组输入重放两次得到逐字一样的结果。
 */
export function applyRecovery(list: readonly Appraisal[], repairs: readonly RepairEvent[]): { list: Appraisal[]; recoveries: Recovery[] } {
    const valid = repairs.filter(validRepair);
    const out = list.map(item => ({ ...item }));
    const recoveries: Recovery[] = [];
    for (const item of out) {
        if (item.repairedAt !== undefined || !NEGATIVE.has(item.kind)) continue;
        const repair = valid
            .filter(event => event.at > item.at && (!event.target || event.target === item.id) && (!event.kind || event.kind === item.kind))
            .sort((a, b) => a.at - b.at)[0];
        if (!repair) continue;
        item.repairedAt = repair.at;
        recoveries.push({ at: repair.at, repaired: item.id, kind: item.kind, repairedCause: item.cause, by: repair.id, byCause: repair.cause });
    }
    return { list: out, recoveries };
}
