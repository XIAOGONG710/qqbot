// 时间块里跟着时间那一行的另几行作为解释器的模块（ADR 0336 第 5 步）：
// - days（ADR 0011 决策 6）：重要的日子临近、当天的说明（「[明天是双十一（……）]」），一行一个日子。
// - selfNote（ADR 0083）：她在 QQ 上的样子——个性签名、最近三天发的说说；她刚才刷空间看到的另起一行。
// - promised（ADR 0018 决策 2）：她之前答应他、还没做的事，到了日子提醒一句；承诺记录读不了时是「暂不可确认，别编」那一句。
//
// 重要的日子是纯函数（卡上的 dates + 这一轮的时刻，农历用 Intl，不读文件、不记日志、不抽随机数），这里在 contribute 时现算，
// 和迁移前在 buildPrompt 开头算出来一样：卡就是 turn.card（危机换卡只换说话用的那份），时刻就是 turn.at。
// 另外两行在联系人流水线原来的位置取（2026-11-18 起是这里的 decideAt.promises，流水线在原位调），写进 turn.facts，contribute 时只放：
// - 她在 QQ 上的样子读的是 presence 的内存状态，后台每分钟的 tick 会改它（换签名、发说说、刷空间）；原位置和 contribute 之间隔着
//   连续性、语义路由两次 await，挪过去这期间落地的改动就会进这一轮。
// - 答应的事每次读承诺状态（可能读文件、记「承诺状态暂时读不了」的日志），还要在 assess 之前写 facts.promised（意图阶梯读它），
//   日志「时间块里提醒了她答应的事」（sim.test.ts 断言）也在那里。
// 条件（名单外不取答应的事）都在取的地方，这里不看档位、危机、只想一想、主动找他（迁移前这三行都不看）。
// 不存状态、不调模型；只有 decideAt.promises 记「时间块里提醒了她答应的事」那一行。同步返回，不多等一个微任务（行为基线核对事件顺序）。

import type { Module, TurnFacts } from '../interpreter/interpreter.ts';
import type { ChatMessage } from '../language/prompt.ts';
import { UNLISTED_TIER } from '../platform/config.ts';
import type { Piece } from '../interpreter/slots.ts';
import { describeDays } from '../language/time-context.ts';

/** 这几样由联系人流水线写进 turn.facts，这里只读（字段说明见 interpreter.ts 的 TurnFacts） */
export type TimeNotesFacts = Pick<TurnFacts, 'selfNote' | 'promisedLine'>;

export function timeNotesModule(): Module {
    return {
        id: 'time-notes',
        // 取（ADR 0336「判断那一串」，2026-11-18）：联系人流水线在原位（perceive 之后、assess 之前）调，上面两条顾虑都不碰。
        // 她在 QQ 上的样子原来在问到那一天的流水账之前读——那是 presence 的内存状态，中间没有 await，挪到这里一样
        decideAt: {
            promises(turn, ctx) {
                const selfNote = ctx.selfNote?.(turn.at.getTime());
                const promised = turn.contact.tier !== UNLISTED_TIER ? ctx.promises?.describe(turn.contact, turn.history as ChatMessage[], turn.at) : undefined;
                if (promised) ctx.log('时间块里提醒了她答应的事');
                if (promised) Object.assign(turn.facts, { promised: true, promisedLine: promised });
                if (selfNote) turn.facts.selfNote = selfNote;
            },
        },
        contribute(turn) {
            const facts = turn.facts;
            const pieces: Piece[] = [];
            const days = turn.card ? describeDays(turn.card.dates, turn.at) : undefined;
            if (days) pieces.push({ slot: 'days', text: days });
            if (facts.selfNote) pieces.push({ slot: 'selfNote', text: facts.selfNote });
            if (facts.promisedLine) pieces.push({ slot: 'promised', text: facts.promisedLine });
            return pieces;
        },
    };
}
