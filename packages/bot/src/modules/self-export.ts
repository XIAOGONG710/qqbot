// 「此刻的她」（SELF.json，ADR 0347 第 2 层，配置 selfExport）的刷新作为解释器的模块（同 modules/now-export.ts）：
// - 每 SELF_REFRESH_MS 写一次（start: 'built'，App 搭好时先写一次）；
// - 写完的那份 validUntil 到点再写一次（状态行要变了：下课、上课、睡醒），「19:58 写的『20:00 还有课』」不会在 20:05 还被当成现在；
// - 给他回完一条之后（refreshSoon，App 在发给他的那一条发出去之后调）稍等一会儿再写——承诺、没了结的、心境刚变过，一串气泡只写一次。
// 怎么算、写不写（开关、名单里有没有男朋友档、休眠、危机暂停）在 app.ts 的 exportSelf；开关关着时这里没有定时任务、refreshSoon 什么都不做。
// 同一时间只跑一次（快照是异步的）；停下之后不再写。

import type { Module } from '../interpreter/interpreter.ts';

/** 计时器：执行器的 after 给什么就是什么，只拿来 cancel；有 unref 就 unref */
const unref = (timer: unknown): void => { (timer as { unref?: () => void } | undefined)?.unref?.(); };

export interface SelfExportModuleOptions<Timer = unknown> {
    /** 写一次；返回这一份的 validUntil（毫秒），没写就是 undefined。开关关着时不给 */
    exportSelf?: () => Promise<number | undefined>;
    every: number;
    /** 此刻（虚拟时钟） */
    now: () => number;
    after: (fn: () => void, ms: number) => Timer;
    cancel: (timer: Timer | undefined) => void;
    /** 回完一条之后等多久再写（一串气泡发完） */
    settleMs?: number;
}

export type SelfExportModule = Module & { refreshSoon(): void };

/** validUntil 之后多等一秒再写，免得正卡在边界上算出来还是上一刻的状态 */
const EDGE_MS = 1_000;

export function selfExportModule<Timer>(options: SelfExportModuleOptions<Timer>): SelfExportModule {
    const { exportSelf } = options;
    let stopped = false;
    let running = false;
    let again = false;
    let edge: Timer | undefined;
    let soon: Timer | undefined;
    const run = (): void => {
        if (!exportSelf || stopped) return;
        if (running) { again = true; return; }
        running = true;
        void exportSelf().then(validUntil => {
            if (stopped || validUntil === undefined) return;
            options.cancel(edge);
            edge = options.after(() => { edge = undefined; run(); }, Math.max(0, validUntil - options.now()) + EDGE_MS);
            unref(edge);
        }).catch(() => { /* exportSelf 自己记日志 */ }).finally(() => {
            running = false;
            if (again) { again = false; run(); }
        });
    };
    return {
        id: 'self-export',
        schedules: exportSelf ? [{ every: options.every, run, runOnStart: true, start: 'built' }] : [],
        refreshSoon() {
            if (!exportSelf || stopped || soon) return;
            soon = options.after(() => { soon = undefined; run(); }, options.settleMs ?? 3_000);
            unref(soon);
        },
        stop() {
            stopped = true;
            options.cancel(edge);
            options.cancel(soon);
            edge = soon = undefined;
            return undefined;
        },
    };
}
