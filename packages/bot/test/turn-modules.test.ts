import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { Module } from '../src/interpreter/interpreter.ts';
import { buildTurnModules, type TurnModuleDeps } from '../src/platform/turn-modules.ts';

// 一份模块接线（ADR 0336 第 6 步）：App 和模拟器都从 buildTurnModules 取。这里核对三件事：
// 1. 先后：所有开关都开时的完整顺序（照合并前 App 的先后，模拟器独有的「做题式」排在「只想一想」之后）；
// 2. 只给必填的那些时只挂总是挂的模块；
// 3. 构造时不调用 deps 里的任何函数——App 里好些东西（设备服务、聊天记录、长期记忆、计划器）在建解释器之后才建，模拟器的计划器也是，构造时去取会撞上还没初始化的变量。
describe('模块接线（ADR 0336 第 6 步）', () => {
    const calls: string[] = [];
    const trap = (name: string) => (..._args: unknown[]): never => {
        calls.push(name);
        throw new Error(`构造时调用了 deps.${name}`);
    };
    const base = (): TurnModuleDeps => ({
        log: trap('log'), now: trap('now'), history: trap('history'), contacts: trap('contacts'),
        worldState: trap('worldState'), appointmentsAt: trap('appointmentsAt'), promises: trap('promises'),
        schedule: true, herDays: true, grievance: true, shortReplies: false, lagTail: true, lifeInPrompt: true,
        intent: { refuse: true }, shape: { shape: true, shapeAgenda: true },
    });
    const jokes: Module = { id: 'jokes', contribute: trap('jokes.contribute') };
    const idioms: Module = { id: 'idioms', contribute: trap('idioms.contribute') };
    const full = (): TurnModuleDeps => ({
        ...base(),
        herNow: { projectChoice: true, realNights: true, herPlan: trap('herPlan') },
        herNotes: { speechNotes: trap('speechNotes'), openQuestions: trap('openQuestions') },
        shell: { noteOf: trap('noteOf'), commands: { lookedRecently: trap('lookedRecently'), setNote: trap('setNote'), run: trap('run'), audit: trap('audit'), log: trap('shell.log') } },
        reviewPull: { recall: trap('recall'), finishReview: trap('finishReview') },
        deliberateNote: '先想清楚',
        selfMemory: { understanding: trap('understanding'), traces: trap('traces') },
        workMode: { modeOf: trap('modeOf'), markers: { setMode: trap('setMode'), refused: trap('refused'), taskOf: trap('taskOf'), start: trap('start'), notTyped: trap('notTyped'), log: trap('work.log') } },
        selfNotes: { keepPrivate: trap('keepPrivate'), remember: trap('remember'), log: trap('notes.log') },
        soul: { selfThread: trap('selfThread'), refusals: trap('refusals'), rating: trap('rating'), life: trap('life') },
        learningQuestion: trap('learningQuestion'),
        exemplars: [{ his: '在吗', her: '在' }] as never,
        innerLine: trap('innerLine'),
        devices: { menu: trap('menu'), allowed: trap('allowed') },
        consent: { ask: trap('ask') },
        quote: { share: 1 },
        factCheck: { mode: 'fix', audit: trap('audit'), onRecord: trap('onRecord') },
        speechCheck: true,
        candidates: { count: 3, speechCheck: true, tailCap: true },
        continuity: true, group: true, texture: true, humanState: true, solveFrame: true, relationship: true,
        jokes, idioms, together: true, interruptions: true,
        memes: trap('memes'), watched: trap('watched'), memeDict: { mention: trap('mention') },
    });
    const ids = (modules: readonly Module[]) => modules.map(module => module.id);

    test('都开着时的完整先后（同合并前 App 的先后）', () => {
        calls.length = 0;
        const modules = buildTurnModules(full());
        assert.deepEqual(ids(modules), [
            'her-now', 'crisis', 'intent', 'reply-basics', 'asks', 'reading', 'register', 'scenes', 'voice',
            'self-memory', 'work-mode', 'self-notes', 'her-notes', 'soul', 'learning-question', 'shell',
            'repetition', 'books', 'past', 'people-around', 'meetup', 'exemplars', 'practice', 'inner', 'devices', 'consent',
            'shape', 'length', 'quote', 'initiate-note', 'review-finalize', 'review-exit', 'review-facts', 'review-unfinished', 'review-pull',
            'time-block', 'continuity', 'group', 'memory', 'warm', 'feelings', 'time-notes', 'media-offers', 'candidates',
            'texture', 'typo', 'intent-line', 'human-state', 'deliberate', 'transcript', 'solve-frame',
            'closeness', 'jokes', 'idioms', 'together', 'interruptions', 'memes', 'watched', 'meme-dict',
        ]);
        assert.equal(new Set(ids(modules)).size, modules.length, 'id 不重复（App 的解释器会查）');
        // 小梗、口头习惯是外面建好的那一个（App 的带定时抽取和收尾），原样放进来
        assert.equal(modules.find(module => module.id === 'jokes'), jokes);
        assert.equal(modules.find(module => module.id === 'idioms'), idioms);
        assert.deepEqual(calls, []);
    });

    test('货架发现不改变回复模块先后，定时任务排在已有模块之后', () => {
        const withoutDiscovery = buildTurnModules(full());
        let lookups = 0;
        const photos = () => {};
        const modules = buildTurnModules({ ...full(), mediaDiscovery: () => { lookups++; return { photos }; } });
        assert.deepEqual(ids(modules), [...ids(withoutDiscovery), 'media-discovery']);
        assert.equal(lookups, 0);
        const discovery = modules.at(-1)!;
        assert.equal(discovery.schedules?.length, 1);
        assert.equal(lookups, 1);
    });

    test('补回后的周期任务先于已有模块注册，构造时不执行', () => {
        calls.length = 0;
        const withoutJobs = buildTurnModules(full());
        const modules = buildTurnModules({ ...full(), syncedJobs: {
            weeklyReport: trap('weekly'), watching: trap('watching'), feed: trap('feed'), memes: trap('memes'),
        } });
        assert.deepEqual(ids(modules), ['synced-jobs', ...ids(withoutJobs)]);
        assert.deepEqual(modules[0]?.schedules?.map(({ every, runOnStart }) => [every, Boolean(runOnStart)]),
            [[60 * 60_000, false], [30 * 60_000, false], [30 * 60_000, true], [30 * 60_000, false]]);
        assert.deepEqual(calls, []);
    });

    test('只给必填的：只挂总是挂的那些，先后不变', () => {
        calls.length = 0;
        assert.deepEqual(ids(buildTurnModules(base())), [
            'her-now', 'crisis', 'intent', 'reply-basics', 'asks', 'reading', 'register', 'scenes', 'voice',
            'her-notes', 'shell', 'repetition', 'books', 'past', 'people-around', 'meetup', 'practice',
            'shape', 'length', 'initiate-note', 'review-finalize', 'review-exit', 'review-pull',
            'time-block', 'memory', 'warm', 'feelings', 'time-notes', 'media-offers', 'typo', 'intent-line', 'deliberate', 'transcript',
        ]);
        assert.deepEqual(calls, []);
    });

    test('开关是假的、真人例子是空的：不挂', () => {
        const off = buildTurnModules({
            ...base(), exemplars: [], speechCheck: false, continuity: false, group: false, texture: false, humanState: false,
            solveFrame: false, relationship: false, together: false, interruptions: false,
        });
        assert.deepEqual(ids(off), ids(buildTurnModules(base())));
    });

    test('有先后要求的几对（模块之间靠 turn.facts 交接）', () => {
        const list = ids(buildTurnModules(full()));
        const before = (first: string, second: string) => assert.ok(list.indexOf(first) < list.indexOf(second), `${first} 要排在 ${second} 前面`);
        before('her-now', 'crisis');
        before('crisis', 'intent');
        before('intent', 'interruptions');
        before('intent', 'repetition');
        before('shape', 'length');
        before('memes', 'watched');
        before('memes', 'meme-dict');
        before('closeness', 'jokes');
        before('jokes', 'idioms');
        before('idioms', 'together');
    });
});
