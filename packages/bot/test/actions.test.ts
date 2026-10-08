import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { availableActions, judgeAction, typedOccupation } from '../src/actions.ts';
import type { LifeEvent } from '../src/life-events.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { worldAt } from '../src/world.ts';

const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = card.schedule!;
const books = card.books;
const at = (text: string) => new Date(`${text}+08:00`);
const context = (time: Date, events: LifeEvent[] = []) => ({ schedule, books, world: worldAt(card.herWorld!, schedule, time), events });

describe('类型化行动与世界裁判（ADR 0037）', () => {
    test('睡觉严格对上睡眠段，上课严格对上真实课程', () => {
        const sleep = judgeAction({ id: 'sleep', kind: 'sleep', startedAt: at('2026-10-09T02:00:00') }, context(at('2026-10-09T02:00:00')));
        assert.equal(sleep.ok, true);
        if (sleep.ok) assert.equal(sleep.event.at, at('2026-10-09T07:40:00').toISOString());
        assert.deepEqual(judgeAction({ id: 'late', kind: 'sleep', startedAt: at('2026-10-09T03:00:00') }, context(at('2026-10-09T03:00:00'))), {
            ok: false,
            event: { id: 'late', kind: 'sleep', startedAt: at('2026-10-09T03:00:00').toISOString(), at: at('2026-10-09T03:00:00').toISOString(), source: 'simulation', result: 'failed', reason: 'unavailable' },
            reason: 'unavailable',
        });

        const lesson = judgeAction({ id: 'class', kind: 'attend_class', startedAt: at('2026-10-09T08:20:00') }, context(at('2026-10-09T08:20:00')));
        assert.equal(lesson.ok, true);
        if (lesson.ok) assert.match(lesson.occupation, /^在上/);
        assert.equal(judgeAction({ id: 'holiday', kind: 'attend_class', startedAt: at('2026-10-03T09:00:00') }, context(at('2026-10-03T09:00:00'))).ok, false);
    });

    test('吃饭只接受世界里已有的一餐，不重复扣出第二顿', () => {
        const now = at('2026-10-12T12:05:00');
        const meal = context(now).world!.routine!.meals.find(item => item.kind === 'lunch')!;
        const first = judgeAction({ id: 'lunch', kind: 'eat', startedAt: meal.start }, context(meal.start));
        assert.equal(first.ok, true);
        if (!first.ok) return;
        const stored: LifeEvent = { ...first.event, actor: 'linmengyao', day: '2026-10-12', startedAt: first.event.startedAt!, endedAt: first.event.at };
        const repeated = judgeAction({ id: 'lunch-2', kind: 'eat', startedAt: meal.start }, context(meal.start, [stored]));
        assert.equal(repeated.ok, false);
        if (!repeated.ok) assert.equal(repeated.reason, 'already_done');
    });

    test('学习撞上硬边界会中断；短到不足最低时长就不开始', () => {
        const start = at('2026-10-12T16:50:00');
        const judged = judgeAction({ id: 'study', kind: 'study', startedAt: start, durationMinutes: 60 }, context(start));
        assert.equal(judged.ok, true);
        if (judged.ok) {
            assert.equal(judged.event.result, 'interrupted');
            assert.ok(judged.actualMinutes >= 25 && judged.actualMinutes < 60);
            assert.equal(judged.event.reason, 'interrupted_by_commitment');
        }
        const dinner = context(start).world!.routine!.meals.find(item => item.kind === 'dinner')!;
        const tooLate = new Date(dinner.start.getTime() - 10 * 60_000);
        const noTime = judgeAction({ id: 'study-late', kind: 'study', startedAt: tooLate }, context(tooLate));
        assert.equal(noTime.ok, false);
        if (!noTime.ok) assert.equal(noTime.reason, 'no_time');
    });

    test('已有自由动作占用同一时间，后来的动作失败', () => {
        const start = at('2026-10-12T14:00:00');
        const existing: LifeEvent = {
            id: 'reading', actor: 'linmengyao', kind: 'read_book', day: '2026-10-12',
            startedAt: start.toISOString(), endedAt: at('2026-10-12T14:30:00').toISOString(), source: 'simulation', result: 'succeeded', subject: books[0]!.id,
        };
        const verdict = judgeAction({ id: 'rest', kind: 'rest', startedAt: at('2026-10-12T14:10:00') }, context(at('2026-10-12T14:10:00'), [existing]));
        assert.equal(verdict.ok, false);
        if (!verdict.ok) assert.equal(verdict.reason, 'conflict');
    });

    test('读书必须对上仍在读的稳定书 ID；动作能转成状态行占用', () => {
        const start = at('2026-10-12T14:00:00');
        const missing = judgeAction({ id: 'none', kind: 'read_book', startedAt: start, subject: '不存在的书' }, context(start));
        assert.equal(missing.ok, false);
        const reading = books.find(book => book.progress.state === 'reading')!;
        const verdict = judgeAction({ id: 'read', kind: 'read_book', startedAt: start, subject: reading.id }, context(start));
        assert.equal(verdict.ok, true);
        if (!verdict.ok) return;
        const event: LifeEvent = { ...verdict.event, actor: 'linmengyao', day: '2026-10-12', startedAt: verdict.event.startedAt!, endedAt: verdict.event.at };
        assert.equal(typedOccupation(event, at('2026-10-12T14:10:00'), books), `在看《${reading.title}》`);
        assert.equal(typedOccupation(event, at('2026-10-12T14:31:00'), books), undefined);
    });

    test('选择器只给这一刻现实中能做的动作，同一输入结果一致', () => {
        const now = at('2026-10-12T14:00:00');
        const first = availableActions(now, context(now));
        assert.deepEqual(availableActions(now, context(now)), first);
        assert.ok(first.some(item => item.kind === 'study'));
        assert.ok(first.some(item => item.kind === 'rest'));
        assert.ok(first.some(item => item.kind === 'read_book'));
        assert.ok(!first.some(item => item.kind === 'sleep' || item.kind === 'eat' || item.kind === 'attend_class'));
    });
});
