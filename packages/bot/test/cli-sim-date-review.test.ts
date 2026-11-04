import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { weeklyReport, weeklyReportName } from '../src/platform/weekly-report.ts';
import { proactiveChecks, type StepRecord } from '../src/sim/runner.ts';
import type { TierCard } from '../src/platform/contact.ts';
import type { Schedule } from '../src/life/schedule.ts';

test('周报低年份文件名使用真实周日和四位日历年', () => {
    assert.equal(weeklyReportName(new Date('0099-11-05T12:00:00')), 'weekly-0099-11-01.md');
    assert.equal(weeklyReportName(new Date('2026-11-24T12:00:00')), 'weekly-2026-11-22.md');
});

test('周报日志起始筛选不把低年份的旧行映射到未来', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-report-calendar-'));
    try {
        mkdirSync(join(dir, 'logs'));
        writeFileSync(join(dir, 'logs', '0099-11-01.log'), '[0099/11/01 09:00:00] 心境：合成旧行\n[0099/11/01 13:00:00] 心境：合成新行\n');
        const report = weeklyReport({ dataDir: dir, qq: 1, tier: 'test', since: new Date('0099-11-01T12:00:00').getTime(), now: new Date('0099-11-02T12:00:00').getTime() });
        assert.match(report, /心境 1\n/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('模拟器低年凌晨主动消息仍受夜间时段限制', () => {
    const schedule: Schedule = { sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: '1' }, periods: { '1': { start: '08:20', end: '09:50' } },
        semester: { start: '0099-11-01', weeks: 20 }, holidays: [], makeups: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} }, courses: [],
        free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '合成地点' };
    const time = new Date('0099-11-05T01:00:00').getTime();
    const steps = [{ bubbles: [{ time, text: '合成消息', proactive: '合成时机' }] }] as StepRecord[];
    const results = proactiveChecks({ allowedTimes: true }, steps, { character: { schedule } } as TierCard);
    assert.equal(results.length, 1); assert.equal(results[0]!.ok, false);
});

for (const kind of ['asks', 'presence']) test(`${kind} 预览把低年 CLI 参数传给实际预览时钟`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-preview-calendar-'));
    const entry = new URL(`../src/sim/${kind}-preview.ts`, import.meta.url).href;
    const bootstrap = `import { registerHooks } from 'node:module';
        const check = at => { if (new Date(at).getFullYear() !== 99) throw new Error('preview date shifted'); };
        registerHooks({ load(url, context, next) {
            let source;
            if (url.endsWith('/st/card.ts')) source = 'export const loadCharacterCard = () => ({ schedule: {}, herWorld: {} });';
            if (url.endsWith('/world/world.ts')) source = 'export function worldAt(w, s, at) { (' + check.toString() + ')(at); return { dates: [] }; }';
            if (url.endsWith('/social/presence.ts')) source = 'export function createPresence(options) { (' + check.toString() + ')(options.now()); return { tick: async () => {} }; }';
            if (url.endsWith('/bilibili/bilibili.ts')) source = 'export function createVideoBrowsing(options) { (' + check.toString() + ')(options.now()); return { tick: async () => {} }; }';
            return source === undefined ? next(url, context) : { format: 'module', source, shortCircuit: true };
        }});
        process.argv = ['node', 'preview', '0099-11-05', '1'];
        await import(${JSON.stringify(entry)});`;
    try {
        const file = join(dir, 'bootstrap.mjs'); writeFileSync(file, bootstrap);
        const result = spawnSync(process.execPath, [file], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, TZ: 'Asia/Shanghai' } });
        assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /0099-11-05/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
});
