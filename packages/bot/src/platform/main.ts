// 独立入口：npm start -w @qqbot/bot（Koishi 路线验收之前保持可用，ADR 0008）
// 配置见 config.ts。回复名单（contacts）里的人的直接私聊，每人按自己的档位用对应的角色卡和世界书（ADR 0003）；
// 名单外的好友私聊用 unlisted 档（配置 unlistedFriends 可关）。群聊、群临时会话不回复。编排在 app.ts，这里只管连 NapCat。

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createLog } from './log.ts';
import type { HistoryMessage } from '.././memory/backfill.ts';
import { ocrLines } from '.././vision/media.ts';
import { assertKernelOk, isFriendRecall, isGroupMessage, isPokeAtMe, isPrivateFriendMessage, OneBotClient, type OneBotEvent } from './onebot.ts';
import { configuredImageDescriber, STICKER_VISION_PROMPT } from '.././vision/vision.ts';
import { stickerDecider, stickerShelf } from '.././social/stickers.ts';
import { qqFavorites } from '.././social/sticker-favorites.ts';
import { bqbDiscover } from '.././social/sticker-sources.ts';

// 这个文件在 packages/bot/src/platform/：往上四层才是仓库根
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const config = loadConfig(repoRoot);
const log = createLog(join(config.dataDir, 'logs'));

const client = new OneBotClient({ url: config.onebot.url, token: config.onebot.token, onEvent, log });
const vision = configuredImageDescriber(config);
const stickerVision = configuredImageDescriber(config, STICKER_VISION_PROMPT);
// 读他刚发来的表情包（ADR 0206）：同一个要求，但在聊天路上，不排在后台收藏后面
const stickerReader = config.readStickers ? configuredImageDescriber(config, STICKER_VISION_PROMPT, 'chat') : undefined;
const qqFav = qqFavorites((action, params) => client.call<unknown>(action, params));
const stickers = (config.stickers ?? 'off') !== 'off' && stickerVision ? stickerShelf({
    dir: join(config.dataDir, 'stickers'),
    describe: image => stickerVision.describe(image),
    decide: stickerDecider(config.llm, log),
    trendDiscover: bqbDiscover({ dir: join(config.dataDir, 'stickers', 'sources'), log }),
    discover: qqFav.discover,
    favorites: qqFav.favorites,
    log,
}) : undefined;
const app = startApp({
    config,
    transport: {
        sendPrivateText: (userId, text, replyTo) => client.sendPrivateText(userId, text, replyTo),
        sendGroupText: (groupId, text, replyTo) => client.sendGroupText(groupId, text, replyTo),
        sendPrivateImage: (userId, file, summary) => client.sendPrivateImage(userId, file, summary),
        setInputStatus: (userId, eventType) => client.setInputStatus(userId, eventType),
        deleteMessage: async messageId => { await client.call('delete_msg', { message_id: messageId }); },
        pokeFriend: async userId => { await client.call('friend_poke', { user_id: String(userId) }); },
        markRead: async userId => { await client.call('mark_private_msg_as_read', { user_id: String(userId) }); },
        reactMessage: async (messageId, emojiId) => { assertKernelOk('set_msg_emoji_like', await client.call('set_msg_emoji_like', { message_id: messageId, emoji_id: String(emojiId), set: true })); },
        setOnlineStatus: async (status, ext) => { await client.call('set_online_status', { status, ext_status: ext, battery_status: 0 }); },
        sendLike: async (userId, times) => { await client.call('send_like', { user_id: String(userId), times }); },
        setSignature: async text => { await client.call('set_self_longnick', { longNick: text }); },
        postQzone: async post => (await client.call<{ tid: string }>('send_qzone_msg', { content: post.content, ...(post.images ? { images: post.images } : {}), ugc_right: post.ugcRight })).tid,
        friendHistory: async (userId, count) => (await client.call<{ messages: HistoryMessage[] }>('get_friend_msg_history', {
            user_id: String(userId),
            count,
        })).messages,
    },
    log,
    // 听语音、看图上的字（ADR 0052）：QQ 自带的语音转文字、NapCat 的 OCR（只有 Windows）
    media: {
        voiceToText: async (messageId, signal) => (await client.call<{ text: string }>('fetch_ptt_text', { message_id: messageId }, signal)).text,
        ocr: async (image, signal) => ocrLines(await client.call<unknown>('ocr_image', { image }, signal)),
    },
    vision,
    ...(stickerReader ? { stickerReader } : {}),
    ...(stickers ? { stickers } : {}),
});
process.on('exit', () => app.stop());

function onEvent(event: OneBotEvent): void {
    // 每次连上 NapCat 先补回漏掉的消息
    if (event.post_type === 'meta_event' && event.meta_event_type === 'lifecycle') {
        log(`NapCat 账号 ${String(event.self_id)} 已就绪`);
        void app.connected(Number(event.self_id));
        return;
    }
    if (isPrivateFriendMessage(event)) app.receive(event);
    // 群消息（ADR 0210）：app 里只认配置 groups 名单里的群，别的群什么都不做
    else if (isGroupMessage(event)) app.receiveGroup(event);
    else if (isPokeAtMe(event)) app.receivePoke(event);
    else if (isFriendRecall(event)) app.receiveRecall(event);
}

// Ctrl+C 是 SIGINT；Windows 上直接关掉终端窗口是 SIGHUP
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
        client.stop();
        process.exit(0);
    });
}

client.start();
