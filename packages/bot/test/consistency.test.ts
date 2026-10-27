import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { checkConsistency, describeFindings, type SaidRow } from '../src/platform/consistency.ts';
import { stateAt } from '../src/life/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// ADR 0119：前后一致性检查
const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;

/** 找一个有课的工作日里“正在上课”的时刻，和一个“没课”的时刻 */
function findTimes() {
    let inClass: number | undefined;
    let free: number | undefined;
    for (let d = 0; d < 14 && (!inClass || !free); d++) {
        for (let h = 8; h < 21; h++) {
            const t = new Date(2026, 10, 2 + d, h, 30).getTime();
            const s = stateAt(schedule, new Date(t));
            if (!inClass && s.activity.kind === 'class') inClass = t;
            if (!free && s.activity.kind === 'free' && !s.holiday) free = t;
        }
    }
    return { inClass: inClass!, free: free! };
}
const row = (time: number, role: 'user' | 'assistant', text: string): SaidRow => ({ time, role, text });

describe('前后一致性检查', () => {
    const { inClass, free } = findTimes();

    test('说在上课：真在上课不算，没课的时候算；说的是将来 / 过去（等下课、刚上完）不算', () => {
        assert.ok(inClass && free, '找到了有课和没课的时刻');
        const hits = (time: number, text: string) => checkConsistency({ rows: [row(time, 'assistant', text)], schedule }).filter(f => f.rule === 'class_but_free').length;
        assert.equal(hits(inClass, '在上课呢，回头说'), 0);
        assert.equal(hits(free, '在上课呢，回头说'), 1);
        assert.equal(hits(free, '等下课再说'), 0);
        assert.equal(hits(free, '刚上完课，累死'), 0);
    });

    test('下雨：账上没下却说下雨 / 账上在下却说没下才算；不给账就不查', () => {
        const rows = [row(free, 'assistant', '外面在下雨呢'), row(free + 3_600_000, 'assistant', '今天没下雨，真好')];
        const none = checkConsistency({ rows, schedule });
        assert.equal(none.filter(f => f.rule === 'rain_but_dry' || f.rule === 'dry_but_rain').length, 0, '没给账');
        const dry = checkConsistency({ rows, schedule, rainAt: () => false });
        assert.equal(dry.filter(f => f.rule === 'rain_but_dry').length, 1);
        const wet = checkConsistency({ rows, schedule, rainAt: () => true });
        assert.equal(wet.filter(f => f.rule === 'dry_but_rain').length, 1);
        const right = checkConsistency({ rows: [row(free, 'assistant', '在下雨')], schedule, rainAt: () => true });
        assert.equal(right.length, 0);
    });

    test('问候和钟点：她先开口时中午以后说早安 / 白天说晚安才算；回他的不算', () => {
        const noon = new Date(2026, 10, 3, 15, 0).getTime();
        const alone = checkConsistency({ rows: [row(noon, 'assistant', '早安呀')], schedule });
        assert.equal(alone.filter(f => f.rule === 'greeting_time').length, 1);
        const reply = checkConsistency({ rows: [row(noon - 60_000, 'user', '早'), row(noon, 'assistant', '早安呀')], schedule });
        assert.equal(reply.filter(f => f.rule === 'greeting_time').length, 0, '回他的“早”');
        const evening = checkConsistency({ rows: [row(new Date(2026, 10, 3, 23, 0).getTime(), 'assistant', '晚安')], schedule });
        assert.equal(evening.length, 0);
    });

    test('同一句话（≥ 5 个字）在 3 个不同的日子都说过才算复读；同一天说三遍不算', () => {
        const at = (day: number) => new Date(2026, 10, day, 12, 0).getTime();
        const three = checkConsistency({ rows: [row(at(3), 'assistant', '算了，随便你吧'), row(at(4), 'assistant', '算了，随便你吧！'), row(at(6), 'assistant', '算了 随便你吧')], schedule });
        assert.equal(three.filter(f => f.rule === 'same_line_many_days').length, 1);
        const sameDay = checkConsistency({ rows: [row(at(3), 'assistant', '算了，随便你吧'), row(at(3) + 60_000, 'assistant', '算了，随便你吧'), row(at(3) + 120_000, 'assistant', '算了，随便你吧')], schedule });
        assert.equal(sameDay.length, 0);
        const short = checkConsistency({ rows: [3, 4, 5].map(d => row(at(d), 'assistant', '嗯嗯')), schedule });
        assert.equal(short.length, 0, '太短不算');
        const media = checkConsistency({ rows: [3, 4, 5].map(d => row(at(d), 'assistant', '她发了张照片：土豆晒太阳')), schedule });
        assert.equal(media.length, 0, '发图的记录不算');
    });

    test('汇总文字：每条规则一节、例子最多 4 条，他的话一个字不出现', () => {
        const secret = '他说的暗号七七七';
        const rows = [row(free, 'user', secret), row(free + 1000, 'assistant', '在上课呢'), ...[1, 2, 3, 4, 5, 6].map(i => row(free + i * 60_000, 'assistant', '在上课呢，等会儿聊'))];
        const text = describeFindings(checkConsistency({ rows, schedule }), 7);
        for (const label of ['说在上课', '说在宿舍', '说在下雨', '说没下雨', '问候和钟点', '同一句话']) assert.ok(text.includes(label), label);
        assert.ok(!text.includes(secret));
        assert.ok(text.split('\n').filter(l => l.startsWith('- ')).length <= 4 * 6);
    });
});
