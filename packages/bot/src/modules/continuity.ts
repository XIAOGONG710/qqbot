// 连续性作为解释器的模块（ADR 0336 第 5 步）：ADR 0157–0163——设定改动的背景、QQ 以外做过的事、上网查到的资料、自己发现的口味、又见到的人，
// 按这一轮他说的话取几行，放进「此刻」块的 continuity 槽（一行一段，先后照取回来的顺序）。只给男朋友档（App 的 continuity 里判断）。
// 取的那一下（DecideCtx.continuity，2026-11-18 起由这里的 decideAt.continuity 在流水线原位调）是异步的，会上网、调模型、记「已经告诉他了」，最长等 25 秒、App 停下时抛 AbortError。
// 它后面紧跟着图片表情、语义路由（又一次模型调用）、「/亲热」取一条、各模块的 contribute（读文件、取走命令结果……），
// 挪到 contribute 时再取，外部调用和日志的先后、等待的位置、停下时哪些副作用已经发生都会变；所以取的那一下留在联系人流水线原来的位置
// （危机回合、只想一想的轮次不取，出错当没有），取回来的写进 turn.facts.continuity，contribute 时照原样放。
// 没有开关（App 没有 identityLedger / timeline / webLookup / tastes / acquaintances 时就取不到东西）。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（真实 App 的 memory-app-web-owner-review 测试核对上网查到的那一行；行为基线里这一段一直是空的）。

import type { Module } from '../interpreter/interpreter.ts';

export function continuityModule(): Module {
    return {
        id: 'continuity',
        // 取（ADR 0336「判断那一串」，2026-11-18）：联系人流水线在原来的位置调（心境之后、图片表情之前），上面那几条顾虑都不碰。
        // 危机回合、只想一想的轮次不取（同步返回，不等）；出错当没有、记一行，停下（AbortError）照旧抛出去。
        // 返回的是取回来那个 promise 上接的一层（和原来的 .catch 一样只多一层），流水线只在真去取时等，微任务的拍数不变
        decideAt: {
            continuity(turn, ctx) {
                if (!ctx.continuity || turn.facts.crisis || turn.thinking) return;
                const chat = turn.history;
                const said = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
                return ctx.continuity({ contact: turn.contact, said, initiating: Boolean(turn.initiate), now: turn.at }).then(lines => {
                    if (lines.length) turn.facts.continuity = lines;
                }, (error: unknown) => {
                    if (error instanceof DOMException && error.name === 'AbortError') throw error;
                    ctx.log(`连续性：出错，这一轮不放（${error instanceof Error ? error.message : String(error)}）`);
                });
            },
        },
        contribute(turn) {
            const lines = turn.facts.continuity ?? [];
            return lines.map(text => ({ slot: 'continuity' as const, text }));
        },
    };
}
