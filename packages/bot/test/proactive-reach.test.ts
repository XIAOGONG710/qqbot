import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import {
    blockReason, candidatesOn, DEFAULT_REACH, occasionNote, planFrom, REACH_DECLINE, REACH_MAX_PER_DAY, unansweredGate, withReach,
    type Candidate, type ProactiveInput, type ProactiveRecord,
} from '../src/proactive/proactive.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// ADR 0100：他没回也继续找他、可以催他一下（配置 proactiveReach）。用转换器生成的真卡（男朋友档）；国庆假期 10-05 没有课，起床 09:30
const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const HOUR = 3_600_000;
let nextId = 1;
const user = (time: number, content = '在吗'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'user', content, messageId: nextId++ });
const her = (time: number, content = '早安'): StoredMessage => ({ time: new Date(time).toISOString(), role: 'assistant', content, messageId: nextId++ });
const record = (id: string, at: number, result: ProactiveRecord['result'] = 'sent'): ProactiveRecord => ({
    id, occasion: id.split(':')[1] as ProactiveRecord['occasion'], plannedAt: new Date(at).toISOString(), at: new Date(at).toISOString(), result,
});
const off = boyfriend.proactive!;
const on = withReach(boyfriend.proactive!);
const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({
    qq: 10001, schedule, settings: on, dates: boyfriend.dates, history: [], records: [], mode: 'on', ...patch,
});
const day = new Date(2026, 9, 5);
const reachOf = (list: Candidate[]) => list.filter(c => c.occasion === 'reach');
/** 他前一晚说过话，今天早安 10:00 发了没回 */
const morningUnanswered = () => ({
    history: [user(t(10, 4, 22, 0), '晚上好'), her(t(10, 4, 22, 1), '嗯嗯'), her(t(10, 5, 10, 0), '早呀')],
    records: [record('2026-10-05:morning', t(10, 5, 10, 0))],
});

describe('没回也继续：节流闸', () => {
    test('没开：没回到 unansweredMax 条就停到他回（原来的样子）；开了：还能再发，但要隔够', () => {
        const state = morningUnanswered();
        assert.equal(planFrom(t(10, 5, 10, 30), input({ ...state, settings: off })).paused !== undefined, true);
        assert.deepEqual(unansweredGate(input({ ...state, settings: off }), day), { count: 1, blocked: '上一条主动消息他还没回' });
        const gate = unansweredGate(input(state), day);
        assert.equal(gate.count, 1);
        assert.equal(gate.blocked, undefined);
        assert.equal(gate.notBefore, t(10, 5, 12, 0), '第二条隔 2 小时');
        assert.equal(planFrom(t(10, 5, 10, 30), input(state)).paused, undefined);
    });

    test('第二条没回再隔 4 小时，第三条没回（到 cap）就停；他一回话就重新算', () => {
        const two = { history: [...morningUnanswered().history, her(t(10, 5, 12, 10), '在吗')], records: [...morningUnanswered().records, record('2026-10-05:reach:1', t(10, 5, 12, 10))] };
        assert.equal(unansweredGate(input(two), day).notBefore, t(10, 5, 16, 10), '第三条隔 4 小时');
        const three = { history: [...two.history, her(t(10, 5, 16, 20), '人呢')], records: [...two.records, record('2026-10-05:reach:2', t(10, 5, 16, 20))] };
        assert.equal(DEFAULT_REACH.cap, 3);
        assert.equal(unansweredGate(input(three), day).blocked, '上一条主动消息他还没回');
        assert.ok(planFrom(t(10, 5, 17, 0), input(three)).paused);
        // 他回了：没回的条数归零
        const replied = { ...three, history: [...three.history, user(t(10, 5, 17, 5), '刚看到'), her(t(10, 5, 17, 6), '哼')] };
        const back = unansweredGate(input(replied), day);
        assert.equal(back.count, 0);
        assert.equal(back.blocked, undefined);
    });

    test('开了以后，别的时机也不早于“隔够了”的时刻；日子不受限制', () => {
        const state = morningUnanswered();
        const list = candidatesOn(day, input(state));
        for (const c of list.filter(c => c.occasion !== 'dates')) assert.ok(c.at >= t(10, 5, 12, 0), `${c.occasion} ${new Date(c.at).toTimeString().slice(0, 5)}`);
        const withDate = candidatesOn(new Date(2026, 8, 29), input({ history: [user(t(9, 28, 21, 0))], records: [record('2026-09-29:morning', t(9, 29, 10, 0))] }));
        assert.ok(withDate.length > 0);
    });

    test('到点再查一遍：没隔够就不发（带原因）；到顶不发', () => {
        const state = morningUnanswered();
        const reach = reachOf(candidatesOn(day, input(state)))[0]!;
        assert.ok(reach);
        assert.equal(blockReason({ ...reach, at: t(10, 5, 11, 0) }, t(10, 5, 11, 0), input(state)), '他还没回，离上一条主动消息隔得不够久');
        assert.equal(blockReason(reach, reach.at, input(state)), undefined);
    });
});

describe('没回也继续：reach 时机', () => {
    test('他没回、没到顶时有一个 reach：不早于隔够的时刻、起床后 1 小时、不晚于 22:30；没开 / 他回过 / 没有没回的都没有', () => {
        const state = morningUnanswered();
        const [reach] = reachOf(candidatesOn(day, input(state)));
        assert.ok(reach);
        assert.equal(reach.id, '2026-10-05:reach:1');
        assert.ok(reach.at >= t(10, 5, 12, 0) && reach.at < t(10, 5, 12, 31), new Date(reach.at).toTimeString());
        assert.deepEqual(reach.reach, { count: 1 });
        assert.equal(reachOf(candidatesOn(day, input({ ...state, settings: off }))).length, 0, '没开');
        assert.equal(reachOf(candidatesOn(day, input())).length, 0, '没有没回的');
        assert.equal(reachOf(candidatesOn(day, input({ ...state, history: [...state.history, user(t(10, 5, 10, 5), '早')] }))).length, 0, '他回过了');
        // 太晚了：上一条是 21:00 发的，下一条最早 23:00 以后，超过 22:30 就这一天没有
        const late = { history: [user(t(10, 4, 22, 0)), her(t(10, 5, 21, 0))], records: [record('2026-10-05:bedtime', t(10, 5, 21, 0))] };
        assert.equal(reachOf(candidatesOn(day, input(late))).length, 0);
    });

    test('想过的（发了、决定不发、被挡掉的）都算一次：下一次至少隔 1 小时、编号 +1；一天最多 REACH_MAX_PER_DAY 次；等着重试的不算', () => {
        const base = morningUnanswered();
        const declined = [...base.records, record('2026-10-05:reach:1', t(10, 5, 12, 20), 'skipped')];
        const [next] = reachOf(candidatesOn(day, input({ ...base, records: declined })));
        assert.ok(next);
        assert.equal(next.id, '2026-10-05:reach:2');
        assert.ok(next.at >= t(10, 5, 13, 20), '决定不发之后至少隔 1 小时再想');
        const many = [...base.records, record('2026-10-05:reach:1', t(10, 5, 12, 20), 'skipped'), record('2026-10-05:reach:2', t(10, 5, 13, 30), 'skipped'), record('2026-10-05:reach:3', t(10, 5, 14, 40), 'skipped')];
        assert.equal(REACH_MAX_PER_DAY, 3);
        assert.equal(reachOf(candidatesOn(day, input({ ...base, records: many }))).length, 0);
        const retry: ProactiveRecord = { ...record('2026-10-05:reach:1', t(10, 5, 12, 20), 'failed'), retryAt: new Date(t(10, 5, 12, 35)).toISOString(), tries: 1 };
        assert.equal(reachOf(candidatesOn(day, input({ ...base, records: [...base.records, retry] })))[0]!.id, '2026-10-05:reach:1', '等着重试的不算一次');
    });

    test('reach 到点还要查：他回过了、太晚了、他刚说过去睡了 / 去忙了都不催', () => {
        const state = morningUnanswered();
        const reach = reachOf(candidatesOn(day, input(state)))[0]!;
        assert.equal(blockReason({ ...reach, at: t(10, 5, 22, 40) }, t(10, 5, 22, 40), input(state)), '太晚了，不催他');
        // 他前一晚说了晚安：12 小时内不催
        const goodnight = { ...state, history: [user(t(10, 5, 0, 50), '我先睡了，晚安'), her(t(10, 5, 0, 51), '晚安'), her(t(10, 5, 10, 0), '早呀')] };
        assert.equal(blockReason(reach, reach.at, input(goodnight)), '他说过去睡了 / 去忙了，不催');
        // 超过 12 小时了就不算
        const old = { ...goodnight, history: [user(t(10, 4, 20, 0), '我先睡了，晚安'), her(t(10, 4, 20, 1), '晚安'), her(t(10, 5, 10, 0), '早呀')] };
        assert.equal(blockReason(reach, reach.at, input(old)), undefined);
    });

    test('他没回的这段时间里，“随口说件事”和“冷场”交给 reach；他回过 / 没开时照旧；reach 排在早安之前（名额不够时先留它）', () => {
        const state = morningUnanswered();
        const ids = (list: Candidate[]) => list.map(c => c.occasion);
        assert.ok(!ids(candidatesOn(day, input(state))).some(o => o === 'share' || o === 'quiet'));
        assert.ok(ids(candidatesOn(day, input())).includes('share'), '没有没回的：照旧');
        assert.ok(ids(candidatesOn(day, input({ ...state, settings: off }))).includes('share'), '没开：照旧');
        const tight = input({ ...state, settings: { ...on, dailyMax: 2 } });
        const plan = planFrom(t(10, 5, 10, 30), tight);
        assert.equal(plan.upcoming[0]?.occasion, 'reach', '只剩一个名额时给 reach');
    });

    test('withReach：加上 reach 时机和默认的节流设置，不改原对象；已经有的设置不覆盖', () => {
        assert.ok(!off.occasions.includes('reach'));
        assert.ok(on.occasions.includes('reach') && on.occasions.length === off.occasions.length + 1);
        assert.deepEqual(on.reach, DEFAULT_REACH);
        assert.deepEqual(withReach({ ...off, reach: { cap: 5, gapsMs: [HOUR] } }).reach, { cap: 5, gapsMs: [HOUR] });
        assert.equal(withReach(on).occasions.filter(o => o === 'reach').length, 1);
    });
});

describe('没回也继续：聊着聊着他没再理她最后一句回复', () => {
    // 10:00 他说了话，10:01 她回了；之后他没再说话（她一条主动的都还没发）
    const chatting = { history: [user(t(10, 5, 10, 0), '今天好无聊'), her(t(10, 5, 10, 1), '我也是，在宿舍躺着')], records: [] as ProactiveRecord[] };

    test('开了：她最后一句回复之后隔 1.5 小时，她可以想想要不要接着聊；没开 / 她最后一句是收尾 / 他还没说过话都不算', () => {
        const gate = unansweredGate(input(chatting), day);
        assert.deepEqual({ count: gate.count, replied: gate.replied, since: gate.since, notBefore: gate.notBefore }, { count: 0, replied: true, since: t(10, 5, 10, 1), notBefore: t(10, 5, 11, 31) });
        assert.deepEqual(unansweredGate(input({ ...chatting, settings: off }), day), { count: 0 }, '没开');
        assert.deepEqual(unansweredGate(input({ history: [user(t(10, 5, 10, 0)), her(t(10, 5, 10, 1), '晚安，早点睡')], records: [] }), day), { count: 0 }, '收尾不算');
        assert.deepEqual(unansweredGate(input({ history: [her(t(10, 5, 10, 1), '早')], records: [] }), day), { count: 0 }, '他还没说过话（别的时机管）');
        assert.deepEqual(unansweredGate(input({ history: [her(t(10, 5, 10, 1), '嗯'), user(t(10, 5, 10, 2))], records: [] }), day), { count: 0 }, '最后一句是他的');
    });

    test('reach 候选：不早于隔够的时刻、同一个“她的一天”里；别的时机不被推后；share / quiet 交给它；到点还要查（没隔够、他说过去忙了不催）', () => {
        const list = candidatesOn(day, input(chatting));
        const [reach] = reachOf(list);
        assert.ok(reach);
        assert.deepEqual(reach.reach, { count: 0, replied: true });
        assert.ok(reach.at >= t(10, 5, 11, 31) && reach.at < t(10, 5, 12, 2), new Date(reach.at).toTimeString());
        assert.ok(!list.some(c => c.occasion === 'share' || c.occasion === 'quiet'));
        const base = candidatesOn(day, input({ ...chatting, settings: off }));
        const bedtime = (l: Candidate[]) => l.find(c => c.occasion === 'bedtime')!.at;
        assert.equal(bedtime(list), bedtime(base), '别的时机不动');
        assert.equal(blockReason({ ...reach, at: t(10, 5, 11, 15) }, t(10, 5, 11, 15), input(chatting)), '离她最后一句回复还没隔够');
        assert.equal(blockReason(reach, reach.at, input(chatting)), undefined);
        const busy = { history: [user(t(10, 5, 10, 0), '我去洗澡了'), her(t(10, 5, 10, 1), '好哦')], records: [] as ProactiveRecord[] };
        assert.equal(blockReason(reach, reach.at, input(busy)), '他说过去睡了 / 去忙了，不催');
        // 超过 12 小时 / 隔天了不再用：交还给 share / quiet
        const stale = { history: [user(t(10, 4, 20, 0)), her(t(10, 4, 20, 1), '好呀')], records: [] as ProactiveRecord[] };
        assert.equal(reachOf(candidatesOn(day, input(stale))).length, 0);
    });

    test('发了一条以后接上原来的节流：下一条隔 2 小时、第三条再隔 4 小时，到 cap 停', () => {
        const sent = { history: [...chatting.history, her(t(10, 5, 12, 0), '在吗')], records: [record('2026-10-05:reach:1', t(10, 5, 12, 0))] };
        const gate = unansweredGate(input(sent), day);
        assert.equal(gate.count, 1);
        assert.equal(gate.replied, undefined);
        assert.equal(gate.notBefore, t(10, 5, 14, 0));
    });

    test('提示词：接着聊或轻轻戳一下，没有脾气；可以只输出「不发」', () => {
        const note = occasionNote({ id: '2026-10-05:reach:1', occasion: 'reach', day: '2026-10-05', at: 0, reason: 'x', reach: { count: 0, replied: true } }, '宝宝');
        assert.ok(note.includes('你们刚才在聊天') && note.includes('接着聊') && note.includes(`只输出「${REACH_DECLINE}」两个字`), note);
        assert.ok(!note.includes('小脾气') && !note.includes('好几次'), note);
        assert.ok(note.endsWith('只发一两句，像平时随手发的消息。]'), note);
    });
});

describe('没回也继续：他消失好几天', () => {
    test('他最后一次说话是前天或更早：每多一整天多放一条（最多 REACH_EXTRA_DAYS 条），所以她每天还会说声早安；昨天不算', () => {
        // 三条都没回（昨天 10:00 / 12:20 / 16:20 发的），他上一次说话是 10-03 晚上
        const records = [record('2026-10-04:morning', t(10, 4, 10, 0)), record('2026-10-04:reach:1', t(10, 4, 12, 20)), record('2026-10-04:reach:2', t(10, 4, 16, 20))];
        const history = [user(t(10, 3, 22, 0), '晚上好'), her(t(10, 4, 10, 0)), her(t(10, 4, 12, 20)), her(t(10, 4, 16, 20))];
        const gate = (d: Date, extra: Partial<ProactiveInput> = {}) => unansweredGate(input({ history, records, ...extra }), d);
        // 10-04（他前一天说的话，昨天不算）：cap 3，到顶
        assert.equal(gate(new Date(2026, 9, 4)).blocked, '上一条主动消息他还没回');
        // 10-05：他上次说话是前天，多放一条
        assert.equal(gate(new Date(2026, 9, 5)).blocked, undefined);
        assert.ok(gate(new Date(2026, 9, 5)).notBefore! < t(10, 5, 9, 0), '隔夜早就隔够了');
        // 10-05 她又发了一条之后到顶；10-06 再多放一条；10-08 起最多加 3 条
        const four = { history: [...history, her(t(10, 5, 10, 0))], records: [...records, record('2026-10-05:morning', t(10, 5, 10, 0))] };
        assert.equal(gate(new Date(2026, 9, 5), four).blocked, '上一条主动消息他还没回');
        assert.equal(gate(new Date(2026, 9, 6), four).blocked, undefined);
        assert.equal(gate(new Date(2026, 9, 20), four).blocked, undefined, '上限是 cap + REACH_EXTRA_DAYS = 6，这里才 4 条');
        const six = { history: [...history, ...[10, 11, 12].map(h => her(t(10, 5, h, 0)))], records: [...records, ...[10, 11, 12].map(h => record(`2026-10-05:reach:${h}`, t(10, 5, h, 0)))] };
        assert.equal(gate(new Date(2026, 9, 30), six).blocked, '上一条主动消息他还没回', '6 条是上限，再久也不加');
        // 把没开 reach 的卡放在一边：不放宽
        assert.equal(gate(new Date(2026, 9, 6), { settings: off }).blocked, '上一条主动消息他还没回');
    });
});

describe('没回也继续：提示词', () => {
    const candidate = (count: number): Candidate => ({ id: '2026-10-05:reach:1', occasion: 'reach', day: '2026-10-05', at: 0, reason: '他一直没回', reach: { count } });

    test('催的方向按这一条轮换（同一条每次一样、不同的条能抽到不同的方向）：避免每次都是同一种说法', () => {
        const notes = new Set(Array.from({ length: 40 }, (_, i) => occasionNote({ ...candidate(1), id: `2026-10-${String(i + 1).padStart(2, '0')}:reach:1` }, '宝宝')));
        assert.ok(notes.size >= 3, String(notes.size));
        assert.equal(occasionNote(candidate(1), '宝宝'), occasionNote(candidate(1), '宝宝'));
        const later = new Set(Array.from({ length: 40 }, (_, i) => occasionNote({ ...candidate(2), id: `2026-10-${String(i + 1).padStart(2, '0')}:reach:2` }, '宝宝')));
        assert.ok(later.size >= 3, String(later.size));
    });

    test('第一次轻轻戳一下、第二次起带点小脾气；都可以只输出「不发」；不再写“不抱怨没回”；不给台词', () => {
        const first = occasionNote(candidate(1), '宝宝');
        assert.ok(first.includes('催他理你一下') && first.includes('轻轻的') && first.includes(`只输出「${REACH_DECLINE}」两个字`), first);
        assert.ok(!first.includes('不抱怨对方没找你'), '催他那一种本来就是在说他没回');
        assert.ok(first.endsWith('只发一两句，像平时随手发的消息。]'), first);
        const second = occasionNote(candidate(2), '宝宝');
        assert.ok(second.includes('小脾气') && second.includes('傲娇') && second.includes('不威胁') && second.includes('别和前面发过的话重复') && second.includes(REACH_DECLINE), second);
        assert.ok(!/在吗|人呢|回我|哼/.test(first + second), '只给方向，不引用台词');
        assert.ok(second.includes('连开头也别一样'), second);
        // 别的时机的说明不变
        const morning = occasionNote({ id: 'x:morning', occasion: 'morning', day: '2026-10-05', at: 0, reason: '起床后' }, '宝宝');
        assert.ok(morning.endsWith('不抱怨对方没找你、没回你。]'), morning);
    });
});
