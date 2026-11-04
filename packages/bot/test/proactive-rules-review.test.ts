import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blockReason, candidatesOn, inviteDeclined, moveToHisHours, parseDates, parseProactive, planFrom, unansweredCount, withBack, withReach, type ProactiveInput, type ProactiveRecord } from '../src/proactive/proactive.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import type { Schedule } from '../src/life/schedule.ts';
import { localDate } from '../src/local-date.ts';

const schedule: Schedule = {
    sleep: '02:00', wake: { early: '08:00', lazy: '08:00', earlySlot: '1' },
    periods: {}, semester: { start: '2026-01-05', weeks: 52 }, holidays: [], makeups: [], courses: [], kinds: { hard: {}, machine: {}, water: {}, pe: {} },
    free: { morning: ['休息'], afternoon: ['休息'], evening: ['休息'], afternoonFrom: '12:00', eveningFrom: '18:00' }, where: '学校',
};
const at = (h: number, m = 0) => new Date(2026, 10, 10, h, m).getTime();
const input = (patch: Partial<ProactiveInput> = {}): ProactiveInput => ({ qq: 10001, schedule,
    settings: { occasions: ['ask'], dailyMax: 4, unansweredMax: 1 }, dates: [], history: [], records: [], mode: 'on', ...patch });

test('back 保持短暂离开的返回时刻，不被未回复的两小时节流推迟', () => {
    const said = at(20);
    const record: ProactiveRecord = { id: '2026-11-10:share', occasion: 'share', plannedAt: new Date(said).toISOString(), at: new Date(said).toISOString(), result: 'sent' };
    const state = input({ settings: withBack(withReach({ occasions: [], dailyMax: 4, unansweredMax: 1 })), records: [record],
        history: [{ role: 'user', time: new Date(at(19)).toISOString(), content: '嗯' }, { role: 'assistant', time: new Date(said).toISOString(), content: '等我一下，我去倒水' }] });
    const back = candidatesOn(new Date(2026, 10, 10), state).find(c => c.occasion === 'back');
    assert.ok(back);
    assert.ok(back.at >= said + 4 * 60_000 && back.at <= said + 14 * 60_000);
    assert.equal(blockReason(back, back.at, state), undefined);
});

test('合法 afternoon 待跟进同样阻止问他意见，上午事件不阻止', () => {
    const candidate = { id: '2026-11-10:ask', occasion: 'ask' as const, day: '2026-11-10', at: at(15), reason: '问意见' };
    const follow = { id: 'f', what: '面试', date: candidate.day, time: 'afternoon', episode: 'ep-1' };
    assert.equal(blockReason(candidate, candidate.at, input({ followUps: [follow] })), '他下午 / 晚上有事，不问');
    assert.equal(blockReason(candidate, candidate.at, input({ followUps: [{ ...follow, time: 'morning' }] })), undefined);
});

test('挪在线钟头保留本地分钟、秒和毫秒，兼容非整小时偏移', () => {
    const previous = process.env.TZ;
    try {
        process.env.TZ = 'Asia/Kathmandu';
        const time = new Date(2026, 10, 10, 15, 40, 12, 345).getTime();
        const weights = Array<number>(24).fill(0); weights[18] = 1;
        assert.equal(moveToHisHours(time, weights, new Date(2026, 10, 10, 14).getTime(), new Date(2026, 10, 10, 21).getTime(), 'x'), new Date(2026, 10, 10, 18, 40, 12, 345).getTime());
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('日子拒绝永远不会出现的公历月日、农历31日，保留闰日和农历三十', () => {
    for (const date of ['02-30', '02-31', '04-31', '06-31', '09-31', '11-31']) assert.throws(() => parseDates([{ name: '日子', date }], '合成卡'));
    assert.throws(() => parseDates([{ name: '日子', lunar: '01-31' }], '合成卡'));
    assert.equal(parseDates([{ name: '日子', date: '02-29', lunar: '12-30' }], '合成卡').length, 1);
});

test('每日和未回复额度拒绝不可精确计数的数值', () => {
    for (const key of ['dailyMax', 'unansweredMax']) for (const value of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => parseProactive({ occasions: [], dailyMax: 1, unansweredMax: 1, [key]: value }, '合成卡'));
    }
});

test('无聊天的低年份也有下午分享候选，不把Unix纪元当成上次聊天', () => {
    assert.ok(candidatesOn(localDate(99, 10, 10), input({ settings: { occasions: ['share'], dailyMax: 1, unansweredMax: 1 } })).some(c => c.occasion === 'share'));
});

test('末年计划不发布次年候选或扩展年份时间戳，非法查询明确失败', () => {
    const state = input({ settings: { occasions: ['morning', 'dates'], dailyMax: 4, unansweredMax: 1 }, dates: [{ name: '周年', date: '01-01', midnight: true }] });
    const plan = planFrom(localDate(9999, 11, 31, 20).getTime(), state);
    assert.equal(plan.upcoming.length, 0);
    assert.throws(() => planFrom(NaN, state), /支持范围/);
});

test('UTC+14 的约玩/问意见按本地日号计算两日间隔', () => {
    const previous = process.env.TZ;
    try {
        process.env.TZ = 'Pacific/Kiritimati';
        for (const [occasion, d] of [['ask', 7], ['invite', 1]] as const) {
            const state = input({ settings: { occasions: [occasion], dailyMax: 4, unansweredMax: 1 } });
            const day = new Date(2026, 10, d);
            assert.ok(candidatesOn(day, state).some(c => c.occasion === occasion), '合成当日本来会发');
            const prior = new Date(2026, 10, d - 2, 20);
            const text = `${prior.getFullYear()}-${String(prior.getMonth() + 1).padStart(2, '0')}-${String(prior.getDate()).padStart(2, '0')}`;
            state.records = [{ id: `${text}:${occasion}`, occasion, at: prior.toISOString(), plannedAt: prior.toISOString(), result: 'sent' }];
            assert.ok(candidatesOn(day, state).some(c => c.occasion === occasion), `${occasion} 已隔两天`);
        }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('持久瞬时编码也须四位年，即使本地日号还在范围内', () => {
    const previous = process.env.TZ;
    try {
        process.env.TZ = 'Asia/Shanghai';
        assert.throws(() => planFrom(localDate(0, 0, 1, 0).getTime(), input()), /支持范围/);
        assert.doesNotThrow(() => planFrom(localDate(0, 0, 1, 12).getTime(), input()));
        process.env.TZ = 'America/New_York';
        assert.throws(() => planFrom(localDate(9999, 11, 31, 23).getTime(), input()), /支持范围/);
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('真实已发送ID确认同秒实际回复，解除未回复闸并认出拒约', () => {
    const at = '2026-11-10T12:00:00.600Z';
    const record: ProactiveRecord = { id: '2026-11-10:invite', occasion: 'invite', at, plannedAt: at, result: 'sent', messageIds: [901] };
    const history: StoredMessage[] = [{ role: 'assistant', time: '2026-11-10T12:00:00.800Z', content: '今晚一起玩吗', messageId: 901 },
        { role: 'user', time: '2026-11-10T12:00:00.000Z', content: '今天不了，有点累', messageId: 902 }];
    assert.equal(unansweredCount({ history, records: [record], mode: 'on' }), 0);
    assert.equal(inviteDeclined(record, history), true);
    assert.equal(inviteDeclined(record, [...history, { role: 'user', time: '2026-11-10T12:01:00Z', content: '来', messageId: 903 }]), true, '取实际第一句');
});

test('旧同ID/未来同ID/发出前的同秒用户消息不冒充回复，无ID和dryRun保留时间回退', () => {
    const at = '2026-11-10T12:00:00.600Z';
    const record: ProactiveRecord = { id: '2026-11-10:invite', occasion: 'invite', at, plannedAt: at, result: 'sent', messageIds: [901] };
    const user: StoredMessage = { role: 'user', time: '2026-11-10T12:00:00.000Z', content: '不玩', messageId: 902 };
    const assistant = (time: string): StoredMessage => ({ role: 'assistant', time, content: '来玩吗', messageId: 901 });
    for (const history of [[assistant('2026-11-09T12:00:00Z'), user], [assistant('2026-11-10T12:00:00.100Z'), user], [user, assistant('2026-11-10T12:00:00.800Z')], [user, assistant('2026-11-10T12:01:00Z')],
        [assistant('2026-11-10T12:00:00.700Z'), assistant('2026-11-10T12:00:00.800Z'), user]]) {
        assert.equal(unansweredCount({ history, records: [record], mode: 'on' }), 1);
        assert.equal(inviteDeclined(record, history), false);
    }
    const history = [assistant('2026-11-10T12:00:00.800Z'), user];
    assert.equal(unansweredCount({ history, records: [{ ...record, messageIds: undefined }], mode: 'on' }), 1);
    assert.equal(unansweredCount({ history, records: [{ ...record, result: 'dryRun' }], mode: 'dryRun' }), 1);
});
