import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, test } from 'node:test';
import type { Module, Turn } from '../src/interpreter/interpreter.ts';
import type { Piece } from '../src/interpreter/slots.ts';
import { asleepSince } from '../src/life/bedtime.ts';
import { DESKTOP_EVENT_PREFIX, DESKTOP_SUBJECT, DESKTOP_TARGET, desktopBusySpans, desktopCalled, desktopWorldEvents } from '../src/life/desktop-conflict.ts';
import { PRESENCE_KIND, PRESENCE_VERSION } from '../src/life/desktop-presence.ts';
import { describeNight, lastNight, type NightDesktopTurn } from '../src/life/nights.ts';
import { classesOn, stateAt, wakeTime } from '../src/life/schedule.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import { DESKTOP_CALLED, herNowModule } from '../src/modules/her-now.ts';
import type { Contact } from '../src/platform/config.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { actionQueue, settlingWorld } from '../src/world/action-queue.ts';
import type { LifeEvent } from '../src/world/life-events.ts';
import { lifeExecutor, type LifeSources } from '../src/world/life-selector.ts';
import { worldAt, worldState } from '../src/world/world.ts';
import { syntheticCardPath, syntheticCardPattern } from './fixtures/card.ts';

// ADR 0347 第 3 层 F 块「作息冲突」（方案 §2.6，开关 desktopConflict）。全部用合成角色，数据目录用临时目录。
const card = loadCharacterCard(syntheticCardPath('boyfriend'));
const schedule = card.schedule!;
const herWorld = card.herWorld!;
const HIM = 10001;
const OTHER = 10002;
const MIN = 60_000;
const t = (text: string) => new Date(`${text}+08:00`);
const ms = (text: string) => t(text).getTime();
const turn = (userAt: string, at: string, user = '帮我看下这个报错', assistant = '我看看'): NightDesktopTurn => ({ userAt: ms(userAt), at: ms(at), user, assistant });
/** from 到 to 每 step 分钟一轮（他说一句、她回一句，回合 1 分钟） */
const turnsEvery = (from: string, to: string, step = 10): NightDesktopTurn[] => {
    const turns: NightDesktopTurn[] = [];
    for (let at = ms(from); at <= ms(to); at += step * MIN) turns.push({ userAt: at - MIN, at, user: `他第${turns.length}句：D:\\work\\secret-project 里那个文件`, assistant: `她第${turns.length}句` });
    return turns;
};
const stateOf = (at: Date) => stateAt(schedule, at);

describe('昨晚：半夜被他叫上电脑（nights.ts，realNights + desktopConflict）', () => {
    // 同 nights.test.ts：起床时间带浮动的设定补到合成卡上
    const jittered = { ...schedule, wake: { ...schedule.wake, jitter: { from: '2026-10-26', spreadMin: 40, weekendMin: 60 } } };
    let early: { day: Date; wake: Date } | undefined;
    for (let d = 3; d < 30 && !early; d++) {
        const day = new Date(2026, 10, d);
        const wake = wakeTime(jittered, day, classesOn(jittered, day).lessons);
        if (wake.getHours() < 8) early = { day, wake };
    }
    const { day, wake } = early!;
    const at = (h: number, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m);
    const morning = at(10);
    const desktopTurns = (fromH: number, fromM: number, toH: number, toM: number): NightDesktopTurn[] => {
        const turns: NightDesktopTurn[] = [];
        for (let x = at(fromH, fromM).getTime(); x <= at(toH, toM).getTime(); x += 10 * MIN) turns.push({ userAt: x - MIN, at: x, user: '醒醒', assistant: '？你最好有事' });
        return turns;
    };

    test('不给桌面回合、给了空的：和原来逐字一样', () => {
        const his: StoredMessage[] = [{ time: at(1, 40).toISOString(), role: 'assistant', content: '我睡了 晚安' }];
        const plain = lastNight([{ qq: HIM, messages: his }], HIM, jittered, morning);
        assert.deepEqual(lastNight([{ qq: HIM, messages: his }], HIM, jittered, morning, { turns: [], byDuration: true }), plain);
        assert.deepEqual(lastNight([{ qq: HIM, messages: his }], HIM, jittered, morning, { turns: desktopTurns(15, 0, 16, 0).map(x => ({ ...x, at: x.at - 86_400_000, userAt: x.userAt! - 86_400_000 })), byDuration: true }), plain, '前一天下午的不算');
    });

    test('3:00 被他叫上电脑陪到 3:20：算被他吵醒、扣 45 分钟、写明被叫上电脑陪到几点', () => {
        const night = lastNight([{ qq: HIM, messages: [] }], HIM, jittered, morning, { turns: desktopTurns(3, 0, 3, 20), byDuration: true })!;
        assert.equal(night.woken?.byHim, true);
        assert.equal(night.woken?.at, at(3, 0).getTime());
        assert.equal(night.woken?.desktop?.until, at(3, 20).getTime());
        const expected = (wake.getTime() - at(2).getTime()) / 3_600_000 - 0.75;
        assert.ok(Math.abs(night.hours - expected) < 0.1, `${night.hours} vs ${expected}`);
        assert.match(describeNight(night), /昨晚 2:00 睡、半夜 3:00 被他叫上电脑、陪到 3:20/);
    });

    test('陪了两个小时（3:00–5:00）：开了按时长扣就扣两小时，没开还是 45 分钟', () => {
        const turns = desktopTurns(3, 0, 5, 0);
        const long = lastNight([{ qq: HIM, messages: [] }], HIM, jittered, morning, { turns, byDuration: true })!;
        const fixed = lastNight([{ qq: HIM, messages: [] }], HIM, jittered, morning, { turns })!;
        const base = (wake.getTime() - at(2).getTime()) / 3_600_000;
        // 第一轮他 2:59 开口，到 5:00 是 121 分钟
        assert.ok(Math.abs(long.hours - (base - 121 / 60)) < 0.1, `${long.hours}`);
        assert.ok(Math.abs(fixed.hours - (base - 0.75)) < 0.1, `${fixed.hours}`);
        assert.ok(long.hours < fixed.hours);
    });

    test('在电脑上说「睡了」算她说的；说完以后又被叫上去才算吵醒', () => {
        const said = [{ userAt: at(0, 50).getTime(), at: at(0, 55).getTime(), user: '睡吧', assistant: '嗯 睡了 晚安' }];
        const night = lastNight([{ qq: HIM, messages: [] }], HIM, jittered, morning, { turns: said, byDuration: true })!;
        assert.equal(night.said, true);
        assert.equal(night.withHim, true, '睡前在电脑上跟他聊');
        assert.equal(night.woken, undefined);
        assert.match(describeNight(night), /昨晚 0:55 睡（跟他聊到那会儿）/);
    });

    test('作息上 2:00 该睡了还在电脑上陪他到 3:30：写在电脑上陪他到几点，扣到 3:30', () => {
        const night = lastNight([{ qq: HIM, messages: [] }], HIM, jittered, morning, { turns: desktopTurns(1, 0, 3, 30), byDuration: true })!;
        assert.equal(night.woken?.desktop?.stayedUp, true);
        assert.match(describeNight(night), /昨晚 2:00 睡、在电脑上陪他到 3:30/);
        const base = (wake.getTime() - at(2).getTime()) / 3_600_000;
        assert.ok(Math.abs(night.hours - (base - 1.5)) < 0.1, `${night.hours}`);
    });

    test('被别人在 QQ 上吵醒在先：不算电脑那一段吵醒的，但电脑上陪的时长照扣', () => {
        const other: StoredMessage[] = [{ time: at(2, 40).toISOString(), role: 'assistant', content: '干嘛啊' }];
        const night = lastNight([{ qq: HIM, messages: [] }, { qq: OTHER, messages: other }], HIM, jittered, morning, { turns: desktopTurns(3, 0, 4, 30), byDuration: true })!;
        assert.equal(night.woken?.byHim, false);
        assert.equal(night.woken?.desktop, undefined);
        assert.match(describeNight(night), /被消息吵醒过一次/);
        const base = (wake.getTime() - at(2).getTime()) / 3_600_000;
        assert.ok(Math.abs(night.hours - (base - 91 / 60)) < 0.1, `${night.hours}`);
    });
});

describe('桌面那几段占着她的时间（desktopBusySpans → LifeSources.desktopBusy）', () => {
    test('结束了的一段从他开口到最后一轮；还在陪着的算到现在；短于 10 分钟的不算', () => {
        const turns = [...turnsEvery('2026-10-13T15:30:00', '2026-10-13T16:40:00'), turn('2026-10-13T19:00:00', '2026-10-13T19:02:00')];
        const done = desktopBusySpans({ turns, now: ms('2026-10-13T20:00:00') });
        assert.deepEqual(done.map(s => [s.start.getTime(), s.end.getTime()]), [[ms('2026-10-13T15:29:00'), ms('2026-10-13T16:40:00')]]);
        const ongoing = desktopBusySpans({ turns: turnsEvery('2026-10-13T15:30:00', '2026-10-13T15:50:00'), now: ms('2026-10-13T15:55:00') });
        assert.deepEqual(ongoing.map(s => [s.start.getTime(), s.end.getTime()]), [[ms('2026-10-13T15:29:00'), ms('2026-10-13T15:55:00')]]);
        assert.deepEqual(desktopBusySpans({ turns: [turn('2026-10-13T15:30:00', '2026-10-13T15:31:00')], now: ms('2026-10-13T15:35:00') }), [], '说两句不算');
    });

    test('租约作数、还没有回合：从租约开始算到现在；未来的回合不信', () => {
        const lease = { kind: PRESENCE_KIND, version: PRESENCE_VERSION, session: 's1', startedAt: t('2026-10-13T15:00:00').toISOString(), renewedAt: t('2026-10-13T15:28:00').toISOString(), ttlMs: 5 * MIN };
        const spans = desktopBusySpans({ turns: [turn('2026-10-13T18:00:00', '2026-10-13T18:30:00')], lease, now: ms('2026-10-13T15:30:00') });
        assert.deepEqual(spans.map(s => [s.start.getTime(), s.end.getTime()]), [[ms('2026-10-13T15:00:00'), ms('2026-10-13T15:30:00')]]);
    });
});

describe('生活选择器：空闲时被叫上电脑，排着的空闲活动停在那一刻（life-selector 的 desktopBusy）', () => {
    const withDir = (run: (dir: string) => void) => {
        const dir = mkdtempSync(join(tmpdir(), 'desktop-conflict-'));
        try { run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
    };
    const plain: LifeSources = { schedule, plans: herWorld.plans, books: card.books, worldAt: time => worldAt(herWorld, schedule, time), events: () => [] };
    /** 每 10 分钟推一次；回合在 at 那一刻才「收进来」（和线上 30 秒收一次相当）；每次推完按 desktopWorldEvents 记世界事件 */
    function live(dir: string, start: Date, end: Date, turns: readonly NightDesktopTurn[] | undefined) {
        let clock = start.getTime();
        const logs: string[] = [];
        const ledger = worldState(herWorld, schedule, message => logs.push(message), join(dir, 'world'), () => clock);
        const queue = actionQueue(join(dir, 'world', 'action-queue.json'), message => logs.push(message));
        const world = settlingWorld(ledger, queue, () => clock);
        const seen = () => (turns ?? []).filter(x => x.at <= clock);
        const executor = lifeExecutor({
            ...plain, worldAt: time => world.at(herWorld, schedule, time), events: () => ledger.events(),
            ...(turns ? { desktopBusy: () => desktopBusySpans({ turns: seen(), now: clock }) } : {}),
        }, queue, { since: start, log: message => logs.push(message) });
        for (; clock <= end.getTime(); clock += 10 * MIN) {
            executor.fill(new Date(clock));
            world.events();
            if (turns) ledger.recordEvents(desktopWorldEvents({ turns: seen(), now: clock, stateAt: stateOf, events: ledger.events(), pending: queue.pending(), contact: HIM }));
        }
        return { all: world.events(), life: world.events().filter(e => e.id.startsWith('life:')), logs };
    }
    const overlapping = (events: readonly LifeEvent[], from: string, to: string) =>
        events.filter(e => e.result !== 'failed' && Date.parse(e.startedAt) < ms(to) && Date.parse(e.endedAt) > ms(from));

    test('不传 desktopBusy：和原来一样（同一份事件账）', () => withDir(a => withDir(b => {
        const before = live(a, t('2026-10-13T12:00:00'), t('2026-10-13T20:00:00'), undefined).all;
        const empty = live(b, t('2026-10-13T12:00:00'), t('2026-10-13T20:00:00'), []).all;
        assert.deepEqual(empty, before);
    })));

    test('15:29–16:40 在电脑上陪他：正在做的空闲活动停在 15:29（做了的那段算数），这段不排别的；结束 45 分钟后记一件「陪他（电脑上）」', () => withDir(dir => {
        const turns = turnsEvery('2026-10-13T15:30:00', '2026-10-13T16:40:00');
        const { all, life } = live(dir, t('2026-10-13T12:00:00'), t('2026-10-13T20:00:00'), turns);
        const stopped = life.find(e => e.endedAt === t('2026-10-13T15:29:00').toISOString());
        assert.deepEqual([stopped?.kind, stopped?.result], ['leisure', 'succeeded'], '停下是 shorten（做完了那段），不是打断');
        assert.deepEqual(overlapping(life, '2026-10-13T15:29:00', '2026-10-13T16:40:00'), [], '这段不排她自己的事');
        assert.ok(life.some(e => e.startedAt === t('2026-10-13T16:40:00').toISOString()), '陪完接着过');
        const desktop = all.filter(e => e.id.startsWith(DESKTOP_EVENT_PREFIX));
        assert.equal(desktop.length, 1);
        assert.deepEqual([desktop[0]!.kind, desktop[0]!.subject, desktop[0]!.source, desktop[0]!.startedAt, desktop[0]!.endedAt, desktop[0]!.contact],
            ['leisure', DESKTOP_SUBJECT, 'external', t('2026-10-13T15:29:00').toISOString(), t('2026-10-13T16:40:00').toISOString(), HIM]);
        assert.doesNotMatch(JSON.stringify(desktop), /secret|work|他第|她第/, '世界事件里没有桌面原文');
    }));

    test('会话结束前不记事件；上课的那部分不记（课照样上）；记过的不再记', () => {
        const turns = turnsEvery('2026-10-13T13:00:00', '2026-10-13T15:20:00');
        const now = ms('2026-10-13T15:30:00');
        assert.deepEqual(desktopWorldEvents({ turns, now, stateAt: stateOf, events: [] }), [], '还没过 45 分钟');
        const later = ms('2026-10-13T16:30:00');
        const drafts = desktopWorldEvents({ turns, now: later, stateAt: stateOf, events: [] });
        // 13:30–14:50 在上形势与政策：分成课前、课后两件
        assert.deepEqual(drafts.map(d => [d.startedAt, d.at]), [
            [t('2026-10-13T12:59:00').toISOString(), t('2026-10-13T13:30:00').toISOString()],
            [t('2026-10-13T14:50:00').toISOString(), t('2026-10-13T15:20:00').toISOString()],
        ]);
        const known = drafts.map(d => ({ ...d, actor: 'linmengyao', day: '2026-10-13', endedAt: d.at, startedAt: d.startedAt! }) as unknown as LifeEvent);
        assert.deepEqual(desktopWorldEvents({ turns, now: later, stateAt: stateOf, events: known }), []);
        // 只看开关打开以后开始的会话
        assert.deepEqual(desktopWorldEvents({ turns, now: later, stateAt: stateOf, events: [], since: ms('2026-10-13T14:00:00') }), []);
    });

    test('有别的事占着的分钟让出来（饭、说了睡了以后的觉）；租约说他还在就再等等', () => {
        const turns = turnsEvery('2026-10-13T16:00:00', '2026-10-13T17:00:00');
        const later = ms('2026-10-13T18:00:00');
        const eat = { id: 'life:eat', actor: 'linmengyao', kind: 'eat', day: '2026-10-13', startedAt: t('2026-10-13T16:20:00').toISOString(), endedAt: t('2026-10-13T16:40:00').toISOString(), source: 'simulation', result: 'succeeded' } as LifeEvent;
        const drafts = desktopWorldEvents({ turns, now: later, stateAt: stateOf, events: [eat] });
        assert.deepEqual(drafts.map(d => [d.startedAt, d.at]), [
            [t('2026-10-13T15:59:00').toISOString(), t('2026-10-13T16:20:00').toISOString()],
            [t('2026-10-13T16:40:00').toISOString(), t('2026-10-13T17:00:00').toISOString()],
        ]);
        const pendingSleep = [{ event: { startedAt: t('2026-10-13T15:00:00').toISOString(), at: t('2026-10-14T07:40:00').toISOString(), result: 'succeeded' as const } }];
        assert.deepEqual(desktopWorldEvents({ turns, now: later, stateAt: stateOf, events: [], pending: pendingSleep }), []);
        assert.deepEqual(desktopWorldEvents({ turns, now: later, stateAt: stateOf, events: [], asleep: () => true }), []);
        const lease = { kind: PRESENCE_KIND, version: PRESENCE_VERSION, session: 's', startedAt: t('2026-10-13T15:59:00').toISOString(), renewedAt: t('2026-10-13T17:58:00').toISOString(), ttlMs: 5 * MIN };
        assert.deepEqual(desktopWorldEvents({ turns, lease, now: later, stateAt: stateOf, events: [] }), []);
    });

    test('在电脑上帮他做过事（时间线里 desktop 渠道的动作）：记 work_on_project，target 不算进任何项目', () => {
        const turns = turnsEvery('2026-10-13T16:00:00', '2026-10-13T17:00:00');
        const drafts = desktopWorldEvents({ turns, now: ms('2026-10-13T18:00:00'), stateAt: stateOf, events: [], did: [ms('2026-10-13T16:30:00')] });
        assert.deepEqual(drafts.map(d => [d.kind, d.target, d.subject]), [['work_on_project', DESKTOP_TARGET, DESKTOP_SUBJECT]]);
        const outside = desktopWorldEvents({ turns, now: ms('2026-10-13T18:00:00'), stateAt: stateOf, events: [], did: [ms('2026-10-13T12:00:00')] });
        assert.deepEqual(outside.map(d => d.kind), ['leisure']);
    });
});

describe('被他叫上电脑（desktopCalled → her-now）', () => {
    test('开始时在上课 / 该睡了 / 已经说过睡了才有；空闲、他不在都没有', () => {
        const at = (text: string) => ({ turns: [turn(text, text)], now: ms(text) + MIN, stateAt: stateOf });
        assert.deepEqual(desktopCalled(at('2026-10-14T15:30:00')), { overlaps: 'class', since: ms('2026-10-14T15:30:00') });
        assert.equal(desktopCalled(at('2026-10-14T03:00:00'))?.overlaps, 'sleep');
        assert.equal(desktopCalled(at('2026-10-13T16:00:00')), undefined);
        assert.equal(desktopCalled({ ...at('2026-10-14T15:30:00'), now: ms('2026-10-14T16:30:00') }), undefined, '他已经走了');
        const bedtime = ms('2026-10-13T23:30:00');
        assert.equal(desktopCalled({ ...at('2026-10-13T23:50:00'), asleep: when => Boolean(asleepSince(schedule, [bedtime], when)) })?.overlaps, 'sleep');
    });

    const tier = loadTierCard(syntheticCardPattern, 'boyfriend').character;
    const amin: Contact = { qq: 1, name: '阿明', tier: 'boyfriend' };
    const zhou: Contact = { qq: 2, name: '小周', tier: 'classmate' };
    const base = { schedule: true, herDays: true, history: () => [], log: () => {} };
    const turnOf = (contact: Contact, at: Date): Turn => ({ contact, at, history: [], thinking: false, card: tier, facts: {} });
    const run = (module: Module, x: Turn) => { module.perceive!(x); return module.contribute!(x) as Piece[]; };
    const states = (pieces: readonly Piece[]) => pieces.filter(piece => piece.slot === 'state').map(piece => piece.text);

    test('不给：和原来逐字一样；给了：男朋友档状态行后面多一句事实，同学档没有', () => {
        const at = t('2026-10-14T15:40:00');
        const plain = run(herNowModule(base), turnOf(amin, at));
        assert.deepEqual(run(herNowModule({ ...base, desktopCalled: () => undefined }), turnOf(amin, at)), plain);
        const called = herNowModule({ ...base, desktopCalled: () => ({ overlaps: 'class', since: ms('2026-10-14T15:30:00') }) });
        const pieces = run(called, turnOf(amin, at));
        assert.deepEqual(states(pieces), [...states(plain), DESKTOP_CALLED.class]);
        assert.deepEqual(pieces.filter(piece => piece.slot !== 'state'), plain.filter(piece => piece.slot !== 'state'));
        assert.deepEqual(run(called, turnOf(zhou, at)), run(herNowModule(base), turnOf(zhou, at)));
    });

    test('本来该睡了：刚叫上去 10 分钟以内和 QQ 上被吵醒一样（开了 realNights 带起床气），之后只剩那句事实', () => {
        const since = ms('2026-10-14T03:00:00');
        const module = (realNights: boolean) => herNowModule({ ...base, realNights, desktopCalled: () => ({ overlaps: 'sleep', since }) });
        const fresh = states(run(module(true), turnOf(amin, t('2026-10-14T03:05:00'))));
        assert.match(fresh[0]!, /被消息震醒了，迷迷糊糊的，有点起床气/);
        assert.equal(fresh[1], DESKTOP_CALLED.sleep);
        assert.doesNotMatch(states(run(module(false), turnOf(amin, t('2026-10-14T03:05:00'))))[0]!, /起床气/);
        const later = states(run(module(true), turnOf(amin, t('2026-10-14T03:30:00'))));
        assert.doesNotMatch(later[0]!, /震醒/);
        assert.equal(later[1], DESKTOP_CALLED.sleep);
    });

    test('desktopNight 给了：身体那一行的昨晚算上半夜被叫上电脑', () => {
        const history = (): StoredMessage[] => [];
        const nightTurns = turnsEvery('2026-10-14T03:00:00', '2026-10-14T05:00:00');
        const at = t('2026-10-14T10:00:00');
        const plainNight = run(herNowModule({ ...base, realNights: true, history }), turnOf(amin, at)).find(p => p.slot === 'body')?.text ?? '';
        const withDesk = run(herNowModule({ ...base, realNights: true, history, desktopNight: () => nightTurns }), turnOf(amin, at)).find(p => p.slot === 'body')?.text ?? '';
        assert.doesNotMatch(plainNight, /电脑/);
        assert.match(withDesk, /半夜 3:00 被他叫上电脑、陪到 5:00/);
        assert.doesNotMatch(withDesk, /secret|他第/, '身体那一行不带桌面原文');
        // 同学档不看
        assert.doesNotMatch(run(herNowModule({ ...base, realNights: true, history, desktopNight: () => nightTurns }), turnOf(zhou, at)).find(p => p.slot === 'body')?.text ?? '', /电脑/);
    });
});
