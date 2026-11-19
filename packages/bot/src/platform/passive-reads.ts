import type { BiliFetch } from '../bilibili/bilibili.ts';
import type { Executor } from '../executor/executor.ts';

// 纯后台的读（她看视频、刷推荐、学热梗、查东西）：整条链在第一次派发前就归 App 所有，和账号那边的写分开。
// 停的时候一起取消（AbortController），等已经派出去的收完。
// 原来在 app.ts 开头（passiveLifetime / passiveRead / passiveFetch / passiveSleep / ownPassiveRead / stopPassiveReads），ADR 0336 第 6 步原样搬到这里；
// 停法仍由 App 在原位登记（lifetime.own('passive-reads')）。
export interface PassiveReads {
    /** 停的时候 abort；用它的 signal 判断停没停、接到别的请求上 */
    lifetime: AbortController;
    /** 跑一次读：停了就立刻以停的原因失败 */
    read<T>(run: () => Promise<T>): Promise<T>;
    /** 包一层 B 站请求：带上停的 signal，读正文也能被停打断 */
    fetch(raw: BiliFetch): BiliFetch;
    /** 等一会儿（经执行器的计时器），停了就失败 */
    sleep(ms: number): Promise<void>;
    /** 登记一件后台读的活：停了就不做；做完（不论成败）调 done */
    own(work: () => Promise<void>, done: () => void): Promise<void>;
    stop(): Promise<void> | undefined;
}

export function passiveReads({ stopped, exec }: { stopped: () => boolean; exec: Pick<Executor, 'after' | 'cancel'> }): PassiveReads {
    // Watching and feed are pure background reads. Own the complete local
    // chain before its first dispatch, independently of account mutations.
    const passiveLifetime = new AbortController(), passiveJobs = new Set<Promise<void>>();
    let passiveDrain: Promise<void> | undefined;
    const passiveRead = async <T>(run: () => Promise<T>): Promise<T> => {
        const signal = passiveLifetime.signal; signal.throwIfAborted();
        let abort!: () => void;
        const cancelled = new Promise<never>((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
        try { const value = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return run(); }), cancelled]); signal.throwIfAborted(); return value; }
        finally { signal.removeEventListener('abort', abort); }
    };
    const passiveFetch = (raw: BiliFetch): BiliFetch => async (url, init) => {
        const response = await passiveRead(() => raw(url, { ...init, signal: AbortSignal.any([passiveLifetime.signal, init.signal]) }));
        return new Proxy(response, { get(target, property) {
            if (property === 'text') return () => passiveRead(() => target.text());
            return Reflect.get(target, property, target) as unknown;
        } });
    };
    const passiveSleep = (ms: number) => new Promise<void>((resolve, reject) => {
        const signal = passiveLifetime.signal; if (signal.aborted) { reject(signal.reason); return; }
        const abort = () => { exec.cancel(timer); reject(signal.reason); };
        const timer = exec.after(() => { signal.removeEventListener('abort', abort); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
    });
    const ownPassiveRead = (work: () => Promise<void>, done: () => void): Promise<void> => {
        if (stopped() || passiveLifetime.signal.aborted) { done(); return Promise.resolve(); }
        const task = Promise.resolve().then(() => { if (!stopped() && !passiveLifetime.signal.aborted) return work(); }).finally(() => { done(); passiveJobs.delete(task); });
        passiveJobs.add(task); return task;
    };
    const stopPassiveReads = () => {
        if (passiveLifetime.signal.aborted) return passiveDrain;
        passiveLifetime.abort();
        if (passiveJobs.size) passiveDrain = Promise.allSettled([...passiveJobs]).then(() => {});
        return passiveDrain;
    };
    return { lifetime: passiveLifetime, read: passiveRead, fetch: passiveFetch, sleep: passiveSleep, own: ownPassiveRead, stop: stopPassiveReads };
}
