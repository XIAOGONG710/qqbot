// 模型调用的总闸（ADR 0070 第 7 项）：并发上限、聊天优先、每日额度、连续失败后的熔断。
// 不限制名单里的人聊天的频率——这里只防「程序循环 / 账号被盗 / 后台任务失控」把额度和连接耗光，并且永远先保住实时聊天。
// 只在内存里计数：重启会清零（一个反复重启的循环要靠 CI / 看门狗发现，不靠这里）。

export type ModelPurpose = 'chat' | 'background';

/** 被总闸挡住（没有真的去调模型）；llm.ts 把它换成 ModelUnreachable，后台任务因此「等好了再来」而不是记成失败 */
export class GuardRejected extends Error {
    readonly reason: 'budget' | 'breaker' | 'queue';
    constructor(reason: GuardRejected['reason'], message: string) {
        super(message);
        this.reason = reason;
    }
}

export interface ModelGuardOptions {
    /** 同时在跑的模型调用上限 */
    concurrent: number;
    /** 其中后台任务（抽取、日记、总结、表情判断）最多占几个，剩下的永远留给聊天 */
    backgroundConcurrent: number;
    /** 每个自然日的调用次数：后台任务到这个数就不再放行，聊天到它的 hardMultiplier 倍才拒绝 */
    dailyCalls: number;
    hardMultiplier: number;
    /** 连续这么多次「没连上」就熔断 */
    breakerFailures: number;
    /** 熔断多久；期间后台任务直接拒绝，聊天一次只放一个探路的 */
    breakerOpenMs: number;
    /** 排队最久等多久（毫秒），到了就拒绝 */
    chatWaitMs: number;
    backgroundWaitMs: number;
    now: () => number;
    log: (message: string) => void;
}

export const MODEL_GUARD_DEFAULTS: Omit<ModelGuardOptions, 'now' | 'log'> = {
    concurrent: 4,
    backgroundConcurrent: 2,
    dailyCalls: 4000,
    hardMultiplier: 1.5,
    breakerFailures: 5,
    breakerOpenMs: 30_000,
    chatWaitMs: 120_000,
    backgroundWaitMs: 600_000,
};

interface Waiter { purpose: ModelPurpose; start: () => void; timer: ReturnType<typeof setTimeout> }

const dayKey = (time: number) => {
    const date = new Date(time);
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

export class ModelGuard {
    readonly #options: ModelGuardOptions;
    #day = '';
    #calls = 0;
    #warned = new Set<string>();
    #active = { chat: 0, background: 0 };
    readonly #waiting: Record<ModelPurpose, Waiter[]> = { chat: [], background: [] };
    #failures = 0;
    #openUntil = 0;
    #probing = false;

    constructor(options: Partial<ModelGuardOptions> = {}) {
        this.#options = { ...MODEL_GUARD_DEFAULTS, now: Date.now, log: () => {}, ...options };
    }

    /** 给状态页 / 日志用 */
    status(): { callsToday: number; active: number; waiting: number; breakerOpen: boolean } {
        this.#rollDay();
        return {
            callsToday: this.#calls,
            active: this.#active.chat + this.#active.background,
            waiting: this.#waiting.chat.length + this.#waiting.background.length,
            breakerOpen: this.#options.now() < this.#openUntil,
        };
    }

    async run<T>(purpose: ModelPurpose, work: () => Promise<T>, unreachable: (error: unknown) => boolean = () => false, signal?: AbortSignal): Promise<T> {
        signal?.throwIfAborted();
        let probe = this.#admit(purpose);
        try {
            await this.#acquire(purpose, signal);
        } catch (error) {
            if (probe) this.#probing = false;
            throw error;
        }
        try {
            // 获得位置和启动请求之间也可能取消，不能留下幽灵请求或占用位置。
            signal?.throwIfAborted();
            // 排队期间可能已经熔断；真正开始工作前复核，不重复扣日额度。
            if (!probe) probe = this.#admitBreaker(purpose);
            const result = await work();
            this.#failures = 0;
            this.#openUntil = 0;
            return result;
        } catch (error) {
            if (unreachable(error)) this.#fail();
            throw error;
        } finally {
            this.#active[purpose]--;
            if (probe) this.#probing = false;
            this.#next();
        }
    }

    #rollDay(): void {
        const today = dayKey(this.#options.now());
        if (today === this.#day) return;
        this.#day = today;
        this.#calls = 0;
        this.#warned.clear();
    }

    #once(key: string, message: string): void {
        if (this.#warned.has(key)) return;
        this.#warned.add(key);
        this.#options.log(message);
    }

    /** 放不放行；返回 true 表示这是熔断期间唯一放行的探路调用 */
    #admit(purpose: ModelPurpose): boolean {
        this.#rollDay();
        const { dailyCalls, hardMultiplier } = this.#options;
        const limit = purpose === 'chat' ? dailyCalls * hardMultiplier : dailyCalls;
        if (this.#calls >= limit) {
            this.#once(`budget-${purpose}`, `模型额度：今天已经调用 ${this.#calls} 次，${purpose === 'chat' ? '聊天' : '后台任务'}不再放行（上限 ${limit}，明天自动恢复）`);
            throw new GuardRejected('budget', `今天的模型调用额度用完了（${this.#calls}/${limit}）`);
        }
        if (this.#calls >= dailyCalls * 0.8) this.#once('budget-80', `模型额度：今天已经调用 ${this.#calls} 次，超过日额度 ${dailyCalls} 的 80%`);
        const probe = this.#admitBreaker(purpose);
        this.#calls++;
        return probe;
    }

    #admitBreaker(purpose: ModelPurpose): boolean {
        let probe = false;
        if (this.#options.now() < this.#openUntil || this.#failures >= this.#options.breakerFailures) {
            const halfOpen = this.#options.now() >= this.#openUntil;
            if (purpose === 'background' && !halfOpen) throw new GuardRejected('breaker', '模型接口连续没连上，暂停后台任务');
            if (this.#probing) throw new GuardRejected('breaker', '模型接口连续没连上，正在探路，这次先不调');
            this.#probing = true;
            probe = true;
        }
        return probe;
    }

    #fail(): void {
        this.#failures++;
        if (this.#failures >= this.#options.breakerFailures) {
            this.#openUntil = this.#options.now() + this.#options.breakerOpenMs;
            this.#once(`breaker-${this.#openUntil}`, `模型熔断：连续 ${this.#failures} 次没连上，后台任务暂停 ${this.#options.breakerOpenMs / 1000} 秒，聊天一次只放一个探路的`);
        }
    }

    /** 拿到位置才返回，位置在这里（或 #next 里）同步占上，中间不留空隙让别的调用多放进来 */
    #acquire(purpose: ModelPurpose, signal?: AbortSignal): Promise<void> {
        signal?.throwIfAborted();
        if (this.#canStart(purpose)) {
            this.#active[purpose]++;
            return Promise.resolve();
        }
        return new Promise<void>((resolve, reject) => {
            const cleanup = () => { clearTimeout(waiter.timer); signal?.removeEventListener('abort', cancel); };
            const remove = () => {
                const queue = this.#waiting[purpose];
                const at = queue.indexOf(waiter);
                if (at >= 0) queue.splice(at, 1);
                cleanup();
            };
            const cancel = () => { remove(); reject(signal!.reason); this.#next(); };
            const waiter: Waiter = {
                purpose,
                start: () => { cleanup(); resolve(); },
                timer: setTimeout(() => {
                    remove();
                    reject(new GuardRejected('queue', `模型调用排队超过 ${(purpose === 'chat' ? this.#options.chatWaitMs : this.#options.backgroundWaitMs) / 1000} 秒`));
                    this.#next();
                }, purpose === 'chat' ? this.#options.chatWaitMs : this.#options.backgroundWaitMs),
            };
            this.#waiting[purpose].push(waiter);
            signal?.addEventListener('abort', cancel, { once: true });
        });
    }

    #canStart(purpose: ModelPurpose): boolean {
        const { concurrent, backgroundConcurrent } = this.#options;
        if (this.#active.chat + this.#active.background >= concurrent) return false;
        return purpose === 'chat' || this.#active.background < backgroundConcurrent;
    }

    /** 有空位了：聊天先，后台在不超过自己那份时才轮到 */
    #next(): void {
        for (const purpose of ['chat', 'background'] as const) {
            while (this.#waiting[purpose].length && this.#canStart(purpose)) {
                const waiter = this.#waiting[purpose].shift()!;
                this.#active[purpose]++;
                waiter.start();
            }
        }
    }
}
