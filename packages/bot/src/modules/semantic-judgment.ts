// 私聊语义判断（硬编码改造第一优先级，exchange/handoff/2026-11-28-hardcoded-policy-audit.md；环境变量 QQBOT_SEMANTIC_JUDGMENT=1，默认关）。
// 他在私聊里最后说的那几句是「认真求关心」「轻松接梗」「没接就收」「推掉 / 拒绝」「纠正她的理解」还是都不是（后两类第四批加的）：问一次小模型，提示词、格式、严格解析和放给她的那一行
// 都在和 DSH 共用的 dsh-plugins/dsh-linmengyao-memory/semantic-judgment.mjs，两边读到的是同一份判断。
//
// 三层分开：
// 1. 模型的理解：assess 时就发出那次调用（和召回之后的几步并行），decideAt.deliberate（流水线会等的位置）拿回结果；能用的才写进 turn.facts.semanticJudgment。
// 2. 程序允许做的：只有三样——往「此刻」块的 judgment 槽放一句「你对他这几句的理解」（带把握）；出口检查（review-exit.ts）和卡末尾那段（contact.ts → prompt.ts）
//    在已有的选择里用它代替关键词认「求哄 / 转话题」（recognizes）；主人当场纠正时那一轮的修复提示（self-memory.ts）用它代替关键词认「他在纠正」。
//    记下纠正、记下待确认 / 已澄清的理解（落盘的那一半）照旧只按他的原话和规则，不看判断。
//    它不是权限、不落成事实或记忆、不当对外发送的凭据；超时、读不懂、依据对不上、拿不准都不写，出口检查照旧走那几条正则（兼容入口）。
// 3. 最终怎么说：她自己。
// 只给男朋友档的私聊；危机、主动找他、只想一想、快照（SELF.json）的轮次不问。日志只记类别、不确定性、依据条数和字数（不记原话，也不带 QQ 号）。
// 开关关着时这个模块不挂（platform/turn-modules.ts），一个字都不变（行为基线核对）。

import type { Module, Turn, TurnFacts } from '../interpreter/interpreter.ts';
import type { Log } from '../platform/log.ts';
import {
    JUDGMENT_MAX_TOKENS, JUDGMENT_TIMEOUT_MS, judgeTurn, judgmentConversation, judgmentLine, judgmentLogLine, reportedSpeech,
    type JudgmentAsk, type JudgmentLine, type JudgmentResult,
} from '../../../../dsh-plugins/dsh-linmengyao-memory/semantic-judgment.mjs';

/** 开关：只认 '1'（features.ts 的 ENV_SWITCHES 登记了） */
export const semanticJudgmentOn = (): boolean => process.env.QQBOT_SEMANTIC_JUDGMENT === '1';

/** 那次小调用的上限（App 拿去覆盖小调用配置里的输出上限和超时） */
export const JUDGMENT_LIMITS = { maxTokens: JUDGMENT_MAX_TOKENS, timeoutMs: JUDGMENT_TIMEOUT_MS } as const;

/**
 * 这一轮他是不是在「求哄」（care）/「转话题」（closing）：有能用的判断就按判断；开着但这一轮退回了，按关键词认，
 * 只是他最后那几句是分几条发的转述（「我室友跟他女朋友说了一句：」+ 那句话）时不认（第一批补验的缺口二）；没开语义判断就照旧只看关键词（一个字不变）。
 */
export function recognizes(turn: Turn, category: 'care' | 'closing', keyword: (said: string) => boolean): boolean {
    const { facts } = turn;
    if (facts.semanticJudgment) return facts.semanticJudgment.category === category;
    const latest = turn.history.at(-1);
    if (latest?.role !== 'user' || !keyword(latest.content)) return false;
    return !(facts.semanticJudgmentFallback && reportedSpeech(judgmentConversation(turn.history)));
}

/** 主人当场纠正时那一轮的修复提示用：有能用的判断就按判断认「他在纠正」，没有就 undefined（照旧按关键词） */
export const judgedCorrection = (facts: TurnFacts): boolean | undefined => (facts.semanticJudgment ? facts.semanticJudgment.category === 'correction' : undefined);

export interface SemanticJudgmentOptions {
    /** 问小模型：给消息，回一段文字（App 里是经执行器、不开思考、温度 0 的小调用；测试里是假的） */
    ask: JudgmentAsk;
    /** 不带 QQ 号的日志（联系人流水线给的 ctx.log 会加 [QQ号]，这里不用它） */
    log: Log;
    timeoutMs?: number;
}

export function semanticJudgmentModule(options: SemanticJudgmentOptions): Module {
    const pending = new WeakMap<TurnFacts, Promise<{ result: JudgmentResult; conversation: JudgmentLine[] }>>();
    return {
        id: 'semantic-judgment',
        assess(turn) {
            const { facts } = turn;
            if (turn.contact.tier !== 'boyfriend' || turn.snapshot || turn.thinking || turn.initiate || facts.crisis || turn.history.at(-1)?.role !== 'user') return;
            const conversation = judgmentConversation(turn.history);
            pending.set(facts, judgeTurn({ conversation, ask: options.ask, ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}) })
                .then(result => ({ result, conversation })));
        },
        decideAt: {
            deliberate(turn) {
                const asked = pending.get(turn.facts);
                if (!asked) return undefined;
                pending.delete(turn.facts);
                return asked.then(({ result, conversation }) => {
                    options.log(judgmentLogLine(result, conversation));
                    if (result.judgment && !result.fallback) turn.facts.semanticJudgment = result.judgment;
                    else if (result.fallback) turn.facts.semanticJudgmentFallback = result.fallback;
                });
            },
        },
        contribute(turn) {
            const line = judgmentLine(turn.facts.semanticJudgment);
            return line ? [{ slot: 'judgment', text: line }] : [];
        },
    };
}
