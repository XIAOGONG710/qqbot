// 连续性作为解释器的模块（ADR 0336 第 5 步）：ADR 0157–0163——设定改动的背景、QQ 以外做过的事、上网查到的资料、自己发现的口味、又见到的人，
// 按这一轮他说的话取几行，放进「此刻」块的 continuity 槽（一行一段，先后照取回来的顺序）。只给男朋友档（App 的 continuity 里判断）。
// 这一模块只放段落，不取：取的那一下（options.continuity）是异步的，会上网、调模型、记「已经告诉他了」，最长等 25 秒、App 停下时抛 AbortError。
// 它后面紧跟着图片表情、语义路由（又一次模型调用）、「/亲热」取一条、各模块的 contribute（读文件、取走命令结果……），
// 挪到 contribute 时再取，外部调用和日志的先后、等待的位置、停下时哪些副作用已经发生都会变；所以取的那一下留在联系人流水线原来的位置
// （危机回合、只想一想的轮次不取，出错当没有），取回来的写进 turn.facts.continuity，这里照原样放。等它前后那几样都迁成模块，再考虑把取也挪进来。
// 没有开关（App 没有 identityLedger / timeline / webLookup / tastes / acquaintances 时就取不到东西）。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（真实 App 的 memory-app-web-owner-review 测试核对上网查到的那一行；行为基线里这一段一直是空的）。

import type { Module } from '../interpreter/interpreter.ts';

export function continuityModule(): Module {
    return {
        id: 'continuity',
        contribute(turn) {
            const lines = turn.facts.continuity ?? [];
            return lines.map(text => ({ slot: 'continuity' as const, text }));
        },
    };
}
