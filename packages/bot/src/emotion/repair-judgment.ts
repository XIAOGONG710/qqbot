// 道歉 / 解释有没有接住那件事（硬编码改造第五批「心境与恢复（D）」；环境变量 QQBOT_REPAIR_JUDGMENT=1，默认关）。
//
// 原来「这句算不算修复」只看 isExplanationText（affect.ts 的 isApologyText 加 grievance.ts 的解释 / 认错正则）：
// 说了「对不起」就算，哪怕只是随口一句就转开；没说那几个字的认真解释又不算。开了这个开关，由第一批那份共用判断约定
// （semantic-judgment.mjs，第五批加了 repair / brushoff 两类）按这一轮他的原话来认：
// 1. 模型的理解：他最后那几句是接住了那件事（repair），还是嘴上道歉没接住（brushoff），还是别的。
// 2. 程序允许做的：只有一样——心境里那件事回落得快不快（recovery.ts 的修复证据、feelings.ts 回来那一句的等待难过和「他在认真道歉」那点松口气）。
//    判断不当权限、不落事实；只靠判断才算上的回落不写进感觉账（recovery.ts 的 judged）。
// 3. 最终怎么说：她自己（judgment 槽那一行说明气消没消、怎么回由她定）。
// 判过的那几条在进程里记着（不落盘），后面几轮算心境时同一条话按同一个结论，不会这一轮说没接住、下一轮又被正则当成道歉；
// 重启后、没判过、判断用不上（超时、读不懂、拿不准）时一律照旧按正则（兼容回退）。

import { createHash } from 'node:crypto';
import type { StoredMessage } from '../memory/history.ts';
import type { RepairJudged } from './feelings.ts';
import { judgmentConversation, latestLines, type Judgment } from '../../../../dsh-plugins/dsh-linmengyao-memory/semantic-judgment.mjs';

/** 开关：只认 '1'（features.ts 的 ENV_SWITCHES 登记了）；还要 QQBOT_SEMANTIC_JUDGMENT、QQBOT_FEELING_RECOVERY 开着才有用 */
export const repairJudgmentOn = (): boolean => process.env.QQBOT_REPAIR_JUDGMENT === '1';

type Said = Pick<StoredMessage, 'role' | 'content'> & { time?: string | undefined };

/** 同一条话的键：时刻 + 内容的摘要（不存原话；快照那一路不带消息号，所以不用消息号） */
export function repairKey(message: Said): string {
    return `${message.time ?? ''}|${createHash('sha256').update(message.content).digest('hex').slice(0, 16)}`;
}

/**
 * 这一轮的判断落到他最后那几句的哪几条上：repair → 依据落在的那几条算接住了（true），同一串里别的算 false；
 * 别的能用的类别（brushoff、care、none……）→ 这一串都不算修复（false）。模型没看到的（超出最后几行、没有字的）不判，照旧按正则。
 */
export function verdictsFromJudgment(history: readonly Said[], judgment: Judgment): Map<string, boolean> {
    const conversation = judgmentConversation(history);
    // judgmentConversation 只留有字的两人的话、取最后几条：按同一个筛法从后往前对上原来的消息
    const kept = history.filter(message => (message.role === 'user' || message.role === 'assistant')
        && typeof message.content === 'string' && message.content.replace(/\s+/g, ' ').trim()).slice(-conversation.length);
    const cited = new Set(judgment.evidence.filter(item => item.speaker === 'him').map(item => item.line - 1));
    const out = new Map<string, boolean>();
    for (const index of latestLines(conversation)) {
        const message = kept[index];
        if (!message) continue;
        out.set(repairKey(message), judgment.category === 'repair' && cited.has(index));
    }
    return out;
}

/** 进程里记着的判过的那几条（不落盘，最多 MAX 条，旧的先丢） */
export class RepairVerdicts {
    static readonly MAX = 200;
    private readonly seen = new Map<string, boolean>();
    remember(verdicts: ReadonlyMap<string, boolean>): void {
        for (const [key, value] of verdicts) {
            this.seen.delete(key);
            this.seen.set(key, value);
        }
        while (this.seen.size > RepairVerdicts.MAX) this.seen.delete(this.seen.keys().next().value!);
    }
    get size(): number { return this.seen.size; }
    snapshot(): ReadonlyMap<string, boolean> { return new Map(this.seen); }
}

/** 给心境用的查法：判过的按判的，没判过 undefined */
export const judgedBy = (verdicts: ReadonlyMap<string, boolean> | undefined): RepairJudged | undefined =>
    verdicts?.size ? message => verdicts.get(repairKey(message)) : undefined;
