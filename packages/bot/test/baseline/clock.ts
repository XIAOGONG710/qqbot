// 行为基线（ADR 0336 第 2 步）用的假时钟：Date 冻在虚拟时间上（node:test 的 mock.timers 只接管 Date），
// setTimeout / setInterval 换成自己的队列，只有 advanceTo 拨到点才触发；Math.random 换成固定种子。
// 拨时间之前先等进程“静下来”：没有进行中的文件读写、连续几轮 setImmediate 里什么都没变。
// 这样同一份代码每次跑出来的提示词、QQ 动作和状态文件逐字一样。

import { mock } from 'node:test';

interface Pending { id: number; at: number; fn: (...args: unknown[]) => void; args: unknown[]; every?: number }

const realImmediate = globalThis.setImmediate;
const flushOnce = () => new Promise<void>(resolve => realImmediate(resolve));

class Handle {
    readonly id: number;
    readonly clock: FakeClock;
    constructor(id: number, clock: FakeClock) { this.id = id; this.clock = clock; }
    ref(): this { return this; }
    unref(): this { return this; }
    hasRef(): boolean { return true; }
    refresh(): this { this.clock.refresh(this.id); return this; }
    close(): this { this.clock.clear(this.id); return this; }
    [Symbol.toPrimitive](): number { return this.id; }
    [Symbol.dispose](): void { this.clock.clear(this.id); }
}

/** 一次跑场景时装上，跑完 uninstall；装着的时候全局的 Date、计时器、Math.random 都是假的 */
export class FakeClock {
    #now: number;
    #nextId = 1;
    #timers = new Map<number, Pending>();
    #saved: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout; setInterval: typeof setInterval; clearInterval: typeof clearInterval; random: typeof Math.random } | undefined;
    /** 每次进程静下来之前看一眼的“动静”：外面记录的条数变了也算没静下来 */
    activity: () => number = () => 0;

    constructor(start: number, seed = 0x2630) {
        this.#now = start;
        this.#seed = seed >>> 0;
    }

    #seed: number;
    /** mulberry32：固定种子的伪随机 */
    #random = (): number => {
        this.#seed = (this.#seed + 0x6d2b79f5) >>> 0;
        let t = this.#seed;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    now = (): number => this.#now;

    install(): void {
        if (this.#saved) throw new Error('假时钟已经装上了');
        this.#saved = { setTimeout, clearTimeout, setInterval, clearInterval, random: Math.random };
        mock.timers.enable({ apis: ['Date'], now: this.#now });
        const g = globalThis as Record<string, unknown>;
        g.setTimeout = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => this.#add(fn, ms, args);
        g.setInterval = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => this.#add(fn, ms, args, true);
        g.clearTimeout = g.clearInterval = (handle: unknown) => { if (handle !== undefined && handle !== null) this.clear(Number(handle)); };
        Math.random = this.#random;
    }

    uninstall(): void {
        const saved = this.#saved;
        if (!saved) return;
        const g = globalThis as Record<string, unknown>;
        g.setTimeout = saved.setTimeout; g.clearTimeout = saved.clearTimeout; g.setInterval = saved.setInterval; g.clearInterval = saved.clearInterval;
        Math.random = saved.random;
        mock.timers.reset();
        this.#timers.clear();
        this.#saved = undefined;
    }

    #add(fn: (...args: unknown[]) => void, ms: number | undefined, args: unknown[], every = false): Handle {
        if (typeof fn !== 'function') throw new TypeError('setTimeout 需要函数');
        const delay = Math.max(every ? 1 : 0, Math.floor(Number(ms) || 0));
        const id = this.#nextId++;
        this.#timers.set(id, { id, at: this.#now + delay, fn, args, ...(every ? { every: delay } : {}) });
        return new Handle(id, this);
    }

    clear(id: number): void { this.#timers.delete(id); }

    refresh(id: number): void {
        const timer = this.#timers.get(id);
        if (timer) timer.at = this.#now + (timer.every ?? 0);
    }

    /** 还排着的计时器有几个（测试自查用） */
    get pending(): number { return this.#timers.size; }

    #earliest(limit: number): Pending | undefined {
        let best: Pending | undefined;
        for (const timer of this.#timers.values()) {
            if (timer.at > limit) continue;
            if (!best || timer.at < best.at || (timer.at === best.at && timer.id < best.id)) best = timer;
        }
        return best;
    }

    /** 等到进程静下来：没有进行中的文件读写，连续 stableRounds 轮 setImmediate 里动静和计时器数都没变 */
    async idle(stableRounds = 4): Promise<void> {
        let last = '';
        let stable = 0;
        for (let round = 0; round < 100_000; round++) {
            await flushOnce();
            const busy = process.getActiveResourcesInfo().filter(name => name.startsWith('FS') || name.startsWith('FileHandle')).length;
            const signature = `${busy}:${this.activity()}:${this.#timers.size}:${this.#nextId}`;
            if (busy === 0 && signature === last) {
                if (++stable >= stableRounds) return;
            } else stable = 0;
            last = signature;
        }
        throw new Error('进程一直静不下来');
    }

    #setNow(at: number): void {
        if (at < this.#now) return;
        this.#now = at;
        mock.timers.setTime(at);
    }

    /** 拨到 target：途中到点的计时器按时间（同一刻按登记顺序）一个个触发，每触发一个都等静下来 */
    async advanceTo(target: number): Promise<void> {
        await this.idle();
        for (let fired = 0; ; fired++) {
            if (fired > 200_000) throw new Error('计时器触发次数太多，可能是死循环');
            const next = this.#earliest(target);
            if (!next) break;
            this.#setNow(next.at);
            if (next.every === undefined) this.#timers.delete(next.id);
            else next.at = this.#now + next.every;
            next.fn(...next.args);
            await this.idle();
        }
        this.#setNow(target);
        await this.idle();
    }

    advance(ms: number): Promise<void> { return this.advanceTo(this.#now + ms); }

    /** 等一个 promise 结束；它要靠计时器推进时，按到点顺序往前拨，最多拨 limitMs */
    async settle<T>(work: Promise<T>, limitMs = 24 * 3600_000): Promise<T> {
        let done = false;
        let result: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
        work.then(value => { done = true; result = { ok: true, value }; }, error => { done = true; result = { ok: false, error }; });
        const deadline = this.#now + limitMs;
        await this.idle();
        while (!done) {
            const next = this.#earliest(deadline);
            if (!next) break;
            this.#setNow(next.at);
            if (next.every === undefined) this.#timers.delete(next.id);
            else next.at = this.#now + next.every;
            next.fn(...next.args);
            await this.idle();
        }
        if (!done) throw new Error('等的事在时限内没有结束');
        if (!result!.ok) throw result!.error;
        return result!.value;
    }
}
