// 形状控制作为解释器的模块（ADR 0336 第 5 步）：ADR 0091 起——用具体的字数和条数（每条多长、几条，带自己的事、废话、情绪轮、长答、拆条……）代替「回短一点」的软提示，
// 放进「此刻」块的 shape 槽。按他最后一句的哈希抽（同一句每次一样，不抽随机数）。
// 语言松绑（DSH 10-28）：只有接情绪 / 好事 / 亲近 / 撒娇 / 认真，或问到过去 / 节日（记忆线索）时给；shapeAll（ADR 0220）所有轮次都给。
// 危机、只发表情、发照片、被打断、只想一想、深思的轮次不给；主动找他时 planShape 自己不给。
//
// 「照片 → 意图 → 心境 → 图片表情 → 深思 → 引用 → 形状 → 长短」这一串从末端倒着迁（见 modules/length.ts）：
// 前面那几样还在旧逻辑里，旧逻辑写进 turn.facts，这里读；算出的形状写回 turn.facts.shape——长短的模块读它（要排在它后面），
// 旧逻辑在拼完段落之后也读它：生成时按它调最多几条。发出去之前按它裁（shapeReply）是这个模块的 reviewAt.shape（ADR 0336「生成之后那一段」第 3 步）：
// 只有 contribute 写了 facts.shape 才有事做，超字数重写一次、还超就按分句截断。不存状态。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线核对）。

import { catAlternative } from '../character-terms.ts';
import { feelsLow } from '../emotion/feelings.ts';
import type { Module } from '../interpreter/interpreter.ts';
import { describeBody, unwell } from '../life/body.ts';
import { moodAt } from '../life/her-days.ts';
import { describeWorld } from '../world/world.ts';
import { ENGAGED_INTENT } from '../language/expression.ts';
import { describeShape, planShape, shapeReply, type ShapeShares } from '../language/shape.ts';
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
        // 形状和长短要的两样（ADR 0336「判断那一串」，decideAt.length：深思之后、质感之前，联系人流水线里的原位），和迁移前逐字一样：
        // - low：她这会儿低落——今天的心情是「安静」、身体不舒服、心境那一行放了而且偏低、真人数值低（没劲 / 饿 / 压力大 / 心情差）：不加「话多」。
        // - agendaTopics：带自己的事时能挑的话题——她那边那一行里还没说过的几样（按标签）、身体（没说过肚子不舒服）、心情（卡上有心情）。
        // 今天的心情在这里现算（按日子哈希，纯函数；作息经 DecideCtx 给，没开她自己的日子就没有心情）。
        decideAt: {
            length: (turn, ctx) => {
                const { facts, at: time } = turn;
                const { world: around, body: bodyNow, humanValues } = facts;
                const mood = ctx.schedule ? moodAt(ctx.schedule, turn.card?.moods ?? [], time, ctx.mood, { body: bodyNow, world: around }) : undefined;
                const low = mood?.mood.name === '安静' || (bodyNow ? unwell(bodyNow) : false) || (facts.feelingLine !== undefined && feelsLow(facts.felt ?? []))
                    || Boolean(humanValues && (humanValues.energy <= 30 || humanValues.hunger >= 82 || humanValues.stress >= 78 || humanValues.mood <= 30));
                if (low) facts.low = true;
                // 她这一天半里已经主动说过的事（ADR 0098，modules/repetition.ts assess 时写；危机回合不算）
                const told = facts.told ?? [];
                const TOLD_LABEL: Record<string, RegExp> = { 相机: /相机/, 猫: new RegExp(`${catAlternative()}猫`), 作业: /作业/, 快递: /快递/ };
                // 世界那一行的标签（天气、猫、作业……）：行本身由她此刻的模块放；标签和“钱是谁给的”无关，这里不带称呼
                const world = around ? describeWorld(around, time) : undefined;
                const worldLabels = world ? world.replace(/^\[你那边（[^）]*）：/, '').replace(/\]$/, '').split('｜').map(item => item.split('：')[0]!.trim()).filter(Boolean) : [];
                facts.agendaTopics = [
                    ...worldLabels.filter(label => !told.some(name => TOLD_LABEL[name]?.test(label))),
                    ...(bodyNow && describeBody(bodyNow) && !told.includes('肚子不舒服') ? ['身体'] : []),
                    ...(mood ? ['心情'] : []),
                ];
            },
        },
        reviewAt: {
            // 发出去之前按这一轮的形状裁：没形状同步原样返回（同原来不 await）
            shape(text, turn, ctx) {
                const plan = turn.facts.shape;
                if (!plan) return text;
                return shapeReply(text, plan, { regenerate: ctx.regenerate, onRewriteAccepted: ctx.accept, log: ctx.log });
            },
        },
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
