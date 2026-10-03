// 入口：npm start -w @qqbot/bot
// 配置见 config.ts；M1 只回复配置里那一个人的私聊。

import { writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.ts';
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
log(`角色 ${character.name}，世界书 ${character.world || '无'}（${worldInfo.length} 条），只回复 QQ ${config.contact.qq} 的私聊`);

const history = new ChatHistory(config.dataDir);
const names = { user: config.contact.name, char: character.name };

const client = new OneBotClient({ url: config.onebot.url, token: config.onebot.token, onEvent, log });

const responder = createResponder({
    userId: config.contact.qq,
    history,
    // last-prompt.json 记录的是后处理之后、实际发给模型的消息
    buildPrompt: chat => withPostProcessing(buildPrompt({
        character,
        worldInfo,
        history: chat,
        userName: config.contact.name,
        settings: { maxContext: config.prompt.maxContext, maxTokens: config.llm.maxTokens, worldInfo: config.prompt.worldInfo },
        countTokens: estimateTokens,
    })),
    generate: messages => chatCompletion(config.llm, messages),
    clean: reply => cleanUpReply(reply, names),
    send: (userId, text) => client.sendPrivateText(userId, text),
    log,
    onPrompt: prompt => writeFileSync(join(config.dataDir, 'last-prompt.json'), JSON.stringify(prompt, null, 2)),
});

function withPostProcessing(prompt: PromptResult): PromptResult {
    return { ...prompt, messages: postProcessPrompt(prompt.messages, config.llm.promptPostProcessing) };
}

function onEvent(event: OneBotEvent): void {
    if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle') {
        log(`NapCat 账号 ${String(event.self_id)} 已就绪`);
        return;
    }
    if (!isPrivateFriendMessage(event)) return;
    if (event.user_id !== config.contact.qq) {
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
