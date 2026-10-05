// 一位联系人的回复流水线：召回长期记忆 → 按 ST 顺序拼提示词 → 后处理 → 生成 → 清理（含卡上的 ST 正则）→ 出口检查 → 拆条发送（responder.ts 调度）。
// 出口检查带上聊天记录里她最近几次回复和对方最近几条，查说话的毛病（ADR 0014，配置 speechCheck）。
// bot（main.ts）和模拟器（sim/）共用这一份；模拟器只换掉收发、时钟和数据目录（ADR 0005）。

import { dirname, join } from 'node:path';
import { UNLISTED_TIER, type AppConfig, type Contact, type Tier } from './config.ts';
import { reviewReply } from './exit-check.ts';
import type { ChatHistory, StoredMessage } from './history.ts';
import { chatCompletion } from './llm.ts';
import type { Log } from './log.ts';
import { initiateQuery, type LongTermMemory } from './memory/long-term.ts';
import { buildPrompt, type OpenAIMessage, type PromptResult } from './prompt.ts';
import { cleanUpReply } from './reply.ts';
import { createResponder, DEFAULT_SETTLE, RETRY_AFTER_MS, type Responder } from './responder.ts';
import { loadCharacterCard, type Character } from './st/card.ts';
import { postProcessPrompt } from './st/prompt-converters.ts';
import { loadWorldInfo, type WorldInfoEntry } from './st/world-info.ts';
import { isAckAfterClosing, moodySkip, typingMs, whenSeen } from './reply-timing.ts';
import { describeState, stateAt } from './schedule.ts';
import { speechContext } from './speech-check.ts';
import { describeDays, describeTime } from './time-context.ts';
import { estimateTokens } from './tokens.ts';

const DAY_MS = 86_400_000;

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

/**
 * 没回的这一串不回的原因（按作息时）：她已经收尾、对方只回了附和（ADR 0007 决策 7）；看心情不回（ADR 0013 决策 4）。要回就是 undefined。
 * 回复器和主动消息的计划器用同一个（看心情没回的那串不算「有没回的消息」）。chance 只给模拟器用
 */
export function replySkip(character: Character, moody: boolean, chance?: number): (history: StoredMessage[]) => string | undefined {
    return history => (isAckAfterClosing(history)
        ? '她已经收尾，对方只回了附和，不回'
        : moody ? moodySkip(history, character.pace, chance) : undefined);
}

export interface ContactPipelineOptions {
    contact: Contact;
    card: TierCard;
    llm: AppConfig['llm'];
    prompt: AppConfig['prompt'];
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
    /** 按卡上的作息（ADR 0007）：时间块里加一行她现在在干什么，按作息决定什么时候看到、打字多久，收尾后的附和不回。默认否；卡上没有作息时也不按 */
    schedule?: boolean;
    /** 看心情不回（ADR 0013 决策 4），要按作息；默认否 */
    moody?: boolean;
    /** 出口检查里查说话的毛病（ADR 0014）；默认否 */
    speechCheck?: boolean;
    /** 看心情不回的概率，不传按档位算；模拟器用 */
    moodyChance?: number;
    /** 看到消息之前的等待（可能几个小时），默认真实定时器；模拟器换成虚拟时钟上的 */
    waitUntil?: (at: number, signal: AbortSignal) => Promise<void>;
    /** 回复失败之后隔多久再试，默认 RETRY_AFTER_MS；模拟器传 []（它的时钟是虚拟的，真等几分钟会插进后面的步骤） */
    retryAfterMs?: readonly number[];
}

export function createContactResponder(options: ContactPipelineOptions): Responder {
    const { contact, card: { character, worldInfo }, llm, memory } = options;
    const names = { user: contact.name, char: character.name };
    const now = options.now ?? Date.now;
    const log: Log = message => options.log(`[${contact.qq}] ${message}`);
    const generate = options.generate ?? ((messages, log) => chatCompletion(llm, messages, { log }));
    const clean = (reply: string) => cleanUpReply(reply, names, character.regexScripts);
    const schedule = options.schedule ? character.schedule : undefined;
    return createResponder({
        userId: contact.qq,
        history: options.history,
        buildPrompt: async (chat, { woken, initiate }) => {
            const time = new Date(now());
            // 长期记忆只给名单里的人；主动找他时没有「他这次说的」：查想知道的事 + 最后两句，带前 3 天到后 2 天的时间窗（ADR 0012 决策 1 第 7 条）
            const remembers = memory && contact.tier !== UNLISTED_TIER;
            const recallOptions = initiate
                ? { query: initiateQuery(chat, initiate.topic), window: { start: new Date(time.getTime() - 3 * DAY_MS), end: new Date(time.getTime() + 2 * DAY_MS) } }
                : {};
            const recalled = remembers ? await memory.recall(contact, chat, time, recallOptions) : undefined;
            const relationship = remembers ? memory.relationship(contact) : undefined;
            if (recalled) log(`召回长期记忆 ${recalled.split('\n').length - 1} 条`);
            const days = describeDays(character.dates, time);
            const prompt = buildPrompt({
                character,
                worldInfo,
                history: chat,
                userName: contact.name,
                userPersona: contact.persona,
                afterMain: relationship ? [relationship] : [],
                afterHistory: [
                    ...(recalled ? [recalled] : []),
                    [
                        describeTime(chat, time, { initiating: Boolean(initiate) }),
                        ...(days ? [days] : []),
                        ...(schedule ? [describeState(stateAt(schedule, time), schedule, { userName: contact.name, woken })] : []),
                        ...(initiate ? [initiate.note] : []),
                    ].join('\n'),
                ],
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
            ...(options.speechCheck ? { speech: speechContext(options.history.load(contact.qq)) } : {}),
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
        retryAfterMs: options.retryAfterMs ?? RETRY_AFTER_MS,
        // 睡着时连着发能把她吵醒的只有男朋友档（决策 6）；冷场时多久看到、打字多久乘这一档的节奏系数（ADR 0013 决策 1）
        timing: schedule && {
            whenSeen: (history, at) => whenSeen(history, at, { schedule, wakeable: contact.tier === 'boyfriend', pace: character.pace }),
            typingMs: text => typingMs(text, character.pace),
            skip: replySkip(character, options.moody ?? false, options.moodyChance),
        },
        waitUntil: options.waitUntil,
        onPrompt: options.onPrompt,
    });
}
