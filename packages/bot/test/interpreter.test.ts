import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { assessTurn, contributeTurn, createInterpreter, perceiveTurn, reviewTurn, runTurn, type Module, type Turn } from '../src/interpreter/interpreter.ts';
import { AFTER_HISTORY_SLOTS, AFTER_MAIN_SLOTS, ALL_SLOTS, assemblePrompt, NOW_SLOTS, type Piece } from '../src/interpreter/slots.ts';
import type { MessageEvent } from '../src/platform/onebot.ts';
import { createExecutor } from '../src/executor/executor.ts';
import { jokesTurnModule } from '../src/modules/jokes.ts';
import { idiomsTurnModule } from '../src/modules/idioms.ts';
import { interruptionsModule } from '../src/modules/interruptions.ts';
import { closenessAllowed, closenessModule } from '../src/modules/closeness.ts';
import { playfulAllowed } from '../src/modules/playful.ts';
import { togetherAllowed, togetherModule } from '../src/modules/together.ts';
import { memesModule } from '../src/modules/memes.ts';
import { watchedAllowed, watchedModule } from '../src/modules/watched.ts';
import { intentModule, intentOf } from '../src/modules/intent.ts';
import { DIRECT_ANSWER_NOTE, lastUserLine, NO_OVERTHINK_NOTE, PERSON_NOTE, replyBasicsModule } from '../src/modules/reply-basics.ts';
import { asksAllowed, asksModule } from '../src/modules/asks.ts';
import { readingAllowed, readingModule } from '../src/modules/reading.ts';
import { registerAllowed, registerModule } from '../src/modules/register.ts';
import { scenesAllowed, scenesModule } from '../src/modules/scenes.ts';
import { voiceAllowed, voiceModule } from '../src/modules/voice.ts';
import { shellModule } from '../src/modules/shell.ts';
import { learningQuestionModule } from '../src/modules/learning-question.ts';
import { WORK_JUDGE_NOTE, WORK_MODE_NOTE, WORK_REQUEST_NOTE, workModeModule } from '../src/modules/work-mode.ts';
import { SELF_MEMORY_NOTE, selfMemoryModule } from '../src/modules/self-memory.ts';
import { soulModule } from '../src/modules/soul.ts';
import { herNotesModule } from '../src/modules/her-notes.ts';
import { SHELL_INTENT } from '../src/language/intent.ts';
import { VOICE_HINT, voiceRoll, VOICE_HINT_RATE } from '../src/language/speaking.ts';
import { UNSURE_LINE } from '../src/language/asks.ts';
import { repetitionModule, repetitionPieces } from '../src/modules/repetition.ts';
import { herNowModule } from '../src/modules/her-now.ts';
import { booksModule } from '../src/modules/books.ts';
import { pastModule } from '../src/modules/past.ts';
import { peopleAroundModule } from '../src/modules/people-around.ts';
import { loadTierCard } from '../src/platform/contact.ts';
import type { Contact } from '../src/platform/config.ts';
import type { StoredMessage } from '../src/memory/history.ts';
import type { Schedule } from '../src/life/schedule.ts';
import { worldAt, type WorldAction } from '../src/world/world.ts';
import { syntheticCardPattern } from './fixtures/card.ts';

const exec = createExecutor({ transport: { sendPrivateText: async () => 1, friendHistory: async () => [] } });

const turn: Turn = { contact: { qq: 1, name: '阿明', tier: 'classmate' }, at: new Date(0), history: [], thinking: false, facts: {} };
const message = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 2, user_id: 1, message_id: 3, time: 0, message: '在吗', raw_message: '在吗', sender: { user_id: 1 } } as MessageEvent;

describe('提示词槽位表（ADR 0336）', () => {
    test('每个槽名只出现一次', () => {
        assert.equal(new Set(ALL_SLOTS).size, ALL_SLOTS.length);
        assert.equal(ALL_SLOTS.length, AFTER_MAIN_SLOTS.length + AFTER_HISTORY_SLOTS.length + NOW_SLOTS.length);
    });

    test('按表排序：消息槽各一条，「此刻」行拼成最后一条；同槽按给出的顺序', () => {
        const pieces: Piece[] = [
            { slot: 'intent', text: '[意图]' }, { slot: 'time', text: '[时间]' }, { slot: 'people', text: '人1' }, { slot: 'relationship', text: '关系' },
            { slot: 'summary', text: '要点' }, { slot: 'people', text: '人2' }, { slot: 'feeling', text: '[心境]' },
        ];
        assert.deepEqual(assemblePrompt(pieces), { afterMain: ['关系'], afterHistory: ['要点', '人1', '人2', '[时间]\n[心境]\n[意图]'] });
        assert.deepEqual(assemblePrompt([]), { afterMain: [], afterHistory: [] });
        assert.throws(() => assemblePrompt([{ slot: 'nope' as never, text: 'x' }]), /没有这个提示词槽/);
    });
});

describe('解释器骨架（ADR 0336）', () => {
    test('一轮回复：先全部 assess 再全部 contribute；都同步时同步返回', () => {
        const order: string[] = [];
        const a: Module = { id: 'a', assess: () => { order.push('a.assess'); }, contribute: () => { order.push('a.contribute'); return [{ slot: 'intent', text: 'A' }]; } };
        const b: Module = { id: 'b', assess: () => { order.push('b.assess'); }, contribute: () => { order.push('b.contribute'); return [{ slot: 'time', text: 'B' }]; } };
        const result = runTurn([a, b], turn);
        assert.ok(!(result instanceof Promise));
        assert.deepEqual(result, { afterMain: [], afterHistory: ['B\nA'] });
        assert.deepEqual(order, ['a.assess', 'b.assess', 'a.contribute', 'b.contribute']);
    });

    test('有异步钩子时整轮变成 promise，顺序不变', async () => {
        const order: string[] = [];
        const a: Module = { id: 'a', assess: async () => { await null; order.push('a'); } };
        const b: Module = { id: 'b', assess: () => { order.push('b'); }, contribute: async () => [{ slot: 'time', text: 'T' }] };
        const result = runTurn([a, b], turn);
        assert.ok(result instanceof Promise);
        assert.deepEqual(await result, { afterMain: [], afterHistory: ['T'] });
        assert.deepEqual(order, ['a', 'b']);
    });

    test('review 按模块顺序逐个改草稿', async () => {
        const modules: Module[] = [{ id: 'x', review: draft => `${draft}1` }, { id: 'y' }, { id: 'z', review: async draft => `${draft}2` }];
        assert.equal(reviewTurn([modules[0]!, modules[1]!], '稿', turn), '稿1');
        assert.equal(await reviewTurn(modules, '稿', turn), '稿12');
    });

    test('分发：按注册顺序；只有一个返回 promise 时原样返回它；没有处理的事件返回 undefined', async () => {
        const seen: string[] = [];
        const pending = Promise.resolve();
        const interpreter = createInterpreter({ exec, modules: [
            { id: 'one', on: { message: () => { seen.push('one'); } } },
            { id: 'two', on: { message: () => { seen.push('two'); }, connected: () => pending } },
            { id: 'turn', contribute: () => [] },
        ] });
        assert.equal(interpreter.dispatch({ kind: 'message', event: message }), undefined);
        assert.deepEqual(seen, ['one', 'two']);
        assert.equal(interpreter.dispatch({ kind: 'connected', selfId: 2 }), pending);
        assert.equal(interpreter.dispatch({ kind: 'recall', event: { post_type: 'notice', notice_type: 'friend_recall', self_id: 2, user_id: 1, message_id: 3 } }), undefined);
        assert.deepEqual(interpreter.turnModules.map(m => m.id), ['turn']);
    });

    test('处理函数同步抛错照样抛；模块 id 不能重复', () => {
        const interpreter = createInterpreter({ exec, modules: [{ id: 'bad', on: { message: () => { throw new Error('坏了'); } } }] });
        assert.throws(() => interpreter.dispatch({ kind: 'message', event: message }), /坏了/);
        assert.throws(() => createInterpreter({ exec, modules: [{ id: 'a' }, { id: 'a' }] }), /重复/);
    });

    test('定时任务经执行器开、只开一次，stop 时关；stop 按注册顺序收各模块的收尾；状态按顺序合并', () => {
        const opened: number[] = [];
        let cancelled = 0;
        const fake = { every: (_fn: () => void, ms?: number) => { opened.push(ms!); return { unref() { return this; } } as unknown as ReturnType<typeof setInterval>; }, cancel: () => { cancelled++; } };
        const drain = Promise.resolve();
        const stopped: string[] = [];
        const interpreter = createInterpreter({ exec: fake, modules: [
            { id: 'a', schedules: [{ every: 60_000, run: () => {} }], stop: () => { stopped.push('a'); return drain; }, status: () => ({ a: 1 }) },
            { id: 'b', stop: () => { stopped.push('b'); return undefined; }, status: () => ({ b: 2 }) },
            { id: 'c' },
        ] });
        interpreter.startSchedules();
        interpreter.startSchedules();
        assert.deepEqual(opened, [60_000]);
        assert.equal(interpreter.hasStatus, true);
        assert.deepEqual(interpreter.status(), { a: 1, b: 2 });
        assert.deepEqual(interpreter.stop(), [drain]);
        assert.deepEqual(stopped, ['a', 'b']);
        assert.equal(cancelled, 1);
        interpreter.startSchedules();
        assert.deepEqual(opened, [60_000], '停下之后不再开');
    });
});

describe('小梗模块（ADR 0114 / 0336）', () => {
    const boyfriend = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' as const }, history: [{ role: 'user' as const, content: '小土豆在干嘛', time: '2026-11-20T11:00:00.000Z' }], at: new Date('2026-11-20T11:00:00.000Z') };
    test('只有男朋友档；主动找他、只想一想、危机、小别扭、他难过的轮次让路', () => {
        assert.equal(playfulAllowed(boyfriend), true);
        assert.equal(playfulAllowed({ ...boyfriend, contact: { ...boyfriend.contact, tier: 'classmate' } }), false);
        assert.equal(playfulAllowed({ ...boyfriend, thinking: true }), false);
        assert.equal(playfulAllowed({ ...boyfriend, initiate: { note: '', topic: '' } }), false);
        assert.equal(playfulAllowed({ ...boyfriend, facts: { crisis: { level: 'high' } as never } }), false);
        assert.equal(playfulAllowed({ ...boyfriend, facts: { grievance: {} as never } }), false);
        assert.equal(playfulAllowed({ ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } }), false);
        assert.equal(playfulAllowed({ ...boyfriend, facts: { baseIntent: '[这一轮你想：回两句]' } }), true);
    });
    test('放进 joke 槽；让路的轮次不看梗', () => {
        const logs: string[] = [];
        let asked = 0;
        const module = jokesTurnModule(() => { asked++; return [{ phrase: '小土豆', origin: '他老这么叫她' }]; }, line => logs.push(line));
        const pieces = [0, 1, 2, 3, 4, 5, 6, 7].flatMap(i => module.contribute!({ ...boyfriend, history: [{ ...boyfriend.history[0]!, content: `小土豆在干嘛${i}` }] }) as never[]);
        assert.ok(pieces.length > 0 && pieces.every((piece: { slot: string; text: string }) => piece.slot === 'joke' && piece.text.includes('小土豆')));
        assert.ok(logs.every(line => line.startsWith('[1] 小梗：')) && logs.length === pieces.length);
        asked = 0;
        assert.deepEqual(module.contribute!({ ...boyfriend, thinking: true }), []);
        assert.equal(asked, 0);
    });
});

describe('口头习惯模块（ADR 0138 / 0336）', () => {
    const boyfriend = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' as const }, history: [{ role: 'user' as const, content: '笑死 又迟到了', time: '2026-11-20T11:00:00.000Z' }], at: new Date('2026-11-20T11:00:00.000Z') };
    test('放进 idiom 槽；share 为 0 时不放，让路的轮次不看词', () => {
        const logs: string[] = [];
        let asked = 0;
        const idioms = () => { asked++; return [{ phrase: '笑死', kind: '口头禅', count: 9, days: 5 }]; };
        const always = idiomsTurnModule(idioms, line => logs.push(line), 1);
        const pieces = always.contribute!(boyfriend) as { slot: string; text: string }[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'idiom');
        assert.ok(pieces[0]!.text.includes('「笑死」'));
        assert.deepEqual(logs, ['[1] 口头习惯：这一轮提示词里放了他爱说的词（日志不记内容）']);
        assert.deepEqual(idiomsTurnModule(idioms, () => {}, 0).contribute!(boyfriend), []);
        asked = 0;
        assert.deepEqual(always.contribute!({ ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } }), []);
        assert.equal(asked, 0);
    });
});

describe('分开的两个阶段（ADR 0336）', () => {
    test('assessTurn 只写判断、不收段落；contributeTurn 只收段落、不再 assess；都同步时同步返回', () => {
        const calls: string[] = [];
        const module: Module = {
            id: 'a',
            assess: t => { calls.push('assess'); t.facts.baseIntent = '写下的'; },
            contribute: t => { calls.push('contribute'); return [{ slot: 'intent', text: t.facts.baseIntent ?? '' }]; },
        };
        const t: Turn = { ...turn, facts: {} };
        assert.equal(assessTurn([module], t), undefined);
        assert.deepEqual(calls, ['assess']);
        assert.deepEqual(contributeTurn([module], t), { afterMain: [], afterHistory: ['写下的'] });
        assert.deepEqual(calls, ['assess', 'contribute']);
    });
    test('perceiveTurn 只看清她此刻：全部 perceive 在任何 assess 之前，后面的 assess 读得到', () => {
        const calls: string[] = [];
        const sees: Module = { id: 'sees', perceive: t => { calls.push('sees.perceive'); t.facts.schedule = { sleep: '02:00' } as never; } };
        const judges: Module = { id: 'judges', assess: t => { calls.push(`judges.assess:${t.facts.schedule ? '有作息' : '没有'}`); } };
        const t: Turn = { ...turn, facts: {} };
        assert.equal(perceiveTurn([judges, sees], t), undefined);
        assert.deepEqual(calls, ['sees.perceive']);
        // runTurn 也是：注册在后面的模块的 perceive 照样排在前面的 assess 之前
        const u: Turn = { ...turn, facts: {} };
        calls.length = 0;
        assert.deepEqual(runTurn([judges, sees], u), { afterMain: [], afterHistory: [] });
        assert.deepEqual(calls, ['sees.perceive', 'judges.assess:有作息']);
    });
    test('有异步的 perceive 时返回 promise；runTurn 等它之后才 assess', async () => {
        const calls: string[] = [];
        const t: Turn = { ...turn, facts: {} };
        const result = runTurn([
            { id: 'a', perceive: async () => { await null; calls.push('a.perceive'); } },
            { id: 'b', assess: () => { calls.push('b.assess'); }, contribute: () => [{ slot: 'time', text: 'T' }] },
        ], t);
        assert.ok(result instanceof Promise);
        assert.deepEqual(await result, { afterMain: [], afterHistory: ['T'] });
        assert.deepEqual(calls, ['a.perceive', 'b.assess']);
    });
    test('只实现 perceive 的模块也算一轮回复的模块', () => {
        const interpreter = createInterpreter({ exec, modules: [{ id: 'p', perceive: () => {} }, { id: 'events', on: { connected: () => {} } }] });
        assert.deepEqual(interpreter.turnModules.map(m => m.id), ['p']);
    });
    test('有异步的 assess 时返回 promise', async () => {
        const t: Turn = { ...turn, facts: {} };
        const result = assessTurn([{ id: 'a', assess: async x => { x.facts.baseIntent = '晚到'; } }], t);
        assert.ok(result instanceof Promise);
        await result;
        assert.equal(t.facts.baseIntent, '晚到');
    });
});

describe('被打断模块（ADR 0115 / 0336）', () => {
    const at = new Date('2026-11-22T13:00:00.000Z');
    const world = { events: [{ id: 'e1', text: '室友喊她去拿外卖', at: new Date('2026-11-22T12:58:00.000Z') }] } as never;
    const history = [
        { role: 'user' as const, content: '在干嘛', time: '2026-11-22T12:56:00.000Z' },
        { role: 'assistant' as const, content: '刚吃完', time: '2026-11-22T12:56:30.000Z' },
    ];
    const live = (content: string): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [...history, { role: 'user', content, time: '2026-11-22T12:59:50.000Z' }], facts: { world } });
    test('assess 写进 facts.interruption 并记日志，contribute 放进 interrupt 槽；让路的轮次不写', () => {
        const logs: string[] = [];
        const module = interruptionsModule(line => logs.push(line));
        // 按他最后一句取哈希，约六成的轮次才打断：挑几句里第一句会打断的
        const hit = ['你呢', '然后呢', '好吧', '哈哈', '在吗', '嗯嗯', '真的吗', '我也是'].map(live).find(t => { module.assess!(t); return t.facts.interruption; });
        assert.ok(hit, '几句里至少有一句会被打断');
        assert.equal(hit.facts.interruption!.text, '室友喊她去拿外卖');
        assert.equal(hit.facts.interruption!.minutesAgo, 2);
        const pieces = module.contribute!(hit) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'interrupt');
        assert.ok(pieces[0]!.text.includes('室友喊她去拿外卖'));
        assert.deepEqual(logs, ['[1] 被打断：聊着的时候她那边发生了一件小事（提示词里多一行；日志不记内容）']);
        const sad: Turn = { ...hit, facts: { world, baseIntent: '[这一轮你想：先接住他此刻的情绪]' } };
        module.assess!(sad);
        assert.equal(sad.facts.interruption, undefined);
        assert.deepEqual(module.contribute!(sad), []);
        const noWorld: Turn = { ...hit, facts: {} };
        module.assess!(noWorld);
        assert.equal(noWorld.facts.interruption, undefined);
    });
});

describe('关系阶段模块（ADR 0113 / 0336）', () => {
    const at = new Date('2026-11-25T12:00:00+08:00');
    // 最近 20 天每天他说 3 条
    const history = Array.from({ length: 20 }, (_, day) => [0, 1, 2].map(i => ({ role: 'user' as const, content: '在吗', time: new Date(at.getTime() - (day + 1) * 86_400_000 + i * 3600_000).toISOString() }))).flat();
    const boyfriend: Turn = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history };
    test('只有男朋友档；只想一想、危机、小别扭时不放；主动找他、他难过时照样放', () => {
        assert.equal(closenessAllowed(boyfriend), true);
        assert.equal(closenessAllowed({ ...boyfriend, initiate: { note: '', topic: '' } }), true);
        assert.equal(closenessAllowed({ ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } }), true);
        assert.equal(closenessAllowed({ ...boyfriend, contact: { ...boyfriend.contact, tier: 'classmate' } }), false);
        assert.equal(closenessAllowed({ ...boyfriend, thinking: true }), false);
        assert.equal(closenessAllowed({ ...boyfriend, facts: { crisis: { level: 'high' } as never } }), false);
        assert.equal(closenessAllowed({ ...boyfriend, facts: { grievance: {} as never } }), false);
    });
    test('放进 closeness 槽并记日志；聊得少时不放', () => {
        const logs: string[] = [];
        const module = closenessModule(line => logs.push(line));
        const pieces = module.contribute!(boyfriend) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'closeness');
        assert.ok(pieces[0]!.text.includes('这个月已经聊了 20 天'));
        assert.deepEqual(logs, ['[1] 关系：最近几乎天天在聊，她更放得开一点（提示词里多一行）']);
        assert.deepEqual(module.contribute!({ ...boyfriend, history: history.slice(0, 30) }), []);
    });
});

describe('陪玩模块（ADR 0111 / 0336）', () => {
    const at = new Date('2026-11-27T20:30:00+08:00');
    const history = [
        { role: 'user' as const, content: '今晚王者双排吗', time: new Date('2026-11-27T20:00:00+08:00').toISOString() },
        { role: 'assistant' as const, content: '来呀', time: new Date('2026-11-27T20:01:00+08:00').toISOString() },
        { role: 'user' as const, content: '这把输了', time: new Date('2026-11-27T20:29:50+08:00').toISOString() },
    ];
    const boyfriend: Turn = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history };
    test('只有男朋友档；主动找他（含只想一想）、危机时不算；小别扭、他难过时照样算', () => {
        assert.equal(togetherAllowed(boyfriend), true);
        assert.equal(togetherAllowed({ ...boyfriend, facts: { grievance: {} as never } }), true);
        assert.equal(togetherAllowed({ ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } }), true);
        assert.equal(togetherAllowed({ ...boyfriend, contact: { ...boyfriend.contact, tier: 'classmate' } }), false);
        assert.equal(togetherAllowed({ ...boyfriend, initiate: { note: '', topic: '' } }), false);
        assert.equal(togetherAllowed({ ...boyfriend, initiate: { note: '', topic: '', think: true } as never, thinking: true }), false);
        assert.equal(togetherAllowed({ ...boyfriend, facts: { crisis: { level: 'high' } as never } }), false);
    });
    test('assess 写进 facts.together 并记日志，contribute 放进 together 槽；说了下了就不算', () => {
        const logs: string[] = [];
        const module = togetherModule(line => logs.push(line));
        const live: Turn = { ...boyfriend, facts: {} };
        module.assess!(live);
        assert.deepEqual(live.facts.together, { activity: 'wzry', since: Date.parse('2026-11-27T20:01:00+08:00') });
        assert.deepEqual(logs, ['[1] 陪玩：他们正一起打王者（从答应起 29 分钟）']);
        const pieces = module.contribute!(live) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'together');
        assert.ok(pieces[0]!.text.includes('打王者（双排）（已经玩了约 29 分钟）'));
        const ended: Turn = { ...boyfriend, history: [...history, { role: 'user', content: '我先下了', time: history[2]!.time }], facts: {} };
        module.assess!(ended);
        assert.equal(ended.facts.together, undefined);
        assert.deepEqual(module.contribute!(ended), []);
        const crisis: Turn = { ...boyfriend, facts: { crisis: { level: 'high' } as never } };
        module.assess!(crisis);
        assert.equal(crisis.facts.together, undefined);
        assert.equal(logs.length, 1);
    });
});

describe('网络热梗模块（ADR 0129 / 0336）', () => {
    const at = new Date('2026-11-29T13:00:00+08:00');
    const entry = { term: '尊嘟假嘟', meaning: '“真的假的”的卖萌说法', example: '', confidence: 'high' as const, firstSeen: '2026-11-20', lastSeen: '2026-11-28', seen: 3 };
    const boyfriend: Turn = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: '尊嘟假嘟', time: at.toISOString() }] };
    test('他用了库里的梗就放进 meme 槽并记日志；让路的轮次不看库', () => {
        const logs: string[] = [];
        let reads = 0;
        const module = memesModule(() => { reads++; return [entry]; }, line => logs.push(line));
        const pieces = module.contribute!(boyfriend) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'meme');
        assert.ok(pieces[0]!.text.includes('「尊嘟假嘟」：“真的假的”的卖萌说法'));
        assert.deepEqual(logs, ['[1] 网络热梗：这一轮提示词里放了梗的意思（日志不记内容）']);
        assert.equal(reads, 1);
        for (const yielding of [
            { ...boyfriend, contact: { ...boyfriend.contact, tier: 'classmate' as const } },
            { ...boyfriend, initiate: { note: '', topic: '' } },
            { ...boyfriend, facts: { grievance: {} as never } },
            { ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } },
        ]) assert.deepEqual(module.contribute!(yielding), []);
        assert.equal(reads, 1);
        assert.deepEqual(memesModule(() => [], () => {}).contribute!(boyfriend), []);
    });
});

describe('她看视频模块（ADR 0130 / 0336）', () => {
    const at = new Date('2026-12-01T12:20:00+08:00');
    const seen = { bvid: 'BV1test', title: '手机拍夜景的三个小技巧', owner: '某个 UP 主', tname: '摄影', excerpt: '夜景别开闪光灯', hot: ['笑死我了'], day: '2026-11-30' };
    const boyfriend: Turn = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: '你最近在看什么', time: at.toISOString() }] };
    test('只有男朋友档；主动找他、只想一想、危机时不放；小别扭、他难过时照样放', () => {
        assert.equal(watchedAllowed(boyfriend), true);
        assert.equal(watchedAllowed({ ...boyfriend, facts: { grievance: {} as never } }), true);
        assert.equal(watchedAllowed({ ...boyfriend, facts: { baseIntent: '[这一轮你想：先接住他此刻的情绪]' } }), true);
        assert.equal(watchedAllowed({ ...boyfriend, contact: { ...boyfriend.contact, tier: 'classmate' } }), false);
        assert.equal(watchedAllowed({ ...boyfriend, initiate: { note: '', topic: '' } }), false);
        assert.equal(watchedAllowed({ ...boyfriend, thinking: true }), false);
        assert.equal(watchedAllowed({ ...boyfriend, facts: { crisis: { level: 'high' } as never } }), false);
    });
    test('他问起时放进 watched 槽并记日志；没问、让路的轮次不放', () => {
        const logs: string[] = [];
        let reads = 0;
        const module = watchedModule(() => { reads++; return [seen]; }, line => logs.push(line));
        const pieces = module.contribute!(boyfriend) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'watched');
        assert.ok(pieces[0]!.text.includes('手机拍夜景的三个小技巧'));
        assert.deepEqual(logs, ['[1] 她看视频：这一轮提示词里放了她最近看过的（日志不记内容）']);
        assert.deepEqual(module.contribute!({ ...boyfriend, history: [{ role: 'user', content: '吃饭了吗', time: at.toISOString() }] }), []);
        assert.equal(reads, 2);
        assert.deepEqual(module.contribute!({ ...boyfriend, initiate: { note: '', topic: '' } }), []);
        assert.equal(reads, 2);
        assert.equal(logs.length, 1);
    });
});

describe('意图模块（意图阶梯，ADR 0336）', () => {
    const at = new Date('2026-12-03T12:00:00+08:00');
    const said = (content: string): Turn['history'] => [
        { role: 'assistant', content: '嗯嗯', time: new Date(at.getTime() - 3_600_000).toISOString() },
        { role: 'user', content, time: at.toISOString() },
    ];
    const boyfriend = (content: string, facts: Turn['facts'] = {}): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: said(content), facts });
    const free = (text: string) => ({ activity: { kind: 'free', text }, where: '宿舍' }) as never;
    test('assess 把意图写进 facts.baseIntent；只想一想、主动找他时没有；不放段落', () => {
        const module = intentModule();
        const live = boyfriend('你吃饭了吗');
        module.assess!(live);
        assert.match(live.facts.baseIntent!, /先直接回答他刚问的/);
        assert.equal(module.contribute, undefined);
        const thinking: Turn = { ...boyfriend('你吃饭了吗'), thinking: true };
        module.assess!(thinking);
        assert.equal(thinking.facts.baseIntent, undefined);
        assert.equal(intentOf({ ...boyfriend('你吃饭了吗'), initiate: { note: '', topic: '' } }, {}), undefined);
    });
    test('开关是模块的选项：会拒绝、吃醋只在开了时有；亲密、玩梗只给男朋友档', () => {
        const control = '不许你跟别的男生说话，听到没';
        assert.match(intentOf(boyfriend(control), { refuse: true })!, /他在管着你/);
        assert.doesNotMatch(intentOf(boyfriend(control), {}) ?? '', /他在管着你/);
        assert.doesNotMatch(intentOf({ ...boyfriend(control), contact: { qq: 2, name: '小周', tier: 'classmate' } }, { refuse: true }) ?? '', /他在管着你/);
        const hug = '抱抱我';
        assert.match(intentOf(boyfriend(hug), {})!, /他在向你要亲近/);
        assert.doesNotMatch(intentOf({ ...boyfriend(hug), contact: { qq: 2, name: '小周', tier: 'classmate' } }, {}) ?? '', /他在向你要亲近/);
        const meme = 'xswl 你这也太离谱了';
        assert.match(intentOf(boyfriend(meme), {})!, /他在玩网络梗/);
        assert.doesNotMatch(intentOf({ ...boyfriend(meme), contact: { qq: 2, name: '小周', tier: 'classmate' } }, {}) ?? '', /他在玩网络梗/);
    });
    test('旧逻辑写进 facts 的输入：挂着的事、她答应的事、没说过的事、她此刻在干嘛、她的追求', () => {
        assert.match(intentOf(boyfriend('在吗', { waiting: ['他去面试'] }), {})!, /知道「他去面试」后来怎么样了/);
        assert.match(intentOf(boyfriend('在吗', { promised: true }), {})!, /先把上面你答应的那件事说了/);
        assert.match(intentOf(boyfriend('在吗', { unanswered: ['他周末回不回家'] }), {})!, /上次问他「他周末回不回家」/);
        assert.match(intentOf(boyfriend('我到宿舍了', { news: ['新相机到了'] }), {})!, /你今天新相机到了，还没跟他说过/);
        assert.match(intentOf(boyfriend('在吗', { state: free('赶作业') }), {})!, /回两句就去忙/);
        assert.equal(intentOf(boyfriend('在吗', { state: free('看剧') }), {}), undefined);
        const drop = '先别修了，陪我聊会';
        assert.match(intentOf(boyfriend(drop, { state: free('修片') }), { refuse: true, pursuits: true })!, /你正在修片/);
        assert.doesNotMatch(intentOf(boyfriend(drop, { state: free('修片') }), { refuse: true }) ?? '', /你正在修片/);
    });
    test('这一轮已有的判断：危机（含身边有人还没说安全）、小别扭、今天的小事', () => {
        assert.match(intentOf(boyfriend('嗯', { crisis: { level: 'high' } as never }), {})!, /这不是玩笑/);
        assert.match(intentOf(boyfriend('嗯', { crisis: { level: 'high', awaitingSafe: true } as never }), {})!, /他提到身边有人了/);
        assert.match(intentOf(boyfriend('我回来啦', { grievance: { stage: 'sulk', days: 5, round: 0 } }), {})!, /5 天没来找你/);
        const day = '你今天干嘛了';
        const world = { events: [{ id: 'e', text: '下楼喂了猫', at }] } as never;
        assert.match(intentOf(boyfriend(day, { world }), { everydayLife: true })!, /他在问你今天过得怎么样/);
        assert.doesNotMatch(intentOf(boyfriend(day, { world }), {}) ?? '', /他在问你今天过得怎么样/);
    });
});

describe('接话的基本规矩模块（DSH 10-30 / 10-31，ADR 0336）', () => {
    const at = new Date('2026-11-29T13:00:00+08:00');
    const said = (minutesAgo: number, content = '你在干嘛') => ({ role: 'user' as const, content, time: new Date(at.getTime() - minutesAgo * 60_000).toISOString() });
    const chatTurn = (history: Turn['history'], extra: Partial<Turn> = {}): Turn => ({ ...turn, at, history, ...extra });
    const initiating = { initiate: { note: '[主动]', topic: '' } };

    test('30 分钟内他说的那句原样给（最多 120 字）；他没说过话时没有', () => {
        assert.equal(lastUserLine(chatTurn([said(5, '  你在干嘛  ')])), '他最后说的是：「你在干嘛」。先接这一句，别接更早的话。');
        assert.equal(lastUserLine(chatTurn([said(30)])), '他最后说的是：「你在干嘛」。先接这一句，别接更早的话。');
        assert.ok(lastUserLine(chatTurn([said(1, '长'.repeat(200))]))!.includes(`「${'长'.repeat(120)}」`));
        assert.equal(lastUserLine(chatTurn([])), undefined);
        assert.equal(lastUserLine(chatTurn([{ role: 'assistant', content: '我在', time: at.toISOString() }])), undefined);
        // 只认他最后一句，不认更早的
        assert.match(lastUserLine(chatTurn([said(10, '早的'), { role: 'assistant', content: '嗯', time: at.toISOString() }, said(2, '晚的')]))!, /「晚的」/);
    });

    test('超过 30 分钟：主动找他时提醒「那不是刚说的」，别的轮次不放；没有时间的说「好几条消息以前」', () => {
        assert.equal(lastUserLine(chatTurn([said(31)])), undefined);
        assert.equal(lastUserLine(chatTurn([said(150)], initiating)), '他上一次说话是 3 小时前，那不是刚说的：别接着说那句旧话，说你这一轮要说的事。');
        assert.equal(lastUserLine(chatTurn([said(31)], initiating)), '他上一次说话是 1 小时前，那不是刚说的：别接着说那句旧话，说你这一轮要说的事。');
        assert.equal(lastUserLine(chatTurn([{ role: 'user', content: '你在干嘛' }], initiating)), '他上一次说话是 好几条消息以前，那不是刚说的：别接着说那句旧话，说你这一轮要说的事。');
        assert.equal(lastUserLine(chatTurn([{ role: 'user', content: '你在干嘛' }])), undefined);
    });

    test('人称、先直接答、别琢磨三行：主动找他时不放；各档位、危机、只想一想照样放', () => {
        const module = replyBasicsModule();
        const slots = (t: Turn) => (module.contribute!(t) as Piece[]).map(piece => piece.slot);
        assert.deepEqual(slots(chatTurn([said(1)])), ['lastUser', 'person', 'directAnswer', 'noOverthink']);
        assert.deepEqual((module.contribute!(chatTurn([said(1)])) as Piece[]).slice(1).map(piece => piece.text), [PERSON_NOTE, DIRECT_ANSWER_NOTE, NO_OVERTHINK_NOTE]);
        assert.deepEqual(slots(chatTurn([said(150)], initiating)), ['lastUser']);
        assert.deepEqual(slots(chatTurn([], initiating)), []);
        assert.deepEqual(slots(chatTurn([said(1)], { contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, thinking: true, facts: { crisis: { level: 'acute' } as never } })), ['lastUser', 'person', 'directAnswer', 'noOverthink']);
    });
});

describe('她自己的问题和判断模块（DSH 10-31，ADR 0336）', () => {
    const at = new Date('2026-11-29T13:00:00+08:00');
    const boyfriend = (said: string, extra: Partial<Turn> = {}): Turn => ({
        ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [{ role: 'user', content: said, time: at.toISOString() }], ...extra,
    });

    test('只有男朋友档；危机时不放；小别扭、主动找他、只想一想照样放', () => {
        assert.equal(asksAllowed(boyfriend('嗯嗯')), true);
        assert.equal(asksAllowed({ ...boyfriend('嗯嗯'), contact: { qq: 1, name: '阿明', tier: 'classmate' } }), false);
        assert.equal(asksAllowed(boyfriend('嗯嗯', { facts: { crisis: { level: 'acute' } as never } })), false);
        assert.equal(asksAllowed(boyfriend('嗯嗯', { facts: { grievance: {} as never }, initiate: { note: '', topic: '' }, thinking: true })), true);
    });

    test('问的方向、先表态、拿不准各放一个槽并记日志；只想一想时不给问的方向', () => {
        const logs: string[] = [];
        const module = asksModule(line => logs.push(line));
        const slots = (t: Turn) => (module.contribute!(t) as Piece[]).map(piece => piece.slot);
        assert.deepEqual(slots(boyfriend('嗯嗯')), ['askHint', 'unsure']);
        assert.deepEqual(logs, ['[1] 问一句：他这句轮到了，给她一个问的方向']);
        assert.deepEqual(slots(boyfriend('你觉得这件外套好看吗？')), ['opinion', 'unsure']);
        assert.equal(logs.at(-1), '[1] 表态：他他在问看法，给一句先表态的方向');
        assert.deepEqual(slots(boyfriend('嗯嗯', { thinking: true })), ['unsure']);
        assert.deepEqual(slots(boyfriend('你觉得这件外套好看吗？', { thinking: true })), ['opinion', 'unsure']);
        assert.deepEqual((module.contribute!(boyfriend('今天下午去图书馆还书，顺便借了两本')) as Piece[]), [{ slot: 'unsure', text: UNSURE_LINE }]);
        assert.deepEqual(module.contribute!({ ...boyfriend('嗯嗯'), contact: { qq: 1, name: '阿明', tier: 'classmate' } }), []);
        // 他还没说过话：只剩拿不准那一行
        assert.deepEqual(slots({ ...boyfriend(''), history: [] }), ['unsure']);
    });
});

describe('先读懂他这一轮模块（DSH 10-30，ADR 0336）', () => {
    const at = new Date('2026-11-29T13:00:00+08:00');
    const boyfriend = (history: Turn['history'], extra: Partial<Turn> = {}): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history, ...extra });
    const said = (content: string) => ({ role: 'user' as const, content, time: at.toISOString() });

    test('只有男朋友档；只想一想、危机时不放；主动找他、小别扭照样放', () => {
        assert.equal(readingAllowed(boyfriend([said('在吗')])), true);
        assert.equal(readingAllowed({ ...boyfriend([said('在吗')]), contact: { qq: 1, name: '阿明', tier: 'classmate' } }), false);
        assert.equal(readingAllowed(boyfriend([said('在吗')], { thinking: true })), false);
        assert.equal(readingAllowed(boyfriend([said('在吗')], { facts: { crisis: { level: 'acute' } as never } })), false);
        assert.equal(readingAllowed(boyfriend([said('在吗')], { initiate: { note: '', topic: '' }, facts: { grievance: {} as never } })), true);
    });

    test('放进 reading 槽并记日志；连着发的按一句；他没说过话时不放', () => {
        const logs: string[] = [];
        const module = readingModule(line => logs.push(line));
        const pieces = module.contribute!(boyfriend([said('今天'), said('好累啊')])) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'reading');
        assert.match(pieces[0]!.text, /^\[他这一轮说的是：「今天/);
        assert.match(pieces[0]!.text, /他分 2 条发的/);
        assert.deepEqual(logs, ['[1] 他这句：这一轮先把他的话读明白再回（日志不记内容）']);
        assert.deepEqual(module.contribute!(boyfriend([])), []);
        assert.deepEqual(module.contribute!(boyfriend([said('在吗')], { thinking: true })), []);
        assert.equal(logs.length, 1);
    });
});

describe('他的口气模块（DSH 10-30，ADR 0336）', () => {
    const at = new Date('2026-11-29T13:00:00+08:00');
    const said = (content: string) => ({ role: 'user' as const, content, time: at.toISOString() });
    const boyfriend = (history: Turn['history'], extra: Partial<Turn> = {}): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history, ...extra });

    test('只有男朋友档；主动找他、只想一想、危机时不放；小别扭照样放', () => {
        assert.equal(registerAllowed(boyfriend([said('想你了')])), true);
        assert.equal(registerAllowed({ ...boyfriend([said('想你了')]), contact: { qq: 1, name: '阿明', tier: 'classmate' } }), false);
        assert.equal(registerAllowed(boyfriend([said('想你了')], { initiate: { note: '', topic: '' } })), false);
        assert.equal(registerAllowed(boyfriend([said('想你了')], { thinking: true })), false);
        assert.equal(registerAllowed(boyfriend([said('想你了')], { facts: { crisis: { level: 'acute' } as never } })), false);
        assert.equal(registerAllowed(boyfriend([said('想你了')], { facts: { grievance: {} as never } })), true);
    });

    test('几行拼成 register 槽的一段并记日志；读不出口气时不放', () => {
        const logs: string[] = [];
        const module = registerModule(line => logs.push(line));
        const person = module.contribute!(boyfriend([said('想你了')])) as Piece[];
        assert.deepEqual(person, [{ slot: 'register', text: '[这几句是在跟你说话，不是在派活。照你平时的样子接]' }]);
        assert.deepEqual(logs, ['[1] 他的口气：person（像对人：想你）']);
        const tool = module.contribute!(boyfriend([said('帮我查一下'), said('再给我写个'), said('翻译一下这句'), said('你是不是程序，上下文多长')])) as Piece[];
        assert.equal(tool.length, 1);
        const lines = tool[0]!.text.split('\n');
        assert.match(lines[0]!, /像在使唤一个能干活的工具/);
        assert.match(lines[1]!, /跟一个「程序」说话/);
        assert.match(lines[2]!, /问的是很元的东西/);
        assert.match(lines[3]!, /最近他 4 次是在使唤你、0 次是在跟你说话/);
        assert.equal(logs.at(-1), '[1] 他的口气：最近使唤得比说话多');
        assert.deepEqual(module.contribute!(boyfriend([said('今天天气不错')])), []);
        assert.deepEqual(module.contribute!(boyfriend([said('想你了')], { thinking: true })), []);
    });
});

describe('场景应答模块（DSH 10-31，ADR 0336）', () => {
    const at = new Date('2026-11-29T13:00:00+08:00');
    const said = (content: string) => ({ role: 'user' as const, content, time: at.toISOString() });
    const boyfriend = (history: Turn['history'], extra: Partial<Turn> = {}): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history, ...extra });

    test('只有男朋友档，危机时不放；主动找他、只想一想、小别扭照样放', () => {
        assert.equal(scenesAllowed(boyfriend([said('zdjd')])), true);
        assert.equal(scenesAllowed({ ...boyfriend([said('zdjd')]), contact: { qq: 1, name: '阿明', tier: 'classmate' } }), false);
        assert.equal(scenesAllowed(boyfriend([said('zdjd')], { facts: { crisis: { level: 'acute' } as never } })), false);
        assert.equal(scenesAllowed(boyfriend([said('zdjd')], { initiate: { note: '', topic: '' }, thinking: true, facts: { grievance: {} as never } })), true);
    });

    test('只看他最后一句：命中才放进 scene 槽并记日志', () => {
        const logs: string[] = [];
        const module = scenesModule(line => logs.push(line));
        const pieces = module.contribute!(boyfriend([said('哄我睡觉呗')])) as Piece[];
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'scene');
        assert.match(pieces[0]!.text, /他说的是「哄我睡」/);
        assert.deepEqual(logs, ['[1] 场景：他这句要特殊接（哄睡 / 报错 / 自我怀疑 / 暗号）']);
        assert.match((module.contribute!(boyfriend([said('哄我睡觉呗'), said('zdjd')])) as Piece[])[0]!.text, /看不懂的缩写/);
        assert.deepEqual(module.contribute!(boyfriend([said('zdjd'), said('今天好冷')])), []);
        assert.deepEqual(module.contribute!(boyfriend([said('ok')])), []);
        assert.deepEqual(module.contribute!(boyfriend([])), []);
    });
});

describe('语音提示模块（DSH 11-01，ADR 0336）', () => {
    const at = new Date('2026-11-29T13:00:00+08:00');
    const boyfriend = (history: Turn['history'], extra: Partial<Turn> = {}): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history, ...extra });
    /** 找一句掷出来给 / 不给的话（骰子按他最后一条的时间和内容定，同一句每次一样） */
    const lineWhere = (give: boolean) => {
        for (let i = 0; i < 500; i++) {
            const history = [{ role: 'user' as const, content: `第${i}句`, time: at.toISOString() }];
            if ((voiceRoll(history) < VOICE_HINT_RATE) === give) return history;
        }
        throw new Error('没找到');
    };

    test('只有男朋友档；危机、只想一想、主动找他时不给；小别扭照样给', () => {
        const history = lineWhere(true);
        assert.equal(voiceAllowed(boyfriend(history)), true);
        assert.equal(voiceAllowed({ ...boyfriend(history), contact: { qq: 1, name: '阿明', tier: 'classmate' } }), false);
        assert.equal(voiceAllowed(boyfriend(history, { facts: { crisis: { level: 'acute' } as never } })), false);
        assert.equal(voiceAllowed(boyfriend(history, { thinking: true })), false);
        assert.equal(voiceAllowed(boyfriend(history, { initiate: { note: '', topic: '' } })), false);
        assert.equal(voiceAllowed(boyfriend(history, { facts: { grievance: {} as never } })), true);
    });

    test('骰子掷到才放进 voice 槽并记日志；同一句每次一样；他没说过话时不给', () => {
        const logs: string[] = [];
        const module = voiceModule(line => logs.push(line));
        const give = lineWhere(true);
        assert.deepEqual(module.contribute!(boyfriend(give)), [{ slot: 'voice', text: VOICE_HINT }]);
        assert.deepEqual(module.contribute!(boyfriend(give)), [{ slot: 'voice', text: VOICE_HINT }]);
        assert.deepEqual(logs, ['[1] 说话：这一轮告诉她可以发语音', '[1] 说话：这一轮告诉她可以发语音']);
        assert.deepEqual(module.contribute!(boyfriend(lineWhere(false))), []);
        assert.deepEqual(module.contribute!(boyfriend([])), []);
        assert.deepEqual(module.contribute!(boyfriend(give, { initiate: { note: '', topic: '' } })), []);
    });
});

describe('她可以跑命令模块（DSH 10-30，ADR 0336）', () => {
    const at = new Date('2026-11-29T13:00:00+08:00');
    const boyfriend = (extra: Partial<Turn> = {}): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: [], ...extra });

    test('命令结果给她看一眼就清掉；「可以跑命令」那一行在只想一想、小别扭生效时不给', () => {
        const notes = new Map([[1, '[你刚跑了 whoami：pc-user]']]);
        const module = shellModule({ noteOf: contact => { const note = notes.get(contact.qq); notes.delete(contact.qq); return note; } });
        assert.deepEqual(module.contribute!(boyfriend()), [{ slot: 'shell', text: '[你刚跑了 whoami：pc-user]' }, { slot: 'shellIntent', text: SHELL_INTENT }]);
        assert.deepEqual(module.contribute!(boyfriend()), [{ slot: 'shellIntent', text: SHELL_INTENT }]);
        notes.set(1, '[结果]');
        assert.deepEqual(module.contribute!(boyfriend({ thinking: true })), [{ slot: 'shell', text: '[结果]' }]);
        // 有小别扭但没生效（意图被照片等换掉了）照样给；生效时不给
        assert.deepEqual(module.contribute!(boyfriend({ facts: { grievance: {} as never } })), [{ slot: 'shellIntent', text: SHELL_INTENT }]);
        assert.deepEqual(module.contribute!(boyfriend({ facts: { grievance: {} as never, grievanceActive: true } })), []);
        // 主动找他照样给
        assert.deepEqual(module.contribute!(boyfriend({ initiate: { note: '', topic: '' } })), [{ slot: 'shellIntent', text: SHELL_INTENT }]);
    });

    test('只有男朋友档，危机时都不放（也不读命令结果，留到下一轮）', () => {
        const notes = new Map([[1, '[结果]']]);
        let reads = 0;
        const module = shellModule({ noteOf: contact => { reads++; const note = notes.get(contact.qq); notes.delete(contact.qq); return note; } });
        assert.deepEqual(module.contribute!({ ...boyfriend(), contact: { qq: 1, name: '阿明', tier: 'classmate' } }), []);
        assert.deepEqual(module.contribute!(boyfriend({ facts: { crisis: { level: 'acute' } as never } })), []);
        assert.equal(reads, 0);
        assert.deepEqual(shellModule().contribute!(boyfriend()), [{ slot: 'shellIntent', text: SHELL_INTENT }]);
    });
});

describe('她学的时候没想通的地方模块（DSH 10-31，ADR 0336）', () => {
    test('有问题时放进 question 槽；别的档位、危机、只想一想时不放，也不去读', () => {
        let reads = 0;
        const module = learningQuestionModule(() => { reads++; return '[你有一个没想通的地方：…]'; });
        const boyfriend: Turn = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' } };
        assert.deepEqual(module.contribute!(boyfriend), [{ slot: 'question', text: '[你有一个没想通的地方：…]' }]);
        assert.deepEqual(module.contribute!({ ...boyfriend, initiate: { note: '', topic: '' }, facts: { grievance: {} as never } }), [{ slot: 'question', text: '[你有一个没想通的地方：…]' }]);
        assert.equal(reads, 2);
        assert.deepEqual(module.contribute!(turn), []);
        assert.deepEqual(module.contribute!({ ...boyfriend, facts: { crisis: { level: 'acute' } as never } }), []);
        assert.deepEqual(module.contribute!({ ...boyfriend, thinking: true }), []);
        assert.equal(reads, 2);
        assert.deepEqual(learningQuestionModule(() => undefined).contribute!(boyfriend), []);
    });
});

describe('工作模式模块（DSH 10-29 / 10-30，ADR 0336）', () => {
    test('按状态放其中一行；只有男朋友档；危机、主动找他、只想一想照样放', () => {
        const modes = new Map<number, 'chat' | 'work' | 'pending'>([[1, 'pending']]);
        const module = workModeModule(contact => modes.get(contact.qq) ?? 'chat');
        const boyfriend: Turn = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' } };
        assert.deepEqual(module.contribute!(boyfriend), [{ slot: 'workRequest', text: WORK_REQUEST_NOTE }]);
        modes.set(1, 'work');
        assert.deepEqual(module.contribute!(boyfriend), [{ slot: 'workMode', text: WORK_MODE_NOTE }]);
        assert.deepEqual(module.contribute!({ ...boyfriend, facts: { crisis: { level: 'acute' } as never }, initiate: { note: '', topic: '' }, thinking: true }), [{ slot: 'workMode', text: WORK_MODE_NOTE }]);
        modes.set(1, 'chat');
        assert.deepEqual(module.contribute!(boyfriend), [{ slot: 'workJudge', text: WORK_JUDGE_NOTE }]);
        modes.set(1, 'work');
        assert.deepEqual(module.contribute!(turn), []);
    });
});

describe('她自己决定记不记模块（DSH 10-30 / 10-31，ADR 0336）', () => {
    const at = new Date('2026-11-29T13:00:00+08:00');
    const boyfriend = (history: Turn['history'], extra: Partial<Turn> = {}): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history, ...extra });
    const said = (content: string) => ({ role: 'user' as const, content, time: at.toISOString() });

    test('记忆那一行各档位每一轮都放；理解偏过按他最后一句查、留痕现读，只给男朋友档、主动找他时不放', () => {
        const asked: string[] = [];
        const module = selfMemoryModule({ understanding: words => { asked.push(words); return words.includes('老板') ? '[理解偏过]' : undefined; }, traces: () => '[他最近的事]' });
        const slots = (t: Turn) => (module.contribute!(t) as Piece[]).map(piece => piece.slot);
        assert.deepEqual(module.contribute!(boyfriend([said('早的'), said('  那家公司老板  ')])), [
            { slot: 'understanding', text: '[理解偏过]' }, { slot: 'traces', text: '[他最近的事]' }, { slot: 'selfMemory', text: SELF_MEMORY_NOTE },
        ]);
        assert.deepEqual(asked, ['那家公司老板']);
        assert.deepEqual(slots(boyfriend([said('今天下雨')])), ['traces', 'selfMemory']);
        assert.deepEqual(slots(boyfriend([said('那家公司老板')], { initiate: { note: '', topic: '' } })), ['selfMemory']);
        assert.deepEqual(slots({ ...boyfriend([said('那家公司老板')]), contact: { qq: 2, name: '小周', tier: 'classmate' } }), ['selfMemory']);
        // 他还没说过话：不查理解偏过
        asked.length = 0;
        assert.deepEqual(slots(boyfriend([])), ['traces', 'selfMemory']);
        assert.deepEqual(asked, []);
        // 危机、只想一想照样放
        assert.deepEqual(slots(boyfriend([said('那家公司老板')], { thinking: true, facts: { crisis: { level: 'acute' } as never } })), ['understanding', 'traces', 'selfMemory']);
    });
});

describe('她在本机的那一份模块（DSH 灵魂目录，ADR 0336）', () => {
    const boyfriend: Turn = { ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' } };
    const all = { selfThread: () => '[线头]', refusals: () => '你最近拒绝过：x。', rating: () => '他最近挺买你的账。', life: () => '在宿舍看书', wake: () => '（他走了 8 小时。）' };
    const slots = (module: ReturnType<typeof soulModule>, t: Turn) => (module.contribute!(t) as Piece[]).map(piece => piece.slot);

    test('五行各放一个槽；「你现在的生活」前面加标题；只给男朋友档', () => {
        const module = soulModule(all);
        assert.deepEqual(module.contribute!(boyfriend), [
            { slot: 'selfThread', text: '[线头]' }, { slot: 'refusal', text: '你最近拒绝过：x。' }, { slot: 'rating', text: '他最近挺买你的账。' },
            { slot: 'life', text: '[你现在的生活] 在宿舍看书' }, { slot: 'wake', text: '（他走了 8 小时。）' },
        ]);
        assert.deepEqual(module.contribute!(turn), []);
    });

    test('线头在主动找他、只想一想、危机时不放（也不去读）；别的几行照样放；没给首轮铺底就没有', () => {
        let threads = 0;
        const module = soulModule({ ...all, selfThread: () => { threads++; return '[线头]'; } });
        for (const t of [{ ...boyfriend, initiate: { note: '', topic: '' } }, { ...boyfriend, thinking: true }, { ...boyfriend, facts: { crisis: { level: 'acute' } as never } }]) {
            assert.deepEqual(slots(module, t), ['refusal', 'rating', 'life', 'wake']);
        }
        assert.equal(threads, 0);
        const { wake: _wake, ...noWake } = all;
        assert.deepEqual(slots(soulModule(noWake), boyfriend), ['selfThread', 'refusal', 'rating', 'life']);
        assert.deepEqual(slots(soulModule({ ...all, refusals: () => undefined, life: () => undefined }), boyfriend), ['selfThread', 'rating', 'wake']);
    });
});

describe('她自己记下的东西模块（DSH，ADR 0336）', () => {
    const at = Date.parse('2026-11-29T13:00:00+08:00');
    const said = (content: string) => ({ role: 'user' as const, content, time: new Date(at).toISOString() });
    const boyfriend = (history: Turn['history'], extra: Partial<Turn> = {}): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at: new Date(at), history, ...extra });
    const all = {
        speechNotes: () => [{ id: 'a', text: '他问正经事的时候我先直接说结论', at }],
        chatReview: () => [{ id: 'b', text: '别连着问他好几个问题', at }],
        diaryInsights: () => [{ id: 'c', text: '我一紧张就会话多', at, dates: [] }],
        readingTakes: () => [{ id: 'd', key: 'book:x', kind: 'book' as const, title: '小王子', names: ['小王子'], text: '狐狸那段', at, progress: 1 }],
        openQuestions: () => [{ id: 'e', q: '熬夜到底伤不伤身体', text: '伤的是第二天的心情和身体', at }],
        herGuesses: () => [{ id: 'f', at, said: 'x', text: '我猜他这次考试要挂', kind: 'quiz' as const, status: 'open' as const }],
        now: () => at,
    };
    const slots = (options: Parameters<typeof herNotesModule>[0], t: Turn) => (herNotesModule(options).contribute!(t) as Piece[]).map(piece => piece.slot);

    test('按他这句话挑相关的放，各一个槽；说话习惯和聊天回顾总是放', () => {
        const logs: string[] = [];
        assert.deepEqual(slots({ ...all, log: line => logs.push(line) }, boyfriend([said('你今天话多吗，熬夜伤不伤身体，考试出分了，小王子看完没')])), ['speechNote', 'review', 'insight', 'takes', 'thoughts', 'guesses']);
        assert.equal(logs.length, 6);
        assert.ok(logs.every(line => line.startsWith('[1] ')));
        assert.deepEqual(slots({ ...all, log: () => {} }, boyfriend([said('今天天气不错')])), ['speechNote', 'review']);
    });

    test('他难过时不放聊天回顾；只想一想、危机、小别扭、别的档位都不放；没开的那样没有', () => {
        const quiet = { ...all, log: () => {} };
        assert.deepEqual(slots(quiet, boyfriend([said('我今天好难过')])), ['speechNote']);
        for (const t of [boyfriend([said('考试')], { thinking: true }), boyfriend([said('考试')], { facts: { crisis: { level: 'acute' } as never } }), boyfriend([said('考试')], { facts: { grievance: {} as never } }), { ...boyfriend([said('考试')]), contact: { qq: 2, name: '小周', tier: 'classmate' as const } }]) {
            assert.deepEqual(slots(quiet, t), []);
        }
        assert.deepEqual(slots({ now: () => at, log: () => {} }, boyfriend([said('考试')])), []);
        // 主动找他（他还没说话）：说话习惯和聊天回顾照样放
        assert.deepEqual(slots(quiet, boyfriend([], { initiate: { note: '', topic: '' } })), ['speechNote', 'review']);
    });
});

describe('别重复自己模块（ADR 0098 / 0135 / 0336）', () => {
    const at = new Date('2026-12-05T20:00:00+08:00');
    const ago = (minutes: number) => new Date(at.getTime() - minutes * 60_000).toISOString();
    // 她最近 5 次话头里 4 次「刚」起头、5 条气泡都带「困死」；第二次是她自己说起相机（他前面的话里没提）
    const history: Turn['history'] = [
        { role: 'assistant', content: '刚起床 困死了', time: ago(300) },
        { role: 'user', content: '早', time: ago(290) },
        { role: 'assistant', content: '刚到 我相机到了 困死', time: ago(280) },
        { role: 'user', content: '好', time: ago(200) },
        { role: 'assistant', content: '对了 困死了', time: ago(190) },
        { role: 'user', content: '嗯', time: ago(100) },
        { role: 'assistant', content: '刚下课 困死', time: ago(90) },
        { role: 'user', content: '在干嘛', time: ago(60) },
        { role: 'assistant', content: '刚吃完 困死', time: ago(50) },
        { role: 'user', content: '晚上吃啥', time: ago(1) },
    ];
    const boyfriend = (patch: Partial<Turn> = {}): Turn => ({ ...turn, contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history, facts: {}, ...patch });
    const run = (t: Turn) => { const module = repetitionModule(() => {}); module.assess!(t); return { facts: t.facts, pieces: module.contribute!(t) as Piece[] }; };
    const slots = (pieces: readonly Piece[]) => pieces.map(piece => piece.slot);
    test('他发来的一轮：反复说的字词、说过了的事；assess 把说过了的写进 facts.told', () => {
        const { facts, pieces } = run(boyfriend());
        assert.deepEqual(facts.told, ['相机']);
        assert.deepEqual(slots(pieces), ['crutch', 'told']);
        assert.match(pieces[0]!.text, /反复在说「困死」/);
        assert.equal(pieces[1]!.text, '[这些事你已经主动跟他说过了：相机。他不问，就别再自己提]');
    });
    test('主动找他：换个开头，不提醒反复说的字词；只想一想时都不放', () => {
        const initiate = { note: '', topic: '' } as Turn['initiate'];
        const { pieces } = run(boyfriend({ initiate }));
        assert.deepEqual(slots(pieces), ['opener', 'told']);
        assert.equal(pieces[0]!.text, '[你最近几次开头都是「刚」：这次换一种开头，别用「刚」起头]');
        assert.deepEqual(slots(run(boyfriend({ initiate, thinking: true })).pieces), []);
    });
    test('危机回合：不算说过了的事，三行都不放（主动找他时本来不算危机，开头这条是冗余的保险）', () => {
        const crisis = { level: 'high' } as never;
        const live = boyfriend({ facts: { crisis } });
        const { facts, pieces } = run(live);
        assert.equal(facts.told, undefined);
        assert.deepEqual(slots(pieces), []);
        assert.deepEqual(slots(repetitionPieces({ ...boyfriend({ initiate: { note: '', topic: '' } as Turn['initiate'] }), facts: { crisis, told: ['相机'] } })), ['told']);
    });
    test('聊得不多、没有重复：什么都不放；说过了的是空的', () => {
        const { facts, pieces } = run(boyfriend({ history: history.slice(-2) }));
        assert.deepEqual(facts.told, []);
        assert.deepEqual(pieces, []);
    });
});

describe('她此刻模块（ADR 0021 / 0025 / 0042 / 0047 / 0336）', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend').character;
    const at = new Date('2026-10-08T23:30:00+08:00');
    const amin: Contact = { qq: 1, name: '阿明', tier: 'boyfriend' };
    const zhou: Contact = { qq: 2, name: '小周', tier: 'classmate' };
    const base = { schedule: true, herDays: true, history: () => [], log: () => {} };
    const turnOf = (contact: Contact, patch: Partial<Turn> = {}): Turn => ({ contact, at, history: [], thinking: false, card, facts: {}, ...patch });
    const run = (module: Module, t: Turn) => { module.perceive!(t); return { facts: t.facts, pieces: module.contribute!(t) as Piece[] }; };
    const text = (pieces: readonly Piece[], slot: Piece['slot']) => pieces.find(piece => piece.slot === slot)?.text;
    test('perceive 写她那边、身体、状态行、作息；contribute 放此刻、她那边、身体、打算，他刚回学校', () => {
        const { facts, pieces } = run(herNowModule(base), turnOf(amin));
        assert.ok(facts.world && facts.status && facts.state && facts.schedule);
        assert.equal(facts.state, facts.status.state);
        assert.deepEqual(pieces.map(piece => piece.slot), ['state', 'world', ...(facts.body ? ['body'] : []), 'plans', 'partnerBack']);
        assert.match(text(pieces, 'state')!, /^\[你现在：/);
        assert.equal(text(pieces, 'partnerBack'), '[阿明国庆放完回学校了，已经在学校里了]');
    });
    test('没有卡、两个开关都关：什么都不算、不放；只开作息：只有此刻那一行', () => {
        const none = turnOf(amin, { card: undefined });
        assert.deepEqual(run(herNowModule(base), none), { facts: {}, pieces: [] });
        assert.deepEqual(run(herNowModule({ ...base, schedule: false, herDays: false }), turnOf(amin)), { facts: {}, pieces: [] });
        const only = run(herNowModule({ ...base, herDays: false }), turnOf(amin));
        assert.equal(only.facts.world, undefined);
        assert.deepEqual(only.pieces.map(piece => piece.slot), ['state', 'partnerBack']);
    });
    test('说过「睡了」：对谁说的都算（同学来问也是在睡）；吵醒那一轮写被吵醒', () => {
        const said: Record<number, StoredMessage[]> = { 1: [{ time: '2026-10-08T15:20:00.000Z', role: 'assistant', content: '我先睡了，晚安' }] };
        const module = herNowModule({ ...base, contacts: () => [amin, zhou], history: qq => said[qq] ?? [] });
        const later = new Date('2026-10-09T00:30:00+08:00');
        const classmate = run(module, turnOf(zhou, { at: later }));
        assert.equal(classmate.facts.state?.activity.kind, 'sleep');
        assert.ok(classmate.facts.status?.saidAsleep);
        assert.match(text(run(module, turnOf(amin, { at: later, woken: true })).pieces, 'state')!, /被消息震醒了/);
        // 不看别人的聊天记录：同学这边她还醒着（作息 02:00 才睡）
        assert.notEqual(run(herNowModule({ ...base, history: qq => said[qq] ?? [] }), turnOf(zhou, { at: later })).facts.state?.activity.kind, 'sleep');
    });
    test('约好的见面：和这个人约的写在赴约，别人来问只说在外面、约了人；名单外不看', () => {
        const meeting = {
            contact: amin, start: new Date('2026-10-08T23:00:00+08:00'), end: new Date('2026-10-09T00:00:00+08:00'),
            promise: { id: 'p', what: '和他去东门吃夜宵', said: '2026-10-08', episode: 'e', meet: { time: '23:00', where: '东门口' } },
        } as never;
        const module = herNowModule({ ...base, appointmentsAt: () => [meeting] });
        assert.match(text(run(module, turnOf(amin)).pieces, 'state')!, /约好的：和他去东门吃夜宵（23:00，东门口），正在赴约/);
        assert.match(text(run(module, turnOf(zhou)).pieces, 'state')!, /在外面，约了人（23:00 起）/);
        assert.doesNotMatch(text(run(module, turnOf({ qq: 9, name: '路人', tier: 'unlisted' })).pieces, 'state') ?? '', /约了人/);
    });
    test('她那边的钱是谁给的（买了相机之后那一行写）：正在聊的人写他的称呼，别人看男朋友给的写「男朋友」', () => {
        const evening = new Date('2026-10-11T20:00:00+08:00');
        const gift = { id: '1:ep:1:receive_money', kind: 'receive_money', day: '2026-10-08', at: '2026-10-08T15:41', contact: 1, episode: 'ep', amount: 2000, target: 'camera_fund' } as WorldAction;
        const worldState = { at: (world: NonNullable<typeof card.herWorld>, schedule: Schedule, when: Date) => worldAt(world, schedule, when, [gift]) };
        const module = herNowModule({ ...base, worldState: () => worldState, contacts: () => [amin, zhou] });
        const mine = text(run(module, turnOf(amin, { at: evening })).pieces, 'world')!;
        const theirs = text(run(module, turnOf(zhou, { at: evening })).pieces, 'world')!;
        assert.match(mine, /相机：.*阿明/);
        assert.match(theirs, /相机：.*男朋友/);
        assert.doesNotMatch(theirs, /阿明/);
        // 名单里没有给钱的人：写「别人」
        assert.match(text(run(herNowModule({ ...base, worldState: () => worldState }), turnOf(zhou, { at: evening })).pieces, 'world')!, /相机：.*别人/);
    });
});

describe('在读的书模块（ADR 0015 / 0336）', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend').character;
    const at = new Date('2026-11-12T19:30:00+08:00');
    const asked: Turn['history'] = [{ role: 'user', content: '雾港旧事你看到第几章了', time: at.toISOString() }];
    const turnOf = (patch: Partial<Turn> = {}): Turn => ({ contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: asked, thinking: false, card, facts: {}, ...patch });
    const run = (module: Module, t: Turn) => { module.assess!(t); return { facts: t.facts, pieces: module.contribute!(t) as Piece[] }; };
    test('他问起在读的书：facts.books 带出口检查用的进度，books 槽放那一行', () => {
        const { facts, pieces } = run(booksModule({ herDays: true }), turnOf());
        assert.ok(facts.books?.context.books.length);
        assert.deepEqual(pieces, [{ slot: 'books', text: facts.books!.text }]);
        assert.match(pieces[0]!.text, /^\[在读的书：/);
    });
    test('她此刻正在看书（facts.state 的空闲活动）：没提也放', () => {
        const state = { activity: { kind: 'free', text: '睡前看几章《雾港旧事》' } } as never;
        assert.equal(run(booksModule({ herDays: true }), turnOf({ history: [], facts: {} })).pieces.length, 0);
        assert.equal(run(booksModule({ herDays: true }), turnOf({ history: [], facts: { state } })).pieces[0]?.slot, 'books');
    });
    test('没开她自己的日子、没有卡：不放，出口检查也不核对', () => {
        for (const [module, t] of [[booksModule(), turnOf()], [booksModule({ herDays: true }), turnOf({ card: undefined })]] as const) {
            const { facts, pieces } = run(module, t);
            assert.equal(facts.books, undefined);
            assert.deepEqual(pieces, []);
        }
    });
});

describe('她的过去模块（ADR 0022 / 0336）', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend').character;
    const classmateCard = loadTierCard(syntheticCardPattern, 'classmate').character;
    const at = new Date('2026-11-18T19:30:00+08:00');
    const iso = (minutes: number) => new Date(at.getTime() + minutes * 60_000).toISOString();
    const asked: Turn['history'] = [{ role: 'user', content: '你小时候养过猫吗', time: iso(0) }];
    const followUp: Turn['history'] = [...asked, { role: 'assistant', content: '养过呀', time: iso(1) }, { role: 'user', content: '那后来呢', time: iso(3) }];
    const turnOf = (patch: Partial<Turn> = {}): Turn => ({ contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: asked, thinking: false, card, facts: {}, ...patch });
    const run = (t: Turn) => { const logs: string[] = []; return { pieces: pastModule(line => logs.push(line)).contribute!(t) as Piece[], logs }; };
    test('他说到线索：想起的那一块和这一档的年表放进 past 槽并记日志；没有线索不放', () => {
        const { pieces, logs } = run(turnOf());
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'past');
        assert.match(pieces[0]!.text, /^\[你想起的从前（[\s\S]*- 小时候养过猫：[\s\S]*你的年表：.*大一：认识了阿测$/);
        assert.deepEqual(logs, ['[1] 想起从前：小时候养过猫']);
        assert.deepEqual(run(turnOf({ history: [{ role: 'user', content: '在干嘛', time: iso(0) }] })), { pieces: [], logs: [] });
    });
    test('追问没有线索：十分钟以内沿用刚才想起的，过了就不放', () => {
        const still = run(turnOf({ history: followUp, at: new Date(at.getTime() + 3 * 60_000) }));
        assert.match(still.pieces[0]!.text, /小时候养过猫/);
        assert.deepEqual(still.logs, ['[1] 从前沿用刚才想起的：小时候养过猫']);
        assert.deepEqual(run(turnOf({ history: followUp, at: new Date(at.getTime() + 12 * 60_000) })).pieces, []);
    });
    test('主动找他时不想（他的话还没回、刚想起过都不算）；危机、别的档位照样放，按这一轮的卡', () => {
        const initiate = { note: '[主动]' } as NonNullable<Turn['initiate']>;
        assert.deepEqual(run(turnOf({ initiate })), { pieces: [], logs: [] });
        assert.deepEqual(run(turnOf({ initiate, history: followUp.slice(0, 2), at: new Date(at.getTime() + 3 * 60_000) })), { pieces: [], logs: [] });
        assert.equal(run(turnOf({ facts: { crisis: { level: 'high' } as never } })).pieces.length, 1);
        const classmate = run(turnOf({ contact: { qq: 2, name: '小周', tier: 'classmate' }, card: classmateCard }));
        assert.match(classmate.pieces[0]!.text, /你的年表：小学：在郊区的小学读书$/);
        assert.deepEqual(run(turnOf({ card: classmateCard, history: [{ role: 'user', content: '你高考考得怎么样', time: iso(0) }] })).pieces, []);
    });
    test('没有卡、卡上没有自传：不放', () => {
        assert.deepEqual(run(turnOf({ card: undefined })).pieces, []);
        assert.deepEqual(run(turnOf({ card: { ...card, biography: undefined } })).pieces, []);
    });
});

describe('她身边的人模块（ADR 0033 / 0336）', () => {
    const card = loadTierCard(syntheticCardPattern, 'boyfriend').character;
    const girlFriendCard = loadTierCard(syntheticCardPattern, 'girl_friend').character;
    const classmateCard = loadTierCard(syntheticCardPattern, 'classmate').character;
    const at = new Date('2026-09-29T18:30:00+08:00');
    const iso = (minutes: number) => new Date(at.getTime() + minutes * 60_000).toISOString();
    const asked: Turn['history'] = [{ role: 'user', content: '小禾最近怎么样', time: iso(0) }];
    const followUp: Turn['history'] = [...asked, { role: 'assistant', content: '感冒了', time: iso(1) }, { role: 'user', content: '那她现在呢', time: iso(3) }];
    const turnOf = (patch: Partial<Turn> = {}): Turn => ({ contact: { qq: 1, name: '阿明', tier: 'boyfriend' }, at, history: asked, thinking: false, card, facts: {}, ...patch });
    const run = (t: Turn, herDays = true) => {
        const logs: string[] = [];
        const module = peopleAroundModule({ herDays, log: line => logs.push(line) });
        void module.assess!(t);
        return { pieces: module.contribute!(t) as Piece[], about: t.facts.aboutPeople, logs };
    };
    test('他说起名字的后两个字：那人最近两周放进 npcs 槽、写进 facts 并记日志；没说起不放', () => {
        const { pieces, about, logs } = run(turnOf());
        assert.equal(pieces.length, 1);
        assert.equal(pieces[0]!.slot, 'npcs');
        assert.match(pieces[0]!.text, /^\[许小禾最近两周（室友；你知道的事，他问到了照实说，没写到的别编）：9月26日–9月28日感冒/);
        assert.deepEqual(about, { names: ['许小禾'], lines: [pieces[0]!.text] });
        assert.deepEqual(logs, ['[1] 想起许小禾最近的事']);
        assert.deepEqual(run(turnOf({ history: [{ role: 'user', content: '你室友呢', time: iso(0) }] })), { pieces: [], about: undefined, logs: [] });
    });
    test('一句话说起两个人：两段，按卡上的顺序', () => {
        const { pieces, about } = run(turnOf({ history: [{ role: 'user', content: '林小满和许小禾你更喜欢跟谁玩', time: iso(0) }] }));
        assert.deepEqual(about?.names, ['许小禾', '林小满']);
        assert.equal(pieces.length, 2);
        assert.match(pieces[1]!.text, /^\[林小满最近两周（高中同学，最好的朋友；/);
    });
    test('追问没有名字：十分钟以内沿用刚才说起的，过了就不放', () => {
        const still = run(turnOf({ history: followUp, at: new Date(at.getTime() + 3 * 60_000) }));
        assert.deepEqual(still.about?.names, ['许小禾']);
        assert.equal(still.pieces.length, 1);
        assert.equal(run(turnOf({ history: followUp, at: new Date(at.getTime() + 12 * 60_000) })).about, undefined);
    });
    test('主动找他时不想；没开她自己的日子、没有卡、卡上没有她的世界：不放', () => {
        const initiate = { note: '[主动]' } as NonNullable<Turn['initiate']>;
        assert.deepEqual(run(turnOf({ initiate })), { pieces: [], about: undefined, logs: [] });
        assert.deepEqual(run(turnOf(), false), { pieces: [], about: undefined, logs: [] });
        assert.equal(run(turnOf({ card: undefined })).about, undefined);
        assert.equal(run(turnOf({ card: { ...card, herWorld: undefined } })).about, undefined);
    });
    test('危机照样放；别的档位按这一轮的卡：女生朋友的卡里室友有名字、闺蜜没有名字，同学的卡里没有人', () => {
        assert.equal(run(turnOf({ facts: { crisis: { level: 'high' } as never } })).pieces.length, 1);
        const full: Turn['history'] = [{ role: 'user', content: '许小禾是谁呀', time: iso(0) }];
        assert.equal(run(turnOf({ card: girlFriendCard, history: full })).pieces.length, 1);
        assert.equal(run(turnOf({ card: girlFriendCard, history: [{ role: 'user', content: '那林小满呢', time: iso(0) }] })).about, undefined);
        assert.equal(run(turnOf({ card: classmateCard, history: full })).about, undefined);
    });
});
