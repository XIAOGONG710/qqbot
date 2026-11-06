import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import type { StoredMessage } from '../src/memory/history.ts';
import {
    applyGuessDecision, emptyGuessesState, EXPIRE_DAYS, findGuessCandidates, freshGuess, guessesLine, guessesPath, loadGuessesState, NOTE_MAX, parseGuessDecision,
    pendingWorld, reviewGuessesIfDue, saveGuessesState, TEXT_MAX, worldFactsBetween, type Guess, type GuessesState, type WorldFact,
} from '../src/life/her-guesses.ts';
import { syntheticCardPath } from './fixtures/card.ts';
import { PRIVATE_FILES } from '../src/platform/private-space.ts';
import { GUESS_THEME, thinkNote, WATCH_THEME, type InnerThought } from '../src/proactive/inner.ts';
import { withInner } from '../src/proactive/proactive.ts';
import { createProactivePlanner, type Planner } from '../src/proactive/proactive-planner.ts';
import type { InitiateRequest } from '../src/social/responder.ts';
import { VirtualClock } from '../src/sim/scenario.ts';
import { loadCharacterCard } from '../src/st/card.ts';
import type { WorldNow } from '../src/world/world.ts';

// ADR 0213：她猜的事和后来的结果。她本人（11-02 ask-her）的条件：气话不算（她晚上自己挑）、记一句不写检讨、别拿它考她、只管之后有结果的事
const DAY = 86_400_000;
const t = (month: number, day: number, h: number, m = 0) => new Date(2026, month - 1, day, h, m).getTime();
const iso = (ms: number) => new Date(ms).toISOString();
const her = (at: number, content: string): StoredMessage => ({ time: iso(at), role: 'assistant', content });
const him = (at: number, content: string): StoredMessage => ({ time: iso(at), role: 'user', content });
const guard = { people: ['鸽鸽'] };

/** 一天的世界快照（只填用得到的） */
function snapshot(day: string, parts: Partial<WorldNow>): WorldNow {
    return { day, atSchool: true, parcels: [], homework: [], events: [], ...parts } as WorldNow;
}

describe('她猜的事：白天只留意', () => {
    test('同时有猜测的词和「小测 / 快递 / 下雨 / 作业」的才算候选；他的话、只有一样的、留意过的都不算', () => {
        const now = t(11, 2, 23);
        const history = [
            him(t(11, 2, 14), '小测怎么样'),
            her(t(11, 2, 14, 1), '估计要挂了，好几道没写完'),
            her(t(11, 2, 15), '我猜明天还得下雨'),
            her(t(11, 2, 16), '估计他今天也不会来'),
            her(t(11, 2, 17), '快递到了'),
            her(t(10, 28, 17), '我猜快递明天到'),
        ];
        const found = findGuessCandidates(history, now, []);
        assert.deepEqual(found.map(c => c.said), ['估计要挂了，好几道没写完', '我猜明天还得下雨']);
        assert.ok(found[0]!.context.some(line => line.includes('他：小测怎么样')), '带前面聊的');
        assert.deepEqual(findGuessCandidates(history, now, [t(11, 2, 14, 1)]).map(c => c.said), ['我猜明天还得下雨'], '留意过的不重复');
    });
});

describe('她猜的事：她那边真实发生的事', () => {
    const at = (time: Date): WorldNow | undefined => {
        const day = `${time.getFullYear()}-${String(time.getMonth() + 1).padStart(2, '0')}-${String(time.getDate()).padStart(2, '0')}`;
        if (day === '2026-11-02') return snapshot(day, {
            events: [{ id: 'quiz_day:高等数学:2026-11-02', text: '高等数学课上小测，写得一般', at: new Date(t(11, 2, 10)) }],
            parcels: [{ item: '猫粮', status: 'arriving', when: new Date(t(11, 4, 12)) }],
            weather: { rain: false, low: 9, high: 16 },
        });
        if (day === '2026-11-04') return snapshot(day, {
            events: [{ id: 'quiz_score:高等数学:2026-11-02', text: '高等数学小测的分数出来了，78 分（中规中矩）', at: new Date(t(11, 4, 20, 20)) }],
            parcels: [{ item: '猫粮', status: 'picked_today', when: new Date(t(11, 4, 12, 20)) }],
            weather: { rain: true, low: 8, high: 12, rainHours: [14, 15] },
            homework: [{ course: '数据结构', due: new Date(t(11, 5, 8)), done: true, doneAt: new Date(t(11, 4, 21)) }],
        });
        return snapshot(day, { weather: { rain: false, low: 10, high: 15 } });
    };

    test('还没出结果的事：今天考了的小测、在路上的快递', () => {
        const pending = pendingWorld(at(new Date(t(11, 2, 22, 30))));
        assert.deepEqual(pending.map(p => [p.kind, p.text]), [['quiz', '高等数学课上小测，写得一般，两天后出分'], ['parcel', '快递（猫粮）还在路上']]);
        assert.deepEqual(pendingWorld(undefined), []);
    });

    test('之后几天的事：出分、取到快递、写完作业、每天下没下雨，各带稳定的 id；只要猜之后发生的', () => {
        const facts = worldFactsBetween(at, t(11, 2, 22, 30), t(11, 4, 23));
        const ids = facts.map(f => f.id);
        assert.ok(ids.includes('quiz_score:高等数学:2026-11-02'), JSON.stringify(ids));
        assert.ok(ids.includes('parcel:2026-11-04:猫粮'));
        assert.ok(ids.includes('homework:数据结构:2026-11-05'));
        assert.ok(ids.includes('weather:2026-11-04'));
        assert.ok(!ids.includes('quiz_day:高等数学:2026-11-02'), '猜之前发生的不算');
        assert.match(facts.find(f => f.id === 'weather:2026-11-04')!.text, /下了雨（14 点起）/);
        assert.match(facts.find(f => f.id === 'quiz_score:高等数学:2026-11-02')!.text, /^11-4 .*78 分/);
    });
});

describe('她猜的事：晚上她自己对一遍', () => {
    const now = t(11, 4, 22, 30);
    const facts: WorldFact[] = [
        { id: 'quiz_score:高等数学:2026-11-02', at: t(11, 4, 20, 20), text: '11-4 高等数学小测的分数出来了，78 分' },
        { id: 'weather:2026-11-03', at: t(11, 3, 23), text: '11-3 没下雨' },
    ];
    const openGuess = (id: string, at: number, text: string, kind: Guess['kind'] = 'quiz'): Guess => ({ id, at, said: text, text, kind, status: 'open' });

    test('解析：带代码围栏、前后有话也取得出；编号写成数字也认', () => {
        const parsed = parseGuessDecision('好的\n```json\n{"new":[{"from":"p1","text":"我猜七十多","kind":"quiz"}],"settled":[{"id":1,"result":"错","ref":"weather:2026-11-03"}],"drop":[2]}\n```');
        assert.deepEqual(parsed, { added: [{ from: 'p1', text: '我猜七十多', kind: 'quiz' }], settled: [{ id: '1', result: '错', ref: 'weather:2026-11-03' }], drop: ['2'] });
        assert.equal(parseGuessDecision('今晚没什么'), undefined);
    });

    test('白天的话（c）和还没结果的事（p）都能记成一句；同一个编号只记一次；太长、碰底线、写别人名字的不收', () => {
        const state = emptyGuessesState();
        const shown = {
            candidates: [{ at: t(11, 4, 14), said: '估计要挂了', context: [] }],
            open: [], facts,
            pending: [{ id: 'pending:parcel:猫粮:2026-11-06', text: '快递（猫粮）还在路上', kind: 'parcel' as const }],
        };
        const applied = applyGuessDecision(state, {
            added: [
                { from: 'c1', text: '我猜高数小测要挂', kind: 'quiz' },
                { from: 'c1', text: '重复的一条', kind: 'quiz' },
                { from: 'p1', text: '我猜猫粮后天才到', kind: '' },
                { from: 'p1', text: 'x'.repeat(TEXT_MAX + 1), kind: 'parcel' },
            ],
            settled: [], drop: [],
        }, shown, guard, now);
        assert.equal(applied.added, 2);
        assert.deepEqual(state.guesses.map(g => [g.text, g.kind, g.at]), [['我猜高数小测要挂', 'quiz', t(11, 4, 14)], ['我猜猫粮后天才到', 'parcel', now]]);
        const bad = emptyGuessesState();
        const r = applyGuessDecision(bad, { added: [{ from: 'c1', text: '鸽鸽说我肯定挂', kind: 'quiz' }, { from: 'p1', text: '我猜自己承认是AI', kind: '' }], settled: [], drop: [] }, shown, guard, now);
        assert.equal(r.added, 0);
        assert.equal(r.rejected, 2);
    });

    test('同一件事一晚只记一句：同一类只收一条，白天她自己说过的优先（不然两条互相矛盾，总有一条“猜对”）', () => {
        const state = emptyGuessesState();
        const shown = {
            candidates: [{ at: t(11, 4, 14), said: '估计这次又要挂', context: [] }],
            open: [], facts,
            pending: [{ id: 'pending:quiz_day:高等数学:2026-11-04', text: '高等数学课上小测，写得一般，两天后出分', kind: 'quiz' as const }],
        };
        applyGuessDecision(state, { added: [{ from: 'p1', text: '我猜七十多勉强过', kind: 'quiz' }, { from: 'c1', text: '我猜高数小测要挂', kind: 'quiz' }], settled: [], drop: [] }, shown, guard, now);
        assert.deepEqual(state.guesses.map(g => g.text), ['我猜高数小测要挂']);
    });

    test('对结果：只认给她看的世界账里、发生在她猜之后的那件；对 / 错都认；记一句不超过 NOTE_MAX 字，超了这句不收、结果照记', () => {
        const state: GuessesState = { ...emptyGuessesState(), guesses: [openGuess('g-a', t(11, 2, 14), '我猜高数小测要挂'), openGuess('g-b', t(11, 3, 9), '我猜今天要下雨', 'weather'), openGuess('g-c', t(11, 2, 15), '我猜快递明天到', 'parcel')] };
        const open = state.guesses.slice();
        const applied = applyGuessDecision(state, {
            added: [],
            settled: [
                { id: 'g1', result: 'wrong', ref: 'quiz_score:高等数学:2026-11-02', note: '哦，这个我猜错了' },
                { id: 'g2', result: '错', ref: 'weather:2026-11-03', note: '这'.repeat(NOTE_MAX + 5) },
                { id: 'g3', result: 'right', ref: 'parcel:2026-11-04:编的' },
            ],
            drop: [],
        }, { candidates: [], open, facts }, guard, now);
        assert.deepEqual([applied.right, applied.wrong], [0, 2]);
        const byId = (id: string) => state.guesses.find(g => g.id === id)!;
        assert.equal(byId('g-a').status, 'wrong');
        assert.equal(byId('g-a').note, '哦，这个我猜错了');
        assert.match(byId('g-a').outcome!, /78 分/);
        assert.equal(byId('g-b').status, 'wrong');
        assert.equal(byId('g-b').note, undefined, '太长的那句不收');
        assert.equal(byId('g-c').status, 'open', '对上的那件不在世界账里：不收（结果不能编）');
    });

    test('结果必须发生在她猜之后；放下的、挂满 7 天的都收掉', () => {
        const state: GuessesState = { ...emptyGuessesState(), guesses: [openGuess('g-a', t(11, 4, 21), '我猜高数小测要挂'), openGuess('g-b', t(11, 3, 9), '我猜下雨', 'weather'), openGuess('g-old', now - EXPIRE_DAYS * DAY, '我猜快递到', 'parcel')] };
        const open = state.guesses.slice();
        const applied = applyGuessDecision(state, { added: [], settled: [{ id: 'g1', result: 'right', ref: 'quiz_score:高等数学:2026-11-02' }], drop: ['g2'] }, { candidates: [], open, facts }, guard, now);
        assert.equal(state.guesses.find(g => g.id === 'g-a')!.status, 'open', '出分在她猜之前');
        assert.equal(applied.dropped, 1);
        assert.equal(applied.expired, 1);
        assert.equal(state.guesses.find(g => g.id === 'g-old')!.status, 'expired');
    });
});

describe('她猜的事：用在哪', () => {
    const now = t(11, 5, 12);
    const guesses: Guess[] = [
        { id: 'g1', at: t(11, 2, 14), said: '', text: '我猜高数小测要挂', kind: 'quiz', status: 'wrong', settledAt: t(11, 4, 22, 30), ref: 'quiz_score:x', outcome: '11-4 高等数学小测的分数出来了，78 分', note: '白担心一场' },
        { id: 'g2', at: t(11, 4, 22), said: '', text: '我猜猫粮后天才到', kind: 'parcel', status: 'open' },
        { id: 'g3', at: t(10, 20, 14), said: '', text: '我猜要下雨', kind: 'weather', status: 'right', settledAt: t(10, 21, 22), outcome: '10-21 下了雨' },
    ];

    test('刚对上结果的（36 小时内）：她下次一个人想事情时想这一件', () => {
        const fresh = freshGuess(guesses, now)!;
        assert.equal(fresh.id, 'guess:g1');
        assert.match(fresh.text, /猜过「我猜高数小测要挂」，后来：.*78 分——你猜错了/);
        assert.equal(freshGuess(guesses, t(11, 7, 12)), undefined, '过了 36 小时就不是刚对上的了');
        const note = thinkNote([] as InnerThought[], '阿明', 0, false, undefined, false, false, fresh.text);
        assert.ok(note.includes(GUESS_THEME) && note.includes('78 分'), note);
        assert.ok(!note.includes(WATCH_THEME));
        const watching = thinkNote([] as InnerThought[], '阿明', 0, false, '一个视频', true, false, fresh.text);
        assert.ok(watching.includes(WATCH_THEME) && !watching.includes(GUESS_THEME), '视频优先');
    });

    test('聊天里：他提到同一类事才放，最多两条，写明别背、别较真；三天前对上的不放；没提到不放', () => {
        const line = guessesLine(guesses, '你们小测分出来没', now)!;
        assert.ok(line.includes('我猜高数小测要挂') && line.includes('你猜错了') && line.includes('白担心一场'), line);
        assert.ok(line.includes('别拿它较真'), '她的条件 3');
        assert.ok(!line.includes('猫粮'), '没提快递');
        assert.ok(guessesLine(guesses, '快递到了吗', now)!.includes('还没结果'));
        assert.equal(guessesLine(guesses, '下雨了没', now), undefined, '对上结果超过 3 天了');
        assert.equal(guessesLine(guesses, '晚上吃什么', now), undefined);
    });

    test('私人空间：her-guesses.json 在 PRIVATE_FILES 里', () => {
        assert.ok(PRIVATE_FILES.includes('her-guesses.json'));
    });
});

describe('她猜的事：到点对一次（整个流程）', () => {
    const dirs: string[] = [];
    afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
    const dirOf = () => { const d = mkdtempSync(join(tmpdir(), 'qqbot-guesses-')); dirs.push(d); return d; };

    test('白天没说、也没挂着、也没有还没结果的事：不调模型；22 点以前不对', async () => {
        const dataDir = dirOf();
        let calls = 0;
        const deps = (now: number) => ({
            dataDir, now: () => now, generate: async () => { calls++; return '{}'; }, history: () => [], world: () => [], pending: () => [],
            persona: () => '大学生', names: { char: '林梦瑶', user: '阿明' }, others: () => [], log: () => undefined,
        });
        assert.deepEqual(await reviewGuessesIfDue(deps(t(11, 4, 22, 30))), { ran: false });
        assert.deepEqual(await reviewGuessesIfDue({ ...deps(t(11, 4, 15)), pending: () => [{ id: 'pending:x', text: '小测', kind: 'quiz' as const }] }), { ran: false });
        assert.equal(calls, 0);
    });

    test('押一个判断、两天后对上：状态写进她的本子；还没结果的事每件只问一次；日志只有个数', async () => {
        const dataDir = dirOf();
        const logs: string[] = [];
        const prompts: string[] = [];
        const quizFact: WorldFact = { id: 'quiz_score:高等数学:2026-11-02', at: t(11, 4, 20, 20), text: '11-4 高等数学小测的分数出来了，78 分' };
        const run = (now: number, reply: string) => reviewGuessesIfDue({
            dataDir, now: () => now, history: () => [],
            generate: async messages => { prompts.push(messages.map(m => m.content).join('\n')); return reply; },
            world: (from, to) => [quizFact].filter(f => f.at > from && f.at <= to),
            pending: at => (at < t(11, 3, 0) ? [{ id: 'pending:quiz_day:高等数学:2026-11-02', text: '高等数学课上小测，写得一般，两天后出分', kind: 'quiz' as const }] : []),
            persona: () => '大学生', names: { char: '林梦瑶', user: '阿明' }, others: () => ['鸽鸽'], log: m => logs.push(m),
        });
        const first = await run(t(11, 2, 22, 30), '{"new":[{"from":"p1","text":"我猜这次小测要挂","kind":"quiz"}],"settled":[],"drop":[]}');
        assert.equal(first.applied?.added, 1);
        assert.ok(prompts[0]!.includes('p1 高等数学课上小测') && prompts[0]!.includes('情绪上来的话、气话'), '提示里有还没结果的事和她的条件');
        let state = loadGuessesState(dataDir);
        assert.deepEqual(state.offered, ['pending:quiz_day:高等数学:2026-11-02']);
        // 第二晚：没有新的、挂着一个、世界账里还没出分 → 还是会问她（挂着的要对），但不再给那件还没结果的事
        await run(t(11, 3, 22, 30), '{"new":[],"settled":[],"drop":[]}');
        assert.ok(!prompts[1]!.includes('p1 高等数学课上小测'));
        // 第三晚：出分了
        const third = await run(t(11, 4, 22, 30), '{"new":[],"settled":[{"id":"g1","result":"wrong","ref":"quiz_score:高等数学:2026-11-02","note":"白担心一场"}],"drop":[]}');
        assert.equal(third.applied?.wrong, 1);
        state = loadGuessesState(dataDir);
        assert.equal(state.guesses[0]!.status, 'wrong');
        assert.ok(logs.every(line => !line.includes('要挂') && !line.includes('白担心')), `日志不记她的话：${logs.join(' | ')}`);
        assert.ok(logs.some(line => /对 0、错 1/.test(line)), logs.join(' | '));
        assert.ok(readFileSync(guessesPath(dataDir), 'utf8').includes('白担心一场'), '在她自己的本子里');
    });

    test('坏文件不崩：读成空的', () => {
        const dataDir = dirOf();
        saveGuessesState(dataDir, emptyGuessesState());
        assert.deepEqual(loadGuessesState(dataDir).guesses, []);
    });
});

describe('她猜的事：计划器（想事情时想这一件）', () => {
    const boyfriend = loadCharacterCard(syntheticCardPath('boyfriend'));
    const planners: Planner[] = [];
    const dirs: string[] = [];
    afterEach(() => { for (const p of planners.splice(0)) p.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

    test('刚对上结果的那件：第一次想事情就想它，想过了就不再强制', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'qqbot-guess-planner-'));
        dirs.push(dir);
        const clock = new VirtualClock(new Date(t(10, 5, 9, 0)));
        const thinks: InitiateRequest[] = [];
        const logs: string[] = [];
        const planner = createProactivePlanner({
            contact: { qq: 10001, name: '阿明', tier: 'boyfriend' },
            schedule: boyfriend.schedule!, settings: withInner({ ...boyfriend.proactive!, occasions: ['inner'], dailyMax: 4, unansweredMax: 2 }), dates: [], mode: 'on',
            history: { load: () => [] },
            responder: {
                initiate: async (request: InitiateRequest) => {
                    if (request.think) { thinks.push(request); return { result: 'thought', text: thinks.length === 1 ? '原来没我想的那么差\n告诉他' : '有点困\n自己想想' }; }
                    request.commit(['嗯']);
                    return { result: 'sent', parts: ['嗯'], messageIds: [1] };
                },
            },
            dir, log: m => logs.push(m), now: clock.now, waitUntil: clock.waitUntil,
            names: { user: '阿明', char: '林梦瑶' }, inner: true,
            guessFacts: () => ({ id: 'guess:g1', text: '你 11-2 猜过「我猜高数小测要挂」，后来：78 分——你猜错了。' }),
        });
        planners.push(planner);
        for (let i = 0; i < 80 && clock.now() < t(10, 5, 16); i++) {
            await new Promise(r => setTimeout(r, 30));
            const next = clock.nextTimer();
            if (next === undefined || next > t(10, 5, 16)) break;
            clock.advanceTo(next);
        }
        await new Promise(r => setTimeout(r, 30));
        assert.ok(thinks.length >= 2, String(thinks.length));
        assert.ok(thinks[0]!.note.includes(GUESS_THEME), thinks[0]!.note);
        assert.ok(!thinks[1]!.note.includes(GUESS_THEME), '想过了就不再强制');
        assert.ok(logs.some(line => line.includes('之前猜的一件事有了结果')));
    });
});
