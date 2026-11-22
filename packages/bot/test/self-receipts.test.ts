import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { SelfPending, SelfReceipt } from '../src/life/self-types.ts';
import { consumeSelfReceipts, parseSelfReceipt, thoughtSaid, THOUGHT_TOLD_MIN, type SelfReceiptPlanner } from '../src/memory/self-receipts.ts';
import { pendingIntents, similarity, type InnerThought } from '../src/proactive/inner.ts';
import { blockReason, candidatesOn, ELSEWHERE_REASON, untoldNews, withInner, type NewsItem, type ProactiveInput } from '../src/proactive/proactive.ts';
import { createProactivePlanner, SELF_PENDING_MAX, type Planner, type PlannerDeps } from '../src/proactive/proactive-planner.ts';
import { readProactiveState, validProactiveState, type ProactiveState } from '../src/proactive/proactive-state.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { syntheticCardPath } from './fixtures/card.ts';

// ADR 0347 第 2 层：攒着想跟他说的（pendingForSelf）+ 桌面回执落地（方案 二、2 / 二、5，测试 四、1，变异 四、3 第 6 条）
const boyfriend = loadCharacterCard(syntheticCardPath('boyfriend'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const thought = (at: number, text: string, goes: InnerThought['goes'] = 'tell', told = false): InnerThought => ({ id: `th-${at}`, at: iso(at), text, goes, ...(told ? { told: true as const } : {}) });
const camera: NewsItem = { id: 'camera:2026-10-05', kind: 'camera', day: '2026-10-05', at: t(10, 5, 13, 30), what: '在城南的二手相机店买到了二手相机' };
const followUp = { id: 'f-1', what: '字节的面试', date: '2026-10-05', time: '16:00', episode: `ep-${t(10, 4, 20)}` };
const later = { id: 'f-2', what: '体检', date: '2026-10-07', time: 'morning', episode: `ep-${t(10, 4, 21)}` };

const dirs: string[] = [];
const planners: Planner[] = [];
afterEach(() => {
    planners.splice(0).forEach(p => p.stop());
    dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true }));
});
const fixture = () => { const dir = mkdtempSync(join(tmpdir(), 'qqbot-self-receipts-')); dirs.push(dir); return dir; };

/** 一个开了内心、有她那边的事的计划器；状态文件先写好（lastThinkAt = 此刻，不会去想） */
function setup(seed: Partial<ProactiveState> & { thoughts?: InnerThought[] } = {}, patch: Partial<PlannerDeps> = {}) {
    const dir = fixture();
    const now = t(10, 5, 14, 5);
    const { thoughts = [thought(t(10, 5, 14), '他昨天说的那个面试不知道怎么样了', 'ask')], ...rest } = seed;
    const state: ProactiveState = { version: 1, records: [], followUps: [followUp, later], extracted: {}, inner: { thoughts, lastThinkAt: iso(now) }, ...rest };
    const path = join(dir, '10001-boyfriend.json');
    writeFileSync(path, JSON.stringify(state));
    const logs: string[] = [];
    let crisis = false;
    const planner = createProactivePlanner({
        dir, contact: { qq: 10001, name: '阿明', tier: 'boyfriend' }, schedule,
        settings: withInner({ ...boyfriend.proactive!, occasions: ['inner'], dailyMax: 4, unansweredMax: 2 }), dates: [], mode: 'on',
        names: { char: boyfriend.name, user: '阿明' }, now: () => now, history: { load: () => [] },
        responder: { initiate: async () => assert.fail('不应发消息') }, log: m => logs.push(m), inner: true,
        news: () => [camera], crisisPaused: () => crisis,
        waitUntil: (_at, signal) => new Promise(done => signal.addEventListener('abort', () => done(), { once: true })),
        ...patch,
    });
    planners.push(planner);
    return { dir, path, now, planner, logs, state: () => readProactiveState(path), setCrisis: (on: boolean) => { crisis = on; } };
}

describe('pendingForSelf：攒着想跟他说的', () => {
    test('念头、她那边的事、到日子的待跟进；新的在前；没到日子的待跟进不出', () => {
        const { planner, now } = setup();
        assert.deepEqual(planner.pendingForSelf(now), [
            { id: `inner:th-${t(10, 5, 14)}`, kind: 'inner', goes: 'ask', text: '他昨天说的那个面试不知道怎么样了', since: iso(t(10, 5, 14)) },
            { id: 'news:camera:2026-10-05', kind: 'news', text: camera.what, since: iso(camera.at) },
            { id: 'followUp:f-1', kind: 'followUp', text: '字节的面试', since: iso(t(10, 4, 20)) },
        ]);
    });

    test('说过的、自己想想的、超过 6 小时的念头不出；最多 4 件', () => {
        const old = thought(t(10, 5, 7), '早上的念头太久了');
        const kept = thought(t(10, 5, 13), '自己想想的事', 'keep');
        const told = thought(t(10, 5, 12), '已经说过的念头', 'tell', true);
        const fresh = [thought(t(10, 5, 13, 40), '第一个想说的'), thought(t(10, 5, 13, 50), '第二个想说的'), thought(t(10, 5, 13, 55), '第三个想说的')];
        const { planner, now } = setup({ thoughts: [old, kept, told, ...fresh] });
        const ids = planner.pendingForSelf(now).map(p => p.id);
        assert.equal(SELF_PENDING_MAX, 4);
        assert.deepEqual(ids, [`inner:th-${t(10, 5, 13, 55)}`, `inner:th-${t(10, 5, 13, 50)}`, `inner:th-${t(10, 5, 13, 40)}`, 'news:camera:2026-10-05']);
        assert.equal(planner.pendingForSelf(now, Infinity).length, 5);
    });

    test('elsewhere 里的事不出；QQ 上那之后聊过的、主动发过的也不出；照片类不出；危机暂停时为空', () => {
        const { planner, now, setCrisis } = setup({ elsewhere: { 'camera:2026-10-05': iso(t(10, 5, 13, 40)) } });
        assert.ok(!planner.pendingForSelf(now).some(p => p.kind === 'news'));
        const chatted = setup({}, { history: { load: () => [{ time: iso(t(10, 5, 13, 45)), role: 'assistant', content: '嗯' }] } });
        assert.ok(!chatted.planner.pendingForSelf(chatted.now).some(p => p.kind === 'news'));
        const sent = setup({ records: [{ id: '2026-10-05:news:camera:2026-10-05', occasion: 'news', plannedAt: iso(t(10, 5, 13, 40)), at: iso(t(10, 5, 13, 40)), result: 'sent' }] });
        assert.ok(!sent.planner.pendingForSelf(sent.now).some(p => p.kind === 'news'));
        const photo = setup({}, { news: () => [{ id: 'cat_photo:2026-10-05', kind: 'cat_photo', day: '2026-10-05', at: t(10, 5, 13), what: '给猫拍了张照片' }], settings: withInner({ ...boyfriend.proactive!, occasions: ['inner'], dailyMax: 4, unansweredMax: 2, newsKinds: ['cat_photo'] }) });
        assert.ok(!photo.planner.pendingForSelf(photo.now).some(p => p.kind === 'news'));
        setCrisis(true);
        assert.deepEqual(planner.pendingForSelf(now), []);
    });
});

describe('状态：elsewhere', () => {
    test('旧文件没有 elsewhere 照常读；坏的拒绝；没有时写出的文件不带这一项', () => {
        assert.ok(validProactiveState({ version: 1, records: [], followUps: [], extracted: {} }));
        assert.ok(validProactiveState({ version: 1, records: [], followUps: [], extracted: {}, elsewhere: { 'camera:2026-10-05': iso(t(10, 5, 13)) } }));
        for (const elsewhere of [[], { 'camera:x': '2026-10-05' }, { '': iso(t(10, 5, 13)) }, { 'a\u0001': iso(t(10, 5, 13)) }, 'x']) {
            assert.equal(validProactiveState({ version: 1, records: [], followUps: [], extracted: {}, elsewhere }), false, JSON.stringify(elsewhere));
        }
        const { planner, path } = setup();
        planner.markAskedElsewhere('f-1');
        assert.ok(!('elsewhere' in JSON.parse(readFileSync(path, 'utf8'))));
    });

    test('markNewsElsewhere 落盘、按 KEEP_DAYS 修剪；blockReason / untoldNews / 排期都查它', () => {
        const { planner, state } = setup({ elsewhere: { 'camera:2026-09-01': iso(t(9, 1, 12)) } });
        assert.equal(planner.toldElsewhere(camera.id), false);
        assert.equal(planner.markNewsElsewhere(camera.id, new Date(t(10, 5, 14))), true);
        assert.equal(planner.markNewsElsewhere(camera.id, new Date(t(10, 5, 14))), false, '记过的不再记');
        assert.equal(planner.markNewsElsewhere('x', new Date(NaN)), false, '坏时间不写（写了会让计划器暂停）');
        assert.equal(planner.toldElsewhere(camera.id), true);
        assert.deepEqual(state().elsewhere, { [camera.id]: iso(t(10, 5, 14)) }, '30 天前的修剪掉');

        const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
            qq: 10001, schedule, settings: { ...boyfriend.proactive!, occasions: ['news', 'bedtime'], dailyMax: 3 }, dates: [], history: [], records: [], mode: 'on', news: [camera], ...patch,
        });
        const day = new Date(2026, 9, 5);
        const [c] = candidatesOn(day, input()).filter(x => x.occasion === 'news');
        assert.ok(c);
        assert.equal(blockReason(c, c.at, input()), undefined);
        assert.equal(blockReason(c, c.at, input({ elsewhere: state().elsewhere })), ELSEWHERE_REASON);
        assert.equal(candidatesOn(day, input({ elsewhere: state().elsewhere })).filter(x => x.occasion === 'news').length, 0);
        const bedtime = candidatesOn(day, input()).find(x => x.occasion === 'bedtime')!;
        assert.deepEqual(untoldNews(bedtime, t(10, 5, 23), input()), [camera]);
        assert.deepEqual(untoldNews(bedtime, t(10, 5, 23), input({ elsewhere: state().elsewhere })), []);
    });
});

describe('回执：念头的门槛（宁可漏判）', () => {
    // 合成样例：[念头, 她在桌面上回的, 算不算说出口了]
    const samples: [string, string, boolean][] = [
        ['今天食堂的饭好难吃', '今天食堂的饭真的好难吃，我都没吃完', true],
        ['他昨天说的那个面试不知道怎么样了', '你昨天说的那个面试怎么样了？', true],
        ['好想吃火锅啊', '突然好想吃火锅', true],
        ['那本书看到一半有点看不下去了', '那本书我看到一半就看不下去了', true],
        ['想问他周末要不要一起去看电影', '嗯嗯。周末要不要一起去看电影呀', true],
        ['楼下那只猫今天又来蹭我了', '楼下那只猫今天又跑来蹭我腿了', true],
        ['今天食堂的饭好难吃', '今天食堂人好多，挤死了', false],
        ['今天食堂的饭好难吃', '我今天去食堂了', false],
        ['他昨天说的那个面试不知道怎么样了', '你昨天几点睡的呀', false],
        ['好想吃火锅啊', '好想睡觉啊', false],
        ['那本书看到一半有点看不下去了', '你看过那本书吗', false],
        ['想问他周末要不要一起去看电影', '周末你有空吗', false],
        ['楼下那只猫今天又来蹭我了', '今天又下雨了', false],
        ['他最近好像很累的样子', '最近好冷啊', false],
        ['他最近好像很累的样子', '哈哈哈哈哈哈', false],
        ['想他了', '想他了', false],
    ];
    test('合成样例：说出口的认、没说到的不认', () => {
        for (const [idea, said, want] of samples) assert.equal(thoughtSaid(said, idea), want, `${idea} ← ${said}`);
    });
    test('门槛上下各一个：0.6 以上算、刚好在下面不算（方案的 0.3 会误判）', () => {
        const idea = '他最近好像很累的样子';
        const below = '最近好冷啊';
        assert.ok(similarity(below, idea) >= 0.3 && similarity(below, idea) < THOUGHT_TOLD_MIN, String(similarity(below, idea)));
        assert.equal(thoughtSaid(below, idea), false);
        const above = '你最近好像很累的样子';
        assert.ok(similarity(above, idea) >= THOUGHT_TOLD_MIN);
        assert.equal(thoughtSaid(above, idea), true);
    });
});

describe('回执：解析', () => {
    const now = t(10, 5, 14, 5);
    const ok: SelfReceipt = { v: 1, id: '0f8fad5b-d9cb-469f-a165-70867728950e', at: iso(t(10, 5, 14, 4)), selfAt: iso(t(10, 5, 14)), shown: ['inner:th-1', 'news:camera:2026-10-05'], said: '嗯\n今天买到相机了' };
    test('合格的原样（去重 shown）；坏的跳过', () => {
        assert.deepEqual(parseSelfReceipt({ ...ok, shown: [...ok.shown, 'inner:th-1'] }, now), ok);
        for (const bad of [
            { ...ok, v: 2 }, { ...ok, id: 'short' }, { ...ok, at: 'x' }, { ...ok, at: iso(now + 5 * 60_000) }, { ...ok, selfAt: iso(t(10, 5, 15)) },
            { ...ok, shown: [] }, { ...ok, shown: ['other:1'] }, { ...ok, shown: 'inner:th-1' }, { ...ok, said: '   ' }, { ...ok, said: 3 }, null, [],
        ]) assert.equal(parseSelfReceipt(bad, now), undefined, JSON.stringify(bad));
        assert.equal([...parseSelfReceipt({ ...ok, said: '字'.repeat(700) }, now)!.said].length, 600);
    });
});

describe('回执：消费', () => {
    const fake = (pending: SelfPending[], ready = true) => {
        const calls: string[] = [];
        const planner: SelfReceiptPlanner = {
            pendingForSelf: () => pending, selfReady: () => ready,
            markTold: id => { calls.push(`told ${id}`); return true; },
            markAskedElsewhere: id => { calls.push(`asked ${id}`); return true; },
            markNewsElsewhere: (id, at) => { calls.push(`news ${id} ${at.toISOString()}`); return true; },
        };
        return { planner, calls };
    };
    const pending: SelfPending[] = [
        { id: 'inner:th-1', kind: 'inner', goes: 'tell', text: '今天食堂的饭好难吃', since: iso(t(10, 5, 12)) },
        { id: 'inner:th-2', kind: 'inner', goes: 'tell', text: '楼下那只猫今天又来蹭我了', since: iso(t(10, 5, 12)) },
        { id: 'news:camera:2026-10-05', kind: 'news', text: camera.what, since: iso(camera.at) },
        { id: 'followUp:f-1', kind: 'followUp', text: '字节的面试', since: iso(t(10, 4, 20)) },
        { id: 'followUp:f-3', kind: 'followUp', text: '体检', since: iso(t(10, 4, 20)) },
    ];
    const row = (id: string, at: number, shown: string[], said: string) => JSON.stringify({ v: 1, id: `receipt-${id}-0000`, at: iso(at), selfAt: iso(at - 60_000), shown, said }) + '\n';
    const files = () => { const dir = fixture(); return { file: join(dir, 'self-receipts.jsonl'), stateFile: join(dir, 'memory', 'self-receipts-state.json') }; };

    test('只认 shown 里的；不在待说清单的跳过；念头看门槛、待跟进看 mentions、她那边的事放过就算；日志只记数', () => {
        const { file, stateFile } = files();
        const now = new Date(t(10, 5, 14, 5));
        writeFileSync(file, row('a', t(10, 5, 14), ['inner:th-1', 'inner:th-2', 'news:camera:2026-10-05', 'followUp:f-1', 'followUp:f-3', 'inner:th-gone'], '今天食堂的饭真的好难吃！面试那边有消息没'));
        const { planner, calls } = fake(pending);
        const logs: string[] = [];
        const counts = consumeSelfReceipts({ file, stateFile, planner, now, log: m => logs.push(m) });
        assert.deepEqual(calls, ['told th-1', `news camera:2026-10-05 ${iso(t(10, 5, 14))}`, 'asked f-1'], '按 shown 的先后');
        assert.deepEqual(counts, { receipts: 1, inner: 1, followUp: 1, news: 1 });
        assert.deepEqual(logs, ['回执：读了 1 行，桌面上说过了 3 件（念头 1 / 待跟进 1 / 她那边的事 1；不记内容）']);
        assert.ok(!logs.join('').includes('食堂'));
        // 没放给她看的，碰巧说到了也不算
        appendFileSync(file, row('b', t(10, 5, 14, 1), ['followUp:f-3'], '楼下那只猫今天又来蹭我了'));
        const second = fake(pending);
        consumeSelfReceipts({ file, stateFile, planner: second.planner, now, log: () => {} });
        assert.deepEqual(second.calls, [], '体检没说到、念头 th-2 没放给她看');
    });

    test('坏行跳过、重复 id 不再落、未来时间停在原行、计划器没准备好时不读', () => {
        const { file, stateFile } = files();
        const now = t(10, 5, 14, 5);
        writeFileSync(file, '{坏的\n' + row('a', t(10, 5, 14), ['news:camera:2026-10-05'], '嗯') + row('a', t(10, 5, 14), ['news:camera:2026-10-05'], '嗯')
            + row('c', now + 30_000, ['news:camera:2026-10-05'], '嗯'));
        const notReady = fake(pending, false);
        assert.equal(consumeSelfReceipts({ file, stateFile, planner: notReady.planner, now: new Date(now), log: () => {} }).receipts, 0);
        assert.deepEqual(notReady.calls, []);
        const first = fake(pending);
        assert.equal(consumeSelfReceipts({ file, stateFile, planner: first.planner, now: new Date(now), log: () => {} }).receipts, 1);
        assert.equal(first.calls.length, 1);
        assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).line, 3, '停在未来那一行');
        const after = fake(pending);
        assert.equal(consumeSelfReceipts({ file, stateFile, planner: after.planner, now: new Date(now + 60_000), log: () => {} }).receipts, 1);
        assert.equal(after.calls.length, 1, '到点后才落');
    });

    test('落地出错停在原行，下轮重来', () => {
        const { file, stateFile } = files();
        const now = new Date(t(10, 5, 14, 5));
        writeFileSync(file, row('a', t(10, 5, 14), ['news:camera:2026-10-05'], '嗯'));
        const broken = fake(pending);
        broken.planner.markNewsElsewhere = () => { throw new Error('写不进'); };
        const logs: string[] = [];
        assert.equal(consumeSelfReceipts({ file, stateFile, planner: broken.planner, now, log: m => logs.push(m) }).receipts, 0);
        assert.ok(logs.some(m => m.startsWith('桌面回执：') && m.includes('应用失败')));
        const retry = fake(pending);
        assert.equal(consumeSelfReceipts({ file, stateFile, planner: retry.planner, now, log: () => {} }).receipts, 1);
    });
});

describe('回执落到计划器（真计划器，端到端）', () => {
    test('桌面上说出口的念头：打 told、落盘，inner 时机 blockReason「那个念头已经过去了」；没说到的念头照旧会发', () => {
        const idea = thought(t(10, 5, 14), '今天食堂的饭好难吃');
        const other = thought(t(10, 5, 14, 1), '楼下那只猫今天又来蹭我了');
        const { planner, state, now, dir } = setup({ thoughts: [idea, other] });
        const file = join(dir, 'self-receipts.jsonl');
        writeFileSync(file, JSON.stringify({ v: 1, id: 'receipt-e2e-0001', at: iso(now - 60_000), selfAt: iso(now - 120_000), shown: [`inner:${idea.id}`, `inner:${other.id}`, 'news:camera:2026-10-05', 'followUp:f-1'], said: '今天食堂的饭真的好难吃，我都没吃完。对了你面试怎么样了' }) + '\n');
        const counts = consumeSelfReceipts({ file, stateFile: join(dir, 'state.json'), planner, now: new Date(now), log: () => {} });
        assert.deepEqual(counts, { receipts: 1, inner: 1, followUp: 1, news: 1 });

        const saved = state();
        assert.equal(saved.inner!.thoughts.find(x => x.id === idea.id)!.told, true);
        assert.equal(saved.inner!.thoughts.find(x => x.id === other.id)!.told, undefined);
        assert.deepEqual(saved.followUps.map(f => f.id), ['f-2']);
        assert.deepEqual(Object.keys(saved.elsewhere ?? {}), [camera.id]);
        assert.deepEqual(planner.pendingForSelf(now).map(p => p.id), [`inner:${other.id}`]);

        const on = withInner({ ...boyfriend.proactive!, occasions: ['inner'], dailyMax: 4, unansweredMax: 2 });
        const input = (inner: InnerThought[]): ProactiveInput => ({ qq: 10001, schedule, settings: on, dates: [], history: [], records: [], mode: 'on', inner });
        const day = new Date(2026, 9, 5);
        const candidate = (x: InnerThought) => candidatesOn(day, input([x])).find(c => c.occasion === 'inner' && c.inner!.id === x.id)!;
        const left = pendingIntents(saved.inner!.thoughts, now);
        assert.equal(blockReason(candidate(idea), candidate(idea).at, input(left)), '那个念头已经过去了（说过了，或者过期了）');
        assert.equal(blockReason(candidate(other), candidate(other).at, input(left)), undefined);
    });
});
