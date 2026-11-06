import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { startApp } from '../src/platform/app.ts';
import type { AppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';
import type { MessageEvent } from '../src/platform/onebot.ts';
import { AI_MARK, greetingOnly, markSignature, MINOR_NOTICE, minorHint, STRANGER_DAILY, strangerGuard } from '../src/social/strangers.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// ADR 0209（用户 11-02）：陌生人从签名知道她是 AI；签名没写明之前不回；每天上限；只打招呼先不回；未成年人不陪
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-strangers-')); dirs.push(dir); return dir; };

describe('陌生人：规矩本身', () => {
    test('签名补「（AI）」：已经写明的不动，太长截正文', () => {
        assert.equal(markSignature('雨天不想出门'), `雨天不想出门${AI_MARK}`);
        assert.equal(markSignature('  下雨了  '), `下雨了${AI_MARK}`);
        assert.equal(markSignature('我是 AI，别当真'), '我是 AI，别当真');
        assert.equal(markSignature(''), AI_MARK);
        const long = markSignature('很'.repeat(100));
        assert.equal([...long].length, 80);
        assert.ok(long.endsWith(AI_MARK));
    });

    test('看得出是未成年人：说自己初中高中、未成年、十几岁；别人的事、「高一点」不算', () => {
        for (const text of ['我初二的，能陪我聊天吗', '初三了作业好多', '我才15岁', '我今年十六岁', '我是高中生', '我未成年', '还没满十八呢', '你好，我高一']) assert.ok(minorHint(text), text);
        for (const text of ['我弟上初中', '把灯调高一点', '我今年20岁', '我十八岁了', '高三那年我天天熬夜', '你几岁']) assert.ok(!minorHint(text), text);
    });

    test('只打招呼：在吗、你好、？……都是招呼才算', () => {
        assert.ok(greetingOnly(['在吗']));
        assert.ok(greetingOnly(['在吗', '？', '你好']));
        assert.ok(!greetingOnly(['在吗', '想问你个事']));
        assert.ok(!greetingOnly(['你好，想问个事']));
        assert.ok(!greetingOnly([]));
    });

    test('每天上限：每人、一天几个人、一共几条；换一天重新算；未成年人和签名记在文件里，重启还在', () => {
        const dir = tmp();
        const guard = strangerGuard(dir);
        const day = Date.parse('2026-11-02T12:00:00+08:00');
        for (let i = 0; i < STRANGER_DAILY.perContact; i++) assert.deepEqual(guard.take(1, day), { allowed: true });
        assert.equal(guard.take(1, day).allowed, false);
        for (let qq = 2; qq <= STRANGER_DAILY.contacts; qq++) assert.equal(guard.take(qq, day).allowed, true);
        const full = guard.take(STRANGER_DAILY.contacts + 1, day);
        assert.ok(!full.allowed && full.reason.includes(`${STRANGER_DAILY.contacts} 个陌生人`));
        assert.equal(guard.take(1, day + 86_400_000).allowed, true, '第二天重新算');
        guard.markMinor(7);
        guard.markSigned(day);
        const again = strangerGuard(dir);
        assert.ok(again.isMinor(7) && !again.isMinor(8) && again.signed());
    });
});

describe('陌生人：进应用', () => {
    function app(extra: Record<string, unknown>) {
        const dataDir = tmp();
        const cfg = {
            llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
            prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
            characterCard: syntheticCardPattern,
            contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend', knowsBot: true }],
            unlistedFriends: true, schedule: false, moody: false, speechCheck: false, herDays: false, autonomousLife: false, projectChoice: false,
            lifeInPrompt: false, grievance: false, feedbackCommands: false, realWeather: false, media: true,
            candidates: 1, contextTurns: 0, contextContacts: [], proactive: 'off', dataDir,
        } as unknown as AppConfig;
        const sent: string[] = [];
        const logs: string[] = [];
        const started = startApp({
            config: cfg, log: m => logs.push(m),
            transport: { sendPrivateText: async (userId, value) => { sent.push(`${userId}:${value}`); return 900 + sent.length; }, friendHistory: async () => [], ...extra },
            pipeline: { generate: async () => '你哪位', settle: { quietMs: 0, maxMs: 0 } },
        });
        return { app: started, sent, logs, dataDir };
    }
    const until = async (done: () => boolean) => { const deadline = Date.now() + 3000; while (!done() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10)); };
    let id = 1;
    const from = (qq: number, text: string): MessageEvent => ({
        post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: qq, message_id: 5000 + id++,
        time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: qq, nickname: '路人' },
    });

    test('改不了签名：陌生人一律不回（她是 AI 这件事没地方写）', async () => {
        const { app: a, sent, logs } = app({});
        await a.connected(20000);
        a.receive(from(77777, '你好，想问个事'));
        await new Promise(r => setTimeout(r, 100));
        a.stop();
        assert.equal(sent.length, 0);
        assert.ok(logs.some(l => l.includes('改不了个性签名')) && logs.some(l => l.includes('个性签名还没写明她是 AI')), logs.join('\n'));
    });

    test('连上时读现在的签名、补「（AI）」，之后才回陌生人', async () => {
        const set: string[] = [];
        const { app: a, sent } = app({
            setSignature: async (text: string) => { set.push(text); },
            callAction: async (action: string) => (action === 'get_stranger_info' ? { long_nick: '雨天不想出门' } : {}),
        });
        await a.connected(20000);
        await until(() => set.length > 0);
        a.receive(from(77777, '你好，想问个事'));
        await until(() => sent.length > 0);
        a.stop();
        assert.deepEqual(set, [`雨天不想出门${AI_MARK}`]);
        assert.deepEqual(sent, ['77777:你哪位']);
    });

    test('只打招呼先不回（记着）；说了点什么再回', async () => {
        const { app: a, sent, logs, dataDir } = app({ setSignature: async () => {} });
        await a.connected(20000);
        await until(() => logs.some(l => l.includes('个性签名写明了她是 AI')));
        a.receive(from(77777, '在吗'));
        await new Promise(r => setTimeout(r, 100));
        assert.equal(sent.length, 0);
        assert.ok(new ChatHistory(dataDir).load(77777).some(m => m.content === '在吗'));
        a.receive(from(77777, '想问你个事'));
        await until(() => sent.length > 0);
        a.stop();
        assert.deepEqual(sent, ['77777:你哪位']);
    });

    test('说了自己未成年：照实说一句她是 AI、不陪未成年人聊天，之后不再回这个号', async () => {
        const { app: a, sent, logs } = app({ setSignature: async () => {} });
        await a.connected(20000);
        await until(() => logs.some(l => l.includes('个性签名写明了她是 AI')));
        a.receive(from(66666, '我初二的，能陪我聊天吗'));
        await until(() => sent.length > 0);
        a.receive(from(66666, '为什么不行'));
        await new Promise(r => setTimeout(r, 100));
        a.stop();
        assert.deepEqual(sent, [`66666:${MINOR_NOTICE}`]);
        assert.ok(logs.some(l => l.includes('之前看出是未成年人，不再回')), logs.join('\n'));
        assert.match(MINOR_NOTICE, /AI/);
    });
});
