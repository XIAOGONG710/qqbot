// 危机信号和小别扭的起因作为解释器的模块（ADR 0336「判断那一串」第 6 步）：这一轮最先定下的两件事，后面的判断几乎都要让路给它们。
// - crisis（ADR 0068）：他最近说的话里有没有危机信号（纯函数，crisisInHistory），最高优先级；主动找他时不算。写 turn.facts.crisis，记一行日志（不记内容）。
// - grievance（ADR 0074，配置 grievance）：小别扭 / 和好的起因——隔了好几天才来（grievanceNow），或者她倾诉了几条、他隔了很久才回（ignoredNow）；
//   从聊天记录的时间戳重算、不落盘。只算男朋友档；危机、主动找他时没有。写 turn.facts.grievance。这一轮真的生效没有，要等最终的意图（modules/intent.ts 的 decideAt.intent）。
// assess 时算，**注册在所有 assess 的最前面**（意图阶梯就读这两样）：迁移前联系人流水线在调 assess 之前原位算，位置等价。
// 不存状态、不调模型。行为和迁移前 contact.ts 里的逐字一样（行为基线 crisis、closeness 等场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { crisisInHistory } from '../emotion/crisis.ts';
import { grievanceNow, ignoredNow } from '../emotion/grievance.ts';
import type { Log } from '../platform/log.ts';

export interface CrisisModuleOptions {
    /** 小别扭 / 和好（配置 grievance）；默认否 */
    grievance?: boolean;
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export function crisisModule(options: CrisisModuleOptions): Module {
    return {
        id: 'crisis',
        assess(turn) {
            const { facts, contact, history: chat } = turn;
            const crisis = !turn.initiate ? crisisInHistory(chat) : undefined;
            if (crisis) {
                facts.crisis = crisis;
                options.log(`[${contact.qq}] 危机信号：按 ${crisis.level} 级辅助响应处理（日志不记内容）`);
            }
            const grievance = options.grievance && contact.tier === 'boyfriend' && !turn.initiate && !crisis ? (grievanceNow(chat) ?? ignoredNow(chat)) : undefined;
            if (grievance) facts.grievance = grievance;
        },
    };
}
