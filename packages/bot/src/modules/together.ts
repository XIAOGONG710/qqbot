// 陪玩（ADR 0111）作为解释器的模块（ADR 0336 第 5 步）：他答应了她的邀约（或她答应了他的）之后两个半小时，她正和他一起玩——
// assess 时从聊天记录往回推，写进 turn.facts.together（日志在这时记，位置同迁移前）；contribute 时往「此刻」块的 together 槽放一行（回话短、聊局里的事）。
// 让路：只有男朋友档；主动找他（含只想一想）、危机时不放；小别扭、他难过时照样放。不存状态、不调模型。
// 这段时间不插别的主动消息的那一半还在主动消息的接线里（app.ts / sim/runner.ts 的 together 判断），主动消息迁成模块时再收过来。
// 谁邀、谁答应、何时结束的规则都在 language/together.ts，这里只是接线；行为和迁移前 contact.ts 里的逐字一样（行为基线 together 场景核对）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import { describeTogether, togetherNow, type TogetherActivity } from '../language/together.ts';
import type { Log } from '../platform/log.ts';

const DOING: Record<TogetherActivity, string> = { wzry: '打王者', minecraft: '玩我的世界', game: '玩游戏' };

/** 这一轮能不能算陪玩：只有男朋友档；主动找他（只想一想也是主动的一种）、危机时不算 */
export function togetherAllowed(turn: Turn): boolean {
    return turn.contact.tier === 'boyfriend' && !turn.initiate && !turn.facts.crisis;
}

/** log 同联系人流水线的日志，前面加 [QQ] */
export function togetherModule(log: Log): Module {
    return {
        id: 'together',
        assess(turn) {
            if (!togetherAllowed(turn)) return;
            const together = togetherNow(turn.history, turn.at.getTime());
            if (!together) return;
            turn.facts.together = together;
            log(`[${turn.contact.qq}] 陪玩：他们正一起${DOING[together.activity]}（从答应起 ${Math.round((turn.at.getTime() - together.since) / 60_000)} 分钟）`);
        },
        contribute(turn) {
            const { together } = turn.facts;
            return together ? [{ slot: 'together', text: describeTogether(together, turn.at.getTime()) }] : [];
        },
    };
}
