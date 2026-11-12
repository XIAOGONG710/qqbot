// 真人例子（ADR 0190）作为解释器的模块（ADR 0336 第 5 步）：
// 男朋友这一轮最后一句话和语料里哪几条「他说」像，就把真人在那几句后面怎么回的放进 exemplar 槽（最多 4 条）——只给她看真人怎么回，不给她定字数。
// 只给男朋友档；主动找他、只想一想、危机、小别扭的回合不放。跟着配置 exemplars 开（语料在 App 启动时读一次，由 App 传进来）。
// 不存状态、不调模型。挑哪几条、怎么写都在 language/exemplars.ts（pickExemplars / exemplarLine），这里只是接线；
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 exemplars 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { exemplarLine, pickExemplars, type Exemplar } from '../language/exemplars.ts';
import type { Log } from '../platform/log.ts';

export interface ExemplarsModuleOptions {
    /** 已批准的真人语料（配置 exemplars 关着或没读到就是空的） */
    exemplars: readonly Exemplar[];
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export function exemplarsModule(options: ExemplarsModuleOptions): Module {
    return {
        id: 'exemplars',
        contribute(turn) {
            const { contact, history } = turn;
            if (!options.exemplars.length || contact.tier !== 'boyfriend' || turn.initiate || turn.thinking || turn.facts.crisis || turn.facts.grievance) return [];
            const last = history.findLast(message => message.role === 'user');
            if (!last) return [];
            const text = exemplarLine(pickExemplars(options.exemplars, last.content, { k: 4 }));
            if (!text) return [];
            options.log(`[${contact.qq}] 真人例子：这一轮放了几条真人的回法（日志不记内容）`);
            return [{ slot: 'exemplar', text }];
        },
    };
}
