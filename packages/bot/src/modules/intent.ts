// 这一轮的意图（意图阶梯，language/intent.ts 的 describeIntent）作为解释器的模块（ADR 0336 第 5 步）：
// - assess 时按阶梯（约 30 级：危机、小别扭、会拒绝、亲密邀约、吃醋、撒娇、追问……）算出这一轮她想怎么接，写进 turn.facts.baseIntent；
//   注册在 assess 的最前面，后面的模块（被打断、小梗那几样的让路规则）和旧逻辑都读它。只想一想时不算（不是在聊天）。
// - 不放段落：意图行由 modules/intent-line.ts 放进 intent 槽（读下面定下的 facts.intent）。
// - 开关（会拒绝、拒绝之后、吃醋、追问、今天的小事、她的追求）是模块的选项；输入里的危机、小别扭、她那边此刻是 turn.facts 里已有的判断，
//   她此刻在干嘛和作息（her-now 的 perceive）、挂着的事（warm 的 decideAt.loops）、她答应的事（time-notes 的 decideAt.promises）、
//   她那边还没说过的事（这里的 decideAt.news）都在 assess 之前写进 turn.facts。
// 最终的意图（ADR 0336「判断那一串」第 2 步，decideAt.intent）：照片判断之后。和迁移前联系人流水线里的逐字一样：
// - 这一轮发照片（不是主动那条——它的意图在 initiate.note 里）：意图换成「发这一类照片」那一句；发的是审核过的「现在的照片」时换成只发这一张那一句；
// - 他要「现在」的照片但没有匹配图（facts.photoUnavailable）：换成如实说发不了那一句；
// - 被打断的这一轮（ADR 0115）：不带意图（和「先接他的话、顺带说一声刚被什么岔了一下」冲突）；
// - 其余用意图阶梯给的 baseIntent。
// 小别扭 / 和好真的生效 = 最终的意图就是小别扭那一句（没被照片、被打断、更高的意图盖掉）：写 grievanceActive，是小别扭（不是和好）再写 sulk；记一行日志。有意图也记一行。
// 阶梯本身原样不动；行为和迁移前 contact.ts 里的逐字一样（行为基线 intents 等场景核对）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import { describeGrievance } from '../emotion/grievance.ts';
import { describeIntent } from '../language/intent.ts';
import { photoIntent } from '../vision/photos.ts';
import { projectActivity } from '../life/projects.ts';
import { formatDate, herDay } from '../life/schedule.ts';
import { worldNews } from '../world/world.ts';

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
        decideAt: {
            // 她那边的事还没说过（ADR 0057 调整；ADR 0336「判断那一串」2026-11-18 从流水线搬来，原位：挂着的事之后、assess 之前）：
            // 她的今天了结的、那之后她一句话都还没说过（主动那条发出去了也算说过）——这一轮顺带说。先只给男朋友档；作息经 DecideCtx.schedule（开了她自己的日子才有）
            news: (turn, ctx) => {
                const { contact, at: time, initiate } = turn;
                const around = turn.facts.world;
                const herSchedule = ctx.schedule;
                const untold = around && herSchedule && contact.tier === 'boyfriend' && !initiate
                    ? worldNews(around).filter(n => n.at <= time && formatDate(herDay(herSchedule, n.at)) === around.day
                        && !turn.history.some(m => m.role === 'assistant' && m.time !== undefined && Date.parse(m.time) >= n.at.getTime())).map(n => n.what)
                    : [];
                if (untold.length) ctx.log(`她那边的事还没跟他说过：${untold.join('、')}`);
                if (untold.length) turn.facts.news = untold;
            },
            intent: (turn, ctx) => {
                const { facts } = turn;
                const { grievance } = facts;
                const intent = facts.photo && !turn.initiate
                    ? (facts.photoPrompt ? '[这一轮你想：他明确要看现在的照片，你有一张与此刻匹配、已经审核过的：自然带一句后发这一张；别换成别的照片]' : photoIntent(facts.photo))
                    : facts.photoUnavailable
                        ? '[这一轮你想：他明确要看现在的照片，但现在没有一张已经审核且与此刻匹配的；如实说这会儿发不了，别拿以前的图冒充“现在”，也别承诺马上补发]'
                        : facts.interruption ? undefined : facts.baseIntent;
                if (intent) facts.intent = intent;
                if (grievance && intent === describeGrievance(grievance)) {
                    facts.grievanceActive = true;
                    if (grievance.stage === 'sulk') facts.sulk = true;
                    ctx.log(grievance.cause === 'ignored'
                        ? '小别扭：她倾诉了几条他隔了很久才回（他回来后第一轮；日志不记内容）'
                        : `${grievance.stage === 'makeup' ? '和好' : '小别扭'}：他隔了 ${grievance.days} 天才来（他回来后第 ${grievance.round + 1} 轮；日志不记内容）`);
                }
                if (intent) ctx.log(`这一轮有意图：${intent.slice('[这一轮你想：'.length, -1)}`);
            },
        },
        assess(turn) {
            const intent = intentOf(turn, options);
            if (intent) turn.facts.baseIntent = intent;
        },
    };
}
