import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { StoredMessage } from '../src/history.ts';
import { blockReason, candidatesOn, planFrom, usedOn, withRoom, type Candidate, type ProactiveInput, type ProactiveRecord } from '../src/proactive.ts';
import { loadCharacterCard } from '../src/st/card.ts';

// ADR 0124：给主动名额留余地。10-22：他一整天没回，早安 + 催他 ×2 + 冷场把每天 4 条占满，随口说件事、下课、睡前全被挤掉
const boyfriend = loadCharacterCard(resolve(import.meta.dirname, '../../../characters/linmengyao/st/linmengyao-boyfriend.json'));
const schedule = boyfriend.schedule!;
const t = (h: number, m = 0) => new Date(2026, 10, 10, h, m).getTime();
const day = new Date(2026, 10, 10);
const msg = (role: 'user' | 'assistant', time: number, content: string): StoredMessage => ({ time: new Date(time).toISOString(), role, content });
const rec = (id: string, at: number, result: ProactiveRecord['result'] = 'sent'): ProactiveRecord => ({ id, occasion: id.split(':')[1] as ProactiveRecord['occasion'], plannedAt: new Date(at).toISOString(), at: new Date(at).toISOString(), result });
// 他中午说过话、她回了（所以“他没回”的闸是开着的），当天已经主动了三条
const history = [msg('user', t(12, 0), '在忙'), msg('assistant', t(12, 1), '好')];
const threeUsed = [rec('2026-11-10:morning', t(8, 30)), rec('2026-11-10:reach:1', t(10, 0)), rec('2026-11-10:reach:2', t(11, 0))];
const base = boyfriend.proactive!;
const input = (room: boolean, records: ProactiveRecord[] = threeUsed): ProactiveInput => ({
    qq: 10001, schedule, settings: room ? withRoom(base) : base, dates: [], history, records, mode: 'on',
});
const find = (list: Candidate[], occasion: string) => list.find(c => c.occasion === occasion);

describe('给主动名额留余地', () => {
    test('withRoom 只加 room 标记；睡前不占名额（有 room 才这样）', () => {
        assert.equal(withRoom(base).room, true);
        assert.equal(base.room, undefined);
        const records = [...threeUsed, rec('2026-11-10:bedtime', t(23, 30))];
        assert.equal(usedOn('2026-11-10', records), 4, '原来的数法');
        assert.equal(usedOn('2026-11-10', records, withRoom(base)), 3, '睡前不占');
    });

    test('已经用了 3 条：没开时“冷场”还能发（再占掉最后一个名额）；开了以后“冷场”不发、留给“随口说件事”', () => {
        const quiet = { id: '2026-11-10:quiet', occasion: 'quiet', day: '2026-11-10', at: t(20, 0), reason: 'x' } as Candidate;
        assert.ok(!String(blockReason(quiet, quiet.at, input(false)) ?? '').includes('今天已经主动了'), '没开：条数还没到上限');
        assert.equal(blockReason(quiet, quiet.at, input(true)), '今天已经主动了 3 条');
        const share = find(candidatesOn(day, input(true)), 'share');
        assert.ok(share, '有“随口说件事”的候选');
        assert.ok(!String(blockReason(share!, share!.at, input(true)) ?? '').includes('今天已经主动了'), '开了：它有留给自己的名额');
    });

    test('睡前那句晚安：4 条都用满了也照发（它自己的闸——聊过 20 分钟内、他没回——照旧）', () => {
        const full = [...threeUsed, rec('2026-11-10:share', t(16, 0))];
        const bedtime = find(candidatesOn(day, input(true, full)), 'bedtime')!;
        assert.ok(bedtime);
        assert.notEqual(blockReason(bedtime, bedtime.at, input(true, full)), '今天已经主动了 4 条');
        assert.equal(blockReason(bedtime, bedtime.at, input(false, full)), '今天已经主动了 4 条', '没开：被挤掉');
        // 聊着的时候 20 分钟的老规矩还在
        const chatting = { ...input(true, full), history: [...history, msg('user', bedtime.at - 5 * 60_000, '哈哈'), msg('assistant', bedtime.at - 4 * 60_000, '？')] };
        assert.equal(blockReason(bedtime, bedtime.at, chatting), '20 分钟内聊过');
    });

    test('计划：开了以后，剩下的名额里“随口说件事”和睡前都在；没开时只剩一个名额，睡前被挤掉', () => {
        const now = t(13, 0);
        const withRoomPlan = planFrom(now, input(true));
        const withoutPlan = planFrom(now, input(false));
        const occasions = (plan: ReturnType<typeof planFrom>) => plan.upcoming.map(c => c.occasion);
        assert.ok(occasions(withRoomPlan).includes('share') && occasions(withRoomPlan).includes('bedtime'), JSON.stringify(occasions(withRoomPlan)));
        assert.ok(!occasions(withRoomPlan).includes('quiet') || !occasions(withRoomPlan).includes('after_class'), '别的时机不超过 dailyMax - 1');
        assert.ok(!occasions(withoutPlan).includes('bedtime') || occasions(withoutPlan).length === 1, `没开：只剩 1 个名额 ${JSON.stringify(occasions(withoutPlan))}`);
    });

    test('总条数不超过 dailyMax + 睡前一条：4 条都发满后再没有名额', () => {
        const records = [...threeUsed, rec('2026-11-10:share', t(16, 0)), rec('2026-11-10:bedtime', t(23, 30))];
        const plan = planFrom(t(23, 40), input(true, records));
        assert.deepEqual(plan.upcoming.filter(c => c.day === '2026-11-10'), []);
        assert.equal(usedOn('2026-11-10', records, withRoom(base)), 4);
    });
});
