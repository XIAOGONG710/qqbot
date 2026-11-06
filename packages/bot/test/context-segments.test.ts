import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { startApp } from '../src/platform/app.ts';
import type { AppConfig } from '../src/platform/config.ts';
import { ChatHistory } from '../src/memory/history.ts';
import { otherSegmentText, renderForward, segmentsToText, type MessageEvent } from '../src/platform/onebot.ts';
import { DEFAULT_WORLD_INFO_SETTINGS } from '../src/st/world-info.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

// 11-02「检查类似的问题」：和引用丢了一样，有些东西进她的提示词之前被丢掉、写错或者认不出是谁说的
const text = (value: string) => ({ type: 'text', data: { text: value } });

describe('认不出的消息段写成人话，不写英文类型名', () => {
    test('骰子、猜拳、商城表情、位置、推荐、markdown、戳一戳……', () => {
        assert.equal(otherSegmentText('dice', { result: '5' }), '[掷骰子：5 点]');
        assert.equal(otherSegmentText('dice', {}), '[掷骰子]');
        assert.equal(otherSegmentText('rps', { result: '2' }), '[猜拳]');
        assert.equal(otherSegmentText('mface', { summary: '[好耶]' }), '[好耶]');
        assert.equal(otherSegmentText('mface', {}), '[商城表情]');
        assert.equal(otherSegmentText('location', { title: '山大路科技市场', content: '雾岚市市历下区' }), '[位置：山大路科技市场 雾岚市市历下区]');
        assert.equal(otherSegmentText('contact', { type: 'group', id: '1' }), '[推荐了一个群]');
        assert.equal(otherSegmentText('contact', { type: 'qq', id: '1' }), '[推荐了一个QQ好友]');
        assert.equal(otherSegmentText('markdown', { content: '## 今晚 **一起** 吃饭' }), '今晚 一起 吃饭');
        assert.equal(otherSegmentText('poke', {}), '[戳一戳]');
        assert.equal(otherSegmentText('something_new', {}), '[一条特殊消息]');
        assert.equal(segmentsToText([{ type: 'dice', data: { result: 3 } }, text('你也来')]), '[掷骰子：3 点]你也来');
        for (const type of ['dice', 'rps', 'mface', 'location', 'contact', 'markdown', 'poke', 'shake', 'xml', 'whatever']) {
            assert.doesNotMatch(otherSegmentText(type, {}), /^\[[a-z_]+\]$/, type);
        }
    });
});

describe('合并转发：谁说了什么写清楚，别人的话不写成他的', () => {
    test('node 段和 OneBot 消息两种样子都认；他写「他」、她写「你」、别人写昵称；太多只放前 8 条', () => {
        const who = (userId: number | undefined, nickname: string) => (userId === 10001 ? '他' : userId === 20000 ? '你' : nickname);
        const nodes = [
            { type: 'node', data: { user_id: 30001, nickname: '小王', content: [text('你男朋友昨天是不是放你鸽子了')] } },
            { type: 'node', data: { user_id: 10001, nickname: '阿明', content: [text('没有的事')] } },
            { sender: { user_id: 20000, nickname: '梦瑶' }, message: [text('我作证')] },
        ];
        assert.equal(renderForward(nodes, who), '[转发的聊天记录（共 3 条）：小王：你男朋友昨天是不是放你鸽子了／他：没有的事／你：我作证]');
        const many = Array.from({ length: 12 }, (_, i) => ({ type: 'node', data: { user_id: 30000 + i, nickname: `人${i}`, content: [text(`第${i}句`)] } }));
        assert.match(renderForward(many, who)!, /^\[转发的聊天记录（共 12 条，下面是前 8 条）：人0：第0句／/);
        assert.equal(renderForward([], who), undefined);
        assert.equal(renderForward([{ type: 'node', data: { user_id: 1, nickname: 'x', content: [] } }], who), undefined);
    });

    test('没给查找、查不到：照旧只写「[转发的聊天记录]」', () => {
        assert.equal(segmentsToText([{ type: 'forward', data: { id: 'abc' } }]), '[转发的聊天记录]');
        assert.equal(segmentsToText([{ type: 'forward', data: { id: 'abc' } }], undefined, () => undefined), '[转发的聊天记录]');
    });
});

describe('进应用：转发问 NapCat、语音没发成就用文字', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

    function app(generate: () => string, callAction?: (action: string, params: Record<string, unknown>) => Promise<unknown>) {
        const dataDir = mkdtempSync(join(tmpdir(), 'qqbot-ctx-'));
        dirs.push(dataDir);
        const cfg = {
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
        const started = startApp({
            config: cfg, log: () => {},
            transport: {
                sendPrivateText: async (_userId, value) => { sent.push(value); return 900 + sent.length; },
                friendHistory: async () => [],
                ...(callAction ? { callAction } : {}),
            },
            pipeline: { generate: async messages => { seen.push(messages.map(m => m.content).join('\n')); return generate(); }, settle: { quietMs: 0, maxMs: 0 } },
        });
        return { app: started, seen, sent, dataDir };
    }
    const until = async (done: () => boolean) => { const deadline = Date.now() + 3000; while (!done() && Date.now() < deadline) await new Promise(r => setTimeout(r, 10)); };
    const message = (segments: unknown[]): MessageEvent => ({
        post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 20000, user_id: 10001, message_id: 811,
        time: Math.floor(Date.now() / 1000), message: segments as MessageEvent['message'], raw_message: '', sender: { user_id: 10001 },
    });

    test('他转发了一段只有 id 的聊天记录：问 NapCat（get_forward_msg），她看到的、记下的都带着谁说了什么', async () => {
        const asked: unknown[] = [];
        const { app: a, seen, sent, dataDir } = app(() => '这人好八卦', async (action, params) => {
            asked.push([action, params]);
            return { messages: [{ sender: { user_id: 30001, nickname: '小王' }, message: [text('他俩是不是吵架了')] }, { sender: { user_id: 10001, nickname: '阿明' }, message: [text('没有')] }] };
        });
        await a.connected(20000);
        a.receive(message([{ type: 'forward', data: { id: 'res-1' } }, text('你看这人')]));
        await until(() => sent.length > 0);
        a.stop();
        assert.deepEqual(asked, [['get_forward_msg', { message_id: 'res-1' }]]);
        const line = '[转发的聊天记录（共 2 条）：小王：他俩是不是吵架了／他：没有]你看这人';
        assert.ok(seen.at(-1)!.includes(line), seen.at(-1));
        assert.ok(new ChatHistory(dataDir).load(10001).some(m => m.role === 'user' && m.content === line));
    });

    test('她写了 <<语音：…>>、可这儿发不了语音：那句话用文字发出去，聊天记录里有，不再丢', async () => {
        const { app: a, sent, dataDir } = app(() => '好呀\n<<语音：晚安，早点睡>>');
        await a.connected(20000);
        a.receive(message([text('我睡啦')]));
        await until(() => sent.includes('晚安，早点睡'));
        await new Promise(r => setTimeout(r, 50));
        a.stop();
        assert.ok(sent.includes('晚安，早点睡'), sent.join('|'));
        assert.ok(!sent.some(s => s.includes('<<')), sent.join('|'));
        assert.ok(new ChatHistory(dataDir).load(10001).some(m => m.role === 'assistant' && m.content === '晚安，早点睡'));
    });
});
