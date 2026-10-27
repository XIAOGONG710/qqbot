import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { startApp } from '../src/platform/app.ts';
import type { AppConfig } from '../src/platform/config.ts';
import { ChatHistory, RECALLED_TEXT } from '../src/memory/history.ts';
import { isFriendRecall, type MessageEvent } from '../src/platform/onebot.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-recall-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const at = (n: number) => new Date(Date.UTC(2026, 9, 24, 12, 0, n)).toISOString();

describe('撤回（ADR 0082）：聊天记录', () => {
    test('他撤回还没回的一条：load 里是「[撤回了一条消息]」，别的原样，原文还在文件里，换个实例也一样', () => {
        const d = dir();
        const history = new ChatHistory(d);
        history.append(1, { time: at(0), role: 'user', content: '在吗', messageId: 901 });
        history.append(1, { time: at(1), role: 'assistant', content: '在', messageId: 902 });
        history.append(1, { time: at(2), role: 'user', content: '我其实有点喜欢你', messageId: 903 });
        history.append(1, { time: at(3), role: 'user', content: '另一条', messageId: 904 });
        assert.equal(history.recall(1, 903), true);
        assert.deepEqual(history.load(1).map(m => m.content), ['在吗', '在', RECALLED_TEXT, '另一条']);
        assert.match(readFileSync(join(d, 'chats', '1.jsonl'), 'utf8'), /我其实有点喜欢你/, '文件只追加，原文还在');
        assert.deepEqual(new ChatHistory(d).load(1).map(m => m.content), ['在吗', '在', RECALLED_TEXT, '另一条'], '重启后还是撤回的样子');
        assert.equal(history.recall(1, 903), false, '同一条不记两次');
    });

    test('不算数：回过的、她自己的、不认识的 id、keep 说要留着的', () => {
        const history = new ChatHistory(dir());
        history.append(1, { time: at(0), role: 'user', content: '在吗', messageId: 901 });
        history.append(1, { time: at(1), role: 'assistant', content: '在', messageId: 902 });
        history.append(1, { time: at(2), role: 'user', content: '我不想活了', messageId: 903 });
        assert.equal(history.recall(1, 901), false, '她已经回过了');
        assert.equal(history.recall(1, 902), false, '她自己的话');
        assert.equal(history.recall(1, 999), false);
        assert.equal(history.recall(1, 903, content => content.includes('不想活')), false, 'keep');
        assert.deepEqual(history.load(1).map(m => m.content), ['在吗', '在', '我不想活了']);
    });

    test('认得出好友撤回的通知', () => {
        const event = { post_type: 'notice', notice_type: 'friend_recall', self_id: 20000, user_id: 10001, message_id: 903 };
        assert.equal(isFriendRecall(event), true);
        assert.equal(isFriendRecall({ ...event, notice_type: 'group_recall' }), false);
        assert.equal(isFriendRecall({ ...event, message_id: undefined }), false);
        assert.equal(isFriendRecall({ ...event, post_type: 'message' }), false);
    });
});

describe('撤回（ADR 0082）：进应用', () => {
    const run = async (recalls: boolean, text: string) => {
        const dataDir = dir();
        const cfg = {
            llm: { baseUrl: 'http://127.0.0.1:1', model: 'm', apiKey: 'k', temperature: 1, maxTokens: 300, timeoutMs: 1000, promptPostProcessing: 'semi', extraBody: {} },
            prompt: { maxContext: 16384, worldInfo: DEFAULT_WORLD_INFO_SETTINGS, pinExamples: true },
            characterCard: join(resolve(import.meta.dirname, '../../..'), 'characters/linmengyao/st/linmengyao-{tier}.json'),
            contacts: [{ qq: 10001, name: '阿明', tier: 'boyfriend' }],
            unlistedFriends: false, schedule: false, moody: false, speechCheck: false, herDays: false, autonomousLife: false, projectChoice: false,
            lifeInPrompt: false, grievance: false, recalls, feedbackCommands: false, realWeather: false, media: true,
            candidates: 1, contextTurns: 0, contextContacts: [], proactive: 'off', dataDir,
        } as unknown as AppConfig; // 其余字段（后加的开关）都是未设 = 关
        const seen: string[] = [];
        const sent: string[] = [];
        const logs: string[] = [];
        const app = startApp({
            config: cfg, log: message => logs.push(message),
            transport: { sendPrivateText: async (userId, value) => { sent.push(`${userId}:${value}`); return 900; }, friendHistory: async () => [] },
            pipeline: { generate: async messages => { seen.push(messages.map(m => m.content).join('\n')); return '撤回啥了'; }, settle: { quietMs: 400, maxMs: 1000 } },
        });
        const event: MessageEvent = {
            post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 801,
            time: Math.floor(Date.now() / 1000), message: [{ type: 'text', data: { text } }], raw_message: text, sender: { user_id: 10001 },
        };
        app.receive(event);
        await new Promise(r => setTimeout(r, 50));
        app.receiveRecall({ post_type: 'notice', notice_type: 'friend_recall', self_id: 20000, user_id: 10001, message_id: 801 });
        const deadline = Date.now() + 4000;
        while (sent.length === 0 && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
        app.stop();
        return { prompt: seen.at(-1) ?? '', sent, logs };
    };

    test('开着：她回之前他撤回了，提示词里只有「[撤回了一条消息]」没有原文；日志不记内容', async () => {
        const { prompt, sent, logs } = await run(true, '我昨天梦到你了');
        assert.equal(sent.length, 1);
        assert.match(prompt, /\[撤回了一条消息\]/);
        assert.doesNotMatch(prompt, /梦到你/);
        assert.ok(logs.some(l => l === '[10001] 他撤回了一条还没回的消息，记成「撤回了一条消息」'), logs.join('|'));
        assert.ok(!logs.filter(l => l.includes('撤回')).some(l => l.includes('梦到')), '撤回那一行不带内容');
    });

    test('关着（默认）：照旧看到原文', async () => {
        const { prompt } = await run(false, '我昨天梦到你了');
        assert.match(prompt, /梦到你/);
        assert.doesNotMatch(prompt, /\[撤回了一条消息\]/);
    });

    test('想伤害自己的话撤回了也照样看到', async () => {
        const { prompt, logs } = await run(true, '我真的不想活了');
        assert.match(prompt, /不想活了/);
        assert.ok(!logs.some(l => l.includes('撤回了一条还没回')));
    });
});
