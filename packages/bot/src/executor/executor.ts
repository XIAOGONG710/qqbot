// 执行器（ADR 0336）：唯一碰外部的地方。解释器和模块要做的事写成动作（Action），经 run 交给这里执行；
// 这里不做任何“她要不要 / 怎么做”的判断，只负责真的去做、记下正在做什么、给测试和模拟器一个统一的替换口。
//
// 迁移期（ADR 0336 第 3 步）的约束：经执行器做事必须和原来直接调用逐字等价——
// - QQ 动作同步调用底层 Transport，原样返回同一个 promise（不多套一层 then，免得改变微任务顺序）；底层同步抛错也同步抛出。
// - 模型调用：有测试替身（AppOptions.pipeline.generate）时按原来的参数调替身，否则调 chatCompletion。
// - 计时器：调用时取全局的 setTimeout / setInterval（假时钟替换全局后同样生效），原样返回句柄。
// - 设备登记（device，ADR 0336「生成之后那一段」第 8 步）：同步交给设备控制的 commit，和原来直接调一样。
// - 状态文件（file，ADR 0336 第 6 步）：同步调 node:fs 的同名函数、参数同原来（读 utf8、删 force、建目录 recursive），同步返回、同步抛错。
// - 子进程（process，ADR 0336 第 6 步）：她的命令（shell-tool 的 runShell）、交给常驻的她干活（work-bridge 的 runWorkTask）、查仓库的 HEAD（identity 的 realGit）；
//   调原来的函数、参数原样，异步的原样返回同一个 promise（登记进行中）。
// 正在进行的动作和周期计时器都登记在这里，供以后的统一停止（ADR 0336 第 4 节）使用；这一步还不改变 App 的停止流程。

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chatCompletion, type LlmOptions } from '../language/llm.ts';
import type { ModelPurpose } from '../language/model-guard.ts';
import type { OpenAIMessage } from '../language/prompt.ts';
import type { Log } from '../platform/log.ts';
import type { Transport } from '../platform/app.ts';
import type { AppConfig } from '../platform/config.ts';
import type { DeviceControl, ParsedTokens } from '../platform/device-actions.ts';
import { realGit } from '../memory/identity.ts';
import { runShell, type ShellRun } from '../platform/shell-tool.ts';
import { runWorkTask } from '../platform/work-bridge.ts';

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
    /** 这一轮换了模型（深思，ADR 0151）：换成的那份配置；测试替身收到它，和原来 generate 的第三个参数一致 */
    use?: AppConfig['llm'];
    signal?: AbortSignal;
}

/**
 * 一次设备登记（ADR 0148；ADR 0336「生成之后那一段」第 8 步）：这一轮发出去的那一稿带的设备指令，发送前交给设备控制登记、按档处理
 * （提议等他批准、直接做、拒绝的记账）。哪一稿、要不要登记由联系人流水线定，这里只交出去
 */
export interface DeviceAction { kind: 'device'; parsed: ParsedTokens }

/**
 * 一次状态文件操作（ADR 0336 第 6 步）：读（utf8 文本）、写、追加、删（不存在也不算错）、在不在、列目录、建目录（连同上级）。
 * 都是同步的，和原来直接调 node:fs 一样；写进来的是 App 自己的数据目录和灵魂目录里的小文件
 */
export type FileAction =
    | { kind: 'file'; op: 'read' | 'remove' | 'exists' | 'list' | 'mkdir'; path: string }
    | { kind: 'file'; op: 'write' | 'append'; path: string; text: string };

/** 和 node:fs 同步函数一一对应的那几样（App 经执行器碰文件时用） */
export interface Files {
    read(path: string): string;
    write(path: string, text: string): void;
    append(path: string, text: string): void;
    remove(path: string): void;
    exists(path: string): boolean;
    list(dir: string): string[];
    mkdir(dir: string): void;
}

/** 真的文件操作：执行器用它；App 建执行器之前（startApp 建数据目录）也直接用它 */
export const realFiles: Files = {
    read: path => readFileSync(path, 'utf8'),
    write: (path, text) => writeFileSync(path, text),
    append: (path, text) => appendFileSync(path, text),
    remove: path => rmSync(path, { force: true }),
    exists: path => existsSync(path),
    list: dir => readdirSync(dir),
    mkdir: dir => { mkdirSync(dir, { recursive: true }); },
};

/** 一次子进程（ADR 0336 第 6 步）：跑她写的命令、交给常驻的她干活、查仓库现在的提交 */
export type ProcessAction =
    | { kind: 'process'; program: 'shell'; command: string; options: Parameters<typeof runShell>[1] }
    | { kind: 'process'; program: 'work'; task: string; options: Parameters<typeof runWorkTask>[1] }
    | { kind: 'process'; program: 'git-head'; repoRoot: string };

/** 起子进程的那几样（测试可换） */
export interface Processes {
    shell: typeof runShell;
    work: typeof runWorkTask;
    gitHead: (repoRoot: string) => string | undefined;
}

export type Action = QqAction | LlmAction | DeviceAction | FileAction | ProcessAction;

/** 测试替身：换掉真的模型调用（同 ContactPipelineOptions.generate 的签名） */
export type Generate = (messages: OpenAIMessage[], log: Log, use?: AppConfig['llm']) => Promise<string>;

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
    /** 设备控制（ADR 0148）：服务是异步起的，登记时现取；没有（没开、还没起来）就什么都不做 */
    devices?: () => Pick<DeviceControl, 'commit'> | undefined;
    /** 测试：换掉真的文件操作 */
    files?: Files;
    /** 测试：换掉起子进程的那几样（App 的 workRunner 也从这里给） */
    processes?: Partial<Processes>;
}

type Timer = ReturnType<typeof setTimeout>;

export interface Executor {
    /** 执行一个动作。QQ 动作的返回值就是 Transport 方法的返回值 */
    run(action: QqAction): unknown;
    run(action: LlmAction, log: Log): Promise<string>;
    run(action: DeviceAction): void;
    run(action: FileAction): string | string[] | boolean | void;
    run(action: ProcessAction): Promise<ShellRun> | Promise<string> | string | undefined;
    /** 和 Transport 同形状：每个方法调用都变成一个 QQ 动作；底层没有的可选方法这里也没有 */
    readonly qq: Transport;
    /** 碰状态文件：每个方法都变成一个文件动作 */
    readonly files: Files;
    /** 起子进程：每个方法都变成一个子进程动作 */
    readonly process: Processes;
    /** 调模型 */
    llm(action: Omit<LlmAction, 'kind'>, log: Log): Promise<string>;
    now(): number;
    /** 参数顺序同 setTimeout / setInterval，便于逐处替换 */
    after(fn: () => void, ms?: number): Timer;
    every(fn: () => void, ms?: number): Timer;
    cancel(timer: Timer | undefined): void;
    /** 正在进行的动作数 */
    readonly inFlight: number;
    /** 活着的周期计时器数（every 登记、cancel 去掉；一次性的 after 不登记，统一停止见 ADR 0336 第 4 节） */
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
            ? generate(action.messages, log, action.use)
            : complete(action.config, action.messages, { log, purpose: action.purpose, ...(action.signal ? { signal: action.signal } : {}) });
        return track(result);
    }

    /** 同步做文件操作（和原来直接调 node:fs 一样：同步做完、同步抛错） */
    const disk = options.files ?? realFiles;
    function runFile(action: FileAction): string | string[] | boolean | void {
        look(action);
        switch (action.op) {
            case 'read': return disk.read(action.path);
            case 'write': return disk.write(action.path, action.text);
            case 'append': return disk.append(action.path, action.text);
            case 'remove': return disk.remove(action.path);
            case 'exists': return disk.exists(action.path);
            case 'list': return disk.list(action.path);
            case 'mkdir': return disk.mkdir(action.path);
        }
    }

    const programs: Processes = {
        shell: options.processes?.shell ?? runShell,
        work: options.processes?.work ?? runWorkTask,
        gitHead: options.processes?.gitHead ?? (repoRoot => realGit(repoRoot).head()),
    };
    function runProcess(action: ProcessAction): Promise<ShellRun> | Promise<string> | string | undefined {
        look(action);
        if (action.program === 'shell') return track(programs.shell(action.command, action.options));
        if (action.program === 'work') return track(programs.work(action.task, action.options));
        return programs.gitHead(action.repoRoot);
    }

    /** 同步交给设备控制（和原来直接调 commit 一样：同步做完、同步抛错） */
    function runDevice(action: DeviceAction): void {
        look(action);
        options.devices?.()?.commit(action.parsed);
    }

    function run(action: QqAction): unknown;
    function run(action: LlmAction, log: Log): Promise<string>;
    function run(action: DeviceAction): void;
    function run(action: FileAction): string | string[] | boolean | void;
    function run(action: ProcessAction): Promise<ShellRun> | Promise<string> | string | undefined;
    function run(action: Action, log?: Log): unknown {
        if (action.kind === 'qq') return runQq(action);
        if (action.kind === 'llm') {
            if (!log) throw new Error('模型调用要带日志');
            return runLlm(action, log);
        }
        if (action.kind === 'device') return runDevice(action);
        if (action.kind === 'file') return runFile(action);
        if (action.kind === 'process') return runProcess(action);
        throw new Error(`不认识的动作 ${(action as { kind: string }).kind}`);
    }

    const qq = {} as Record<string, (...args: unknown[]) => unknown>;
    for (const method of methodNames(transport)) qq[method] = (...args: unknown[]) => runQq({ kind: 'qq', method, args });

    return {
        run,
        qq: qq as unknown as Transport,
        process: {
            shell: (command, options) => runProcess({ kind: 'process', program: 'shell', command, options }) as Promise<ShellRun>,
            work: (task, options) => runProcess({ kind: 'process', program: 'work', task, options }) as Promise<string>,
            gitHead: repoRoot => runProcess({ kind: 'process', program: 'git-head', repoRoot }) as string | undefined,
        },
        files: {
            read: path => runFile({ kind: 'file', op: 'read', path }) as string,
            write: (path, text) => { runFile({ kind: 'file', op: 'write', path, text }); },
            append: (path, text) => { runFile({ kind: 'file', op: 'append', path, text }); },
            remove: path => { runFile({ kind: 'file', op: 'remove', path }); },
            exists: path => runFile({ kind: 'file', op: 'exists', path }) as boolean,
            list: dir => runFile({ kind: 'file', op: 'list', path: dir }) as string[],
            mkdir: dir => { runFile({ kind: 'file', op: 'mkdir', path: dir }); },
        },
        llm: (action, log) => runLlm({ kind: 'llm', ...action }, log),
        now: () => now(),
        // 一次性计时器原样交给 setTimeout（不包一层：已有测试按回调认计时器；触发后这里也无从得知，登记了只会越积越多）
        after: (fn, ms) => setTimeout(fn, ms),
        every(fn, ms) {
            const timer: Timer = setInterval(fn, ms);
            live.add(timer);
            return timer;
        },
        // 周期计时器用 clearInterval、其余用 clearTimeout：和原来逐处调用的一致（已有测试换掉全局的 clearInterval 核对）
        cancel(timer) {
            if (timer === undefined) return;
            if (live.delete(timer)) clearInterval(timer);
            else clearTimeout(timer);
        },
        get inFlight() { return inFlight; },
        get timers() { return live.size; },
    };
}
