import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import { moodySkip } from '../src/social/reply-timing.ts';
import {
    answerWhy, createSilenceWatcher, currentNote, DEFAULT_THRESHOLDS, explain, kindOfSkip, kindOfWaiting, MAX_NOTICES_PER_STREAK, noteFromInfo,
    recentSilence, recordSilence, shouldNotify, silencePath, unansweredStreak, type NoticeState, type SilenceNote,
} from '../src/social/silence.ts';

const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-silence-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const T0 = Date.parse('2026-10-29T14:00:00+08:00');
const min = (n: number) => n * 60_000;
const msg = (role: 'user' | 'assistant', at: number, content = 'x'): StoredMessage => ({ time: new Date(at).toISOString(), role, content });

describe('没回的原因归类（ADR 0173）：谁的决定 —— 作息 / 她自己 / 故障', () => {
    test('等到几点才看到（reply-timing 给的话）：睡觉、上课、忙、冷场', () => {
        assert.equal(kindOfWaiting('睡着了，被连着来的消息吵醒'), 'asleep');
        assert.equal(kindOfWaiting('说了睡了，在睡觉，起床后看'), 'asleep');
        assert.equal(kindOfWaiting('在上高数课'), 'class');
        assert.equal(kindOfWaiting('在洗澡'), 'busy');
        assert.equal(kindOfWaiting('正聊着'), 'lag');
        assert.equal(kindOfWaiting('冷场，过一会儿才看到'), 'lag');
        assert.equal(kindOfWaiting('冷场，过一会儿才看到；在做别的，12 分钟才看到'), 'lag');
    });

    test('看到了决定不回：已经收尾 / 看心情；认不出的按她的决定算。用 reply-timing 真正产生的那句话防「文案改了这里没跟着改」', () => {
        assert.equal(kindOfSkip('她已经收尾，对方只回了附和，不回'), 'closing');
        // 真的跑一遍 moodySkip：她刚回过，他连着发几个「哈哈」，概率定成 1
        const history = [msg('assistant', T0), msg('user', T0 + 5_000, '哈哈'), msg('user', T0 + 9_000, '嗯嗯')];
        const real = moodySkip(history, 1, 1);
        assert.ok(real, 'moodySkip 应该给出原因');
        assert.equal(kindOfSkip(real!), 'moody');
        assert.equal(kindOfSkip('别的什么原因'), 'declined');
    });

    test('每一类都标明是谁的决定；响应器的回调信息变成记账的一条', () => {
        assert.deepEqual(noteFromInfo({ phase: 'waiting', reason: '在上高数课', seenAt: T0 + min(30) }, T0), { at: T0, kind: 'class', by: 'schedule', reason: '在上高数课', until: T0 + min(30) });
        assert.equal(noteFromInfo({ phase: 'skipped', reason: '看心情没回' }, T0).by, 'her');
        const retry = noteFromInfo({ phase: 'retry', reason: '回复失败：连不上', retryAt: T0 + min(5), failures: 2 }, T0);
        assert.deepEqual([retry.kind, retry.by, retry.until, retry.failures], ['failing', 'system', T0 + min(5), 2]);
        assert.equal(noteFromInfo({ phase: 'gaveUp', reason: 'x', failures: 3 }, T0).until, undefined);
    });
});

describe('连着没回', () => {
    test('她最后一次回复之后他发的条数；没有就 undefined；她的消息不算', () => {
        assert.equal(unansweredStreak([]), undefined);
        assert.equal(unansweredStreak([msg('user', T0), msg('assistant', T0 + 1000)]), undefined);
        const streak = unansweredStreak([msg('user', T0), msg('assistant', T0 + 1000), msg('user', T0 + min(2)), msg('user', T0 + min(3))]);
        assert.deepEqual(streak, { count: 2, firstAt: T0 + min(2), lastAt: T0 + min(3) });
        assert.equal(unansweredStreak([msg('user', T0), msg('user', T0 + 1)])!.count, 2, '她从没回过也算');
    });

    test('通知时机：条数够、第一条过了 8 分钟；一串同一种原因只说一次；原因变了才再说，一串最多 3 次；新的一串重新算', () => {
        const streak = { count: 2, firstAt: T0, lastAt: T0 + 1000 };
        const none: NoticeState = {};
        assert.equal(shouldNotify(undefined, 'lag', none, T0 + min(60)), false);
        assert.equal(shouldNotify({ ...streak, count: 1 }, 'lag', none, T0 + min(60)), false, '只有一条不算连着');
        assert.equal(shouldNotify(streak, 'lag', none, T0 + min(7)), false, '还不到 8 分钟');
        assert.equal(shouldNotify(streak, 'lag', none, T0 + DEFAULT_THRESHOLDS.minAgeMs), true);
        assert.equal(shouldNotify(streak, 'lag', { firstAt: T0, kinds: ['lag'] }, T0 + min(30)), false, '同一串同一种原因说过了');
        assert.equal(shouldNotify(streak, 'failing', { firstAt: T0, kinds: ['lag'] }, T0 + min(30)), true, '原因变成故障要再说');
        const full: NoticeState = { firstAt: T0, kinds: ['lag', 'failing', 'unknown'] };
        assert.equal(full.kinds!.length, MAX_NOTICES_PER_STREAK);
        assert.equal(shouldNotify(streak, 'asleep', full, T0 + min(30)), false, '一串最多 3 次');
        assert.equal(shouldNotify({ ...streak, firstAt: T0 + min(100) }, 'lag', full, T0 + min(120)), true, '新的一串重新算');
    });
});

describe('说给他听：说清是谁的决定，查不到就老实说查不到', () => {
    const streak = { count: 3, firstAt: T0, lastAt: T0 + min(2) };
    const ctx = { now: T0 + min(10), streak };

    test('作息 / 节奏：说明「这是作息，不是故障」，带上几点看到', () => {
        const text = explain({ at: ctx.now, kind: 'asleep', by: 'schedule', reason: '在睡觉', until: T0 + min(400) }, ctx);
        assert.match(text, /^（你有 3 条消息她还没回（最早一条是 10 分钟前）：她在睡觉，约 \d\d:\d\d 看到，会接着回。这是作息，不是故障。）$/);
        assert.match(explain({ at: ctx.now, kind: 'class', by: 'schedule', reason: '在上高数课', until: T0 + min(50) }, ctx), /她在上课，约 \d\d:\d\d 看到。这是作息，不是故障/);
        assert.match(explain({ at: ctx.now, kind: 'lag', by: 'schedule', reason: '冷场，过一会儿才看到', until: T0 + min(15) }, ctx), /这是她的节奏，不是故障/);
    });

    test('她自己的决定：明说是她选的、不是故障，并告诉他怎么办', () => {
        assert.match(explain({ at: ctx.now, kind: 'moody', by: 'her', reason: 'x' }, ctx), /她看到了，选择先不回.*这是她自己的决定，不是故障；隔一分钟再发一条她一定回/);
        assert.match(explain({ at: ctx.now, kind: 'closing', by: 'her', reason: 'x' }, ctx), /她选择不回。这是她自己的决定；换个新话题她就会回/);
        assert.match(explain({ at: ctx.now, kind: 'declined', by: 'her', reason: '今天不想聊这个' }, ctx), /选择先不回（今天不想聊这个）。这是她自己的决定/);
    });

    test('故障：说明是故障、不是她不想回；还会重试就说几点再试，不会就说等下一条', () => {
        assert.match(explain({ at: ctx.now, kind: 'failing', by: 'system', reason: '回复失败：连不上', until: T0 + min(15), failures: 2 }, ctx), /她回不了：回复失败：连不上；已经连着失败 2 次，约 \d\d:\d\d 再试。这是故障（多半是网络 \/ 模型），不是她不想回/);
        assert.match(explain({ at: ctx.now, kind: 'failing', by: 'system', reason: 'x', failures: 3 }, ctx), /这一轮不再自动重试，等你下一条消息再回/);
    });

    test('查不到原因：老实说查不到，不编一个；休眠、工作模式各有各的说法', () => {
        const unknown = explain({ at: ctx.now, kind: 'unknown', by: 'system', reason: '没有记录到原因' }, ctx);
        assert.match(unknown, /我这边查不到她没回的明确原因/);
        assert.match(unknown, /过了十分钟还没动静，很可能掉线了/);
        assert.doesNotMatch(unknown, /在睡觉|在上课|选择/, '不能编一个原因');
        assert.match(explain({ at: ctx.now, kind: 'dormant', by: 'system', reason: 'x' }, ctx), /发 \/唤醒/);
        assert.match(explain({ at: ctx.now, kind: 'working', by: 'system', reason: 'x' }, ctx), /工作模式里帮你干活.*\/QQ/);
    });

    test('由响应器此刻的状态定当前原因：休眠 > 工作 > 等待 > 重试 > 跳过 > 放弃 > 在生成 > 查不到', () => {
        const now = T0 + min(10);
        const idle = { phase: 'idle', failures: 0 };
        assert.equal(currentNote(idle, { now, dormant: true }).kind, 'dormant');
        assert.equal(currentNote(idle, { now, working: true }).kind, 'working');
        assert.equal(currentNote({ phase: 'waiting', reason: '在上课', seenAt: now + 1000, failures: 0 }, { now }).kind, 'class');
        assert.equal(currentNote({ phase: 'retry', reason: '回复失败', retryAt: now + 1000, failures: 1 }, { now }).kind, 'failing');
        assert.equal(currentNote({ ...idle, skipped: { at: now, reason: '看心情没回' } }, { now }).kind, 'moody');
        const gaveUp = currentNote({ phase: 'idle', failures: 2 }, { now });
        assert.deepEqual([gaveUp.kind, gaveUp.failures], ['failing', 3], '放弃重试后实际失败了 failures + 1 次');
        assert.equal(currentNote({ phase: 'generating', failures: 0 }, { now }).kind, 'generating');
        assert.equal(currentNote(idle, { now }).kind, 'unknown');
    });
});

describe('记账', () => {
    const note = (over: Partial<SilenceNote> = {}): SilenceNote => ({ at: T0, kind: 'class', by: 'schedule', reason: '在上课', ...over });

    test('追加、最新的在前；一分钟内同一条不重复记；坏行跳过', () => {
        const dir = tmp();
        recordSilence(dir, 7, note());
        recordSilence(dir, 7, note({ at: T0 + 30_000 }));
        assert.equal(recentSilence(dir, 7).length, 1, '一分钟内同类同原因不重复');
        recordSilence(dir, 7, note({ at: T0 + min(5), kind: 'failing', by: 'system', reason: '连不上' }));
        appendFileSync(silencePath(dir, 7), '{坏掉的一行\n');
        const list = recentSilence(dir, 7);
        assert.deepEqual(list.map(n => n.kind), ['failing', 'class']);
        assert.deepEqual(recentSilence(dir, 99), []);
    });

    test('文件长了只留最近的', () => {
        const dir = tmp();
        const pad = '长'.repeat(150);
        // 修剪条件：文件超过 60 KB 并且超过 300 行（只留最近 300 行）
        for (let i = 0; i < 320; i++) recordSilence(dir, 7, note({ at: T0 + i * min(2), reason: `原因${i}${pad}` }));
        const lines = readFileSync(silencePath(dir, 7), 'utf8').split('\n').filter(Boolean);
        assert.ok(lines.length < 320, `修剪过：${lines.length} 行`);
        assert.ok(lines.length >= 20, '不是全删了');
        assert.match(recentSilence(dir, 7, 1)[0]!.reason, /^原因319长/);
    });
});

describe('看着他的消息：该通知就通知', () => {
    function setup(initial: StoredMessage[], status: { phase: string; seenAt?: number; reason?: string; retryAt?: number; failures?: number; skipped?: { at: number; reason: string } } = { phase: 'idle', failures: 0 }) {
        const dir = tmp();
        const state = { now: T0, history: initial, status, external: {} as { dormant?: boolean; working?: boolean } };
        const told: string[] = [];
        const logs: string[] = [];
        const make = () => createSilenceWatcher({ dataDir: dir, qq: 7, now: () => state.now, history: () => state.history, status: () => state.status, external: () => state.external, tell: text => told.push(text), log: m => logs.push(m) });
        return { dir, state, told, logs, make };
    }

    test('他连发两条、她在上课没回：到 8 分钟说一次（作息，不是故障）；再 tick 不重复；她回了之后新的一串又能说', () => {
        const { state, told, make, dir } = setup([msg('user', T0, '在吗'), msg('user', T0 + 1000, '人呢')], { phase: 'waiting', reason: '在上高数课', seenAt: T0 + min(50), failures: 0 });
        const watcher = make();
        state.now = T0 + min(3);
        assert.equal(watcher.tick(), false);
        state.now = T0 + min(9);
        assert.equal(watcher.tick(), true);
        assert.equal(told.length, 1);
        assert.match(told[0]!, /^（你有 2 条消息她还没回.*她在上课，约 \d\d:\d\d 看到。这是作息，不是故障。）$/);
        state.now = T0 + min(20);
        assert.equal(watcher.tick(), false, '同一串同一种原因不重复');
        assert.equal(recentSilence(dir, 7)[0]!.kind, 'class', '说的同时记了账');
        // 她回了
        state.history = [...state.history, msg('assistant', T0 + min(51), '刚下课')];
        state.status = { phase: 'idle', failures: 0 };
        state.now = T0 + min(60);
        assert.equal(watcher.tick(), false);
        // 新的一串
        state.history = [...state.history, msg('user', T0 + min(70)), msg('user', T0 + min(71))];
        state.now = T0 + min(85);
        assert.equal(watcher.tick(), true, '新的一串重新算');
    });

    test('同一串里原因变成故障：再说一次；重启（新 watcher、同一个数据目录）不重复说已经说过的', () => {
        const { state, told, make } = setup([msg('user', T0), msg('user', T0 + 1000)], { phase: 'waiting', reason: '冷场，过一会儿才看到', seenAt: T0 + min(15), failures: 0 });
        const watcher = make();
        state.now = T0 + min(9);
        assert.equal(watcher.tick(), true);
        state.status = { phase: 'retry', reason: '回复失败：连不上', retryAt: state.now + min(5), failures: 1 };
        state.now = T0 + min(12);
        assert.equal(watcher.tick(), true);
        assert.match(told[1]!, /这是故障（多半是网络 \/ 模型），不是她不想回/);
        // 重启：新 watcher 读同一份「通知过」的记录
        const restarted = make();
        state.now = T0 + min(14);
        assert.equal(restarted.tick(), false, '重启后不重复轰炸');
        assert.equal(told.length, 2);
    });

    test('查不到原因的时候（她没在等也没在生成）：照实说查不到，而不是不说', () => {
        const { state, told, make } = setup([msg('user', T0), msg('user', T0 + 1000)]);
        state.now = T0 + min(9);
        assert.equal(make().tick(), true);
        assert.match(told[0]!, /我这边查不到她没回的明确原因/);
    });

    test('休眠 / 工作模式的原因来自外部', () => {
        const dormant = setup([msg('user', T0), msg('user', T0 + 1000)]);
        dormant.state.external = { dormant: true };
        dormant.state.now = T0 + min(9);
        dormant.make().tick();
        assert.match(dormant.told[0]!, /她在休眠，发 \/唤醒/);
        const working = setup([msg('user', T0), msg('user', T0 + 1000)]);
        working.state.external = { working: true };
        working.state.now = T0 + min(9);
        working.make().tick();
        assert.match(working.told[0]!, /工作模式里帮你干活/);
    });

    test('/为什么：有没回的说现在的原因（不看条数和时间门槛）；没有就说回过了，有记录的话带上上一次', () => {
        const withStreak = setup([msg('user', T0)], { phase: 'waiting', reason: '在洗澡', seenAt: T0 + min(8), failures: 0 });
        withStreak.state.now = T0 + min(2);
        assert.match(answerWhy({ dataDir: withStreak.dir, qq: 7, now: () => withStreak.state.now, history: () => withStreak.state.history, status: () => withStreak.state.status, external: () => ({}) }), /她在忙（在洗澡）/);

        const fresh = setup([msg('user', T0), msg('assistant', T0 + 1000)]);
        const ask = () => answerWhy({ dataDir: fresh.dir, qq: 7, now: () => fresh.state.now, history: () => fresh.state.history, status: () => fresh.state.status, external: () => ({}) });
        assert.equal(ask(), '（你的消息她都回过了，也没有记录到她没回的情况。）');
        recordSilence(fresh.dir, 7, { at: T0, kind: 'moody', by: 'her', reason: '看心情没回' });
        const text = ask();
        assert.match(text, /^（你的消息她都回过了。最近一次没马上回是 .*：她看到了，选择先不回.*这是她自己的决定，不是故障/);
        assert.equal(text.endsWith('）'), true);
    });
});

describe('检查文件落盘的位置', () => {
    test('通知状态和账都在数据目录下，不碰别处', () => {
        const dir = tmp();
        recordSilence(dir, 5, { at: T0, kind: 'lag', by: 'schedule', reason: '冷场' });
        writeFileSync(join(dir, 'probe.txt'), 'x');
        assert.ok(silencePath(dir, 5).startsWith(dir));
    });
});
