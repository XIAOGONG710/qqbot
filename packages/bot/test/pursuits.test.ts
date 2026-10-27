// 她自己的追求（ADR 0104）：内置两条、进度只来自她做过的事、作者的文件、进心境、先弄完这一小段。

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import { loadTierCard } from '../src/contact.ts';
import { appraisals, feelingsAt } from '../src/emotion/feelings.ts';
import { describeIntent, dropsHerThing, holdPursuitIntent } from '../src/intent.ts';
import type { LifeEvent } from '../src/life-events.ts';
import { PHOTOGRAPHY_PROJECT_ID } from '../src/projects.ts';
import {
    BUILTIN_PURSUITS, CAMERA_STALL_DAYS, CAMERA_STEPS, CAMERA_THRESHOLDS, cameraProgress, describePursuits, mergePursuits, pursuitViews, pursuitsReader, quizRecord, validPursuits,
    type Pursuit, type PursuitFacts,
} from '../src/pursuits.ts';
import type { WorldNow } from '../src/world.ts';

const repoRoot = resolve(import.meta.dirname, '../../..');
const schedule = loadTierCard(join(repoRoot, 'characters/linmengyao/st/linmengyao-{tier}.json'), 'boyfriend').character.schedule!;
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const bought = new Date('2026-10-11T17:00:00+08:00');
const session = (index: number, at: Date): LifeEvent => ({
    id: `s${index}`, actor: 'linmengyao', kind: 'work_on_project', day: '2026-10-12', startedAt: new Date(at.getTime() - 90 * 60_000).toISOString(), endedAt: at.toISOString(),
    source: 'simulation', result: 'succeeded', target: PHOTOGRAPHY_PROJECT_ID, subject: '修片',
});
const sessions = (count: number, firstAt = bought.getTime() + DAY, spacing = DAY) => Array.from({ length: count }, (_, i) => session(i + 1, new Date(firstAt + i * spacing)));
const world = (state: 'bought' | 'planned' | undefined = 'bought'): WorldNow => ({
    day: '2026-10-22', atSchool: true, parcels: [], homework: [], events: [],
    ...(state ? { cameraFund: { saved: 4500, goal: 4500, camera: { start: new Date(bought.getTime() - 3 * HOUR), end: bought, where: '万象城', what: '微单', price: 4500, state } } } : {}),
});
const facts = (patch: Partial<PursuitFacts> = {}): PursuitFacts => ({ now: new Date('2026-10-22T20:00:00+08:00'), schedule, quizzes: false, ...patch });
const camera = (list = mergePursuits([])) => list.find(item => item.id === 'camera')!;

describe('内置的两条', () => {
    test('只有自传里写明的两条：别挂科、用新相机拍出自己满意的东西；不含毕业去向 / 家里期待这类悬着的问题', () => {
        assert.deepEqual(BUILTIN_PURSUITS.map(item => item.id), ['courses', 'camera']);
        const text = BUILTIN_PURSUITS.map(item => `${item.title}${item.why}`).join('');
        for (const word of ['考研', '就业', '实习', '出国', '妈妈', '期待', '毕业']) assert.ok(!text.includes(word), word);
        assert.equal(CAMERA_STEPS.length, CAMERA_THRESHOLDS.length);
    });

    test('摄影这条：相机没买就没有；买了之后按她认真弄过几回数到第几步（2 / 5 / 9 / 13 / 16 回）', () => {
        assert.deepEqual(pursuitViews([camera()], facts({ events: sessions(3), world: world('planned') })), []);
        assert.deepEqual(pursuitViews([camera()], facts({ events: sessions(3) })), [], '没有世界快照也没有');
        for (const [count, step] of [[0, 0], [1, 0], [2, 1], [4, 1], [5, 2], [9, 3], [13, 4], [16, 5], [20, 5]] as const) {
            assert.equal(cameraProgress(sessions(count), bought, new Date('2026-12-31T00:00:00+08:00')).step, step, String(count));
        }
        // 买相机以前的修片不算；失败的不算；还没发生的不算
        const before = [session(0, new Date(bought.getTime() - 2 * DAY)), { ...session(1, new Date(bought.getTime() + DAY)), result: 'failed' as const }, session(2, new Date('2026-10-30T00:00:00+08:00'))];
        assert.equal(cameraProgress(before, bought, new Date('2026-10-22T20:00:00+08:00')).sessions.length, 0);
        const [view] = pursuitViews([camera()], facts({ events: sessions(6, bought.getTime() + 2 * HOUR), world: world() }));
        assert.match(view!.text, /现在在第 3 步（拍一组校园的秋天）/);
        assert.match(view!.text, /做完的有：熟悉新相机的设置、拍一组土豆/);
        assert.match(view!.text, /认真弄过 6 回，上一回是/);
    });

    test('做完一步她开心（心境里一条评估，做完第五步更开心）；买了相机好几天没碰有点愧疚；做完了就不再愧疚', () => {
        const [view] = pursuitViews([camera()], facts({ events: sessions(5, bought.getTime() + 2 * HOUR), world: world() }));
        const joys = view!.appraisals.filter(a => a.kind === 'joy');
        assert.equal(joys.length, 2);
        assert.match(joys[0]!.cause, /熟悉新相机的设置/);
        const stall = pursuitViews([camera()], facts({ now: new Date('2026-10-22T20:00:00+08:00'), events: sessions(1, bought.getTime() + HOUR), world: world() }))[0]!;
        assert.ok(stall.appraisals.some(a => a.kind === 'worry' && /好几天没怎么拍/.test(a.cause)));
        const recent = pursuitViews([camera()], facts({ events: sessions(1, new Date('2026-10-21T20:00:00+08:00').getTime()), world: world() }))[0]!;
        assert.ok(!recent.appraisals.some(a => a.kind === 'worry'), '昨天刚拍过');
        const done = pursuitViews([camera()], facts({ events: sessions(16, bought.getTime() + 2 * HOUR, 6 * HOUR), world: world() }))[0]!;
        assert.ok(!done.appraisals.some(a => a.kind === 'worry'));
        assert.match(done.text, /这几步都做完了/);
        // 进心境：做完第五步后不久是开心（明显）
        const finishAt = Date.parse(sessions(16, bought.getTime() + 2 * HOUR, 6 * HOUR).at(-1)!.endedAt);
        const felt = feelingsAt(appraisals({ now: finishAt + HOUR, history: [], extra: done.appraisals }), finishAt + HOUR);
        assert.equal(felt[0]!.kind, 'joy');
        assert.match(felt[0]!.cause, /挑最满意的几张发到空间里/);
        assert.equal(CAMERA_STALL_DAYS, 7);
    });

    test('别挂科：开了小测的线才有数（出了分的次数、平均、最低是哪门）；没开只有她的话', () => {
        const [plain] = pursuitViews([BUILTIN_PURSUITS[0]!], facts());
        assert.match(plain!.text, /就想别挂科/);
        assert.doesNotMatch(plain!.text, /平均/);
        const now = new Date('2026-12-20T20:00:00+08:00');
        const record = quizRecord(schedule, now);
        assert.ok(record.length >= 6);
        const [view] = pursuitViews([BUILTIN_PURSUITS[0]!], facts({ now, quizzes: true }));
        assert.match(view!.text, new RegExp(`出了分的小测 ${record.length} 次`));
        const low = Math.min(...record.map(item => item.score));
        assert.match(view!.text, new RegExp(`最低 ${low}`));
        // 第二天出分：小测当天还没出分的不算
        const early = quizRecord(schedule, new Date('2026-09-15T12:00:00+08:00'));
        assert.equal(early.length, 0);
    });
});

describe('作者的文件', () => {
    const custom: Pursuit = { id: 'sing', title: '学会一首歌', why: '想学', status: 'active', steps: [{ text: '挑歌', doneAt: '2026-10-20T20:00:00+08:00' }, { text: '练熟' }] };

    test('格式：id、标题 2–30 字、状态、步骤 2–40 字最多 12 步；id 不重复', () => {
        assert.equal(validPursuits({ pursuits: [custom] }), true);
        for (const bad of [{ ...custom, id: '有 空格' }, { ...custom, title: '好' }, { ...custom, status: 'later' }, { ...custom, steps: [{ text: '好' }] }, { ...custom, steps: Array.from({ length: 13 }, () => ({ text: '一步一步来' })) }]) {
            assert.equal(validPursuits({ pursuits: [bad] }), false);
        }
        assert.equal(validPursuits({ pursuits: [custom, custom] }), false);
    });

    test('内置的两条可以被作者暂停 / 放下（按 id）；作者加的跟在后面；暂停的不进提示词', () => {
        const merged = mergePursuits([{ id: 'camera', title: '用新相机拍出自己满意的东西', why: '', status: 'paused' }, custom]);
        assert.deepEqual(merged.map(item => [item.id, item.status]), [['courses', 'active'], ['camera', 'paused'], ['sing', 'active']]);
        assert.equal(merged[1]!.builtin, true);
        const views = pursuitViews(merged, facts({ events: sessions(3), world: world() }));
        assert.deepEqual(views.map(view => view.pursuit.id), ['courses', 'sing']);
        const sing = views.find(view => view.pursuit.id === 'sing')!;
        assert.match(sing.text, /现在在第 2 步（练熟）/);
        assert.match(sing.text, /做完的有：挑歌/);
        assert.ok(sing.appraisals.some(a => a.kind === 'joy' && a.source === 'author' && /挑歌/.test(a.cause)));
    });

    test('读文件：没有 = 只有内置；写好的读出来；写坏了不挪走、不覆盖、只记一次，沿用上一次', () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-pursuits-'));
        dirs.push(dir);
        const logs: string[] = [];
        const read = pursuitsReader(dir, line => logs.push(line));
        assert.equal(read().length, 2);
        writeFileSync(join(dir, 'pursuits.json'), JSON.stringify({ pursuits: [custom] }));
        assert.equal(read().length, 3);
        writeFileSync(join(dir, 'pursuits.json'), '{ 坏了');
        assert.equal(read().length, 3, '沿用上一次');
        read();
        assert.equal(logs.length, 1);
    });
});

describe('提示词里的一小段', () => {
    test('她自己想做成的事，不是任务；不用主动提；没写的进展别编；没有就没有', () => {
        assert.equal(describePursuits([]), undefined);
        const line = describePursuits(pursuitViews(mergePursuits([]), facts({ events: sessions(3), world: world() })))!;
        assert.match(line, /^\[你自己想做成的事（是你的追求，不是任务；不用主动提/);
        assert.match(line, /①别挂科/);
        assert.match(line, /②用新相机拍出自己满意的东西/);
        assert.match(line, /没写的进展别编/);
        assert.doesNotMatch(line, /[「“]/, '不给台词');
    });
});

describe('先弄完这一小段（配合会拒绝，ADR 0103）', () => {
    const now = new Date('2026-10-22T20:00:00+08:00');
    const asked = (text: string) => [{ role: 'assistant' as const, content: '嗯' }, { role: 'user' as const, content: text }];

    test('他让她先放下手头的事陪他：她正在修片 / 拍照时，先弄完这一小段、给个大概的时间；不立刻放下也不冷；他认真需要她就放下', () => {
        for (const text of ['别修片了，陪我聊天', '先别拍了陪陪我', '放一放吧', '不要写了，来聊天']) {
            assert.equal(dropsHerThing(asked(text)), true, text);
            assert.equal(describeIntent({ history: asked(text), now, intimate: true, refuse: true, pursuitDoing: '修片' }), holdPursuitIntent('修片'), text);
        }
        const line = holdPursuitIntent('修片');
        assert.match(line, /你正在修片，这是你自己在意的事/);
        assert.match(line, /先把手上这一小段弄完，给个大概的时间/);
        assert.match(line, /别冷着/);
        assert.match(line, /他认真地说需要你/);
        assert.doesNotMatch(line, /[「」“”]/, '不给台词');
    });

    test('没在做 / 没开 herNo / 不是男朋友档 / 他难过 / 他说的不是放下：不触发', () => {
        const text = '别修片了，陪我聊天';
        assert.notEqual(describeIntent({ history: asked(text), now, intimate: true, refuse: true }), holdPursuitIntent('修片'), '没在做');
        assert.notEqual(describeIntent({ history: asked(text), now, intimate: true, pursuitDoing: '修片' }), holdPursuitIntent('修片'), '没开会拒绝');
        assert.notEqual(describeIntent({ history: asked(text), now, refuse: true, pursuitDoing: '修片' }), holdPursuitIntent('修片'), '不是男朋友档');
        assert.notEqual(describeIntent({ history: asked('我今天被骂了好难过，别修片了陪陪我'), now, intimate: true, refuse: true, pursuitDoing: '修片' }), holdPursuitIntent('修片'), '他难过让路');
        assert.equal(dropsHerThing(asked('修好了给我看看')), false);
        assert.equal(dropsHerThing(asked('你在修什么')), false);
    });
});
