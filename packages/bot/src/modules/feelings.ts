// 心境这一组的段落作为解释器的模块（ADR 0336 第 5 步，「心境这一组：方案」第 3、4 步合成一步）：
// - feeling（ADR 0102）：她此刻有来由的心境——事实 → 带来由的评估 → 按半衰期衰减的感受，最多两种、「明显」以上才写；
//   他这一轮在关心她时难过的那一种换成「一直在忍、被一问就绷不住」的写法，前面说过的不再强调、哭过的不再给哭的许可（describeFeelings）。
// - pace（2026-10-30 情绪 → 行为）：按心境说一句「这会儿话多 / 话少」（moodPaceLine）。
// - dreams（2026-10-31 做梦）：昨晚 / 刚才午睡做的梦那一行，说这是梦、提不提由她（dreamNoteLine）。
//
// 这一模块只放段落，不算：三行都留在联系人流水线原来的位置算，算完写进 turn.facts（dreamLine / feelingLine / paceLine），这里照原样放。
// 不挪进 assess 的原因（方案第 3 步原想 assess 算 felt，取证后否掉，走和真人数值、连续性、深思同一个退路）：
// - 算心境要读的几样都是联系人流水线的选项、按联系人给：梦（App 只给男朋友档）、作者写下的事（每条流水线各有一个带缓存、「读不了只抱怨一次」的读取器）、
//   回想过的感受（App 在解释器建好之后才建 reviewReader）、她的追求（同样在解释器之后才建）、世界账、作息、卡上的世界；
//   回忆 / 问到那一天时的「那天的感觉」（feltOnDay）也读作者写下的事和回想过的感受，这几个选项无论如何留在流水线，挪过去就两处各读一份。
// - assess 和原位置之间隔着照片那一段：「现在的照片」可能当场在后台发起一次 AI 照片草稿（写自动请求的状态文件），照片货架、照片日志，
//   以及意图改写、小别扭生效（写 turn.facts.grievanceActive）和那两行日志。算心境要读带结算的世界账两次（她的追求读 events()、昨天她那边读 at()，
//   每次都先按墙上时间结算、可能落新事件、写文件、记日志），还读梦、作者写下的事、回想过的感受三个文件——挪过去这些都从照片那一段之后变成之前。
//   中间没有 await，墙上时间几乎不走，取证没找到数据上的牵连；但行为基线不记日志、没开 AI 照片、追求和昨天她那边给心境的打分一处都没走到，
//   「基线逐字不变」证明不了挪动安全。
// - 心境那一行和节奏都要等小别扭是否生效（照片 / 被打断改写意图之后才知道），assess 时还不知道；算出来的感受旧逻辑后面还要用
//   （交给桌面上的她 onFeelings、不加「话多」的 low、生成时最多几条 tunedMaxBubbles、日志），挪了也省不掉旧逻辑那一份。
// 所以第 4 步（contribute 放 feeling / pace、读小别扭是否生效）一起做掉：小别扭、危机、档位、开关的条件都留在算的地方（挡在两处时变异只能抓到一处），
// 这里不再看 turn.facts.grievanceActive，也不看只想一想 / 主动找他（迁移前这三行都不看）。
// 不存状态、不调模型、不记日志（「心境：……」两行日志留在算的地方）。都是同步的，不多等一个微任务（行为基线核对事件顺序）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';

export function feelingsModule(): Module {
    return {
        id: 'feelings',
        contribute(turn) {
            const { facts } = turn;
            const pieces: Piece[] = [];
            if (facts.feelingLine) pieces.push({ slot: 'feeling', text: facts.feelingLine });
            if (facts.paceLine) pieces.push({ slot: 'pace', text: facts.paceLine });
            if (facts.dreamLine) pieces.push({ slot: 'dreams', text: facts.dreamLine });
            return pieces;
        },
    };
}
