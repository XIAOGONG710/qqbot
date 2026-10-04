// 一位联系人的回复流水线：召回长期记忆 → 按 ST 顺序拼提示词 → 后处理 → 生成 → 清理（含卡上的 ST 正则）→ 出口检查 → 拆条发送（responder.ts 调度）。
// bot（main.ts）和模拟器（sim/）共用这一份；模拟器只换掉收发、时钟和数据目录（ADR 0005）。

import { dirname, join } from 'node:path';
import { UNLISTED_TIER, type BotConfig, type Contact, type Tier } from './config.ts';
import { reviewReply } from './exit-check.ts';
import type { ChatHistory } from './history.ts';
import { chatCompletion } from './llm.ts';
import type { Log } from './log.ts';
import type { LongTermMemory } from './memory/long-term.ts';
import { buildPrompt, type OpenAIMessage, type PromptResult } from './prompt.ts';
import { cleanUpReply } from './reply.ts';
import { createResponder, DEFAULT_SETTLE, type Responder } from './responder.ts';
import { loadCharacterCard, type Character } from './st/card.ts';
import { postProcessPrompt } from './st/prompt-converters.ts';
import { loadWorldInfo, type WorldInfoEntry } from './st/world-info.ts';
import { describeTime } from './time-context.ts';
import { estimateTokens } from './tokens.ts';

export interface TierCard {
    character: Character;
    worldInfo: WorldInfoEntry[];
}

/** 读一个档位的角色卡和它链接的世界书；pattern 是配置里的 characterCard（{tier} 换成档位名），世界书在同目录的 <world>.json */
export function loadTierCard(pattern: string, tier: Tier): TierCard {
    const path = pattern.replaceAll('{tier}', tier);
    const character = loadCharacterCard(path);
    const worldInfo = character.world ? loadWorldInfo(join(dirname(path), `${character.world}.json`), character.world) : [];
    return { character, worldInfo };
}

export interface ContactPipelineOptions {
    contact: Contact;
    card: TierCard;
    llm: BotConfig['llm'];
    prompt: BotConfig['prompt'];
    history: Pick<ChatHistory, 'load' | 'append'>;
    /** 长期记忆；名单外的好友（unlisted 档）不用 */
    memory?: LongTermMemory;
    send: (userId: number, text: string) => Promise<number>;
    /** 不带联系人前缀，这里会加上 [QQ 号] */
    log: Log;
    /** 每次生成前拿到后处理之后、实际发给模型的提示词 */
    onPrompt?: (prompt: PromptResult) => void;
    /** 毫秒时间戳，默认真实时间；模拟器传虚拟时钟 */
    now?: () => number;
    /** 默认调模型接口（llm.ts）；模拟器包一层，在生成中插入对方的消息 */
    generate?: (messages: OpenAIMessage[], log: Log) => Promise<string>;
    /** 连发合并的等待，默认 DEFAULT_SETTLE（测试用短的） */
    settle?: { quietMs: number; maxMs: number };
}

export function createContactResponder(options: ContactPipelineOptions): Responder {
    const { contact, card: { character, worldInfo }, llm, memory } = options;
    const names = { user: contact.name, char: character.name };
    const now = options.now ?? Date.now;
    const log: Log = message => options.log(`[${contact.qq}] ${message}`);
    const generate = options.generate ?? ((messages, log) => chatCompletion(llm, messages, { log }));
    const clean = (reply: string) => cleanUpReply(reply, names, character.regexScripts);
    return createResponder({
        userId: contact.qq,
        history: options.history,
        buildPrompt: async chat => {
            const time = new Date(now());
            // 长期记忆只给名单里的人
            const remembers = memory && contact.tier !== UNLISTED_TIER;
            const recalled = remembers ? await memory.recall(contact, chat, time) : undefined;
            const relationship = remembers ? memory.relationship(contact) : undefined;
            if (recalled) log(`召回长期记忆 ${recalled.split('\n').length - 1} 条`);
            const prompt = buildPrompt({
                character,
                worldInfo,
                history: chat,
                userName: contact.name,
                userPersona: contact.persona,
                afterMain: relationship ? [relationship] : [],
                afterHistory: [...(recalled ? [recalled] : []), describeTime(chat, time)],
                now: time,
                settings: {
                    maxContext: options.prompt.maxContext,
                    maxTokens: llm.maxTokens,
                    worldInfo: options.prompt.worldInfo,
                    pinExamples: options.prompt.pinExamples,
                },
                countTokens: estimateTokens,
            });
            return { ...prompt, messages: postProcessPrompt(prompt.messages, llm.promptPostProcessing, names) };
        },
        generate: messages => generate(messages, log),
        clean,
        // 出口检查：重写时在后处理过的提示词末尾加一条说明，再按同样的方式后处理一次
        review: (reply, messages) => reviewReply(reply, {
            banned: character.banned,
            userName: contact.name,
            regenerate: async note => clean(await generate(
                postProcessPrompt([...messages, { role: 'system', content: note }], llm.promptPostProcessing, names),
                log,
            )),
            log,
        }),
        send: options.send,
        log,
        now,
        settle: options.settle ?? DEFAULT_SETTLE,
        onPrompt: options.onPrompt,
    });
}
