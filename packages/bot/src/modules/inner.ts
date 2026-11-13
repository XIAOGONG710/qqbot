// 她最近心里在想的（ADR 0101，配置 innerLife）作为解释器的模块（ADR 0336 第 5 步）：前后是同一个在想事情的人。
// 念头由主动消息的计划器想、存（还在 app.ts / 模拟器里），这里只在拼提示词时现取一行放进「此刻」块的 inner 槽。
// 主动找他时也带上（她主动说的常常就是这些念头，还有她自己上网查到的，ADR 0180）；危机回合不放。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 memes、proactive-day、watched 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';

export interface InnerModuleOptions {
    /** 这个人的计划器此刻的那一行；计划器后建，每次现取 */
    innerLine: (contact: Contact) => string | undefined;
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export function innerModule(options: InnerModuleOptions): Module {
    return {
        id: 'inner',
        contribute(turn) {
            if (turn.facts.crisis) return [];
            const line = options.innerLine(turn.contact);
            if (!line) return [];
            options.log(`[${turn.contact.qq}] 内心：这一轮提示词里放了她最近的念头`);
            return [{ slot: 'inner', text: line }];
        },
    };
}
