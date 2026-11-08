// 她自己决定记不记（配置 selfDirectedMemory，DSH 10-30 / 10-31）往提示词里放的三行，作为解释器的模块（ADR 0336 第 5 步）：
// - selfMemory：「记忆由你自己决定」——值得长期记住的才写 <<记住：…>>，还有 <<日记>> <<私密>> <<查>> 这些标记（标记不会发出去，解析在 app.ts）。各档位每一轮都放。
// - understanding：他这句话和以前被他纠正过的事撞上时，提醒她当时理解偏在哪（规则在 life/understanding.ts）。
// - traces：他最近说过 / 做过 / 答应过的事，聊到相关的再提（规则在 life/traces.ts）。
// 后两样只给男朋友档（记的时候就只记他的），她主动找他的轮次不放。不调模型；记下纠正和痕迹的那一半还在 app.ts 收消息的地方。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 self-memory 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';

/** 她自己决定记不记：只在这条真的值得长期记住时，回复最后另起一行写标记；标记不会发出去 */
export const SELF_MEMORY_NOTE = '记忆由你自己决定：只有这条真的值得长期记住（约定、他的重要事、你自己想记住的），才在回复最后另起一行写 `<<记住：一句话>>`；想写今天的事就写 `<<日记：一段>>`；有不想让他知道的真实想法，写 `<<私密：…>>`（不会发出去，只记在私密日记）。不想答应的事可以拒绝；拒绝后把真实想法写进 `<<私密：…>>`。想不起某件事时，别硬编，写 `<<查：关键词>>`，系统会把你想起的东西给你再回。这些标记不会发出去。不重要就不写，别每条都记。';

export interface SelfMemoryOptions {
    /** 他这句话撞上以前被纠正过的事时的那一行（App 从数据目录现读） */
    understanding: (hisWords: string) => string | undefined;
    /** 他最近说过 / 做过 / 答应过的事那一行（App 从数据目录现读） */
    traces: () => string | undefined;
}

export function selfMemoryModule(options: SelfMemoryOptions): Module {
    return {
        id: 'self-memory',
        contribute(turn) {
            const pieces: Piece[] = [];
            if (turn.contact.tier === 'boyfriend' && !turn.initiate) {
                const hisWords = [...turn.history].reverse().find(message => message.role === 'user')?.content?.trim();
                const understood = hisWords ? options.understanding(hisWords) : undefined;
                if (understood) pieces.push({ slot: 'understanding', text: understood });
                const traces = options.traces();
                if (traces) pieces.push({ slot: 'traces', text: traces });
            }
            pieces.push({ slot: 'selfMemory', text: SELF_MEMORY_NOTE });
            return pieces;
        },
    };
}
