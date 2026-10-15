import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { buildReport, contentKind, loadReportData, type ChatRow, type ReportData } from '../src/ops/daily-report.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));
const at = (hhmm: string, date = '2026-10-14') => `${date}T${hhmm}:00+08:00`;
const row = (role: 'user' | 'assistant', time: string, content: string): ChatRow => ({ time, role, content });
const empty = (): ReportData => ({ chats: new Map(), proactive: new Map(), events: [], feedback: [], logs: [] });

describe('每日原始数报告（T2）', () => {
    test('内容分类：文字 / 表情（只有 [xxx] 或图片表情标记）/ 图片 / 语音', () => {
        assert.equal(contentKind('在吗'), 'text');
        assert.equal(contentKind('在吗[捂脸]'), 'text', '文字里夹小黄脸还是文字');
        assert.equal(contentKind('[动画表情]'), 'face');
        assert.equal(contentKind('[爽了，] [好困]'), 'face');
        assert.equal(contentKind('<sticker:abc123>'), 'face');
        assert.equal(contentKind('[图片：一只猫]'), 'image');
        assert.equal(contentKind('[语音]'), 'voice');
    });

    test('量、表层、断联指标、反馈、服务：按当天（+08:00）算，窗口外的不进来；报告里没有聊天原话', () => {
        const data = empty();
        data.chats.set(10001234, [
            row('user', at('23:59', '2026-10-13'), '昨天的一句'),
            row('user', at('09:00'), '早'),
            row('assistant', at('09:01'), '早呀'),
            row('assistant', at('09:01'), '刚起床'),
            row('assistant', at('09:01'), '好困啊'),
            row('user', at('09:05'), '[动画表情]'),
            row('assistant', at('09:06'), '你吃饭了吗？'),
            row('assistant', at('09:30'), '去上课了'),
            row('user', at('09:31'), '[图片：猫]'),
            row('assistant', at('09:32'), '[爽了，]'),
            row('assistant', at('00:05', '2026-10-15'), '明天的一句'),
        ]);
        data.proactive.set(10001234, [
            { id: '2026-10-14:morning', at: at('09:30'), result: 'sent', messageIds: [1, 2] },
            { id: '2026-10-14:quiet', at: at('15:00'), result: 'skipped' },
            { id: '2026-10-13:bedtime', at: at('23:30', '2026-10-13'), result: 'sent', messageIds: [3] },
        ]);
        data.events = [
            { kind: 'eat', day: '2026-10-14' }, { kind: 'attend_class', day: '2026-10-14' }, { kind: 'attend_class', day: '2026-10-14' },
            { kind: 'feed_cat', day: '2026-10-14' }, { kind: 'sleep', day: '2026-10-13' },
        ];
        data.feedback = [{ at: at('10:00'), label: 'fake' }, { at: at('10:05'), label: 'real' }, { at: at('10:06'), label: 'fake' }, { at: at('10:00', '2026-10-13'), label: 'fake' }];
        const ms = (hhmm: string) => Date.parse(at(hhmm));
        data.logs = [
            { timestamp: ms('08:00'), content: '名单：10001234（…）' },
            { timestamp: ms('08:01'), content: '她的行动队列：结算 sleep' },
            { timestamp: ms('12:00'), content: '[10001234] 模型正文是空的（finish=stop）' },
            { timestamp: ms('13:00'), content: '[10001234] 生成出错：模型接口返回 500：错误' },
            { timestamp: ms('14:00'), content: '[10001234] 危机信号：他说了想伤害自己的话' },
            { timestamp: Date.parse(at('08:00', '2026-10-13')), content: '名单：昨天的启动' },
        ];
        const text = buildReport(data, '2026-10-14');
        assert.match(text, /联系人 …1234：他发来 3（文字 1、表情 1、图片 1、语音 0）；她回复 6（文字 5、表情 1、图片 0、语音 0）；其中她主动 1 次（2 条）/);
        // 文字轮：[早呀/刚起床/好困啊](3) [你吃饭了吗？](1) [去上课了](1)；表情那条不进文字轮
        assert.match(text, /轮数 3，气泡 5/);
        assert.match(text, /一轮一条 67%，两条 0%，三条以上 33%/);
        assert.match(text, /每条中位 3 字，1–3 字的占 60%/);
        assert.match(text, /带问句的轮 33%/);
        assert.match(text, /事件账上她这天过的事 4 件；其中类别在她的话里出现过关键词的 3 件（3\/4）/);
        assert.match(text, /attend_class：账上 2 件，她说起过/);
        assert.match(text, /feed_cat：账上 1 件，没说起/);
        assert.match(text, /假 2，像 1/);
        assert.match(text, /日志 5 行；启动 1 次/);
        assert.match(text, /错误 1、模型正文是空的 1、被截断 0、危机信号 1/);
        for (const content of ['昨天的一句', '明天的一句', '刚起床', '你吃饭了吗']) assert.ok(!text.includes(content), `报告里不该有聊天原话：${content}`);
        assert.doesNotMatch(text, /指数|得分|分数/, '只给原始数，没有综合分');
    });

    test('他一条都没发的日子：明说，下面的数照给；没数据的一天也不崩', () => {
        const data = empty();
        data.chats.set(10009999, [row('assistant', at('10:00'), '突然想吃火锅')]);
        data.events = [{ kind: 'eat', day: '2026-10-14' }];
        const text = buildReport(data, '2026-10-14');
        assert.match(text, /这一天他一条都没发/);
        assert.match(text, /她回复 1（文字 1/);
        assert.match(text, /3.*（1\/1）|（1\/1）/);
        const nothing = buildReport(empty(), '2026-10-14');
        assert.match(nothing, /没有聊天记录文件/);
        assert.match(nothing, /她这天没有说文字/);
        assert.match(nothing, /这天没有日志/);
        assert.throws(() => buildReport(empty(), 'yesterday'), /YYYY-MM-DD/);
    });

    test('读数据目录：聊天、主动、事件账、反馈、日志；缺的目录和坏行都不崩', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-daily-report-'));
        dirs.push(dir);
        for (const sub of ['chats', 'proactive', 'world', 'feedback', 'logs']) mkdirSync(join(dir, sub));
        writeFileSync(join(dir, 'chats', '10001.jsonl'), `${JSON.stringify(row('user', at('09:00'), '早'))}\nnot json\n${JSON.stringify({ time: 'bad', role: 'user', content: 'x' })}\n`);
        writeFileSync(join(dir, 'proactive', '10001-boyfriend.json'), JSON.stringify({ records: [{ id: 'a', at: at('09:00'), result: 'sent' }] }));
        writeFileSync(join(dir, 'proactive', '10002-classmate.json'), 'broken');
        writeFileSync(join(dir, 'world', 'events.json'), JSON.stringify({ version: 1, events: [{ kind: 'eat', day: '2026-10-14' }, { nokind: 1 }] }));
        writeFileSync(join(dir, 'feedback', '2026-10.jsonl'), `${JSON.stringify({ at: at('10:00'), label: 'fake' })}\n???\n`);
        writeFileSync(join(dir, 'logs', '2026-10-14-1.log'), `${JSON.stringify({ timestamp: Date.parse(at('08:00')), content: '名单：x' })}\nplain text line\n`);
        const data = loadReportData(dir, join(dir, 'logs'));
        assert.equal(data.chats.get(10001)!.length, 1);
        assert.equal(data.proactive.get(10001)!.length, 1);
        assert.equal(data.proactive.has(10002), false);
        assert.equal(data.events.length, 1);
        assert.equal(data.feedback.length, 1);
        assert.equal(data.logs.length, 1);
        const missing = loadReportData(join(dir, 'nope'), join(dir, 'also-nope'));
        assert.equal(missing.chats.size + missing.events.length + missing.logs.length, 0);
    });
});
