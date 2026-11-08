// 他的口气作为解释器的模块（ADR 0336 第 5 步）：DSH 线 10-30 加的（用户：「我想让她自己判断我在跟她聊天的时候是把她当成程序还是人」），
// 往「此刻」块的 register 槽放一段、不存状态、不调模型。规则都在 language/register.ts，这里只是接线：
// - 他这几句是在跟她说话，还是在使唤一个工具（registerLine）；
// - 他是在跟「程序」说话时，她自己选用哪种身份接（identityLine）；
// - 他问了很元的东西时别只剩空附和（ackGuardLine）；
// - 最近使唤得明显比说话多时，她不是每次都得给好脸（temperLine）。
// 只递观察，怎么回由她自己定。只给男朋友档；主动找他、只想一想、危机时不放。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 register 等场景核对）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import { ackGuardLine, identityLine, readRegister, registerLine, registerSummary, temperLine } from '../language/register.ts';
import type { Log } from '../platform/log.ts';

/** 这一轮能不能放：只有男朋友档；主动找他、只想一想、危机时不放 */
export function registerAllowed(turn: Turn): boolean {
    return turn.contact.tier === 'boyfriend' && !turn.initiate && !turn.thinking && !turn.facts.crisis;
}

/** log 同联系人流水线的日志，前面加 [QQ] */
export function registerModule(log: Log): Module {
    return {
        id: 'register',
        contribute(turn) {
            if (!registerAllowed(turn)) return [];
            const read = readRegister(turn.history);
            if (read.cues.length) log(`[${turn.contact.qq}] 他的口气：${read.kind}（${read.cues.join('；')}）`);
            // 连着被当工具使唤：给她一句「你没必要每次都陪着」，态度由她定
            const temper = temperLine(registerSummary(turn.history));
            if (temper) log(`[${turn.contact.qq}] 他的口气：最近使唤得比说话多`);
            const lines = [registerLine(read), identityLine(read), ackGuardLine(turn.history), temper].filter(Boolean);
            return lines.length ? [{ slot: 'register', text: lines.join('\n') }] : [];
        },
    };
}
