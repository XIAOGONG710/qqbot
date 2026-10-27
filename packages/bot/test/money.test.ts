import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { describe, test } from 'node:test';
import { depositFor, nextPayday, sideJobOn, spendItems, type Money } from '../src/life/money.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { describeWorld, recapDay, simulateWorld, worldAt } from '../src/world/world.ts';

const card = (tier: string) => loadCharacterCard(resolve(import.meta.dirname, `../../../characters/linmengyao/st/linmengyao-${tier}.json`));
const boyfriend = card('boyfriend');
const known = card('known');
const classmate = card('classmate');
const world = boyfriend.herWorld!;
const schedule = boyfriend.schedule!;
const money = world.money!;
const at = (m: number, d: number, h: number, min = 0) => new Date(2026, m - 1, d, h, min);

describe('她的钱（ADR 0035）', () => {
    test('到账、接单、存多少：规则', () => {
        assert.equal(nextPayday(money, new Date(2026, 9, 11)).getDate(), 1);
        assert.equal(nextPayday(money, new Date(2026, 9, 11)).getMonth(), 10);
        assert.equal(nextPayday(money, new Date(2026, 9, 31)).getMonth(), 10, '31 号的下一次是 11-01');
        // 一年里每月的线上单不超过 perMonth 的整数部分 + 1
        for (let m = 0; m < 12; m++) {
            let jobs = 0;
            for (let d = 1; d <= 31; d++) if (new Date(2026, m, d).getMonth() === m && sideJobOn(money, new Date(2026, m, d))) jobs++;
            assert.ok(jobs <= Math.floor(money.sideJobs!.perMonth) + 1, `${m + 1} 月 ${jobs} 个`);
        }
        const plain: Money = { ...money, saving: { keepPerDay: 70, step: 50, max: 200 } };
        // 10-11（周日）离 11-01 还有 20 天：留 1400，剩下的按 50 取整、最多 200、不超过离目标还差的
        assert.equal(depositFor(plain, 1400, new Date(2026, 9, 11), 2000), 0);
        assert.equal(depositFor(plain, 1580, new Date(2026, 9, 11), 2000), 150);
        assert.equal(depositFor(plain, 3000, new Date(2026, 9, 11), 2000), 200);
        assert.equal(depositFor(plain, 3000, new Date(2026, 9, 11), 80), 80, '离目标只差 80');
        assert.equal(spendItems([{ what: '午饭', amount: 12 }, { what: '零碎', amount: 5 }, { what: '午饭', amount: 3 }]), '午饭 15、零碎 5');
    });

    test('她说出口的数以后不能变：10-08 晚上她跟他说过两次「还差1750」（ADR 0035 调整 7）', () => {
        // 钱是从开学那天按规则一天天推的，改规则（新的花销、行动花钱……）会把过去的数一起改掉。
        // 这里不过：要么改法不该动过去，要么在世界设定里给那天之前的数立锚点，别让她记得的数凭空变
        const now = worldAt(world, schedule, at(10, 8, 21, 7))!;
        assert.equal(now.cameraFund!.saved, 2750);
        assert.equal(now.cameraFund!.goal - now.cameraFund!.saved, 1750);
    });

    test('四个月推下来：钱不会花成负的；每月花一千多到两千；相机基金每月都在涨，存多存少跟着手上的钱走', () => {
        const timeline = simulateWorld(world, schedule, at(12, 31, 23, 59));
        // 一天之内可能先花后进账（跟家里要的在晚上），按天末看
        for (let d = new Date(2026, 8, 1); d <= new Date(2026, 11, 31); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
            const now = worldAt(world, schedule, new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59))!;
            assert.ok(now.money!.balance >= 0, `${d.toDateString()} 手上 ${now.money!.balance}`);
        }
        for (const month of [8, 9, 10, 11]) {
            const spent = -timeline.ledger.filter(e => e.kind === 'spend' && e.at.getMonth() === month).reduce((s, e) => s + e.amount, 0);
            assert.ok(spent > 1200 && spent < 2400, `${month + 1} 月花了 ${spent}`);
        }
        const amounts = timeline.deposits.map(d => d.amount);
        assert.ok(new Set(amounts).size > 2, `存的不是一个固定数：${amounts.join(',')}`);
        assert.ok(amounts.some(a => a === 0), '有的周钱要留着花，没存');
        assert.ok(timeline.deposits.at(-1)!.saved > world.cameraFund!.saved);
        assert.ok(timeline.deposits.at(-1)!.saved <= world.cameraFund!.goal);
    });

    test('提示词：男朋友档看得到手上还有多少、今天花了什么；熟人档只看到相机基金；同学档都没有', () => {
        const t = at(10, 11, 21, 30);
        const bf = describeWorld(worldAt(world, schedule, t)!, t)!;
        assert.match(bf, /钱：手上还有 \d+ 元（生活费每月 1 号到，这个月的到了，离下次还有 21 天）；今天花了 \d+ 元（.*午饭 \d+/);
        assert.match(bf, /攒钱买相机：\d+ \/ 4500 元，还差 \d+（今天(存了 \d+|没存，手上的钱留着花到月底)）/);
        const kn = describeWorld(worldAt(known.herWorld!, known.schedule!, t)!, t)!;
        assert.doesNotMatch(kn, /手上还有|今天花了/);
        assert.match(kn, /攒钱买相机/);
        // 各档存的钱一样多（规则在看得到相机基金的每一档）
        assert.equal(worldAt(known.herWorld!, known.schedule!, t)!.cameraFund!.saved, worldAt(world, schedule, t)!.cameraFund!.saved);
        const cm = describeWorld(worldAt(classmate.herWorld!, classmate.schedule!, t)!, t) ?? '';
        assert.doesNotMatch(cm, /手上还有|今天花了|相机|跟家里要/);
        assert.equal(worldAt(classmate.herWorld!, classmate.schedule!, t)!.money, undefined);
    });

    test('问到那天（ADR 0032）：那天花了多少、存没存', () => {
        const recap = recapDay(worldAt(world, schedule, at(10, 11, 23, 30))!).join('；');
        assert.match(recap, /花了 \d+ 元（/);
        assert.match(recap, /相机基金(存了 \d+|这周没存)/);
        assert.doesNotMatch(recapDay(worldAt(known.herWorld!, known.schedule!, at(10, 11, 23, 30))!).join('；'), /花了 \d+ 元/);
    });

    test('跟家里要钱只在说得出口的档位里是一件事；账是同一本', () => {
        const until = at(12, 31, 23, 59);
        const asked = simulateWorld(world, schedule, until).ledger.filter(e => e.what === '跟家里要的');
        assert.deepEqual(simulateWorld(known.herWorld!, known.schedule!, until).ledger.filter(e => e.what === '跟家里要的').map(e => e.at.getTime()), asked.map(e => e.at.getTime()));
        for (const entry of asked) {
            const day = new Date(entry.at.getFullYear(), entry.at.getMonth(), entry.at.getDate(), 23, 30);
            assert.ok(worldAt(world, schedule, day)!.events.some(e => e.id === 'ask_home'));
            assert.ok(!worldAt(known.herWorld!, known.schedule!, day)!.events.some(e => e.id === 'ask_home'));
        }
    });
});
