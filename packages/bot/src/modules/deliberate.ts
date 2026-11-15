// 深思作为解释器的模块（ADR 0336 第 5 步）：ADR 0151——他是认真在问她的轮次（要她讲清楚、追着要一个答案、说她不像真人、很大很抽象的问题、认真问她的看法），
// 不套字数和条数、换更强的模型、提示词里只留一句「先想清楚」，放进「此刻」块的 deliberate 槽；
// ADR 0202 语义路由（配置 depthRouting）——关键词没认出来的轮次问一次小模型，分类说值得认真的也走深思，
// 沉重的事 / 质疑她 / 问他们俩再加一小句方向（ROUTED_HINTS），放进 routedHint 槽。
//
// 这一模块只放段落，不判断：判断留在联系人流水线原来的位置（危机、只发表情、照片、被打断、只想一想、小别扭生效、主动找他都不深思），
// 算完写进 turn.facts.deliberate 和 turn.facts.routedHint，这里照原样放。不挪进 contribute 的原因：
// - 语义路由那一下（options.turnWeight）是一次经执行器的模型调用，要 await（最长等 3 秒）；
// - 它和 contribute 之间隔着「/亲热」取走一条（takeIntimateLine 会扣次数）、上下文要点在后台开一次整理（又一次模型调用，原来排在分类回来之后才发）、
//   图片表情 / 照片的货架刷新、读聊天记录，以及排在前面的模块的 contribute——取走命令结果（shell 的 noteOf 读完就删）、他的请求等她点头（看墙上时间判断过期）、
//   读灵魂目录和她自己记下的东西的文件……挪过去，这些读 / 取就从 await 之后变成 await 之前，外部调用由先后变成同时在跑，日志的先后也变；
// - 判断要读的照片、意图、图片表情、小别扭是否生效还在旧逻辑里，assess 时都还不知道，没有更早的阶段可放；
// - 行为基线一个场景都没开 depthRouting（快照里没有分类那次调用，也没有一句 ROUTED_HINTS），「基线逐字不变」证明不了挪动安全。
// 和连续性（modules/continuity.ts）、真人数值（modules/human-state.ts）同一个退路。等照片 → 意图 → 心境 → 图片表情这几样迁成模块，再把判断和那一次调用挪进来。
// 这里不再判断危机 / 只想一想等：判断在旧逻辑一处，挡在两处时变异只能抓到一处。
// 深思时的另外三处——生成时换模型（useNow）、最多几条（DELIBERATE_MAX_BUBBLES）、意图行去掉「怎么答」那一句——都还在旧逻辑，读它自己的 deliberateNow。
// 形状、长短的模块读同一个 turn.facts.deliberate（深思的轮次不给）。不存状态、不调模型、不记日志（「深思：……」那行日志留在判断的地方）。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 rich-chat 那一轮深思核对 deliberate 槽；routedHint 槽由 app.test.ts 的语义路由那条和 deliberate-module.test.ts 核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { DELIBERATE_NOTE } from '../language/shape.ts';

export interface DeliberateModuleOptions {
    /** 换掉深思轮次的那段提示词（只有模拟器的 --deliberate-note 用；线上不传，用 DELIBERATE_NOTE） */
    note?: string;
}

export function deliberateModule(options: DeliberateModuleOptions = {}): Module {
    return {
        id: 'deliberate',
        contribute(turn) {
            const { facts } = turn;
            const pieces: Piece[] = [];
            if (facts.deliberate) pieces.push({ slot: 'deliberate', text: options.note ?? DELIBERATE_NOTE });
            if (facts.routedHint) pieces.push({ slot: 'routedHint', text: facts.routedHint });
            return pieces;
        },
    };
}
