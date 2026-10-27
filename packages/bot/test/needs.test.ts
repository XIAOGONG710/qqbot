import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { LifeEvent } from '../src/world/life-events.ts';
import { loadNeedsAnchor, needsAt, NEEDS_RULES_VERSION, type NeedsSnapshot } from '../src/needs.ts';

const anchor: NeedsSnapshot = { at: '2026-10-01T00:00:00.000Z', energy: 68, hunger: 35, stress: 24 };

function event(id: string, kind: string, start: string, end: string, result: LifeEvent['result'] = 'succeeded'): LifeEvent {
    return {
        id, actor: 'linmengyao', kind, day: start.slice(0, 10), startedAt: start, endedAt: end,
        source: 'simulation', result,
    };
}

describe('连续需要投影（ADR 0045）', () => {
    test('睡觉恢复精力和压力，学习消耗，吃完饭才降低饥饿', () => {
        const events = [
            event('sleep', 'sleep', '2026-10-01T00:00:00.000Z', '2026-10-01T08:00:00.000Z'),
            event('class', 'attend_class', '2026-10-01T08:00:00.000Z', '2026-10-01T11:30:00.000Z'),
            event('lunch', 'eat', '2026-10-01T12:00:00.000Z', '2026-10-01T12:30:00.000Z'),
            event('study', 'study', '2026-10-01T13:00:00.000Z', '2026-10-01T15:00:00.000Z'),
        ];
        const woke = needsAt(anchor, events, new Date('2026-10-01T08:00:00.000Z'));
        assert.equal(woke.energy, 100);
        assert.ok(woke.stress < anchor.stress);
        const beforeLunch = needsAt(anchor, events, new Date('2026-10-01T12:29:00.000Z'));
        const afterLunch = needsAt(anchor, events, new Date('2026-10-01T12:30:00.000Z'));
        assert.ok(afterLunch.hunger < beforeLunch.hunger - 50);
        const afterStudy = needsAt(anchor, events, new Date('2026-10-01T15:00:00.000Z'));
        assert.ok(afterStudy.energy < afterLunch.energy);
        assert.ok(afterStudy.stress > afterLunch.stress);
    });

    test('失败行动没有身体后果；重复事件 ID 不会让一顿饭吃两遍', () => {
        const meal = event('meal', 'eat', '2026-10-01T04:00:00.000Z', '2026-10-01T04:30:00.000Z');
        const failedSleep = event('failed-sleep', 'sleep', '2026-10-01T00:00:00.000Z', '2026-10-01T04:00:00.000Z', 'failed');
        assert.deepEqual(
            needsAt(anchor, [meal, meal, failedSleep], new Date('2026-10-01T05:00:00.000Z')),
            needsAt(anchor, [meal], new Date('2026-10-01T05:00:00.000Z')),
        );
        const interrupted = event('interrupted-meal', 'eat', '2026-10-01T06:00:00.000Z', '2026-10-01T06:10:00.000Z', 'interrupted');
        const withInterrupted = needsAt(anchor, [interrupted], new Date('2026-10-01T07:00:00.000Z'));
        const noMeal = needsAt(anchor, [], new Date('2026-10-01T07:00:00.000Z'));
        assert.equal(withInterrupted.hunger, noMeal.hunger, '饭被打断，不能当作已经吃饱');
    });

    test('出去吃饭的赴约在完成后也会结算饱腹', () => {
        const dinner = { ...event('meet-dinner', 'meet', '2026-10-01T10:00:00.000Z', '2026-10-01T11:30:00.000Z'), meal: true };
        const social = event('meet-show', 'meet', '2026-10-01T10:00:00.000Z', '2026-10-01T11:30:00.000Z');
        const afterDinner = needsAt(anchor, [dinner], new Date('2026-10-01T11:30:00.000Z'));
        const afterShow = needsAt(anchor, [social], new Date('2026-10-01T11:30:00.000Z'));
        assert.ok(afterDinner.hunger < afterShow.hunger - 50);
    });

    test('同一段生活一次推完和中途重启后接着推，结果一致', () => {
        const events = fortnight();
        const middle = new Date('2026-10-08T00:00:00.000Z');
        const end = new Date('2026-10-15T00:00:00.000Z');
        const direct = needsAt(anchor, events, end);
        const resumed = needsAt(needsAt(anchor, events, middle), events, end);
        assert.deepEqual(resumed, direct);
    });

    test('14 天每 6 小时取样：三个值始终有界，也不是每天瞬间复原成固定值', () => {
        const events = fortnight();
        const samples: NeedsSnapshot[] = [];
        for (let hours = 0; hours <= 14 * 24; hours += 6) {
            samples.push(needsAt(anchor, events, new Date(Date.parse(anchor.at) + hours * 3_600_000)));
        }
        for (const sample of samples) {
            for (const value of [sample.energy, sample.hunger, sample.stress]) assert.ok(value >= 0 && value <= 100, JSON.stringify(sample));
        }
        assert.ok(new Set(samples.map(item => item.energy)).size > 8);
        assert.ok(new Set(samples.map(item => item.hunger)).size > 8);
        assert.ok(new Set(samples.map(item => item.stress)).size > 8);
        for (const key of ['energy', 'hunger', 'stress'] as const) {
            const pinned = samples.filter(item => item[key] === 0 || item[key] === 100).length;
            assert.ok(pinned < samples.length * 0.7, `${key} 长时间钉在边界：${pinned}/${samples.length}`);
        }
        const midnights = samples.filter((_, index) => index % 4 === 0).map(item => [item.energy, item.hunger, item.stress].join('/'));
        assert.ok(new Set(midnights).size > 4, '不能每天零点重置成同一组三个值');
        assert.deepEqual(needsAt(anchor, events, new Date('2026-10-15T00:00:00.000Z')), needsAt(anchor, events, new Date('2026-10-15T00:00:00.000Z')));
    });

    test('只允许从锚点向未来投影', () => {
        assert.throws(() => needsAt(anchor, [], new Date('2026-09-30T23:59:59.000Z')), /不能早于锚点/);
    });

    test('锚点落盘并跨重启复用；规则版本变化时不偷偷重算历史', () => {
        const dir = mkdtempSync(join(tmpdir(), 'needs-anchor-'));
        const path = join(dir, 'needs-anchor.json');
        try {
            const firstAt = new Date('2026-10-01T00:00:00.000Z');
            const first = loadNeedsAnchor(path, firstAt);
            assert.equal(first.at, firstAt.toISOString());
            assert.equal(JSON.parse(readFileSync(path, 'utf8')).rulesVersion, NEEDS_RULES_VERSION);
            assert.deepEqual(loadNeedsAnchor(path, new Date('2026-10-08T00:00:00.000Z')), first);

            writeFileSync(path, JSON.stringify({ version: 1, rulesVersion: 'needs-v0', anchor: first }));
            assert.throws(() => loadNeedsAnchor(path, new Date('2026-10-08T00:00:00.000Z')), /必须先迁移锚点/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('已有锚点字段损坏时失败关闭，不拿当前时刻偷偷重建', () => {
        const dir = mkdtempSync(join(tmpdir(), 'needs-anchor-schema-'));
        const path = join(dir, 'needs-anchor.json');
        try {
            writeFileSync(path, JSON.stringify({ version: 1, rulesVersion: NEEDS_RULES_VERSION, anchor: { at: 'bad', energy: 50, hunger: 50, stress: 50 } }));
            assert.throws(() => loadNeedsAnchor(path, new Date('2026-10-08T00:00:00.000Z')), /需要锚点.*schema.*拒绝启动/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

/** 两周的确定性行动账：睡眠、两餐、课程 / 学习、休息和摄影交错。 */
function fortnight(): LifeEvent[] {
    const events: LifeEvent[] = [];
    const base = Date.parse(anchor.at);
    const iso = (day: number, hour: number, minute = 0) => new Date(base + (day * 24 * 60 + hour * 60 + minute) * 60_000).toISOString();
    for (let day = 0; day < 14; day++) {
        events.push(event(`sleep-${day}`, 'sleep', iso(day, 0), iso(day, 8)));
        if (day % 2 === 0) events.push(event(`class-${day}`, 'attend_class', iso(day, 8), iso(day, 11, 30)));
        events.push(event(`lunch-${day}`, 'eat', iso(day, 12), iso(day, 12, 30)));
        events.push(event(`dinner-${day}`, 'eat', iso(day, 18), iso(day, 18, 30)));
        if (day % 3 === 0) events.push(event(`photo-${day}`, 'work_on_project', iso(day, 14), iso(day, 16)));
        else events.push(event(`study-${day}`, 'study', iso(day, 14), iso(day, 16)));
        events.push(event(`rest-${day}`, day % 2 ? 'interact_npc' : 'leisure', iso(day, 20), iso(day, 22)));
    }
    return events;
}
