// 解释器（ADR 0263）：唯一做判断的地方。这里只有骨架——事件分发、一轮回复的三个阶段、提示词槽位的排序与拼接、模块注册；
// 具体功能一律写成模块（Module），不写在骨架里。碰外部的事交给执行器（executor/executor.ts）。
//
// 一轮回复的三个阶段（每个模块都可以只实现其中几个）：
// 1. assess：往这一轮写判断（turn.facts）——是不是危机、意图、形状……；后面的模块读前面写下的，模块之间不互相 import 内部函数。
// 2. contribute：往提示词的具名槽位里放段落（slots.ts）；先后由槽位表定，模块不管。
// 3. review：拿到草稿之后改一改（出口检查、事实检查、句尾封顶……）。
//
// 迁移期（ADR 0263 第 4 步）：每个钩子都同步时整轮也同步返回、不多等一个微任务；分发只有一个处理函数返回 promise 时原样返回它。
// 这样经解释器走和原来直接调用逐字等价（行为基线核对）。

import type { Contact } from '../platform/config.ts';
import type { GroupMessageEvent, MessageEvent, PokeEvent, RecallEvent } from '../platform/onebot.ts';
import type { ChatMessage } from '../language/prompt.ts';
import type { ResponderDeps } from '../social/responder.ts';
import type { CrisisHit } from '../emotion/crisis.ts';
import type { Grievance } from '../emotion/grievance.ts';
import type { Executor } from '../executor/executor.ts';
import type { WorldNow } from '../world/world.ts';
import type { Together } from '../language/together.ts';
import type { Schedule, State } from '../life/schedule.ts';
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
 * 这一轮回复在判断的事实。字段随模块迁出逐个加上（ADR 0263 第 5 步）：
 * 写的模块在 assess 里写，读的模块在 contribute / review 里读。
 */
export interface TurnFacts {
    /** 危机信号（ADR 0068）；主动找他时不算 */
    crisis?: CrisisHit;
    /** 小别扭 / 和好的起因（ADR 0074）；只算男朋友档，危机、主动找他时没有 */
    grievance?: Grievance;
    /** 这一轮的意图行（意图阶梯，modules/intent.ts 写；照片 / 被打断改写之前的那一版）；只想一想时没有 */
    baseIntent?: string;
    /** 她那边此刻（ADR 0021 世界账：猫、快递、钱、今天的小事……）；开了她自己的日子、卡上有世界才有 */
    world?: WorldNow;
    /** 她此刻在干嘛（作息里的这一刻）；开了作息才有 */
    state?: State;
    /** 作息（快睡了“回两句就去忙”按它算）；开了作息或卡上有她的一天才有 */
    schedule?: Schedule;
    /** 时间块里已经有「她答应的事」（ADR 0018） */
    promised?: boolean;
    /** 挂着的事（ADR 0023）：在等他说结果的事、她问了他没答的；开了长期记忆才有 */
    waiting?: readonly string[];
    unanswered?: readonly string[];
    /** 她那边今天了结了、还没跟他说过的事（ADR 0057）；只算男朋友档 */
    news?: readonly string[];
    /** 被打断（ADR 0115，modules/interruptions.ts 写）：聊着的时候她那边刚发生的一件小事；旧逻辑读它决定这一轮不带意图 / 深思 / 形状 / 长短 */
    interruption?: { text: string; minutesAgo: number };
    /** 陪玩（ADR 0111，modules/together.ts 写）：此刻正和他一起玩什么、从哪一刻答应的 */
    together?: Together;
    /** 网络热梗（ADR 0129，modules/memes.ts 在 contribute 时写）：这一轮放进提示词的那一行；梗百科（旧逻辑）读它，不重复给同一个词 */
    meme?: string;
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
    readonly facts: TurnFacts;
}

export interface Module {
    id: string;
    /** 处理事件（收到消息、戳、撤回、好友申请、连上 NapCat） */
    on?: EventHandlers;
    assess?(turn: Turn): Maybe<void>;
    contribute?(turn: Turn): Maybe<readonly Piece[]>;
    review?(draft: string, turn: Turn): Maybe<string>;
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

/** 第一个阶段：按顺序让每个模块往 turn.facts 写判断（都同步时同步返回） */
export function assessTurn(modules: readonly Module[], turn: Turn): Maybe<void> {
    const assessed = sequence<Module, null>(modules, module => {
        const done = module.assess?.(turn);
        return isThenable(done) ? Promise.resolve(done).then(() => null) : null;
    }, null);
    return isThenable(assessed) ? Promise.resolve(assessed).then(() => undefined) : undefined;
}

/** 第二个阶段：收各模块的段落，按槽位表拼成 afterMain / afterHistory（不再 assess） */
export function contributeTurn(modules: readonly Module[], turn: Turn): Maybe<Assembled> {
    const collected = sequence<Module, Piece[]>(modules, (module, pieces) => {
        const mine = module.contribute?.(turn);
        if (isThenable(mine)) return Promise.resolve(mine).then(list => [...pieces, ...list]);
        return mine ? [...pieces, ...mine] : pieces;
    }, []);
    return isThenable(collected) ? Promise.resolve(collected).then(assemblePrompt) : assemblePrompt(collected);
}

/** 一轮回复的前两个阶段连着做：所有模块先 assess、再 contribute。
 * 旧逻辑要在两个阶段之间读模块写下的判断时，分开调 assessTurn / contributeTurn（contact.ts） */
export function runTurn(modules: readonly Module[], turn: Turn): Maybe<Assembled> {
    const assessed = assessTurn(modules, turn);
    return isThenable(assessed) ? Promise.resolve(assessed).then(() => contributeTurn(modules, turn)) : contributeTurn(modules, turn);
}

/** 第三个阶段：草稿按模块顺序逐个 review */
export function reviewTurn(modules: readonly Module[], draft: string, turn: Turn): Maybe<string> {
    return sequence(modules, (module, text) => module.review ? module.review(text, turn) : text, draft);
}

export interface Interpreter {
    readonly modules: readonly Module[];
    /** 把事件交给每个有对应处理的模块（按注册顺序）；只有一个返回 promise 时原样返回它，几个时等全部 */
    dispatch(event: BotEvent): Maybe<void>;
    /** 实现了 assess / contribute / review 的模块（一轮回复时用） */
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
    const turnModules = modules.filter(module => module.assess || module.contribute || module.review);
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
