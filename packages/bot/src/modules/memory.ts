// 记忆这一组的段落作为解释器的模块（ADR 0336 第 5 步）：
// - relationship（main 之后，同 ST 的 After Main Prompt）：他私人库里的关系概况（ADR 0012）。
// - summary（ADR 0043，配置 contextTurns）：更早聊天的要点（原文只放最近几轮时）。
// - recalled（ADR 0012 / 0018）：他的私人记忆，按这一轮他说的召回；主动找他时按想说的事 + 时间窗。
// - work（ADR 0176）：她在 DSH 里做过的事（工作房），男朋友档每轮都查。
// - desktop（ADR 0177，配置 crossRecent）：他刚才在 DSH 桌面上和她的对话。
// - common（ADR 0016 / 0017）：公共记忆——有线索时想起、刚想起的接下来两轮沿用。
// - recap（ADR 0032）：他问到过去的某一天时，那天她那边的流水账（带那天的日记、那天的感觉）。
// - today（ADR 0020）：她今天和别人聊过的（亲密联系人开启新一段、或她主动找他，且没有公共记忆时）。
// - people（ADR 0016 / 0017）：他提到的名单里的人，一人一段（介绍 + 她对那人的印象 + 那人库里的旧事），按提到的先后。
// - disclosure（ADR 0020）：上面有 common / today / people 任何一段时，接一段「说别人的事的分寸」（disclosureRules，纯函数，只看听的人的称呼和档位）。
//
// 这一模块只放段落，不取：召回都在联系人流水线原来的位置（buildPrompt 开头那一串 await：公共库的实体名、他的 / 公共的 / 提到的人的召回一起等、
// 工作房、沿用时再想一次、今天和别人聊过的），走和连续性、真人数值、心境同一个退路——
// - 那几次 await 要等真实的 Hindsight（每次都记「最近一次召回」、可能读状态文件、失败记日志、停下时返回空），夹在真人数值 / 成长层（读带结算的世界账）
//   和 onHerDay、perceive 之间；挪到 contribute 时，等待的位置、外部调用和日志的先后、停下时哪些已经发生都会变。
// - 关系概况和印象是「返回缓存、过期了在后台重读」：什么时候调决定了后台那次读在哪一轮之前落地（行为基线的 memory 场景第二轮起才有关系概况，就是这个先后）。
// - 召回的结果旧逻辑还要用：变淡统计和召回日志、线索（cue）定时间窗和要不要查「今天和别人聊过的」、common 有了就不查 today、要点决定原文放多少（note 那一句）。
// - 要点（summary）那一下会在后台起一次整理（contextWindow.summarize），也留在原位。
// 所以旧逻辑算完把最终的字（她的名字已换成「你」）写进 turn.facts.memory，这里照原样放；有没有、空串当没有，和迁移前 when() 的真假判断一样。
// 不看危机、只想一想、主动找他（迁移前这几段都不看；该不该召回由召回的地方定，挡在两处时变异只能抓到一处）。
// 不存状态、不调模型、不记日志（召回的几行日志留在原位）。都是同步的，不多等一个微任务（行为基线核对事件顺序）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Piece, Slot } from '../interpreter/slots.ts';
import { disclosureRules } from '../emotion/disclosure.ts';

/**
 * 记忆这一组放进提示词的几段：联系人流水线原位召回 / 读好之后写进 turn.facts.memory（她的名字已换成「你」），modules/memory.ts 照原样放。
 * TurnFacts.memory 的类型（interpreter.ts 引用这里）
 */
export interface MemoryPieces {
    /** 关系概况（ADR 0012）：放进 main 之后 */
    relationship?: string;
    /** 更早聊天的要点（ADR 0043） */
    summary?: string;
    /** 他的私人记忆 */
    recalled?: string;
    /** 她在 DSH 里做过的事（工作房，ADR 0176） */
    work?: string;
    /** 他刚才在 DSH 桌面上和她的对话（ADR 0177） */
    desktop?: string;
    /** 公共记忆（ADR 0016 / 0017，含沿用刚才想起的） */
    common?: string;
    /** 他问到的那一天她那边的流水账（ADR 0032，recapText 的结果） */
    recap?: string;
    /** 她今天和别人聊过的（ADR 0020） */
    today?: string;
    /** 他提到的名单里的人，一人一段（describePerson 的结果），按提到的先后 */
    people?: readonly string[];
}

export function memoryModule(): Module {
    return {
        id: 'memory',
        contribute(turn) {
            const memory = turn.facts.memory;
            if (!memory) return [];
            const pieces: Piece[] = [];
            const put = (slot: Slot, text: string | undefined) => { if (text) pieces.push({ slot, text }); };
            put('relationship', memory.relationship);
            put('summary', memory.summary);
            put('recalled', memory.recalled);
            put('work', memory.work);
            put('desktop', memory.desktop);
            put('common', memory.common);
            put('recap', memory.recap);
            put('today', memory.today);
            // 迁移前一人一段、不按真假筛（describePerson 至少有「你认识的人」那一行）
            const people = memory.people ?? [];
            for (const text of people) pieces.push({ slot: 'people', text });
            if (memory.common || memory.today || people.length) pieces.push({ slot: 'disclosure', text: disclosureRules(turn.contact) });
            return pieces;
        },
    };
}
