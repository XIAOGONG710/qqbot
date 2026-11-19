import { describeError } from '../memory/transient-io.ts';
import type { Log } from './log.ts';

// App 的统一停止（ADR 0336 第 6 步，取代 ADR 0320 的「构造失败收尾登记 + 手写 stop() 清单」两份）：
// 每拿到一项要收尾的资源，就在这里登记一次它的停法（名字 + 一个函数）。
// - 构造失败（rollback）：按登记先后全停。
// - App.stop：按 App 给的「停止先后表」停，同名的几项按登记先后（每个联系人一个回复器那种）。先后表是有意写的
//   （例如日记、答应的事先于长期记忆停，它们收尾时还要写记忆），所以和登记先后分开。
// 两边一样：同步部分逐项做，某一项同步抛错不打断后面的、记成一项没确认的收尾；然后等所有已派发的收尾（allSettled），
// 没确认的逐条记一行日志，最后释放目录租约。没有要等的就当场释放。

/** 一项资源停下后要等的：没有、一个，或几个（各自没确认就各记一行） */
export type Drain = Promise<void> | undefined | void | readonly (Promise<void> | undefined)[];
export type Teardown = () => Drain;

export interface Lifetime<Name extends string> {
    /** 登记一项资源的停法。名字必须在停止先后表里；停下之后再登记的不收（同原来：停了之后才建的不再管） */
    own(name: Name, teardown: Teardown): void;
    /** 这几项交给另一个统一停（解释器建好后接手小梗、口头习惯）：拿掉它们，在这里登记接手的那一项 */
    handOver(names: readonly Name[], to: Name, teardown: Teardown): void;
    /** 构造完成：之后失败不再回滚，登记的留给 stop */
    commit(): void;
    /** 构造失败：按登记先后全停，后台等收尾后释放租约（同步抛原来的构造错误由调用方做） */
    rollback(): void;
    /** App.stop：按停止先后表全停；有要等的返回那个等待（等完释放租约），没有就当场释放、返回 undefined。只停一次 */
    stop(): Promise<void> | undefined;
}

export function appLifetime<Name extends string>({ release, log, stopOrder }: { release: () => void; log: Log; stopOrder: readonly Name[] }): Lifetime<Name> {
    let phase: 'building' | 'running' | 'failed' | 'stopped' = 'building';
    let entries: { name: Name; teardown: Teardown }[] = [];
    const settle = (teardowns: readonly Teardown[], unconfirmed: string): Promise<void> | undefined => {
        const drains: Promise<void>[] = [];
        for (const teardown of teardowns) {
            try {
                const drain = teardown();
                for (const one of Array.isArray(drain) ? drain : [drain]) if (one) drains.push(one);
            } catch (error) { drains.push(Promise.reject(error)); }
        }
        if (!drains.length) { release(); return undefined; }
        return Promise.allSettled(drains).then(results => {
            for (const result of results) if (result.status === 'rejected') {
                try { log(`${unconfirmed}（${describeError(result.reason)}）`); } catch { /* 诊断不改变已确认的事实，也不能卡住收尾。 */ }
            }
            release();
        });
    };
    const lifetime: Lifetime<Name> = {
        own(name, teardown) {
            if (!stopOrder.includes(name)) throw new Error(`收尾登记：「${name}」不在停止先后表里`);
            if (phase === 'building' || phase === 'running') entries.push({ name, teardown });
        },
        handOver(names, to, teardown) {
            entries = entries.filter(entry => !names.includes(entry.name));
            lifetime.own(to, teardown);
        },
        commit() { if (phase === 'building') phase = 'running'; },
        rollback() {
            if (phase !== 'building') return;
            phase = 'failed';
            const teardowns = entries.map(entry => entry.teardown);
            entries = [];
            void settle(teardowns, '启动失败时后台收尾未确认');
        },
        stop() {
            if (phase !== 'running') return undefined;
            phase = 'stopped';
            const teardowns = stopOrder.flatMap(name => entries.filter(entry => entry.name === name).map(entry => entry.teardown));
            entries = [];
            return settle(teardowns, '停止时持久收尾未确认');
        },
    };
    return lifetime;
}
