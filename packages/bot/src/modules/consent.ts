// 他的请求等她点头作为解释器的模块（ADR 0336 第 5 步）：她有权拒绝他（2026-10-30，用户：「给她拒绝的权利，让她做为人而不是程序」）。
// 他发「/看屏幕」「/摄像头」这类请求时 App 先记下来（还没做），之后每一轮往「此刻」块的 herAsk 槽放一行「这是请求，不是命令」，
// 她写 <<同意>> 才做、写 <<拒绝：原因>> 就作罢；放久了不作数。记请求、去做还在 App 里（platform/consent.ts 是纯函数）。
// 摘标记（ADR 0336「生成之后那一段」第 12 步，absorbAt.consent）：只给男朋友档。拒绝——撤掉他的请求、把她的原因告诉他；同意——请求还在、没过期才去做。
// 请求的存取和「去做 / 告诉他」是 App 给的函数（answer），App 给了才摘。
// 没有开关；危机、只想一想、主动找他的轮次照样放（迁移前就不看这些）。不存状态、不调模型。
// 行为和迁移前 contact.ts 里的逐字一样（行为基线 consent 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Contact } from '../platform/config.ts';
import { takeConsent } from '../platform/consent.ts';
import type { Log } from '../platform/log.ts';

export interface ConsentModuleOptions {
    /** 这个人此刻有没有等她答复的请求；有就是给她的那一行（App：只有男朋友档，过期的不算） */
    ask: (contact: Contact) => string | undefined;
    /** 她写了 <<同意>> / <<拒绝：原因>> 时怎么办（App 给） */
    answer?: {
        /** 撤掉他等着的请求；返回原来有没有 */
        withdraw: (contact: Contact) => boolean;
        /** 把她拒绝的原因告诉他 */
        tellRefusal: (contact: Contact, reason: string) => void;
        /** 他的请求还在、没过期：取走它（之后不再等），返回它叫什么和怎么去做；没有就不返回 */
        claim: (contact: Contact) => { label: string; run: () => void } | undefined;
        log: Log;
    };
}

export function consentModule(options: ConsentModuleOptions): Module {
    return {
        id: 'consent',
        contribute(turn) {
            const line = options.ask(turn.contact);
            return line ? [{ slot: 'herAsk', text: line }] : [];
        },
        ...(options.answer ? { absorbAt: {
            consent: (input: string, contact: Contact) => {
                if (contact.tier !== 'boyfriend') return input;
                const { withdraw, tellRefusal, claim, log } = options.answer!;
                const judged = takeConsent(input);
                if (judged.refusal !== undefined) {
                    const had = withdraw(contact);
                    log(`[${contact.qq}] 她拒绝了：${judged.refusal || '不想'}${had ? '（撤掉了他的请求）' : ''}`);
                    tellRefusal(contact, judged.refusal);
                    return judged.text;
                }
                if (judged.consent) {
                    const pending = claim(contact);
                    if (pending) {
                        log(`[${contact.qq}] 她答应了：${pending.label}`);
                        pending.run();
                    }
                    return judged.text;
                }
                return input;
            },
        } } : {}),
    };
}
