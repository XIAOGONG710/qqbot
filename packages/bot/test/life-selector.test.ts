import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { homeworkSprints } from '../src/actions.ts';
import { actionQueue, settlingWorld } from '../src/action-queue.ts';
import { bodyAt } from '../src/body.ts';
import { readingActivities } from '../src/her-days.ts';
import { chooseAt, dayBusy, freeKind, lifeExecutor, type LifeSources } from '../src/life-selector.ts';
import type { LifeEvent } from '../src/life-events.ts';
import { classesOn, formatDate, herDay } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { worldAt, worldState } from '../src/world.ts';

const card = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = card.schedule!;
const herWorld = card.herWorld!;
const at = (text: string) => new Date(`${text}+08:00`);
const plain: LifeSources = {
    schedule, plans: herWorld.plans, books: card.books,
    worldAt: time => worldAt(herWorld, schedule, time), events: () => [],
    ...(herWorld.body ? { bodyAt: (time: Date) => bodyAt(herWorld.body!, schedule, time) } : {}),
};

/** 从 start 起每小时推一次到 end，返回她自己的行动（事件账里 life: 开头的）和日志 */
function live(dir: string, start: Date, end: Date, restartAt?: Date, sources: LifeSources = plain) {
    let clock = start.getTime();
    const logs: string[] = [];
    const open = () => {
        const ledger = worldState(herWorld, schedule, message => logs.push(message), join(dir, 'world'), () => clock);
        const queue = actionQueue(join(dir, 'world', 'action-queue.json'), message => logs.push(message));
        const world = settlingWorld(ledger, queue, () => clock);
        const executor = lifeExecutor({ ...sources, worldAt: time => world.at(herWorld, schedule, time), events: () => ledger.events() }, queue, { since: start, log: message => logs.push(message) });
        return { world, executor };
    };
    let { world, executor } = open();
    for (; clock <= end.getTime(); clock += 3600_000) {
        if (restartAt && clock === restartAt.getTime()) ({ world, executor } = open());
        executor.fill(new Date(clock));
        world.events();
    }
    return { events: world.events().filter(event => event.id.startsWith('life:')), logs };
}

describe('规则自主选择器 v1（ADR 0040）', () => {
    test('这一刻做什么：睡觉、上课、赶去上课、吃饭、洗澡跳过、空闲按一天的打算', () => {
        const sleep = chooseAt(at('2026-10-13T03:00:00'), plain);
        assert.ok('intent' in sleep && sleep.intent.kind === 'sleep');
        const lesson = classesOn(schedule, at('2026-10-12T12:00:00')).lessons[0]!;
        const atClass = chooseAt(lesson.start, plain);
        assert.ok('intent' in atClass && atClass.intent.kind === 'attend_class');
        const midClass = chooseAt(new Date(lesson.start.getTime() + 10 * 60_000), plain);
        assert.ok('skipTo' in midClass && midClass.skipTo.getTime() === lesson.end.getTime());
        const lunch = worldAt(herWorld, schedule, at('2026-10-12T12:00:00'))!.routine!.meals.find(m => m.kind === 'lunch')!;
        const eat = chooseAt(lunch.start, plain);
        assert.ok('intent' in eat && eat.intent.kind === 'eat');
        const shower = dayBusy(plain, at('2026-10-12T20:00:00')).find(span => span.text === '洗澡');
        if (shower) {
            const showering = chooseAt(new Date(shower.start.getTime() + 60_000), plain);
            assert.ok('skipTo' in showering && showering.skipTo.getTime() === shower.end.getTime());
        }
        const free = chooseAt(at('2026-10-13T13:00:00'), plain);
        assert.ok('intent' in free && ['leisure', 'study', 'rest', 'read_book'].includes(free.intent.kind));
    });

    test('空闲的事归类：在读的书 → 读书，作业 → 学习，躺着 → 休息，别的 → 休闲', () => {
        const reading = readingActivities(card.books);
        const book = card.books.find(b => b.activity)!;
        assert.deepEqual(freeKind(book.activity!.text, plain, reading), { kind: 'read_book', subject: book.id });
        assert.equal(freeKind('在宿舍写作业', plain, reading).kind, 'study');
        assert.equal(freeKind(herWorld.plans!.rest, plain, reading).kind, 'rest');
        assert.deepEqual(freeKind('打独立游戏', plain, reading), { kind: 'leisure', subject: '打独立游戏' });
    });

    test('三天半没人聊天：一件接一件、不重叠；每天睡觉、两顿饭、课都在；喂猫、洗澡的时候不记别的', () => {
        const dir = mkdtempSync(join(tmpdir(), 'life-selector-'));
        try {
            const start = at('2026-10-12T08:00:00');
            const { events, logs } = live(dir, start, at('2026-10-15T21:00:00'));
            const sorted = [...events].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
            for (let i = 1; i < sorted.length; i++) {
                assert.ok(Date.parse(sorted[i]!.startedAt) >= Date.parse(sorted[i - 1]!.endedAt), `${sorted[i - 1]!.id} 和 ${sorted[i]!.id} 重叠`);
            }
            assert.deepEqual(logs.filter(line => line.includes('排不上') || line.includes('死信')), []);
            const of = (day: string, kind: string) => events.filter(e => e.kind === kind && formatDate(herDay(schedule, new Date(e.startedAt))) === day);
            for (const day of ['2026-10-12', '2026-10-13', '2026-10-14']) {
                assert.equal(of(day, 'eat').length, 2, `${day} 两顿饭`);
                const lessons = classesOn(schedule, new Date(`${day}T12:00:00+08:00`)).lessons;
                assert.equal(of(day, 'attend_class').length, lessons.length, `${day} 的课`);
            }
            // 02:00 入睡算第二天（她的一天从 02:00 换）：10-13 到 10-15 每天一次
            for (const day of ['2026-10-13', '2026-10-14', '2026-10-15']) assert.equal(of(day, 'sleep').length, 1, `${day} 睡觉`);
            // 世界里的事那段时间不记别的
            for (const day of ['2026-10-12', '2026-10-13', '2026-10-14']) {
                for (const span of dayBusy(plain, new Date(`${day}T20:00:00+08:00`))) {
                    const clash = events.find(e => e.kind !== 'eat' && Date.parse(e.startedAt) < span.end.getTime() && Date.parse(e.endedAt) > span.start.getTime());
                    assert.equal(clash, undefined, `${day} ${span.text} 和 ${clash?.id} 撞了`);
                }
                // 赶作业那一段（ADR 0042）：只有学习
                for (const sprint of homeworkSprints(worldAt(herWorld, schedule, new Date(`${day}T19:00:00+08:00`)))) {
                    const clash = events.find(e => e.kind !== 'study' && Date.parse(e.startedAt) < sprint.end.getTime() && Date.parse(e.endedAt) > sprint.start.getTime());
                    assert.equal(clash, undefined, `${day} 赶${sprint.course}作业的时候在 ${clash?.id}`);
                }
            }
            // 上课打断休闲（ADR 0042）：做到一半去上课的都停在上课那一刻
            const byClass = events.filter(e => e.reason === 'interrupted_by_class');
            assert.ok(byClass.length >= 3, `上课打断的 ${byClass.length} 件`);
            for (const e of byClass) {
                assert.ok(events.some(other => other.kind === 'attend_class' && other.startedAt === e.endedAt), `${e.id} 停下的时候没有课`);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('赶作业抢走休闲（ADR 0042）：没有「先赶作业」的打算时，晚上打游戏打到开始赶作业那一刻，接着赶作业', () => {
        const dir = mkdtempSync(join(tmpdir(), 'life-selector-deadline-'));
        try {
            // 不带一天的打算（plans）：晚上照作息的空闲活动，作业明天交也不先赶；20:30 起在赶计算机网络技术（22:00 写完）
            const { events } = live(dir, at('2026-10-12T18:00:00'), at('2026-10-12T23:00:00'), undefined, { ...plain, plans: undefined });
            const cut = events.find(e => e.reason === 'interrupted_by_deadline');
            assert.ok(cut, '没有被赶作业打断的');
            assert.equal(cut.endedAt, at('2026-10-12T20:30:00').toISOString());
            assert.notEqual(cut.kind, 'study');
            const sprint = events.find(e => e.startedAt === cut.endedAt);
            assert.deepEqual([sprint?.kind, sprint?.subject, sprint?.endedAt], ['study', '计算机网络技术的作业', at('2026-10-12T22:00:00').toISOString()]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('在读的书停了（读到最新一卷），那一段记成休闲，不再整晚排不上（ADR 0042）', () => {
        const dir = mkdtempSync(join(tmpdir(), 'life-selector-book-'));
        try {
            const { events, logs } = live(dir, at('2026-10-16T17:00:00'), at('2026-10-17T10:00:00'));
            assert.deepEqual(logs.filter(line => line.includes('排不上')), []);
            const evening = events.filter(e => Date.parse(e.startedAt) >= at('2026-10-16T18:00:00').getTime() && e.kind !== 'sleep');
            assert.ok(evening.length >= 2);
            assert.ok(evening.every(e => e.kind !== 'read_book'));
            assert.ok(events.some(e => e.kind === 'sleep' && e.startedAt === at('2026-10-17T02:00:00').toISOString()));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('同样的日子推两遍一样；中途重启（新的执行器、队列从磁盘读回）也一样', () => {
        const a = mkdtempSync(join(tmpdir(), 'life-selector-a-'));
        const b = mkdtempSync(join(tmpdir(), 'life-selector-b-'));
        try {
            const start = at('2026-10-12T08:00:00');
            const end = at('2026-10-13T23:00:00');
            const plainRun = live(a, start, end).events;
            const restarted = live(b, start, end, at('2026-10-12T19:00:00')).events;
            const shape = (events: readonly LifeEvent[]) => events.map(e => [e.id, e.endedAt, e.result, e.subject]);
            assert.deepEqual(shape(restarted), shape(plainRun));
            assert.ok(plainRun.length > 15);
        } finally {
            rmSync(a, { recursive: true, force: true });
            rmSync(b, { recursive: true, force: true });
        }
    });
});
