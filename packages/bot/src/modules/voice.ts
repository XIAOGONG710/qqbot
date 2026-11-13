// 她可以说出来（语音提示）作为解释器的模块（ADR 0336 第 5 步）：DSH 线 11-01 声音定稿后加的，
// 告诉她「想让他听见的时候」可以单独写一行 <<语音：…>>（规则在 language/speaking.ts）。
// 2026-11-13 起每轮都给（不再按概率）：发不发由她自己决定。
// 只给男朋友档；危机、只想一想、主动找他的轮次不给。不存状态、不调模型。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import { voiceHint } from '../language/speaking.ts';
import type { Log } from '../platform/log.ts';

/** 这一轮能不能给：只有男朋友档；危机、只想一想、主动找他时不给 */
export function voiceAllowed(turn: Turn): boolean {
    return turn.contact.tier === 'boyfriend' && !turn.facts.crisis && !turn.thinking && !turn.initiate;
}

/** log 同联系人流水线的日志，前面加 [QQ] */
export function voiceModule(log: Log): Module {
    return {
        id: 'voice',
        contribute(turn) {
            if (!voiceAllowed(turn)) return [];
            log(`[${turn.contact.qq}] 说话：这一轮告诉她可以发语音`);
            return [{ slot: 'voice', text: voiceHint() }];
        },
    };
}
