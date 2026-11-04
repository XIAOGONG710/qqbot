import assert from 'node:assert/strict';
import { test } from 'node:test';
import { askedWindow, asksPast } from '../src/life/people.ts';
import { formatDate, type Schedule } from '../src/life/schedule.ts';
import { needsAt, NEEDS_RULES_VERSION, type NeedsSnapshot } from '../src/life/needs.ts';
import type { LifeEvent } from '../src/world/life-events.ts';

const ask = (content: string, now = '2026-11-05T12:00:00+08:00') => askedWindow([{ role: 'user', content }], new Date(now));
for (const [content, now, expected] of [
    ['你上个月2号吃的啥', '2026-11-05T12:00:00+08:00', '2026-10-02'],
    ['你10月2日吃了什么', '2026-11-05T12:00:00+08:00', '2026-10-02'],
    ['你2026年10月2日吃了什么', '2026-11-05T12:00:00+08:00', '2026-10-02'],
    ['你去年10月2日吃了什么', '2026-11-05T12:00:00+08:00', '2025-10-02'],
    ['你前年10月2日吃了什么', '2026-11-05T12:00:00+08:00', '2024-10-02'],
    ['你今年10月2日吃了什么', '2026-11-05T12:00:00+08:00', '2026-10-02'],
    ['你上个月31号吃的啥', '2027-01-05T12:00:00+08:00', '2026-12-31'],
    ['你12月31号吃的啥', '2027-01-05T12:00:00+08:00', '2026-12-31'],
    ['你2024年2月29日吃了什么', '2027-01-05T12:00:00+08:00', '2024-02-29'],
    ['你2月29日吃了什么', '2025-03-05T12:00:00+08:00', '2024-02-29'],
] as const) test(`回忆日期保留年月语义：${content}`, () => {
    assert.equal(asksPast([{ role: 'user', content }]), true);
    assert.equal(formatDate(ask(content, now)!.start), expected);
});

test('无效月末与明确未来日期不回退成其他日期或整月', () => {
    for (const content of ['你2026年2月30日吃了什么', '你2027年2月1日吃了什么', '你今年12月31日吃了什么']) {
        assert.equal(ask(content), undefined, content);
    }
    assert.equal(ask('你上个月31号吃了什么', '2026-03-05T12:00:00+08:00'), undefined);
});

test('带作息的显式日期仍包含次日凌晨；裸日号和上周几保持既有语义', () => {
    const schedule = { sleep: '02:00' } as Schedule;
    const result = askedWindow([{ role: 'user', content: '你上个月2号晚上吃的啥' }], new Date('2026-11-05T12:00:00+08:00'), schedule)!;
    assert.equal(formatDate(result.start), '2026-10-02');
    assert.equal(result.end.getTime(), new Date('2026-10-03T02:00:00+08:00').getTime());
    assert.equal(formatDate(ask('你2号吃的啥')!.start), '2026-11-02');
    assert.equal(formatDate(ask('你上周三吃的啥')!.start), '2026-10-28');
});

const anchor: NeedsSnapshot = { at: '2026-11-05T00:00:00+08:00', energy: 68, hunger: 90, stress: 24 };
const at = (clock: string) => new Date(`2026-11-05T${clock}:00+08:00`);
const event = (id: string, start: string, end: string, kind = 'eat'): LifeEvent => ({
    id, actor: 'linmengyao', kind, day: '2026-11-05', startedAt: at(start).toISOString(), endedAt: at(end).toISOString(), source: 'simulation', result: 'succeeded',
});

test('同区间不同 ID 的饭仅按稳定优先级结算一次，输入顺序不影响结果', () => {
    const first = event('a', '04:00', '04:30'); const duplicate = { ...first, id: 'b' };
    const expected = needsAt(anchor, [first], at('05:00'));
    assert.equal(expected.hunger, 46.5);
    assert.deepEqual(needsAt(anchor, [duplicate, first], at('05:00')), expected);
    assert.deepEqual(needsAt(anchor, [first, duplicate], at('05:00')), expected);
});

test('部分重叠的低优先级饭不视为完整吃完；锚点后重新投影不忘记之前的冲突', () => {
    const first = event('a', '04:00', '04:30'); const partial = event('b', '04:15', '04:45');
    const events = [first, partial]; const end = at('05:00');
    const expected = needsAt(anchor, [first], end);
    assert.equal(needsAt(anchor, events, end).hunger, expected.hunger);
    for (const clock of ['04:10', '04:20', '04:30', '04:35', '04:45']) {
        const checkpoint = needsAt(anchor, events, at(clock));
        assert.deepEqual(needsAt(checkpoint, events, end), needsAt(anchor, events, end), clock);
    }
});

test('被其他高优先级活动覆盖的饭不结算，但相邻非重叠饭仍各结算一次', () => {
    const blocking = event('a', '04:00', '05:00', 'study'); const meal = event('b', '04:15', '04:45');
    assert.deepEqual(needsAt(anchor, [blocking, meal], at('05:00')), needsAt(anchor, [blocking], at('05:00')));
    const first = event('a', '04:00', '04:30'); const next = event('b', '04:30', '05:00');
    assert.equal(needsAt(anchor, [first, next], at('05:00')).hunger, 0);
});

test('失败或被打断的饭不结算，正常无重叠轨迹与既有规则版本不变', () => {
    assert.equal(NEEDS_RULES_VERSION, 'needs-v1');
    const first = event('a', '04:00', '04:30');
    for (const result of ['failed', 'interrupted'] as const) {
        const other = { ...event('b', '04:15', '04:45'), result };
        assert.equal(needsAt(anchor, [first, other], at('05:00')).hunger, 46.5);
    }
    assert.deepEqual(needsAt(anchor, [first], at('05:00')), { at: at('05:00').toISOString(), energy: 59, hunger: 46.5, stress: 23.5 });
});
