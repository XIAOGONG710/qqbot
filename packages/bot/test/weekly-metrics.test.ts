import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import {
    appendRun, compareMetrics, computeWeeklyMetrics, formatMetrics, latencyStats, loadMetricsData, metricsLogPath, previousRun, turnsOf, windowOf,
} from '../src/ops/weekly-metrics.ts';

// ADR 0348：每周效果数——只用合成聊天记录（ADR 0333），断言输出里只有数、没有原话
const SECRET = '独一无二的暗号七七三';
const at = (day: number, h: number, m = 0, s = 0) => new Date(2026, 10, day, h, m, s).toISOString();
const msg = (time: string, role: 'user' | 'assistant', content: string, messageId?: number): StoredMessage =>
    ({ time, role, content, ...(messageId === undefined ? {} : { messageId }) });

/** 11-16 一天：回他（带叮嘱、问句结尾、被他纠正）、回他（原话）、回他（同一句原话又说一遍）、隔了两个多小时自己开口（助手腔）、
 *  主动记录里的一条（做不到的事）；11-18 一轮只有表情 */
const history: StoredMessage[] = [
    msg(at(15, 20), 'user', `前一天的话 ${SECRET}`),
    msg(at(15, 20, 1), 'assistant', '嗯嗯'),
    msg(at(16, 9), 'user', '今天好累'),
    msg(at(16, 9, 0, 40), 'assistant', '那你早点休息', 1),
    msg(at(16, 9, 0, 50), 'assistant', '晚上吃什么吗', 2),
    msg(at(16, 9, 5), 'user', '你记错了'),
    msg(at(16, 9, 6), 'assistant', `我今天在图书馆复习高数一下午${SECRET}`, 3),
    msg(at(16, 9, 30), 'user', '嗯'),
    msg(at(16, 9, 31), 'assistant', `我今天在图书馆复习高数一下午${SECRET}`, 4),
    msg(at(16, 12), 'assistant', '希望对你有帮助，有什么需要随时找我', 5),
    msg(at(16, 12, 5), 'assistant', '我给你打个电话吧', 6),
    msg(at(18, 22), 'user', '晚安'),
    msg(at(18, 22, 3), 'assistant', '[图片表情]', 7),
];

describe('每周效果数', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

    test('一轮一轮分开：回他 / 自己找他（主动记录或隔一小时以上）/ 接着自己说，回他的才有延迟', () => {
        const withIds = turnsOf(history, new Set([6]));
        assert.deepEqual(withIds.map(turn => turn.kind), ['reply', 'reply', 'reply', 'reply', 'proactive', 'proactive', 'reply']);
        assert.deepEqual(withIds.map(turn => turn.latencySec), [60, 40, 60, 60, undefined, undefined, 180]);
        assert.equal(withIds[1]!.bubbles, 2, '隔 10 秒的两条算一轮');
        assert.equal(turnsOf(history)[5]!.kind, 'followOn', '没有主动记录、离上一条她自己的只隔 5 分钟：接着说');
        assert.equal(withIds.at(-1)!.text, undefined, '只有表情的一轮不算文字轮');
    });

    test('检测器复用：叮嘱、问句结尾、他纠正、出口检查口径的重复、助手腔、做不到的事', () => {
        const [, first, second, third, fourth, fifth] = turnsOf(history, new Set([6]));
        assert.equal(first!.text!.nag, true);
        assert.equal(first!.text!.questionEnd, true);
        assert.equal(first!.text!.corrected, true);
        assert.equal(first!.text!.lines, 2);
        assert.equal(second!.text!.repeat, false);
        assert.equal(third!.text!.repeat, true, '同一句原话又说一遍');
        assert.equal(fourth!.text!.tone, true);
        assert.equal(fifth!.text!.promise, true);
        assert.equal(fifth!.text!.tone, false);
    });

    test('按天和整周汇总：没聊天的日子也有一行，窗口外的只当上下文', () => {
        const window = windowOf('2026-11-18', 3);
        const metrics = computeWeeklyMetrics({ chats: new Map([[10001, history]]), proactiveIds: new Map([[10001, new Set([6])]]), ...window });
        assert.deepEqual(metrics.days.map(day => day.day), ['2026-11-16', '2026-11-17', '2026-11-18']);
        const [d16, d17, d18] = metrics.days;
        assert.equal(d16!.hisMessages, 3);
        assert.equal(d16!.turns, 5);
        assert.equal(d16!.textTurns, 5);
        assert.equal(d16!.replyTurns, 3);
        assert.equal(d16!.proactiveTurns, 2);
        assert.equal(d16!.proactiveShare, 0.4);
        assert.equal(d16!.nagRate, 0.2);
        assert.equal(d16!.repeatRate, 0.2);
        assert.equal(d16!.duplicateRate, 0.2);
        assert.equal(d16!.assistantToneRate, 0.2);
        assert.equal(d16!.promiseRate, 0.2);
        assert.equal(d16!.correctedRate, 0.2);
        assert.equal(d16!.questionEndRate, 0.2);
        assert.equal(d16!.medianLines, 1);
        assert.equal(d17!.turns, 0);
        assert.equal(d17!.avgChars, null);
        assert.equal(d17!.nagRate, null);
        assert.equal(d18!.textTurns, 0);
        assert.equal(d18!.latency.count, 1);
        assert.equal(metrics.week.turns, 6);
        assert.equal(metrics.week.hisMessages, 4, '11-15 那条在窗口外');
        assert.equal(metrics.week.latency.count, 4);
        assert.equal(metrics.week.latency.p50, 60);
        assert.equal(metrics.week.latency.within2m, 3);
        assert.equal(metrics.week.latency.within10m, 1);
        const text = formatMetrics(metrics);
        assert.match(text, /每周效果数/);
        assert.match(text, /\| 11-17 \| 0 \| 0 \|/);
        for (const out of [text, JSON.stringify(metrics)]) {
            assert.doesNotMatch(out, new RegExp(SECRET));
            assert.doesNotMatch(out, /图书馆|早点休息|打个电话/);
        }
    });

    test('延迟分档和分位', () => {
        assert.deepEqual(latencyStats([10, 30, 31, 120, 121, 600, 601, 3600, 3601]), {
            count: 9, p50: 121, p90: 3601, within30s: 2, within2m: 2, within10m: 2, within1h: 2, over1h: 1,
        });
        assert.deepEqual(latencyStats([]), { count: 0, p50: null, p90: null, within30s: 0, within2m: 0, within10m: 0, within1h: 0, over1h: 0 });
    });

    test('读数据目录、记日志、和同一范围的上一次比；日志里只有数', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-weekly-metrics-'));
        dirs.push(dir);
        mkdirSync(join(dir, 'chats'));
        mkdirSync(join(dir, 'proactive'));
        writeFileSync(join(dir, 'chats', '10001.jsonl'), history.map(row => JSON.stringify(row)).join('\n') + '\nnot json\n');
        writeFileSync(join(dir, 'chats', '10002.jsonl'), JSON.stringify(msg(at(16, 8), 'user', '在吗')) + '\n');
        writeFileSync(join(dir, 'proactive', '10001-boyfriend.json'), JSON.stringify({
            version: 1, records: [{ result: 'sent', messageIds: [6] }, { result: 'skipped', messageIds: [3] }], followUps: [], extracted: {},
        }));
        writeFileSync(join(dir, 'proactive', '10002.json'), '{坏的');
        const data = loadMetricsData(dir);
        assert.deepEqual([...data.chats.keys()].sort(), [10001, 10002]);
        assert.deepEqual([...data.proactiveIds.get(10001)!], [6]);
        assert.equal(loadMetricsData(dir, 10002).chats.size, 1);
        assert.throws(() => loadMetricsData(join(dir, '没有')), /chats/);

        const window = windowOf('2026-11-18', 3);
        const first = computeWeeklyMetrics({ ...data, ...window });
        const log = metricsLogPath(dir);
        assert.equal(previousRun(log, 'all'), undefined);
        appendRun(log, first, new Date(2026, 10, 19, 9));
        appendRun(log, { ...first, scope: 'qq…0002' }, new Date(2026, 10, 19, 9, 1));
        const second = computeWeeklyMetrics({ chats: new Map([[10001, history.slice(0, 5)]]), ...window });
        const previous = previousRun(log, 'all');
        assert.equal(previous?.week.turns, first.week.turns);
        const deltas = compareMetrics(previous!.week, second.week);
        assert.deepEqual(deltas.turns, { before: 6, after: 1, delta: -5 });
        assert.equal(deltas.nagRate.after, 1);
        assert.equal(deltas.nagRate.delta, 0.8);
        assert.deepEqual(deltas['latency.p50'], { before: 60, after: 40, delta: -20 });
        const table = formatMetrics(second, { previous: previous!, deltas });
        assert.match(table, /和上一次比/);
        assert.match(table, /\| 叮嘱 \| 20\.0% \| 100\.0% \| \+80\.0 个点 \|/);
        assert.match(formatMetrics(second, null), /没有同一范围的上一次/);
        const logged = readFileSync(log, 'utf8');
        assert.equal(logged.trim().split('\n').length, 2);
        assert.doesNotMatch(logged, new RegExp(SECRET));
        assert.doesNotMatch(logged, /图书馆|早点休息|10001|10002/);
    });

    test('命令行：--json --compare --until，第二次跑能比上一次', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-weekly-metrics-cli-'));
        dirs.push(dir);
        mkdirSync(join(dir, 'chats'));
        writeFileSync(join(dir, 'chats', '10001.jsonl'), history.map(row => JSON.stringify(row)).join('\n'));
        const cli = resolve(import.meta.dirname, '../src/ops/weekly-metrics-cli.ts');
        const run = (...extra: string[]) => execFileSync(process.execPath, [cli, '--data', dir, '--until', '2026-11-18', '--days', '3', ...extra], { encoding: 'utf8' });
        const firstRun = JSON.parse(run('--json', '--compare')) as { week: { turns: number }; days: unknown[]; compare: unknown };
        assert.equal(firstRun.week.turns, 6);
        assert.equal(firstRun.days.length, 3);
        assert.equal(firstRun.compare, null);
        const table = run('--compare');
        assert.match(table, /和上一次比/);
        assert.match(table, /\| 她的轮数 \| 6 \| 6 \| ±0 \|/);
        assert.doesNotMatch(table, new RegExp(SECRET));
        run('--no-log');
        assert.equal(readFileSync(metricsLogPath(dir), 'utf8').trim().split('\n').length, 2);
    });
});
