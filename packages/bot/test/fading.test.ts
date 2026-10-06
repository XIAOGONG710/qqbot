import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { clarity, isImportant, isLasting, isSummary, lastTouched, withoutMark, type FadeOptions } from '../src/memory/fading.ts';
import type { RecallResult } from '../src/memory/hindsight.ts';
import { formatRecalled, VAGUE_NOTE } from '../src/memory/long-term.ts';

const now = new Date('2026-11-20T21:00:00+08:00');
/** now 往前 days 天那天中午（ISO） */
const ago = (days: number) => new Date(2026, 10, 20 - days, 12).toISOString();
const options = (heard = ''): FadeOptions => ({ now, heard, ignore: ['林梦瑶', '宝宝', '鸽鸽'] });
const fact = (id: string, extra: Partial<RecallResult> = {}): RecallResult => ({ id, text: `事${id}`, type: 'world', ...extra });

describe('记忆变淡（ADR 0018 决策 1）', () => {
    test('长期知道的不变淡：标了【长期】【重要】的（自己或背后的事实开头有）、还没到日子的计划', () => {
        assert.equal(clarity(fact('1', { text: '【长期】宝宝不吃香菜', mentioned_at: ago(100) }), options()), 'lasting', '【长期】');
        assert.equal(clarity(fact('1b', { type: 'observation', mentioned_at: ago(100), sources: ['【重要】【长期】宝宝在字节实习'] }), options()), 'lasting',
            '两个记号都有，背后的事实');
        assert.equal(clarity(fact('2', { text: '【重要】10月10日是一周年', occurred_start: ago(100) }), options()), 'lasting');
        assert.equal(clarity(fact('3', { type: 'observation', occurred_start: ago(100), sources: ['【重要】宝宝 9月1日面试字节'] }), options()), 'lasting',
            '观察整合后记号没了，看背后的事实');
        assert.equal(clarity(fact('4', { occurred_start: new Date(2026, 10, 25).toISOString(), mentioned_at: ago(40) }), options()), 'lasting', '还没到日子');
        assert.ok(isImportant(fact('5', { text: ' 【重要】吵架和好了' })));
        assert.ok(!isImportant(fact('6', { text: '中午吃了面，【重要】不在开头' })));
        assert.ok(isLasting(fact('7', { text: '【重要】【长期】宝宝的生日是 3 月 2 日' })));
        assert.ok(!isLasting(fact('8', { text: '【长期】你在读药屋少女第 7 卷', document_id: 'diary:2026-10-10' })), '日记里的按那篇的日子');
    });

    test('没标【长期】、没有发生日期的（Hindsight 只给带时间词的写发生日期）：按哪天说的变淡（实现时的调整 11）', () => {
        const said = (days: number) => clarity(fact('1', { text: '你说宝宝这二十天没影，是在偷偷练吉他', mentioned_at: ago(days) }), options());
        assert.deepEqual([3, 20, 45].map(said), ['clear', 'vague', 'forgotten']);
        assert.equal(clarity(fact('2'), options()), 'lasting', '一个时间都没有的照旧不变淡');
    });

    test('某天的事：7 天内清楚、30 天内记个大概、更早的想不起来', () => {
        const at = (days: number) => clarity(fact('1', { occurred_start: ago(days) }), options());
        assert.deepEqual([0, 7, 8, 30, 31, 90].map(at), ['clear', 'clear', 'vague', 'vague', 'forgotten', 'forgotten']);
    });

    test('提过 2 次以上（观察背后 2 条以上事实）期限翻倍：14 天、60 天', () => {
        const at = (days: number, ids: string[]) => clarity(fact('1', { type: 'observation', occurred_start: ago(days), source_fact_ids: ids }), options());
        assert.deepEqual([14, 15, 60, 61].map(days => at(days, ['a', 'b'])), ['clear', 'vague', 'vague', 'forgotten']);
        assert.equal(at(14, ['a']), 'vague', '只有 1 条事实不翻倍');
    });

    test('从最后一次沾到它算：发生、结束、最后一次被提起取最晚的；日记按那篇的日子', () => {
        // 发生在 40 天前，3 天前他又说起
        assert.equal(clarity(fact('1', { occurred_start: ago(40), mentioned_at: ago(3) }), options()), 'clear');
        assert.equal(lastTouched(fact('2', { occurred_start: ago(40), occurred_end: ago(20), mentioned_at: ago(35) }))!.getTime(), Date.parse(ago(20)));
        assert.equal(lastTouched(fact('3', { mentioned_at: ago(3) }))!.getTime(), Date.parse(ago(3)), '没有发生日期的按哪天说的');
        assert.equal(lastTouched(fact('3b')), undefined, '一个时间都没有');
        // 日记里的事按那篇的日子（哪怕抽出来的事实没有发生日期）
        const diary = fact('4', { document_id: 'diary:2026-10-10' });
        assert.equal(lastTouched(diary)!.getTime(), new Date(2026, 9, 10).getTime());
        assert.equal(clarity(diary, options()), 'forgotten');
    });

    test('一提就想起：想不起来的，他这次的话里有它的实体名（至少 2 个字，不算她和名单里的称呼）', () => {
        const old = fact('1', { occurred_start: ago(45), entities: ['宝宝', '海底捞', '杭', '鸽鸽'] });
        assert.equal(clarity(old, options('上次那家海底捞还开着吗')), 'recognized');
        assert.equal(clarity(old, options('宝宝想你了')), 'forgotten', '名单里的称呼不算');
        assert.equal(clarity(old, options('鸽鸽去杭州了')), 'forgotten', '单字、名单里的人都不算');
        assert.equal(clarity(fact('2', { occurred_start: ago(10), entities: ['海底捞'] }), options('海底捞')), 'vague', '没忘的照常是记个大概');
    });

    test('周记按周日、阶段总结按最后一天算，期限翻倍；问到那段时间时算一提就想起（ADR 0018 决策 3）', () => {
        const week = fact('1', { document_id: 'week:2026-09-28' }); // 9-28 到 10-04，10-04 离 11-20 是 47 天
        const phase = fact('2', { document_id: 'phase:国庆节:2026-10-07' });
        assert.equal(lastTouched(week)!.getTime(), new Date(2026, 9, 4).getTime());
        assert.equal(lastTouched(phase)!.getTime(), new Date(2026, 9, 7).getTime());
        assert.ok(isSummary(week) && isSummary(phase) && !isSummary(fact('3', { document_id: 'diary:2026-10-04' })));
        assert.equal(clarity(week, options()), 'vague', '翻倍之后 60 天以内');
        const old = fact('4', { document_id: 'week:2026-08-31' }); // 到 9-06，75 天
        assert.equal(clarity(old, options()), 'forgotten');
        assert.equal(clarity(old, { ...options(), window: { start: new Date(2026, 7, 31), end: new Date(2026, 8, 7, 2) } }), 'recognized');
        assert.equal(clarity(old, { ...options(), window: { start: new Date(2026, 9, 1), end: new Date(2026, 9, 8, 2) } }), 'forgotten', '问的不是那周');
        // 时间窗只对周记、阶段总结算
        const diary = fact('5', { document_id: 'diary:2026-09-01' });
        assert.equal(clarity(diary, { ...options(), window: { start: new Date(2026, 8, 1), end: new Date(2026, 8, 2, 2) } }), 'forgotten');
    });

    test('去掉【重要】记号', () => {
        assert.equal(withoutMark('【重要】10月10日是一周年'), '10月10日是一周年');
        assert.equal(withoutMark('一周年'), '一周年');
        assert.equal(withoutMark('【重要】【长期】宝宝的生日是 3 月 2 日'), '宝宝的生日是 3 月 2 日');
    });
});

describe('召回整理时按记得多清楚筛（ADR 0018 决策 1）', () => {
    test('想不起来的不放，记个大概的标出来，标题加一句；记号去掉；条数限制在筛过之后', () => {
        const results = [
            fact('1', { text: '【重要】宝宝 9月1日面试字节', occurred_start: ago(80) }),
            fact('2', { text: '宝宝去了海底捞', occurred_start: ago(45), entities: ['海底捞'] }),
            fact('3', { text: '宝宝感冒了', occurred_start: ago(50) }),
            fact('4', { text: '宝宝去爬山', occurred_start: ago(12) }),
            fact('5', { text: '宝宝今天加班', occurred_start: ago(1) }),
        ];
        let stats;
        const text = formatRecalled(results, { now, limit: 3, fade: { heard: '海底捞还去吗', ignore: [], onFade: s => { stats = s; } } })!;
        const [header, ...lines] = text.split('\n');
        assert.ok(header!.endsWith(`；${VAGUE_NOTE}]`));
        assert.deepEqual(lines, [
            '- 9月1日：宝宝 9月1日面试字节',
            '- 10月6日（他一提才想起来，记不太清了）：宝宝去了海底捞',
            '- 11月8日（记不太清了）：宝宝去爬山',
        ]);
        assert.deepEqual(stats, { vague: 1, recognized: 1, forgotten: 1 });
    });

    test('都清楚时标题不变；全都想不起来就没有这一段；不传 fade 照旧', () => {
        let stats;
        const header = formatRecalled([fact('1', { occurred_start: ago(1) })], { now, header: '[记忆]', fade: { heard: '', ignore: [] } })!.split('\n')[0];
        assert.equal(header, '[记忆]');
        assert.equal(formatRecalled([fact('1', { occurred_start: ago(40) })], { now, fade: { heard: '', ignore: [], onFade: s => { stats = s; } } }), undefined);
        assert.deepEqual(stats, { vague: 0, recognized: 0, forgotten: 1 });
        assert.match(formatRecalled([fact('1', { occurred_start: ago(40) })], { now })!, /事1$/);
    });
});
