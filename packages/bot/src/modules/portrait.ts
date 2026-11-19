// 「我现在的样子」（ADR 0340，配置 selfPortrait，默认关）作为解释器的模块：她每晚自己整份重写的那一份（life/self-portrait.ts），
// 每一轮整份放在角色卡后面（afterMain 的 portrait 槽，紧跟长期记忆里的关系概况）。
// 只给男朋友档；危机的轮次不放（那一轮按危机的最小规则来，别让会变的那部分掺进去）。还没写过就什么都不放。
// 不存状态、不调模型；夜里想、写文件的那一半在 reflections 模块里。

import type { Module } from '../interpreter/interpreter.ts';
import { portraitLine, type PortraitView } from '../life/self-portrait.ts';
import type { Log } from '../platform/log.ts';

export interface PortraitModuleOptions {
    portrait: () => PortraitView;
    log: Log;
}

export function portraitModule(options: PortraitModuleOptions): Module {
    return {
        id: 'portrait',
        contribute(turn) {
            if (turn.contact.tier !== 'boyfriend' || turn.facts.crisis) return [];
            const text = portraitLine(options.portrait());
            if (!text) return [];
            options.log(`[${turn.contact.qq}] 我现在的样子：这一轮整份带上（日志不记内容）`);
            return [{ slot: 'portrait', text }];
        },
    };
}
