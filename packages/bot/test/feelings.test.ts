// 心境（ADR 0102）：事实 → 带来由的评估 → 按半衰期衰减的感受 → 提示词里的一行。纯函数，全部可重放。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import {
    appraisals, asksAfterHer, CLEAR, criedRecently, describeFeelings, FAINT, feelingsAt, feelsLow, STRONG, validMoment, validMoments, voicedKinds,
    type Appraisal, type Felt, type Moment,
} from '../src/emotion/feelings.ts';
import { momentsReader } from '../src/emotion/moments.ts';
import type { WorldNow } from '../src/world.ts';

const HOUR = 3_600_000;
const T0 = Date.parse('2026-10-22T20:00:00+08:00');
const at = (hours: number) => T0 + hours * HOUR;
const iso = (hours: number) => new Date(at(hours)).toISOString();
const say = (hours: number, role: 'user' | 'assistant', content: string) => ({ time: iso(hours), role, content });

const item = (patch: Partial<Appraisal> & Pick<Appraisal, 'kind' | 'strength'>): Appraisal => ({ id: 'x', at: T0, cause: '某件事', source: 'world', ...patch });
const felt = (list: Appraisal[], hours = 0) => feelingsAt(list, at(hours));

describe('感受 = 评估按半衰期衰减后加起来', () => {
    test('大事（3）开始很重，过一个半衰期明显，三个半衰期散了；小事（1）单独一件不会表现出来', () => {
        const joy = [item({ kind: 'joy', strength: 3, halfLifeH: 5 })];
        assert.equal(felt(joy, 0)[0]!.level, 'strong');
        assert.equal(felt(joy, 5)[0]!.level, 'clear', '一个半衰期：2.6 → 1.3');
        assert.deepEqual(felt(joy, 15), [], '三个半衰期：0.325 < 刚能察觉');
        const small = felt([item({ kind: 'worry', strength: 1 })], 0);
        assert.equal(small[0]!.level, 'faint');
        assert.ok(small[0]!.weight < CLEAR && small[0]!.weight >= FAINT);
    });

    test('同一种感受的几件事加起来（小事叠成明显），有上限；没发生的事（时刻在后面）不算；分量大的在前', () => {
        const two = [item({ id: 'a', kind: 'sad', strength: 1 }), item({ id: 'b', kind: 'sad', strength: 1 })];
        assert.equal(felt(two)[0]!.level, 'clear', '0.8 + 0.8 = 1.6');
        const many = Array.from({ length: 8 }, (_, i) => item({ id: `m${i}`, kind: 'sad', strength: 3 }));
        assert.ok(felt(many)[0]!.weight <= 3.4);
        assert.deepEqual(felt([item({ kind: 'joy', strength: 3, at: at(1) })], 0), []);
        const mixed = felt([item({ id: 'a', kind: 'joy', strength: 1 }), item({ id: 'b', kind: 'sad', strength: 2, cause: '最重的' })]);
        assert.deepEqual(mixed.map(f => f.kind), ['sad', 'joy']);
        assert.equal(mixed[0]!.cause, '最重的');
    });

    test('来由取分量最大的那件；同样的输入永远同样的结果', () => {
        const list = [item({ id: 'a', kind: 'worry', strength: 1, cause: '小事' }), item({ id: 'b', kind: 'worry', strength: 2, cause: '大一点的事' })];
        assert.equal(felt(list)[0]!.cause, '大一点的事');
        assert.deepEqual(felt(list), felt(list));
    });
});

describe('评估：她那边的事', () => {
    const world = (patch: Partial<WorldNow>): WorldNow => ({ day: '2026-10-22', atSchool: true, parcels: [], homework: [], events: [], ...patch });
    const kinds = (list: Appraisal[], hours = 0) => felt(list, hours).map(f => `${f.kind}:${f.level}`);

    test('作业快到期了还没写完：18 小时内有点担心（小事），6 小时内明显担心；写完了、离得远的没有', () => {
        const due = at(5);
        const w = world({ homework: [{ course: '高数', due: new Date(due), done: false, doneAt: new Date(due) }] });
        const list = appraisals({ now: T0, history: [], world: w });
        assert.deepEqual(kinds(list), ['worry:clear']);
        assert.equal(felt(list)[0]!.cause, '高数的作业快到期了还没写完');
        const far = world({ homework: [{ course: '高数', due: new Date(at(30)), done: false, doneAt: new Date(at(30)) }] });
        assert.deepEqual(appraisals({ now: T0, history: [], world: far }), []);
        const done = world({ homework: [{ course: '高数', due: new Date(due), done: true, doneAt: new Date(at(-1)) }] });
        assert.deepEqual(appraisals({ now: T0, history: [], world: done }).filter(a => a.kind === 'worry'), []);
    });

    test('买到相机很开心、赶完作业松口气、闺蜜病了担心、约好的临时去不了有点烦', () => {
        const w = world({
            cameraFund: { saved: 4500, goal: 4500, camera: { start: new Date(at(-4)), end: new Date(at(-1)), where: '万象城', what: '微单', price: 4500, state: 'bought' } },
            homework: [{ course: '线代', due: new Date(at(8)), done: true, doneAt: new Date(at(-0.5)) }],
        });
        const list = appraisals({ now: T0, history: [], world: w });
        const got = Object.fromEntries(felt(list).map(f => [f.kind, f.level]));
        assert.equal(got.joy, 'strong');
        assert.equal(got.relief, 'clear');
        const sick = world({ people: [{ name: '苏雨桐', relation: '同学', states: [{ kind: 'sick', day: 1, of: 3 }] }] });
        // 她得知的时刻在当天 9:00–11:30 之间；中午看，还没散，是小事（单独不表现）
        const noon = Date.parse('2026-10-22T12:00:00+08:00');
        const sickList = appraisals({ now: noon, history: [], world: sick });
        const sickFelt = feelingsAt(sickList, noon);
        assert.deepEqual(sickFelt.map(f => `${f.kind}:${f.level}`), ['worry:faint']);
        assert.match(sickFelt[0]!.cause, /苏雨桐感冒了/);
        assert.deepEqual(feelingsAt(sickList, noon + 20 * HOUR), [], '第二天早就散了');
    });

    test('土豆：喂了见到了高兴一点，没见到有点担心；还没去的没有', () => {
        const seen = world({ cat: { name: '土豆', today: { fed: new Date(at(-1)), seen: true }, yesterdayFed: true, foodDays: 9 } });
        assert.equal(appraisals({ now: T0, history: [], world: seen })[0]!.kind, 'joy');
        const unseen = world({ cat: { name: '土豆', today: { fed: new Date(at(-1)), seen: false }, yesterdayFed: true, foodDays: 9 } });
        assert.equal(appraisals({ now: T0, history: [], world: unseen })[0]!.kind, 'worry');
        const later = world({ cat: { name: '土豆', today: { later: '18:30' }, yesterdayFed: true, foodDays: 9 } });
        assert.deepEqual(appraisals({ now: T0, history: [], world: later }), []);
    });
});

describe('评估：他的态度（聊天记录）', () => {
    const run = (history: ReturnType<typeof say>[], now = T0) => feelingsAt(appraisals({ now, history }), now);

    test('他说想你 / 哄她 / 认真道歉：开心一点、松口气；他说他难受：担心；他有好消息：替他高兴', () => {
        assert.deepEqual(run([say(-0.1, 'user', '我想你了')]).map(f => f.kind), ['joy']);
        assert.equal(run([say(-0.1, 'user', '抱抱，别难过')])[0]!.kind, 'relief');
        const repair = run([say(-0.1, 'user', '对不起，是我不好')]);
        assert.deepEqual(repair.map(f => `${f.kind}:${f.level}`), ['relief:clear']);
        const down = run([say(-0.1, 'user', '我今天被导师骂了，烦死了')]);
        assert.deepEqual(down.map(f => `${f.kind}:${f.level}`), ['worry:clear']);
        assert.equal(run([say(-0.1, 'user', '面试过了！！')])[0]!.kind, 'joy');
    });

    test('一天前的、很久以前的不算（窗口 30 小时）；同一个钟头里说几遍想你只算一次', () => {
        assert.deepEqual(run([say(-40, 'user', '我想你了')]), []);
        const twice = run([say(-0.3, 'user', '想你了'), say(-0.2, 'assistant', '嗯'), say(-0.1, 'user', '我想你')]);
        assert.ok(twice[0]!.weight < 1, String(twice[0]!.weight));
    });

    test('她难过时倾诉了几条，他隔了两个钟头才回：委屈（明显），记在他回来的那一刻', () => {
        const history = [say(-3, 'assistant', '我好烦啊今天'), say(-2.9, 'assistant', '被老师说了，有点难过'), say(-1, 'user', '刚看到，怎么了')];
        const got = run(history);
        assert.deepEqual(got.map(f => `${f.kind}:${f.level}`), ['sad:clear']);
        assert.equal(got[0]!.aboutHim, true);
        // 他回得快，或者她发的不是在说自己的感受：没有
        assert.deepEqual(run([say(-3, 'assistant', '人呢'), say(-2.9, 'assistant', '睡了没'), say(-1, 'user', '刚看到')]), []);
        assert.deepEqual(run([say(-3, 'assistant', '我好烦啊今天'), say(-2.9, 'assistant', '有点难过'), say(-2.8, 'user', '怎么了')]), []);
    });

    test('她发的话他一直没回：4 小时以后有一点难过（小事，单独不表现）；他说过去睡了 / 去忙的不算', () => {
        const waiting = [say(-6, 'user', '好的'), say(-5.5, 'assistant', '今天下课好晚'), say(-5.4, 'assistant', '食堂人好多')];
        const quiet = run(waiting);
        assert.deepEqual(quiet.map(f => `${f.kind}:${f.level}`), ['sad:faint']);
        assert.deepEqual(run([say(-6, 'user', '我先去睡了'), say(-5.5, 'assistant', '晚安')]), []);
        assert.deepEqual(run([say(-5.5, 'assistant', '今天下课好晚')].slice(0, 0)), []);
        assert.deepEqual(run([say(-6, 'user', '好的'), say(-2, 'assistant', '在吗')]), [], '才 2 小时');
    });

    test('心里的事叠起来：被晾过一回，她再发的话又等了很久，各自是小事、加起来就明显', () => {
        const history = [say(-10, 'assistant', '我好烦啊今天'), say(-9.9, 'assistant', '有点难过'), say(-6, 'user', '刚看到'), say(-5.5, 'assistant', '你终于回了')];
        const got = run(history);
        assert.equal(got[0]!.kind, 'sad');
        assert.ok(got[0]!.weight >= CLEAR, String(got[0]!.weight));
        const only = run(history.slice(2));
        assert.deepEqual(only.map(f => f.level), ['faint'], '只有后面那一件时单独不表现');
    });

    test('他在哄她（别难过 / 抱抱）不是他自己在难过：不算“担心他”', () => {
        assert.deepEqual(run([say(-0.1, 'user', '抱抱，别难过')]).map(f => f.kind), ['relief']);
        assert.deepEqual(run([say(-0.1, 'user', '别哭了，我在呢')]).map(f => f.kind), ['relief']);
    });
});

describe('作者写下的事', () => {
    const moment = (patch: Partial<Moment> = {}): Moment => ({ id: 'm1', at: iso(-1), kind: 'sad', strength: 3, cause: '高数小测没考好', ...patch });

    test('合格的才认：id、时刻、种类、强度 1–3、来由 2–60 字；id 不重复', () => {
        assert.ok(validMoment(moment()));
        for (const bad of [{ kind: 'angry' }, { strength: 4 }, { cause: '好' }, { cause: '长'.repeat(61) }, { at: 'x' }, { id: '有空 格' }, { halfLifeH: 0 }]) assert.equal(validMoment(moment(bad as Partial<Moment>)), false, JSON.stringify(bad));
        assert.ok(validMoments({ moments: [moment(), moment({ id: 'm2' })] }));
        assert.equal(validMoments({ moments: [moment(), moment()] }), false, 'id 重复');
        assert.equal(validMoments({}), false);
    });

    test('一件大事让她很难过，来由原样进感受；时刻没到的不算', () => {
        const got = feelingsAt(appraisals({ now: T0, history: [], moments: [moment()] }), T0);
        assert.deepEqual(got.map(f => `${f.kind}:${f.level}:${f.source}`), ['sad:strong:author']);
        assert.equal(got[0]!.cause, '高数小测没考好');
        assert.deepEqual(feelingsAt(appraisals({ now: T0, history: [], moments: [moment({ at: iso(2) })] }), T0), []);
    });

    test('读文件：没有 = 没有；合格的读出来；写坏了不挪走、不覆盖，只记一次日志；改好了再读到', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-moments-'));
        try {
            const logs: string[] = [];
            const read = momentsReader(dir, line => logs.push(line));
            assert.deepEqual(read(), []);
            writeFileSync(join(dir, 'moments.json'), JSON.stringify({ moments: [moment()] }));
            assert.equal(read().length, 1);
            writeFileSync(join(dir, 'moments.json'), '{ 坏了');
            assert.equal(read().length, 1, '读不了时沿用上一次读到的');
            read();
            assert.equal(logs.length, 1, '同一个错只记一次');
            writeFileSync(join(dir, 'moments.json'), JSON.stringify({ moments: [moment({ id: 'a' }), moment({ id: 'b' })] }));
            assert.equal(read().length, 2);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('提示词里的一行', () => {
    const make = (kind: Felt['kind'], level: Felt['level'], patch: Partial<Felt> = {}): Felt => ({
        kind, level, weight: level === 'strong' ? 2.6 : level === 'clear' ? 1.5 : 0.8, cause: '某件事', source: 'world', aboutHim: false, ...patch,
    });
    const line = (list: Felt[], context: Partial<Parameters<typeof describeFeelings>[2]> = {}) =>
        describeFeelings(list, '宝宝', { melt: false, voiced: new Set(), mayCry: true, ...context });

    test('没有感受 / 只有刚能察觉的：没有这一行', () => {
        assert.equal(line([]), undefined);
        assert.equal(line([make('sad', 'faint')]), undefined);
    });

    test('难过：明显时话淡一点、嘴硬也行、不能哭；很重时可以哭；两句都带“不怪他、不要他哄”', () => {
        const clear = line([make('sad', 'clear', { cause: '高数小测没考好' })])!;
        assert.match(clear, /有点难过（高数小测没考好）/);
        assert.match(clear, /没事/);
        assert.doesNotMatch(clear, /哭/);
        const strong = line([make('sad', 'strong')])!;
        assert.match(strong, /很难过/);
        assert.match(strong, /哭了/);
        assert.match(strong, /不威胁/);
        assert.match(strong, /不怪他/);
        assert.match(strong, /让他走/);
    });

    test('他在关心她、她本来在难过：绷不住（可以哭）；前面哭过了就不再给哭的许可', () => {
        const melt = line([make('sad', 'clear')], { melt: true })!;
        assert.match(melt, /一直在忍/);
        assert.match(melt, /绷不住/);
        const cried = line([make('sad', 'strong')], { mayCry: false })!;
        assert.doesNotMatch(cried, /哭/);
        const meltCried = line([make('sad', 'clear')], { melt: true, mayCry: false })!;
        assert.doesNotMatch(meltCried, /绷不住/);
    });

    test('难过是他引起的（晾着她）：写“不翻旧账、不质问、不让他内疚”，不写“不怪他”', () => {
        const him = line([make('sad', 'clear', { aboutHim: true, source: 'him' })])!;
        assert.match(him, /不翻旧账、不质问、不让他内疚/);
        assert.doesNotMatch(him, /不怪他/);
    });

    test('开心 / 担心 / 烦 / 累 / 松口气各有方向；最多写两种；前面已经说过的这一轮不再强调', () => {
        assert.match(line([make('joy', 'strong')])!, /藏不住/);
        assert.match(line([make('joy', 'clear')])!, /语气轻快/);
        assert.match(line([make('worry', 'clear')])!, /不用主动讲/);
        assert.match(line([make('annoyed', 'clear')])!, /没耐心/);
        assert.match(line([make('tired', 'clear')])!, /回得短/);
        // 有来由的不想：累 / 烦 / 难过得明显时，他约她做什么，可以直说不想（会拒绝，ADR 0103；来由是她自己的状态，不是随机）
        for (const kind of ['tired', 'annoyed', 'sad'] as const) assert.match(line([make(kind, 'clear')])!, /(不用勉强答应|不用勉强|不用硬撑着答应)/, kind);
        assert.match(line([make('relief', 'clear')])!, /放松/);
        const three = line([make('sad', 'strong'), make('worry', 'clear'), make('joy', 'clear')])!;
        assert.match(three, /很难过/);
        assert.match(three, /担心/);
        assert.doesNotMatch(three, /开心/, '最多两种');
        const voiced = line([make('sad', 'strong')], { voiced: new Set(['sad']) })!;
        assert.match(voiced, /前面已经说过了/);
        assert.doesNotMatch(voiced, /哭了/);
        assert.match(line([make('sad', 'clear')])!, /不用解释自己的状态/);
        assert.match(line([make('sad', 'clear')])!, /没写的别编/);
    });

    test('心里压着事的时候回得短（feelsLow）：难过 / 担心 / 烦 / 累明显以上；开心或刚能察觉的不算；很开心盖过', () => {
        assert.equal(feelsLow([make('sad', 'clear')]), true);
        assert.equal(feelsLow([make('annoyed', 'strong')]), true);
        assert.equal(feelsLow([make('joy', 'strong')]), false);
        assert.equal(feelsLow([make('sad', 'faint')]), false);
        assert.equal(feelsLow([make('sad', 'clear'), make('joy', 'strong')]), false);
        assert.equal(feelsLow([make('relief', 'clear')]), false);
    });
});

describe('说出来的尺度', () => {
    test('她最近几条里说过这种感受 / 哭过：只看 3 小时 / 6 小时内她自己的话', () => {
        const history = [say(-1, 'user', '怎么了'), say(-0.9, 'assistant', '有点难过'), say(-0.5, 'assistant', '眼睛红了')];
        assert.deepEqual([...voicedKinds(history, T0)], ['sad']);
        assert.equal(criedRecently(history, T0), true);
        assert.deepEqual([...voicedKinds([say(-5, 'assistant', '好难过')], T0)], [], '3 小时前的不算');
        assert.equal(criedRecently([say(-7, 'assistant', '哭了一会儿')], T0), false, '6 小时前的不算');
        assert.equal(criedRecently([say(-1, 'user', '你哭了吗')], T0), false, '他说的不算');
    });

    test('他在关心她 / 问她怎么了', () => {
        for (const yes of ['怎么了', '你还好吗', '抱抱', '别哭了', '怎么不开心', '没事吧']) assert.equal(asksAfterHer(yes), true, yes);
        for (const no of ['在吗', '吃了没', '今天好累']) assert.equal(asksAfterHer(no), false, no);
    });

    test('常量：刚能察觉 < 明显 < 很重', () => {
        assert.ok(FAINT < CLEAR && CLEAR < STRONG);
    });
});
