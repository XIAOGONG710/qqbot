// 独立入口：npm start -w @qqbot/bot（Koishi 路线验收之前保持可用，ADR 0008）
// 配置见 config.ts。回复名单（contacts）里的人的直接私聊，每人按自己的档位用对应的角色卡和世界书（ADR 0003）；
// 名单外的好友私聊用 unlisted 档（配置 unlistedFriends 可关）。群聊、群临时会话不回复。编排在 app.ts，这里只管连 NapCat。

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createLog } from './log.ts';
import type { HistoryMessage } from './backfill.ts';
import { isPrivateFriendMessage, OneBotClient, type OneBotEvent } from './onebot.ts';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const config = loadConfig(repoRoot);
const log = createLog(join(config.dataDir, 'logs'));

const client = new OneBotClient({ url: config.onebot.url, token: config.onebot.token, onEvent, log });
const app = startApp({
    config,
    transport: {
        sendPrivateText: (userId, text) => client.sendPrivateText(userId, text),
        friendHistory: async (userId, count) => (await client.call<{ messages: HistoryMessage[] }>('get_friend_msg_history', {
            user_id: String(userId),
            count,
        })).messages,
    },
    log,
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
}

// Ctrl+C 是 SIGINT；Windows 上直接关掉终端窗口是 SIGHUP
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => {
        client.stop();
        process.exit(0);
    });
}

client.start();
