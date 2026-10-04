import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { startApp, type App, type Transport } from '../src/app.ts';
import type { HistoryMessage } from '../src/backfill.ts';
import type { AppConfig } from '../src/config.ts';
import { ChatHistory } from '../src/history.ts';
import type { MessageEvent } from '../src/onebot.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const SELF = 20000;
const nowSec = () => Math.floor(Date.now() / 1000);

const dirs: string[] = [];
const apps: App[] = [];
afterEach(() => {
    for (const app of apps.splice(0)) app.stop();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<AppConfig> = {}): AppConfig {
    const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-app-'));
    dirs.push(dataDir);
    return {
        llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
        prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
        characterCard: join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'),
        contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }],
        unlistedFriends: false,
        schedule: false,
        dataDir,
        ...overrides,
    };
}

function event(userId: number, messageId: number, text: string, nickname?: string): MessageEvent {
    return {
        post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: SELF, user_id: userId, message_id: messageId,
        time: nowSec(), message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: userId, nickname },
    };
}

function historyMessage(messageId: number, from: number, text: string, secondsAgo: number): HistoryMessage {
    return { message_id: messageId, time: nowSec() - secondsAgo, sender: { user_id: from }, message: [{ type: 'text', data: { text } }] };
}

function setup(cfg: AppConfig, history: Record<number, HistoryMessage[]> = {}, options: { holdHistory?: Promise<void> } = {}) {
    const sent: string[] = [];
    const logs: string[] = [];
    const asked: number[] = [];
    let nextId = 900;
    const transport: Transport = {
        sendPrivateText: async (userId, text) => { sent.push(`${userId}:${text}`); return nextId++; },
        friendHistory: async (userId, count) => {
            asked.push(userId);
            await options.holdHistory;
            const list = history[userId];
            if (!list) throw new Error('OneBot 调用失败 retcode 1200：消息不存在');
            return list.slice(-count);
        },
    };
    const app = startApp({
        config: cfg, transport, log: message => logs.push(message),
        pipeline: { generate: async () => '好', settle: { quietMs: 0, maxMs: 0 } },
    });
    apps.push(app);
    return { app, sent, logs, asked };
}

/** 等到条件成立（回复器在后台跑），再多等一会儿看有没有多余的回复 */
async function until(check: () => boolean, ms = 3000): Promise<void> {
    const deadline = Date.now() + ms;
    while (!check()) {
        if (Date.now() > deadline) assert.fail('等不到');
        await new Promise(r => setTimeout(r, 10));
    }
    await new Promise(r => setTimeout(r, 50));
}

const chat = (cfg: AppConfig, qq: number) => new ChatHistory(cfg.dataDir).load(qq).map(m => `${m.role}:${m.content}`);

describe('编排（app.ts）', () => {
    test('连上时补回（小号自己发的算她说的），补的时候到的消息攒着、补完按顺序处理不重复，然后只回一次', async () => {
        const cfg = config();
        let release!: () => void;
        const hold = new Promise<void>(r => { release = r; });
        const { app, sent } = setup(cfg, {
            10001: [historyMessage(1, 10001, '在吗', 60), historyMessage(2, SELF, '在', 50), historyMessage(3, 10001, '吃了吗', 40)],
        }, { holdHistory: hold });
        const connected = app.connected(SELF);
        app.receive(event(10001, 3, '吃了吗'));
        app.receive(event(10001, 4, '人呢'));
        assert.deepEqual(chat(cfg, 10001), [], '补完之前不处理');
        release();
        await connected;
        await until(() => sent.length > 0);
        assert.deepEqual(sent, ['10001:好']);
        assert.deepEqual(chat(cfg, 10001), ['user:在吗', 'assistant:在', 'user:吃了吗', 'user:人呢', 'assistant:好']);
    });

    test('拉不到历史（没有任何记录时 NapCat 也报错）：写日志、跳过这个人，其他人照常补回', async () => {
        const cfg = config({ contacts: [{ qq: 10001, name: '阿明', tier: 'classmate' }, { qq: 10002, name: '宝宝', tier: 'boyfriend' }] });
        const { app, sent, logs } = setup(cfg, { 10002: [historyMessage(7, 10002, '睡了吗', 30)] });
        await app.connected(SELF);
        await until(() => sent.length > 0);
        assert.deepEqual(sent, ['10002:好']);
        assert.ok(logs.some(l => l.startsWith('[10001] 拉取历史消息失败，跳过补回：') && l.includes('消息不存在')));
    });

    test('名单外：开关关着时忽略；开着时按 unlisted 档、用 QQ 昵称回复', async () => {
        const off = setup(config());
        off.app.receive(event(99999, 1, '你好', '小周'));
        await new Promise(r => setTimeout(r, 50));
        assert.deepEqual(off.sent, []);
        assert.ok(off.logs.includes('忽略 QQ 99999 的私聊（不在名单）'));

        const cfg = config({ unlistedFriends: true });
        const on = setup(cfg);
        on.app.receive(event(99999, 1, '你好', ' 小周 '));
        await until(() => on.sent.length > 0);
        assert.deepEqual(on.sent, ['99999:好']);
        assert.ok(on.logs.includes('QQ 99999（小周）不在名单，按 unlisted 档回复'));
        assert.equal(JSON.parse(readFileSync(join(cfg.dataDir, 'tiers.json'), 'utf8'))['99999'].tier, 'unlisted');
    });

    test('stop：释放锁；之后收到的消息、再连上都不处理', async () => {
        const cfg = config();
        const { app, sent, asked } = setup(cfg, { 10001: [historyMessage(1, 10001, '在吗', 10)] });
        assert.ok(existsSync(join(cfg.dataDir, 'bot.lock')));
        app.stop();
        assert.equal(existsSync(join(cfg.dataDir, 'bot.lock')), false);
        app.receive(event(10001, 2, '人呢'));
        await app.connected(SELF);
        await new Promise(r => setTimeout(r, 50));
        assert.deepEqual(sent, []);
        assert.deepEqual(asked, []);
        assert.deepEqual(chat(cfg, 10001), []);
    });
});
