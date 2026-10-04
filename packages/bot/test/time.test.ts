import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { describeTime, duration, when } from '../src/time-context.ts';
import { humanize, timeMacros, type TimedMessage } from '../src/st/time-macros.ts';

const at = (text: string) => new Date(text); // 不带时区，按本地时间
const iso = (text: string) => at(text).toISOString();
const user = (time: string, content = '在吗') => ({ role: 'user' as const, content, time: iso(time) }) satisfies TimedMessage & { content: string };
const her = (time: string, content = '嗯') => ({ role: 'assistant' as const, content, time: iso(time) }) satisfies TimedMessage & { content: string };

describe('ST 时间宏（中文界面）', () => {
    test('日期、星期、时间的格式', () => {
        const macros = timeMacros(at('2026-10-04T09:05:00'), []);
        assert.equal(macros.isodate, '2026-10-04');
        assert.equal(macros.isotime, '09:05');
        assert.equal(macros.time, '09:05');
        assert.equal(macros.date, '2026年10月4日');
        assert.equal(macros.weekday, '星期日');
    });

    test('humanize 的阈值同 moment 默认值', () => {
        const s = 1000, m = 60 * s, h = 60 * m, d = 24 * h;
        assert.equal(humanize(44 * s), '几秒');
        assert.equal(humanize(45 * s), '1 分钟');
        assert.equal(humanize(90 * s), '2 分钟');
        assert.equal(humanize(44 * m), '44 分钟');
        assert.equal(humanize(45 * m), '1 小时');
        assert.equal(humanize(90 * m), '2 小时');
        assert.equal(humanize(21 * h), '21 小时');
        assert.equal(humanize(22 * h), '1 天');
        assert.equal(humanize(36 * h), '2 天');
        assert.equal(humanize(25 * d), '25 天');
        assert.equal(humanize(26 * d), '1 个月');
        assert.equal(humanize(400 * d), '1 年');
    });

    test('idleDuration：跳过最新一条，取再往前最近一条用户消息；没有时是 just now', () => {
        const now = at('2026-10-04T21:15:00');
        const chat = [user('2026-10-01T20:00:00'), her('2026-10-01T20:01:00'), user('2026-10-04T21:14:00'), user('2026-10-04T21:14:50')];
        assert.equal(timeMacros(now, chat).idleduration, '1 分钟', '连发时只算到倒数第二条，这正是运行时另算间隔的原因');
        assert.equal(timeMacros(now, chat.slice(0, 3)).idleduration, '3 天');
        assert.equal(timeMacros(now, [user('2026-10-04T21:00:00')]).idleduration, 'just now');
        assert.equal(timeMacros(now, chat).idle_duration, '1 分钟');
    });
});

describe('运行时的时间提示', () => {
    test('隔了三天连发几条：间隔按这一组的第一条算', () => {
        const chat = [her('2026-10-01T20:15:00'), user('2026-10-04T21:14:00'), user('2026-10-04T21:14:30'), user('2026-10-04T21:15:00')];
        assert.equal(describeTime(chat, at('2026-10-04T21:15:20')), [
            '[当前时间：2026-10-04 星期日 21:15]',
            '[距上一条消息：3 天（上一条在10月1日 20:15）]',
        ].join('\n'));
    });

    test('昨晚聊过：写明是昨天', () => {
        const chat = [user('2026-10-03T22:00:00'), her('2026-10-03T22:01:00'), user('2026-10-04T08:30:00')];
        assert.equal(describeTime(chat, at('2026-10-04T08:30:05')).split('\n')[1], '[距上一条消息：10 小时 29 分钟（上一条在昨天 22:01）]');
    });

    test('对方的消息发出很久才回复（停机后补回）：说明是什么时候发的', () => {
        const chat = [her('2026-10-04T18:00:00'), user('2026-10-04T19:02:00')];
        const lines = describeTime(chat, at('2026-10-04T21:15:00')).split('\n');
        assert.equal(lines[2], '[对方这次的消息是今天 19:02 发的，到现在过了 2 小时 13 分钟]');
    });

    test('她收尾后对方的附和没回，隔天才说下一句：这一组从那句算起，不是从附和算起（10-05 模拟器 boyfriend-time r3）', () => {
        const chat = [
            user('2026-09-21T22:10:30', '明天上午我要做项目汇报，好紧张'), her('2026-09-21T22:10:43', '行了早点睡，熬到半夜明天脑子一团浆糊'),
            user('2026-09-21T22:10:43', '晚安'), user('2026-09-22T12:10:51', '过了！'),
        ];
        assert.equal(describeTime(chat, at('2026-09-22T12:10:52')), [
            '[当前时间：2026-09-22 星期二 12:10]',
            '[距上一条消息：14 小时（上一条在昨天 22:10）]',
        ].join('\n'));
        // 只有附和又要回（关掉作息时）：照旧按附和算
        assert.equal(describeTime(chat.slice(0, 3), at('2026-09-21T22:10:45')).split('\n')[1], '[距上一条消息：不到 1 分钟（上一条在今天 22:10）]');
    });

    test('第一次聊天、或者对方还没有新消息时，只有当前时间', () => {
        const now = at('2026-10-04T12:00:10');
        assert.equal(describeTime([user('2026-10-04T12:00:00')], now), '[当前时间：2026-10-04 星期日 12:00]');
        assert.equal(describeTime([user('2026-10-04T08:00:00'), her('2026-10-04T08:01:00')], now), '[当前时间：2026-10-04 星期日 12:00]');
        assert.equal(describeTime([], now), '[当前时间：2026-10-04 星期日 12:00]');
    });

    test('时间和时长的写法', () => {
        const now = at('2026-10-04T12:00:00');
        assert.equal(when(at('2026-10-04T08:05:00'), now), '今天 08:05');
        assert.equal(when(at('2025-12-31T23:00:00'), now), '2025年12月31日 23:00');
        assert.equal(duration(30_000), '不到 1 分钟');
        assert.equal(duration(3 * 3_600_000), '3 小时');
        assert.equal(duration(29 * 3_600_000), '1 天 5 小时');
        assert.equal(duration(4 * 86_400_000 + 3_600_000), '4 天');
    });
});
