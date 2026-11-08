// 她看视频（ADR 0130）作为解释器的模块（ADR 0336 第 5 步），这次只迁「放进提示词」的那一半：
// - 一轮回复时，他问到“最近看了什么 / 刷到什么 / B 站 / 视频”，按 watchedLine 的规则往「此刻」块的 watched 槽放她真看过的两条。
// - 让路和小梗那几样不一样：只有男朋友档；主动找他、只想一想、危机时不放；小别扭、他难过时照样放（他问了就答）。
// 她自己去“看”的那一半（每天一次、要她的 B 站号）和内心念头里用到的看过的事实（主动消息计划器的 watchedFacts）还在 app.ts，B 站 / 主动消息迁成模块时一起收。
// 挑哪两条的规则都在 language/watching.ts，这里只是接线；行为和迁移前 contact.ts 里的逐字一样（行为基线 watched 场景核对）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import { watchedLine, type Watched } from '../language/watching.ts';
import type { Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';

/** 这一轮能不能放她看过的：只有男朋友档；主动找他、只想一想、危机时不放 */
export function watchedAllowed(turn: Turn): boolean {
    return turn.contact.tier === 'boyfriend' && !turn.initiate && !turn.thinking && !turn.facts.crisis;
}

/** watchedOf：她看过的记录（App 是内存里的那份，看完一个就换新的；模拟器给场景里写好的）；log 同联系人流水线的日志，前面加 [QQ] */
export function watchedModule(watchedOf: (contact: Contact) => readonly Watched[], log: Log): Module {
    return {
        id: 'watched',
        contribute(turn) {
            if (!watchedAllowed(turn)) return [];
            const line = watchedLine(watchedOf(turn.contact), turn.history, turn.at);
            if (!line) return [];
            log(`[${turn.contact.qq}] 她看视频：这一轮提示词里放了她最近看过的（日志不记内容）`);
            return [{ slot: 'watched', text: line }];
        },
    };
}
