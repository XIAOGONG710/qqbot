// 入口：npm start -w @qqbot/bot
// 配置见 config.ts。回复名单（contacts）里的人的直接私聊，每人按自己的档位用对应的角色卡和世界书（ADR 0003）；
// 名单外的好友私聊用 unlisted 档（配置 unlistedFriends 可关）。群聊、群临时会话不回复。

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, UNLISTED_TIER, type Contact, type Tier } from './config.ts';
import { acquireLock } from './lock.ts';
import { ChatHistory } from './history.ts';
import { chatCompletion } from './llm.ts';
import { BACKFILL_COUNT, CATCH_UP_WINDOW_MS, findMissed, shouldCatchUp, type HistoryMessage } from './backfill.ts';
import { isPrivateFriendMessage, OneBotClient, segmentsToText, senderName, type MessageEvent, type OneBotEvent } from './onebot.ts';
import { buildPrompt, type PromptResult } from './prompt.ts';
import { cleanUpReply } from './reply.ts';
import { createResponder, type Responder } from './responder.ts';
import { loadCharacterCard, type Character } from './st/card.ts';
import type { MacroNames } from './st/macros.ts';
import { postProcessPrompt } from './st/prompt-converters.ts';
import { loadWorldInfo, type WorldInfoEntry } from './st/world-info.ts';
import { TierRecord } from './tier-record.ts';
import { describeTime } from './time-context.ts';
import { estimateTokens } from './tokens.ts';

const log = (message: string) => console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const config = loadConfig(repoRoot);

// 每个档位一张角色卡和一本世界书，用到时读一次
const cards = new Map<Tier, { character: Character; worldInfo: WorldInfoEntry[] }>();
function cardFor(tier: Tier) {
    let card = cards.get(tier);
    if (!card) {
        const path = config.characterCard.replaceAll('{tier}', tier);
        const character = loadCharacterCard(path);
        const worldInfo = character.world ? loadWorldInfo(join(dirname(path), `${character.world}.json`), character.world) : [];
        card = { character, worldInfo };
        cards.set(tier, card);
    }
    return card;
}
// 启动时先把要用到的都读一遍，缺文件立刻报错
const tiersInUse = new Set<Tier>(config.contacts.map(c => c.tier));
if (config.unlistedFriends) tiersInUse.add(UNLISTED_TIER);
for (const tier of tiersInUse) {
    const { character, worldInfo } = cardFor(tier);
    log(`档位 ${tier}：角色 ${character.name}，世界书 ${character.world || '无'}（${worldInfo.length} 条）`);
}
const whitelist = config.contacts.map(c => `${c.qq}（${c.name}，${c.tier}）`).join('、');
log(`名单：${whitelist}；名单外的好友${config.unlistedFriends ? '按 unlisted 档回复' : '不回复'}`);

const history = new ChatHistory(config.dataDir);
// 放在 ChatHistory 之后：它会建好数据目录
const releaseLock = acquireLock(join(config.dataDir, 'bot.lock'));
process.on('exit', releaseLock);

const tierRecord = new TierRecord(join(config.dataDir, 'tiers.json'));
for (const contact of config.contacts) {
    const warning = tierRecord.update(contact.qq, contact.tier);
    if (warning) log(warning);
}

const client = new OneBotClient({ url: config.onebot.url, token: config.onebot.token, onEvent, log });

// 每个联系人一个回复器：聊天记录、生成和重新生成都互不影响
const responders = new Map<number, Responder>(config.contacts.map(contact => [contact.qq, createContactResponder(contact)]));

function createContactResponder(contact: Contact) {
    const { character, worldInfo } = cardFor(contact.tier);
    const names = { user: contact.name, char: character.name };
    const contactLog = (message: string) => log(`[${contact.qq}] ${message}`);
    return createResponder({
        userId: contact.qq,
        history,
        // last-prompt.json 记录的是后处理之后、实际发给模型的消息
        buildPrompt: chat => {
            const now = new Date();
            return withPostProcessing(buildPrompt({
                character,
                worldInfo,
                history: chat,
                userName: contact.name,
                userPersona: contact.persona,
                afterHistory: [describeTime(chat, now)],
                now,
                settings: {
                    maxContext: config.prompt.maxContext,
                    maxTokens: config.llm.maxTokens,
                    worldInfo: config.prompt.worldInfo,
                    pinExamples: config.prompt.pinExamples,
                },
                countTokens: estimateTokens,
            }), names);
        },
        generate: messages => chatCompletion(config.llm, messages, { log: contactLog }),
        clean: reply => cleanUpReply(reply, names),
        send: (userId, text) => client.sendPrivateText(userId, text),
        log: contactLog,
        onPrompt: prompt => writeFileSync(
            join(config.dataDir, 'last-prompt.json'),
            JSON.stringify({ qq: contact.qq, ...prompt }, null, 2),
        ),
    });
}

function withPostProcessing(prompt: PromptResult, names: MacroNames): PromptResult {
    return { ...prompt, messages: postProcessPrompt(prompt.messages, config.llm.promptPostProcessing, names) };
}

// 每次连上 NapCat 先补回漏掉的消息；补完之前到的新消息先攒着，补完再按顺序处理
let syncing = false;
const buffered: MessageEvent[] = [];

function onEvent(event: OneBotEvent): void {
    if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle') {
        log(`NapCat 账号 ${String(event.self_id)} 已就绪`);
        syncing = true;
        void syncMissed(Number(event.self_id)).finally(() => {
            syncing = false;
            for (const message of buffered.splice(0)) onMessage(message);
            catchUpAll();
        });
        return;
    }
    if (!isPrivateFriendMessage(event)) return;
    if (syncing) buffered.push(event);
    else onMessage(event);
}

function onMessage(event: MessageEvent): void {
    let responder = responders.get(event.user_id);
    if (!responder) {
        if (!config.unlistedFriends) {
            log(`忽略 QQ ${event.user_id} 的私聊（不在名单）`);
            return;
        }
        // 名单外的好友：{{user}} 用对方的 QQ 昵称
        const contact: Contact = { qq: event.user_id, name: senderName(event), tier: UNLISTED_TIER };
        const warning = tierRecord.update(contact.qq, contact.tier);
        if (warning) log(warning);
        log(`QQ ${contact.qq}（${contact.name}）不在名单，按 ${UNLISTED_TIER} 档回复`);
        responder = createContactResponder(contact);
        responders.set(contact.qq, responder);
    }
    // 补回时可能已经从历史里拿到过这条
    if (history.load(event.user_id).some(m => m.messageId === event.message_id)) return;
    const text = segmentsToText(event.message).trim();
    if (!text) return;
    responder.receive(text, event.message_id, new Date(event.time * 1000));
}

async function syncMissed(selfId: number): Promise<void> {
    for (const contact of config.contacts) {
        let fetched: HistoryMessage[] = [];
        try {
            const data = await client.call<{ messages: HistoryMessage[] }>('get_friend_msg_history', {
                user_id: String(contact.qq),
                count: BACKFILL_COUNT,
            });
            fetched = data.messages;
        } catch (error) {
            // 没有任何聊天记录时 NapCat 也报错（“消息…不存在”）
            log(`[${contact.qq}] 拉取历史消息失败，跳过补回：${error instanceof Error ? error.message : String(error)}`);
            continue;
        }
        const missed = findMissed(history.load(contact.qq), fetched, selfId);
        for (const message of missed) history.append(contact.qq, message);
        if (missed.length) {
            const lines = missed.map(m => `${m.role === 'user' ? '对方' : '她'}：${m.content}`).join(' / ');
            log(`[${contact.qq}] 补回 ${missed.length} 条漏掉的消息：${lines}`);
        }
    }
}

function catchUpAll(): void {
    const now = new Date();
    for (const contact of config.contacts) {
        const stored = history.load(contact.qq);
        if (shouldCatchUp(stored, now)) {
            log(`[${contact.qq}] 有没回的消息，回复`);
            responders.get(contact.qq)!.catchUp();
        } else if (stored.at(-1)?.role === 'user') {
            log(`[${contact.qq}] 没回的消息已超过 ${CATCH_UP_WINDOW_MS / 3_600_000} 小时，只补记录，等对方下一条消息时一起回`);
        }
    }
}

// Ctrl+C 是 SIGINT；Windows 上直接关掉终端窗口是 SIGHUP
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
        client.stop();
        process.exit(0);
    });
}

client.start();
