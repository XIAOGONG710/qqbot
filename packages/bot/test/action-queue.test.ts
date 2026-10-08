import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { actionQueue } from '../src/action-queue.ts';
import type { LifeEventDraft } from '../src/life-events.ts';
import type { LifeEvent } from '../src/life-events.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { worldAt } from '../src/world.ts';

const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = card.schedule!;
const at = (text: string) => new Date(`${text}+08:00`);
const context = (time: Date) => ({ schedule, books: card.books, world: worldAt(card.herWorld!, schedule, time), events: [] });
const fakeLedger = (committed: LifeEventDraft[], fail = false) => ({
    recordEvents(events: readonly LifeEventDraft[]) {
        if (fail) throw new Error('disk full');
        committed.push(...events);
    },
    events: () => committed.map((event): LifeEvent => ({
        ...event, actor: 'linmengyao', day: '2026-10-12', startedAt: event.startedAt!, endedAt: event.at,
    })),
});

describe('可重放行动队列（ADR 0037）', () => {
    test('计划先落盘，到结束时才提交事件；重启能恢复，同一 id 不重复排', () => {
        const dir = mkdtempSync(join(tmpdir(), 'action-queue-'));
        const path = join(dir, 'queue.json');
        try {
            const start = at('2026-10-12T14:00:00');
            const queue = actionQueue(path);
            const first = queue.schedule({ id: 'rest-1', kind: 'rest', startedAt: start }, context(start));
            assert.equal(first.ok, true);
            queue.schedule({ id: 'rest-1', kind: 'rest', startedAt: start }, context(start));
            assert.equal(queue.pending().length, 1);
            assert.equal(JSON.parse(readFileSync(path, 'utf8')).items.length, 1);

            const resumed = actionQueue(path);
            const committed: LifeEventDraft[] = [];
            const ledger = fakeLedger(committed);
            assert.equal(resumed.settleDue(at('2026-10-12T14:29:00'), ledger), 0);
            assert.equal(committed.length, 0);
            assert.equal(resumed.settleDue(at('2026-10-12T14:30:00'), ledger), 1);
            assert.equal(committed[0]!.id, 'rest-1');
            assert.equal(resumed.pending().length, 0);
            assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')).items, []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('提交失败不确认，重启后仍用相同事件 id 重试', () => {
        const dir = mkdtempSync(join(tmpdir(), 'action-queue-'));
        const path = join(dir, 'queue.json');
        try {
            const start = at('2026-10-12T14:00:00');
            const queue = actionQueue(path);
            queue.schedule({ id: 'study-1', kind: 'study', startedAt: start, durationMinutes: 30 }, context(start));
            assert.throws(() => queue.settleDue(at('2026-10-12T15:00:00'), fakeLedger([], true)), /disk full/);
            assert.equal(queue.pending().length, 1);

            const resumed = actionQueue(path);
            const ids: string[] = [];
            const committed: LifeEventDraft[] = [];
            assert.equal(resumed.settleDue(at('2026-10-12T15:00:00'), fakeLedger(committed)), 1);
            ids.push(...committed.map(event => event.id));
            assert.deepEqual(ids, ['study-1']);
            assert.equal(resumed.pending().length, 0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('失败裁决立即返回但不进队列；语义损坏的项目重启时丢弃', () => {
        const dir = mkdtempSync(join(tmpdir(), 'action-queue-'));
        const path = join(dir, 'queue.json');
        try {
            const queue = actionQueue(path);
            const bad = queue.schedule({ id: 'bad-book', kind: 'read_book', startedAt: at('2026-10-12T14:00:00'), subject: '不存在' }, context(at('2026-10-12T14:00:00')));
            assert.equal(bad.ok, false);
            assert.equal(queue.pending().length, 0);
            // 文件可能还没创建；先排一条，再手工把 kind 改坏，验证语义过滤。
            queue.schedule({ id: 'rest', kind: 'rest', startedAt: at('2026-10-12T14:00:00') }, context(at('2026-10-12T14:00:00')));
            const disk = JSON.parse(readFileSync(path, 'utf8'));
            disk.items[0].kind = 'teleport';
            writeFileSync(path, JSON.stringify(disk));
            const logs: string[] = [];
            assert.equal(actionQueue(path, message => logs.push(message)).pending().length, 0);
            assert.match(logs.join('\n'), /忽略 1 条格式损坏的计划/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('提交函数没有把事实写进账本时不删队列', () => {
        const dir = mkdtempSync(join(tmpdir(), 'action-queue-'));
        const path = join(dir, 'queue.json');
        try {
            const start = at('2026-10-12T14:00:00');
            const queue = actionQueue(path);
            queue.schedule({ id: 'rest', kind: 'rest', startedAt: start }, context(start));
            assert.throws(() => queue.settleDue(at('2026-10-12T14:30:00'), { recordEvents: () => undefined, events: () => [] }), /未写入事件账/);
            assert.equal(actionQueue(path).pending().length, 1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
