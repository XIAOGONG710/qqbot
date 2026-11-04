import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { checkSource, readSource } from '../src/source.ts';

const source = readSource(resolve(import.meta.dirname, '../../../characters/linmengyao/source'));

test('源课表日期拒绝不存在的日历日，覆盖学期、假期、调休、起床与活动生效边界', () => {
    const edits = [
        (s: typeof source.schedule) => { s.semester.start = '2026-02-30'; },
        (s: typeof source.schedule) => { s.holidays = [{ name: '合成假期', start: '2026-02-30', end: '2026-03-01' }]; },
        (s: typeof source.schedule) => { s.holidays = [{ name: '合成假期', start: '2026-02-01', end: '2026-02-30' }]; },
        (s: typeof source.schedule) => { s.makeups = [{ date: '2026-02-30', as_day: 1 }]; },
        (s: typeof source.schedule) => { s.wakeup.jitter = { from: '2026-02-30', spread_minutes: 0, weekend_minutes: 0 }; },
        (s: typeof source.schedule) => { s.free = [{ window: 'morning', text: '合成活动', from: '2026-02-30' }]; },
        (s: typeof source.schedule) => { s.free = [{ window: 'morning', text: '合成活动', from: '2026-02-01', until: '2026-02-30' }]; },
    ];
    for (const edit of edits) {
        const bad = structuredClone(source); edit(bad.schedule);
        assert.throws(() => checkSource(bad), /schedule.yml.*日期/);
    }
});

test('源课表仍接受四位低年份、真实闰日与现代日期', () => {
    for (const start of ['0000-02-29', '0099-12-31', '0100-01-01', '2000-02-29', '2026-11-05', '9999-12-31']) {
        const valid = structuredClone(source); valid.schedule.semester.start = start;
        assert.equal(checkSource(valid).schedule.semester.start, start);
    }
});

test('坏源日期错误只标记字段，不回显误填的私密正文', () => {
    const marker = 'SYNTHETIC_PRIVATE_DATE_TEXT';
    const bad = structuredClone(source); bad.schedule.semester.start = marker;
    assert.throws(() => checkSource(bad), error => error instanceof Error && error.message.includes('semester.start') && !error.message.includes(marker));
});
