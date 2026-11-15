// 梗百科（DSH 2026-10-29）作为解释器的模块（ADR 0336 第 5 步）：她自己学的梗库太小；他最后一条话里提到一个词、词库里有，
// 就把「怎么用 / 出处 / 标签」给她，放进「此刻」块的 memeDict 槽。词库只读（language/meme-dict.ts），不写进她自己的梗库。
// - 让路规则和网络热梗一样（modules/playful.ts：男朋友档、不是主动找他 / 只想一想 / 危机 / 小别扭 / 他难过）。
// - 已经在热梗那一行里的词不再给：热梗模块（modules/memes.ts）在 contribute 时把那一行写进 turn.facts.meme，
//   所以这一模块要**注册在热梗模块之后**；迁移前这一行由排在最后的「旧逻辑」模块算，日志也在所有模块之后记，
//   为了日志的先后不变，App 里挂在整张表的最后。
// 查词是纯函数（词库启动时读进内存，mention 只按长度倒序找子串），挪到 contribute 时算和迁移前一样。
// 不存状态、不调模型。同步返回，不多等一个微任务（行为基线核对事件顺序）。

import type { Module } from '../interpreter/interpreter.ts';
import type { Log } from '../platform/log.ts';
import { playfulAllowed } from './playful.ts';

/** 词库里查到的一条（language/meme-dict.ts 的 DictEntry 里用得到的几样） */
export interface MemeDictHit { term: string; meaning: string; origin: string; tags: string }

/** dict：他这句里提到的最长的那个词（App 给 openMemeDict 读好的词库）；log 同联系人流水线的日志，前面加 [QQ] */
export function memeDictModule(dict: { mention(text: string): MemeDictHit | undefined }, log: Log): Module {
    return {
        id: 'meme-dict',
        contribute(turn) {
            if (!playfulAllowed(turn)) return [];
            const last = turn.history.findLast(message => message.role === 'user');
            if (!last) return [];
            const hit = dict.mention(last.content);
            if (!hit || turn.facts.meme?.includes(hit.term)) return [];
            log(`[${turn.contact.qq}] 梗百科：这一轮查到了他提的词（日志不记内容）`);
            return [{
                slot: 'memeDict',
                text: `[他这句里提到一个网络词「${hit.term}」：怎么用——${hit.meaning}${hit.origin ? `；出处——${hit.origin}` : ''}${hit.tags ? `；标签——${hit.tags}` : ''}。你大概知道这个梗：顺着他的意思接，别科普、别解释梗、别拆穿]`,
            }];
        },
    };
}
