// 情绪余温和没了结的事作为解释器的模块（ADR 0336 第 5 步，「心境这一组：方案」第 1 步）：
// - warm（ADR 0028）：他刚道歉、安慰、明确说想她 / 喜欢她之后，她接下来三轮自然软一点（warmAffect 从眼前的聊天重算，连发的气泡算一轮）；
//   只在卡上有心情（moods）时算——陌生人 / 名单外档的卡没有她自己的日子，也不会因为一句越界的「爱你」凭空亲近。
// - unsettled（ADR 0023）：两个人说好的事没成、一件事说到一半就断了，放在心情后面一行，只给事实；
//   他这会儿正在道歉 / 安慰（余温是 repair / comfort，同样要卡上有心情）时换成「他刚刚正在修补，别机械地继续绷着」。
//   挂着的事是旧逻辑从答应的事（promises.openLoops，名单外档不查）取的：等结果的、没回答的进意图行（turn.facts.waiting / unanswered），
//   没了结的写进 turn.facts.unsettled，这里只读。
// warmAffect / describeWarmAffect（emotion/affect.ts）、describeUnsettled（life/open-loops.ts）一个字没改，都是纯函数、不抽随机数；
// 读的聊天记录、卡就是构造 turn 时放进去的同一份，拼段落之前没人改，所以挪到 contribute 时算结果一样。不存状态、不调模型。
// 日志「情绪余温：……」从原来算余温的地方挪到拼段落的时候（同一轮之内，内容不变）；「挂着的事：……」那一行还在旧逻辑里。

import type { Module } from '../interpreter/interpreter.ts';
import type { Piece } from '../interpreter/slots.ts';
import { describeWarmAffect, warmAffect } from '../emotion/affect.ts';
import { describeUnsettled } from '../life/open-loops.ts';
import type { Log } from '../platform/log.ts';

export interface WarmModuleOptions {
    /** 同联系人流水线的日志，前面加 [QQ] */
    log: Log;
}

export function warmModule(options: WarmModuleOptions): Module {
    return {
        id: 'warm',
        contribute(turn) {
            const affect = turn.card?.moods.length ? warmAffect(turn.history) : undefined;
            const loops = turn.facts.unsettled;
            const unsettled = loops ? describeUnsettled(loops.map(what => ({ what })), affect?.kind === 'repair' || affect?.kind === 'comfort') : undefined;
            if (affect) options.log(`[${turn.contact.qq}] 情绪余温：${affect.kind}，还影响 ${affect.remaining} 轮`);
            const warm = describeWarmAffect(affect);
            const pieces: Piece[] = [];
            if (unsettled) pieces.push({ slot: 'unsettled', text: unsettled });
            if (warm) pieces.push({ slot: 'warm', text: warm });
            return pieces;
        },
    };
}
