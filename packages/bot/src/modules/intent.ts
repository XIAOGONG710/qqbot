// 这一轮的意图（意图阶梯，language/intent.ts 的 describeIntent）作为解释器的模块（ADR 0336 第 5 步）：
// - assess 时按阶梯（约 30 级：危机、小别扭、会拒绝、亲密邀约、吃醋、撒娇、追问……）算出这一轮她想怎么接，写进 turn.facts.baseIntent；
//   注册在 assess 的最前面，后面的模块（被打断、小梗那几样的让路规则）和旧逻辑都读它。只想一想时不算（不是在聊天）。
// - 不放段落：意图行由旧逻辑在照片 / 被打断改写之后放进 intent 槽，那几样各自迁成模块之前不动。
// - 开关（会拒绝、拒绝之后、吃醋、追问、今天的小事、她的追求）是模块的选项；输入里的危机、小别扭、她那边此刻是 turn.facts 里已有的判断，
//   她此刻在干嘛和作息、挂着的事、她答应的事、她那边还没说过的事由旧逻辑写进 turn.facts（以后各自迁成模块时改由那些模块写）。
// 阶梯本身原样不动；行为和迁移前 contact.ts 里的逐字一样（行为基线 intents 等场景核对）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import { describeIntent } from '../language/intent.ts';
import { projectActivity } from '../life/projects.ts';

export interface IntentModuleOptions {
    /** 会拒绝（ADR 0103，配置 herNo）：“他在磨她”“他在管着她”“他约她被推了”“他让她先放下手上的事” */
    refuse?: boolean;
    /** 拒绝之后（ADR 0214，配置 afterNo）：他又提同一类请求时，记得上次她推了他只回「行吧」、或者她被磨着勉强答应了 */
    afterNo?: boolean;
    /** 吃醋，最轻的一档（ADR 0123，配置 jealousy） */
    jealous?: boolean;
    /** 会追问（ADR 0126，配置 curious） */
    curious?: boolean;
    /** 今天的小事（ADR 0106，配置 everydayLife）：他问她今天怎么样时从里面挑着说 */
    everydayLife?: boolean;
    /** 她的追求（ADR 0104，配置 pursuits）：她正在做自己在意的事时，他让她先放下可以先弄完这一小段 */
    pursuits?: boolean;
}

/** 这一轮的意图；只想一想时没有 */
export function intentOf(turn: Turn, options: IntentModuleOptions): string | undefined {
    if (turn.thinking) return undefined;
    const { crisis, grievance, world, state, schedule, promised, waiting, unanswered, news } = turn.facts;
    const project = options.pursuits && state?.activity.kind === 'free' ? projectActivity(state.activity.text) : undefined;
    return describeIntent({
        history: turn.history,
        state,
        schedule,
        now: turn.at,
        promised: Boolean(promised),
        initiating: Boolean(turn.initiate),
        ...(options.refuse ? { refuse: true } : {}),
        ...(options.afterNo ? { afterNo: true } : {}),
        ...(options.jealous ? { jealous: true } : {}),
        ...(options.curious ? { curious: true } : {}),
        ...(options.everydayLife && world?.events.length ? { dayThings: true } : {}),
        ...(project ? { pursuitDoing: project.step } : {}),
        waiting,
        unanswered,
        intimate: turn.contact.tier === 'boyfriend',
        playful: turn.contact.tier === 'boyfriend',
        ...(crisis ? { crisis: crisis.level, ...(crisis.awaitingSafe ? { crisisAwaitingSafe: true } : {}) } : {}),
        ...(grievance ? { grievance } : {}),
        ...(news?.length ? { news } : {}),
    });
}

export function intentModule(options: IntentModuleOptions = {}): Module {
    return {
        id: 'intent',
        assess(turn) {
            const intent = intentOf(turn, options);
            if (intent) turn.facts.baseIntent = intent;
        },
    };
}
