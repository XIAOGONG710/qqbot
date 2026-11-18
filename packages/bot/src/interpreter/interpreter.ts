// 解释器（ADR 0336）：唯一做判断的地方。这里只有骨架——事件分发、一轮回复的四个阶段、提示词槽位的排序与拼接、模块注册；
// 具体功能一律写成模块（Module），不写在骨架里。碰外部的事交给执行器（executor/executor.ts）。
//
// 一轮回复的四个阶段（每个模块都可以只实现其中几个）：
// 1. perceive：先看清她此刻——她那边、身体、在干嘛，写进 turn.facts；判断这一轮怎么接的都要读它们。
// 2. assess：往这一轮写判断（turn.facts）——是不是危机、意图、形状……；后面的模块读前面写下的，模块之间不互相 import 内部函数。
// 3. contribute：往提示词的具名槽位里放段落（slots.ts）；先后由槽位表定，模块不管。
// 4. review：拿到草稿之后改一改（出口检查、事实检查、句尾封顶……）。
// 生成出来的每一稿在审稿之前先按清理顺序表（CLEAN_STAGES）清一次（cleanAt：图片表情、照片……），同步。
//
// 迁移期（ADR 0336 第 4 步）：每个钩子都同步时整轮也同步返回、不多等一个微任务；分发只有一个处理函数返回 promise 时原样返回它。
// 这样经解释器走和原来直接调用逐字等价（行为基线核对）。

import type { Contact } from '../platform/config.ts';
import type { GroupMessageEvent, MessageEvent, PokeEvent, RecallEvent } from '../platform/onebot.ts';
import type { ChatMessage, OpenAIMessage } from '../language/prompt.ts';
import type { ResponderDeps } from '../social/responder.ts';
import type { CrisisHit } from '../emotion/crisis.ts';
import type { Grievance } from '../emotion/grievance.ts';
import type { Executor } from '../executor/executor.ts';
import type { WorldNow, WorldState } from '../world/world.ts';
import type { Appraisal, Felt, Moment } from '../emotion/feelings.ts';
import type { Pursuit } from '../life/pursuits.ts';
import type { FeelingsReport } from '../emotion/feeling-export.ts';
import type { Together } from '../language/together.ts';
import type { Schedule, State } from '../life/schedule.ts';
import type { Character } from '../st/card.ts';
import type { BodyNow } from '../life/body.ts';
import type { HerStatus } from '../language/status-line.ts';
import type { DescribedBooks } from '../life/her-days.ts';
import type { ShapePlan } from '../language/shape.ts';
import type { PhotoKind, PhotoShelf } from '../vision/photos.ts';
import type { StickerShelf } from '../social/stickers.ts';
import type { ParsedTokens } from '../platform/device-actions.ts';
import type { QuotePlan } from '../social/quote-reply.ts';
import type { HumanValues } from '../human-values.ts';
import type { DevelopmentSnapshot } from '../life/development.ts';
import type { MemoryPieces } from '../modules/memory.ts';
import type { AskedWindow } from '../life/people.ts';
import type { LongTermMemory } from '../memory/long-term.ts';
import type { PromiseKeeper } from '../life/promises.ts';
import type { ReviewOptions } from '../language/exit-check.ts';
import type { PickRules } from '../language/candidates.ts';
import type { TurnWeight } from '../language/turn-weight.ts';
import type { StoredMessage } from '../memory/history.ts';
import type { TypoRecall } from '../language/expression.ts';
import type { Summarizer, TurnWindow } from '../language/context-window.ts';
import type { CurrentAiPhotoResult } from '../proactive/ai-photo-requests.ts';
import { assemblePrompt, type Piece } from './slots.ts';

/** 解释器收到的事件 */
export type BotEvent =
    | { kind: 'connected'; selfId: number }
    /** 连上 NapCat、补完漏掉的消息之后（连上后要做一次的事从这里开始） */
    | { kind: 'synced' }
    | { kind: 'message'; event: MessageEvent }
    /** 群消息（DSH 线）：她在的群里有人说话 */
    | { kind: 'group'; event: GroupMessageEvent }
    | { kind: 'poke'; event: PokeEvent }
    | { kind: 'recall'; event: RecallEvent }
    | { kind: 'friendRequest'; request: { userId: number; flag: string; comment?: string } };

export type EventKind = BotEvent['kind'];
type Maybe<T> = T | Promise<T>;
export type EventHandlers = { [K in EventKind]?: (event: Extract<BotEvent, { kind: K }>) => Maybe<void> };

type BuildContext = Parameters<ResponderDeps['buildPrompt']>[1];

/**
 * 这一轮回复在判断的事实。字段随模块迁出逐个加上（ADR 0336 第 5 步）：
 * 写的模块在 perceive / assess 里写，读的模块在后面的阶段读。
 */
export interface TurnFacts {
    /** 危机信号（ADR 0068）；主动找他时不算 */
    crisis?: CrisisHit;
    /** 小别扭 / 和好的起因（ADR 0074）；只算男朋友档，危机、主动找他时没有 */
    grievance?: Grievance;
    /** 这一轮的意图行（意图阶梯，modules/intent.ts 写；照片 / 被打断改写之前的那一版）；只想一想时没有 */
    baseIntent?: string;
    /** 她那边此刻（ADR 0021 世界账：猫、快递、钱、今天的小事……，modules/her-now.ts 写）；开了她自己的日子、卡上有世界才有 */
    world?: WorldNow;
    /** 她的身体此刻（ADR 0025，modules/her-now.ts 写）；开了她自己的日子、卡上有身体才有 */
    body?: BodyNow;
    /** 状态行（作息、说过睡了、见面、世界里的事、一天的打算、项目，modules/her-now.ts 写）；开了作息才有 */
    status?: HerStatus;
    /** 她此刻在干嘛（status.state）；开了作息才有 */
    state?: State;
    /** 群里最近发生的事（2026-11-14，contact 取好写进来；modules/group.ts 放进 group 槽） */
    groupEcho?: string;
    /** 作息（快睡了“回两句就去忙”按它算）；开了作息或她自己的日子才有 */
    schedule?: Schedule;
    /** 时间块里已经有「她答应的事」（ADR 0018） */
    promised?: boolean;
    /** 挂着的事（ADR 0023）：在等他说结果的事、她问了他没答的；开了长期记忆才有 */
    waiting?: readonly string[];
    unanswered?: readonly string[];
    /** 挂着的事里没了结的（ADR 0023）：两个人说好的事没成、说到一半就断了，只有事实（what）；旧逻辑和 waiting / unanswered 一起写，modules/warm.ts 读 */
    unsettled?: readonly string[];
    /** 真人数值（ADR 0222）：App 有需要锚点和世界账时，旧逻辑在 buildPrompt 开头（第一次 await 之前）算好写进来；modules/human-state.ts 放「这一刻的底色」。没有时不写 */
    humanValues?: HumanValues;
    /** 人格成长层（ADR 0251）：和数值一起在原位算（读带结算的世界账、可能落事件，不挪过 await）；modules/human-state.ts 放「生活脉络」那一行。投影失败时没有 */
    development?: DevelopmentSnapshot;
    /** 她那边今天了结了、还没跟他说过的事（ADR 0057）；只算男朋友档 */
    news?: readonly string[];
    /** 被打断（ADR 0115，modules/interruptions.ts 写）：聊着的时候她那边刚发生的一件小事；旧逻辑读它决定这一轮不带意图 / 深思 / 形状 / 长短 */
    interruption?: { text: string; minutesAgo: number };
    /** 陪玩（ADR 0111，modules/together.ts 写）：此刻正和他一起玩什么、从哪一刻答应的 */
    together?: Together;
    /** 网络热梗（ADR 0129，modules/memes.ts 在 contribute 时写）：这一轮放进提示词的那一行；梗百科（modules/meme-dict.ts）读它，不重复给同一个词 */
    meme?: string;
    /** 这一轮小别扭真的生效（意图就是小别扭那一句；旧逻辑在照片 / 被打断改写意图之后写）：可以跑命令那一行（modules/shell.ts）读它 */
    grievanceActive?: boolean;
    /** 这一轮生效的是小别扭（不是和好）：出口检查放过「隔了很多天才来」这类带点抱怨的话（ADR 0074）；和 grievanceActive 同一处写（modules/intent.ts 的 decideAt.intent） */
    sulk?: boolean;
    /** 这一轮放的在读的书和进度（ADR 0015，modules/books.ts 写）；旧逻辑的出口检查拿进度核对她说的第几章。他没提、她也没在看书时没有 */
    books?: DescribedBooks;
    /** 她这一天半里已经主动跟他说过的事（ADR 0098，modules/repetition.ts 写）；危机回合不算。旧逻辑的形状读它：带自己的事时跳过说过了的 */
    told?: readonly string[];
    /** 他这一轮说起的她身边的人（ADR 0033，modules/people-around.ts 写）：names 是谁，lines 是放进提示词的那几段（这一档看不到的人没有段）。
     *  旧逻辑的形状和长短读它：说起她身边的人的那一轮按认真接话算、不加「回很短」。没说起、主动找他时没有 */
    aboutPeople?: { names: readonly string[]; lines: readonly string[] };
    // 下面几样是「照片 → 意图 → 心境 → 图片表情 → 深思 → 引用 → 形状 → 长短」这一串的交接（从末端倒着迁，ADR 0336「长短不一」一节）：
    // 前面那几样还在旧逻辑里，旧逻辑在拼段落之前写，长短的模块（modules/length.ts）读。
    /** 这一轮最终的意图行（照片、被打断改写之后，深思删掉「怎么答」那一句之前） */
    intent?: string;
    /** 记忆线索（ADR 0017）：他问到过去、提到节日的那个词；开了长期记忆、不是主动找他才有 */
    cue?: string;
    /** 这一轮抽到要发图片表情（ADR 0132）：他这一轮说的话（收藏库按它挑）、是不是只发表情；流水线拿它取清单。modules/media-offers.ts 的 decideAt.stickers 写 */
    stickerDraw?: { text: string; only?: boolean };
    /** 这一轮只发图片表情、不写文字（ADR 0132） */
    stickerOnly?: boolean;
    /** 这一轮发照片（ADR 0109 / 0128）：哪一种 */
    photo?: PhotoKind;
    /** 这一轮深思（ADR 0151 / 0202）：换更强的模型、不套字数和条数。旧逻辑原位判断后写（语义路由的分类调用不挪过 await）；modules/deliberate.ts 放「先想清楚」，形状、长短、引用读它 */
    deliberate?: boolean;
    /** 语义路由（ADR 0202）放进深思的那一轮按分类多放的一小句方向（ROUTED_HINTS）；旧逻辑在判断深思的地方写，modules/deliberate.ts 放进 routedHint 槽。关键词认出来的深思时没有 */
    routedHint?: string;
    /** 这一轮的形状（ADR 0091）：每条多长、几条。形状的模块（modules/shape.ts）在 contribute 时写，长短的模块和旧逻辑（生成、发出去之前裁）读 */
    shape?: ShapePlan;
    /** 引用回复（ADR 0136，modules/quote.ts 在 contribute 时写）：这一轮第一条引用他哪一条；旧逻辑发送时读 */
    quote?: QuotePlan;
    /** 连续性（ADR 0157–0163）：这一轮放进提示词的几行（设定改动的背景、QQ 以外做过的事、上网查到的、自己发现的口味、又见到的人）。
     *  取是异步的、会上网调模型，还在联系人流水线原来的位置（危机回合、只想一想的轮次不取，出错当没有）；modules/continuity.ts 读、放进 continuity 槽。没取到时没有 */
    continuity?: readonly string[];
    /** 带自己的事时能挑的话题（她那边还没说过的、身体、心情）；形状的模块读 */
    agendaTopics?: readonly string[];
    /** 她这会儿低落（心情安静、身体不舒服、心境偏低、真人数值低）：不加「话多」 */
    low?: boolean;
    /** 早上那句梦（2026-10-31）：联系人流水线原位读梦（同时取梦给心境的打分）后写；App 只给男朋友档、开了 herFeelings，危机回合没有。modules/feelings.ts 放进 dreams 槽 */
    dreamLine?: string;
    /** 梦给心境的打分（和 dreamLine 同一处读）：modules/feelings.ts 的 decideAt.feelings 算心境时加进去 */
    dreamAppraisals?: readonly Appraisal[];
    /** 这一轮她心里的感受（ADR 0102，分量从大到小）：modules/feelings.ts 的 decideAt.feelings 写；流水线的 low、生成时最多几条读。没开心境、不是男朋友档、危机回合没有 */
    felt?: Felt[];
    /** 心境那一行（ADR 0102，QQ 这一句的写法：他在关心她时绷不住）：旧逻辑在小别扭是否生效之后原位算后写；男朋友档、开了 herFeelings、不是危机、小别扭没生效才有。modules/feelings.ts 放进 feeling 槽 */
    feelingLine?: string;
    /** 心境 → 说话的量（2026-10-30）：和心境那一行同一处、同样的条件；modules/feelings.ts 放进 pace 槽。生成时的最多几条还在旧逻辑 */
    paceLine?: string;
    /** 记忆这一组（ADR 0012 / 0016–0020 / 0032 / 0043 / 0176 / 0177）：联系人流水线原位召回 / 读好的几段（她的名字已换成「你」；召回的 await、关系概况和印象读缓存后台重读、要点的后台整理、召回日志都留在原位），
     *  modules/memory.ts 照原样放进各自的槽，有 common / today / people 时接 disclosure。没有的不写（desktop 不要长期记忆，跟着 crossRecent） */
    memory?: MemoryPieces;
    /** 召回的结果（modules/memory.ts 的 decideAt.recall 写；她的名字已换成「你」）：流水线后面拼上要点和那一天，成为 memory */
    recall?: Omit<MemoryPieces, 'summary' | 'recap'>;
    /** 他问到的那一天 / 那一段（ADR 0018 / 0032，decideAt.recall 写）：问到的是某一天时，流水线放那天她那边的流水账 */
    askedDay?: AskedWindow;
    /** 他问到的那一天她那边的流水账（ADR 0032，modules/memory.ts 的 decideAt.recap 写）：拼进 memory.recap */
    recap?: string;
    /** 这一轮放进提示词的聊天原文和没放的条数（modules/memory.ts 的 decideAt.context 写；只想一想时是空的） */
    shown?: { chat: ChatMessage[]; omitted: number };
    /** 她在 QQ 上的样子（ADR 0083）：联系人流水线原位取（presence 的内存状态，后台 tick 会改，不挪过 await）后写；modules/time-notes.ts 放进 selfNote 槽 */
    selfNote?: string;
    /** 她答应过他、还没做的事那一句（ADR 0018 决策 2）：和 promised 同一处写（读承诺状态、记日志）；modules/time-notes.ts 放进 promised 槽 */
    promisedLine?: string;
    /** 图片表情清单（ADR 0063 / 0132）：在所有 contribute 之前原位取（货架查索引 / 文件、会抛错；条件一次、内容一次）；modules/media-offers.ts 放进 sticker 槽 */
    stickerLine?: string;
    /** 照片清单（ADR 0109 / 0128 / 0240）：同上（照片货架每次重读索引）；modules/media-offers.ts 放进 photo 槽 */
    photoLine?: string;
    /** 「/亲热」那一行（ADR 0170）：原位取（每取一次扣一条、写文件），主动找他、危机回合不取；modules/intent-line.ts 放进 intimate 槽 */
    intimateLine?: string;
    /** 这一轮允许发图片表情（ADR 0063 / 0132）：联系人流水线按档位、危机、被吵醒、他难过、这一轮发照片……算好后写；
     *  清理时 modules/media-offers.ts 按它决定留不留一个认识的编号。不允许时没有 */
    stickersAllowed?: boolean;
    /** 这一轮发的吃的照片是哪道菜（ADR 0128）：和 photo 同一处写，只有发照片、有菜名时有；清理时核对编号是不是这道菜的 */
    photoDish?: string;
    /** 「现在的照片」有一张审核通过、和此刻精确匹配的（ADR 0240）：只给模型这一张的那一段清单；有它时 photo 一定有。modules/media-offers.ts 的 decideAt.photo 写 */
    photoPrompt?: string;
    /** 他明确要「现在」的照片，但没有已审核的匹配图：这一轮的意图改成如实说发不了（不拿旧图冒充） */
    photoUnavailable?: boolean;
    /** 这一轮挑候选的规则（ADR 0041，modules/candidates.ts 在 contribute 时写）：他难过、说亲密话、收尾的轮次才有；联系人流水线生成时经 candidatePlan 问 */
    pick?: PickRules;
    /** 这一轮发出去之前加质感用的上下文（ADR 0131 / 0134）：他这一串说的话、是不是认真的回合、她最近几次回复里带了几次小黄脸 / 句尾「～」。
     *  modules/decorate.ts 的质感模块在 decideAt.texture 写（开了 texture、男朋友档、不是只想一想才有），修饰时读 */
    texture?: { said: string; serious: boolean; recentFaces: number; recentTildes: number };
}

/** 一轮回复：谁、什么时候、聊天记录、这一轮是不是她主动找他 / 被吵醒 / 只想一想 */
export interface Turn {
    readonly contact: Contact;
    readonly at: Date;
    readonly history: readonly ChatMessage[];
    readonly initiate?: BuildContext['initiate'];
    readonly woken?: boolean;
    readonly offlineSince?: number;
    /** 只想一想（ADR 0101 内心）：不是在聊天 */
    readonly thinking: boolean;
    /** 这一轮用的卡（分档位：她那边、身体、作息按这一档的卡算）；危机回合换的承认版卡只换说话的部分，这里仍是原卡。不经联系人流水线建的轮次（测试）可以没有 */
    readonly card?: Character;
    readonly facts: TurnFacts;
}

export interface Module {
    id: string;
    /** 处理事件（收到消息、戳、撤回、好友申请、连上 NapCat） */
    on?: EventHandlers;
    /** 先看清她此刻（她那边、身体、在干嘛），写进 turn.facts；在所有 assess 之前 */
    perceive?(turn: Turn): Maybe<void>;
    assess?(turn: Turn): Maybe<void>;
    contribute?(turn: Turn): Maybe<readonly Piece[]>;
    review?(draft: string, turn: Turn): Maybe<string>;
    /**
     * 判断那一串（ADR 0336「判断那一串」）：assess 之后、拼段落之前，挂在判断顺序表（DECIDE_STAGES）的某几个位置，读前面写下的事实、把自己的判断写进 turn.facts。
     * 一般同步；这一轮真要等外部（语义路由问小模型）时才返回 promise，流水线只在那时等
     */
    decideAt?: Partial<Record<DecideStage, (turn: Turn, ctx: DecideCtx) => Maybe<void>>>;
    /**
     * 挑候选（ADR 0336「生成之后那一段」第 10 步）：这一轮要不要同一份提示词生成几个、挑一个。不挑就不返回；
     * 联系人流水线在生成时问一次，按 count 生成、各清理一次，把清理过的字交给 choose
     */
    candidates?(turn: Turn): CandidatePlan | undefined;
    /**
     * 清理（ADR 0336「生成之后那一段」第 9 步）：挂在清理顺序表（CLEAN_STAGES）的某几个位置，同步、文字进文字出。
     * 生成的每一稿都清一次（挑候选的每一个、审稿的每次重写、回复器清理的那一稿）：次数是行为，货架清理会查索引、记日志
     */
    cleanAt?: Partial<Record<CleanStage, (text: string, turn: Turn, ctx: CleanCtx) => string>>;
    /**
     * 生成之后的审稿（ADR 0336「生成之后那一段」）：挂在审稿顺序表（REVIEW_STAGES）的某几个位置，按位置、再按模块注册顺序跑。
     * 返回改过的稿子；要这一轮到此为止（事实检查删光了、危机回合）就返回 { text, stop: true }
     */
    reviewAt?: Partial<Record<ReviewStage, (text: string, turn: Turn, ctx: ReviewCtx) => Maybe<string | ReviewVerdict>>>;
    /**
     * 修饰（ADR 0336「生成之后那一段」第 11 步）：审稿完、拆好条之后、发出去之前，挂在修饰顺序表（DECORATE_STAGES）的某几个位置，同步、几条气泡进几条气泡出。
     * 要带出「撤回改口」的打算（打错字，ADR 0086）就返回 { parts, recall }
     */
    decorateAt?: Partial<Record<DecorateStage, (parts: string[], turn: Turn, ctx: DecorateCtx) => string[] | Decorated>>;
    /**
     * 回复里的内部标记（ADR 0336「生成之后那一段」第 12 步）：每条气泡发出去之前（整条只有标记、不发的气泡也一样），挂在标记处理顺序表（ABSORB_STAGES）的某几个位置，
     * 把自己的标记从字里摘掉、该办的事办了，返回剩下的字。同步；要等的事（写记忆、跑命令、去干活）不等它
     */
    absorbAt?: Partial<Record<AbsorbStage, (text: string, contact: Contact) => string>>;
    /** 定时要做的事：解释器在 startSchedules 时经执行器开计时器，stop 时关 */
    schedules?: readonly { every: number; run: () => void }[];
    /** 停下：拒绝新工作；返回等已派发的活收尾的 promise（没有就不返回） */
    stop?(): Promise<void> | undefined;
    /** 控制台状态页的补充（不含聊天内容） */
    status?(): Record<string, unknown>;
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';

/** 按顺序对每一项做 step；都同步就同步返回，遇到第一个 promise 才转成异步、之后逐个等 */
function sequence<T, R>(items: readonly T[], step: (item: T, acc: R) => Maybe<R>, initial: R): Maybe<R> {
    let acc = initial;
    for (let i = 0; i < items.length; i++) {
        const next = step(items[i]!, acc);
        if (isThenable(next)) {
            return (async () => {
                acc = await next;
                for (let j = i + 1; j < items.length; j++) acc = await step(items[j]!, acc);
                return acc;
            })();
        }
        acc = next;
    }
    return acc;
}

type Assembled = { afterMain: string[]; afterHistory: string[] };

/** 按顺序对每个模块调 hook（都同步时同步返回） */
function eachModule(modules: readonly Module[], hook: (module: Module) => Maybe<void> | undefined): Maybe<void> {
    const done = sequence<Module, null>(modules, module => {
        const result = hook(module);
        return isThenable(result) ? Promise.resolve(result).then(() => null) : null;
    }, null);
    return isThenable(done) ? Promise.resolve(done).then(() => undefined) : undefined;
}

/** 第一个阶段：按顺序让每个模块看清她此刻、写进 turn.facts（都同步时同步返回） */
export function perceiveTurn(modules: readonly Module[], turn: Turn): Maybe<void> {
    return eachModule(modules, module => module.perceive?.(turn));
}

/** 第二个阶段：按顺序让每个模块往 turn.facts 写判断（都同步时同步返回） */
export function assessTurn(modules: readonly Module[], turn: Turn): Maybe<void> {
    return eachModule(modules, module => module.assess?.(turn));
}

/** 第三个阶段：收各模块的段落，按槽位表拼成 afterMain / afterHistory（不再 assess） */
export function contributeTurn(modules: readonly Module[], turn: Turn): Maybe<Assembled> {
    const collected = sequence<Module, Piece[]>(modules, (module, pieces) => {
        const mine = module.contribute?.(turn);
        if (isThenable(mine)) return Promise.resolve(mine).then(list => [...pieces, ...list]);
        return mine ? [...pieces, ...mine] : pieces;
    }, []);
    return isThenable(collected) ? Promise.resolve(collected).then(assemblePrompt) : assemblePrompt(collected);
}

/** 一轮回复的前三个阶段连着做：所有模块先 perceive、再 assess、再 contribute。
 * 旧逻辑要在阶段之间读模块写下的事实时，分开调 perceiveTurn / assessTurn / contributeTurn（contact.ts） */
export function runTurn(modules: readonly Module[], turn: Turn): Maybe<Assembled> {
    const perceived = perceiveTurn(modules, turn);
    if (isThenable(perceived)) return Promise.resolve(perceived).then(() => runAfterPerceive(modules, turn));
    return runAfterPerceive(modules, turn);
}

function runAfterPerceive(modules: readonly Module[], turn: Turn): Maybe<Assembled> {
    const assessed = assessTurn(modules, turn);
    return isThenable(assessed) ? Promise.resolve(assessed).then(() => contributeTurn(modules, turn)) : contributeTurn(modules, turn);
}

/**
 * 一稿（ADR 0336「生成之后那一段」第 8 步）：要发出去的字和它带的设备指令（ADR 0148）分开。联系人流水线清理时把指令从字里摘出来放进 devices；
 * 审稿模块只改字，设备指令跟着「选中的那一稿」走（采用了重写 accept 就换成重写稿的，危机回合 dropDevices 就不带），发送前只登记选中那一稿的
 */
export interface Draft {
    readonly text: string;
    /** 摘出来的设备指令；没开设备控制时没有 */
    readonly devices?: ParsedTokens;
}

/**
 * 判断那一串的顺序（ADR 0336「判断那一串」）：assess 之后、拼段落之前，联系人流水线里还剩一串互相接着的判断（照片 → 最终的意图 → 心境 → 图片表情 → 深思……），
 * 一个个迁成模块；先后由这张表定（照搬流水线里手写的顺序），表随迁出逐个加长
 */
export const DECIDE_STAGES = ['values', 'recall', 'recap', 'promises', 'loops', 'news', 'photo', 'dream', 'intent', 'feelings', 'continuity', 'stickers', 'deliberate', 'length', 'intimate', 'texture', 'context', 'lists'] as const;
export type DecideStage = (typeof DECIDE_STAGES)[number];

/** 判断时联系人流水线给的东西（这个联系人的货架之类；字段随模块迁出逐个加） */
export interface DecideCtx {
    /** 有真人数值（ADR 0222，App 在有需要锚点时才给）才有：这一刻的数值、算人格成长层（ADR 0251）要的世界账事件 */
    values?: {
        humanValues: (context: { contact: Contact; history: Turn['history']; at: Date }) => HumanValues | undefined;
        worldEvents?: () => ReturnType<NonNullable<WorldState['events']>>;
    };
    /** 召回要的（ADR 0012 / 0016–0020 / 0177 / 0218）：长期记忆（开了、名单里的人才有）、名单、她的一天按哪份作息算、那天的感觉、群里 / DSH 桌面上最近的 */
    recall?: {
        memory?: LongTermMemory;
        /** 名单（不给时按空名单；公共记忆按「名单 ?? 只有他」查） */
        contacts?: readonly Contact[];
        schedule?: Schedule;
        /** 某天她心里有依据的感觉（开了 memoryFeelings、男朋友档才给） */
        feltOnDay?: (dayStart: Date) => Felt[];
        /** 设备所有者在当前私聊明确问起已配置的某个群时，按需查该群公开日程或公告（可能要等） */
        groupRecent?: (question: string, at: Date) => string | undefined | Promise<string | undefined>;
        desktopRecent?: (at: Date) => string | undefined;
    };
    /** 他问到过去的某一天（ADR 0032）：那天她那边的流水账（按这一档的卡、那天的世界 / 身体 / 改了的打算 / 日记 / 感觉；只到 7 天前，没有就是 undefined） */
    recapOf?: (dayStart: Date, time: Date) => { day: string; lines: string[]; text: string } | undefined;
    /** 她在 QQ 上的样子（ADR 0083，presence 的内存状态） */
    selfNote?: (now: number) => string | undefined;
    /** 她答应的事（ADR 0018 决策 2）、挂着的事（ADR 0023）：读承诺状态（可能读文件、记日志）；名单外的人不查由模块看 */
    promises?: Pick<PromiseKeeper, 'describe'> & Partial<Pick<PromiseKeeper, 'openLoops'>>;
    /** 梦（2026-10-31）：那一行和它给心境的打分（读状态） */
    dreams?: () => { appraisals: Appraisal[]; line?: string };
    /** 连续性（ADR 0157–0163）：异步——上网、调模型、记「已告诉他」；停下时抛 AbortError */
    continuity?: (context: { contact: Contact; said: string; initiating: boolean; now: Date }) => Promise<string[]>;
    /** 「/亲热」（ADR 0170）那一行：每取一次扣一条、写状态文件 */
    intimacyLine?: () => string | undefined;
    /** 聊天原文放多少（ADR 0018 调整 12 / ADR 0043）：开了长期记忆、名单里的人才只放最近几天（recentOnly）；配置 contextTurns 时更早的换成要点（summarize 会在后台起一次整理） */
    context?: { recentOnly: boolean; window?: TurnWindow & { summarize: Summarizer }; /** 名单（要点里她的名字换成「你」时看有没有别的女生） */ contacts?: readonly Contact[] };
    /** 清单的取（ADR 0063 / 0109 / 0240）：图片表情收藏库、照片货架的 prompt（每取一次都查索引 / 文件，坏了会抛错） */
    lists?: { stickers?: (context: { text: string; only?: boolean }) => string | undefined; photos?: (kind: PhotoKind, dish?: string) => string | undefined };
    /** 这个联系人有图片表情收藏库（ADR 0063）时才有：这一轮抽不抽的几个比例（不写用默认；uncued / onlyChance 不写就是不抽） */
    stickers?: { chance?: number; uncued?: number; onlyChance?: number };
    /** 作息（开了她自己的日子才有）：今天的心情按它算 */
    schedule?: Schedule;
    /** 指定今天的心情（只有模拟器比较不同心情时给） */
    mood?: string;
    /** 开了深思（配置 deliberate，ADR 0151）才有：深思用的模型名（日志里写）、语义路由的分类（配置 depthRouting，ADR 0202；一次小模型调用） */
    deliberate?: { model: string; turnWeight?: (input: { history: ChatMessage[]; said: string }) => Promise<TurnWeight | undefined> };
    /** 这个联系人存下来的聊天记录（判断的那一刻现读：她最近几次回复带了几次小黄脸之类） */
    history: () => readonly StoredMessage[];
    /** 算心境要的、按联系人给的那几样（ADR 0102 / 0104 / 0106）；条件（开没开、档位、危机）在模块里看 */
    feelings?: {
        /** 开了心境（配置 herFeelings） */
        herFeelings: boolean;
        /** 开了今天的小事（她的追求里小测那一条读它） */
        everydayLife: boolean;
        /** 作息（开了她自己的日子才有）：她的一天从几点算 */
        schedule?: Schedule;
        /** 她的追求（ADR 0104）：作者的文件加内置的两条 */
        pursuits?: () => readonly Pursuit[];
        /** 带结算的世界账里的事件（她的追求的进度读它） */
        worldEvents?: () => ReturnType<NonNullable<WorldState['events']>>;
        /** 某一刻她那边（带结算的世界账优先，没有就按卡现算）：算「前一天结束时」用 */
        worldAt: (herWorld: NonNullable<Character['herWorld']>, schedule: Schedule, at: Date) => WorldNow | undefined;
        /** 作者写下的事 */
        moments?: () => readonly Moment[];
        /** 她聊完回想记下的感受（ADR 0197） */
        feelingReview?: () => readonly Appraisal[];
        /** 群里的遭遇 */
        groupMood?: () => readonly Appraisal[];
        /** 交给桌面上的她（ADR 0197） */
        onFeelings?: (report: FeelingsReport) => void;
    };
    /** 照片货架（ADR 0109）：有没有这一类、列出来找审核过的那一张；没开、不是男朋友档时没有 */
    photos?: Pick<PhotoShelf, 'has' | 'list'>;
    /** 「现在的照片」的解析（ADR 0240）：只有已审核、和此刻匹配的才能发 */
    currentAiPhoto?: (request: { kind: PhotoKind; dish?: string; at: Date; world: WorldNow }) => CurrentAiPhotoResult;
    log: (line: string) => void;
}

/** 判断顺序表上的一个位置：挂在这里的模块按注册顺序跑；都同步时同步返回，碰到第一个返回 promise 的才转成异步（同 contributeTurn） */
export function decideStage(modules: readonly Module[], stage: DecideStage, turn: Turn, ctx: DecideCtx): Maybe<void> {
    const mine = modules.filter(module => module.decideAt?.[stage]);
    // 只有一个模块挂在这里（现在每个位置都是）：它返回的 promise 原样交回，不再包 .then——召回那一串原来内联在流水线里，
    // 每多包一层就多一拍微任务，后台记忆任务的日志就会插到这一轮前面（行为基线 memory 场景核对，2026-11-18）
    if (mine.length === 1) return mine[0]!.decideAt![stage]!(turn, ctx);
    return eachModule(mine, module => module.decideAt?.[stage]?.(turn, ctx));
}

/** 挑候选的打算（ADR 0041）：生成几个、怎么挑。choose 拿到的是每个候选清理之后的字（顺序同生成），返回挑中的下标；日志是这个联系人的 */
export interface CandidatePlan {
    count: number;
    choose(cleaned: readonly string[], log: (line: string) => void): number;
}

/** 这一轮挑不挑候选：按注册顺序问，第一个有打算的模块说了算；都没有就只生成一个 */
export function candidatePlan(modules: readonly Module[], turn: Turn): CandidatePlan | undefined {
    for (const module of modules) {
        const plan = module.candidates?.(turn);
        if (plan) return plan;
    }
    return undefined;
}

/**
 * 清理的顺序（ADR 0336「生成之后那一段」第 9 步）：同 slots.ts / REVIEW_STAGES，先后由这张表定。照搬迁移前联系人流水线里手写的顺序：
 * 图片表情（留一个认识的编号、去掉多的）→ 照片（只留这一轮那一类的一张）→ 只发表情的轮次只留表情那一行。
 * 在这之前联系人流水线先摘设备指令（摘出来成 Draft.devices）、过卡上的 ST 正则（cleanUpReply，卡的一部分），这两步不在表上
 */
export const CLEAN_STAGES = ['stickers', 'photos', 'stickerOnly'] as const;
export type CleanStage = (typeof CLEAN_STAGES)[number];

/** 清理时联系人流水线给的东西：这个联系人的两个货架（清单的取、聊天记录的写法也还在流水线里用，所以货架仍是流水线的选项）；没给就没有 */
export interface CleanCtx {
    stickers?: Pick<StickerShelf, 'clean'>;
    photos?: Pick<PhotoShelf, 'clean'>;
}

/** 按清理顺序表清一稿：每个位置上挂了 cleanAt 的模块按注册顺序跑；同步 */
export function cleanStages(modules: readonly Module[], text: string, turn: Turn, ctx: CleanCtx): string {
    let cleaned = text;
    for (const stage of CLEAN_STAGES) {
        for (const module of modules) {
            const step = module.cleanAt?.[stage];
            if (step) cleaned = step(cleaned, turn, ctx);
        }
    }
    return cleaned;
}

/**
 * 修饰的顺序（ADR 0336「生成之后那一段」第 11 步）：同 slots.ts / REVIEW_STAGES / CLEAN_STAGES，先后由这张表定。照搬迁移前联系人流水线里手写的顺序：
 * 先加质感（ADR 0131），再打错字（ADR 0024；打错字认的是汉字，不碰小黄脸 / 标点）
 */
export const DECORATE_STAGES = ['texture', 'typo'] as const;
export type DecorateStage = (typeof DECORATE_STAGES)[number];

/** 修饰时联系人流水线给的东西 */
export interface DecorateCtx {
    /** 拆好条、还没修饰的原稿：按哈希定的修饰拿它当种子（同一句话结果固定，不随前面的修饰变） */
    original: readonly string[];
    /** 这一轮最多几条气泡（加一条单独的反应、补「*对的词」要有空位） */
    maxBubbles: number;
    /** 这个联系人发出去的消息能不能撤回（配置 selfRecall、NapCat 支持）：打错字能不能改成撤回重发 */
    canRecall: boolean;
    log: (line: string) => void;
}

/** 修饰的结果带「撤回改口」的打算时（回复器照它撤回打错的那条、重发对的） */
export interface Decorated { parts: string[]; recall?: TypoRecall }

/** 按修饰顺序表修饰拆好的几条：每个位置上挂了 decorateAt 的模块按注册顺序跑；同步。没有模块挂时原样返回传进来的数组；有撤回改口的打算时返回 { parts, recall } */
export function decorateStages(modules: readonly Module[], parts: string[], turn: Turn, ctx: DecorateCtx): string[] | Decorated {
    let shaped = parts;
    let recall: TypoRecall | undefined;
    for (const stage of DECORATE_STAGES) {
        for (const module of modules) {
            const step = module.decorateAt?.[stage];
            if (!step) continue;
            const out = step(shaped, turn, ctx);
            if (Array.isArray(out)) shaped = out;
            else {
                shaped = out.parts;
                if (out.recall) recall = out.recall;
            }
        }
    }
    return recall ? { parts: shaped, recall } : shaped;
}

/**
 * 回复里内部标记的处理顺序（ADR 0336「生成之后那一段」第 12 步）：同别的顺序表，先后由这张表定。照搬迁移前 app.ts 的 absorbMarkers 里手写的顺序：
 * 她自己记的（<<记住>> / <<日记>> / <<私密>>）→ 语音（<<语音>>）→ 跑命令（<<执行>>）→ 切工作（<<同意工作>> / <<拒绝工作>>）→ 动电脑（<<用电脑>>）→ 他的请求（<<同意>> / <<拒绝>>）。
 * voice 这个位置没有模块：语音是用户自己的代码，原样留在 App 里，App 在 notes 之后、shell 之前做
 */
export const ABSORB_STAGES = ['notes', 'voice', 'shell', 'workSwitch', 'work', 'consent'] as const;
export type AbsorbStage = (typeof ABSORB_STAGES)[number];

/** 标记处理顺序表上的一个位置：挂在这里的模块按注册顺序跑；同步，没有模块挂时原样返回 */
export function absorbStage(modules: readonly Module[], stage: AbsorbStage, text: string, contact: Contact): string {
    let rest = text;
    for (const module of modules) {
        const step = module.absorbAt?.[stage];
        if (step) rest = step(rest, contact);
    }
    return rest;
}

/**
 * 审稿的顺序（ADR 0336「生成之后那一段」）：同 slots.ts，先后由这张表定，不由模块决定。照搬迁移前联系人流水线里手写的顺序：
 * 逐条事实检查 → 出口检查（危机回合走危机检查、到此为止）→ <<查>> → 形状裁剪 → 话说到一半 → 删行收尾 → 最后再查一次事实
 */
export const REVIEW_STAGES = ['facts', 'exit', 'pull', 'shape', 'unfinished', 'finalize', 'factsFinal'] as const;
export type ReviewStage = (typeof REVIEW_STAGES)[number];

/** 审稿时联系人流水线给的东西；字段随审稿模块迁出逐个加 */
export interface ReviewCtx {
    /** 在这一轮的提示词后面加一句说明，重新生成一次（已经清理过：设备指令摘了、正则过了）；返回新稿 */
    regenerate(note: string): Promise<string>;
    /** 采用了刚才那次重写：选中的那一稿（Draft）换成重写稿，设备指令跟着换成重写稿的 */
    accept(): void;
    /** 这一轮不操作他的设备：草稿和重写里的设备指令都不登记（危机回合，ADR 0068 / 0148）；出口检查模块（modules/review-exit.ts）在危机回合调 */
    dropDevices(): void;
    /** 出口检查要的、按联系人 / 配置给的几样：查不查说话的毛病（配置 speechCheck）、句尾语气词封顶（tailCap）、这个联系人有没有图片表情收藏库。联系人流水线总是给；不经流水线建的（测试）可以没有 */
    exit?: { speechCheck: boolean; tailCap: boolean; imageStickers: boolean };
    /** 这个联系人存下来的聊天记录，审稿的那一刻现读（说话的毛病、小黄脸带得密不密） */
    history?: () => readonly StoredMessage[];
    /** 这一轮拼出来的提示词（ST 后处理之前，system 还是 system）：事实检查（modules/review-facts.ts）拿它当「她能依据的事实」；拼提示词没走到时没有 */
    promptSource?: readonly OpenAIMessage[];
    /** 他 / 她的名字（审稿提示词里聊天记录的称呼） */
    names?: { user: string; char: string };
    /** 主动找他的这一轮（事实检查删光了可以整条不发） */
    initiating?: boolean;
    /** 固定说法、允许重复（事实检查、出口检查的重复规则不查） */
    allowRepeat?: boolean;
    /** 审稿模块之间这一轮共用的东西 */
    scratch: ReviewScratch;
    log: (line: string) => void;
}

export interface ReviewVerdict { text: string; stop?: true }

/** 审稿模块之间这一轮共用的东西（同 TurnFacts：写的在前、读的在后；字段随审稿模块迁出逐个加） */
export interface ReviewScratch {
    /** 出口检查那一刻算好的上下文（禁用词、说话的毛病——聊天记录在那一刻读、书、小黄脸……）：出口检查模块在 exit 位置算好后写；
     *  出口检查（modules/review-exit.ts）和删行收尾（modules/review-finalize.ts）都用这一份，不重读聊天记录 */
    exitOptions?: ReviewOptions;
    /** 第一次事实检查（facts 位置）查完的稿子：事实检查模块写，factsFinal 只在稿子跟它不一样时再查；没查（危机、固定说法、没开）就没有 */
    factsChecked?: string;
}

/**
 * 审稿顺序表上的一个位置：挂在这里的模块按注册顺序跑；返回 stop 时后面的不跑。
 * 都是同步返回时整个也同步返回（没挂模块、模块这一轮不用做事时不多一个微任务，同 contributeTurn）；碰到第一个异步的才转成 promise
 */
export function reviewStage(modules: readonly Module[], stage: ReviewStage, draft: string, turn: Turn, ctx: ReviewCtx): Maybe<ReviewVerdict> {
    const steps = modules.map(module => module.reviewAt?.[stage]).filter((step): step is NonNullable<typeof step> => Boolean(step));
    // 吃进一步的结果：stop 就停（返回结论），否则返回下一步要审的稿子
    const take = (out: string | ReviewVerdict): string | ReviewVerdict => (typeof out === 'string' ? out : out.stop ? { text: out.text, stop: true } : out.text);
    let text = draft;
    for (let i = 0; i < steps.length; i++) {
        const out = steps[i]!(text, turn, ctx);
        if (isThenable(out)) {
            return (async () => {
                let next = take(await out);
                for (let j = i + 1; ; j++) {
                    if (typeof next !== 'string') return next;
                    if (j >= steps.length) return { text: next };
                    next = take(await steps[j]!(next, turn, ctx));
                }
            })();
        }
        const taken = take(out);
        if (typeof taken !== 'string') return taken;
        text = taken;
    }
    return { text };
}

/** 第四个阶段：草稿按模块顺序逐个 review */
export function reviewTurn(modules: readonly Module[], draft: string, turn: Turn): Maybe<string> {
    return sequence(modules, (module, text) => module.review ? module.review(text, turn) : text, draft);
}

export interface Interpreter {
    readonly modules: readonly Module[];
    /** 把事件交给每个有对应处理的模块（按注册顺序）；只有一个返回 promise 时原样返回它，几个时等全部 */
    dispatch(event: BotEvent): Maybe<void>;
    /** 实现了 perceive / assess / contribute / review / reviewAt / cleanAt / candidates / decorateAt 的模块（一轮回复时用） */
    readonly turnModules: readonly Module[];
    /** 开各模块的定时任务（重复调用不重开） */
    startSchedules(): void;
    /** 停下：关定时任务，按注册顺序停各模块；返回各模块的收尾（没有的不在里面） */
    stop(): Promise<void>[];
    /** 各模块的状态补充，按注册顺序合在一起 */
    status(): Record<string, unknown>;
    /** 有没有模块给状态补充 */
    readonly hasStatus: boolean;
}

export function createInterpreter(options: { modules: readonly Module[]; exec: Pick<Executor, 'every' | 'cancel'> }): Interpreter {
    const ids = new Set<string>();
    for (const module of options.modules) {
        if (ids.has(module.id)) throw new Error(`模块 id 重复：${module.id}`);
        ids.add(module.id);
    }
    const modules = [...options.modules];
    const turnModules = modules.filter(module => module.perceive || module.assess || module.contribute || module.review || module.reviewAt || module.cleanAt || module.candidates || module.decorateAt || module.decideAt);
    const { exec } = options;
    let timers: ReturnType<Executor['every']>[] | undefined;
    return {
        modules,
        turnModules,
        hasStatus: modules.some(module => module.status),
        startSchedules() {
            if (timers) return;
            timers = [];
            for (const module of modules) {
                for (const schedule of module.schedules ?? []) {
                    const timer = exec.every(schedule.run, schedule.every);
                    timer.unref?.();
                    timers.push(timer);
                }
            }
        },
        stop() {
            for (const timer of timers ?? []) exec.cancel(timer);
            timers = timers ? [] : undefined;
            const drains: Promise<void>[] = [];
            for (const module of modules) {
                const drain = module.stop?.();
                if (drain) drains.push(drain);
            }
            return drains;
        },
        status() {
            return Object.assign({}, ...modules.map(module => module.status?.() ?? {})) as Record<string, unknown>;
        },
        dispatch(event) {
            const pending: PromiseLike<unknown>[] = [];
            for (const module of modules) {
                const handler = module.on?.[event.kind] as ((event: BotEvent) => Maybe<void>) | undefined;
                if (!handler) continue;
                const result = handler(event);
                if (isThenable(result)) pending.push(result);
            }
            if (pending.length === 0) return undefined;
            if (pending.length === 1) return pending[0] as Promise<void>;
            return Promise.all(pending).then(() => undefined);
        },
    };
}
