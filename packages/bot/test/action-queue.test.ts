import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { actionQueue, MAX_DEAD_ACTIONS, settlingWorld } from '../src/world/action-queue.ts';
import type { LifeEventDraft } from '../src/world/life-events.ts';
import type { LifeEvent } from '../src/world/life-events.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { worldAt, worldState } from '../src/world/world.ts';

const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = card.schedule!;
const at = (text: string) => new Date(`${text}+08:00`);
const context = (time: Date) => ({ schedule, books: card.books, world: worldAt(card.herWorld!, schedule, time), events: [] });
const reading = () => card.books.find(book => book.progress.state === 'reading')!.id;
const fakeLedger = (committed: LifeEventDraft[], fail = false) => ({
    recordEvents(events: readonly LifeEventDraft[]) {
        if (fail) throw new Error('disk full');
        committed.push(...events);
    },
    events: () => committed.map((event): LifeEvent => ({
        ...event, actor: 'linmengyao', day: '2026-10-12', startedAt: event.startedAt!, endedAt: event.at,
    })),
});
const withDir = (run: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), 'action-queue-'));
    try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

describe('可重放行动队列（ADR 0037、0038）', () => {
    test('未知版本失败关闭；没有版本的旧容器显式迁移为 v1', () => {
        const dir = mkdtempSync(join(tmpdir(), 'action-queue-schema-'));
        const path = join(dir, 'queue.json');
        try {
            writeFileSync(path, JSON.stringify({ version: 2, items: [] }));
            assert.throws(() => actionQueue(path), /行动队列.*schema.*拒绝启动/);
            writeFileSync(path, JSON.stringify({ items: [] }));
            assert.deepEqual(actionQueue(path).pending(), []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('计划先落盘，到结束时才提交事件；重启能恢复，同一 id 不重复排', () => withDir(dir => {
        const path = join(dir, 'queue.json');
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
    }));

    test('写账抛错不往外抛，留着下次再试；重启后仍用相同事件 id', () => withDir(dir => {
        const path = join(dir, 'queue.json');
        const start = at('2026-10-12T14:00:00');
        const logs: string[] = [];
        const queue = actionQueue(path, message => logs.push(message));
        queue.schedule({ id: 'study-1', kind: 'study', startedAt: start, durationMinutes: 30 }, context(start));
        // 读世界之前会结算（settlingWorld），抛出去这一轮就挂了
        assert.equal(queue.settleDue(at('2026-10-12T15:00:00'), fakeLedger([], true)), 0);
        assert.equal(queue.pending().length, 1);
        assert.match(logs.join('\n'), /写事件账失败，下次再试：disk full/);

        const resumed = actionQueue(path);
        const committed: LifeEventDraft[] = [];
        assert.equal(resumed.settleDue(at('2026-10-12T15:00:00'), fakeLedger(committed)), 1);
        assert.deepEqual(committed.map(event => event.id), ['study-1']);
        assert.equal(resumed.pending().length, 0);
    }));

    test('失败裁决立即返回但不进队列；语义损坏的项目重启时丢弃', () => withDir(dir => {
        const path = join(dir, 'queue.json');
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
    }));

    test('事件账没收的挪到死信区，不堵后面的；重启后死信还在（DSH 行动复核 1.2：原来每次都抛同一个错）', () => withDir(dir => {
        const path = join(dir, 'queue.json');
        const start = at('2026-10-12T14:00:00');
        const logs: string[] = [];
        const queue = actionQueue(path, message => logs.push(message));
        queue.schedule({ id: 'rest', kind: 'rest', startedAt: start }, context(start));
        queue.schedule({ id: 'read', kind: 'read_book', startedAt: at('2026-10-12T14:40:00'), subject: reading() }, context(start));
        // 账本不收 rest（world.ts append 遇到不合格的草稿是静默跳过的），收 read
        const committed: LifeEventDraft[] = [];
        const picky = fakeLedger(committed);
        const ledger = { recordEvents: (events: readonly LifeEventDraft[]) => picky.recordEvents(events.filter(event => event.id !== 'rest')), events: picky.events };
        assert.equal(queue.settleDue(at('2026-10-12T16:00:00'), ledger), 1);
        assert.deepEqual(committed.map(event => event.id), ['read']);
        assert.equal(queue.pending().length, 0);
        assert.deepEqual(queue.dead().map(item => [item.id, item.why]), [['rest', '事件账没收']]);
        assert.match(logs.join('\n'), /rest（rest）事件账没收，挪到死信区/);
        assert.equal(actionQueue(path).dead().length, 1);
        assert.equal(queue.settleDue(at('2026-10-12T17:00:00'), ledger), 0, '死信不再重试');
    }));

    test('死信只保留最近固定数量，避免行动队列状态无限膨胀', () => withDir(dir => {
        const path = join(dir, 'queue.json');
        const seed = actionQueue(path);
        const start = at('2026-10-12T14:00:00');
        seed.schedule({ id: 'template', kind: 'rest', startedAt: start }, context(start));
        const template = JSON.parse(readFileSync(path, 'utf8')).items[0];
        const dead = Array.from({ length: MAX_DEAD_ACTIONS + 5 }, (_, index) => ({
            ...template,
            id: `dead-${String(index).padStart(3, '0')}`,
            event: { ...template.event, id: `dead-${String(index).padStart(3, '0')}` },
            deadAt: new Date(start.getTime() + index * 1000).toISOString(),
            why: '事件账没收',
        }));
        writeFileSync(path, JSON.stringify({ version: 1, items: [], dead }));
        const queue = actionQueue(path);
        assert.equal(queue.dead().length, MAX_DEAD_ACTIONS);
        assert.equal(queue.dead()[0]!.id, 'dead-005');
        assert.equal(queue.schedule({ id: 'live', kind: 'rest', startedAt: start }, context(start)).ok, true);
        assert.equal(JSON.parse(readFileSync(path, 'utf8')).dead.length, MAX_DEAD_ACTIONS);
    }));

    test('排队时队列里还没结算的计划也算占用：撞在计划中间的不行，撞到后面计划的提前停（DSH 行动复核 1.1）', () => withDir(dir => {
        const queue = actionQueue(join(dir, 'queue.json'));
        const start = at('2026-10-12T14:00:00');
        assert.equal(queue.schedule({ id: 'rest', kind: 'rest', startedAt: start, durationMinutes: 30 }, context(start)).ok, true);
        const inside = queue.schedule({ id: 'study-in', kind: 'study', startedAt: at('2026-10-12T14:15:00') }, context(start));
        assert.equal(inside.ok, false);
        if (!inside.ok) assert.equal(inside.reason, 'conflict');
        const before = queue.schedule({ id: 'study-before', kind: 'study', startedAt: at('2026-10-12T13:20:00'), durationMinutes: 60 }, context(at('2026-10-12T13:20:00')));
        assert.equal(before.ok, true);
        if (before.ok) {
            assert.equal(before.event.at, start.toISOString(), '到 14:00 那条计划开始就停');
            assert.equal(before.event.result, 'interrupted');
        }
        // 同一顿饭排两次：第二次算做过了
        const meal = context(start).world!.routine!.meals.find(item => item.kind === 'dinner')!;
        assert.equal(queue.schedule({ id: 'dinner', kind: 'eat', startedAt: meal.start }, context(meal.start)).ok, true);
        assert.equal(queue.schedule({ id: 'dinner-2', kind: 'eat', startedAt: meal.start }, context(meal.start)).ok, false);
        assert.equal(queue.pending().length, 3);
    }));

    test('取消：没开始的记成没做成，开始了的在那一刻打断；做完了的取消不了；落账照常（DSH 行动复核 1.3）', () => withDir(dir => {
        const queue = actionQueue(join(dir, 'queue.json'));
        const start = at('2026-10-12T14:00:00');
        queue.schedule({ id: 'study', kind: 'study', startedAt: start, durationMinutes: 60, subject: '图书馆' }, context(start));
        queue.schedule({ id: 'read', kind: 'read_book', startedAt: at('2026-10-12T16:40:00'), subject: reading() }, context(start));
        const rained = queue.cancel('read', at('2026-10-12T13:30:00'), '下雨了');
        assert.equal(rained?.event.result, 'failed');
        assert.equal(rained?.event.reason, '取消：下雨了');
        assert.equal(rained?.event.at, at('2026-10-12T13:30:00').toISOString());
        const sick = queue.cancel('study', at('2026-10-12T14:20:00'), '肚子疼');
        assert.equal(sick?.event.result, 'interrupted');
        assert.equal(sick?.event.reason, '打断：肚子疼');
        assert.equal(sick?.actualMinutes, 20);
        assert.equal(queue.cancel('study', at('2026-10-12T14:25:00'), '又一次'), undefined, '打断过的不再打断');
        assert.equal(queue.cancel('nope', at('2026-10-12T14:30:00'), 'x'), undefined);
        // 取消之后那段时间空出来了，可以排别的
        assert.equal(queue.schedule({ id: 'rest', kind: 'rest', startedAt: at('2026-10-12T16:40:00') }, context(start)).ok, true);
        const committed: LifeEventDraft[] = [];
        assert.equal(queue.settleDue(at('2026-10-12T17:20:00'), fakeLedger(committed)), 3);
        assert.deepEqual(committed.map(event => [event.id, event.result]), [['read', 'failed'], ['study', 'interrupted'], ['rest', 'succeeded']]);
        // 做完了的取消不了
        queue.schedule({ id: 'late', kind: 'rest', startedAt: at('2026-10-12T20:00:00') }, context(at('2026-10-12T20:00:00')));
        assert.equal(queue.cancel('late', at('2026-10-12T20:30:00'), '晚了'), undefined);
    }));

    test('提前停、去掉（ADR 0042）：开始了的停在那一刻算做完，原来被课打断的原因去掉；去掉的不进事件账；重启后照样', () => withDir(dir => {
        const path = join(dir, 'queue.json');
        const queue = actionQueue(path);
        const start = at('2026-10-12T12:35:00');
        const game = queue.schedule({ id: 'game', kind: 'leisure', startedAt: start, subject: '打独立游戏', durationMinutes: 240 }, context(start));
        assert.ok(game.ok && game.event.reason === 'interrupted_by_class');
        assert.equal(queue.shorten('game', start, 'x'), undefined, '还没开始的不能提前停');
        assert.equal(queue.shorten('game', at('2026-10-12T15:15:00'), 'x'), undefined, '结束了的不能');
        const short = queue.shorten('game', at('2026-10-12T13:05:00'), '下楼喂土豆');
        assert.deepEqual([short?.event.at, short?.event.result, short?.event.reason, short?.actualMinutes], [at('2026-10-12T13:05:00').toISOString(), 'succeeded', undefined, 30]);
        queue.schedule({ id: 'rest', kind: 'rest', startedAt: at('2026-10-12T13:10:00'), durationMinutes: 30 }, context(start));
        assert.equal(queue.drop('rest', '那一刻她在睡')?.id, 'rest');
        assert.equal(queue.drop('rest', 'x'), undefined);
        const resumed = actionQueue(path);
        assert.deepEqual(resumed.pending().map(item => [item.id, item.event.at]), [['game', at('2026-10-12T13:05:00').toISOString()]]);
        const committed: LifeEventDraft[] = [];
        assert.equal(resumed.settleDue(at('2026-10-12T14:00:00'), fakeLedger(committed)), 1);
        assert.deepEqual(committed.map(event => [event.id, event.result]), [['game', 'succeeded']]);
    }));

    test('改时间：没开始的按新时间重新裁判，同一 id；新时间不行就照原计划；开始了的改不了', () => withDir(dir => {
        const queue = actionQueue(join(dir, 'queue.json'));
        const start = at('2026-10-12T14:00:00');
        queue.schedule({ id: 'study', kind: 'study', startedAt: start, durationMinutes: 60 }, context(start));
        const moved = queue.reschedule('study', at('2026-10-12T13:00:00'), { startedAt: at('2026-10-12T16:40:00'), durationMinutes: 30 }, context(start));
        assert.equal(moved?.ok, true);
        assert.deepEqual(queue.pending().map(item => [item.id, item.event.startedAt, item.event.at]),
            [['study', at('2026-10-12T16:40:00').toISOString(), at('2026-10-12T17:10:00').toISOString()]]);
        // 改到 03:00（睡觉的时候）不行：照原计划
        const bad = queue.reschedule('study', at('2026-10-12T13:00:00'), { startedAt: at('2026-10-13T03:00:00') }, context(start));
        assert.equal(bad?.ok, false);
        assert.equal(queue.pending()[0]!.event.startedAt, at('2026-10-12T16:40:00').toISOString());
        assert.equal(queue.reschedule('study', at('2026-10-12T16:50:00'), { startedAt: at('2026-10-12T19:00:00') }, context(start)), undefined, '开始了的用 cancel 打断');
    }));

    test('读世界之前先结算：只有等待、没有别的步骤，到期的行动也落账，用世界自己的时钟（DSH 行动复核 3·4）', () => withDir(dir => {
        let clock = at('2026-10-12T14:00:00').getTime();
        const ledger = worldState(card.herWorld!, schedule, () => undefined, join(dir, 'world'), () => clock);
        const queue = actionQueue(join(dir, 'world', 'action-queue.json'));
        const world = settlingWorld(ledger, queue, () => clock);
        queue.schedule({ id: 'rest', kind: 'rest', startedAt: new Date(clock) }, { ...context(new Date(clock)), events: world.events() });
        assert.equal(world.events().length, 0);
        clock = at('2026-10-12T14:31:00').getTime();
        assert.deepEqual(world.events().map(event => [event.id, event.result]), [['rest', 'succeeded']]);
        assert.equal(queue.pending().length, 0);
    }));
});
