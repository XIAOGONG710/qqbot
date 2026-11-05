import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import { homeworkSprints } from '../src/life/actions.ts';
import { actionQueue, settlingWorld } from '../src/world/action-queue.ts';
import { bodyAt } from '../src/life/body.ts';
import { readingActivities } from '../src/life/her-days.ts';
import { chooseAt, dayBusy, freeKind, lifeActionId as lifeActionIdFor, lifeExecutor, motivate, type LifeSources } from '../src/world/life-selector.ts';
import type { LifeEvent, LifeEventDraft } from '../src/world/life-events.ts';
import { needsAt, type NeedsSnapshot } from '../src/life/needs.ts';
import type { Appointment } from '../src/life/promises.ts';
import { classesOn, formatDate, herDay } from '../src/life/schedule.ts';
import { auditLedgerCoverage, auditLifeStatus } from '../src/sim/life-audit.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { herStatus } from '../src/language/status-line.ts';
import { worldAt, worldState, type World, type WorldAction } from '../src/world/world.ts';
import { dayFrom, useRealWeather, type HourWeather } from '../src/world/weather.ts';
import { syntheticCardPath } from './fixtures/card.ts';

const card = loadCharacterCard(syntheticCardPath('boyfriend'));
const schedule = card.schedule!;
const herWorld = card.herWorld!;
const at = (text: string) => new Date(`${text}+08:00`);
const plain: LifeSources = {
    schedule, plans: herWorld.plans, books: card.books,
    worldAt: time => worldAt(herWorld, schedule, time), events: () => [],
    ...(herWorld.body ? { bodyAt: (time: Date) => bodyAt(herWorld.body!, schedule, time) } : {}),
};
/** 合成卡上的 NPC 事件（和室友一起吃午饭 lunch_with_friend、买奶茶、高中闺蜜打电话……） */
const npcWorld: World = herWorld;
const npcSources: LifeSources = { ...plain, worldAt: time => worldAt(npcWorld, schedule, time) };

/** 从 start 起每小时推一次到 end，返回她自己的行动（事件账里 life: 开头的）和日志 */
function live(dir: string, start: Date, end: Date, restartAt?: Date, sources: LifeSources = plain, herWorldUsed: World = herWorld) {
    let clock = start.getTime();
    const logs: string[] = [];
    const open = () => {
        const ledger = worldState(herWorldUsed, schedule, message => logs.push(message), join(dir, 'world'), () => clock);
        const queue = actionQueue(join(dir, 'world', 'action-queue.json'), message => logs.push(message));
        const world = settlingWorld(ledger, queue, () => clock);
        const executor = lifeExecutor({ ...sources, worldAt: time => world.at(herWorldUsed, schedule, time), events: () => ledger.events() }, queue, { since: start, log: message => logs.push(message) });
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

/**
 * 每 10 分钟推一次（和线上的 LIFE_TICK_MS 一样），途中：她说「睡了」（bedtime，说完就知道）、聊天里抽出来的事（chat，记账的时刻是 recordAt，
 * 线上是聊天片段结束 45 分钟以后才抽）。返回她自己的行动、全部事件和日志
 */
function liveChat(dir: string, start: Date, end: Date, options: { restartAt?: Date; bedtime?: Date; chat?: { recordAt: Date; event: LifeEventDraft }[] } = {}) {
    let clock = start.getTime();
    const logs: string[] = [];
    const recorded = new Set<string>();
    const open = () => {
        const ledger = worldState(herWorld, schedule, message => logs.push(message), join(dir, 'world'), () => clock);
        const queue = actionQueue(join(dir, 'world', 'action-queue.json'), message => logs.push(message));
        const world = settlingWorld(ledger, queue, () => clock);
        const executor = lifeExecutor({
            ...plain, worldAt: time => world.at(herWorld, schedule, time), events: () => ledger.events(),
            bedtimes: () => (options.bedtime && clock >= options.bedtime.getTime() ? [options.bedtime.getTime()] : []),
        }, queue, { since: start, log: message => logs.push(message) });
        return { ledger, world, executor };
    };
    let { ledger, world, executor } = open();
    for (; clock <= end.getTime(); clock += 600_000) {
        if (options.restartAt && clock === options.restartAt.getTime()) ({ ledger, world, executor } = open());
        for (const chat of options.chat ?? []) {
            if (chat.recordAt.getTime() <= clock && !recorded.has(chat.event.id)) {
                recorded.add(chat.event.id);
                ledger.recordEvents([chat.event]);
            }
        }
        executor.fill(new Date(clock));
        world.events();
    }
    return { events: world.events().filter(event => event.id.startsWith('life:')), all: world.events(), logs };
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
        assert.ok('intent' in free && ['leisure', 'study', 'rest', 'read_book', 'work_on_project'].includes(free.intent.kind));
    });

    test('买相机那天：行动账让出出门前、相机店和回来摆弄的三段，不再同时记作息活动', () => {
        const gift: WorldAction = {
            id: '1:camera-gift:1:receive_money', kind: 'receive_money', day: '2026-10-10', at: '2026-10-10T15:41',
            contact: 1, episode: 'camera-gift', amount: 2000, target: 'camera_fund',
        };
        const cameraDay: LifeSources = { ...plain, worldAt: time => worldAt(herWorld, schedule, time, [gift]) };
        const spans = dayBusy(cameraDay, at('2026-10-11T13:00:00')).filter(span => /相机/.test(span.text));
        assert.deepEqual(spans.map(span => [span.start.toISOString(), span.end.toISOString(), span.text]), [
            ['2026-10-11T04:30:00.000Z', '2026-10-11T06:00:00.000Z', '在宿舍准备出门，14:00 去城南的二手相机店买相机'],
            ['2026-10-11T06:00:00.000Z', '2026-10-11T08:00:00.000Z', '去城南的二手相机店买相机'],
            ['2026-10-11T08:00:00.000Z', '2026-10-11T09:30:00.000Z', '刚买完相机回到宿舍，在摆弄新相机'],
        ]);
        for (const [time, until] of [
            ['2026-10-11T13:30:00', '2026-10-11T14:00:00'],
            ['2026-10-11T15:00:00', '2026-10-11T16:00:00'],
            ['2026-10-11T17:00:00', '2026-10-11T17:30:00'],
        ] as const) {
            const choice = chooseAt(at(time), cameraDay);
            assert.ok('skipTo' in choice && choice.skipTo.getTime() === at(until).getTime(), `${time}: ${JSON.stringify(choice)}`);
        }
    });

    test('空闲的事归类：在读的书 → 读书，作业 → 学习，躺着 → 休息，别的 → 休闲', () => {
        const reading = readingActivities(card.books);
        const book = card.books.find(b => b.activity)!;
        assert.deepEqual(freeKind(book.activity!.text, plain, reading), { kind: 'read_book', subject: book.id });
        assert.equal(freeKind('在宿舍写作业', plain, reading).kind, 'study');
        assert.equal(freeKind(herWorld.plans!.rest, plain, reading).kind, 'rest');
        assert.deepEqual(freeKind('修昨天拍的片子', plain, reading), {
            kind: 'work_on_project', subject: '修昨天拍的片子', target: 'photography_growth',
        });
        assert.deepEqual(freeKind('打独立游戏', plain, reading), { kind: 'leisure', subject: '打独立游戏' });
    });

    test('连续需要只改柔性行动：低精力休息、高压力暂缓项目；普通状态不动', () => {
        const project = { kind: 'work_on_project' as const, subject: '修昨天拍的片子', target: 'photography_growth' };
        assert.deepEqual(motivate(project, { at: new Date().toISOString(), energy: 24, hunger: 30, stress: 20 }, '躺着歇会儿').action,
            { kind: 'rest', subject: '躺着歇会儿' });
        assert.deepEqual(motivate(project, { at: new Date().toISOString(), energy: 60, hunger: 30, stress: 76 }, '躺着歇会儿').action,
            { kind: 'rest', subject: '躺着歇会儿' });
        assert.deepEqual(motivate(project, { at: new Date().toISOString(), energy: 60, hunger: 30, stress: 50 }).action, project);
        const study = { kind: 'study' as const, subject: '数据结构的作业' };
        assert.deepEqual(motivate(study, { at: new Date().toISOString(), energy: 60, hunger: 30, stress: 90 }).action, study,
            '压力高只降低项目效用，不能盖掉学习和截止时间');
    });

    test('真人式动机和无聊会回流到柔性行动；没有回调时保持旧行为', () => {
        const study = { kind: 'study' as const, subject: '复习' };
        const rest = { kind: 'rest' as const, subject: '躺会儿' };
        const needs: NeedsSnapshot = { at: new Date().toISOString(), energy: 60, hunger: 30, stress: 35 };
        assert.deepEqual(motivate(study, needs, '躺会儿', { motivation: 20, boredom: 20 }).action,
            rest, '动机过低时先恢复');
        assert.deepEqual(motivate(rest, needs, '躺会儿', { motivation: 65, boredom: 82 }).action,
            { kind: 'leisure', subject: '找点轻松的事做' }, '无聊过高时避免继续躺平');
        assert.deepEqual(motivate(study, needs).action, study, '未接真人式状态时兼容旧选择器');
    });

    test('硬事件仍优先：即使又累又饿又有压力，饭点先吃饭、上课先上课', () => {
        const exhausted: LifeSources = {
            ...plain,
            needsAnchor: { at: at('2026-10-12T08:00:00').toISOString(), energy: 5, hunger: 95, stress: 95 },
        };
        const lunch = worldAt(herWorld, schedule, at('2026-10-12T12:00:00'))!.routine!.meals.find(m => m.kind === 'lunch')!;
        const eat = chooseAt(lunch.start, exhausted);
        assert.ok('intent' in eat && eat.intent.kind === 'eat');
        const lesson = classesOn(schedule, at('2026-10-12T12:00:00')).lessons[0]!;
        const attend = chooseAt(lesson.start, exhausted);
        assert.ok('intent' in attend && attend.intent.kind === 'attend_class');
    });

    test('项目选择开关默认不改变行为；打开后状态行和执行器共用三天内作业，硬事件仍优先', () => {
        const time = at('2026-10-13T13:00:00');
        const base = worldAt(herWorld, schedule, time)!;
        const urgent = {
            ...base,
            homework: [{ course: '数据结构', due: at('2026-10-15T12:00:00'), done: false, doneAt: at('2026-10-14T22:00:00') }],
        };
        const enabled: LifeSources = { ...plain, projectChoice: true, worldAt: () => urgent };
        const picked = chooseAt(time, enabled);
        assert.ok('intent' in picked);
        if (!('intent' in picked)) return;
        assert.deepEqual([picked.intent.kind, picked.intent.subject], ['study', '数据结构作业']);

        const status = herStatus(schedule, time, {
            extraFree: readingActivities(card.books), world: urgent,
            plans: { plans: herWorld.plans, body: bodyAt(herWorld.body!, schedule, time) },
            projectChoice: { events: [], books: card.books },
        });
        assert.equal(status.project?.action.subject, picked.intent.subject);
        assert.equal(status.doing, '在赶数据结构作业');
        const audited: LifeEvent = {
            id: lifeActionIdFor(time, 'study'), actor: 'linmengyao', kind: 'study', day: '2026-10-13',
            startedAt: time.toISOString(), endedAt: new Date(time.getTime() + 30 * 60_000).toISOString(),
            source: 'simulation', result: 'succeeded', subject: '数据结构作业',
        };
        assert.deepEqual(auditLifeStatus([audited], { ...enabled, events: () => [audited] }), []);

        const disabled = chooseAt(time, { ...plain, worldAt: () => urgent });
        assert.ok(!('intent' in disabled) || disabled.intent.subject !== '数据结构作业', '默认关闭时沿用原选择器');
        const lesson = classesOn(schedule, at('2026-10-12T12:00:00')).lessons[0]!;
        const hard = chooseAt(lesson.start, enabled);
        assert.ok('intent' in hard && hard.intent.kind === 'attend_class');
    });

    test('首次启用时复核锚点之前的旧队列，沿用旧选择器而不是向过去投影需要', () => {
        const beforeAnchor = at('2026-10-12T13:00:00');
        const withLaterAnchor: LifeSources = {
            ...plain,
            needsAnchor: { at: at('2026-10-12T17:00:00').toISOString(), energy: 5, hunger: 95, stress: 95 },
        };
        assert.deepEqual(chooseAt(beforeAnchor, withLaterAnchor), chooseAt(beforeAnchor, plain));
    });

    test('NPC 事实不是提示词装饰：一起吃饭附在午饭行动，微信来往成为独立的类型化行动', () => {
        const lunch = worldAt(npcWorld, schedule, at('2026-10-13T12:00:00'))!.routine!.meals.find(m => m.kind === 'lunch')!;
        const together = chooseAt(lunch.start, npcSources);
        assert.ok('intent' in together);
        if ('intent' in together) assert.deepEqual([together.intent.kind, together.intent.target], ['eat', 'su_yutong']);

        // 合成卡上 11-08 14:17 和室友去买了奶茶（卡上的事件）：那一刻成为独立的 NPC 来往
        const chat = chooseAt(at('2026-11-08T14:17:00'), plain);
        assert.ok('intent' in chat);
        if ('intent' in chat) assert.deepEqual(
            [chat.intent.kind, chat.intent.target, chat.intent.subject],
            ['interact_npc', 'su_yutong', '在微信上跟许小禾聊了会儿'],
        );
    });

    test('约好的见面进入行动账：出门时截断柔性行动，餐约替代普通晚饭并结算为外出吃饭', () => {
        const dir = mkdtempSync(join(tmpdir(), 'life-meet-'));
        try {
            const dinner = worldAt(herWorld, schedule, at('2026-10-18T18:00:00'))!.routine!.meals.find(item => item.kind === 'dinner')!;
            const meeting: Appointment = {
                contact: { qq: 42, name: '阿明', tier: 'boyfriend' },
                promise: {
                    id: 'p-dinner', what: '和他去东门吃麻辣烫', date: '2026-10-18', said: '2026-10-17', episode: 'ep-meet',
                    meet: { time: `${String(dinner.start.getHours()).padStart(2, '0')}:${String(dinner.start.getMinutes()).padStart(2, '0')}`, where: '东门口', minutes: 90 },
                },
                start: dinner.start,
                end: new Date(dinner.start.getTime() + 90 * 60_000),
            };
            const lead = new Date(meeting.start.getTime() - 15 * 60_000);
            const sources: LifeSources = {
                ...plain,
                appointmentsBetween: (from, to) => lead < to && meeting.end > from ? [meeting] : [],
            };

            const picked = chooseAt(lead, sources);
            assert.ok('intent' in picked && picked.intent.kind === 'meet');
            if ('intent' in picked) assert.deepEqual(
                [picked.intent.target, picked.intent.meal], ['contact:42', true],
            );

            const { events, logs } = live(dir, new Date(lead.getTime() - 60 * 60_000), new Date(meeting.end.getTime() + 60 * 60_000), undefined, sources);
            assert.deepEqual(logs.filter(line => line.includes('排不上') || line.includes('死信')), []);
            const meet = events.find(event => event.kind === 'meet');
            assert.deepEqual(
                [meet?.startedAt, meet?.endedAt, meet?.subject, meet?.target, meet?.meal],
                [lead.toISOString(), meeting.end.toISOString(), meeting.promise.what, 'contact:42', true],
            );
            assert.equal(events.some(event => event.kind === 'eat'
                && Date.parse(event.startedAt) < meeting.end.getTime() && Date.parse(event.endedAt) > lead.getTime()), false,
            '餐约时段不能同时在食堂吃晚饭');
            const before = events.find(event => event.endedAt === lead.toISOString());
            assert.ok(before && ['leisure', 'rest', 'read_book', 'study', 'work_on_project'].includes(before.kind));
            assert.deepEqual(auditLifeStatus(events, { ...sources, events: () => events }), []);
            assert.deepEqual(auditLedgerCoverage(events, { ...sources, events: () => events }), []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('落在饭点中间、这顿还没吃：从这一刻吃；吃过了才跳过（10-09 线上晚饭整顿没记上）', () => {
        const dinner = worldAt(herWorld, schedule, at('2026-10-18T18:00:00'))!.routine!.meals.find(item => item.kind === 'dinner')!;
        const mid = new Date(dinner.start.getTime() + 51_000 + 60_000);
        const picked = chooseAt(mid, plain);
        assert.ok('intent' in picked && picked.intent.kind === 'eat', JSON.stringify(picked));
        const eaten: LifeEvent = {
            id: lifeActionIdFor(dinner.start, 'eat'), actor: 'linmengyao', kind: 'eat', day: '2026-10-18', startedAt: dinner.start.toISOString(), endedAt: dinner.end.toISOString(),
            source: 'simulation', result: 'succeeded', subject: 'dinner',
        };
        const after = chooseAt(mid, { ...plain, events: () => [eaten] });
        assert.ok('skipTo' in after && after.skipTo.getTime() === dinner.end.getTime(), JSON.stringify(after));
        // 剩下不到 15 分钟就不吃了
        const late = chooseAt(new Date(dinner.end.getTime() - 10 * 60_000), plain);
        assert.ok('skipTo' in late, JSON.stringify(late));
    });

    test('起点带秒（线上 lifeStartedAt）：照样一顿不落，排的事从整分钟开始', () => {
        const dir = mkdtempSync(join(tmpdir(), 'life-seconds-'));
        try {
            const { events } = live(dir, at('2026-10-18T15:07:51'), at('2026-10-18T21:00:00'));
            const dinners = events.filter(event => event.kind === 'eat' && event.subject === 'dinner');
            assert.equal(dinners.length, 1, events.map(e => `${e.kind} ${e.startedAt}`).join('，'));
            assert.ok(events.every(event => new Date(event.startedAt).getUTCSeconds() === 0), '对齐到整分钟');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    describe('约好的见面和吃饭、改约、取消、重启（G1，审查 P1-1 / P1-2）', () => {
        const hhmm = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
        const meeting = (id: string, what: string, start: Date, minutes: number): Appointment => ({
            contact: { qq: 42, name: '阿明', tier: 'boyfriend' },
            promise: { id, what, date: formatDate(start), said: '2026-10-17', episode: 'ep-meet', meet: { time: hhmm(start), where: '东门口', minutes } },
            start, end: new Date(start.getTime() + minutes * 60_000),
        });
        /** 每 10 分钟推一次（线上 LIFE_TICK_MS），约定按时钟换：appointments(clock) 是那一刻约定存储里有的 */
        function liveMeet(dir: string, start: Date, end: Date, appointments: (clock: number) => Appointment[], restartAt?: Date) {
            let clock = start.getTime();
            const logs: string[] = [];
            const sources: LifeSources = {
                ...plain,
                appointmentsBetween: (from, to) => appointments(clock).filter(a => a.start.getTime() - 15 * 60_000 < to.getTime() && a.end > from),
            };
            const open = () => {
                const ledger = worldState(herWorld, schedule, message => logs.push(message), join(dir, 'world'), () => clock);
                const queue = actionQueue(join(dir, 'world', 'action-queue.json'), message => logs.push(message));
                const world = settlingWorld(ledger, queue, () => clock);
                const executor = lifeExecutor({ ...sources, worldAt: time => world.at(herWorld, schedule, time), events: () => ledger.events() }, queue, { since: start, log: message => logs.push(message) });
                return { world, executor };
            };
            let { world, executor } = open();
            for (; clock <= end.getTime(); clock += 600_000) {
                if (restartAt && clock === restartAt.getTime()) ({ world, executor } = open());
                executor.fill(new Date(clock));
                world.events();
            }
            return { events: world.events().filter(event => event.id.startsWith('life:')), logs, sources };
        }
        const lunch = worldAt(herWorld, schedule, at('2026-10-18T12:00:00'))!.routine!.meals.find(item => item.kind === 'lunch')!;
        const dinner = worldAt(herWorld, schedule, at('2026-10-18T18:00:00'))!.routine!.meals.find(item => item.kind === 'dinner')!;
        const overlapping = (events: readonly LifeEvent[], kind: string, from: Date, to: Date) =>
            events.filter(event => event.kind === kind && Date.parse(event.startedAt) < to.getTime() && Date.parse(event.endedAt) > from.getTime());

        test('不吃饭的约会只擦到午饭尾巴：出门前把饭吃完（截到出门那一刻），见面不算吃饭', () => {
            const dir = mkdtempSync(join(tmpdir(), 'life-meet-'));
            try {
                // 午饭开始 31 分钟后见面，出门在午饭开始 16 分钟后；和午饭只重叠几分钟
                const study = meeting('p-study', '和他在图书馆前面集合一起自习', new Date(lunch.start.getTime() + 31 * 60_000), 120);
                const lead = new Date(study.start.getTime() - 15 * 60_000);
                const { events, logs } = liveMeet(dir, at('2026-10-18T10:00:00'), at('2026-10-18T16:00:00'), () => [study]);
                assert.deepEqual(logs.filter(line => line.includes('排不上') || line.includes('死信')), []);
                const eat = overlapping(events, 'eat', lunch.start, lunch.end);
                assert.deepEqual(eat.map(e => [e.startedAt, e.endedAt]), [[lunch.start.toISOString(), lead.toISOString()]]);
                const meet = events.find(event => event.kind === 'meet')!;
                assert.deepEqual([meet.startedAt, meet.endedAt, meet.meal], [lead.toISOString(), study.end.toISOString(), false]);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        test('上午的约会在午饭开始后几分钟见完：回来接着吃午饭', () => {
            const dir = mkdtempSync(join(tmpdir(), 'life-meet-'));
            try {
                const back = new Date(lunch.start.getTime() + 6 * 60_000);
                const errand = meeting('p-errand', '陪他去图书馆还书', at('2026-10-18T10:00:00'), (back.getTime() - at('2026-10-18T10:00:00').getTime()) / 60_000);
                const { events } = liveMeet(dir, at('2026-10-18T08:30:00'), at('2026-10-18T14:00:00'), () => [errand]);
                assert.deepEqual(overlapping(events, 'eat', lunch.start, lunch.end).map(e => [e.startedAt, e.endedAt]), [[back.toISOString(), lunch.end.toISOString()]]);
                assert.equal(events.find(event => event.kind === 'meet')?.meal, false);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        test('晚饭约会出门以后他取消了：见面停在知道的那一刻，之后接着过；不在食堂再吃一顿', () => {
            const dir = mkdtempSync(join(tmpdir(), 'life-meet-'));
            try {
                const date = meeting('p-dinner', '和他去东门吃麻辣烫', dinner.start, 90);
                const lead = new Date(date.start.getTime() - 15 * 60_000);
                // 合成卡 10-18 的晚饭是 18:05–18:35：取消落在饭点过后，不在食堂再吃一顿，接着排别的
                const cancelledAt = at('2026-10-18T18:40:00');
                const { events, logs } = liveMeet(dir, at('2026-10-18T15:00:00'), at('2026-10-18T22:00:00'), clock => (clock < cancelledAt.getTime() ? [date] : []));
                const meet = events.filter(event => event.kind === 'meet');
                assert.deepEqual(meet.map(e => [e.startedAt, e.endedAt]), [[lead.toISOString(), cancelledAt.toISOString()]]);
                assert.ok(logs.some(line => line.includes('约好的见面中途取消了')));
                const next = events.find(event => event.startedAt === cancelledAt.toISOString());
                assert.ok(next && next.kind !== 'meet', '取消以后接着排别的');
                assert.deepEqual(overlapping(events, 'eat', lead, date.end), []);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        test('出门前改了时间：按新的时间出门，旧时间那段照常过', () => {
            const dir = mkdtempSync(join(tmpdir(), 'life-meet-'));
            try {
                const first = meeting('p-walk', '和他去湖边逛逛', at('2026-10-18T15:00:00'), 90);
                const moved = meeting('p-walk', '和他去湖边逛逛', at('2026-10-18T19:00:00'), 90);
                const movedAt = at('2026-10-18T14:00:00').getTime();
                const { events } = liveMeet(dir, at('2026-10-18T13:00:00'), at('2026-10-18T22:00:00'), clock => [clock < movedAt ? first : moved]);
                const meet = events.filter(event => event.kind === 'meet');
                assert.deepEqual(meet.map(e => e.startedAt), [new Date(moved.start.getTime() - 15 * 60_000).toISOString()]);
                assert.deepEqual(overlapping(events, 'meet', first.start, first.end), []);
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        test('约会中途重启（ADR 0039）：事件账和不重启时一样', () => {
            const a = mkdtempSync(join(tmpdir(), 'life-meet-'));
            const b = mkdtempSync(join(tmpdir(), 'life-meet-'));
            try {
                const date = meeting('p-dinner', '和他去东门吃麻辣烫', dinner.start, 90);
                const plainRun = liveMeet(a, at('2026-10-18T15:00:00'), at('2026-10-18T22:00:00'), () => [date]);
                const restarted = liveMeet(b, at('2026-10-18T15:00:00'), at('2026-10-18T22:00:00'), () => [date], at('2026-10-18T18:20:00'));
                const view = (events: readonly LifeEvent[]) => events.map(e => [e.id, e.kind, e.startedAt, e.endedAt, e.result, e.meal ?? null]);
                assert.deepEqual(view(restarted.events), view(plainRun.events));
                assert.deepEqual(auditLifeStatus(plainRun.events, { ...plainRun.sources, events: () => plainRun.events }), []);
            } finally {
                rmSync(a, { recursive: true, force: true });
                rmSync(b, { recursive: true, force: true });
            }
        });
    });

    test('真实天气上午十一点开始下雨（G2）：出门拍照停在十一点，之后在宿舍整理照片；十一点以前那段不倒着改', () => {
        const dir = mkdtempSync(join(tmpdir(), 'life-rain-'));
        // 11-08（周日）上午打算拿胶片机去湖边拍照（合成卡上出门的打算只有上午那一条；空闲活动的抽签列表变了，具体哪天跟着挪）
        const date = '2026-11-08';
        const rain = [11, 12, 13];
        const hours: Record<string, HourWeather> = Object.fromEntries(Array.from({ length: 24 }, (_, h) => [`${date}T${String(h).padStart(2, '0')}`,
            { t: 16, p: rain.includes(h - 1) ? 1.2 : 0, c: rain.includes(h) ? 61 : 2, o: 1 as const }]));
        useRealWeather({ day: (place, day, until) => (place === 'jinan' && day === date ? dayFrom(hours, day, until) : undefined) });
        try {
            const { events } = live(dir, at('2026-11-08T08:00:00'), at('2026-11-08T14:00:00'));
            const library = events.filter(event => event.subject === '拿胶片机去湖边拍照');
            const dorm = events.filter(event => event.subject === '在宿舍整理照片');
            const three = at('2026-11-08T11:00:00');
            assert.ok(library.length > 0, '下雨前在湖边拍照');
            assert.ok(library.every(event => Date.parse(event.endedAt) <= three.getTime()), library.map(event => `${event.startedAt}–${event.endedAt}`).join('，'));
            assert.ok(library.some(event => event.endedAt === three.toISOString()), '停在开始下雨的那一刻');
            assert.ok(dorm.some(event => event.startedAt === three.toISOString()), dorm.map(event => event.startedAt).join('，'));
        } finally {
            useRealWeather(undefined);
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('三天半没人聊天：一件接一件、不重叠；每天睡觉、两顿饭、课都在；喂猫、洗澡的时候不记别的', () => {
        const dir = mkdtempSync(join(tmpdir(), 'life-selector-'));
        try {
            // 合成卡上 11-02 那一周摄影项目（拿胶片机出去拍）推进得够：用这三天半
            const start = at('2026-11-02T08:00:00');
            const { events, logs } = live(dir, start, at('2026-11-05T21:00:00'), undefined, npcSources, npcWorld);
            const sorted = [...events].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
            for (let i = 1; i < sorted.length; i++) {
                assert.ok(Date.parse(sorted[i]!.startedAt) >= Date.parse(sorted[i - 1]!.endedAt), `${sorted[i - 1]!.id} 和 ${sorted[i]!.id} 重叠`);
            }
            assert.deepEqual(logs.filter(line => line.includes('排不上') || line.includes('死信')), []);
            const of = (day: string, kind: string) => events.filter(e => e.kind === kind && formatDate(herDay(schedule, new Date(e.startedAt))) === day);
            for (const day of ['2026-11-02', '2026-11-03', '2026-11-04']) {
                assert.equal(of(day, 'eat').length, 2, `${day} 两顿饭`);
                const lessons = classesOn(schedule, new Date(`${day}T12:00:00+08:00`)).lessons;
                assert.equal(of(day, 'attend_class').length, lessons.length, `${day} 的课`);
            }
            // 02:00 入睡算第二天（她的一天从 02:00 换）：11-03 到 11-05 每天一次
            for (const day of ['2026-11-03', '2026-11-04', '2026-11-05']) assert.equal(of(day, 'sleep').length, 1, `${day} 睡觉`);
            // 世界里的事那段时间不记别的
            for (const day of ['2026-11-02', '2026-11-03', '2026-11-04']) {
                for (const span of dayBusy(npcSources, new Date(`${day}T20:00:00+08:00`))) {
                    const clash = events.find(e => e.kind !== 'eat' && Date.parse(e.startedAt) < span.end.getTime() && Date.parse(e.endedAt) > span.start.getTime());
                    assert.equal(clash, undefined, `${day} ${span.text} 和 ${clash?.id} 撞了`);
                }
                // 赶作业那一段（ADR 0042）：只有学习
                for (const sprint of homeworkSprints(worldAt(npcWorld, schedule, new Date(`${day}T19:00:00+08:00`)))) {
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
            const social = events.filter(e => ['eat', 'attend_class', 'interact_npc'].includes(e.kind) && e.target);
            assert.ok(social.some(e => e.target === 'su_yutong'), '72 小时里和室友的来往进入类型化行动账');
            const project = events.filter(e => e.kind === 'work_on_project' && e.target === 'photography_growth');
            const projectMinutes = project.reduce((sum, e) => sum + (Date.parse(e.endedAt) - Date.parse(e.startedAt)) / 60_000, 0);
            assert.ok(projectMinutes >= 120, `摄影项目只推进了 ${projectMinutes} 分钟`);
            assert.deepEqual(auditLifeStatus(events, { ...npcSources, events: () => events }), [], '事件账里的行动和同一时刻状态行规则一致');
            assert.deepEqual(auditLedgerCoverage(events, { ...npcSources, events: () => events }), [], '反方向：状态行说她在做的，账上那一刻都有行动');
            // 反例：拿掉一段摄影项目，状态行那段还说她在修片，审计要报出来
            const dropped = project.find(e => Date.parse(e.endedAt) - Date.parse(e.startedAt) >= 30 * 60_000)!;
            const holes = auditLedgerCoverage(events.filter(e => e.id !== dropped.id), npcSources);
            assert.equal(holes.length, 1, JSON.stringify(holes));
            assert.equal(holes[0]!.expectedKind, 'work_on_project');
            assert.ok(Date.parse(holes[0]!.from) <= Date.parse(dropped.startedAt) && Date.parse(holes[0]!.to) >= Date.parse(dropped.endedAt));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('真实选择器跑 14 天：需要轨迹有界、有日内变化，重启不改结果', () => {
        const a = mkdtempSync(join(tmpdir(), 'life-needs-a-'));
        const b = mkdtempSync(join(tmpdir(), 'life-needs-b-'));
        try {
            // 合成卡的生活比较松：10 月中以后的两周压力大半时间落在 0；9 月上旬那两周不会
            const start = at('2026-09-07T08:00:00');
            const end = at('2026-09-21T08:00:00');
            const anchor: NeedsSnapshot = { at: start.toISOString(), energy: 68, hunger: 35, stress: 24 };
            const sources: LifeSources = { ...plain, needsAnchor: anchor };
            const direct = live(a, start, end, undefined, sources).events;
            const restarted = live(b, start, end, at('2026-09-14T08:00:00'), sources).events;
            const shape = (events: readonly LifeEvent[]) => events.map(e => [e.id, e.endedAt, e.result, e.subject, e.target]);
            assert.deepEqual(shape(restarted), shape(direct));

            const samples: NeedsSnapshot[] = [];
            for (let time = start.getTime(); time <= end.getTime(); time += 30 * 60_000) {
                samples.push(needsAt(anchor, direct, new Date(time)));
            }
            for (const sample of samples) {
                for (const value of [sample.energy, sample.hunger, sample.stress]) assert.ok(value >= 0 && value <= 100, JSON.stringify(sample));
            }
            for (const key of ['energy', 'hunger', 'stress'] as const) {
                const values = samples.map(sample => sample[key]);
                assert.ok(new Set(values).size > 12, `${key} 缺少日内变化`);
                const pinned = values.filter(value => value === 0 || value === 100).length;
                assert.ok(pinned < samples.length * 0.45, `${key} 长时间钉在边界：${pinned}/${samples.length}`);
            }
        } finally {
            rmSync(a, { recursive: true, force: true });
            rmSync(b, { recursive: true, force: true });
        }
    });

    test('项目选择跑 14 天：紧急作业接管空闲，但摄影和阅读仍有进展，状态账双向一致', () => {
        const dir = mkdtempSync(join(tmpdir(), 'life-project-choice-'));
        try {
            const start = at('2026-10-12T08:00:00');
            const end = at('2026-10-26T08:00:00');
            const sources: LifeSources = { ...plain, projectChoice: true };
            const events = live(dir, start, end, undefined, sources).events;
            assert.ok(events.some(event => event.kind === 'study' && /作业/.test(event.subject ?? '')), '紧急课程项目进入学习行动');
            assert.ok(events.some(event => event.kind === 'work_on_project'), '摄影项目没有被作业饿死');
            assert.ok(events.some(event => event.kind === 'read_book'), '阅读项目没有被作业饿死');
            const audited = { ...sources, events: () => events };
            assert.deepEqual(auditLifeStatus(events, audited), []);
            assert.deepEqual(auditLedgerCoverage(events, audited), []);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('赶作业抢走休闲（ADR 0042）：没有「先赶作业」的打算时，晚上打游戏打到开始赶作业那一刻，接着赶作业', () => {
        const dir = mkdtempSync(join(tmpdir(), 'life-selector-deadline-'));
        try {
            // 不带一天的打算（plans）：晚上照作息的空闲活动，作业明天交也不先赶；20:30 起在赶数据结构（22:00 写完）
            const { events } = live(dir, at('2026-10-14T18:00:00'), at('2026-10-14T23:00:00'), undefined, { ...plain, plans: undefined });
            const cut = events.find(e => e.reason === 'interrupted_by_deadline');
            assert.ok(cut, '没有被赶作业打断的');
            assert.equal(cut.endedAt, at('2026-10-14T20:30:00').toISOString());
            assert.notEqual(cut.kind, 'study');
            const sprint = events.find(e => e.startedAt === cut.endedAt);
            assert.deepEqual([sprint?.kind, sprint?.subject, sprint?.endedAt], ['study', '数据结构的作业', at('2026-10-14T22:00:00').toISOString()]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('在读的书停了（合成卡上的书 11-13 读完），那一段记成休闲，不再整晚排不上（ADR 0042）', () => {
        const dir = mkdtempSync(join(tmpdir(), 'life-selector-book-'));
        try {
            const { events, logs } = live(dir, at('2026-11-13T17:00:00'), at('2026-11-14T10:00:00'));
            assert.deepEqual(logs.filter(line => line.includes('排不上')), []);
            const evening = events.filter(e => Date.parse(e.startedAt) >= at('2026-11-13T18:00:00').getTime() && e.kind !== 'sleep');
            assert.ok(evening.length >= 2);
            assert.ok(evening.every(e => e.kind !== 'read_book'));
            assert.ok(events.some(e => e.kind === 'sleep' && e.startedAt === at('2026-11-14T02:00:00').toISOString()));
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
            const shape = (events: readonly LifeEvent[]) => events.map(e => [e.id, e.endedAt, e.result, e.subject, e.target]);
            assert.deepEqual(shape(restarted), shape(plainRun));
            assert.ok(plainRun.length > 15);
        } finally {
            rmSync(a, { recursive: true, force: true });
            rmSync(b, { recursive: true, force: true });
        }
    });
});

describe('聊天里说过的事改写还没过的（ADR 0042）', () => {
    const iso = (text: string) => at(text).toISOString();
    const withDir = (run: (dir: string) => void) => {
        const dir = mkdtempSync(join(tmpdir(), 'life-chat-'));
        try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    const overlapping = (events: readonly LifeEvent[], from: string, to: string) =>
        events.filter(e => Date.parse(e.startedAt) < at(to).getTime() && Date.parse(e.endedAt) > at(from).getTime());
    const shape = (events: readonly LifeEvent[]) => events.map(e => [e.id, e.endedAt, e.result, e.subject, e.target]);

    test('她 00:32 说「睡了」：正打着的游戏停在 00:32，从 00:32 睡到起床；没说的话照旧 02:00 睡', () => withDir(dir => {
        const { events } = liveChat(dir, at('2026-10-12T21:00:00'), at('2026-10-13T10:00:00'), { bedtime: at('2026-10-13T00:32:00') });
        const game = events.find(e => e.endedAt === iso('2026-10-13T00:32:00'));
        assert.deepEqual([game?.kind, game?.result], ['leisure', 'succeeded']);
        const sleep = events.filter(e => e.kind === 'sleep');
        assert.deepEqual(sleep.map(e => [e.startedAt, e.endedAt]), [[iso('2026-10-13T00:32:00'), iso('2026-10-13T09:30:00')]]);
        assert.deepEqual(overlapping(events, '2026-10-13T00:32:00', '2026-10-13T09:30:00').map(e => e.kind), ['sleep']);
    }));

    test('聊天里说 20:40 下楼喂了团子饼（21:25 才抽出来）：正刷着的手机停在 20:40，喂完 20:50 接着刷；那十分钟不记别的', () => withDir(dir => {
        const feed: LifeEventDraft = { id: 'chat:feed', kind: 'feed_cat', at: iso('2026-10-13T20:40:00'), source: 'conversation', result: 'succeeded' };
        const { events, all } = liveChat(dir, at('2026-10-13T17:00:00'), at('2026-10-13T23:30:00'), { chat: [{ recordAt: at('2026-10-13T21:25:00'), event: feed }] });
        assert.equal(all.find(e => e.id === 'chat:feed')?.result, 'succeeded');
        const before = events.find(e => e.endedAt === iso('2026-10-13T20:40:00'));
        assert.deepEqual([before?.kind, before?.result], ['leisure', 'succeeded']);
        assert.ok(events.some(e => e.kind === 'leisure' && e.startedAt === iso('2026-10-13T20:50:00')), '喂完接着刷');
        assert.deepEqual(overlapping(events, '2026-10-13T20:40:00', '2026-10-13T20:50:00'), []);
    }));

    test('聊天里说 21:40 作业写完了：正赶着的作业停在 21:40（做完了），之后回到原来的打算', () => withDir(dir => {
        const done: LifeEventDraft = { id: 'chat:homework', kind: 'finish_homework', at: iso('2026-10-14T21:40:00'), source: 'conversation', result: 'succeeded' };
        const { events, all } = liveChat(dir, at('2026-10-14T17:00:00'), at('2026-10-14T23:00:00'), { chat: [{ recordAt: at('2026-10-14T21:50:00'), event: done }] });
        assert.equal(all.find(e => e.id === 'chat:homework')?.result, 'succeeded');
        const study = events.find(e => e.endedAt === iso('2026-10-14T21:40:00'));
        assert.deepEqual([study?.kind, study?.result], ['study', 'succeeded']);
        const next = events.find(e => e.startedAt === iso('2026-10-14T21:40:00'));
        assert.equal(next?.kind, 'leisure');
        assert.deepEqual(overlapping(events, '2026-10-14T21:40:00', '2026-10-14T22:00:00').filter(e => e.kind === 'study'), []);
    }));

    test('聊天里说 20:00 作业写完了（20:50 才抽出来）：20:28 排上的赶作业从来没发生，去掉；20:28 起回到原来的打算', () => withDir(dir => {
        // 合成卡 10-14 晚上在赶数据结构（22:00 写完）：18:28 起一段、20:28 起又排一段
        const done: LifeEventDraft = { id: 'chat:homework', kind: 'finish_homework', at: iso('2026-10-14T20:00:00'), source: 'conversation', result: 'succeeded' };
        const { events, logs } = liveChat(dir, at('2026-10-14T17:00:00'), at('2026-10-14T23:00:00'), { chat: [{ recordAt: at('2026-10-14T20:50:00'), event: done }] });
        assert.ok(logs.some(line => line.includes('去掉 study')), '排着的赶作业去掉了');
        assert.equal(events.find(e => e.startedAt === iso('2026-10-14T20:28:00'))?.kind, 'leisure');
        assert.deepEqual(events.filter(e => e.kind === 'study' && Date.parse(e.startedAt) >= at('2026-10-14T20:28:00').getTime()), []);
    }));

    test('抽出来时那段已经落账了：过去的不改，两件并存', () => withDir(dir => {
        const plainDir = join(dir, 'plain');
        const lateDir = join(dir, 'late');
        const feed: LifeEventDraft = { id: 'chat:feed', kind: 'feed_cat', at: iso('2026-10-13T20:40:00'), source: 'conversation', result: 'succeeded' };
        const plainRun = liveChat(plainDir, at('2026-10-13T17:00:00'), at('2026-10-13T23:30:00')).events;
        const late = liveChat(lateDir, at('2026-10-13T17:00:00'), at('2026-10-13T23:30:00'), { chat: [{ recordAt: at('2026-10-13T23:00:00'), event: feed }] }).events;
        const settled = (events: readonly LifeEvent[]) => shape(events.filter(e => Date.parse(e.endedAt) <= at('2026-10-13T22:40:00').getTime()));
        assert.deepEqual(settled(late), settled(plainRun));
        assert.equal(overlapping(late, '2026-10-13T20:40:00', '2026-10-13T20:50:00').length, 1, '刷手机那一段早落账了，和喂猫并存');
    }));

    test('重启一致：说了「睡了」、聊天里说过喂猫，中途重启和不重启得到一样的事件账', () => withDir(dir => {
        const feed: LifeEventDraft = { id: 'chat:feed', kind: 'feed_cat', at: iso('2026-10-12T20:20:00'), source: 'conversation', result: 'succeeded' };
        const options = { bedtime: at('2026-10-13T00:32:00'), chat: [{ recordAt: at('2026-10-12T21:05:00'), event: feed }] };
        const a = liveChat(join(dir, 'a'), at('2026-10-12T17:00:00'), at('2026-10-13T10:00:00'), options).events;
        const b = liveChat(join(dir, 'b'), at('2026-10-12T17:00:00'), at('2026-10-13T10:00:00'), { ...options, restartAt: at('2026-10-13T00:40:00') }).events;
        assert.deepEqual(shape(b), shape(a));
        assert.ok(a.some(e => e.kind === 'sleep' && e.startedAt === iso('2026-10-13T00:32:00')));
    }));
});
