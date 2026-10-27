import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { startApp } from '../src/platform/app.ts';
import { toStored } from '../src/memory/backfill.ts';
import type { AppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { segmentsToText, type MessageEvent, type QuoteLookup } from '../src/platform/onebot.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

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

    test('找不到、id 不是数字、没给查找：什么都不写，和以前一样', () => {
        assert.equal(segmentsToText([reply('999'), text('为什么啊')], lookup), '为什么啊');
        assert.equal(segmentsToText([reply('abc'), text('为什么啊')], lookup), '为什么啊');
        assert.equal(segmentsToText([reply('701'), text('为什么啊')]), '为什么啊');
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
            characterCard: join(resolve(import.meta.dirname, '../../..'), 'characters/linmengyao/st/linmengyao-{tier}.json'),
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
});
