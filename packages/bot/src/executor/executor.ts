// 执行器（ADR 0263）：唯一碰外部的地方。解释器和模块要做的事写成动作（Action），经 run 交给这里执行；
// 这里不做任何“她要不要 / 怎么做”的判断，只负责真的去做、记下正在做什么、给测试和模拟器一个统一的替换口。
//
// 迁移期（ADR 0263 第 3 步）的约束：经执行器做事必须和原来直接调用逐字等价——
// - QQ 动作同步调用底层 Transport，原样返回同一个 promise（不多套一层 then，免得改变微任务顺序）；底层同步抛错也同步抛出。
// - 模型调用：有测试替身（AppOptions.pipeline.generate）时按原来的参数调替身，否则调 chatCompletion。
// - 计时器：调用时取全局的 setTimeout / setInterval（假时钟替换全局后同样生效），原样返回句柄。
// 正在进行的动作和活着的计时器都登记在这里，供以后的统一停止（ADR 0263 第 4 节）使用；这一步还不改变 App 的停止流程。

import { chatCompletion, type LlmOptions } from '../language/llm.ts';
import type { ModelPurpose } from '../language/model-guard.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import type { Log } from '../platform/log.ts';
import type { Transport } from '../platform/app.ts';

/** QQ（NapCat / OneBot）这一侧能做的事：Transport 上的方法名 */
export type QqMethod = keyof Transport;

/** 一次 QQ 动作：调 Transport 上的哪个方法、带什么参数 */
export interface QqAction { kind: 'qq'; method: QqMethod; args: readonly unknown[] }

/** 一次模型调用：用的完整模型配置、消息、是聊天还是后台任务（排队优先级见 model-guard.ts） */
export interface LlmAction {
    kind: 'llm';
    purpose: ModelPurpose;
    config: LlmOptions;
    messages: OpenAIMessage[];
    /** 这一轮换了模型（深思，ADR 0151）：测试替身会收到这份配置，和原来 generate 的第三个参数一致 */
    deliberate?: boolean;
    signal?: AbortSignal;
}

export type Action = QqAction | LlmAction;

/** 测试替身：换掉真的模型调用（同 ContactPipelineOptions.generate 的签名） */
export type Generate = (messages: OpenAIMessage[], log: Log, use?: LlmOptions) => Promise<string>;

export interface ExecutorOptions {
    transport: Transport;
    /** 测试 / 模拟器：换掉真的模型调用 */
    generate?: Generate;
    /** 真的模型调用，默认 chatCompletion（测试可换） */
    complete?: typeof chatCompletion;
    /** 现在几点（毫秒），默认 Date.now；测试和模拟器换成虚拟时钟 */
    now?: () => number;
    /** 每个动作派发前看一眼（审计、录制）；不能改动作，出错不影响执行 */
    observe?: (action: Action) => void;
}

type Timer = ReturnType<typeof setTimeout>;

export interface Executor {
    /** 执行一个动作。QQ 动作的返回值就是 Transport 方法的返回值 */
    run(action: QqAction): unknown;
    run(action: LlmAction, log: Log): Promise<string>;
    /** 和 Transport 同形状：每个方法调用都变成一个 QQ 动作；底层没有的可选方法这里也没有 */
    readonly qq: Transport;
    /** 调模型 */
    llm(action: Omit<LlmAction, 'kind'>, log: Log): Promise<string>;
    now(): number;
    after(ms: number, fn: () => void): Timer;
    every(ms: number, fn: () => void): Timer;
    cancel(timer: Timer | undefined): void;
    /** 正在进行的动作数 */
    readonly inFlight: number;
    /** 活着的计时器数（每次触发的 after 会自动去掉） */
    readonly timers: number;
}

/** Transport 上所有的方法名（含原型链上的，不含 Object 自带的） */
function methodNames(transport: Transport): QqMethod[] {
    const names = new Set<string>();
    for (let proto: object | null = transport; proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        for (const name of Object.getOwnPropertyNames(proto)) {
            if (name !== 'constructor' && typeof (transport as unknown as Record<string, unknown>)[name] === 'function') names.add(name);
        }
    }
    return [...names] as QqMethod[];
}

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as { then?: unknown }).then === 'function';

export function createExecutor(options: ExecutorOptions): Executor {
    const { transport, generate, observe } = options;
    const complete = options.complete ?? chatCompletion;
    const now = options.now ?? Date.now;
    let inFlight = 0;
    const live = new Set<Timer>();

    /** 登记一个进行中的结果：旁路地等它结束，不改变返回给调用方的那个 promise */
    const track = <T>(result: T): T => {
        if (!isThenable(result)) return result;
        inFlight++;
        const done = () => { inFlight--; };
        result.then(done, done);
        return result;
    };

    const look = (action: Action) => {
        if (!observe) return;
        try { observe(action); } catch { /* 观察者出错不影响执行 */ }
    };

    function runQq(action: QqAction): unknown {
        const method = (transport as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>)[action.method];
        if (typeof method !== 'function') throw new Error(`QQ 这一侧没有 ${String(action.method)}`);
        look(action);
        return track(method.apply(transport, action.args as unknown[]));
    }

    function runLlm(action: LlmAction, log: Log): Promise<string> {
        look(action);
        const result = generate
            ? generate(action.messages, log, action.deliberate ? action.config : undefined)
            : complete(action.config, action.messages, { log, purpose: action.purpose, ...(action.signal ? { signal: action.signal } : {}) });
        return track(result);
    }

    function run(action: QqAction): unknown;
    function run(action: LlmAction, log: Log): Promise<string>;
    function run(action: Action, log?: Log): unknown {
        if (action.kind === 'qq') return runQq(action);
        if (action.kind === 'llm') {
            if (!log) throw new Error('模型调用要带日志');
            return runLlm(action, log);
        }
        throw new Error(`不认识的动作 ${(action as { kind: string }).kind}`);
    }

    const qq = {} as Record<string, (...args: unknown[]) => unknown>;
    for (const method of methodNames(transport)) qq[method] = (...args: unknown[]) => runQq({ kind: 'qq', method, args });

    return {
        run,
        qq: qq as unknown as Transport,
        llm: (action, log) => runLlm({ kind: 'llm', ...action }, log),
        now: () => now(),
        after(ms, fn) {
            const timer: Timer = setTimeout(() => { live.delete(timer); fn(); }, ms);
            live.add(timer);
            return timer;
        },
        every(ms, fn) {
            const timer: Timer = setInterval(fn, ms);
            live.add(timer);
            return timer;
        },
        cancel(timer) {
            if (timer === undefined) return;
            live.delete(timer);
            clearTimeout(timer);
        },
        get inFlight() { return inFlight; },
        get timers() { return live.size; },
    };
}
