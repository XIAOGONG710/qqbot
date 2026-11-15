// 形状控制作为解释器的模块（ADR 0336 第 5 步）：ADR 0091 起——用具体的字数和条数（每条多长、几条，带自己的事、废话、情绪轮、长答、拆条……）代替「回短一点」的软提示，
// 放进「此刻」块的 shape 槽。按他最后一句的哈希抽（同一句每次一样，不抽随机数）。
// 语言松绑（DSH 10-28）：只有接情绪 / 好事 / 亲近 / 撒娇 / 认真，或问到过去 / 节日（记忆线索）时给；shapeAll（ADR 0220）所有轮次都给。
// 危机、只发表情、发照片、被打断、只想一想、深思的轮次不给；主动找他时 planShape 自己不给。
//
// 「照片 → 意图 → 心境 → 图片表情 → 深思 → 引用 → 形状 → 长短」这一串从末端倒着迁（见 modules/length.ts）：
// 前面那几样还在旧逻辑里，旧逻辑写进 turn.facts，这里读；算出的形状写回 turn.facts.shape——长短的模块读它（要排在它后面），
// 旧逻辑在拼完段落之后也读它：生成时按它调最多几条、发出去之前按它裁（shapeReply）。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { ENGAGED_INTENT } from '../language/expression.ts';
import { describeShape, planShape, type ShapeShares } from '../language/shape.ts';
import type { Log } from '../platform/log.ts';

export interface ShapeModuleOptions {
    /** 配置 shape；关着整个模块不放 */
    shape?: boolean;
    shapeAll?: boolean;
    shapeAgenda?: boolean;
    shapeFiller?: boolean;
    shapeFeel?: boolean;
    shapeSplit?: boolean;
    shapeAsk?: boolean;
    shapeLong?: boolean;
    /** 各种形状轮次的占比（只有模拟器的场景调参用） */
    shapeShares?: ShapeShares;
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export function shapeModule(options: ShapeModuleOptions): Module {
    return {
        id: 'shape',
        contribute(turn) {
            const { facts } = turn;
            if (!options.shape || facts.crisis || facts.stickerOnly || facts.photo || facts.interruption || turn.thinking || facts.deliberate) return [];
            if (!(options.shapeAll || facts.cue || (facts.intent && ENGAGED_INTENT.test(facts.intent)))) return [];
            const plan = planShape({
                history: turn.history, intent: facts.intent, initiating: Boolean(turn.initiate), low: Boolean(facts.low), aboutPerson: Boolean(facts.aboutPeople),
                agenda: options.shapeAgenda, filler: options.shapeFiller, feel: options.shapeFeel, split: options.shapeSplit, ask: options.shapeAsk, long: options.shapeLong,
                agendaTopics: facts.agendaTopics ?? [], ...(options.shapeShares ? { shares: options.shapeShares } : {}),
            });
            if (!plan) return [];
            facts.shape = plan;
            options.log(`[${turn.contact.qq}] 这一轮形状：每条不超过 ${plan.cap} 字、最多 ${plan.maxBubbles} 条（${plan.kind}${plan.agenda ? `，带自己的事${plan.agendaTopic ? `：${plan.agendaTopic}` : ''}` : ''}${plan.filler ? '，废话' : ''}${plan.long ? '，长答' : ''}${plan.feel ? '，先说小情绪' : ''}${plan.stretch ? '，跟着拖音' : ''}${plan.drawl ? '，语气松一点' : ''}${plan.parts ? `，分 ${plan.parts} 条` : ''}）`);
            return [{ slot: 'shape', text: describeShape(plan) }];
        },
    };
}
