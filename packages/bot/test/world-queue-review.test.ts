import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { actionQueue, type Ledger } from '../src/world/action-queue.ts';
import { fileOps } from '../src/memory/json-file.ts';
import type { LifeEvent } from '../src/world/life-events.ts';
import type { Schedule } from '../src/life/schedule.ts';

const dirs: string[] = [];
const originalWrite = fileOps.writeFileSync;
afterEach(() => { fileOps.writeFileSync = originalWrite; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const schedule: Schedule = {
    sleep: '02:00', wake: { early: '07:40', lazy: '09:30', earlySlot: 'one' },
    periods: { one: { start: '08:20', end: '09:50' } }, semester: { start: '2026-09-07', weeks: 20 },
    holidays: [], makeups: [], courses: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} },
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '13:00', eveningFrom: '18:00' }, where: '宿舍',
};
const at = (clock: string) => new Date(`2026-11-05T${clock}:00+08:00`);
const context = { schedule, events: [] };
const intent = { id: 'rest', kind: 'rest' as const, startedAt: at('14:00'), durationMinutes: 30 };
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'world-queue-review-')); dirs.push(dir); return join(dir, 'queue.json'); };
const failWrites = (path: string) => { fileOps.writeFileSync = ((file, ...args) => {
    if (String(file).startsWith(path)) throw new Error('SYNTHETIC_QUEUE_WRITE_FAILURE');
    return originalWrite(file, ...args);
}) as typeof fileOps.writeFileSync; };

test('首次排队写盘失败不发布内存假成功，同 ID 重试确实落盘且可重启恢复', () => {
    const path = fixture(); const queue = actionQueue(path);
    failWrites(path);
    assert.throws(() => queue.schedule(intent, context), /SYNTHETIC_QUEUE_WRITE_FAILURE/);
    assert.deepEqual(queue.pending(), []);
    fileOps.writeFileSync = originalWrite;
    assert.equal(queue.schedule(intent, context).ok, true);
    assert.equal(actionQueue(path).pending()[0]!.id, 'rest');
});

for (const operation of ['reschedule', 'cancel', 'shorten', 'drop'] as const) {
    test(`${operation} 写盘失败保持内存和磁盘一致，恢复后可重试`, () => {
        const path = fixture(); const queue = actionQueue(path); queue.schedule(intent, context);
        const before = structuredClone(queue.pending()); const disk = readFileSync(path, 'utf8');
        const mutate = () => operation === 'reschedule' ? queue.reschedule('rest', at('13:00'), { startedAt: at('15:00') }, context)
            : operation === 'cancel' ? queue.cancel('rest', at('14:10'), '合成取消')
                : operation === 'shorten' ? queue.shorten('rest', at('14:10'), '合成提前停') : queue.drop('rest', '合成删除');
        failWrites(path);
        assert.throws(mutate, /SYNTHETIC_QUEUE_WRITE_FAILURE/);
        assert.deepEqual(queue.pending(), before);
        assert.equal(readFileSync(path, 'utf8'), disk);
        fileOps.writeFileSync = originalWrite;
        assert.ok(mutate());
        assert.deepEqual(queue.pending(), actionQueue(path).pending());
    });
}

test('事实已提交但队列清理失败时保留计划重试，不抛出也不重复事实', () => {
    const path = fixture(); const queue = actionQueue(path); queue.schedule(intent, context);
    const events = new Map<string, LifeEvent>();
    const ledger: Ledger = { recordEvents(drafts) {
        for (const draft of drafts) if (!events.has(draft.id)) events.set(draft.id, { ...draft, actor: 'linmengyao', day: '2026-11-05', startedAt: draft.startedAt!, endedAt: draft.at });
    }, events: () => [...events.values()] };
    failWrites(path);
    assert.equal(queue.settleDue(at('15:00'), ledger), 0);
    assert.equal(events.size, 1);
    assert.equal(queue.pending().length, 1);
    fileOps.writeFileSync = originalWrite;
    assert.equal(queue.settleDue(at('15:00'), ledger), 1);
    assert.equal(events.size, 1);
    assert.deepEqual(actionQueue(path).pending(), []);
});

test('死信转移写盘失败不丢待结算项或先发布死信，恢复后只转移一次', () => {
    const path = fixture(); const queue = actionQueue(path); queue.schedule(intent, context);
    const ledger: Ledger = { recordEvents: () => {}, events: () => [] };
    failWrites(path);
    assert.equal(queue.settleDue(at('15:00'), ledger), 0);
    assert.equal(queue.pending().length, 1);
    assert.deepEqual(queue.dead(), []);
    fileOps.writeFileSync = originalWrite;
    assert.equal(queue.settleDue(at('15:00'), ledger), 0);
    assert.deepEqual(queue.pending(), []);
    assert.equal(actionQueue(path).dead().length, 1);
});

test('提交后读取事实账失败仍保留队列，恢复后确认并清理', () => {
    const path = fixture(); const queue = actionQueue(path); queue.schedule(intent, context);
    assert.equal(queue.settleDue(at('15:00'), { recordEvents: () => {}, events: () => { throw new Error('synthetic read failure'); } }), 0);
    assert.equal(queue.pending().length, 1);
    assert.equal(actionQueue(path).pending().length, 1);
});
