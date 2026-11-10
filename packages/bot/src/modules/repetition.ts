// 别重复自己作为解释器的模块（ADR 0336 第 5 步）：三行提醒，都从聊天记录现算，不存状态、不调模型、没有开关。
// - 反复说的字词（10-22 深夜测试：被追问时原地打转、同一件事说三个晚上）：她最近几条里反复在说的，这一轮让她换个反应；主动找他、危机回合不放。
// - 主动找他的开头（ADR 0135）：最近几次开头用了同一个起头词（「刚」「人呢」……）就换一种；只在主动找他时，危机、只想一想不放。
// - 说过了的事（ADR 0098）：她这一天半里已经主动跟他说过的，他不问就别再自己提；事实还在时间块里，他问起来照常答。只想一想不放。
//   assess 时写进 turn.facts.told（危机回合不算），旧逻辑读它：形状挑“带自己的事”时跳过说过了的。
// 判断规则都在 language/expression.ts（recentCrutches / repeatedOpener / alreadyTold），这里只是接线；
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 repetition 场景核对）。

import type { Module, Turn } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { alreadyTold, recentCrutches, repeatedOpener } from '../language/expression.ts';
import type { Log } from '../platform/log.ts';

/** 这一轮的三行（按槽位：crutch、opener、told）；没有的不放 */
export function repetitionPieces(turn: Turn, log: Log = () => {}): Piece[] {
    const { crisis, told = [] } = turn.facts;
    const initiating = Boolean(turn.initiate);
    const pieces: Piece[] = [];
    const crutches = !initiating && !crisis ? recentCrutches(turn.history) : [];
    if (crutches.length) {
        pieces.push({ slot: 'crutch', text: `[你这几条里反复在说「${crutches.join('」「')}」：这一轮别再用这几个字，换个反应——直接答、逗他、反问、认怂、生气都行]` });
        log(`[${turn.contact.qq}] 最近反复说的字词：${crutches.join('、')}（提示词里让她换个反应）`);
    }
    const opener = initiating && !crisis && !turn.thinking ? repeatedOpener(turn.history) : undefined;
    if (opener) {
        pieces.push({ slot: 'opener', text: `[你最近几次开头都是「${opener}」：这次换一种开头，别用「${opener}」起头]` });
        log(`[${turn.contact.qq}] 最近几次开头都是「${opener}」（提示词里让她这次换个开头）`);
    }
    if (told.length && !turn.thinking) {
        pieces.push({ slot: 'told', text: `[这些事你已经主动跟他说过了：${told.join('、')}。他不问，就别再自己提]` });
        log(`[${turn.contact.qq}] 已经主动说过：${told.join('、')}（提示词里让她不再自己提）`);
    }
    return pieces;
}

/** log 同联系人流水线的日志，前面加 [QQ] */
export function repetitionModule(log: Log): Module {
    return {
        id: 'repetition',
        // 先判断说过了的事（旧逻辑的形状要读）；危机回合不算
        assess(turn) {
            if (!turn.facts.crisis) turn.facts.told = alreadyTold(turn.history, turn.at.getTime());
        },
        contribute: turn => repetitionPieces(turn, log),
    };
}
