// 深思作为解释器的模块（ADR 0336 第 5 步）：ADR 0151——他是认真在问她的轮次（要她讲清楚、追着要一个答案、说她不像真人、很大很抽象的问题、认真问她的看法），
// 不套字数和条数、换更强的模型、提示词里只留一句「先想清楚」，放进「此刻」块的 deliberate 槽；
// ADR 0202 语义路由（配置 depthRouting）——关键词没认出来的轮次问一次小模型，分类说值得认真的也走深思，
// 沉重的事 / 质疑她 / 问他们俩再加一小句方向（ROUTED_HINTS），放进 routedHint 槽。
//
// 判断（2026-11-16 起，ADR 0336「判断那一串」，decideAt.deliberate）：在联系人流水线原来的位置判断（图片表情之后、「/亲热」之前），写进 turn.facts.deliberate 和 routedHint，contribute 时照放。
// 原来不挪进 contribute 的几条顾虑（语义路由那次 await 和「/亲热」取走一条、要点整理、货架刷新、别的模块的 contribute 之间的先后）都是「挪了位置」才有的；decideAt 就在原位，先后没变。
// 判断要读的照片、最终的意图、只发表情、小别扭是否生效现在都是 facts。只有要问小模型分类的轮次才返回 promise（流水线只在那时等）；多出的一个微任务落在本来就异步的路上。
// 行为基线没开 depthRouting：关键词认出来的深思由 rich-chat 核对，语义路由那条路由 app.test.ts 的语义路由用例和 decide-stage.test.ts 核对。
// 深思时的另外三处——生成时换模型（useNow）、最多几条（DELIBERATE_MAX_BUBBLES）在联系人流水线（读 facts.deliberate），意图行去掉「怎么答」那一句在 modules/intent-line.ts。
// 形状、长短的模块读同一个 turn.facts.deliberate（深思的轮次不给）。不存状态；分类那次模型调用是流水线给的函数（经执行器），「深思：……」那行日志在判断时记。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 rich-chat 那一轮深思核对 deliberate 槽；routedHint 槽由 app.test.ts 的语义路由那条和 deliberate-module.test.ts 核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import type { ChatMessage } from '../language/prompt.ts';
import { asksToExplain } from '../language/expression.ts';
import { DELIBERATE_NOTE, deliberateTurn } from '../language/deliberate.ts';
import { KIND_LABEL, ROUTED_HINTS, wantsDepth, type TurnWeight } from '../language/turn-weight.ts';

export interface DeliberateModuleOptions {
    /** 换掉深思轮次的那段提示词（只有模拟器的 --deliberate-note 用；线上不传，用 DELIBERATE_NOTE） */
    note?: string;
}

export function deliberateModule(options: DeliberateModuleOptions = {}): Module {
    return {
        id: 'deliberate',
        decideAt: {
            deliberate: (turn, ctx) => {
                const given = ctx.deliberate;
                const { facts, history: chat } = turn;
                // 深思（ADR 0151）：他是认真在问她的轮次；危机 / 只发表情 / 照片 / 被打断 / 只想一想 / 小别扭生效 / 主动找他的轮次照旧让路
                const eligible = Boolean(given) && !turn.initiate && !facts.crisis && !facts.stickerOnly && !facts.photo && !facts.interruption && !turn.thinking && !facts.grievanceActive;
                const saidNow = chat.slice(chat.findLastIndex(message => message.role === 'assistant') + 1).filter(message => message.role === 'user').map(message => message.content).join('\n');
                const lexicalDeep = eligible && deliberateTurn(facts.intent, saidNow, asksToExplain(saidNow));
                const finish = (routed: TurnWeight | undefined): void => {
                    const deep = eligible && (lexicalDeep || wantsDepth(routed));
                    const hint = deep && !lexicalDeep && routed ? ROUTED_HINTS[routed.kind] : undefined;
                    if (!deep) return;
                    facts.deliberate = true;
                    if (hint) facts.routedHint = hint;
                    ctx.log(!lexicalDeep && routed
                        ? `深思：语义路由认为他这一轮是「${KIND_LABEL[routed.kind]}」${routed.why ? `（${routed.why}）` : ''}，这一轮不套字数和条数、用 ${given!.model}、提示词只留一句“先想清楚”${hint ? '、再加一小句方向' : ''}`
                        : `深思：他在认真问她，这一轮不套字数和条数、用 ${given!.model}、提示词只留一句“先想清楚”`);
                };
                // 语义路由（ADR 0202）：关键词没认出来的轮次问一次小模型；只在「关键词说不是、分类说值得认真」时多放行一轮，关键词认出来的照旧
                if (eligible && !lexicalDeep && given!.turnWeight && saidNow.trim()) {
                    return given!.turnWeight({ history: chat as ChatMessage[], said: saidNow }).catch(() => undefined).then(finish);
                }
                finish(undefined);
                return undefined;
            },
        },
        contribute(turn) {
            const { facts } = turn;
            const pieces: Piece[] = [];
            if (facts.deliberate) pieces.push({ slot: 'deliberate', text: options.note ?? DELIBERATE_NOTE });
            if (facts.routedHint) pieces.push({ slot: 'routedHint', text: facts.routedHint });
            return pieces;
        },
    };
}
