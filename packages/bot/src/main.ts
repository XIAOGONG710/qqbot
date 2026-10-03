// 入口：npm start -w @qqbot/bot
// 配置见 config.ts；M1 只回复白名单（contacts）里的人的直接私聊。

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, type Contact } from './config.ts';
import { ChatHistory } from './history.ts';
import { chatCompletion } from './llm.ts';
import { isPrivateFriendMessage, OneBotClient, segmentsToText, type OneBotEvent } from './onebot.ts';
import { assertSupportedCharacter, buildPrompt, type PromptResult } from './prompt.ts';
import { cleanUpReply } from './reply.ts';
import { createResponder } from './responder.ts';
import { loadCharacterCard } from './st/card.ts';
import { postProcessPrompt } from './st/prompt-converters.ts';
import { loadWorldInfo } from './st/world-info.ts';
import { estimateTokens } from './tokens.ts';

const log = (message: string) => console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`);

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const config = loadConfig(repoRoot);

const character = loadCharacterCard(config.characterCard);
assertSupportedCharacter(character);
const worldInfo = character.world
    ? loadWorldInfo(join(dirname(config.characterCard), `${character.world}.json`), character.world)
    : [];
const whitelist = config.contacts.map(c => `${c.qq}（${c.name}）`).join('、');
log(`角色 ${character.name}，世界书 ${character.world || '无'}（${worldInfo.length} 条），只回复这些 QQ 的私聊：${whitelist}`);

const history = new ChatHistory(config.dataDir);

const client = new OneBotClient({ url: config.onebot.url, token: config.onebot.token, onEvent, log });

// 每个联系人一个回复器：聊天记录、生成和重新生成都互不影响
const responders = new Map(config.contacts.map(contact => [contact.qq, createContactResponder(contact)]));

function createContactResponder(contact: Contact) {
    const names = { user: contact.name, char: character.name };
    return createResponder({
        userId: contact.qq,
        history,
        // last-prompt.json 记录的是后处理之后、实际发给模型的消息
        buildPrompt: chat => withPostProcessing(buildPrompt({
            character,
            worldInfo,
            history: chat,
            userName: contact.name,
            settings: { maxContext: config.prompt.maxContext, maxTokens: config.llm.maxTokens, worldInfo: config.prompt.worldInfo },
            countTokens: estimateTokens,
        })),
        generate: messages => chatCompletion(config.llm, messages),
        clean: reply => cleanUpReply(reply, names),
        send: (userId, text) => client.sendPrivateText(userId, text),
        log: message => log(`[${contact.qq}] ${message}`),
        onPrompt: prompt => writeFileSync(
            join(config.dataDir, 'last-prompt.json'),
            JSON.stringify({ qq: contact.qq, ...prompt }, null, 2),
        ),
    });
}

function withPostProcessing(prompt: PromptResult): PromptResult {
    return { ...prompt, messages: postProcessPrompt(prompt.messages, config.llm.promptPostProcessing) };
}

function onEvent(event: OneBotEvent): void {
    if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle') {
        log(`NapCat 账号 ${String(event.self_id)} 已就绪`);
        return;
    }
    if (!isPrivateFriendMessage(event)) return;
    const responder = responders.get(event.user_id);
    if (!responder) {
        log(`忽略 QQ ${event.user_id} 的私聊（不在白名单）`);
        return;
    }
    const text = segmentsToText(event.message).trim();
    if (!text) return;
    responder.receive(text, event.message_id, new Date(event.time * 1000));
}

process.on('SIGINT', () => {
    client.stop();
    process.exit(0);
});

client.start();
