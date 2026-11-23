import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { desktopAffectOf, desktopAffects } from '../src/social/desktop-affect.ts';
import type { StoredMessage } from '../src/memory/history.ts';

const now = new Date('2026-11-22T22:50:00+08:00').getTime();
const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
const said = (content: string, minutesAgo = 5, role: 'user' | 'assistant' = 'user'): Pick<StoredMessage, 'role' | 'content' | 'time'> => ({ role, content, time: at(minutesAgo) });

describe('桌面上的事也进心境（ADR 0347 第 5 层）', () => {
    test('他说想她、要抱抱：心里暖', () => {
        const got = desktopAffectOf(said('想你了，快过来'), now);
        assert.equal(got?.kind, 'joy');
        assert.equal(got?.source, 'desktop');
        assert.equal(got?.aboutHim, true);
        assert.match(got!.cause, /想你/);
    });

    test('他关心她（问吃没吃、让早点睡）：也是暖的那一种，弱一点', () => {
        assert.equal(desktopAffectOf(said('吃饭了没'), now)?.kind, 'joy');
        assert.equal(desktopAffectOf(said('早点睡，别熬夜'), now)?.strength, 1);
    });

    test('他自己说难受：她跟着担心', () => {
        const got = desktopAffectOf(said('今天累死了，被老师骂了一顿'), now);
        assert.equal(got?.kind, 'worry');
    });

    test('他冲她发火：烦', () => {
        assert.equal(desktopAffectOf(said('别烦我'), now)?.kind, 'annoyed');
    });

    test('她自己在桌面上说的话不算（只算冲她来的）', () => {
        assert.equal(desktopAffectOf(said('想你了', 5, 'assistant'), now), undefined);
    });

    test('六小时以前的旧账不再重复算', () => {
        assert.equal(desktopAffectOf(said('想你了', 60 * 7), now), undefined);
    });

    test('普通的话不算：宁可少记也不硬猜', () => {
        assert.equal(desktopAffectOf(said('这个函数怎么改'), now), undefined);
        assert.equal(desktopAffectOf(said(''), now), undefined);
    });

    test('一批回合里只收算得上的', () => {
        const list = desktopAffects([
            said('想你了'),
            said('这个报错你帮我看看', 4),
            said('累死了', 3),
            said('好', 2, 'assistant'),
        ], now);
        assert.deepEqual(list.map(item => item.kind), ['joy', 'worry']);
    });
});

// 6bd84cee 漏了一处：feelingsAt 的来源白名单里没有 desktop，桌面来的评估全被丢掉，开关开了心境也是空的
test('桌面来的评估进得了心境（feelingsAt 认 desktop 来源）', async () => {
    const { appraisals, feelingsAt } = await import('../src/emotion/feelings.ts');
    const { desktopAffects } = await import('../src/social/desktop-affect.ts');
    const now = Date.parse('2026-11-04T20:30:00+08:00');
    const extra = desktopAffects([{ role: 'user', content: '好想你啊', time: new Date(now - 5 * 60_000).toISOString() }], now);
    const felt = feelingsAt(appraisals({ now, history: [], moments: [], extra }), now);
    assert.equal(felt[0]?.source, 'desktop');
    assert.equal(felt[0]?.cause, '他在电脑上说想你');
});

// 11-23 审 6bd84cee：关心她、问她的话原来记成了「他在电脑上说难受」
test('他自己难受才算；劝她、问她的不算（别太累了 / 你好累吗 / 你哪里不舒服）；「有病」只算一点', () => {
    const now = Date.parse('2026-11-04T20:30:00+08:00');
    const say = (content: string) => desktopAffectOf({ role: 'user', content, time: new Date(now - 60_000).toISOString() }, now);
    assert.equal(say('今天好累啊')?.cause, '他在电脑上说难受');
    assert.equal(say('我头疼')?.cause, '他在电脑上说难受');
    assert.equal(say('别太累了')?.cause, '他在电脑上关心你', '劝她是关心');
    assert.equal(say('你好累吗'), undefined, '问她的不算他难受');
    assert.equal(say('你哪里不舒服'), undefined);
    assert.equal(say('不舒服吗'), undefined, '问句不算');
    assert.equal(say('你有病吧哈哈')?.strength, 1);
    assert.equal(say('闭嘴')?.strength, 2);
});
