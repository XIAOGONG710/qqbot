// 记忆相关性判断（硬编码改造第三批「记忆、遗忘和技能（I、J）」；环境变量 QQBOT_MEMORY_RELEVANCE=1，默认关）。
// 他的私人记忆召回以后，原来按规则（变淡、同一件事别太多、最多几条）挑好就全放；开了以后问一次小模型：这几条里哪几条和他此刻说的真有关系。
// 提示词、格式、严格解析、取舍和日志那一行都在和 DSH 共用的 dsh-plugins/dsh-linmengyao-memory/memory-relevance.mjs。
//
// 三层分开：
// 1. 模型的理解：decideAt.recall（记忆模块召回完之后，同一个位置）发出那次调用，和后面几步并行；decideAt.deliberate 取回。
// 2. 程序允许做的：只能从召回那一段里去掉几行（不加、不换、不改字），所以读不到的照样读不到（账号隔离、撤回、变淡都在召回时算过）；
//    不落成事实或记忆、不当对外发送的凭据。超时、读不懂、编号不对、拿不准都照规则全放。
// 3. 最终怎么说：她自己。
// 只管男朋友档私聊里他的私人记忆那一段（facts.recall.recalled）；公共记忆、别人的记忆、工作房、桌面那几段不动。
// 危机、主动找他、只想一想、快照（SELF.json）的轮次不问。日志只记候选几条、留几条、不确定性（不记内容、原话和 QQ 号）。
// 开关关着时这个模块不挂（platform/turn-modules.ts），一个字都不变（行为基线核对）。

import type { Module, TurnFacts } from '../interpreter/interpreter.ts';
import type { Log } from '../platform/log.ts';
import type { JudgmentAsk } from '../../../../dsh-plugins/dsh-linmengyao-memory/semantic-judgment.mjs';
import { judgmentConversation } from '../../../../dsh-plugins/dsh-linmengyao-memory/semantic-judgment.mjs';
import {
    applyRelevance, judgeRelevance, RELEVANCE_MAX_TOKENS, RELEVANCE_TIMEOUT_MS, relevanceCandidates, relevanceLogLine, type RelevanceResult,
} from '../../../../dsh-plugins/dsh-linmengyao-memory/memory-relevance.mjs';

/** 开关：只认 '1'（features.ts 的 ENV_SWITCHES 登记了） */
export const memoryRelevanceOn = (): boolean => process.env.QQBOT_MEMORY_RELEVANCE === '1';

/** 那次小调用的上限（App 拿去覆盖小调用配置里的输出上限和超时） */
export const RELEVANCE_LIMITS = { maxTokens: RELEVANCE_MAX_TOKENS, timeoutMs: RELEVANCE_TIMEOUT_MS } as const;

export interface MemoryRelevanceOptions {
    /** 问小模型（App 里是经执行器、不开思考、温度 0 的小调用；测试里是假的） */
    ask: JudgmentAsk;
    /** 不带 QQ 号的日志 */
    log: Log;
    timeoutMs?: number;
}

/** 召回那一段拆成标题和各行；每行都是「- 」开头才拆（格式不认识就不判断） */
export function recalledLines(block: string): { header: string; lines: string[] } | undefined {
    const [header, ...lines] = block.split('\n');
    if (!header || !lines.length || lines.some(line => !line.startsWith('- '))) return undefined;
    return { header, lines };
}

export function memoryRelevanceModule(options: MemoryRelevanceOptions): Module {
    const pending = new WeakMap<TurnFacts, Promise<{ result: RelevanceResult; header: string; lines: string[] }>>();
    return {
        id: 'memory-relevance',
        decideAt: {
            recall(turn) {
                const { facts } = turn;
                if (turn.contact.tier !== 'boyfriend' || turn.snapshot || turn.thinking || turn.initiate || facts.crisis || turn.history.at(-1)?.role !== 'user') return;
                const split = facts.recall?.recalled ? recalledLines(facts.recall.recalled) : undefined;
                if (!split) return;
                const conversation = judgmentConversation(turn.history);
                pending.set(facts, judgeRelevance({
                    conversation, candidates: relevanceCandidates(split.lines), ask: options.ask,
                    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
                }).then(result => ({ result, ...split })));
            },
            deliberate(turn) {
                const asked = pending.get(turn.facts);
                if (!asked) return undefined;
                pending.delete(turn.facts);
                return asked.then(({ result, header, lines }) => {
                    options.log(relevanceLogLine(result, lines.length));
                    const recall = turn.facts.recall;
                    if (result.fallback || !recall) return;
                    const kept = applyRelevance(lines, result);
                    if (kept.length) recall.recalled = [header, ...kept].join('\n');
                    else delete recall.recalled;
                });
            },
        },
    };
}
