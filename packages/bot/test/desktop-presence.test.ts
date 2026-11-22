import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
    DESKTOP_GAP_MS, DESKTOP_PRESENCE_FILE, DESKTOP_WITH_MS, isPresenceLease, justLeft, leaseActive, presenceAt, PRESENCE_FUTURE_SLACK_MS,
    PRESENCE_TTL_MAX_MS, sessionOverlap, sessionsFromTurns, TURN_LEAD_MS, desktopPresencePath, type PresenceLease, type PresenceTurn,
} from '../src/life/desktop-presence.ts';
import { stateAt, type Activity } from '../src/life/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { syntheticCardPath } from './fixtures/card.ts';

// ADR 0347 第 3 层地基：他是不是正在电脑前陪着她（租约优先，回合兜底；方案 layer3 §2.1，研究建议 2、4）
const MIN = 60_000;
const t = (h: number, m = 0) => new Date(2026, 10, 23, h, m).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const lease = (over: Partial<PresenceLease> = {}): PresenceLease => ({
    kind: 'dsh-presence', version: 1, session: 's-1', startedAt: iso(t(14)), renewedAt: iso(t(15)), ttlMs: 5 * MIN, ...over,
});
const turn = (at: number, userAt?: number): PresenceTurn => (userAt === undefined ? { at } : { at, userAt });

describe('租约格式', () => {
    test('合格的租约；文件名放在灵魂目录下', () => {
        assert.equal(isPresenceLease(lease()), true);
        assert.equal(isPresenceLease(lease({ ended: iso(t(15, 2)) })), true);
        assert.equal(DESKTOP_PRESENCE_FILE, 'desktop-presence.json');
        assert.ok(desktopPresencePath('/soul').endsWith(DESKTOP_PRESENCE_FILE));
    });

    test('格式不对的一律不认：kind / version / session / 时间 / ttl 越界 / renewedAt 早于 startedAt', () => {
        const bad: unknown[] = [
            undefined, null, [], 'x', { ...lease(), kind: 'other' }, { ...lease(), version: 2 }, lease({ session: '' }),
            lease({ startedAt: 'nope' }), lease({ renewedAt: iso(t(13)) }), lease({ ttlMs: 0 }), lease({ ttlMs: Number.NaN }),
            lease({ ttlMs: PRESENCE_TTL_MAX_MS + 1 }), lease({ ended: 'later' }),
        ];
        for (const value of bad) assert.equal(isPresenceLease(value), false, JSON.stringify(value));
    });
});

describe('此刻在不在：租约优先', () => {
    test('有效租约 → 在，since / until 来自租约；回合再旧也不影响', () => {
        const now = t(15, 3);
        const p = presenceAt({ lease: lease(), turns: [turn(t(9))], now });
        assert.deepEqual(p, { with: true, since: t(14), until: t(15, 5), source: 'lease' });
        assert.equal(leaseActive(lease(), t(15, 5)), true, '到期那一刻还算');
    });

    test('过期 / 已结束 / 在未来 / 格式不对 → 退回回合；回合也旧就是不在', () => {
        const now = t(15, 6);
        const cases = {
            过期: lease(),
            已结束: lease({ renewedAt: iso(now - MIN), ended: iso(now - MIN) }),
            在未来: lease({ renewedAt: iso(now + 2 * MIN) }),
            格式不对: lease({ renewedAt: iso(now), ttlMs: -1 }),
        };
        for (const [name, l] of Object.entries(cases)) {
            assert.equal(leaseActive(l, now), false, name);
            assert.deepEqual(presenceAt({ lease: l, turns: [], now }), { with: false, source: 'none' }, name);
            assert.deepEqual(presenceAt({ lease: l, turns: [turn(now - MIN, now - 3 * MIN)], now }), { with: true, since: now - 3 * MIN, until: now - MIN + DESKTOP_WITH_MS, source: 'turns' }, name);
        }
        const future = lease({ startedAt: iso(t(14)), renewedAt: iso(t(15, 2)) });
        assert.equal(leaseActive(future, t(15, 2) - PRESENCE_FUTURE_SLACK_MS), true, '晚 1 分钟以内照收');
        assert.equal(leaseActive(future, t(15, 2) - PRESENCE_FUTURE_SLACK_MS - 1), false, '再晚就不信');
    });

    test('插件崩了不用管：不再续，ttl 一过自然不在', () => {
        assert.equal(presenceAt({ lease: lease(), turns: [], now: t(15, 5) }).with, true);
        assert.equal(presenceAt({ lease: lease(), turns: [], now: t(15, 5) + 1 }).with, false);
    });
});

describe('此刻在不在：没有租约看回合', () => {
    test('最后一轮在 10 分钟以内 → 在（source turns），since 是这段开头他开口的时刻', () => {
        const turns = [turn(t(14, 0), t(13, 58)), turn(t(14, 20)), turn(t(14, 30))];
        assert.deepEqual(presenceAt({ turns, now: t(14, 40) }), { with: true, since: t(13, 58), until: t(14, 40), source: 'turns' });
        assert.equal(presenceAt({ turns, now: t(14, 40) + 1 }).with, false);
        assert.equal(presenceAt({ turns, now: t(14, 40) + 1 }).source, 'none');
        assert.equal(DESKTOP_WITH_MS, 10 * MIN);
    });

    test('晚于现在 1 分钟以上的回合不信', () => {
        assert.equal(presenceAt({ turns: [turn(t(14, 0) + 2 * MIN)], now: t(14, 0) }).with, false);
        assert.equal(presenceAt({ turns: [turn(t(14, 0) + 30_000)], now: t(14, 0) }).with, true);
    });
});

describe('切段', () => {
    test('上一轮结束到下一轮他开口安静不到 45 分钟算同一段，满 45 分钟另起一段', () => {
        assert.equal(DESKTOP_GAP_MS, 45 * MIN);
        const joined = sessionsFromTurns([turn(t(14, 0)), turn(t(14, 50), t(14, 45) - 1)]);
        assert.equal(joined.length, 1);
        const split = sessionsFromTurns([turn(t(14, 0)), turn(t(14, 50), t(14, 45))]);
        assert.deepEqual(split.map(s => [s.start, s.end, s.turns.length]), [[t(14, 0) - TURN_LEAD_MS, t(14, 0), 1], [t(14, 45), t(14, 50), 1]]);
    });

    test('没有 userAt 的旧行：开始取 at 往前推 2 分钟；乱序输入按 at 排；坏行丢掉', () => {
        const sessions = sessionsFromTurns([turn(t(16, 0)), turn(Number.NaN), turn(t(14, 0)), turn(t(14, 30))]);
        assert.deepEqual(sessions.map(s => [s.start, s.end]), [[t(14, 0) - TURN_LEAD_MS, t(14, 30)], [t(16, 0) - TURN_LEAD_MS, t(16, 0)]]);
        assert.equal(sessionsFromTurns([turn(t(14), t(15))])[0]!.start, t(14), 'userAt 晚于 at 的坏数据：开始不晚于结束');
    });

    test('一轮做得很久（他开口到结束 1 小时）不会把自己切开；gapMs 可换', () => {
        assert.equal(sessionsFromTurns([turn(t(14, 0)), turn(t(15, 40), t(14, 10))]).length, 1);
        assert.equal(sessionsFromTurns([turn(t(14, 0)), turn(t(14, 20))], 10 * MIN).length, 2);
    });
});

describe('刚陪完', () => {
    const turns = [turn(t(14, 0), t(13, 50)), turn(t(14, 30)), turn(t(15, 0))];
    test('还在陪就不是刚陪完；离最后一轮不超过窗口（含边界）才算', () => {
        assert.equal(justLeft({ turns, now: t(15, 5), windowMs: 30 * MIN }), undefined, '10 分钟内还在');
        assert.deepEqual(justLeft({ turns, now: t(15, 11), windowMs: 30 * MIN }), { at: t(15, 0), since: t(13, 50), source: 'turns' });
        assert.ok(justLeft({ turns, now: t(15, 30), windowMs: 30 * MIN }));
        assert.equal(justLeft({ turns, now: t(15, 30) + 1, windowMs: 30 * MIN }), undefined);
        assert.equal(justLeft({ turns: [], now: t(15, 30), windowMs: 30 * MIN }), undefined);
    });

    test('租约：结束的取 ended，过期的取最后一次心跳；和回合比取较晚的', () => {
        const ended = lease({ ended: iso(t(15, 2)) });
        assert.deepEqual(justLeft({ lease: ended, turns: [], now: t(15, 20), windowMs: 30 * MIN }), { at: t(15, 2), since: t(14), source: 'lease' });
        assert.deepEqual(justLeft({ lease: lease(), turns: [], now: t(15, 20), windowMs: 30 * MIN }), { at: t(15), since: t(14), source: 'lease' });
        assert.equal(justLeft({ lease: lease(), turns: [], now: t(15, 4), windowMs: 30 * MIN }), undefined, '租约还有效 = 还在陪');
        assert.equal(justLeft({ lease: ended, turns: [turn(t(15, 10))], now: t(15, 30), windowMs: 30 * MIN })!.source, 'turns');
        assert.equal(justLeft({ lease: ended, turns: [turn(t(14, 30))], now: t(15, 30), windowMs: 30 * MIN })!.source, 'lease');
        const future = lease({ renewedAt: iso(t(16)), ended: iso(t(16)) });
        assert.equal(justLeft({ lease: future, turns: [], now: t(15, 0), windowMs: 30 * MIN }), undefined, '未来的租约不算');
    });
});

describe('和作息重叠：只给标签', () => {
    // 合成卡（第 7 周周一 10-12 有早课，见 schedule.test.ts）
    const schedule = loadCharacterCard(syntheticCardPath('boyfriend')).schedule!;
    const at = (kind: Activity['kind']) => {
        for (let m = 0; m < 24 * 60; m += 5) {
            const time = new Date(2026, 9, 12, 0, m);
            if (stateAt(schedule, time).activity.kind === kind) return time.getTime();
        }
        throw new Error(`10-12 找不到 ${kind}`);
    };

    test('会话开始那一刻在睡 / 上课 / 课间 / 空闲，各给对应标签', () => {
        const of = (at: Date) => stateAt(schedule, at);
        for (const kind of ['sleep', 'class', 'between', 'free'] as const) {
            const session = sessionsFromTurns([turn(at(kind) + TURN_LEAD_MS)])[0]!;
            assert.deepEqual(sessionOverlap(session, of), { overlaps: kind });
        }
    });

    test('标签只看开始那一刻；没开作息就没有标签', () => {
        const session = { start: at('class') };
        assert.deepEqual(sessionOverlap(session, () => ({ activity: { kind: 'free', text: '看书' } })), { overlaps: 'free' });
        assert.equal(sessionOverlap(session, () => undefined), undefined);
    });
});
