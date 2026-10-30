import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { FEELINGS_EXPORT_KIND, FEELINGS_REFRESH_MS, feelingsExportPath, writeFeelingsExport, type FeelingsExport } from '../src/emotion/feeling-export.ts';
import type { Felt } from '../src/emotion/feelings.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const tmp = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-feelings-')); dirs.push(dir); return dir; };
const NIGHT = new Date(2026, 9, 30, 23, 0, 0).getTime();
const felt = (kind: Felt['kind'], level: Felt['level'], cause: string, over: Partial<Felt> = {}): Felt => ({ kind, weight: level === 'strong' ? 2.5 : level === 'clear' ? 1.5 : 0.7, level, cause, source: 'world', aboutHim: false, ...over });
const read = (dir: string) => JSON.parse(readFileSync(feelingsExportPath(dir), 'utf8')) as FeelingsExport;

describe('写给桌面上的她的心境（FEELINGS.json）', () => {
    test('写出 kind / 生成时间 / 此刻的感受（只留明显以上、最多 4 条）/ 那一行；没有明显的感受就是 line: null', () => {
        const dir = tmp();
        const line = '[你此刻的心境（有来由的，不是演的）：很难过（高数小测没考好）。…]';
        assert.equal(writeFeelingsExport(dir, { at: NIGHT, felt: [felt('sad', 'strong', '高数小测没考好', { source: 'author' }), felt('worry', 'clear', '作业快到期了', { aboutHim: false }), felt('joy', 'faint', '猫出来蹭了')], line }), true);
        const file = read(dir);
        assert.equal(file.kind, FEELINGS_EXPORT_KIND);
        assert.equal(file.generatedAt, new Date(NIGHT).toISOString());
        assert.deepEqual(file.felt.map(item => [item.kind, item.level, item.cause, item.source]), [['sad', 'strong', '高数小测没考好', 'author'], ['worry', 'clear', '作业快到期了', 'world']]);
        assert.equal(file.line, line);
        // 这一刻没有明显的感受：明确写 null（告诉桌面「算过了，没有」，不是没算）
        writeFeelingsExport(dir, { at: NIGHT + 1, felt: [felt('joy', 'faint', '小事')], line: undefined });
        assert.deepEqual([read(dir).felt, read(dir).line], [[], null]);
        // 最多 4 条
        const five = (['sad', 'worry', 'joy', 'annoyed', 'tired'] as const).map(kind => felt(kind, 'clear', `${kind} 的来由`));
        writeFeelingsExport(dir, { at: NIGHT + 2, felt: five, line: 'x' });
        assert.equal(read(dir).felt.length, 4);
    });

    test('内容没变且时间戳新鲜（10 分钟内）不重写；超过 10 分钟刷新时间戳；内容变了马上写；坏文件 / 别人的文件直接覆盖；时钟回拨也重写', () => {
        const dir = tmp();
        const report = (at: number, line: string | undefined = 'L') => ({ at, felt: [felt('joy', 'clear', '相机到手了')], line });
        assert.equal(writeFeelingsExport(dir, report(NIGHT)), true);
        assert.equal(writeFeelingsExport(dir, report(NIGHT + 5 * 60_000)), false, '5 分钟后没变：不写');
        assert.equal(writeFeelingsExport(dir, report(NIGHT + FEELINGS_REFRESH_MS + 1000)), true, '超过 10 分钟：刷新时间戳');
        assert.equal(read(dir).generatedAt, new Date(NIGHT + FEELINGS_REFRESH_MS + 1000).toISOString());
        assert.equal(writeFeelingsExport(dir, report(NIGHT + FEELINGS_REFRESH_MS + 2000, 'L2')), true, '内容变了：马上写');
        writeFileSync(feelingsExportPath(dir), '{坏');
        assert.equal(writeFeelingsExport(dir, report(NIGHT + 3_600_000)), true);
        writeFileSync(feelingsExportPath(dir), JSON.stringify({ kind: 'other', line: 'x' }));
        assert.equal(writeFeelingsExport(dir, report(NIGHT + 3_700_000)), true);
        assert.equal(read(dir).kind, FEELINGS_EXPORT_KIND);
        writeFeelingsExport(dir, report(NIGHT + 10 * 3_600_000));
        assert.equal(writeFeelingsExport(dir, report(NIGHT)), true, '文件里的时间在未来：重写');
    });
});
