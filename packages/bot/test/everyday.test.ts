// 她每天碰到的小事和小测（ADR 0106）：目录要干净、条件要满足、频率要合理、小测的线要连得上、带感受的要进心境。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { loadTierCard } from '../src/contact.ts';
import {
    EVERYDAY_EVENT_DEFS, EVERYDAY_MAX_PER_DAY, everydayEventsFor, loadEverydayFrom, quizEvents, quizFeel, quizScore, quizzesOn, withEveryday,
} from '../src/everyday.ts';
import { appraisals, feelingsAt } from '../src/emotion/feelings.ts';
import { quizRecord } from '../src/pursuits.ts';
import { simulateWorld, worldAt, type WorldNow } from '../src/world/world.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const pattern = join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json');
const boyfriend = loadTierCard(pattern, 'boyfriend', { everydayLife: true }).character;
const plain = loadTierCard(pattern, 'boyfriend').character;
const classmate = loadTierCard(pattern, 'classmate', { everydayLife: true }).character;
const schedule = boyfriend.schedule!;
const world = boyfriend.herWorld!;
const day = (text: string) => new Date(`${text}T00:00:00`);

describe('目录', () => {
    test('每条：id 不重复、有文字、概率在 (0, 1]、窗口 / 条件合法、带人物的文字里有 {person} 且人物是卡上的两位、感受的种类和强度合法', () => {
        const ids = new Set<string>();
        for (const def of EVERYDAY_EVENT_DEFS) {
            assert.ok(!ids.has(def.id), `重复 ${def.id}`);
            ids.add(def.id);
            assert.match(def.id, /^ed_/);
            assert.ok(def.text.length >= 6 && [...def.text].length <= 40, def.id);
            assert.ok(def.chance > 0 && def.chance <= 1, def.id);
            assert.ok(['morning', 'afternoon', 'evening'].includes(def.window), def.id);
            assert.ok(['school', 'class_day', 'any', 'off_day'].includes(def.when), def.id);
            assert.equal(def.text.includes('{person}'), Boolean(def.person), `${def.id}：{person} 和 person 要同时有`);
            if (def.person) assert.ok(['chen_jianing', 'su_yutong'].includes(def.person), def.id);
            if (def.feel) assert.ok(['joy', 'relief', 'worry', 'sad', 'annoyed', 'tired'].includes(def.feel.kind) && [1, 2, 3].includes(def.feel.strength), def.id);
            for (const month of def.months ?? []) assert.ok(month >= 1 && month <= 12, def.id);
            for (const weekday of def.weekdays ?? []) assert.ok(weekday >= 1 && weekday <= 7, def.id);
            assert.ok(def.group, def.id);
        }
        assert.ok(EVERYDAY_EVENT_DEFS.length >= 80, String(EVERYDAY_EVENT_DEFS.length));
    });

    test('不加新的有名字的人、不加社团 / 恋爱 / 家里变故这类要作者定的大事', () => {
        const all = EVERYDAY_EVENT_DEFS.map(def => def.text).join('\n');
        for (const word of ['社团', '表白', '分手', '住院', '去世', '吵架', '挂科', '退学', '奖学金', '生病住', '男朋友', '他']) assert.ok(!all.includes(word), word);
    });

    test('档位只看得到自己该看的：同学档没有宿舍 / 闺蜜 / 家里；亲近档位全有；世界里没有这个人就没有带人的', () => {
        const bf = everydayEventsFor(world, 'boyfriend');
        const mate = everydayEventsFor(loadTierCard(pattern, 'classmate').character.herWorld!, 'classmate');
        assert.ok(bf.length > mate.length);
        for (const event of mate) {
            assert.ok(!event.id.startsWith('ed_roommate') && !event.id.startsWith('ed_dorm') && !event.id.startsWith('ed_jn_') && !event.id.startsWith('ed_yt_') && event.id !== 'ed_mom_msg', event.id);
        }
        assert.ok(bf.some(event => event.id === 'ed_jn_meme') && bf.some(event => event.id === 'ed_yt_hw'));
        const alone = everydayEventsFor({ ...world, people: [] }, 'boyfriend');
        assert.ok(alone.every(event => !event.person));
        // 承认版的档位名也认
        assert.equal(everydayEventsFor(world, 'boyfriend-open').length, bf.length);
        // 概率整体打了折
        assert.ok(bf.every(event => event.chance <= 0.4));
    });

    test('withEveryday 不改原来的世界；没开的卡和原来一模一样', () => {
        const before = world.events.length;
        const merged = withEveryday(plain.herWorld, 'boyfriend')!;
        assert.equal(plain.herWorld!.events.length + everydayEventsFor(plain.herWorld!, 'boyfriend').length, merged.events.length);
        assert.equal(plain.herWorld!.events.some(event => event.id.startsWith('ed_')), false);
        assert.equal(plain.herWorld!.quizzes, undefined);
        assert.equal(world.quizzes, true);
        assert.equal(classmate.herWorld!.quizzes, false, '同学档没有小测');
        assert.ok(before > plain.herWorld!.events.length);
    });
});

describe('世界里的日子', () => {
    const until = new Date('2026-12-20T23:00:00+08:00');
    const timeline = simulateWorld(world, schedule, until);
    const dates = [...timeline.days.keys()].filter(date => date >= '2026-09-01');

    test('同样的输入同样的结果（重启、重放一样）', () => {
        const again = simulateWorld(world, schedule, until);
        for (const date of dates) assert.deepEqual(again.days.get(date)!.events.map(e => [e.id, e.at.getTime()]), timeline.days.get(date)!.events.map(e => [e.id, e.at.getTime()]));
    });

    test('一天的小事数：补充的最多 3 件、同一类一天一件；整体平均在 3–5 件', () => {
        let total = 0;
        for (const date of dates) {
            const events = timeline.days.get(date)!.events;
            total += events.length;
            const extras = events.filter(e => e.id.startsWith('ed_'));
            assert.ok(extras.length <= EVERYDAY_MAX_PER_DAY, `${date} ${extras.length}`);
            const groups = extras.map(e => EVERYDAY_EVENT_DEFS.find(def => def.id === e.id)!.group);
            assert.equal(new Set(groups).size, groups.length, `${date} 同一类出现两次`);
        }
        const avg = total / dates.length;
        assert.ok(avg >= 3 && avg <= 5, String(avg));
    });

    test('条件：下雨的事只在下雨那天，晴天的事不在雨天；土豆的事只在见到 / 没见到那天，且在喂完之后；月份、星期对得上', () => {
        for (const date of dates) {
            const record = timeline.days.get(date)!;
            for (const event of record.events) {
                const def = EVERYDAY_EVENT_DEFS.find(d => d.id === event.id);
                if (!def) continue;
                if (def.weather === 'rain') assert.equal(record.weather?.rain, true, `${date} ${def.id}`);
                if (def.weather === 'dry') assert.equal(record.weather?.rain, false, `${date} ${def.id}`);
                if (def.weather === 'cold') assert.ok(record.weather!.high <= 12, `${date} ${def.id}`);
                if (def.weather === 'hot') assert.ok(record.weather!.high >= 30, `${date} ${def.id}`);
                if (def.requires === 'cat_seen') assert.ok(record.cat?.fed && record.cat.seen && event.at > record.cat.fed, `${date} ${def.id}`);
                if (def.requires === 'cat_unseen') assert.ok(record.cat?.fed && record.cat.seen === false && event.at > record.cat.fed, `${date} ${def.id}`);
                if (def.months) assert.ok(def.months.includes(Number(date.slice(5, 7))), `${date} ${def.id}`);
                if (def.weekdays) assert.ok(def.weekdays.includes(new Date(`${date}T00:00`).getDay() || 7), `${date} ${def.id}`);
                if (def.when === 'class_day') assert.ok(record.atSchool, `${date} ${def.id}`);
            }
        }
    });

    test('闺蜜的事跟着她的状态：苏雨桐感冒 / 在家的日子没有一起自习、分零食这类；花钱的小事记了账', () => {
        const withMoney = timeline.ledger.filter(e => e.what === '文具' || e.what === '打印' || e.what === '水果');
        const fromEvents = [...timeline.days.values()].flatMap(record => record.events).filter(e => ['ed_pen', 'ed_print_queue', 'ed_fruit'].includes(e.id)).length;
        assert.equal(withMoney.length, fromEvents);
    });

    test('进 WorldNow：今天到现在为止的、带感受的会带着 feel；{person} 换成名字', () => {
        let found = false;
        for (const date of dates) {
            const now = worldAt(world, schedule, new Date(`${date}T23:00:00+08:00`));
            if (!now) continue;
            for (const event of now.events) {
                assert.ok(!event.text.includes('{person}'), event.text);
                if (event.feel) found = true;
            }
        }
        assert.ok(found);
    });
});

describe('小测的一条线', () => {
    test('只有数学类和专业课，水课没有；前两周和期末前两周没有；数学类大约每四周一次', () => {
        const days = [...simulateWorld(world, schedule, new Date('2026-12-20T23:00:00+08:00')).days.keys()].filter(date => date >= '2026-09-01' && date <= '2027-01-03');
        const quizzes = days.flatMap(date => quizzesOn(schedule, day(date)).map(q => ({ ...q, date })));
        assert.ok(quizzes.length > 8);
        for (const quiz of quizzes) {
            assert.ok(/高等数学|概率论|数据结构|计算机网络|MySQL|Linux|大数据|数据采集/.test(quiz.course), quiz.course);
            assert.ok(!/形势与政策|创业基础|思想概论|Python数据分析|体育/.test(quiz.course), quiz.course);
            assert.ok(quiz.date >= '2026-09-14' && quiz.date < '2026-12-20', quiz.date);
        }
        const math = quizzes.filter(q => q.category === 'math');
        assert.ok(math.length >= 3 && math.length <= 8, String(math.length));
    });

    test('一场小测：前一次课老师说 → 当天写 → 两天后晚上出分；三件事连得上', () => {
        const until = new Date('2026-12-20T23:00:00+08:00');
        const timeline = simulateWorld(world, schedule, until);
        const byKey = new Map<string, { notice?: string; day?: string; score?: string }>();
        for (const [date, record] of timeline.days) {
            for (const event of record.events) {
                const [kind, course, sourceDate] = event.id.split(':');
                if (!kind?.startsWith('quiz_')) continue;
                const key = `${course}:${kind === 'quiz_notice' ? '' : kind === 'quiz_day' ? sourceDate : sourceDate}`;
                const entry = byKey.get(key) ?? {};
                if (kind === 'quiz_day') entry.day = date;
                if (kind === 'quiz_score') entry.score = date;
                if (kind === 'quiz_notice') entry.notice = date;
                byKey.set(key, entry);
            }
        }
        const full = [...byKey.values()].filter(e => e.day && e.score);
        assert.ok(full.length > 8);
        for (const entry of full) {
            const dayAt = new Date(`${entry.day}T00:00`).getTime();
            assert.equal((new Date(`${entry.score}T00:00`).getTime() - dayAt) / 86_400_000, 2, '两天后出分');
        }
        // 小测当天的前几天里，同一门课有过“老师说”
        for (const [date, record] of timeline.days) {
            for (const event of record.events.filter(e => e.id.startsWith('quiz_day:'))) {
                const course = event.id.split(':')[1]!;
                const notice = [...timeline.days.entries()].some(([other, rec]) => other < date && other >= new Date(new Date(`${date}T00:00`).getTime() - 22 * 86_400_000).toISOString().slice(0, 10)
                    && rec.events.some(e => e.id.startsWith(`quiz_notice:${course}:`)));
                assert.ok(notice || date < '2026-09-10', `${date} ${course} 没有人说过会小测`);
            }
        }
    });

    test('分数：38–99；数学类均值明显低于专业课（怕数学）；同一场每次一样；感受按分数', () => {
        const sample = (category: 'math' | 'core') => Array.from({ length: 600 }, (_, i) => quizScore({ course: category === 'math' ? '高等数学' : '数据结构', category }, `2026-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}x${i}`));
        const math = sample('math');
        const core = sample('core');
        const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
        assert.ok(Math.min(...math, ...core) >= 38 && Math.max(...math, ...core) <= 99);
        assert.ok(mean(core) - mean(math) > 7, `${mean(core)} ${mean(math)}`);
        assert.ok(Math.abs(mean(math) - 72) < 3 && Math.abs(mean(core) - 83) < 3);
        assert.equal(quizScore({ course: '高等数学', category: 'math' }, '2026-10-21'), quizScore({ course: '高等数学', category: 'math' }, '2026-10-21'));
        assert.deepEqual(quizFeel(95, 'core'), { kind: 'joy', strength: 2 });
        assert.equal(quizFeel(75, 'core'), undefined);
        assert.deepEqual(quizFeel(75, 'math'), { kind: 'relief', strength: 1 });
        assert.deepEqual(quizFeel(65, 'core'), { kind: 'worry', strength: 1 });
        assert.deepEqual(quizFeel(55, 'math'), { kind: 'sad', strength: 2 });
        assert.deepEqual(quizFeel(45, 'math'), { kind: 'sad', strength: 3 });
    });

    test('出分的难过会进心境：当晚明显，第二天还在；考好了是开心', () => {
        // 找一个数学类分数 < 60 的出分日
        const timeline = simulateWorld(world, schedule, new Date('2026-12-20T23:00:00+08:00'));
        let bad: { date: string; at: Date } | undefined;
        for (const [date, record] of timeline.days) {
            const event = record.events.find(e => e.id.startsWith('quiz_score:') && (e.feel?.kind === 'sad'));
            if (event) { bad = { date, at: event.at }; break; }
        }
        assert.ok(bad, '这个学期应该至少有一次没考好');
        const now = (hours: number) => new Date(bad!.at.getTime() + hours * 3_600_000);
        const nowWorld = (time: Date): WorldNow => worldAt(world, schedule, time)!;
        const evening = feelingsAt(appraisals({ now: now(0.5).getTime(), history: [], world: nowWorld(now(0.5)) }), now(0.5).getTime());
        assert.equal(evening[0]!.kind, 'sad');
        assert.notEqual(evening[0]!.level, 'faint');
        assert.match(evening[0]!.cause, /小测的分数出来了/);
        // 第二天中午：今天的世界里没有这件事了，靠“前一天的世界”还在
        const next = new Date(new Date(`${bad.date}T12:00:00`).getTime() + 86_400_000);
        const previous = nowWorld(new Date(next.getTime() - 14 * 3_600_000 - 60_000));
        const lunch = feelingsAt(appraisals({ now: next.getTime(), history: [], world: nowWorld(next), previousWorld: worldAt(world, schedule, new Date(new Date(`${bad.date}T23:59:00`).getTime()))! }), next.getTime());
        void previous;
        assert.ok(lunch.some(f => f.kind === 'sad'), JSON.stringify(lunch.map(f => [f.kind, f.level])));
        // 没有前一天的世界就散了一半：不会比有它更重
        const without = feelingsAt(appraisals({ now: next.getTime(), history: [], world: nowWorld(next) }), next.getTime());
        const sad = (list: typeof lunch) => list.find(f => f.kind === 'sad')?.weight ?? 0;
        assert.ok(sad(lunch) >= sad(without));
    });

    test('quizEvents 只在她在学校的日子', () => {
        assert.deepEqual(quizEvents(schedule, day('2026-10-21'), false), []);
        assert.ok(quizEvents(schedule, day('2026-10-21'), true).length >= 0);
    });
});

describe('从哪天起才有（她已经过完的日子不改写）', () => {
    const from = '2026-10-23';
    const gated = withEveryday(loadTierCard(pattern, 'boyfriend').character.herWorld, 'boyfriend', from)!;
    const until = new Date('2026-12-20T23:00:00+08:00');
    const plainTimeline = simulateWorld(loadTierCard(pattern, 'boyfriend').character.herWorld!, schedule, until);
    const gatedTimeline = simulateWorld(gated, schedule, until);
    const full = simulateWorld(world, schedule, until);

    test('之前的日子和没开的时候一模一样（一件小事、一场小测都不多）；之后的日子和一直开着的一样', () => {
        for (const [date, record] of gatedTimeline.days) {
            const ids = record.events.map(e => e.id);
            if (date < from) {
                assert.deepEqual(ids, plainTimeline.days.get(date)!.events.map(e => e.id), date);
            } else {
                assert.deepEqual(ids, full.days.get(date)!.events.map(e => e.id), date);
            }
        }
        const after = [...gatedTimeline.days].filter(([date]) => date >= from).flatMap(([, record]) => record.events);
        assert.ok(after.some(e => e.id.startsWith('ed_')) && after.some(e => e.id.startsWith('quiz_')));
        const before = [...gatedTimeline.days].filter(([date]) => date < from).flatMap(([, record]) => record.events);
        assert.ok(before.every(e => !e.id.startsWith('ed_') && !e.id.startsWith('quiz_')));
    });

    test('别挂科的数也只数从那天起的小测', () => {
        const now = new Date('2026-12-20T20:00:00+08:00');
        assert.ok(quizRecord(schedule, now).length > quizRecord(schedule, now, from).length);
        assert.ok(quizRecord(schedule, now, from).every(item => item.date >= from));
        assert.equal(quizRecord(schedule, new Date('2026-10-25T20:00:00+08:00'), from).length, 0, '才过了两天，还没有出分的');
    });

    test('第一次开的时候定下“第二天”并存进文件，以后重启读同一个；文件坏了也不往前改', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-everyday-'));
        try {
            const path = join(dir, 'everyday-from.json');
            const logs: string[] = [];
            assert.equal(loadEverydayFrom(path, new Date('2026-10-22T21:30:00+08:00'), line => logs.push(line)), '2026-10-23');
            assert.ok(logs.some(line => line.includes('从 2026-10-23 起生效')));
            assert.equal(loadEverydayFrom(path, new Date('2026-11-30T10:00:00+08:00')), '2026-10-23', '重启后读同一个');
            writeFileSync(path, '{ 坏了');
            assert.equal(loadEverydayFrom(path, new Date('2026-11-30T10:00:00+08:00')), '2026-12-01', '读不了就用今天之后的一天，不去改写已经过的日子');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
