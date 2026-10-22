import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { weeklyReport, weeklyReportDue, weeklyReportName, writeWeeklyReport } from '../src/weekly-report.ts';

// ADR 0118：周报——只有数字，没有原话
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const SECRET = '独一无二的暗号九九八';
const now = new Date(2026, 10, 22, 22, 0).getTime();   // 周日 22:00
const at = (daysAgo: number, h: number, m = 0, s = 0) => new Date(new Date(2026, 10, 22 - daysAgo, h, m, s).getTime()).toISOString();

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-weekly-'));
    dirs.push(dir);
    for (const sub of ['chats', 'proactive', 'logs']) mkdirSync(join(dir, sub));
    const rows = [
        { time: at(2, 10, 0, 0), role: 'user', content: `早 ${SECRET}` },
        { time: at(2, 10, 0, 9), role: 'assistant', content: '早呀' },
        { time: at(2, 10, 0, 10), role: 'assistant', content: '睡得好吗' },
        { time: at(2, 12, 0, 0), role: 'user', content: '吃饭了' },
        { time: at(2, 12, 0, 30), role: 'assistant', content: '宝宝，刚吃完' },
        { time: at(1, 21, 0, 0), role: 'assistant', content: '宝宝，在忙吗' },
        { time: at(1, 21, 5, 0), role: 'user', content: '嗯' },
        { time: at(1, 21, 5, 8), role: 'assistant', content: '她发了张照片：土豆晒太阳' },
    ];
    writeFileSync(join(dir, 'chats', '10001.jsonl'), rows.map(r => JSON.stringify(r)).join('\n'));
    writeFileSync(join(dir, 'proactive', '10001-boyfriend.json'), JSON.stringify({
        records: [{ id: 'x', occasion: 'bedtime', plannedAt: at(1, 21, 0), at: at(1, 21, 0), result: 'sent' }, { id: 'y', occasion: 'share', plannedAt: at(3, 15, 0), at: at(3, 15, 0), result: 'skipped' }],
        inner: { thoughts: [{ id: 'th-1', at: at(1, 9, 0), text: `想起${SECRET}的事`, goes: 'keep' }] },
    }));
    writeFileSync(join(dir, 'logs', '2026-11-21.log'), ['[2026/11/21 10:00:00] 照片货架：收了一张 cat（abc）', '[2026/11/21 10:00:01] 陪玩：他们正一起打王者', '[2026/11/21 10:30:00] [10001] 回复失败：x'].join('\n'));
    return dir;
}

describe('周报', () => {
    test('有各个部分和数字；原话一个字都不出现（聊天、念头）', () => {
        const dir = fixture();
        const report = weeklyReport({ dataDir: dir, qq: 10001, tier: 'boyfriend', since: now - 7 * 86_400_000, now });
        for (const part of ['# 离真人还差多少', '## 说话的样子', '## 表情和语气', '## 主动性', '## 日志里数到的', '## 在不在（下限）']) assert.ok(report.includes(part), part);
        assert.match(report, /他 3 条、她 5 条/);
        assert.match(report, /照片 她发了 1 张/);
        assert.match(report, /主动发出 1 条/);
        assert.match(report, /念头 1 个/);
        assert.match(report, /照片·收进货架 1/);
        assert.match(report, /陪玩 1/);
        assert.match(report, /回复失败成 1 次断/);
        assert.ok(!report.includes(SECRET), '原话泄露');
        assert.ok(!report.includes('土豆晒太阳') && !report.includes('睡得好吗'), '她的话也不出现');
    });

    test('称呼开头：回话和她先开口分开数', () => {
        const report = weeklyReport({ dataDir: fixture(), qq: 10001, tier: 'boyfriend', since: now - 7 * 86_400_000, now });
        assert.match(report, /以昵称开头：回话 \d+%；她先开口 \d+%（\d+ 条/);
    });

    test('什么数据都没有也不崩', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-weekly-empty-'));
        dirs.push(dir);
        const report = weeklyReport({ dataDir: dir, qq: 1, tier: 'boyfriend', since: now - 86_400_000, now });
        assert.ok(report.includes('他 0 条、她 0 条') && report.includes('（没有主动消息记录）'));
    });
});

describe('什么时候出', () => {
    test('文件名按本周日；周日 21:30 以后、这周的还没有才该出；出了就不再出；别的日子不出', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-weekly-due-'));
        dirs.push(dir);
        assert.equal(weeklyReportName(new Date(2026, 10, 22, 22, 0)), 'weekly-2026-11-22.md');
        assert.equal(weeklyReportName(new Date(2026, 10, 24, 9, 0)), 'weekly-2026-11-22.md', '周二算 11-22 那一周');
        assert.equal(weeklyReportDue(new Date(2026, 10, 22, 21, 0), dir), false, '21:30 之前');
        assert.equal(weeklyReportDue(new Date(2026, 10, 23, 22, 0), dir), false, '周一');
        assert.equal(weeklyReportDue(new Date(2026, 10, 22, 21, 31), dir), true);
        const source = fixture();
        const file = writeWeeklyReport({ dataDir: source, qq: 10001, tier: 'boyfriend', since: now - 7 * 86_400_000, now, reportsDir: dir });
        assert.ok(existsSync(file) && file.endsWith('weekly-2026-11-22.md'));
        assert.ok(readFileSync(file, 'utf8').startsWith('# 离真人还差多少'));
        assert.equal(weeklyReportDue(new Date(2026, 10, 22, 23, 0), dir), false, '这周已经出过了');
    });
});
