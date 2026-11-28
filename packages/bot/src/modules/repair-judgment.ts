// 道歉 / 解释有没有接住那件事（硬编码改造第五批，QQBOT_REPAIR_JUDGMENT=1，默认关；判据和边界见 emotion/repair-judgment.ts）。
// 挂在心境模块前面：decideAt.feelings 先把语义判断取回来（平时它在 decideAt.deliberate 才取，比算心境晚），
// 按这一轮的判断记下他最后那几句算不算修复，再把记着的那几条写进 turn.facts.repairVerdicts，心境模块（modules/feelings.ts）按它认修复证据。
// 提前取的代价：判断和召回等几步并行，最慢的一轮在这里多等，最多是判断的时限（2.5 秒）。开关关着时不挂，一个字不变。
// 日志只记接没接住、几条，不记原话，也不带 QQ 号（用模块自己的日志）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import type { Log } from '../platform/log.ts';
import { RepairVerdicts, verdictsFromJudgment } from '../emotion/repair-judgment.ts';

export interface RepairJudgmentOptions {
    /** 语义判断模块的 settle：取回这一轮的判断（取过就没有了） */
    settle: (turn: Turn) => Promise<void> | undefined;
    log: Log;
}

export function repairJudgmentModule(options: RepairJudgmentOptions): Module {
    const remembered = new RepairVerdicts();
    const record = (turn: Turn) => {
        const judgment = turn.facts.semanticJudgment;
        if (judgment && turn.contact.tier === 'boyfriend') {
            const verdicts = verdictsFromJudgment(turn.history, judgment);
            if (verdicts.size) {
                remembered.remember(verdicts);
                const caught = [...verdicts.values()].filter(Boolean).length;
                options.log(`道歉判断：他这几句${caught ? `接住了那件事（${caught} 条算修复）` : '不算修复'}，记着 ${remembered.size} 条（日志不记原话）`);
            }
        }
        if (remembered.size) turn.facts.repairVerdicts = remembered.snapshot();
    };
    return {
        id: 'repair-judgment',
        decideAt: {
            feelings(turn) {
                const settled = options.settle(turn);
                if (settled) return settled.then(() => record(turn));
                record(turn);
                return undefined;
            },
        },
    };
}
