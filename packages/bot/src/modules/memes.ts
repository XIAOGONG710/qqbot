// 网络热梗（ADR 0129）作为解释器的模块（ADR 0336 第 5 步），这次只迁「放进提示词」的那一半：
// - 一轮回复时，让路规则同小梗（modules/playful.ts：男朋友档、不是主动找他 / 只想一想 / 危机 / 小别扭 / 他难过），
//   按 memeLine 的规则往「此刻」块的 meme 槽放一行（他用了库里的梗就说意思；没用，约两成的轮次给几个最近刷到的）。
// - 梗库每一轮现读（作者可以在两轮之间用 meme-cli 改 / 删），App 停下之后不再读。
// 从热榜学新梗的那一半（要她的 B 站号、和刷 B 站共用被动读取的生命周期）还在 app.ts，B 站迁成模块时一起收。
// 放了的那一行也写进 turn.facts.meme：旧逻辑的梗百科（他提到的词查词库）读它，已经在这一行里的词不再给。
// 挑梗的规则都在 language/memes.ts，这里只是接线；行为和迁移前 contact.ts 里的逐字一样（行为基线 memes 场景核对）。

import type { Module } from '../interpreter/interpreter.ts';
import { memeLine, type MemeEntry } from '../language/memes.ts';
import type { Contact } from '../platform/config.ts';
import type { Log } from '../platform/log.ts';
import { playfulAllowed } from './playful.ts';

/** memesOf：这个人这一轮能用的梗（App 从库里现读，模拟器给场景里写好的）；log 同联系人流水线的日志，前面加 [QQ] */
export function memesModule(memesOf: (contact: Contact) => readonly MemeEntry[], log: Log): Module {
    return {
        id: 'memes',
        contribute(turn) {
            if (!playfulAllowed(turn)) return [];
            const line = memeLine(memesOf(turn.contact), turn.history, turn.at.getTime());
            if (!line) return [];
            // 梗百科那一行（旧逻辑，DSH 2026-10-29）要知道这一轮放了哪些梗，免得同一个词说两遍
            turn.facts.meme = line;
            log(`[${turn.contact.qq}] 网络热梗：这一轮提示词里放了梗的意思（日志不记内容）`);
            return [{ slot: 'meme', text: line }];
        },
    };
}
