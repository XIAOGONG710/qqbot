import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import type { Schedule } from '../src/schedule.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import { describeWorld, occupationAt, outAt, parseWorld, recapDay, simulateWorld, worldAt, worldLogger, worldNews, worldState, type World, type WorldAction } from '../src/world.ts';
import { busySpans } from '../src/life-selector.ts';

const cards = resolve(import.meta.dirname, '../../../characters/linmengyao/st');
const boyfriend = loadCharacterCard(join(cards, 'linmengyao-boyfriend.json'));
const classmate = loadCharacterCard(join(cards, 'linmengyao-classmate.json'));
const schedule = boyfriend.schedule!;
const world = boyfriend.herWorld!;
const at = (text: string) => new Date(`${text}+08:00`);

/** 换掉卡上世界的某几块（随机部分按日期取哈希，换概率能把「下不下雨」「有没有快递」钉死） */
const patch = (change: (w: World) => void): World => {
    const copy = structuredClone(world);
    change(copy);
    return copy;
};

describe('她的世界（ADR 0021 W1）', () => {
    test('卡上有世界；同一时刻可复现，各档位同一天的猫、天气、快递一样，只是看得到的块不同', () => {
        const now = at('2026-10-11T21:30:00');
        const a = worldAt(world, schedule, now)!;
        assert.deepEqual(worldAt(world, schedule, now), a);
        const low = worldAt(classmate.herWorld!, classmate.schedule!, now)!;
        assert.deepEqual(low.weather, a.weather);
        assert.deepEqual(low.cat, a.cat);
        assert.deepEqual(low.parcels, a.parcels);
        assert.ok(a.cameraFund && !low.cameraFund, '相机基金只给 BFGK');
        assert.equal(low.familyCall, undefined);
    });

    test('猫：下雨不下楼；喂一次少一天猫粮，剩得少了下单猫粮，取回来就加一袋；吃完了不喂', () => {
        const dry = patch(w => { w.weather!.rainChance = 0; w.parcels!.perWeek = 0; w.cat!.food.left = 4; w.cat!.food.reorderAt = 2; });
        const timeline = simulateWorld(dry, schedule, at('2026-09-20T23:00:00'));
        const fed = [...timeline.days.values()].filter(d => d.cat?.fed).length;
        assert.ok(fed > 4, '猫粮补上了，接着喂');
        const food = timeline.parcels.filter(p => p.food);
        assert.ok(food.length >= 1 && food.every(p => p.item === '猫粮'));
        assert.ok(food[0]!.picked, '猫粮到了就取');
        const rainy = patch(w => { w.weather!.rainChance = 1; });
        const day = worldAt(rainy, schedule, at('2026-09-15T22:30:00'))!;
        assert.deepEqual(day.cat!.today, { skipped: 'rain' });
        const empty = patch(w => { w.weather!.rainChance = 0; w.cat!.food.left = 0; w.cat!.food.reorderAt = -1; });
        assert.deepEqual(worldAt(empty, schedule, at('2026-09-02T22:30:00'))!.cat!.today, { skipped: 'no_food' });
    });

    test('还没到的不写：晚上喂猫之前是「还没下楼」，之后是几点喂的；今天的小事只写已经发生的', () => {
        const dry = patch(w => { w.weather!.rainChance = 0; });
        const before = worldAt(dry, schedule, at('2026-09-16T12:00:00'))!;
        assert.ok('later' in before.cat!.today);
        const after = worldAt(dry, schedule, at('2026-09-16T23:30:00'))!;
        assert.ok('fed' in after.cat!.today);
        const always = patch(w => { w.events = [{ id: 'x', text: '傍晚的小事', window: 'evening', chance: 1, when: 'any' }]; });
        assert.equal(worldAt(always, schedule, at('2026-09-16T12:00:00'))!.events.length, 0);
        assert.equal(worldAt(always, schedule, at('2026-09-16T23:30:00'))!.events.length, 1);
    });

    test('快递：到了驿站、空的时候取；人不在学校取不了，过了最后一天退回；先下单的先到', () => {
        const busy = patch(w => { w.parcels!.perWeek = 7; });
        const timeline = simulateWorld(busy, schedule, at('2026-09-30T23:00:00'));
        const normal = timeline.parcels.filter(p => !p.food);
        assert.ok(normal.length > 10);
        for (const parcel of normal.filter(p => p.picked)) {
            assert.ok(parcel.picked! >= parcel.arrive, '到了才取');
            assert.ok(parcel.picked!.toISOString().slice(0, 10) <= parcel.deadline, '最后一天之前');
        }
        // 国庆回家：那几天到的快递取不了
        const home = patch(w => { w.parcels!.perWeek = 7; w.awayHolidays = ['国庆节']; });
        const parcels = simulateWorld(home, schedule, at('2026-10-12T23:00:00')).parcels.filter(p => !p.food);
        const awayStart = at('2026-10-01T00:00:00');
        const awayEnd = at('2026-10-08T00:00:00');
        assert.ok(parcels.every(p => !p.picked || p.picked < awayStart || p.picked >= awayEnd), '回家那几天没取');
        assert.ok(parcels.every(p => p.ordered < '2026-10-01' || p.ordered > '2026-10-07'), '不在学校不下单');
        assert.ok(parcels.some(p => p.returned), '放假前下单、放假里过期的退回');
    });

    test('作业：上课时留，下一次这门课之前交，写完的时刻在交之前；不在列表里的课型不留', () => {
        const all = patch(w => { w.homework!.chance = 1; w.homework!.earlyChance = 0; });
        const timeline = simulateWorld(all, schedule, at('2026-09-20T23:00:00'));
        assert.ok(timeline.homework.length > 3);
        for (const item of timeline.homework) {
            assert.ok(item.done < item.due, `${item.course} 交之前写完`);
            assert.ok(item.course, '男朋友档看得到课名');
        }
        const none = patch(w => { w.homework!.kinds = ['pe']; w.homework!.chance = 1; });
        assert.ok(simulateWorld(none, schedule, at('2026-09-20T23:00:00')).homework.every(h => !/Linux|MySQL/.test(h.course)));
    });

    test('相机基金：每周那天晚上存一笔，到目标停；存之前还是上周的数', () => {
        const fund = world.cameraFund!;
        const sunday = at('2026-09-06T20:00:00');
        // 卡上没有钱的规则：每周固定存 weekly
        const fixed = patch(w => { delete w.money; });
        assert.equal(worldAt(fixed, schedule, sunday)!.cameraFund!.saved, fund.saved, '21:00 存之前');
        assert.equal(worldAt(fixed, schedule, at('2026-09-06T22:00:00'))!.cameraFund!.saved, fund.saved + fund.weekly);
        // 有钱的规则（ADR 0035）：9 月头一个周日手上宽裕，存满 200
        assert.equal(worldAt(world, schedule, at('2026-09-06T22:00:00'))!.cameraFund!.saved, fund.saved + world.money!.saving.max);
        // 只看存满即停：去掉 10-11 买相机的安排（买相机另有一项）
        const rich = patch(w => { w.cameraFund!.saved = w.cameraFund!.goal - 50; delete w.cameraFund!.purchase; });
        assert.equal(worldAt(rich, schedule, at('2026-10-30T22:00:00'))!.cameraFund!.saved, rich.cameraFund!.goal);
    });

    test('学期开始以前没有世界；卡上没有世界的旧卡照常', () => {
        assert.equal(worldAt(world, schedule, at('2026-08-20T12:00:00')), undefined);
        assert.equal(parseWorld(undefined, 'x'), undefined);
        assert.throws(() => parseWorld({ startDay: '9-1' }, 'x'), /startDay/);
    });
});

describe('「你那边」进时间块（ADR 0021 W2）', () => {
    test('只写事实和约束：天气、猫、快递、作业、相机基金、小事；人名按档位换；有总说明「别照着念、没写的别编」', () => {
        const now = at('2026-10-11T21:30:00');
        const text = describeWorld(worldAt(world, schedule, now)!, now)!;
        assert.match(text, /^\[你那边（今天到现在的事实，用不用、怎么说你自己定，别照着念；这里没写的别编）：/);
        assert.match(text, /土豆（楼下的流浪猫）：[^｜]*；昨天(喂过|没喂)/, '昨天喂没喂总写上');
        assert.match(text, /的作业(已经写完了|还没写)（(明天|后天|周.)交）/, '先写写没写完，再写哪天交');
        assert.match(text, /攒钱买相机：\d+ \/ 4500 元/);
        assert.doesNotMatch(text, /[我你]觉得|好开心|好烦|！/, '不写情绪和能照抄的句子');
        const friend = patch(w => { w.events = [{ id: 'x', text: '{person}在微信上跟你互损了几句', person: 'chen_jianing', window: 'morning', chance: 1, when: 'any' }]; });
        const withFriend = describeWorld(worldAt(friend, schedule, now)!, now)!;
        assert.match(withFriend, /陈佳宁在微信上跟你互损了几句（陈佳宁：高中同班，你的死党/);
    });

    test('看不到课名的档位，几份一样的作业合成一条', () => {
        const all = patch(w => { w.homework!.chance = 1; w.homework!.earlyChance = 0; });
        const nameless = structuredClone(all);
        const schedulePlain: Schedule = { ...schedule, courses: schedule.courses.map(({ name: _name, ...c }) => c) };
        const now = at('2026-09-13T21:30:00');
        const text = describeWorld(worldAt(nameless, schedulePlain, now)!, now)!;
        assert.doesNotMatch(text, /作业还没写（明天交）；作业还没写（明天交）/);
        assert.match(text, /作业：\d 份作业还没写（明天交）|作业：作业还没写（明天交）/);
    });

    test('每天第一次写一行摘要和 state.json，同一天不重复', () => {
        const dir = mkdtempSync(join(tmpdir(), 'world-'));
        try {
            const logs: string[] = [];
            const note = worldLogger(world, schedule, message => logs.push(message), dir);
            note(at('2026-10-11T12:00:00'));
            note(at('2026-10-11T21:00:00'));
            note(at('2026-10-12T01:59:00'));
            assert.equal(logs.length, 1);
            assert.match(logs[0]!, /^她的世界：今天（10-11）：/);
            const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
            assert.equal(state.day, '2026-10-11');
            note(at('2026-10-12T09:00:00'));
            assert.equal(logs.length, 2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('说出口的行为回写世界（ADR 0027 W3）', () => {
    test('动作只在说出后生效：雨天原本没喂，她说喂过后所有档位都变成喂过；没说见没见到就不乱补', () => {
        const rainy = patch(w => { w.weather!.rainChance = 1; });
        const action: WorldAction = {
            id: '1:ep-1:1:feed_cat', kind: 'feed_cat', day: '2026-09-15', at: '2026-09-15T19:00', contact: 1, episode: 'ep-1',
        };
        assert.deepEqual(worldAt(rainy, schedule, at('2026-09-15T18:59:00'), [action])!.cat!.today, { skipped: 'rain' });
        const rich = worldAt(rainy, schedule, at('2026-09-15T19:01:00'), [action])!;
        const low = worldAt({ ...classmate.herWorld!, weather: rainy.weather }, classmate.schedule!, at('2026-09-15T19:01:00'), [action])!;
        assert.deepEqual(rich.cat!.today, { fed: at('2026-09-15T19:00:00') });
        assert.deepEqual(low.cat!.today, rich.cat!.today);
        assert.match(describeWorld(rich, at('2026-09-15T19:01:00'))!, /今天 19:00 下楼喂过；/);
        assert.doesNotMatch(describeWorld(rich, at('2026-09-15T19:01:00'))!, /见到了|没见着/);
    });

    test('状态层原子落盘、重启恢复；同一天向不同人重复说同一动作不重复执行', () => {
        const rainy = patch(w => { w.weather!.rainChance = 1; });
        const dir = mkdtempSync(join(tmpdir(), 'world-actions-'));
        const logs: string[] = [];
        const now = at('2026-09-15T22:00:00');
        const contact = { qq: 1, name: '阿明', tier: 'boyfriend' as const };
        const episode = {
            id: `ep-${at('2026-09-15T18:00:00').getTime()}`,
            start: at('2026-09-15T18:00:00'), end: at('2026-09-15T19:00:00'),
            messages: [
                { role: 'user' as const, content: '土豆呢', time: at('2026-09-15T18:00:00').toISOString() },
                { role: 'assistant' as const, content: '刚喂完', time: at('2026-09-15T19:00:00').toISOString() },
            ],
        };
        try {
            const state = worldState(rainy, schedule, message => logs.push(message), dir, () => now.getTime());
            state.record(contact, episode, [{ kind: 'feed_cat', at: '2026-09-15T19:00' }]);
            state.record({ ...contact, qq: 2 }, { ...episode, id: `${episode.id}-other` }, [{ kind: 'feed_cat', at: '2026-09-15T19:00' }]);
            assert.equal(state.actions().length, 1);
            assert.ok('fed' in state.at(rainy, schedule, now)!.cat!.today);
            assert.equal(JSON.parse(readFileSync(join(dir, 'actions.json'), 'utf8')).actions.length, 1);
            assert.equal(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')).cat.today.fed, at('2026-09-15T19:00:00').toISOString());

            const resumed = worldState(rainy, schedule, () => undefined, dir, () => now.getTime());
            assert.equal(resumed.actions().length, 1);
            assert.ok('fed' in resumed.at(rainy, schedule, now)!.cat!.today);
            assert.ok(logs.some(line => line.includes('喂了土豆')));
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('模型给的时刻必须能对上她在片段里的一句话，不能凭空造动作时间', () => {
        const dir = mkdtempSync(join(tmpdir(), 'world-actions-'));
        try {
            const now = at('2026-09-15T22:00:00');
            const state = worldState(world, schedule, () => undefined, dir, () => now.getTime());
            state.record({ qq: 1, name: '阿明', tier: 'boyfriend' }, {
                id: 'ep-1', start: at('2026-09-15T18:00:00'), end: at('2026-09-15T19:00:00'),
                messages: [{ role: 'assistant', content: '还没去', time: at('2026-09-15T19:00:00').toISOString() }],
            }, [{ kind: 'feed_cat', at: '2026-09-15T19:01' }]);
            assert.equal(state.actions().length, 0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('他给的钱（10-10 用户裁决：打字发的「转账」也当真）：买相机的存进相机基金到目标为止，多的留在手上；要他在这段里真发过，转述不算，同一笔不重复记', () => {
        const dir = mkdtempSync(join(tmpdir(), 'world-actions-'));
        try {
            const now = at('2026-09-15T22:00:00');
            const contact = { qq: 1, name: '阿明', tier: 'boyfriend' as const };
            const episode = {
                id: 'ep-gift', start: at('2026-09-15T19:50:00'), end: at('2026-09-15T20:05:00'),
                messages: [
                    { role: 'user' as const, content: '［转账］5000元', time: at('2026-09-15T20:00:00').toISOString() },
                    { role: 'user' as const, content: '拿去买相机', time: at('2026-09-15T20:00:30').toISOString() },
                    { role: 'assistant' as const, content: '真转啊，那我收下了', time: at('2026-09-15T20:01:00').toISOString() },
                ],
            };
            const gift = { kind: 'receive_money' as const, at: '2026-09-15T20:01', amount: 5000, forCamera: true };
            const state = worldState(world, schedule, () => undefined, dir, () => now.getTime());
            // 她跟闺蜜转述：那一段里没有他的转账，不算
            state.record({ qq: 2, name: '思思', tier: 'bestie' }, {
                id: 'ep-tell', start: at('2026-09-15T20:30:00'), end: at('2026-09-15T20:30:00'),
                messages: [{ role: 'assistant', content: '他刚给我转了5000', time: at('2026-09-15T20:30:00').toISOString() }],
            }, [{ ...gift, at: '2026-09-15T20:30' }]);
            assert.equal(state.actions().length, 0);
            // 金额对不上（他没发过 900；「5000」里的「500」也不算）不算
            state.record(contact, episode, [{ ...gift, amount: 900 }]);
            state.record(contact, episode, [{ ...gift, amount: 500 }]);
            assert.equal(state.actions().length, 0);
            state.record(contact, episode, [gift]);
            state.record(contact, { ...episode, id: 'ep-gift-again' }, [gift]);
            assert.equal(state.actions().length, 1, '同一天同一个人同样的金额只记一次');
            assert.equal(state.actions()[0]!.target, 'camera_fund');

            const plain = worldAt(world, schedule, now)!;
            const after = state.at(world, schedule, now)!;
            const put = plain.cameraFund!.goal - plain.cameraFund!.saved;
            assert.ok(put > 0 && put < 5000);
            assert.equal(after.cameraFund!.saved, after.cameraFund!.goal);
            assert.match(describeWorld(after, now)!, /攒钱买相机：(\d+) \/ \1 元，攒够了/);
            if (plain.money) assert.equal(after.money!.balance - plain.money.balance, 5000 - put, '多出来的留在手上');
            // 收下之前还是原来的数
            assert.equal(state.at(world, schedule, at('2026-09-15T20:00:00'))!.cameraFund!.saved, plain.cameraFund!.saved);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('攒够了这周末去买相机（用户 10-10）：出门前说要去、在外面挑、回来以后是买了的；剩下的钱回到手上，之后不再存；钱不够就不买', () => {
        const gift: WorldAction = {
            id: '1:ep-gift:1:receive_money', kind: 'receive_money', day: '2026-10-10', at: '2026-10-10T15:41', contact: 1, episode: 'ep-gift',
            amount: 2000, target: 'camera_fund',
        };
        const fund = world.cameraFund!.purchase!;
        assert.equal(fund.date, '2026-10-11');
        const eve = worldAt(world, schedule, at('2026-10-10T21:00:00'), [gift])!;
        assert.match(describeWorld(eve, at('2026-10-10T21:00:00'))!, new RegExp(`攒钱买相机：4500 / 4500 元，攒够了.*；明天 14:00 打算去${fund.where}买，看中的是${fund.what}`), '前一天就知道明天去买');
        const before = worldAt(world, schedule, at('2026-10-11T13:00:00'), [gift])!;
        assert.equal(before.cameraFund!.camera!.state, 'planned');
        assert.equal(occupationAt(worldAt(world, schedule, at('2026-10-11T13:30:00'), [gift])!, at('2026-10-11T13:30:00')), `在宿舍准备出门，14:00 去${fund.where}买相机`, '出门前那一会儿');
        assert.doesNotMatch(occupationAt(worldAt(world, schedule, at('2026-10-11T12:20:00'), [gift])!, at('2026-10-11T12:20:00')) ?? '', /准备出门/, '一个半小时以前照作息');
        assert.match(describeWorld(before, at('2026-10-11T13:00:00'))!, new RegExp(`相机：钱攒够了（4500 元），今天 14:00 要去${fund.where}买，看中的是${fund.what}`));
        const out = worldAt(world, schedule, at('2026-10-11T15:00:00'), [gift])!;
        assert.equal(occupationAt(out, at('2026-10-11T15:00:00')), `在${fund.where}挑相机`);
        assert.equal(outAt(out), `在${fund.where}挑相机，隔一会儿才看手机`, '回消息隔一会儿');
        assert.equal(outAt(before), undefined);
        assert.equal(occupationAt(worldAt(world, schedule, at('2026-10-11T16:40:00'), [gift])!, at('2026-10-11T16:40:00')), '刚买完相机回到宿舍，在摆弄新相机', '买完回来那一会儿');
        const back = worldAt(world, schedule, at('2026-10-11T17:00:00'), [gift])!;
        assert.equal(occupationAt(back, at('2026-10-11T17:00:00')), '刚买完相机回到宿舍，在摆弄新相机');
        assert.doesNotMatch(occupationAt(worldAt(world, schedule, at('2026-10-11T18:10:00'), [gift])!, at('2026-10-11T18:10:00')) ?? '', /相机/, '一个半小时以后照作息（这会儿在吃晚饭）');
        assert.equal(back.cameraFund!.camera!.state, 'bought');
        const line = describeWorld(back, at('2026-10-11T17:00:00'))!;
        assert.match(line, new RegExp(`相机：今天下午去${fund.where}买的${fund.what}（${fund.price} 元，攒的钱买的）`));
        assert.doesNotMatch(line, /攒钱买相机/);
        const left = simulateWorld(world, schedule, at('2026-10-11T17:00:00'), [gift]).ledger.find(e => e.what === '买完相机剩下的');
        assert.equal(left?.amount, 4500 - fund.price, '剩下的回到手上');
        assert.ok(recapDay(back).some(item => item.includes(`去${fund.where}买了相机`)));
        assert.ok(busySpans(back).some(span => span.text === `去${fund.where}买相机` && span.start.getTime() === at('2026-10-11T14:00:00').getTime()));
        // 主动消息「她那边的事」（ADR 0057）：出门前就知道几点了结，16:30 买到
        assert.deepEqual(worldNews(before), [{ id: 'camera', at: at('2026-10-11T16:30:00'), what: `刚在${fund.where}买到了${fund.what}（${fund.price} 元，攒的钱买的）` }]);
        // 下周日不再往相机基金里存；那天以后说的是哪天买的
        // 零点过后她还没睡（凌晨 2 点前算前一天）：还是「今天下午」
        assert.match(describeWorld(worldAt(world, schedule, at('2026-10-12T00:30:00'), [gift])!, at('2026-10-12T00:30:00'))!, new RegExp(`相机：今天下午去${fund.where}买的`));
        assert.match(describeWorld(worldAt(world, schedule, at('2026-10-12T20:00:00'), [gift])!, at('2026-10-12T20:00:00'))!, new RegExp(`相机：昨天下午去${fund.where}买的`));
        const nextWeek = worldAt(world, schedule, at('2026-10-18T22:00:00'), [gift])!;
        assert.match(describeWorld(nextWeek, at('2026-10-18T22:00:00'))!, new RegExp(`相机：10 月 11 日下午去${fund.where}买的`));
        assert.equal(simulateWorld(world, schedule, at('2026-10-18T22:00:00'), [gift]).ledger.filter(e => e.kind === 'deposit' && e.at > at('2026-10-11T00:00:00') && e.what === '存进相机基金').length, 0);
        assert.ok(!busySpans(nextWeek).some(span => span.text.includes('买相机')));
        // 没有那笔钱：10-11 攒不够，不买
        const plain = worldAt(world, schedule, at('2026-10-11T17:00:00'))!;
        assert.equal(plain.cameraFund!.camera, undefined);
        assert.deepEqual(worldNews(plain), []);
        assert.match(describeWorld(plain, at('2026-10-11T17:00:00'))!, /攒钱买相机：\d+ \/ 4500 元，还差/);
    });

    test('作业用稳定目标跨档回写：低档看不到课名，仍完成和男朋友档同一份', () => {
        const richWorld = patch(w => { w.homework!.chance = 1; w.homework!.earlyChance = 0; });
        const lowWorld = structuredClone(classmate.herWorld!);
        lowWorld.homework!.chance = 1;
        lowWorld.homework!.earlyChance = 0;
        const now = at('2026-09-13T21:30:00');
        const pending = simulateWorld(richWorld, schedule, now).homework.find(item => item.done > now && item.due > now)!;
        assert.ok(pending?.course);
        const dir = mkdtempSync(join(tmpdir(), 'world-actions-'));
        try {
            const state = worldState(richWorld, schedule, () => undefined, dir, () => now.getTime());
            state.record({ qq: 1, name: '阿明', tier: 'boyfriend' }, {
                id: 'ep-homework', start: now, end: now,
                messages: [{ role: 'assistant', content: `${pending.course}作业写完了`, time: now.toISOString() }],
            }, [{ kind: 'finish_homework', at: '2026-09-13T21:30', subject: pending.course }]);
            const action = state.actions()[0]!;
            assert.equal(action.target, pending.id);
            const richDone = simulateWorld(richWorld, schedule, now, state.actions()).homework.find(item => item.id === action.target)!;
            const lowDone = simulateWorld(lowWorld, classmate.schedule!, now, state.actions()).homework.find(item => item.id === action.target)!;
            assert.equal(richDone.done.getTime(), now.getTime());
            assert.equal(lowDone.done.getTime(), now.getTime());
            assert.equal(lowDone.course, '');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('统一生活事件账本（ADR 0029）', () => {
    test('旧 actions.json 可直接升级；第一次新增事件时写 events.json，并继续维护旧投影', () => {
        const dir = mkdtempSync(join(tmpdir(), 'world-events-'));
        const legacy: WorldAction = {
            id: 'legacy-feed', kind: 'feed_cat', day: '2026-09-15', at: '2026-09-15T19:00', contact: 1, episode: 'ep-old',
        };
        try {
            writeFileSync(join(dir, 'actions.json'), JSON.stringify({ actions: [legacy] }));
            const now = at('2026-09-15T22:00:00');
            const state = worldState(world, schedule, () => undefined, dir, () => now.getTime());
            assert.equal(state.events().length, 1);
            assert.equal(state.events()[0]!.source, 'conversation');
            state.recordEvents([{
                id: 'sim:read-1', kind: 'read_book', at: at('2026-09-15T21:00:00').toISOString(),
                source: 'simulation', result: 'succeeded', subject: '局外人',
            }]);
            const disk = JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8'));
            assert.equal(disk.version, 1);
            assert.deepEqual(disk.events.map((event: { id: string }) => event.id), ['legacy-feed', 'sim:read-1']);
            assert.deepEqual(JSON.parse(readFileSync(join(dir, 'actions.json'), 'utf8')).actions.map((action: WorldAction) => action.id), ['legacy-feed']);
            const resumed = worldState(world, schedule, () => undefined, dir, () => now.getTime());
            assert.equal(resumed.events().length, 2, 'events 与兼容 actions 同时存在时不重复迁移');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('成功事件才投影到世界；失败和中断留下经历，但不伪造成完成', () => {
        const rainy = patch(w => { w.weather!.rainChance = 1; });
        const dir = mkdtempSync(join(tmpdir(), 'world-events-'));
        try {
            const now = at('2026-09-15T22:00:00');
            const state = worldState(rainy, schedule, () => undefined, dir, () => now.getTime());
            state.recordEvents([
                { id: 'failed', kind: 'feed_cat', at: at('2026-09-15T18:00:00').toISOString(), source: 'simulation', result: 'failed', reason: '下雨，没见到猫' },
                { id: 'interrupted', kind: 'feed_cat', at: at('2026-09-15T18:30:00').toISOString(), source: 'simulation', result: 'interrupted' },
            ]);
            assert.deepEqual(state.at(rainy, schedule, at('2026-09-15T18:59:00'))!.cat!.today, { skipped: 'rain' });
            state.recordEvents([
                { id: 'succeeded', kind: 'feed_cat', at: at('2026-09-15T19:00:00').toISOString(), source: 'simulation', result: 'succeeded', seen: false },
            ]);
            assert.equal(state.events().length, 3);
            assert.equal(state.events()[0]!.reason, '下雨，没见到猫');
            assert.equal(state.actions().length, 1);
            assert.deepEqual(state.at(rainy, schedule, at('2026-09-15T19:01:00'))!.cat!.today, { fed: at('2026-09-15T19:00:00'), seen: false });
            const resumed = worldState(rainy, schedule, () => undefined, dir, () => now.getTime());
            assert.equal(resumed.events()[0]!.reason, '下雨，没见到猫', '裁判原因重启后仍在');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    test('事件 id 幂等，且不满足现实前置条件的“成功”会结算为失败', () => {
        const noParcels = patch(w => { w.parcels!.perWeek = 0; });
        const dir = mkdtempSync(join(tmpdir(), 'world-events-'));
        try {
            const now = at('2026-09-15T22:00:00');
            const state = worldState(noParcels, schedule, () => undefined, dir, () => now.getTime());
            const draft = { id: 'pick-none', kind: 'pick_parcel', at: at('2026-09-15T19:00:00').toISOString(), source: 'external' as const, result: 'succeeded' as const };
            state.recordEvents([draft]);
            state.recordEvents([draft]);
            assert.equal(state.events().length, 1);
            assert.equal(state.events()[0]!.result, 'failed');
            assert.equal(state.actions().length, 0);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
