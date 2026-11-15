// 逐条事实检查作为审稿模块（ADR 0336「生成之后那一段」第 7 步；ADR 0137，她替他说的那一类 ADR 0203）：把回复拆成一条条关于她自己 / 她身边世界（开着 aboutHim 时还有关于他）的说法，
// 交给审稿的模型对照这一轮的提示词（设定、事实、聊天）；log 档只记，fix 档带说明重写一次、还有就删行（checkFacts，language/fact-check.ts）。
// 占审稿顺序表的两个位置：
//   facts       第一次查，在出口检查之前（重写出来的话还要过出口检查）。主动找他时删完剩下的撑不住这一轮（返回空串），这一轮到此为止（stop），后面的审稿不跑、整条不发；
//   factsFinal  后面几步（出口检查、<<查>>、形状、话说到一半、删行收尾）改过稿子时再查一次，只删行、不再重写（finalOnly）；稿子和第一次查完的一样就不查。
// 第一次查完的稿子经 ctx.scratch.factsChecked 交给 factsFinal（没查过就没有，factsFinal 也不查）。
// 不查的情况同迁移前：危机回合（turn.facts.crisis）、固定说法（ctx.allowRepeat）、拿不到这一轮的提示词（ctx.promptSource）。
// 开关在 App / 模拟器：factCheck 是 log / fix 时才挂（mode 就是它），factHim 给 aboutHim；审稿的模型调用（audit）由它们给——App 经执行器，日志用 ctx.log（同迁移前的 [qq] 前缀）。
// 不用查时同步返回原稿（同原来不 await）；要查时返回 promise（原来就 await），审稿调用的次数和先后和迁移前逐字一样（行为基线 review 场景核对）。

import type { Module, ReviewCtx, ReviewVerdict, Turn } from '../interpreter/interpreter.ts';
import { checkFacts, type FactCheckMode, type FactCheckOptions, type FactRecord } from '../language/fact-check.ts';
import type { OpenAIMessage } from '../language/prompt.ts';

export interface ReviewFactsOptions {
    /** log 只查、记日志，照发；fix 有对不上事实的说法就带说明重写一次（配置 factCheck；off 时不挂这个模块） */
    mode: Exclude<FactCheckMode, 'off'>;
    /** 多查一类：她替他说的、没有依据的事（配置 factHim，ADR 0203） */
    aboutHim?: boolean;
    /** 把审稿的提示词交给模型、返回原文（App：exec.llm，温度 0；模拟器：场景的模型）。log 是这个联系人的日志（ctx.log） */
    audit: (messages: OpenAIMessage[], log: (line: string) => void) => Promise<string>;
    /** 每次检查的记录（模拟器的报告用） */
    onRecord?: (record: FactRecord) => void;
}

export function reviewFactsModule(options: ReviewFactsOptions): Module {
    const { mode, aboutHim, audit, onRecord } = options;
    /** 这一轮要不要查、查的话给 checkFacts 的那一份（同迁移前 contact.ts 的 factOptions） */
    const optionsFor = (turn: Turn, ctx: ReviewCtx): FactCheckOptions | undefined => {
        const { promptSource, names } = ctx;
        if (turn.facts.crisis || ctx.allowRepeat || !promptSource || !names) return undefined;
        return {
            mode, source: promptSource, names, mayDropAll: Boolean(ctx.initiating), ...(aboutHim ? { aboutHim: true } : {}),
            audit: messages => audit(messages, ctx.log),
            regenerate: ctx.regenerate, onRewriteAccepted: ctx.accept, log: ctx.log, ...(onRecord ? { onRecord } : {}),
        };
    };
    return {
        id: 'review-facts',
        reviewAt: {
            facts(text, turn, ctx) {
                const factOptions = optionsFor(turn, ctx);
                if (!factOptions) return text;
                return checkFacts(text, factOptions).then((checked): string | ReviewVerdict => {
                    ctx.scratch.factsChecked = checked;
                    // 想说的那部分被当成没依据删光了（只在主动找他时会这样）：这轮不发，后面的审稿不跑；主动消息那边按「生成的是空的」跳过
                    return checked === '' && text !== '' ? { text: '', stop: true } : checked;
                });
            },
            factsFinal(text, turn, ctx) {
                const first = ctx.scratch.factsChecked;
                if (first === undefined || text === first) return text;
                const factOptions = optionsFor(turn, ctx);
                if (!factOptions) return text;
                return checkFacts(text, { ...factOptions, finalOnly: true });
            },
        },
    };
}
