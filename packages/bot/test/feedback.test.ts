import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { createFeedbackChannel, FEEDBACK_WINDOW_MS, FeedbackLog, locateTurn, parseFeedback } from '../src/emotion/feedback.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import type { Segment } from '../src/platform/onebot.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-feedback-')); dirs.push(dir); return dir; };

const text = (value: string): Segment => ({ type: 'text', data: { text: value } });
const reply = (id: number | string): Segment => ({ type: 'reply', data: { id: String(id) } });
const face: Segment = { type: 'face', data: { id: '178' } };
const T0 = Date.parse('2026-10-15T12:00:00+08:00');
const at = (minutes: number) => new Date(T0 + minutes * 60_000);
const msg = (minutes: number, role: 'user' | 'assistant', content: string, messageId?: number): StoredMessage =>
    ({ time: at(minutes).toISOString(), role, content, ...(messageId !== undefined ? { messageId } : {}) });

describe('反馈指令的识别（ADR 0073）', () => {
    test('「假」「像」命中：可带一个 /、后面的标点、至多一个小黄脸', () => {
        for (const value of ['假', '像', '/假', '/像', ' 假 ', '假。', '假!!', '像～', '像…', '假？']) {
            assert.ok(parseFeedback([text(value)]), value);
            assert.ok(parseFeedback(value), `string ${value}`);
        }
        assert.deepEqual(parseFeedback([text('假')]), { label: 'fake' });
        assert.deepEqual(parseFeedback([text('像')]), { label: 'real' });
        assert.deepEqual(parseFeedback([text('像'), face]), { label: 'real' });
        assert.deepEqual(parseFeedback([text('假'), face, text('。')]), { label: 'fake' });
    });

    test('多一个字就不算：「假的」「太假了」「真假」「你真假」「假装」「像是」', () => {
        for (const value of ['假的', '太假了', '真假', '你真假', '假装', '像是', '好像', '假 像', '假像', '', '。', '//假', '／假']) {
            assert.equal(parseFeedback([text(value)]), undefined, value);
        }
    });

    test('别的段（图片、语音、@、第二个小黄脸、第二条引用）一出现就不算', () => {
        assert.equal(parseFeedback([text('假'), { type: 'image', data: { file: 'a.jpg' } }]), undefined);
        assert.equal(parseFeedback([{ type: 'record', data: {} }, text('像')]), undefined);
        assert.equal(parseFeedback([text('假'), face, face]), undefined);
        assert.equal(parseFeedback([reply(5), reply(6), text('假')]), undefined);
        assert.equal(parseFeedback([{ type: 'at', data: { qq: '1' } }, text('假')]), undefined);
        assert.equal(parseFeedback([face]), undefined, '只有小黄脸不是指令');
    });

    test('QQ 的回复引用：取被引用的消息 id；id 不是正整数就不算', () => {
        assert.deepEqual(parseFeedback([reply(900), text('/假。')]), { label: 'fake', replyTo: 900 });
        assert.equal(parseFeedback([reply('abc'), text('假')]), undefined);
        assert.equal(parseFeedback([reply(0), text('假')]), undefined);
        assert.equal(parseFeedback([reply(-3), text('像')]), undefined);
    });
});

describe('找被评价的那一轮', () => {
    const history = [
        msg(-60, 'user', '早'), msg(-59, 'assistant', '早呀', 11),
        msg(-40, 'user', '吃了吗'), msg(-39, 'assistant', '刚吃完', 21), msg(-39, 'assistant', '你呢', 22), msg(-38, 'assistant', '在干嘛', 23),
        msg(-10, 'user', '在看番'),
    ];

    test('不带引用：她最近那一串连续的消息；上下文是它之前最多 6 条', () => {
        const turn = locateTurn(history, at(-9))!;
        assert.deepEqual(turn.her.map(m => m.content), ['刚吃完', '你呢', '在干嘛']);
        assert.deepEqual(turn.context.map(m => m.content), ['早', '早呀', '吃了吗']);
        const long = [...Array.from({ length: 10 }, (_, i) => msg(-100 + i, 'user', `旧${i}`)), msg(-5, 'assistant', '新的', 31)];
        assert.deepEqual(locateTurn(long, at(0))!.context.map(m => m.content), ['旧4', '旧5', '旧6', '旧7', '旧8', '旧9']);
    });

    test('不带引用：她最后一条在 30 分钟之外就不算；刚好 30 分钟算', () => {
        assert.equal(locateTurn(history, new Date(at(-38).getTime() + FEEDBACK_WINDOW_MS + 1)), undefined);
        assert.ok(locateTurn(history, new Date(at(-38).getTime() + FEEDBACK_WINDOW_MS)));
        assert.equal(locateTurn([msg(-1, 'user', '你好')], at(0)), undefined, '一条她的话都没有');
        assert.equal(locateTurn([], at(0)), undefined);
    });

    test('带引用：被引用那条所在的一串；不是她发的、不在记录里就找不到；不受 30 分钟限制', () => {
        const turn = locateTurn(history, at(500), 22)!;
        assert.deepEqual(turn.her.map(m => m.content), ['刚吃完', '你呢', '在干嘛']);
        assert.deepEqual(locateTurn(history, at(500), 11)!.her.map(m => m.content), ['早呀']);
        assert.equal(locateTurn(history, at(0), 999), undefined, '不在记录里');
        const userMsg = [msg(-5, 'user', '他自己的话', 77), msg(-4, 'assistant', '她的', 78)];
        assert.equal(locateTurn(userMsg, at(0), 77), undefined, '被引用的是他自己的话');
    });
});

describe('记录文件', () => {
    const row = (messageId: number) => ({ at: at(0).toISOString(), label: 'fake' as const, messageId, herMessageId: 1, her: ['x'], context: [], tier: 'boyfriend' });

    test('按月追加，一行一条；重新打开能认出已记过的消息 id，并接着数', () => {
        const dir = tmp();
        const first = new FeedbackLog(dir);
        assert.equal(first.has(5), false);
        assert.equal(first.record(row(5), at(0)), 1);
        assert.equal(first.record(row(6), at(0)), 2);
        assert.equal(first.has(5), true);
        const again = new FeedbackLog(dir);
        assert.equal(again.has(6), true);
        assert.equal(again.has(7), false);
        assert.equal(again.record(row(7), at(0)), 3);
        const file = readFileSync(join(dir, 'feedback', '2026-10.jsonl'), 'utf8').trimEnd().split('\n');
        assert.equal(file.length, 3);
        assert.equal(JSON.parse(file[2]!).messageId, 7);
    });

    test('文件里有坏行也不崩，坏行不算数', () => {
        const dir = tmp();
        new FeedbackLog(dir).record(row(1), at(0));
        const path = join(dir, 'feedback', '2026-10.jsonl');
        appendFileSync(path, 'not json\n', 'utf8');
        const reopened = new FeedbackLog(dir);
        assert.equal(reopened.has(1), true);
        assert.equal(reopened.record(row(2), at(0)), 2);
    });
});

describe('反馈通道', () => {
    const history = [msg(-20, 'user', '在吗'), msg(-19, 'assistant', '在呀', 40), msg(-19, 'assistant', '怎么啦', 41)];

    test('命中：记一行、日志只有标签和第几条、返回 true；同一条消息 id 再来一遍不重复记', () => {
        const dir = tmp();
        const logs: string[] = [];
        const channel = createFeedbackChannel(dir, line => logs.push(line));
        assert.equal(channel.consume(10001, 'boyfriend', [text('假')], 900, at(0), history), true);
        assert.equal(channel.consume(10001, 'boyfriend', [text('假')], 900, at(0), history), true, '重投：吞掉但不再记');
        const lines = readFileSync(join(dir, 'feedback', '2026-10.jsonl'), 'utf8').trimEnd().split('\n');
        assert.equal(lines.length, 1);
        const saved = JSON.parse(lines[0]!);
        assert.deepEqual({ label: saved.label, messageId: saved.messageId, herMessageId: saved.herMessageId, her: saved.her, tier: saved.tier },
            { label: 'fake', messageId: 900, herMessageId: 41, her: ['在呀', '怎么啦'], tier: 'boyfriend' });
        assert.deepEqual(saved.context, [{ role: 'user', text: '在吗' }]);
        assert.deepEqual(logs, ['[10001] 反馈：假（本月第 1 条）']);
        assert.ok(logs.every(line => !line.includes('在呀')), '日志里没有聊天正文');
    });

    test('带引用时 herMessageId 是被引用的那条；不是指令、或找不到那一轮就返回 false 且什么都不写', () => {
        const dir = tmp();
        const channel = createFeedbackChannel(dir, () => {});
        assert.equal(channel.consume(1, 'boyfriend', [reply(40), text('像')], 901, at(0), history), true);
        const saved = JSON.parse(readFileSync(join(dir, 'feedback', '2026-10.jsonl'), 'utf8').trim());
        assert.deepEqual({ label: saved.label, herMessageId: saved.herMessageId }, { label: 'real', herMessageId: 40 });
        assert.equal(channel.consume(1, 'boyfriend', [text('假的')], 902, at(0), history), false);
        assert.equal(channel.consume(1, 'boyfriend', [text('假')], 903, at(60), history), false, '30 分钟外');
        assert.equal(channel.consume(1, 'boyfriend', [reply(12345), text('假')], 904, at(0), history), false, '引用的找不到');
        assert.equal(readFileSync(join(dir, 'feedback', '2026-10.jsonl'), 'utf8').trimEnd().split('\n').length, 1);
        assert.equal(existsSync(join(dir, 'feedback')), true);
    });
});
