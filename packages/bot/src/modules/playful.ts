// 轻松的那几样（小梗 ADR 0114、口头习惯 ADR 0138……）什么时候让路：几个模块共用的一条规则，单独放在这里，模块之间不互相 import。

import type { Turn } from '../interpreter/interpreter.ts';

/** 他难过的轮次（意图行是「先接住他此刻的情绪」） */
const COMFORTING = /先接住他此刻的情绪/;

/** 这一轮能不能来点轻松的：只有男朋友档；主动找他、只想一想、危机、小别扭、他难过时都不行 */
export function playfulAllowed(turn: Turn): boolean {
    const { crisis, grievance, baseIntent } = turn.facts;
    return turn.contact.tier === 'boyfriend' && !turn.initiate && !turn.thinking && !crisis && !grievance && !(baseIntent && COMFORTING.test(baseIntent));
}
