import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { classesOn } from '../src/life/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { worldAt, type FriendDate } from '../src/world/world.ts';
import { syntheticCardPath } from './fixtures/card.ts';

// 闺蜜的约（ADR 0061）过一整个学期：走世界层（线上开着 npcAsks 时的那条路），每天 23:00 看一次，把两个月里的约收齐，检查跨天、跨人的界。
const card = loadCharacterCard(syntheticCardPath('boyfriend'));
const schedule = card.schedule!;
const world = { ...card.herWorld!, asks: true };

describe('闺蜜的约：一个学期的审计（ADR 0061）', () => {
    test('11、12 月：每月约 7 次；答应了的约彼此不重叠、不撞课；改约和迟到不晚过 22:30；约的人是两位闺蜜', () => {
        const from = new Date(2026, 10, 1);
        const days = 61;
        const seen = new Map<string, FriendDate>();
        for (let i = -1; i <= days; i++) {
            for (const date of worldAt(world, schedule, new Date(2026, 10, 1 + i, 23))?.dates ?? []) seen.set(date.id, date);
        }
        const dates = [...seen.values()].filter(x => x.start >= from && x.start < new Date(2027, 0, 1)).sort((a, b) => a.start.getTime() - b.start.getTime());
        const month = (x: FriendDate) => `${x.start.getFullYear()}-${String(x.start.getMonth() + 1).padStart(2, '0')}`;
        const perMonth = new Map<string, number>();
        for (const x of dates) perMonth.set(month(x), (perMonth.get(month(x)) ?? 0) + 1);
        assert.deepEqual([...perMonth.keys()].sort(), ['2026-11', '2026-12']);
        assert.ok([...perMonth.values()].every(n => n >= 5 && n <= 9), JSON.stringify([...perMonth]));
        assert.deepEqual([...new Set(dates.map(x => x.person.id))].sort(), ['chen_jianing', 'su_yutong']);

        const window = (x: FriendDate) => { const start = x.actualStart ?? x.start; return { start, end: new Date(start.getTime() + x.minutes * 60_000) }; };
        const accepted = dates.filter(x => x.outcome !== 'cancelled' && !x.declined);
        for (let i = 0; i < accepted.length; i++) {
            const a = window(accepted[i]!);
            assert.ok(a.end.getHours() * 60 + a.end.getMinutes() <= 22 * 60 + 30 + 25, `${accepted[i]!.id} 结束得太晚`);
            const { lessons } = classesOn(schedule, new Date(a.start.getFullYear(), a.start.getMonth(), a.start.getDate()));
            assert.ok(!lessons.some(l => l.start < a.end && a.start < l.end), `${accepted[i]!.id} 撞课`);
            for (let j = i + 1; j < accepted.length; j++) {
                const b = window(accepted[j]!);
                assert.ok(!(a.start < b.end && b.start < a.end), `${accepted[i]!.id} 和 ${accepted[j]!.id} 重叠`);
            }
        }
        const outcomes = new Set(dates.map(x => x.outcome));
        assert.ok(outcomes.has('on_time') && outcomes.size >= 3, `结果种类太少：${[...outcomes]}`);
    });
});
