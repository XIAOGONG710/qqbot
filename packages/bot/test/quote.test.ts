import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { startApp } from '../src/platform/app.ts';
import { toStored } from '../src/memory/backfill.ts';
import type { AppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { QUOTE_UNKNOWN, quotedIds, segmentsToText, type MessageEvent, type QuoteLookup } from '../src/platform/onebot.ts';
import type { HistoryMessage } from '../src/memory/backfill.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

const reply = (id: string | number) => ({ type: 'reply', data: { id } });
const text = (value: string) => ({ type: 'text', data: { text: value } });
const book: Record<number, { role: 'user' | 'assistant'; content: string }> = {
    701: { role: 'assistant', content: '我周三有早八，烦死了' },
    702: { role: 'user', content: '哈哈惨' },
    703: { role: 'user', content: '[引用你说的：「我周三有早八，烦死了」]为什么啊' },
    704: { role: 'assistant', content: '第一行\n第二行 ' + '很长'.repeat(40) },
};
const lookup: QuoteLookup = id => book[id];

describe('引用回复：被引用的那句话写进聊天记录（ADR 0081）', () => {
    test('引用她的话、引用他自己的话；后面的文字接着拼', () => {
        assert.equal(segmentsToText([reply('701'), text('为什么啊')], lookup), '[引用你说的：「我周三有早八，烦死了」]为什么啊');
        assert.equal(segmentsToText([reply(702), text('嗯')], lookup), '[引用他之前说的：「哈哈惨」]嗯');
    });

    test('给了查找却找不到（id 不在、不是数字）：写一句「引用了一条之前的消息」，不再什么都不写（11-02 线上）；没给查找照旧不写', () => {
        assert.equal(segmentsToText([reply('999'), text('为什么啊')], lookup), `${QUOTE_UNKNOWN}为什么啊`);
        assert.equal(segmentsToText([reply('abc'), text('为什么啊')], lookup), `${QUOTE_UNKNOWN}为什么啊`);
        assert.equal(segmentsToText([reply('701'), text('为什么啊')]), '为什么啊');
        assert.ok(!QUOTE_UNKNOWN.includes('看不'), '不写「看不到」：真人在 QQ 上总看得见被引用的那句');
        assert.deepEqual(quotedIds([reply('701'), text('x'), reply(702), reply('abc')]), [701, 702]);
        assert.deepEqual(quotedIds('纯文字'), []);
    });

    test('被引用的那条自己开头的引用不再套进来；换行压成空格，太长截短', () => {
        assert.equal(segmentsToText([reply(703), text('对')], lookup), '[引用他之前说的：「为什么啊」]对');
        const long = segmentsToText([reply(704), text('嗯')], lookup);
        assert.match(long, /^\[引用你说的：「第一行 第二行 很长/);
        assert.match(long, /…」\]嗯$/);
        assert.ok(long.length < 70, long);
    });

    test('补回（停机期间收到的）也一样', () => {
        const stored = toStored([{ message_id: 1, time: 1_800_000_000, sender: { user_id: 5 }, message: [reply('701'), text('为什么啊')] }], 20000, lookup);
        assert.deepEqual(stored.map(m => [m.role, m.content]), [['user', '[引用你说的：「我周三有早八，烦死了」]为什么啊']]);
    });
});

describe('引用回复进应用（ADR 0081）', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

    test('他引用她存在记录里的一句话：她看到的、记下来的都带着那句话', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-quote-'));
        dirs.push(dataDir);
        mkdirSync(dataDir, { recursive: true });
        new ChatHistory(dataDir).append(10001, { time: new Date(Date.now() - 6 * 3_600_000).toISOString(), role: 'assistant', content: '我周三有早八，烦死了', messageId: 701 });
        const cfg: AppConfig = {
            llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
            prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
            characterCard: syntheticCardPattern,
            contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }],
            unlistedFriends: false, schedule: false, moody: false, speechCheck: false, herDays: false, autonomousLife: false, projectChoice: false,
            lifeInPrompt: false, grievance: false, feedbackCommands: false, realWeather: false, media: true,
            candidates: 1, contextTurns: 0, contextContacts: [], proactive: 'off', dataDir,
        } as unknown as AppConfig; // 其余字段（后加的开关）都是未设 = 关
        const seen: string[] = [];
        const sent: string[] = [];
        const app = startApp({
            config: cfg, log: () => {},
            transport: { sendPrivateText: async (userId, value) => { sent.push(`${userId}:${value}`); return 900; }, friendHistory: async () => [] },
            pipeline: { generate: async messages => { seen.push(messages.map(m => m.content).join('\n')); return '早八要七点起'; }, settle: { quietMs: 0, maxMs: 0 } },
        });
        const event: MessageEvent = {
            post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 801,
            time: Math.floor(Date.now() / 1000), message: [reply('701'), text('为什么啊')], raw_message: '', sender: { user_id: 10001 },
        };
        app.receive(event);
        const deadline = Date.now() + 3000;
        while (sent.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
        app.stop();
        assert.equal(sent.length, 1);
        assert.match(seen.at(-1)!, /\[引用你说的：「我周三有早八，烦死了」\]为什么啊/);
        assert.ok(new ChatHistory(dataDir).load(10001).some(m => m.role === 'user' && m.content === '[引用你说的：「我周三有早八，烦死了」]为什么啊'));
    });

    // 11-02 线上：他引用她那句自我介绍问「你这是说谁呢」，引用在记录里没对上，她只看到这一句，答成「说你呢，姓林的」
    function quoteApp(getMsg: (params: Record<string, unknown>) => Promise<unknown>, history: HistoryMessage[] = []) {
        const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-quote-'));
        dirs.push(dataDir);
        const cfg: AppConfig = {
            llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
            prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
            characterCard: syntheticCardPattern,
            contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }],
            unlistedFriends: false, schedule: false, moody: false, speechCheck: false, herDays: false, autonomousLife: false, projectChoice: false,
            lifeInPrompt: false, grievance: false, feedbackCommands: false, realWeather: false, media: true,
            candidates: 1, contextTurns: 0, contextContacts: [], proactive: 'off', dataDir,
        } as unknown as AppConfig;
        const seen: string[] = [];
        const sent: string[] = [];
        const logs: string[] = [];
        const asked: unknown[] = [];
        const app = startApp({
            config: cfg, log: m => logs.push(m),
            transport: {
                sendPrivateText: async (userId, value) => { sent.push(`${userId}:${value}`); return 900 + sent.length; },
                friendHistory: async () => history,
                callAction: async (action, params) => { asked.push([action, params]); if (action !== 'get_msg') throw new Error('没有'); return getMsg(params); },
            },
            pipeline: { generate: async messages => { seen.push(messages.map(m => m.content).join('\n')); return '说我自己呢'; }, settle: { quietMs: 0, maxMs: 0 } },
        });
        return { app, seen, sent, logs, asked, dataDir };
    }
    const until = async (done: () => boolean) => { const deadline = Date.now() + 3000; while (!done() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10)); };
    const asks = (id: number): MessageEvent => ({
        post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 802,
        time: Math.floor(Date.now() / 1000), message: [reply(id), text('你这是说谁呢～')], raw_message: '', sender: { user_id: 10001 },
    });

    test('引用的那一条记录里没有：问 NapCat（get_msg），发的人是她自己就写成「引用你说的」', async () => {
        const { app, seen, sent, logs, asked } = quoteApp(async () => ({ message_id: 901, sender: { user_id: 20000 }, message: [text('认得我，姓林的那个女的，在一块儿一年多也还不腻')] }));
        await app.connected(20000);
        app.receive(asks(901));
        await until(() => sent.length > 0);
        app.stop();
        assert.deepEqual(asked, [['get_msg', { message_id: 901 }]]);
        assert.match(seen.at(-1)!, /\[引用你说的：「认得我，姓林的那个女的，在一块儿一年多也还不腻」\]你这是说谁呢～/);
        assert.ok(logs.some(l => l.includes('问 NapCat 补上了（她说的）')), logs.join('\n'));
    });

    test('问 NapCat 也没拿到 / 认不出是谁发的：写「引用了一条之前的消息」，不猜', async () => {
        for (const getMsg of [async () => { throw new Error('消息不存在'); }, async () => ({ sender: { user_id: 55555 }, message: [text('别人说的')] })]) {
            const { app, seen, sent } = quoteApp(getMsg);
            await app.connected(20000);
            app.receive(asks(902));
            await until(() => sent.length > 0);
            app.stop();
            assert.ok(seen.at(-1)!.includes(`${QUOTE_UNKNOWN}你这是说谁呢～`), seen.at(-1));
        }
    });

    test('补回的消息（停机期间他引用了她一句）：也先问 NapCat 再记进聊天记录', async () => {
        const missed: HistoryMessage[] = [{ message_id: 803, time: Math.floor(Date.now() / 1000) - 60, sender: { user_id: 10001 }, message: [reply(903), text('你这是说谁呢～')] }];
        const { app, logs, dataDir } = quoteApp(async () => ({ sender: { user_id: 20000 }, message: [text('真实感觉啊……就是对你这脾气已经摸清了')] }), missed);
        await app.connected(20000);
        await until(() => new ChatHistory(dataDir).load(10001).length > 0);
        app.stop();
        assert.ok(new ChatHistory(dataDir).load(10001).some(m => m.role === 'user' && m.content === '[引用你说的：「真实感觉啊……就是对你这脾气已经摸清了」]你这是说谁呢～'), logs.join('\n'));
    });
});
