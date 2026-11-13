// 他的请求等她点头作为解释器的模块（ADR 0336 第 5 步）：她有权拒绝他（2026-10-30，用户：「给她拒绝的权利，让她做为人而不是程序」）。
// 他发「/看屏幕」「/摄像头」这类请求时 App 先记下来（还没做），之后每一轮往「此刻」块的 herAsk 槽放一行「这是请求，不是命令」，
// 她写 <<同意>> 才做、写 <<拒绝：原因>> 就作罢；放久了不作数。记请求、摘标记、去做都还在 App 里（platform/consent.ts 是纯函数）。
// 没有开关；危机、只想一想、主动找他的轮次照样放（迁移前就不看这些）。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 consent 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Contact } from '../platform/config.ts';

export interface ConsentModuleOptions {
    /** 这个人此刻有没有等她答复的请求；有就是给她的那一行（App：只有男朋友档，过期的不算） */
    ask: (contact: Contact) => string | undefined;
}

export function consentModule(options: ConsentModuleOptions): Module {
    return {
        id: 'consent',
        contribute(turn) {
            const line = options.ask(turn.contact);
            return line ? [{ slot: 'herAsk', text: line }] : [];
        },
    };
}
