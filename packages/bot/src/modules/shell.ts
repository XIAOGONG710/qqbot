// 她可以在这台电脑上跑命令，作为解释器的模块（ADR 0336 第 5 步）：DSH 线 10-30（用户：「直接将本机的最高权限给她」）。往「此刻」块放两样，不存状态、不调模型：
// - shell：她上一轮跑的命令的结果（App 记在内存里，给她看一眼就清掉；结果要回到她脑子里）。只给男朋友档，危机时不放。
// - shellIntent：告诉她可以单独写一行 <<执行：命令>>、结果下一轮给她（language/intent.ts 的 SHELL_INTENT）。
//   只给男朋友档；只想一想时不给（想事情不走发送，命令不会跑，只会被当成一个念头存下来——11-02 探针里有一个念头整句是 <<执行：Get-Date …>>），
//   危机、这一轮小别扭真的生效时也不给（turn.facts.grievanceActive，旧逻辑算意图改写之后写进来）。
// 跑命令本身（解析、拦截、执行、审计）还在 app.ts / platform/shell-tool.ts，设备 / 执行器迁移时再收。
// 行为和迁移前 contact.ts 里的一样（行为基线核对）；命令结果读出来的时刻从算意图前后挪到了拼段落时，见 ADR 0336「她可以跑命令」一节。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { SHELL_INTENT } from '../language/intent.ts';
import type { Contact } from '../platform/config.ts';

export interface ShellModuleOptions {
    /** 这个人这一轮要给她看的命令结果，读了就清掉（App 给；模拟器不跑命令，不给） */
    noteOf?: (contact: Contact) => string | undefined;
}

export function shellModule(options: ShellModuleOptions = {}): Module {
    return {
        id: 'shell',
        contribute(turn: Turn) {
            if (turn.contact.tier !== 'boyfriend' || turn.facts.crisis) return [];
            const pieces: Piece[] = [];
            const note = options.noteOf?.(turn.contact);
            if (note) pieces.push({ slot: 'shell', text: note });
            if (!turn.thinking && !turn.facts.grievanceActive) pieces.push({ slot: 'shellIntent', text: SHELL_INTENT });
            return pieces;
        },
    };
}
